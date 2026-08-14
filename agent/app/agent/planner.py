import json
import os
import urllib.request
from pathlib import Path
from typing import Any

from .tools import calendar_events_query, research_task_duration


DEEPSEEK_BASE_URL = "https://api.deepseek.com"


def _read_positive_int(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)) and value > 0:
        return int(round(value))
    if isinstance(value, str) and value.strip().isdigit():
        return int(value.strip())
    return None


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


def _now_iso() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def query_existing_calendar_events(payload: dict[str, Any], normalized_context: dict[str, Any]) -> dict[str, Any]:
    user_id = str(payload.get("userId", "")).strip()
    deadline = str(normalized_context.get("deadline", "")).strip()
    if not user_id:
        return {
            "tool": "calendar_events_query",
            "events": [],
            "errors": ["calendar_events_query: missing userId"],
        }
    if not deadline:
        return {
            "tool": "calendar_events_query",
            "events": [],
            "errors": ["calendar_events_query: missing normalizedContext.deadline"],
        }
    return calendar_events_query(user_id, _now_iso(), deadline)


def _parse_json_object(content: str) -> dict[str, Any]:
    text = content.strip()
    if not text:
        raise ValueError("LLM planning returned blank content")
    try:
        value = json.loads(text)
    except json.JSONDecodeError:
        start = text.find("{")
        end = text.rfind("}")
        if start < 0 or end <= start:
            raise
        value = json.loads(text[start : end + 1])
    if not isinstance(value, dict):
        raise ValueError("LLM planning output must be a JSON object")
    return value


def _request_deepseek_for_atomic_tasks(payload: dict[str, Any], attempt: int) -> dict[str, str]:
    api_key = _get_deepseek_api_key()
    if not api_key:
        raise RuntimeError("DEEPSEEK_API_KEY is not configured for Python planner")

    body: dict[str, Any] = {
        "model": _get_deepseek_model(),
        "messages": [
            {
                "role": "system",
                "content": "\n".join(
                    [
                        "你是 Python Agent 的 Plan 层。",
                        "你必须基于 toolResults 中真实外部网页搜索结果，拆解用户任务本体。",
                        "先拆原子任务，不要排具体日期时间。",
                        "每个原子任务必须有 title、durationRangeMinutes、plannedMinutes、dependsOn、evidence。",
                        "durationRangeMinutes 是 [min,max]，plannedMinutes 取区间中位或更合理值。",
                        "dependsOn 填前置任务 title 数组；没有依赖填空数组。",
                        "evidence 至少引用一个 toolResults 里的来源；如果来源不足，说明 evidenceNote。",
                        "只返回 JSON object，不要 markdown。",
                        f"attempt={attempt}",
                    ]
                ),
            },
            {"role": "user", "content": json.dumps(payload, ensure_ascii=False)},
        ],
        "temperature": 0.2,
        "max_tokens": 3600,
        "thinking": {"type": "disabled"},
        "stream": False,
    }
    if attempt <= 2:
        body["response_format"] = {"type": "json_object"}

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
    choice = data.get("choices", [{}])[0] if isinstance(data.get("choices"), list) else {}
    message = choice.get("message", {}) if isinstance(choice, dict) else {}
    return {
        "content": str(message.get("content") or ""),
        "finishReason": str(choice.get("finish_reason") or ""),
        "reasoningPreview": str(message.get("reasoning_content") or "")[:300],
        "raw": raw,
    }


def _call_deepseek_for_atomic_tasks(payload: dict[str, Any]) -> dict[str, Any]:
    last_result: dict[str, str] = {}
    for attempt in range(1, 4):
        result = _request_deepseek_for_atomic_tasks(payload, attempt)
        last_result = result
        if result["content"].strip():
            return _parse_json_object(result["content"])

        print("[Python Agent] DeepSeek planning returned blank content, retrying:")
        print(
            json.dumps(
                {
                    "attempt": attempt,
                    "finishReason": result.get("finishReason", ""),
                    "reasoningPreview": result.get("reasoningPreview", ""),
                    "raw": result.get("raw", "")[:1200],
                },
                ensure_ascii=False,
                indent=2,
            ),
            flush=True,
        )

    raise RuntimeError(
        "LLM planning returned blank content after retries: "
        + json.dumps(
            {
                "finishReason": last_result.get("finishReason", ""),
                "reasoningPreview": last_result.get("reasoningPreview", ""),
                "raw": last_result.get("raw", "")[:1200],
            },
            ensure_ascii=False,
        )
    )


def _normalize_atomic_tasks(value: Any) -> list[dict[str, Any]]:
    source = value if isinstance(value, list) else []
    tasks: list[dict[str, Any]] = []
    for index, item in enumerate(source, start=1):
        if not isinstance(item, dict):
            continue
        title = str(item.get("title", "")).strip() or f"子任务 {index}"
        duration_range = item.get("durationRangeMinutes")
        if not isinstance(duration_range, list) or len(duration_range) != 2:
            planned = _read_positive_int(item.get("plannedMinutes")) or 30
            duration_range = [max(1, planned - 10), planned + 10]
        min_minutes = _read_positive_int(duration_range[0]) or 1
        max_minutes = _read_positive_int(duration_range[1]) or min_minutes
        if max_minutes < min_minutes:
            min_minutes, max_minutes = max_minutes, min_minutes
        planned_minutes = _read_positive_int(item.get("plannedMinutes")) or round((min_minutes + max_minutes) / 2)
        depends_on = item.get("dependsOn") if isinstance(item.get("dependsOn"), list) else []
        evidence = item.get("evidence") if isinstance(item.get("evidence"), list) else []
        tasks.append(
            {
                "title": title,
                "durationRangeMinutes": [min_minutes, max_minutes],
                "plannedMinutes": planned_minutes,
                "dependsOn": [str(dep) for dep in depends_on],
                "evidence": evidence,
                "order": index,
            }
        )
    return tasks


