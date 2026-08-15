import json
from http import HTTPStatus
from typing import Any

from .executor import accept_task
from .planner import plan_atomic_tasks, resume_schedule_decision
from .tool_agent import run_tool_agent
from .validators import validate_fields


def handle_get(path: str) -> tuple[int, dict[str, Any]]:
    if path == "/health":
        return HTTPStatus.OK, {"status": "ok"}
    return HTTPStatus.NOT_FOUND, {"message": "Not found"}


def handle_post(path: str, raw_body: str) -> tuple[int, dict[str, Any]]:
    try:
        payload = json.loads(raw_body) if raw_body else {}
    except json.JSONDecodeError as error:
        return HTTPStatus.BAD_REQUEST, {"message": f"Invalid JSON: {error}"}

    if not isinstance(payload, dict):
        return HTTPStatus.BAD_REQUEST, {"message": "Request body must be a JSON object"}

    if path == "/agent/validate":
        result = validate_fields(payload)
        return HTTPStatus.OK, result.to_response()

    if path == "/agent/plan":
        try:
            return HTTPStatus.OK, plan_atomic_tasks(payload)
        except Exception as error:  # noqa: BLE001 - agent tool failures are returned as structured payload
            return HTTPStatus.OK, {
                "status": "failed",
                "atomicTasks": [],
                "totalEstimatedMinutes": 0,
                "feasibility": {
                    "status": "overloaded",
                    "requiredMinutes": 0,
                    "issues": [f"Python Agent 规划工具失败: {error}"],
                },
                "toolResults": [],
            }

    if path == "/agent/resume":
        try:
            return HTTPStatus.OK, resume_schedule_decision(payload)
        except Exception as error:  # noqa: BLE001
            return HTTPStatus.OK, {
                "status": "failed",
                "message": f"Python Agent 恢复排期失败: {error}",
                "atomicTasks": [],
                "scheduleToolResult": {
                    "tool": "schedule_tasks",
                    "status": "failed",
                    "draftAllocations": [],
                    "remainingFreeWindows": [],
                    "interrupt": None,
                    "errors": [str(error)],
                },
            }

    if path == "/agent/tool-agent":
        try:
            return HTTPStatus.OK, run_tool_agent(payload)
        except Exception as error:  # noqa: BLE001
            return HTTPStatus.OK, {
                "status": "failed",
                "answer": "",
                "toolCalls": [],
                "toolResults": [],
                "errors": [f"Python Agent 工具调度失败: {error}"],
            }

    if path == "/agent/tasks":
        return HTTPStatus.OK, accept_task(payload)

    return HTTPStatus.NOT_FOUND, {"message": "Not found"}
