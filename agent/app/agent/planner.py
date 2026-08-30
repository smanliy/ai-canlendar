import json
import os
import re
import urllib.request
from pathlib import Path
from typing import Any

from .langsmith_tracing import traceable
from .tracing import add_edge, add_node, create_trace, finish_node, finish_trace
from .tools import calculate_free_windows, calendar_events_query, check_schedule_conflicts, research_task_duration, schedule_tasks, web_search_tool

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


def calculate_available_free_windows(
    payload: dict[str, Any],
    calendar_events_tool_result: dict[str, Any],
) -> dict[str, Any]:
    args = calendar_events_tool_result.get("args") if isinstance(calendar_events_tool_result.get("args"), dict) else {}
    start_iso = str(args.get("startIso", "")).strip()
    end_iso = str(args.get("endIso", "")).strip()
    calendar_events = calendar_events_tool_result.get("events") if isinstance(calendar_events_tool_result.get("events"), list) else []
    user_preference = payload.get("userPreference") if isinstance(payload.get("userPreference"), dict) else {}
    return calculate_free_windows(
        start_iso=start_iso,
        end_iso=end_iso,
        calendar_events=calendar_events,
        user_preference=user_preference,
        draft_allocations=[],
    )


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


def _empty_usage() -> dict[str, Any]:
    return {"promptTokens": 0, "completionTokens": 0, "totalTokens": 0, "model": _get_deepseek_model()}


def _read_usage(data: dict[str, Any]) -> dict[str, Any]:
    usage = data.get("usage") if isinstance(data.get("usage"), dict) else {}
    prompt_tokens = _read_positive_int(usage.get("prompt_tokens"))
    completion_tokens = _read_positive_int(usage.get("completion_tokens"))
    total_tokens = _read_positive_int(usage.get("total_tokens"))
    if prompt_tokens is None or completion_tokens is None or total_tokens is None:
        return _empty_usage()
    return {
        "promptTokens": prompt_tokens,
        "completionTokens": completion_tokens,
        "totalTokens": total_tokens,
        "model": _get_deepseek_model(),
    }


def _merge_usage(target: dict[str, Any], source: dict[str, Any]) -> dict[str, Any]:
    return {
        "promptTokens": int(target.get("promptTokens", 0)) + int(source.get("promptTokens", 0)),
        "completionTokens": int(target.get("completionTokens", 0)) + int(source.get("completionTokens", 0)),
        "totalTokens": int(target.get("totalTokens", 0)) + int(source.get("totalTokens", 0)),
        "model": str(target.get("model") or source.get("model") or _get_deepseek_model()),
    }


@traceable(name="deepseek_atomic_task_split", run_type="llm")
def _request_deepseek_for_atomic_tasks(payload: dict[str, Any], attempt: int) -> dict[str, Any]:
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
                        "你必须基于 toolResults 中真实外部网页搜索结果，判断用户任务是否需要拆解。",
                        "简单的一次性事件、提醒、会议或很小的原子任务不要强拆，返回 1 个 atomicTask 表示完整工作。",
                        "只有复杂任务存在多个有意义阶段时才拆成 2 到 6 个 atomicTasks。",
                        "先给出原子任务，不要排具体日期时间。",
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
        "usage": _read_usage(data),
    }


