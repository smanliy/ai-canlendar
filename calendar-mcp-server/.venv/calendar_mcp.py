from typing import Any
import sys
import logging
import asyncio
import json
import os
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path

from mcp.server import MCPServer

logging.basicConfig(stream=sys.stderr, level=logging.INFO)
logger = logging.getLogger(__name__)

mcp = MCPServer("calendar")
if not hasattr(mcp, "run_stdio") and hasattr(mcp, "run_stdio_async"):
    mcp.run_stdio = mcp.run_stdio_async  # type: ignore[attr-defined]

SERVER_DIR = Path(__file__).resolve().parents[1]
WORKSPACE_DIR = SERVER_DIR.parent
NODE_BFF_DIR = WORKSPACE_DIR / "node_calendar-bff"
PY_AGENT_APP_DIR = WORKSPACE_DIR / "agent" / "app"

sys.path.append(str(NODE_BFF_DIR))
sys.path.append(str(PY_AGENT_APP_DIR))


def _read_env_file_value(env_file: Path, name: str) -> str:
    """Read one environment variable from a dotenv-style file."""
    if not env_file.exists():
        return ""
    try:
        lines = env_file.read_text(encoding="utf-8").splitlines()
    except OSError as error:
        logger.warning("Failed to read env file %s: %s", env_file, error)
        return ""

    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        if key.strip() == name:
            return value.strip().strip('"').strip("'")
    return ""


def _get_config(name: str, default: str = "") -> str:
    """Resolve config from process env first, then the Node BFF .env file."""
    value = os.environ.get(name, "").strip()
    if value:
        return value
    return _read_env_file_value(NODE_BFF_DIR / ".env", name) or default


def _json_text(payload: Any) -> str:
    """Serialize any MCP tool result as a string."""
    return json.dumps(payload, ensure_ascii=False, default=str)


def _normalize_id(value: Any, field_name: str) -> str:
    """Normalize numeric or string IDs to the string IDs used by the backend."""
    text = str(value).strip()
    if not text:
        raise ValueError(f"{field_name} 不能为空")
    return text


def _validate_iso_datetime(value: str, field_name: str) -> str:
    """Validate and return an ISO-like datetime string accepted by the Node backend."""
    text = value.strip()
    if not text:
        raise ValueError(f"{field_name} 不能为空")
    normalized = text[:-1] + "+00:00" if text.endswith("Z") else text
    try:
        datetime.fromisoformat(normalized)
    except ValueError as error:
        raise ValueError(f"{field_name} 必须是合法 ISO 时间字符串") from error
    return text


