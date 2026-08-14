import json
from typing import Any


FINAL_TASK_JSON_FIELDS = {
    "userId": "当前用户 ID",
    "rawInput": "用户原始输入 + Node 拼接的 agent 上下文",
    "userPreference": {
        "preferredStartTime": "用户偏好开始时间，例如 09:00",
        "preferredEndTime": "用户偏好结束时间，例如 18:00",
        "dailyFocusLimitMinutes": "每日专注上限分钟数",
        "avoidWeekends": "是否避开周末",
        "defaultEventCategory": "默认日程分类",
        "timezone": "用户时区",
    },
    "normalizedContext": {
        "rawInput": "用户原始输入",
        "duration": "用户输入的耗时原文，仅用于展示和追溯",
        "totalMinutes": "Node 在字段抽取阶段统一换算出的分钟数，Python 只使用这个字段做耗时校验",
        "deadline": "Node 在字段抽取阶段换算出的 ISO 截止时间",
        "deadlineText": "用户原始截止时间说法",
    },
    "parsedTask": {
        "taskName": "任务名称",
        "deadline": "LLM 拆分后换算出的 ISO 截止时间",
        "totalMinutes": "LLM 拆分后换算出的总分钟数",
        "priority": "优先级",
        "constraints": {
            "avoidWeekends": "是否避开周末",
            "preferredTimeOfDay": "偏好时段",
            "preferredStartTime": "偏好开始时间",
            "preferredEndTime": "偏好结束时间",
        },
        "subtasks": [
            {
                "title": "子任务标题",
                "minutes": "子任务分钟数",
                "order": "子任务顺序",
                "startAt": "子任务开始 ISO 时间",
                "endAt": "子任务结束 ISO 时间",
            }
        ],
    },
}


def _read_positive_int(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)) and value > 0:
        return int(round(value))
    if isinstance(value, str) and value.strip().isdigit():
        return int(value.strip())
    return None


def validate_final_task(payload: dict[str, Any]) -> dict[str, Any]:
    parsed_task = payload.get("parsedTask") if isinstance(payload.get("parsedTask"), dict) else {}
    normalized_context = payload.get("normalizedContext") if isinstance(payload.get("normalizedContext"), dict) else {}
    subtasks = parsed_task.get("subtasks") if isinstance(parsed_task.get("subtasks"), list) else []

    expected_total = _read_positive_int(normalized_context.get("totalMinutes")) or _read_positive_int(parsed_task.get("totalMinutes"))
    parsed_total = _read_positive_int(parsed_task.get("totalMinutes"))
    subtask_total = sum(_read_positive_int(item.get("minutes")) or 0 for item in subtasks if isinstance(item, dict))

    issues: list[str] = []
    if expected_total is None:
        issues.append("normalizedContext.totalMinutes 缺失或无效")
    if parsed_total is None:
        issues.append("parsedTask.totalMinutes 缺失或无效")
    if expected_total is not None and parsed_total is not None and parsed_total != expected_total:
        issues.append(f"parsedTask.totalMinutes({parsed_total}) 不等于用户输入 totalMinutes({expected_total})")
    if expected_total is not None and subtask_total > expected_total:
        issues.append(f"subtasks.minutes 总和({subtask_total}) 超过用户输入 totalMinutes({expected_total})")

    return {
        "status": "ready" if not issues else "invalid",
        "expectedTotalMinutes": expected_total,
        "parsedTaskTotalMinutes": parsed_total,
        "subtaskTotalMinutes": subtask_total,
        "issues": issues,
    }


def accept_task(payload: dict[str, Any]) -> dict[str, Any]:
    final_validation = validate_final_task(payload)

    print("[Python Agent] Final task JSON field schema:")
    print(json.dumps(FINAL_TASK_JSON_FIELDS, ensure_ascii=False, indent=2))
    print("[Python Agent] Final task JSON payload:")
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    print("[Python Agent] Final task validation:")
    print(json.dumps(final_validation, ensure_ascii=False, indent=2))
    print("[Python Agent] End final task JSON\n", flush=True)

    return {
        "message": "python received json",
        "finalValidation": final_validation,
        "received": payload,
    }