def _build_evidence_lookup(tool_results: list[dict[str, Any]]) -> dict[str, dict[str, str]]:
    lookup: dict[str, dict[str, str]] = {}
    for tool_result in tool_results:
        if not isinstance(tool_result, dict):
            continue
        query = str(tool_result.get("query", "")).strip()
        provider = str(tool_result.get("provider", "")).strip()
        results = tool_result.get("results") if isinstance(tool_result.get("results"), list) else []
        for item in results:
            if not isinstance(item, dict):
                continue
            url = str(item.get("url", "")).strip()
            if not url or url in lookup:
                continue
            lookup[url] = {
                "title": str(item.get("title", "")).strip(),
                "url": url,
                "snippet": str(item.get("snippet", "")).strip(),
                "query": query,
                "tool": "web_search",
                "provider": provider,
            }
    return lookup


def enrich_atomic_task_evidence(atomic_tasks: list[dict[str, Any]], tool_results: list[dict[str, Any]]) -> list[dict[str, Any]]:
    lookup = _build_evidence_lookup(tool_results)
    for task in atomic_tasks:
        evidence = task.get("evidence") if isinstance(task.get("evidence"), list) else []
        enriched_evidence: list[dict[str, str]] = []
        for item in evidence:
            if not isinstance(item, dict):
                continue
            url = str(item.get("url", "")).strip()
            source = lookup.get(url, {})
            enriched = {
                "title": str(item.get("title") or source.get("title", "")).strip(),
                "url": url or source.get("url", ""),
                "snippet": str(item.get("snippet") or source.get("snippet", "")).strip(),
                "query": str(item.get("query") or source.get("query", "")).strip(),
                "tool": str(item.get("tool") or source.get("tool", "web_search")).strip(),
                "provider": str(item.get("provider") or source.get("provider", "")).strip(),
            }
            enriched_evidence.append({key: value for key, value in enriched.items() if value})
        task["evidence"] = enriched_evidence
    return atomic_tasks


def validate_atomic_plan(atomic_tasks: list[dict[str, Any]], normalized_context: dict[str, Any]) -> dict[str, Any]:
    available_minutes = _read_positive_int(normalized_context.get("totalMinutes"))
    required_minutes = sum(_read_positive_int(task.get("plannedMinutes")) or 0 for task in atomic_tasks)
    issues: list[str] = []
    if available_minutes is None:
        issues.append("normalizedContext.totalMinutes 缺失或无效")
    if not atomic_tasks:
        issues.append("没有生成原子任务")
    known_titles = {str(task.get("title")) for task in atomic_tasks}
    for task in atomic_tasks:
        for dependency in task.get("dependsOn", []):
            if dependency not in known_titles:
                issues.append(f"{task.get('title')} 的依赖不存在: {dependency}")
    if available_minutes is not None and required_minutes > available_minutes:
        issues.append(f"原子任务总耗时({required_minutes}) 超过用户可用总时长({available_minutes})")
    return {
        "status": "ok" if not issues else "overloaded",
        "availableMinutes": available_minutes,
        "requiredMinutes": required_minutes,
        "issues": issues,
    }


def plan_atomic_tasks(payload: dict[str, Any]) -> dict[str, Any]:
    raw_input = str(payload.get("rawInput", "")).strip()
    normalized_context = payload.get("normalizedContext") if isinstance(payload.get("normalizedContext"), dict) else {}
    tool_results = research_task_duration(raw_input, normalized_context)
    print("[Python Agent] Tool results JSON:")
    print(json.dumps(tool_results, ensure_ascii=False, indent=2), flush=True)

    has_external_evidence = any(result.get("results") for result in tool_results if isinstance(result, dict))
    if not has_external_evidence:
        raise RuntimeError("外部网站工具没有取得真实搜索结果，请配置 TAVILY_API_KEY 或检查网络后重试")
    llm_payload = {
        "rawInput": raw_input,
        "normalizedContext": normalized_context,
        "userPreference": payload.get("userPreference", {}),
        "toolResults": tool_results,
        "requiredOutput": {
            "atomicTasks": [
                {
                    "title": "原子子任务",
                    "durationRangeMinutes": [80, 100],
                    "plannedMinutes": 90,
                    "dependsOn": [],
                    "evidence": [{"title": "来源标题", "url": "https://..."}],
                }
            ]
        },
    }
    llm_result = _call_deepseek_for_atomic_tasks(llm_payload)
    atomic_tasks = enrich_atomic_task_evidence(_normalize_atomic_tasks(llm_result.get("atomicTasks")), tool_results)
    calendar_events_tool_result = query_existing_calendar_events(payload, normalized_context)
    print("[Python Agent] Existing calendar events JSON:")
    print(json.dumps(calendar_events_tool_result, ensure_ascii=False, indent=2), flush=True)
    feasibility = validate_atomic_plan(atomic_tasks, normalized_context)
    response = {
        "status": "ready" if feasibility["status"] == "ok" else "overloaded",
        "atomicTasks": atomic_tasks,
        "totalEstimatedMinutes": feasibility["requiredMinutes"],
        "feasibility": feasibility,
        "toolResults": tool_results,
        "calendarEventsToolResult": calendar_events_tool_result,
    }
    print("[Python Agent] Atomic plan result:")
    print(json.dumps(response, ensure_ascii=False, indent=2), flush=True)
    return response