def _call_deepseek_for_atomic_tasks(payload: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    last_result: dict[str, Any] = {}
    total_usage = _empty_usage()
    for attempt in range(1, 4):
        result = _request_deepseek_for_atomic_tasks(payload, attempt)
        last_result = result
        total_usage = _merge_usage(total_usage, result.get("usage") if isinstance(result.get("usage"), dict) else _empty_usage())
        if result["content"].strip():
            return _parse_json_object(result["content"]), total_usage

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


@traceable(name="deepseek_task_shape_decision", run_type="llm")
def _request_deepseek_for_task_shape(payload: dict[str, Any]) -> dict[str, Any]:
    api_key = _get_deepseek_api_key()
    if not api_key:
        raise RuntimeError("DEEPSEEK_API_KEY is not configured for Python task shape decision")

    body: dict[str, Any] = {
        "model": _get_deepseek_model(),
        "messages": [
            {
                "role": "system",
                "content": "\n".join(
                    [
                        "你是日程 Agent 的任务形态判定节点。",
                        "你只判断用户需求是否需要拆分，不负责排具体时间，不调用工具。",
                        "如果是洗澡、吃饭、睡觉、开会、提醒、取快递、打电话、跑步等单一生活/事务事项，decision=atomic。",
                        "如果是报告、论文、学习、复习、开发、设计、调研、备考、项目等由多个阶段组成的工作，decision=needs_decomposition。",
                        "不要因为用户给了 1 小时就强行拆分；时长长短不是唯一依据，关键看语义上是否有多个必要阶段。",
                        "只返回 JSON object，不要 markdown。",
                        'JSON shape: {"decision":"atomic|needs_decomposition","reason":"简短原因","suggestedTitle":"任务标题"}',
                    ]
                ),
            },
            {"role": "user", "content": json.dumps(payload, ensure_ascii=False)},
        ],
        "temperature": 0,
        "max_tokens": 800,
        "thinking": {"type": "disabled"},
        "stream": False,
        "response_format": {"type": "json_object"},
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
    with urllib.request.urlopen(request, timeout=25) as response:
        raw = response.read().decode("utf-8")
    data = json.loads(raw)
    choice = data.get("choices", [{}])[0] if isinstance(data.get("choices"), list) else {}
    message = choice.get("message", {}) if isinstance(choice, dict) else {}
    return {
        "content": str(message.get("content") or ""),
        "usage": _read_usage(data),
    }


def _classify_task_shape_with_llm(raw_input: str, normalized_context: dict[str, Any], user_preference: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    result = _request_deepseek_for_task_shape(
        {
            "rawInput": raw_input,
            "normalizedContext": normalized_context,
            "userPreference": user_preference,
        }
    )
    content = _parse_json_object(result.get("content", ""))
    decision = str(content.get("decision") or "").strip()
    if decision not in {"atomic", "needs_decomposition"}:
        raise RuntimeError(f"LLM task shape decision invalid: {decision}")
    return {
        "decision": decision,
        "reason": str(content.get("reason") or "").strip(),
        "suggestedTitle": str(content.get("suggestedTitle") or "").strip(),
    }, result.get("usage") if isinstance(result.get("usage"), dict) else _empty_usage()


@traceable(name="deepseek_task_split", run_type="llm")
def _request_deepseek_for_task_split(payload: dict[str, Any]) -> dict[str, Any]:
    api_key = _get_deepseek_api_key()
    if not api_key:
        raise RuntimeError("DEEPSEEK_API_KEY is not configured for Python task split")

    body: dict[str, Any] = {
        "model": _get_deepseek_model(),
        "messages": [
            {
                "role": "system",
                "content": "\n".join(
                    [
                        "你是 Python Agent 的局部拆分节点。",
                        "你只能拆分 parentTask，不能重新规划全部任务，不能改变其他任务。",
                        "必须保持 parentTask 的语义边界，不能新增 parentTask 范围外的新主题。",
                        "existingEvidence 是父任务上下文，newToolResults 只能补充细节，不能扩大任务范围。",
                        "如果搜索结果和 parentTask 冲突，以 parentTask 为准。",
                        "拆分后 subtasks 数量 2 到 6 个。",
                        "你只负责语义拆分，不决定最终分钟数；plannedMinutes 会被 Python 预算分配器忽略并重算。",
                        "每个子任务必须有 title、taskType、dependsOn、evidence、parentCoverage。",
                        "taskType 只能是 learn、practice、project、review、test、setup 之一。",
                        "只返回 JSON object，不要 markdown。",
                    ]
                ),
            },
            {"role": "user", "content": json.dumps(payload, ensure_ascii=False)},
        ],
        "temperature": 0.15,
        "max_tokens": 5200,
        "thinking": {"type": "disabled"},
        "stream": False,
        "response_format": {"type": "json_object"},
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
    choice = data.get("choices", [{}])[0] if isinstance(data.get("choices"), list) else {}
    message = choice.get("message", {}) if isinstance(choice, dict) else {}
    content = str(message.get("content") or "").strip()
    if not content:
        raise RuntimeError("LLM task split returned blank content")
    try:
        return {
            "content": _parse_json_object(content),
            "usage": _read_usage(data),
        }
    except json.JSONDecodeError as error:
        print("[Python Agent] LLM task split returned invalid JSON:")
        print(
            json.dumps(
                {
                    "error": str(error),
                    "contentPreview": content[:2000],
                    "contentTail": content[-1000:],
                },
                ensure_ascii=False,
                indent=2,
            ),
            flush=True,
        )
        raise RuntimeError(f"LLM task split returned invalid JSON: {error}") from error


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


def _build_single_atomic_task(raw_input: str, normalized_context: dict[str, Any]) -> list[dict[str, Any]]:
    planned_minutes = _read_positive_int(normalized_context.get("totalMinutes")) or _extract_minutes_from_text(raw_input) or 30
    title = str(normalized_context.get("taskName") or normalized_context.get("title") or raw_input).strip() or "日程任务"
    if len(title) > 36:
        title = title[:36]
    return [
        {
            "title": title,
            "durationRangeMinutes": [max(1, planned_minutes - 10), planned_minutes + 10],
            "plannedMinutes": planned_minutes,
            "dependsOn": [],
            "evidence": [],
            "evidenceNote": "简单原子任务无需外部资料，按用户输入和字段抽取结果直接排期。",
            "order": 1,
        }
    ]


def _is_simple_atomic_request(raw_input: str, normalized_context: dict[str, Any]) -> bool:
    text = raw_input.strip()
    compact_text = re.sub(r"\s+", "", text)
    total_minutes = _read_positive_int(normalized_context.get("totalMinutes")) or _extract_minutes_from_text(text)
    complex_keywords = [
        "报告",
        "论文",
        "项目",
        "开发",
        "实现",
        "设计",
        "调研",
        "学习",
        "复习",
        "备考",
        "准备",
        "整理",
        "制作",
        "方案",
        "作业",
        "考试",
        "面试",
        "写",
    ]
    simple_keywords = [
        "洗澡",
        "洗漱",
        "吃饭",
        "早餐",
        "午饭",
        "晚饭",
        "睡觉",
        "午睡",
        "跑步",
        "健身",
        "散步",
        "开会",
        "会议",
        "看医生",
        "取快递",
        "打电话",
        "提醒",
    ]
    has_simple_keyword = any(keyword in compact_text for keyword in simple_keywords)
    has_complex_keyword = any(keyword in compact_text for keyword in complex_keywords)
    if has_simple_keyword and not has_complex_keyword:
        return True
    return bool(total_minutes and total_minutes <= 120 and len(compact_text) <= 50 and not has_complex_keyword)


TASK_TYPE_BASE_WEIGHTS = {
    "setup": 1,
    "review": 2,
    "learn": 3,
    "test": 3,
    "practice": 4,
    "project": 4,
}

MIN_EXECUTABLE_MINUTES = 20


def _infer_task_type(title: str, item: dict[str, Any]) -> str:
    raw_type = str(item.get("taskType") or item.get("type") or "").strip().lower()
    if raw_type in TASK_TYPE_BASE_WEIGHTS:
        return raw_type
    if any(keyword in title for keyword in ["练习", "刷题", "题目", "实战", "训练"]):
        return "practice"
    if any(keyword in title for keyword in ["项目", "实践", "demo", "案例"]):
        return "project"
    if any(keyword in title for keyword in ["复盘", "总结", "整理", "错题"]):
        return "review"
    if any(keyword in title for keyword in ["自测", "测试", "模拟面试", "面试"]):
        return "test"
    if any(keyword in title for keyword in ["准备", "环境", "配置", "安装"]):
        return "setup"
    return "learn"


def _extract_minutes_from_text(text: str) -> int:
    values: list[int] = []
    for match in re.finditer(r"(\d+(?:\.\d+)?)\s*(?:小时|小時|h|hour|hours)", text, flags=re.IGNORECASE):
        values.append(round(float(match.group(1)) * 60))
    for match in re.finditer(r"(\d+(?:\.\d+)?)\s*(?:分钟|分鐘|min|mins|minute|minutes)", text, flags=re.IGNORECASE):
        values.append(round(float(match.group(1))))
    chinese_digits = {
        "一": 1,
        "二": 2,
        "两": 2,
        "三": 3,
        "四": 4,
        "五": 5,
        "六": 6,
        "七": 7,
        "八": 8,
        "九": 9,
        "十": 10,
    }
    for match in re.finditer(r"([一二两三四五六七八九十])个?半?小时", text):
        number = chinese_digits.get(match.group(1), 0)
        if number:
            values.append(number * 60 + (30 if "半" in match.group(0) else 0))
    reasonable = [value for value in values if 5 <= value <= 480]
    return reasonable[0] if reasonable else 0


def _extract_reference_minutes(tool_result: dict[str, Any]) -> int:
    results = tool_result.get("results") if isinstance(tool_result.get("results"), list) else []
    for item in results:
        if not isinstance(item, dict):
            continue
        minutes = _extract_minutes_from_text(
            " ".join(
                [
                    str(item.get("title", "")),
                    str(item.get("snippet", "")),
                    str(item.get("content", "")),
                ]
            )
        )
        if minutes:
            return minutes
    return 0


def _research_reference_minutes_for_split_task(title: str, normalized_context: dict[str, Any]) -> tuple[int, dict[str, Any]]:
    raw_input = str(normalized_context.get("rawInput", "")).strip()
    query = f"{title} 学习 耗时 经验"
    if raw_input:
        query = f"{raw_input} {title} 耗时 经验"
    tool_result = web_search_tool(query, limit=2)
    reference_minutes = _extract_reference_minutes(tool_result)
    tool_result["referenceTaskTitle"] = title
    tool_result["referenceMinutes"] = reference_minutes
    return reference_minutes, tool_result


def _distribute_minutes_by_weights(total_minutes: int, weights: list[int]) -> list[int]:
    if total_minutes <= 0 or not weights:
        return []
    safe_weights = [max(1, weight) for weight in weights]
    weight_sum = sum(safe_weights)
    allocations = [max(1, int(total_minutes * weight / weight_sum)) for weight in safe_weights]
    diff = total_minutes - sum(allocations)
    index = 0
    while diff != 0 and allocations:
        cursor = index % len(allocations)
        if diff > 0:
            allocations[cursor] += 1
            diff -= 1
        elif allocations[cursor] > 1:
            allocations[cursor] -= 1
            diff += 1
        index += 1
        if index > total_minutes + len(allocations) * 4:
            break
    return allocations


def _task_minutes(task: dict[str, Any]) -> int:
    return _read_positive_int(task.get("plannedMinutes")) or 0


def _has_slice_title(title: str) -> bool:
    return bool(re.search(r"[（(]\s*\d+\s*/\s*\d+\s*[）)]", title))


def _is_mechanical_slice_task(task: dict[str, Any]) -> bool:
    title = str(task.get("title", ""))
    return isinstance(task.get("budgetSlice"), dict) or _has_slice_title(title)


def _merge_two_budget_tasks(first: dict[str, Any], second: dict[str, Any], reason: str) -> dict[str, Any]:
    first_minutes = _task_minutes(first)
    second_minutes = _task_minutes(second)
    merged = dict(first)
    merged_minutes = first_minutes + second_minutes
    merged["title"] = f"{first.get('title')} + {second.get('title')}"
    merged["plannedMinutes"] = merged_minutes
    merged["durationRangeMinutes"] = [max(1, merged_minutes - 10), merged_minutes + 10]
    first_depends = first.get("dependsOn") if isinstance(first.get("dependsOn"), list) else []
    second_depends = second.get("dependsOn") if isinstance(second.get("dependsOn"), list) else []
    merged["dependsOn"] = list(dict.fromkeys([str(dep) for dep in [*first_depends, *second_depends] if str(dep) != str(first.get("title"))]))
    merged["parentCoverage"] = "；".join(
        part
        for part in [
            str(first.get("parentCoverage", "")).strip(),
            str(second.get("parentCoverage", "")).strip(),
        ]
        if part
    )
    merged["mergedShortTasks"] = [
        *(
            first.get("mergedShortTasks")
            if isinstance(first.get("mergedShortTasks"), list)
            else [{"title": str(first.get("title", "")), "plannedMinutes": first_minutes}]
        ),
        *(
            second.get("mergedShortTasks")
            if isinstance(second.get("mergedShortTasks"), list)
            else [{"title": str(second.get("title", "")), "plannedMinutes": second_minutes}]
        ),
    ]
    merged["mergeReason"] = reason
    return merged


def _merge_short_budget_tasks(tasks: list[dict[str, Any]], max_minutes: int) -> list[dict[str, Any]]:
    if not tasks:
        return []
    min_minutes = min(MIN_EXECUTABLE_MINUTES, max(1, max_minutes or MIN_EXECUTABLE_MINUTES))
    remaining = [dict(task) for task in tasks]
    index = 0
    while index < len(remaining):
        current = remaining[index]
        planned = _task_minutes(current)
        would_create_short_slice = False
        if max_minutes > 0 and planned > max_minutes:
            slice_count = max(2, (planned + max_minutes - 1) // max_minutes)
            would_create_short_slice = min(_distribute_minutes_by_weights(planned, [1] * slice_count) or [planned]) < min_minutes

        if (planned >= min_minutes and not would_create_short_slice) or len(remaining) == 1:
            index += 1
            continue

        reason = (
            f"子任务 {planned} 分钟低于最小可执行时长 {min_minutes} 分钟，已合并到相邻任务"
            if planned < min_minutes
            else f"子任务 {planned} 分钟直接切片会产生低于 {min_minutes} 分钟的碎片，已先合并到相邻任务"
        )
        if index > 0:
            remaining[index - 1] = _merge_two_budget_tasks(remaining[index - 1], current, reason)
            remaining.pop(index)
            index = max(0, index - 1)
            continue

        remaining[index + 1] = _merge_two_budget_tasks(current, remaining[index + 1], reason)
        remaining.pop(index)
    return remaining


def _split_oversized_budget_task(task: dict[str, Any], max_minutes: int) -> list[dict[str, Any]]:
    planned = _read_positive_int(task.get("plannedMinutes")) or 0
    if max_minutes <= 0 or planned <= max_minutes:
        return [task]
    count = max(2, (planned + max_minutes - 1) // max_minutes)
    allocations = _distribute_minutes_by_weights(planned, [1] * count)
    pieces: list[dict[str, Any]] = []
    previous_title = ""
    for index, minutes in enumerate(allocations, start=1):
        title = f"{task.get('title')}（{index}/{count}）"
        piece = dict(task)
        piece["title"] = title
        piece["plannedMinutes"] = minutes
        piece["durationRangeMinutes"] = [max(1, minutes - 10), max(minutes, min(max_minutes, minutes + 10))]
        original_depends = task.get("dependsOn") if isinstance(task.get("dependsOn"), list) else []
        piece["dependsOn"] = [previous_title] if previous_title else original_depends
        piece["parentCoverage"] = f"{task.get('parentCoverage') or task.get('title')} 的第 {index}/{count} 个连续时间片"
        piece["budgetSlice"] = {
            "sourceTaskTitle": str(task.get("title", "")),
            "sliceIndex": index,
            "sliceCount": count,
            "reason": f"单个子任务预算 {planned} 分钟超过最大连续窗口 {max_minutes} 分钟",
        }
        pieces.append(piece)
        previous_title = title
    return pieces


def _apply_python_time_budget_allocator(
    parent_task: dict[str, Any],
    tasks: list[dict[str, Any]],
    max_minutes: int,
) -> list[dict[str, Any]]:
    parent_minutes = _read_positive_int(parent_task.get("plannedMinutes")) or max_minutes
    if not tasks:
        return []
    weights: list[int] = []
    for task in tasks:
        reference_minutes = _read_positive_int(task.get("referenceMinutes")) or 0
        base_weight = _read_positive_int(task.get("baseWeight")) or TASK_TYPE_BASE_WEIGHTS.get(str(task.get("taskType")), 3)
        final_weight = reference_minutes if reference_minutes else base_weight
        task["baseWeight"] = base_weight
        task["finalWeight"] = final_weight
        task["weightReason"] = (
            f"使用工具参考耗时 {reference_minutes} 分钟作为比例权重"
            if reference_minutes
            else f"未获得可用工具耗时，使用 taskType={task.get('taskType')} 的基础权重 {base_weight}"
        )
        weights.append(final_weight)

    allocations = _distribute_minutes_by_weights(parent_minutes, weights)
    budgeted_tasks: list[dict[str, Any]] = []
    for task, planned in zip(tasks, allocations, strict=False):
        task["plannedMinutes"] = planned
        task["durationRangeMinutes"] = [max(1, planned - 10), planned + 10]
        task["budgetAllocation"] = {
            "source": "python_time_budget_allocator",
            "parentPlannedMinutes": parent_minutes,
            "strategy": "tool_reference_minutes_or_task_type_weight",
        }
        budgeted_tasks.append(task)

    merged_tasks = _merge_short_budget_tasks(budgeted_tasks, max_minutes)
    final_tasks: list[dict[str, Any]] = []
    for task in merged_tasks:
        final_tasks.extend(_split_oversized_budget_task(task, max_minutes))
    return final_tasks


def _build_budget_allocation_debug(parent_task: dict[str, Any], split_tasks: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "parentTaskTitle": str(parent_task.get("title", "")),
        "parentPlannedMinutes": _read_positive_int(parent_task.get("plannedMinutes")) or 0,
        "allocatedTotalMinutes": sum(_read_positive_int(task.get("plannedMinutes")) or 0 for task in split_tasks),
        "strategy": "LLM 拆语义，Tools 提供参考耗时，Python 按权重分配父任务总时间",
        "items": [
            {
                "title": str(task.get("title", "")),
                "taskType": str(task.get("taskType", "")),
                "referenceMinutes": _read_positive_int(task.get("referenceMinutes")) or 0,
                "baseWeight": _read_positive_int(task.get("baseWeight")) or 0,
                "finalWeight": _read_positive_int(task.get("finalWeight")) or 0,
                "plannedMinutes": _read_positive_int(task.get("plannedMinutes")) or 0,
                "weightReason": str(task.get("weightReason", "")),
                "budgetSlice": task.get("budgetSlice") if isinstance(task.get("budgetSlice"), dict) else None,
            }
            for task in split_tasks
        ],
    }


def _normalize_split_tasks(
    parent_task: dict[str, Any],
    value: Any,
    max_minutes: int,
    normalized_context: dict[str, Any] | None = None,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    source = value if isinstance(value, list) else []
    tasks: list[dict[str, Any]] = []
    reference_tool_results: list[dict[str, Any]] = []
    for index, item in enumerate(source, start=1):
        if not isinstance(item, dict):
            continue
        title = str(item.get("title", "")).strip()
        if not title:
            continue
        task_type = _infer_task_type(title, item)
        reference_minutes, reference_tool_result = _research_reference_minutes_for_split_task(title, normalized_context or {})
        reference_tool_results.append(reference_tool_result)
        depends_on = item.get("dependsOn") if isinstance(item.get("dependsOn"), list) else []
        evidence = item.get("evidence") if isinstance(item.get("evidence"), list) else parent_task.get("evidence", [])
        tasks.append(
            {
                "title": title,
                "taskType": task_type,
                "referenceMinutes": reference_minutes,
                "dependsOn": [str(dep) for dep in depends_on],
                "evidence": evidence,
                "parentTaskTitle": str(parent_task.get("title", "")),
                "parentCoverage": str(item.get("parentCoverage", "")).strip(),
                "semanticSplitApplied": True,
            }
        )
    return _apply_python_time_budget_allocator(parent_task, tasks, max_minutes), reference_tool_results


def _validate_split_result(parent_task: dict[str, Any], split_tasks: list[dict[str, Any]], max_minutes: int) -> list[str]:
    issues: list[str] = []
    parent_minutes = _read_positive_int(parent_task.get("plannedMinutes")) or 0
    if not 2 <= len(split_tasks) <= 12:
        issues.append("拆分后子任务数量必须在 2 到 12 个之间")
    total_minutes = sum(_read_positive_int(task.get("plannedMinutes")) or 0 for task in split_tasks)
    if parent_minutes and abs(total_minutes - parent_minutes) > max(20, round(parent_minutes * 0.2)):
        issues.append(f"拆分后总时长({total_minutes}) 与原任务时长({parent_minutes}) 偏差过大")
    for task in split_tasks:
        planned = _read_positive_int(task.get("plannedMinutes")) or 0
        if planned > max_minutes:
            issues.append(f"{task.get('title')} 仍然超过最大连续黄金时间 {max_minutes} 分钟")
        if not str(task.get("title", "")).strip():
            issues.append("存在空标题子任务")
    return issues


def _replace_one_task_only(atomic_tasks: list[dict[str, Any]], parent_task: dict[str, Any], split_tasks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    parent_title = str(parent_task.get("title", ""))
    result: list[dict[str, Any]] = []
    inserted = False
    for task in atomic_tasks:
        if str(task.get("title", "")) != parent_title:
            result.append(task)
            continue
        inserted = True
        for split_task in split_tasks:
            result.append(split_task)
    if not inserted:
        result.extend(split_tasks)
    for index, task in enumerate(result, start=1):
        task["order"] = index
    return result


def _find_task_by_id_or_title(atomic_tasks: list[dict[str, Any]], task_id: str) -> dict[str, Any] | None:
    for task in atomic_tasks:
        if not isinstance(task, dict):
            continue
        candidates = [
            str(task.get("id", "")),
            str(task.get("title", "")),
            f"task-{task.get('order', '')}",
        ]
        if task_id in candidates:
            return task
    return None


def _read_interrupt_split_limit(interrupt: dict[str, Any]) -> int:
    interrupt_type = str(interrupt.get("type", ""))
    if interrupt_type == "task_exceeds_golden_window":
        values = [
            interrupt.get("maxGoldenWindowMinutes"),
            interrupt.get("maxAvailableWindowMinutes"),
        ]
    else:
        values = [
            interrupt.get("maxAvailableWindowMinutes"),
            interrupt.get("maxGoldenWindowMinutes"),
        ]
    for value in values:
        minutes = _read_positive_int(value)
        if minutes:
            return minutes
    return 0


def _can_auto_split_interrupt(schedule_tool_result: dict[str, Any]) -> bool:
    if schedule_tool_result.get("status") != "needsDecision":
        return False
    interrupt = schedule_tool_result.get("interrupt") if isinstance(schedule_tool_result.get("interrupt"), dict) else {}
    if not interrupt:
        return False
    interrupt_type = str(interrupt.get("type", ""))
    if interrupt_type not in {"task_exceeds_golden_window", "task_exceeds_available_window"}:
        return False
    return _read_interrupt_split_limit(interrupt) > 0


def _fallback_split_parent_task(parent_task: dict[str, Any], max_minutes: int) -> list[dict[str, Any]]:
    parent_title = str(parent_task.get("title", "")).strip() or "当前子任务"
    parent_minutes = _read_positive_int(parent_task.get("plannedMinutes")) or max_minutes
    if max_minutes <= 0:
        max_minutes = max(30, parent_minutes)
    count = max(2, min(6, (parent_minutes + max_minutes - 1) // max_minutes))
    base_minutes = max(1, parent_minutes // count)
    tasks: list[dict[str, Any]] = []
    previous_title = ""
    for index in range(1, count + 1):
        planned = parent_minutes - base_minutes * (count - 1) if index == count else base_minutes
        planned = max(1, min(planned, max_minutes))
        title = f"{parent_title}（第 {index} 部分）"
        tasks.append(
            {
                "title": title,
                "durationRangeMinutes": [max(1, planned - 10), min(max_minutes, planned + 10)],
                "plannedMinutes": planned,
                "dependsOn": [previous_title] if previous_title else [],
                "evidence": parent_task.get("evidence", []),
                "parentTaskTitle": parent_title,
                "parentCoverage": f"覆盖父任务《{parent_title}》的第 {index}/{count} 个连续部分",
            }
        )
        previous_title = title
    return tasks


def _split_single_task_with_llm(
    parent_task: dict[str, Any],
    atomic_tasks: list[dict[str, Any]],
    normalized_context: dict[str, Any],
    raw_input: str,
    tool_results: list[dict[str, Any]],
    max_minutes: int,
) -> tuple[list[dict[str, Any]], dict[str, Any], list[dict[str, Any]], list[str], dict[str, Any]]:
    supplemental_results = research_task_duration(str(parent_task.get("title", "")), normalized_context)
    split_payload = {
        "originalGoal": raw_input,
        "parentTask": parent_task,
        "maxMinutes": max_minutes,
        "existingEvidence": parent_task.get("evidence", []),
        "globalToolResults": tool_results,
        "newToolResults": supplemental_results,
        "requiredOutput": {
            "subtasks": [
                {
                    "title": "更小子任务",
                    "taskType": "learn",
                    "dependsOn": [],
                    "evidence": [],
                    "parentCoverage": "说明覆盖 parentTask 的哪一部分",
                }
            ]
        },
    }
    total_usage = _empty_usage()
    try:
        llm_result = _request_deepseek_for_task_split(split_payload)
        total_usage = _merge_usage(total_usage, llm_result.get("usage") if isinstance(llm_result.get("usage"), dict) else _empty_usage())
        raw_split_tasks = llm_result.get("content", {}).get("subtasks") if isinstance(llm_result.get("content"), dict) else None
    except Exception as error:  # noqa: BLE001 - fallback keeps the interrupted agent flow alive
        print("[Python Agent] Falling back to deterministic task split after LLM JSON failure:")
        print(str(error), flush=True)
        raw_split_tasks = _fallback_split_parent_task(parent_task, max_minutes)
    normalized_split_tasks, reference_tool_results = _normalize_split_tasks(
        parent_task,
        raw_split_tasks,
        max_minutes,
        normalized_context,
    )
    if not normalized_split_tasks:
        print("[Python Agent] LLM split produced no valid subtasks; using deterministic fallback split.", flush=True)
        normalized_split_tasks, reference_tool_results = _normalize_split_tasks(
            parent_task,
            _fallback_split_parent_task(parent_task, max_minutes),
            max_minutes,
            normalized_context,
        )
    split_tasks = enrich_atomic_task_evidence(
        normalized_split_tasks,
        [*tool_results, *supplemental_results, *reference_tool_results],
    )
    budget_debug = _build_budget_allocation_debug(parent_task, split_tasks)
    print("[Python Agent] Time budget allocation JSON:")
    print(json.dumps(budget_debug, ensure_ascii=False, indent=2), flush=True)
    issues = _validate_split_result(parent_task, split_tasks, max_minutes)
    if issues:
        return (
            atomic_tasks,
            {
                "parentTaskTitle": str(parent_task.get("title", "")),
                "subtaskTitles": [],
                "subtasks": [],
                "toolResults": [*supplemental_results, *reference_tool_results],
                "budgetAllocation": budget_debug,
            },
            [*supplemental_results, *reference_tool_results],
            issues,
            total_usage,
        )

    next_atomic_tasks = _replace_one_task_only(atomic_tasks, parent_task, split_tasks)
    split_result = {
        "parentTaskTitle": str(parent_task.get("title", "")),
        "subtaskTitles": [str(task.get("title", "")) for task in split_tasks],
        "subtasks": split_tasks,
        "toolResults": [*supplemental_results, *reference_tool_results],
        "budgetAllocation": budget_debug,
    }
    return next_atomic_tasks, split_result, [*supplemental_results, *reference_tool_results], [], total_usage


def _split_single_task_mechanically(
    parent_task: dict[str, Any],
    atomic_tasks: list[dict[str, Any]],
    max_minutes: int,
) -> tuple[list[dict[str, Any]], dict[str, Any], list[str]]:
    split_tasks = _split_oversized_budget_task(parent_task, max_minutes)
    issues = _validate_split_result(parent_task, split_tasks, max_minutes)
    if issues:
        return (
            atomic_tasks,
            {
                "parentTaskTitle": str(parent_task.get("title", "")),
                "subtaskTitles": [],
                "subtasks": [],
                "splitMode": "mechanical_slice",
            },
            issues,
        )
    next_atomic_tasks = _replace_one_task_only(atomic_tasks, parent_task, split_tasks)
    split_result = {
        "parentTaskTitle": str(parent_task.get("title", "")),
        "subtaskTitles": [str(task.get("title", "")) for task in split_tasks],
        "subtasks": split_tasks,
        "splitMode": "mechanical_slice",
        "reason": "该任务已经完成语义拆分或属于机械切片，后续只按时间窗口继续切片，不再调用 LLM。",
    }
    return next_atomic_tasks, split_result, []


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


def _attach_excluded_availability_note(
    schedule_tool_result: dict[str, Any],
    free_windows_tool_result: dict[str, Any],
) -> dict[str, Any]:
    if schedule_tool_result.get("status") != "needsDecision":
        return schedule_tool_result
    interrupt = schedule_tool_result.get("interrupt") if isinstance(schedule_tool_result.get("interrupt"), dict) else {}
    if not interrupt:
        return schedule_tool_result

    excluded_windows = free_windows_tool_result.get("excludedWindows") if isinstance(free_windows_tool_result.get("excludedWindows"), list) else []
    if not excluded_windows:
        return schedule_tool_result

    max_excluded_minutes = max([_read_positive_int(window.get("minutes")) or 0 for window in excluded_windows if isinstance(window, dict)] or [0])
    total_excluded_minutes = _read_positive_int(free_windows_tool_result.get("totalExcludedMinutes")) or sum(
        _read_positive_int(window.get("minutes")) or 0 for window in excluded_windows if isinstance(window, dict)
    )
    if total_excluded_minutes <= 0:
        return schedule_tool_result
    total_free_minutes = _read_positive_int(free_windows_tool_result.get("totalFreeMinutes")) or 0
    if total_free_minutes > 0:
        return schedule_tool_result

    next_result = dict(schedule_tool_result)
    next_interrupt = dict(interrupt)
    next_interrupt["excludedWindows"] = excluded_windows
    next_interrupt["maxExcludedWindowMinutes"] = max_excluded_minutes
    next_interrupt["totalExcludedMinutes"] = total_excluded_minutes
    if (_read_positive_int(next_interrupt.get("maxAvailableWindowMinutes")) or 0) == 0:
        next_interrupt["reason"] = (
            f"严格遵守当前偏好后，最大连续可排时间是 0 分钟；"
            f"但有 {total_excluded_minutes} 分钟空闲时间被偏好排除，"
            f"其中最大连续 {max_excluded_minutes} 分钟。请调整偏好或允许例外。"
        )
    next_result["interrupt"] = next_interrupt
    return next_result


def _check_conflicts_after_schedule(
    schedule_tool_result: dict[str, Any],
    calendar_events_tool_result: dict[str, Any],
    decisions: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    if schedule_tool_result.get("status") != "ready":
        payload = {
            "tool": "check_schedule_conflicts",
            "status": "pending",
            "summary": {"blocking": 0, "approved": 0, "total": 0},
            "conflicts": [],
            "errors": ["schedule is not ready; conflict check skipped"],
        }
        print("[Python Agent] Conflict check skipped JSON:")
        print(json.dumps(payload, ensure_ascii=False, indent=2), flush=True)
        return payload
    draft_allocations = schedule_tool_result.get("draftAllocations") if isinstance(schedule_tool_result.get("draftAllocations"), list) else []
    calendar_events = calendar_events_tool_result.get("events") if isinstance(calendar_events_tool_result.get("events"), list) else []
    return check_schedule_conflicts(draft_allocations, calendar_events, decisions or [])


@traceable(name="python_agent_plan", run_type="chain")
def plan_atomic_tasks(payload: dict[str, Any]) -> dict[str, Any]:
    raw_input = str(payload.get("rawInput", "")).strip()
    normalized_context = payload.get("normalizedContext") if isinstance(payload.get("normalizedContext"), dict) else {}
    trace = create_trace(
        "python_agent_plan",
        {
            "rawInput": raw_input,
            "normalizedContext": normalized_context,
        },
    )

    add_node(trace, "plan.start", "接收排期请求", kind="input", detail={"rawInput": raw_input})
    finish_node(trace, "plan.start", detail={"hasNormalizedContext": bool(normalized_context)})

    shape_decision: dict[str, Any]
    shape_usage = _empty_usage()
    try:
        shape_decision, shape_usage = _classify_task_shape_with_llm(
            raw_input,
            normalized_context,
            payload.get("userPreference") if isinstance(payload.get("userPreference"), dict) else {},
        )
    except Exception as error:
        shape_decision = {
            "decision": "atomic" if _is_simple_atomic_request(raw_input, normalized_context) else "needs_decomposition",
            "reason": f"LLM 任务形态判定失败，使用本地兜底：{error}",
            "suggestedTitle": "",
        }

    add_node(trace, "llm.task_shape_decision", "LLM 判断是否需要拆分", kind="llm")
    add_edge(trace, "plan.start", "llm.task_shape_decision")
    finish_node(trace, "llm.task_shape_decision", detail=shape_decision)

    if shape_decision.get("decision") == "atomic":
        tool_results = []
        llm_usage = shape_usage
        atomic_context = dict(normalized_context)
        if shape_decision.get("suggestedTitle"):
            atomic_context["taskName"] = shape_decision.get("suggestedTitle")
        add_node(trace, "python.single_atomic_task", "生成单原子任务", kind="python")
        add_edge(trace, "llm.task_shape_decision", "python.single_atomic_task", label="atomic")
        atomic_tasks = _build_single_atomic_task(raw_input, atomic_context)
        finish_node(trace, "python.single_atomic_task", detail={"taskCount": len(atomic_tasks), "reason": shape_decision.get("reason")})

        add_node(trace, "python.normalize_tasks", "规范化原子任务", kind="python")
        add_edge(trace, "python.single_atomic_task", "python.normalize_tasks")
    else:
        add_node(trace, "tools.research_task_duration", "查询外部资料/耗时参考", kind="tool")
        add_edge(trace, "llm.task_shape_decision", "tools.research_task_duration", label="needs decomposition")
        tool_results = research_task_duration(raw_input, normalized_context)
        finish_node(
            trace,
            "tools.research_task_duration",
            detail={
                "toolResultCount": len(tool_results),
                "resultCount": sum(len(result.get("results", [])) for result in tool_results if isinstance(result, dict)),
                "providers": [str(result.get("provider", "")) for result in tool_results if isinstance(result, dict) and result.get("provider")],
            },
        )
        print("[Python Agent] Tool results JSON:")
        print(json.dumps(tool_results, ensure_ascii=False, indent=2), flush=True)

        has_external_evidence = any(result.get("results") for result in tool_results if isinstance(result, dict))
        if has_external_evidence:
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
            add_node(trace, "llm.atomic_task_split", "DeepSeek 判断/拆分原子任务", kind="llm")
            add_edge(trace, "tools.research_task_duration", "llm.atomic_task_split", label="evidence found")
            llm_result, split_usage = _call_deepseek_for_atomic_tasks(llm_payload)
            llm_usage = _merge_usage(shape_usage, split_usage)
            finish_node(trace, "llm.atomic_task_split", detail={"returnedKeys": list(llm_result.keys())})

            add_node(trace, "python.normalize_tasks", "规范化原子任务", kind="python")
            add_edge(trace, "llm.atomic_task_split", "python.normalize_tasks")
            atomic_tasks = enrich_atomic_task_evidence(_normalize_atomic_tasks(llm_result.get("atomicTasks")), tool_results)
        else:
            llm_usage = shape_usage
            add_node(trace, "python.single_atomic_task", "简单任务单原子兜底", kind="python")
            add_edge(trace, "tools.research_task_duration", "python.single_atomic_task", label="no evidence needed")
            atomic_tasks = _build_single_atomic_task(raw_input, normalized_context)
            finish_node(trace, "python.single_atomic_task", detail={"taskCount": len(atomic_tasks)})

            add_node(trace, "python.normalize_tasks", "规范化原子任务", kind="python")
            add_edge(trace, "python.single_atomic_task", "python.normalize_tasks")
    finish_node(
        trace,
        "python.normalize_tasks",
        detail={
            "taskCount": len(atomic_tasks),
            "totalPlannedMinutes": sum(_read_positive_int(task.get("plannedMinutes")) or 0 for task in atomic_tasks),
        },
    )

    add_node(trace, "tools.calendar_events_query", "查询已有日程", kind="tool")
    add_edge(trace, "python.normalize_tasks", "tools.calendar_events_query")
    calendar_events_tool_result = query_existing_calendar_events(payload, normalized_context)
    finish_node(
        trace,
        "tools.calendar_events_query",
        status="failed" if calendar_events_tool_result.get("errors") else "success",
        detail={
            "eventCount": len(calendar_events_tool_result.get("events", [])) if isinstance(calendar_events_tool_result.get("events"), list) else 0,
            "errors": calendar_events_tool_result.get("errors", []),
        },
    )
    print("[Python Agent] Existing calendar events JSON:")
    print(json.dumps(calendar_events_tool_result, ensure_ascii=False, indent=2), flush=True)

    add_node(trace, "tools.calculate_free_windows", "计算空闲窗口", kind="tool")
    add_edge(trace, "tools.calendar_events_query", "tools.calculate_free_windows")
    free_windows_tool_result = calculate_available_free_windows(payload, calendar_events_tool_result)
    finish_node(
        trace,
        "tools.calculate_free_windows",
        status="failed" if free_windows_tool_result.get("errors") else "success",
        detail={
            "freeWindowCount": len(free_windows_tool_result.get("freeWindows", [])) if isinstance(free_windows_tool_result.get("freeWindows"), list) else 0,
            "totalFreeMinutes": free_windows_tool_result.get("totalFreeMinutes"),
            "errors": free_windows_tool_result.get("errors", []),
        },
    )
    print("[Python Agent] Free windows result JSON:")
    print(json.dumps(free_windows_tool_result, ensure_ascii=False, indent=2), flush=True)

    add_node(trace, "tools.schedule_tasks", "生成排期草稿", kind="tool")
    add_edge(trace, "tools.calculate_free_windows", "tools.schedule_tasks")
    schedule_tool_result = schedule_tasks(
        atomic_tasks=atomic_tasks,
        free_windows=free_windows_tool_result.get("freeWindows") if isinstance(free_windows_tool_result.get("freeWindows"), list) else [],
        decisions=[],
    )
    schedule_tool_result = _attach_excluded_availability_note(schedule_tool_result, free_windows_tool_result)
    schedule_status = str(schedule_tool_result.get("status", ""))
    finish_node(
        trace,
        "tools.schedule_tasks",
        status="waiting" if schedule_status in {"needsDecision", "pending"} else ("failed" if schedule_status == "failed" else "success"),
        detail={
            "status": schedule_status,
            "draftAllocationCount": len(schedule_tool_result.get("draftAllocations", [])) if isinstance(schedule_tool_result.get("draftAllocations"), list) else 0,
            "interrupt": schedule_tool_result.get("interrupt"),
            "errors": schedule_tool_result.get("errors", []),
        },
    )
    print("[Python Agent] Schedule result JSON:")
    print(json.dumps(schedule_tool_result, ensure_ascii=False, indent=2), flush=True)

    add_node(trace, "tools.check_schedule_conflicts", "检测排期冲突", kind="tool")
    add_edge(trace, "tools.schedule_tasks", "tools.check_schedule_conflicts")
    conflict_check_result = _check_conflicts_after_schedule(schedule_tool_result, calendar_events_tool_result, [])
    finish_node(
        trace,
        "tools.check_schedule_conflicts",
        status="waiting" if conflict_check_result.get("status") in {"needsDecision", "pending"} else ("failed" if conflict_check_result.get("status") == "failed" else "success"),
        detail={
            "status": conflict_check_result.get("status"),
            "summary": conflict_check_result.get("summary"),
            "errors": conflict_check_result.get("errors", []),
        },
    )

    add_node(trace, "python.validate_atomic_plan", "校验原子任务体量", kind="python")
    add_edge(trace, "tools.check_schedule_conflicts", "python.validate_atomic_plan")
    feasibility = validate_atomic_plan(atomic_tasks, normalized_context)
    finish_node(trace, "python.validate_atomic_plan", status="success" if feasibility["status"] == "ok" else "failed", detail=feasibility)
    response = {
        "status": "ready" if feasibility["status"] == "ok" else "overloaded",
        "atomicTasks": atomic_tasks,
        "totalEstimatedMinutes": feasibility["requiredMinutes"],
        "feasibility": feasibility,
        "toolResults": tool_results,
        "calendarEventsToolResult": calendar_events_tool_result,
        "freeWindowsToolResult": free_windows_tool_result,
        "scheduleToolResult": schedule_tool_result,
        "conflictCheckResult": conflict_check_result,
        "taskShapeDecision": shape_decision,
        "llmUsage": llm_usage,
        "agentTrace": finish_trace(trace, status="success" if feasibility["status"] == "ok" else "failed", detail={"responseStatus": "ready" if feasibility["status"] == "ok" else "overloaded"}),
    }
    print("[Python Agent] Atomic plan result:")
    print(json.dumps(response, ensure_ascii=False, indent=2), flush=True)
    return response


@traceable(name="python_agent_resume", run_type="chain")
def resume_schedule_decision(payload: dict[str, Any]) -> dict[str, Any]:
    decision = payload.get("decision") if isinstance(payload.get("decision"), dict) else {}
    planning_state = payload.get("planningState") if isinstance(payload.get("planningState"), dict) else {}
    option_id = str(decision.get("optionId", "")).strip()
    task_id = str(decision.get("taskId", "")).strip()
    trace = create_trace(
        "python_agent_resume",
        {
            "decision": decision,
            "taskId": task_id,
            "optionId": option_id,
        },
    )
    add_node(trace, "resume.start", "接收继续执行决策", kind="input", detail={"optionId": option_id, "taskId": task_id})
    finish_node(trace, "resume.start")
    atomic_tasks = planning_state.get("atomicTasks") if isinstance(planning_state.get("atomicTasks"), list) else []
    normalized_context = planning_state.get("normalizedContext") if isinstance(planning_state.get("normalizedContext"), dict) else {}
    tool_results = planning_state.get("toolResults") if isinstance(planning_state.get("toolResults"), list) else []
    calendar_events_tool_result = planning_state.get("calendarEventsToolResult") if isinstance(planning_state.get("calendarEventsToolResult"), dict) else {}
    free_windows_tool_result = planning_state.get("freeWindowsToolResult") if isinstance(planning_state.get("freeWindowsToolResult"), dict) else {}
    free_windows = free_windows_tool_result.get("freeWindows") if isinstance(free_windows_tool_result.get("freeWindows"), list) else []
    schedule_tool_result = planning_state.get("scheduleToolResult") if isinstance(planning_state.get("scheduleToolResult"), dict) else {}
    llm_usage_total = _empty_usage()

    if option_id == "allow_beyond_golden_time":
        add_node(trace, "resume.allow_beyond_golden_time", "允许使用非黄金时间", kind="decision")
        add_edge(trace, "resume.start", "resume.allow_beyond_golden_time", label=option_id)
        finish_node(trace, "resume.allow_beyond_golden_time", detail={"taskId": "*"})
        decisions = [
            {
                **decision,
                "taskId": "*",
                "source": "user_allowed_beyond_golden_time_for_plan",
            }
        ]
        add_node(trace, "tools.schedule_tasks.resume_allow", "重新排期", kind="tool")
        add_edge(trace, "resume.allow_beyond_golden_time", "tools.schedule_tasks.resume_allow")
        next_schedule_tool_result = schedule_tasks(
            atomic_tasks=atomic_tasks,
            free_windows=free_windows,
            decisions=decisions,
        )
        next_schedule_tool_result = _attach_excluded_availability_note(next_schedule_tool_result, free_windows_tool_result)
        finish_node(
            trace,
            "tools.schedule_tasks.resume_allow",
            status="waiting" if next_schedule_tool_result.get("status") in {"needsDecision", "pending"} else ("failed" if next_schedule_tool_result.get("status") == "failed" else "success"),
            detail={
                "status": next_schedule_tool_result.get("status"),
                "draftAllocationCount": len(next_schedule_tool_result.get("draftAllocations", [])) if isinstance(next_schedule_tool_result.get("draftAllocations"), list) else 0,
                "interrupt": next_schedule_tool_result.get("interrupt"),
            },
        )
        add_node(trace, "tools.check_schedule_conflicts.resume_allow", "检测冲突", kind="tool")
        add_edge(trace, "tools.schedule_tasks.resume_allow", "tools.check_schedule_conflicts.resume_allow")
        conflict_check_result = _check_conflicts_after_schedule(next_schedule_tool_result, calendar_events_tool_result, decisions)
        finish_node(
            trace,
            "tools.check_schedule_conflicts.resume_allow",
            status="waiting" if conflict_check_result.get("status") in {"needsDecision", "pending"} else ("failed" if conflict_check_result.get("status") == "failed" else "success"),
            detail={"status": conflict_check_result.get("status"), "summary": conflict_check_result.get("summary")},
        )
        response = {
            "status": "ready",
            "atomicTasks": atomic_tasks,
            "scheduleToolResult": next_schedule_tool_result,
            "conflictCheckResult": conflict_check_result,
            "toolResults": tool_results,
            "llmUsage": llm_usage_total,
            "agentTrace": finish_trace(trace, status="success", detail={"branch": "allow_beyond_golden_time"}),
        }
        print("[Python Agent] Resume allow non-golden result JSON:")
        print(json.dumps(response, ensure_ascii=False, indent=2), flush=True)
        return response

    if option_id != "split_task":
        add_node(trace, "resume.unsupported", "不支持的继续执行选项", kind="decision", status="failed")
        add_edge(trace, "resume.start", "resume.unsupported", label=option_id or "empty")
        finish_node(trace, "resume.unsupported", status="failed", detail={"optionId": option_id})
        return {
            "status": "unsupported",
            "message": f"暂时只实现 split_task，当前 optionId={option_id}",
            "atomicTasks": atomic_tasks,
            "scheduleToolResult": schedule_tool_result,
            "llmUsage": llm_usage_total,
            "agentTrace": finish_trace(trace, status="failed", detail={"branch": "unsupported"}),
        }

    add_node(trace, "resume.find_parent_task", "定位需要拆分的任务", kind="python")
    add_edge(trace, "resume.start", "resume.find_parent_task", label="split_task")
    parent_task = _find_task_by_id_or_title(atomic_tasks, task_id)
    if not parent_task:
        finish_node(trace, "resume.find_parent_task", status="failed", detail={"taskId": task_id})
        return {
            "status": "failed",
            "message": f"没有找到要拆分的子任务: {task_id}",
            "atomicTasks": atomic_tasks,
            "scheduleToolResult": schedule_tool_result,
            "llmUsage": llm_usage_total,
            "agentTrace": finish_trace(trace, status="failed", detail={"branch": "split_task", "reason": "parent_not_found"}),
        }
    finish_node(trace, "resume.find_parent_task", detail={"parentTaskTitle": parent_task.get("title"), "plannedMinutes": parent_task.get("plannedMinutes")})

    raw_input = str(normalized_context.get("rawInput") or planning_state.get("rawInput") or "").strip()
    next_atomic_tasks = atomic_tasks
    next_schedule_tool_result = schedule_tool_result
    all_tool_results = list(tool_results)
    split_batches: list[dict[str, Any]] = []
    max_auto_split_rounds = 8
    current_parent_task = parent_task

    for round_index in range(1, max_auto_split_rounds + 1):
        round_node_id = f"resume.split_round_{round_index}"
        add_node(trace, round_node_id, f"拆分循环第 {round_index} 轮", kind="loop", detail={"parentTaskTitle": current_parent_task.get("title")})
        add_edge(trace, "resume.find_parent_task" if round_index == 1 else f"tools.schedule_tasks.split_round_{round_index - 1}", round_node_id)
        interrupt = next_schedule_tool_result.get("interrupt") if isinstance(next_schedule_tool_result.get("interrupt"), dict) else {}
        current_max_minutes = _read_interrupt_split_limit(interrupt)
        if current_max_minutes < MIN_EXECUTABLE_MINUTES:
            finish_node(trace, round_node_id, status="waiting", detail={"reason": "current_max_minutes_below_min_executable", "currentMaxMinutes": current_max_minutes})
            add_node(trace, "tools.schedule_tasks.auto_allow_after_split", "拆分后自动允许非黄金时间", kind="tool")
            add_edge(trace, round_node_id, "tools.schedule_tasks.auto_allow_after_split")
            next_schedule_tool_result = schedule_tasks(
                atomic_tasks=next_atomic_tasks,
                free_windows=free_windows,
                decisions=[
                    {
                        "optionId": "allow_beyond_golden_time",
                        "taskId": "*",
                        "source": "auto_after_user_requested_split",
                    }
                ],
            )
            next_schedule_tool_result = _attach_excluded_availability_note(next_schedule_tool_result, free_windows_tool_result)
            finish_node(trace, "tools.schedule_tasks.auto_allow_after_split", detail={"status": next_schedule_tool_result.get("status")})
            break

        parent_minutes = _read_positive_int(current_parent_task.get("plannedMinutes")) or current_max_minutes
        if parent_minutes <= current_max_minutes:
            finish_node(trace, round_node_id, detail={"reason": "parent_fits_current_window", "parentMinutes": parent_minutes, "currentMaxMinutes": current_max_minutes})
            break

        if _is_mechanical_slice_task(current_parent_task) or bool(current_parent_task.get("semanticSplitApplied")):
            split_node_id = f"python.mechanical_split_round_{round_index}"
            add_node(trace, split_node_id, "机械切片拆分", kind="python", detail={"maxMinutes": current_max_minutes})
            add_edge(trace, round_node_id, split_node_id)
            updated_tasks, split_result, issues = _split_single_task_mechanically(
                parent_task=current_parent_task,
                atomic_tasks=next_atomic_tasks,
                max_minutes=current_max_minutes,
            )
            supplemental_results = []
            finish_node(trace, split_node_id, status="failed" if issues else "success", detail={"issues": issues, "subtaskCount": len(split_result.get("subtasks", [])) if isinstance(split_result.get("subtasks"), list) else 0})
        else:
            split_node_id = f"llm.semantic_split_round_{round_index}"
            add_node(trace, split_node_id, "LLM 语义拆分任务", kind="llm", detail={"maxMinutes": current_max_minutes})
            add_edge(trace, round_node_id, split_node_id)
            updated_tasks, split_result, supplemental_results, issues, split_usage = _split_single_task_with_llm(
                parent_task=current_parent_task,
                atomic_tasks=next_atomic_tasks,
                normalized_context=normalized_context,
                raw_input=raw_input,
                tool_results=all_tool_results,
                max_minutes=current_max_minutes,
            )
            llm_usage_total = _merge_usage(llm_usage_total, split_usage)
            all_tool_results.extend(supplemental_results)
            finish_node(trace, split_node_id, status="failed" if issues else "success", detail={"issues": issues, "subtaskCount": len(split_result.get("subtasks", [])) if isinstance(split_result.get("subtasks"), list) else 0, "supplementalToolResultCount": len(supplemental_results)})
        split_result["round"] = round_index

        if issues:
            # If the LLM cannot produce a valid semantic split, keep the latest schedule interrupt
            # instead of failing the whole run. The user can choose another decision path.
            next_schedule_tool_result["errors"] = list(next_schedule_tool_result.get("errors") or []) + issues
            finish_node(trace, round_node_id, status="failed", detail={"issues": issues})
            break

        next_atomic_tasks = updated_tasks
        split_batches.append(split_result)
        schedule_node_id = f"tools.schedule_tasks.split_round_{round_index}"
        add_node(trace, schedule_node_id, "拆分后重新排期", kind="tool")
        add_edge(trace, split_node_id, schedule_node_id)
        next_schedule_tool_result = schedule_tasks(
            atomic_tasks=next_atomic_tasks,
            free_windows=free_windows,
            decisions=[],
        )
        next_schedule_tool_result = _attach_excluded_availability_note(next_schedule_tool_result, free_windows_tool_result)
        finish_node(
            trace,
            schedule_node_id,
            status="waiting" if next_schedule_tool_result.get("status") in {"needsDecision", "pending"} else ("failed" if next_schedule_tool_result.get("status") == "failed" else "success"),
            detail={
                "status": next_schedule_tool_result.get("status"),
                "interrupt": next_schedule_tool_result.get("interrupt"),
                "draftAllocationCount": len(next_schedule_tool_result.get("draftAllocations", [])) if isinstance(next_schedule_tool_result.get("draftAllocations"), list) else 0,
            },
        )
        finish_node(trace, round_node_id, detail={"splitMode": split_result.get("splitMode", "semantic_split"), "subtaskCount": len(split_result.get("subtasks", [])) if isinstance(split_result.get("subtasks"), list) else 0})
        next_interrupt = next_schedule_tool_result.get("interrupt") if isinstance(next_schedule_tool_result.get("interrupt"), dict) else {}
        if next_interrupt.get("type") == "task_needs_non_golden_approval":
            add_node(trace, "tools.schedule_tasks.auto_allow_non_golden", "拆分后自动处理非黄金时间确认", kind="tool")
            add_edge(trace, schedule_node_id, "tools.schedule_tasks.auto_allow_non_golden")
            next_schedule_tool_result = schedule_tasks(
                atomic_tasks=next_atomic_tasks,
                free_windows=free_windows,
                decisions=[
                    {
                        "optionId": "allow_beyond_golden_time",
                        "taskId": "*",
                        "source": "auto_after_user_requested_split",
                    }
                ],
            )
            next_schedule_tool_result = _attach_excluded_availability_note(next_schedule_tool_result, free_windows_tool_result)
            finish_node(trace, "tools.schedule_tasks.auto_allow_non_golden", detail={"status": next_schedule_tool_result.get("status")})
            break

        if not _can_auto_split_interrupt(next_schedule_tool_result):
            break

        next_interrupt = next_schedule_tool_result.get("interrupt") if isinstance(next_schedule_tool_result.get("interrupt"), dict) else {}
        next_task_id = str(next_interrupt.get("taskId", "")).strip()
        next_parent_task = _find_task_by_id_or_title(next_atomic_tasks, next_task_id)
        if not next_parent_task:
            break
        current_parent_task = next_parent_task

    flattened_subtasks = [
        task
        for batch in split_batches
        for task in (batch.get("subtasks") if isinstance(batch.get("subtasks"), list) else [])
        if isinstance(task, dict)
    ]
    split_result = {
        "parentTaskTitle": str(parent_task.get("title", "")),
        "subtaskTitles": [str(task.get("title", "")) for task in flattened_subtasks],
        "subtasks": flattened_subtasks,
        "splitBatches": split_batches,
        "autoSplitRounds": len(split_batches),
    }
    add_node(trace, "tools.check_schedule_conflicts.resume_split", "检测拆分后冲突", kind="tool")
    last_schedule_node = f"tools.schedule_tasks.split_round_{len(split_batches)}" if split_batches else "resume.find_parent_task"
    add_edge(trace, last_schedule_node, "tools.check_schedule_conflicts.resume_split")
    conflict_check_result = _check_conflicts_after_schedule(next_schedule_tool_result, calendar_events_tool_result, [])
    finish_node(
        trace,
        "tools.check_schedule_conflicts.resume_split",
        status="waiting" if conflict_check_result.get("status") in {"needsDecision", "pending"} else ("failed" if conflict_check_result.get("status") == "failed" else "success"),
        detail={"status": conflict_check_result.get("status"), "summary": conflict_check_result.get("summary")},
    )
    response = {
        "status": "ready",
        "atomicTasks": next_atomic_tasks,
        "scheduleToolResult": next_schedule_tool_result,
        "conflictCheckResult": conflict_check_result,
        "splitResult": split_result,
        "toolResults": all_tool_results,
        "llmUsage": llm_usage_total,
        "agentTrace": finish_trace(trace, status="success", detail={"branch": "split_task", "autoSplitRounds": len(split_batches)}),
    }
    print("[Python Agent] Resume auto split result JSON:")
    print(json.dumps(response, ensure_ascii=False, indent=2), flush=True)
    return response
