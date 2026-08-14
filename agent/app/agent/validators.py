import json
import re
from typing import Any

from .models import REQUIRED_FIELDS, ValidationResult


UNCLEAR_VALUES = {
    "",
    "null",
    "none",
    "undefined",
    "无",
    "无明确时间",
    "没有",
    "未提供",
    "随便",
    "都行",
    "看情况",
    "不知道",
    "不确定",
    "抽空",
    "一会",
    "一会儿",
    "马上",
    "立刻",
    "尽快",
}

ISO_DEADLINE_PATTERN = r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}"


def _read_string(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def _is_unclear(value: str) -> bool:
    normalized = value.strip().lower()
    return normalized in UNCLEAR_VALUES


def _read_positive_int(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)) and value > 0:
        return int(round(value))
    if isinstance(value, str) and value.strip().isdigit():
        return int(value.strip())
    return None


def _deadline_iso_is_valid(value: str) -> bool:
    if not value or _is_unclear(value):
        return False
    return bool(re.search(ISO_DEADLINE_PATTERN, value))


def _read_deadline_iso(llm_extraction: dict[str, Any]) -> str:
    for field in ("deadline", "deadlineIso"):
        value = _read_string(llm_extraction.get(field))
        if _deadline_iso_is_valid(value):
            return value
    return ""


def _extract_clarification(payload: dict[str, Any]) -> dict[str, Any]:
    value = payload.get("clarificationJson")
    return value if isinstance(value, dict) else {}


def _merge_field(field: str, llm_extraction: dict[str, Any], clarification: dict[str, Any]) -> str:
    clarification_value = _read_string(clarification.get(field))
    if clarification_value:
        return clarification_value
    return _read_string(llm_extraction.get(field))


def validate_fields(payload: dict[str, Any]) -> ValidationResult:
    original_input = _read_string(payload.get("rawInput"))
    llm_extraction = payload.get("llmExtraction") if isinstance(payload.get("llmExtraction"), dict) else {}
    clarification = _extract_clarification(payload)

    duration_value = _merge_field("duration", llm_extraction, clarification)
    deadline_value = _merge_field("deadline", llm_extraction, clarification)
    deadline_iso_value = _read_deadline_iso(llm_extraction)
    deadline_text_value = _read_string(llm_extraction.get("deadlineText"))
    total_minutes_value = _read_positive_int(llm_extraction.get("totalMinutes"))

    print("[Python Agent] Field validation request:")
    print(
        json.dumps(
            {
                "rawInput": original_input,
                "llmExtraction": llm_extraction,
                "clarificationJson": clarification,
                "merged": {
                    "duration": duration_value,
                    "totalMinutes": total_minutes_value,
                    "deadline": deadline_value,
                    "deadlineText": deadline_text_value,
                    "deadlineIso": deadline_iso_value,
                },
            },
            ensure_ascii=False,
            indent=2,
        ),
        flush=True,
    )

    missing: dict[str, str] = {}
    reasons: list[str] = []

    if total_minutes_value is None:
        missing["duration"] = _read_string(clarification.get("duration")) or duration_value
        reasons.append("duration 缺失、模糊，或 Node 未统一换算出合法 totalMinutes")

    if not _deadline_iso_is_valid(deadline_iso_value):
        missing["deadline"] = _read_string(clarification.get("deadline")) or deadline_value
        reasons.append("deadline 缺失、模糊，或 Node 未换算出合法 ISO 时间")

    if missing:
        ordered_missing = {field: missing[field] for field in REQUIRED_FIELDS if field in missing}
        response = ValidationResult(
            status="needsUserInput",
            message="信息还不完整，请只补全下面字段的值。",
            reasons=reasons,
            clarification_json=ordered_missing,
        )
        print("[Python Agent] Field validation result: needsUserInput")
        print(json.dumps(response.to_response(), ensure_ascii=False, indent=2), flush=True)
        return response

    response = ValidationResult(
        status="ready",
        message="字段完整，允许进入任务拆分。",
        reasons=[],
        clarification_json={},
        normalized_context={
            "rawInput": original_input,
            "duration": duration_value,
            "totalMinutes": total_minutes_value,
            "deadline": deadline_iso_value,
            "deadlineText": deadline_text_value or deadline_value,
        },
    )
    print("[Python Agent] Field validation result: ready")
    print(json.dumps(response.to_response(), ensure_ascii=False, indent=2), flush=True)
    return response
