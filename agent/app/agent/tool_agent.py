import json
import os
import urllib.request
from pathlib import Path
from typing import Any

from .tools import dispatch_tool_call, get_tool_specs


DEEPSEEK_BASE_URL = "https://api.deepseek.com"


def _load_node_env_value(name: str) -> str:
    current = Path(__file__).resolve()
    for parent in current.parents:
        env_file = parent / "node_calendar-bff" / ".env"
        if not env_file.exists():
            continue
        for line in env_file.read_text(encoding="utf-8").splitlines():
            stripped = line.strip()
            if not stripped or stripped.startswith("#") or "=" not in stripped:
                continue
            key, value = stripped.split("=", 1)
            if key.strip() == name:
                return value.strip().strip('"').strip("'")
    return ""


def _get_deepseek_api_key() -> str:
    return os.environ.get("DEEPSEEK_API_KEY", "").strip() or _load_node_env_value("DEEPSEEK_API_KEY")


def _get_deepseek_model() -> str:
    return os.environ.get("DEEPSEEK_MODEL", "").strip() or _load_node_env_value("DEEPSEEK_MODEL") or "deepseek-v4-flash"


def _parse_json_object(content: str) -> dict[str, Any]:
    text = content.strip()
    if not text:
        raise ValueError("LLM returned blank content")
    try:
        value = json.loads(text)
    except json.JSONDecodeError:
        start = text.find("{")
        end = text.rfind("}")
        if start < 0 or end <= start:
            raise
        value = json.loads(text[start : end + 1])
    if not isinstance(value, dict):
        raise ValueError("LLM output must be a JSON object")
    return value


def _call_deepseek(messages: list[dict[str, str]], max_tokens: int = 1600) -> str:
    api_key = _get_deepseek_api_key()
    if not api_key:
        raise RuntimeError("DEEPSEEK_API_KEY is not configured")

    body = {
        "model": _get_deepseek_model(),
        "messages": messages,
        "response_format": {"type": "json_object"},
        "temperature": 0,
        "max_tokens": max_tokens,
        "stream": False,
        "thinking": {"type": "disabled"},
    }
    request = urllib.request.Request(
        f"{DEEPSEEK_BASE_URL}/chat/completions",
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
    )
    with urllib.request.urlopen(request, timeout=35) as response:
        raw = response.read().decode("utf-8")

    data = json.loads(raw)
    content = data.get("choices", [{}])[0].get("message", {}).get("content", "")
    if not content:
        raise RuntimeError(f"LLM returned empty content: {raw[:1000]}")
    return content


def _normalize_tool_calls(value: dict[str, Any]) -> list[dict[str, Any]]:
    if isinstance(value.get("toolCalls"), list):
        return [item for item in value["toolCalls"] if isinstance(item, dict)]
    if isinstance(value.get("tool_call"), dict):
        return [value["tool_call"]]
    if isinstance(value.get("tool"), str):
        return [value]
    return []


def _build_tool_selection_messages(user_input: str) -> list[dict[str, str]]:
    return [
        {
            "role": "system",
            "content": "\n".join(
                [
                    "你是一个简易 Agent 工具选择器。",
                    "你只能从 tools 列表中选择工具，不允许发明新工具。",
                    "如果需要工具，输出 JSON：",
                    json.dumps({"toolCalls": [{"tool": "web_search", "args": {"q": "关键词", "count": 3}}]}, ensure_ascii=False),
                    "如果不需要工具，输出：",
                    json.dumps({"toolCalls": [], "reason": "无需工具"}, ensure_ascii=False),
                    "可用 tools：",
                    json.dumps(get_tool_specs(), ensure_ascii=False),
                    "只返回 JSON object，不要 markdown。",
                ]
            ),
        },
        {"role": "user", "content": user_input},
    ]


def _build_final_messages(user_input: str, tool_calls: list[dict[str, Any]], tool_results: list[dict[str, Any]]) -> list[dict[str, str]]:
    return [
        {
            "role": "system",
            "content": "\n".join(
                [
                    "你是 Agent 最终回答生成器。",
                    "请基于用户需求和 toolResults 整合最终答案。",
                    "如果 toolResults 中有 errors，要如实说明工具访问失败，不要编造外部来源。",
                    "输出 JSON object：",
                    json.dumps({"answer": "最终答案", "usedTools": [], "toolErrors": []}, ensure_ascii=False),
                    "只返回 JSON object，不要 markdown。",
                ]
            ),
        },
        {
            "role": "user",
            "content": json.dumps(
                {
                    "userInput": user_input,
                    "toolCalls": tool_calls,
                    "toolResults": tool_results,
                },
                ensure_ascii=False,
            ),
        },
    ]


def run_tool_agent(payload: dict[str, Any]) -> dict[str, Any]:
    user_input = str(payload.get("input") or payload.get("userInput") or "").strip()
    if not user_input:
        return {
            "status": "failed",
            "answer": "",
            "toolCalls": [],
            "toolResults": [],
            "errors": ["input is required"],
        }

    tool_selection_raw = _call_deepseek(_build_tool_selection_messages(user_input))
    tool_selection = _parse_json_object(tool_selection_raw)
    tool_calls = _normalize_tool_calls(tool_selection)
    tool_results = [dispatch_tool_call(tool_call) for tool_call in tool_calls]

    print("[Python Agent] Dispatched tool calls JSON:")
    print(json.dumps({"toolCalls": tool_calls, "toolResults": tool_results}, ensure_ascii=False, indent=2), flush=True)

    final_raw = _call_deepseek(_build_final_messages(user_input, tool_calls, tool_results))
    final_answer = _parse_json_object(final_raw)
    response = {
        "status": "ready",
        "answer": final_answer.get("answer", ""),
        "toolCalls": tool_calls,
        "toolResults": tool_results,
        "final": final_answer,
        "errors": final_answer.get("toolErrors", []),
    }
    print("[Python Agent] Tool agent final JSON:")
    print(json.dumps(response, ensure_ascii=False, indent=2), flush=True)
    return response