def _bridge_request_sync(action: str, user_id: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    """Send one JSON request to the existing Node bridge endpoint."""
    base_url = _get_config("NODE_BFF_URL", "http://127.0.0.1:3000").rstrip("/")
    token = _get_config("OPENCLAW_BRIDGE_TOKEN")
    body: dict[str, Any] = {
        "action": action,
        "userId": user_id,
    }

    if action == "create_run" and payload is not None:
        body["input"] = str(payload.get("input", "")).strip()
        body["payload"] = payload.get("clarificationJson")
    elif payload is not None:
        body["payload"] = payload

    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    if token:
        headers["x-openclaw-bridge-token"] = token

    request = urllib.request.Request(
        f"{base_url}/api/integrations/openclaw/bridge",
        method="POST",
        headers=headers,
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
    )

    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            raw = response.read().decode("utf-8")
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as error:
        raw = error.read().decode("utf-8", errors="replace")
        try:
            data = json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            data = {"message": raw}
        return {
            "code": error.code,
            "message": data.get("message") or f"HTTP {error.code}",
            "data": data.get("data"),
        }
    except Exception as error:
        logger.exception("Bridge request failed: action=%s user_id=%s", action, user_id)
        return {
            "code": 500,
            "message": f"无法连接 Node 日历后端: {error}",
            "data": None,
        }


async def _bridge_request(action: str, user_id: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    """Run the stdlib HTTP request outside the event loop."""
    return await asyncio.to_thread(_bridge_request_sync, action, user_id, payload)


# 此处填充内部公共业务函数
async def _query_calendar_events(user_id: str) -> dict[str, Any]:
    """Query all non-deleted calendar events for a user through the Node bridge."""
    return await _bridge_request(
        "query_calendar_events",
        user_id,
        {
            "start": "1970-01-01T00:00:00.000Z",
            "end": "2100-01-01T00:00:00.000Z",
        },
    )


async def _create_schedule(task_name: str, deadline: str, duration: int, user_id: str) -> dict[str, Any]:
    """Create a schedule run through the Node Agent flow."""
    clean_name = task_name.strip()
    if not clean_name:
        raise ValueError("task_name 不能为空")
    if duration <= 0:
        raise ValueError("duration 必须是正整数分钟")
    deadline_iso = _validate_iso_datetime(deadline, "deadline")
    input_text = f"{clean_name}，截止时间：{deadline_iso}，预计耗时：{duration}分钟"
    return await _bridge_request(
        "create_run",
        user_id,
        {
            "input": input_text,
            "clarificationJson": {
                "taskName": clean_name,
                "deadline": deadline_iso,
                "duration": f"{duration}分钟",
                "totalMinutes": duration,
            },
        },
    )


async def _update_calendar_event(user_id: str, event_id: str, new_start_time: str, new_end_time: str, title: str) -> dict[str, Any]:
    """Update one calendar event through the Node bridge."""
    clean_title = title.strip()
    if not clean_title:
        raise ValueError("title 不能为空")
    start_time = _validate_iso_datetime(new_start_time, "new_start_time")
    end_time = _validate_iso_datetime(new_end_time, "new_end_time")
    return await _bridge_request(
        "update_event",
        user_id,
        {
            "eventId": event_id,
            "title": clean_title,
            "startTime": start_time,
            "endTime": end_time,
        },
    )


async def _delete_calendar_event(user_id: str, event_id: str) -> dict[str, Any]:
    """Soft-delete one calendar event through the Node bridge."""
    return await _bridge_request("delete_event", user_id, {"eventId": event_id})


# 此处填充 @mcp.tool() 工具函数
@mcp.tool()
async def get_calendar_events(user_id: str) -> str:
    """
    查询指定用户的全部日历日程。

    Args:
        user_id: 用户 ID。当前后端 Prisma schema 使用 UUID 字符串，传入数字时会自动转换为字符串。
    """
    try:
        result = await _query_calendar_events(_normalize_id(user_id, "user_id"))
        return _json_text(result)
    except Exception as error:
        logger.exception("get_calendar_events failed")
        return _json_text({"code": 500, "message": str(error), "data": None})


@mcp.tool()
async def create_schedule_task(task_name: str, deadline: str, duration: int, user_id: str) -> str:
    """
    调用原有日历后端的 Agent 排期流程生成日程，并在后端允许自动创建时写入数据库。

    Args:
        task_name: 需要排期的任务名称。
        deadline: 截止时间，必须是 ISO 日期时间字符串，例如 2026-09-10T23:59:00+08:00。
        duration: 任务预计总耗时，单位为分钟，必须是正整数。
        user_id: 用户 ID。当前后端 Prisma schema 使用 UUID 字符串，传入数字时会自动转换为字符串。
    """
    try:
        result = await _create_schedule(task_name, deadline, int(duration), _normalize_id(user_id, "user_id"))
        return _json_text(result)
    except Exception as error:
        logger.exception("create_schedule_task failed")
        return _json_text({"code": 500, "message": str(error), "data": None})


@mcp.tool()
async def update_event(event_id: str, new_start_time: str, new_end_time: str, title: str, user_id: str) -> str:
    """
    修改一条已存在的日程。

    Args:
        event_id: 日程 ID。当前后端 CalendarEvent.id 是 UUID 字符串，传入数字时会自动转换为字符串。
        new_start_time: 新开始时间，必须是 ISO 日期时间字符串。
        new_end_time: 新结束时间，必须是 ISO 日期时间字符串。
        title: 新日程标题，不能为空。
        user_id: 用户 ID，用于确保只修改该用户自己的日程。
    """
    try:
        result = await _update_calendar_event(
            _normalize_id(user_id, "user_id"),
            _normalize_id(event_id, "event_id"),
            new_start_time,
            new_end_time,
            title,
        )
        return _json_text(result)
    except Exception as error:
        logger.exception("update_event failed")
        return _json_text({"code": 500, "message": str(error), "data": None})


@mcp.tool()
async def delete_event(event_id: str, user_id: str) -> str:
    """
    删除指定 ID 的日程；当前后端实现为软删除，即写入 deletedAt 而不是物理删除。

    Args:
        event_id: 日程 ID。当前后端 CalendarEvent.id 是 UUID 字符串，传入数字时会自动转换为字符串。
        user_id: 用户 ID，用于确保只删除该用户自己的日程。
    """
    try:
        result = await _delete_calendar_event(_normalize_id(user_id, "user_id"), _normalize_id(event_id, "event_id"))
        return _json_text(result)
    except Exception as error:
        logger.exception("delete_event failed")
        return _json_text({"code": 500, "message": str(error), "data": None})


async def main():
    await mcp.run_stdio()

if __name__ == "__main__":
    import asyncio
    asyncio.run(main())
