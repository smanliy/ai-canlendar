from dataclasses import dataclass
from typing import Any


REQUIRED_FIELDS = ("duration", "deadline")


@dataclass
class ValidationResult:
    status: str
    message: str
    reasons: list[str]
    clarification_json: dict[str, str]
    normalized_context: dict[str, Any] | None = None

    def to_response(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "status": self.status,
            "message": self.message,
            "reasons": self.reasons,
        }
        if self.status == "needsUserInput":
            payload["clarificationJson"] = self.clarification_json
        else:
            payload["normalizedContext"] = self.normalized_context or {}
        return payload
