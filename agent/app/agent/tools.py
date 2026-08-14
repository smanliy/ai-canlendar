import html
import json
import os
import re
import ast
import operator
import urllib.parse
import urllib.request
from datetime import datetime, timezone, timedelta
from html.parser import HTMLParser
from pathlib import Path
from socket import timeout as SocketTimeout
from typing import Any
from urllib.error import HTTPError, URLError
from zoneinfo import ZoneInfo


class _DuckDuckGoResultParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.results: list[dict[str, str]] = []
        self._active_href = ""
        self._active_text: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag != "a":
            return
        attr_map = {key: value or "" for key, value in attrs}
        class_name = attr_map.get("class", "")
        href = attr_map.get("href", "")
        if "result__a" in class_name and href:
            self._active_href = href
            self._active_text = []

    def handle_data(self, data: str) -> None:
        if self._active_href:
            self._active_text.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag != "a" or not self._active_href:
            return
        title = " ".join("".join(self._active_text).split())
        if title:
            self.results.append(
                {
                    "title": html.unescape(title),
                    "url": self._normalize_duck_url(self._active_href),
                    "snippet": "",
                }
            )
        self._active_href = ""
        self._active_text = []

    @staticmethod
    def _normalize_duck_url(value: str) -> str:
        parsed = urllib.parse.urlparse(value)
        query = urllib.parse.parse_qs(parsed.query)
        uddg = query.get("uddg", [""])[0]
        return urllib.parse.unquote(uddg) if uddg else value


def _http_get(url: str, timeout: int = 8) -> str:
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": "Mozilla/5.0 (compatible; ChronoAgent/1.0; +https://localhost)",
            "Accept": "text/html,application/json",
        },
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        charset = response.headers.get_content_charset() or "utf-8"
        return response.read().decode(charset, errors="replace")


def _http_post_json(url: str, payload: dict[str, Any], timeout: int = 8) -> dict[str, Any]:
    request = urllib.request.Request(
        url,
        method="POST",
        headers={
            "User-Agent": "Mozilla/5.0 (compatible; ChronoAgent/1.0; +https://localhost)",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        body = response.read().decode("utf-8")
    value = json.loads(body) if body else {}
    return value if isinstance(value, dict) else {}


def _format_network_error(prefix: str, error: Exception) -> str:
    if isinstance(error, TimeoutError | SocketTimeout):
        return f"{prefix}: <urlopen error timed out>"
    if isinstance(error, HTTPError):
        return f"{prefix}: HTTP {error.code}"
    if isinstance(error, URLError):
        return f"{prefix}: {error}"
    return f"{prefix}: {error}"


def _load_env_file_value(env_file: Path, name: str) -> str:
    if not env_file.exists():
        return ""
    try:
        lines = env_file.read_text(encoding="utf-8").splitlines()
    except OSError:
        return ""
    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        if key.strip() == name:
            return value.strip().strip('"').strip("'")
    return ""


def _get_env_value(*names: str) -> str:
    for name in names:
        value = os.environ.get(name, "").strip()
        if value:
            return value

    current = Path(__file__).resolve()
    candidate_files: list[Path] = []
    for parent in current.parents:
        candidate_files.extend(
            [
                parent / ".env",
                parent / "agent" / ".env",
                parent / "node_calendar-bff" / ".env",
            ]
        )

    seen: set[Path] = set()
    for env_file in candidate_files:
        if env_file in seen:
            continue
        seen.add(env_file)
        for name in names:
            value = _load_env_file_value(env_file, name)
            if value:
                return value
    return ""


def _tavily_search(query: str, limit: int) -> list[dict[str, str]]:
    api_key = _get_env_value("TAVILY_API_KEY")
    if not api_key:
        return []

    request = urllib.request.Request(
        "https://api.tavily.com/search",
        method="POST",
        headers={"Content-Type": "application/json"},
        data=json.dumps(
            {
                "api_key": api_key,
                "query": query,
                "search_depth": "basic",
                "max_results": limit,
                "include_answer": False,
            }
        ).encode("utf-8"),
    )
    with urllib.request.urlopen(request, timeout=12) as response:
        payload = json.loads(response.read().decode("utf-8"))

    results = payload.get("results") if isinstance(payload, dict) else []
    if not isinstance(results, list):
        return []
    return [
        {
            "title": str(item.get("title", "")),
            "url": str(item.get("url", "")),
            "snippet": str(item.get("content", ""))[:500],
        }
        for item in results[:limit]
        if isinstance(item, dict)
    ]


def _cstcloud_search(query: str, limit: int) -> list[dict[str, str]]:
    api_key = _get_env_value("CSTCLOUD_API_KEY", "UNI_API_KEY")
    if not api_key:
        return []

    base_url = (_get_env_value("CSTCLOUD_BASE_URL") or "https://uni-api.cstcloud.cn/v1").rstrip("/")
    request = urllib.request.Request(
        f"{base_url}/web-search",
        method="POST",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        data=json.dumps(
            {
                "model": "web-search",
                "query": query,
                "freshness": "noLimit",
                "summary": False,
                "count": limit,
            },
            ensure_ascii=False,
        ).encode("utf-8"),
    )
    with urllib.request.urlopen(request, timeout=15) as response:
        payload = json.loads(response.read().decode("utf-8"))

    if payload.get("code") not in (None, 200):
        raise RuntimeError(f"HTTP body code {payload.get('code')}: {payload.get('msg')}")

    values = (
        payload.get("data", {})
        .get("webPages", {})
        .get("value", [])
        if isinstance(payload, dict)
        else []
    )
    if not isinstance(values, list):
        return []

    return [
        {
            "title": str(item.get("name", "")),
            "url": str(item.get("url", "")),
            "snippet": str(item.get("snippet", "") or item.get("summary", ""))[:500],
        }
        for item in values[:limit]
        if isinstance(item, dict)
    ]


def _duckduckgo_search(query: str, limit: int) -> list[dict[str, str]]:
    encoded = urllib.parse.urlencode({"q": query})
    body = _http_get(f"https://html.duckduckgo.com/html/?{encoded}")
    parser = _DuckDuckGoResultParser()
    parser.feed(body)
    return parser.results[:limit]


def web_search_tool(query: str, limit: int = 5) -> dict[str, Any]:
    print(f"[Python Agent Tool] web_search query={query}", flush=True)
    errors: list[str] = []
    fallbacks: list[dict[str, str]] = []
    results: list[dict[str, str]] = []
    provider = ""

    if _get_env_value("CSTCLOUD_API_KEY", "UNI_API_KEY"):
        try:
            results = _cstcloud_search(query, limit)
            if results:
                provider = "cstcloud"
                fallbacks.append({"provider": "cstcloud", "status": "ok"})
            else:
                fallbacks.append({"provider": "cstcloud", "status": "empty"})
        except Exception as error:  # noqa: BLE001 - tool errors are reported to agent caller
            message = _format_network_error("cstcloud", error)
            errors.append(message)
            fallbacks.append({"provider": "cstcloud", "status": "failed", "reason": message})
    else:
        fallbacks.append({"provider": "cstcloud", "status": "skipped", "reason": "missing api key"})

    try:
        if not results:
            results = _tavily_search(query, limit)
            if results:
                provider = "tavily"
                fallbacks.append({"provider": "tavily", "status": "ok"})
            else:
                fallbacks.append({"provider": "tavily", "status": "empty"})
    except Exception as error:  # noqa: BLE001 - tool errors are reported to agent caller
        message = _format_network_error("tavily", error)
        errors.append(message)
        fallbacks.append({"provider": "tavily", "status": "failed", "reason": message})

    if not results:
        try:
            results = _duckduckgo_search(query, limit)
            if results:
                provider = "duckduckgo"
                fallbacks.append({"provider": "duckduckgo", "status": "ok"})
            else:
                fallbacks.append({"provider": "duckduckgo", "status": "empty"})
        except Exception as error:  # noqa: BLE001
            message = _format_network_error("duckduckgo", error)
            errors.append(message)
            fallbacks.append({"provider": "duckduckgo", "status": "failed", "reason": message})

    payload = {
        "tool": "web_search",
        "query": query,
        "provider": provider,
        "fallbacks": fallbacks,
        "results": results,
        "errors": errors,
    }
    print(json.dumps(payload, ensure_ascii=False, indent=2), flush=True)
    return payload


def web_search(q: str, count: int = 5) -> dict[str, Any]:
    results = web_search_tool(q, count)
    return {
        "tool": "web_search",
        "args": {"q": q, "count": count},
        "provider": results.get("provider", ""),
        "fallbacks": results.get("fallbacks", []),
        "results": results.get("results", []),
        "errors": results.get("errors", []),
    }


class _TextExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.parts: list[str] = []
        self._skip_depth = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in {"script", "style", "noscript"}:
            self._skip_depth += 1

    def handle_endtag(self, tag: str) -> None:
        if tag in {"script", "style", "noscript"} and self._skip_depth > 0:
            self._skip_depth -= 1

    def handle_data(self, data: str) -> None:
        if self._skip_depth == 0:
            text = " ".join(data.split())
            if text:
                self.parts.append(text)

    def text(self) -> str:
        return "\n".join(self.parts)


def page_fetch(url: str) -> dict[str, Any]:
    print(f"[Python Agent Tool] page_fetch url={url}", flush=True)
    errors: list[str] = []
    text = ""
    try:
        body = _http_get(url, timeout=10)
        parser = _TextExtractor()
        parser.feed(body)
        text = parser.text()[:12000]
    except Exception as error:  # noqa: BLE001
        errors.append(_format_network_error("page_fetch", error))

    payload = {
        "tool": "page_fetch",
        "args": {"url": url},
        "text": text,
        "errors": errors,
    }
    print(json.dumps(payload, ensure_ascii=False, indent=2), flush=True)
    return payload


_CALCULATE_OPERATORS = {
    ast.Add: operator.add,
    ast.Sub: operator.sub,
    ast.Mult: operator.mul,
    ast.Div: operator.truediv,
    ast.FloorDiv: operator.floordiv,
    ast.Mod: operator.mod,
    ast.Pow: operator.pow,
    ast.USub: operator.neg,
    ast.UAdd: operator.pos,
}


def _eval_math_node(node: ast.AST) -> float:
    if isinstance(node, ast.Expression):
        return _eval_math_node(node.body)
    if isinstance(node, ast.Constant) and isinstance(node.value, int | float):
        return float(node.value)
    if isinstance(node, ast.UnaryOp) and type(node.op) in _CALCULATE_OPERATORS:
        return float(_CALCULATE_OPERATORS[type(node.op)](_eval_math_node(node.operand)))
    if isinstance(node, ast.BinOp) and type(node.op) in _CALCULATE_OPERATORS:
        return float(_CALCULATE_OPERATORS[type(node.op)](_eval_math_node(node.left), _eval_math_node(node.right)))
    raise ValueError("unsupported expression")


def calculate(expr: str) -> dict[str, Any]:
    print(f"[Python Agent Tool] calculate expr={expr}", flush=True)
    errors: list[str] = []
    result: float | int | None = None
    try:
        tree = ast.parse(expr, mode="eval")
        value = _eval_math_node(tree)
        result = int(value) if value.is_integer() else value
    except Exception as error:  # noqa: BLE001
        errors.append(f"calculate: {error}")

    payload = {
        "tool": "calculate",
        "args": {"expr": expr},
        "result": result,
        "errors": errors,
    }
    print(json.dumps(payload, ensure_ascii=False, indent=2), flush=True)
    return payload


def _format_agent_calendar_time(value: str) -> str:
    try:
        normalized = value.replace("Z", "+00:00")
        date = datetime.fromisoformat(normalized)
        if date.tzinfo is None:
            date = date.replace(tzinfo=timezone.utc)
        shanghai = date.astimezone(timezone(timedelta(hours=8)))
        return shanghai.strftime("%Y-%m-%d %H:%M")
    except ValueError:
        return value


def _print_calendar_events_table(user_id: str, events: list[dict[str, Any]]) -> None:
    print("[Python Agent Tool] Local calendar events fetched:", flush=True)
    print(f"USER {user_id}", flush=True)
    print("TIMEZONE Asia/Shanghai", flush=True)
    print(f"COUNT {len(events)}", flush=True)
    print(
        "FORMAT YYYY-MM-DD HH:mm - YYYY-MM-DD HH:mm | title | category/priority | status | source | id",
        flush=True,
    )
    print("-" * 150, flush=True)
    if not events:
        print("(empty)", flush=True)
        return
    for event in events:
        print(
            " | ".join(
                [
                    f"{_format_agent_calendar_time(str(event.get('startAt', '')))} - {_format_agent_calendar_time(str(event.get('endAt', '')))}",
                    str(event.get("title", "")),
                    f"{event.get('category', '')}/{event.get('priority', '')}",
                    str(event.get("status", "")),
                    str(event.get("source", "")),
                    str(event.get("id", "")),
                ]
            ),
            flush=True,
        )


def calendar_events_query(user_id: str, start_iso: str, end_iso: str) -> dict[str, Any]:
    print(
        f"[Python Agent Tool] calendar_events_query userId={user_id} startIso={start_iso} endIso={end_iso}",
        flush=True,
    )
    errors: list[str] = []
    events: list[dict[str, Any]] = []
    node_base_url = (_get_env_value("NODE_INTERNAL_BASE_URL", "NODE_BFF_URL") or "http://127.0.0.1:3000").rstrip("/")
    try:
        response = _http_post_json(
            f"{node_base_url}/api/agent/internal/calendar-events",
            {
                "userId": user_id,
                "startIso": start_iso,
                "endIso": end_iso,
            },
            timeout=8,
        )
        data = response.get("data") if isinstance(response.get("data"), dict) else {}
        raw_events = data.get("events") if isinstance(data.get("events"), list) else []
        events = [
            {
                "id": str(item.get("id", "")),
                "title": str(item.get("title", "")),
                "startAt": str(item.get("startTime", "")),
                "endAt": str(item.get("endTime", "")),
                "category": str(item.get("category", "")),
                "priority": str(item.get("priority", "")),
                "status": str(item.get("status", "")),
                "source": str(item.get("source", "")),
            }
            for item in raw_events
            if isinstance(item, dict)
        ]
    except Exception as error:  # noqa: BLE001
        errors.append(_format_network_error("calendar_events_query", error))

    _print_calendar_events_table(user_id, events)

    payload = {
        "tool": "calendar_events_query",
        "args": {
            "userId": user_id,
            "startIso": start_iso,
            "endIso": end_iso,
        },
        "events": events,
        "errors": errors,
    }
    print("[Python Agent Tool] Local calendar events:")
    print(f"USER {user_id}")
    print(f"COUNT {len(events)}")
    print("FORMAT startAt - endAt | title | category/priority | status | source | id")
    print("-" * 150)
    if events:
        for event in events:
            print(
                " | ".join(
                    [
                        f"{event.get('startAt', '')} - {event.get('endAt', '')}",
                        str(event.get("title", "")),
                        f"{event.get('category', '')}/{event.get('priority', '')}",
                        str(event.get("status", "")),
                        str(event.get("source", "")),
                        str(event.get("id", "")),
                    ]
                )
            )
    else:
        print("(empty)")
    print(json.dumps(payload, ensure_ascii=False, indent=2), flush=True)
    return payload


def _parse_iso_datetime(value: str) -> datetime:
    text = value.strip()
    if text.endswith("Z"):
        text = f"{text[:-1]}+00:00"
    parsed = datetime.fromisoformat(text)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def _read_time_parts(value: Any, fallback: str) -> tuple[int, int]:
    text = str(value or fallback).strip()
    match = re.match(r"^(\d{1,2}):(\d{2})$", text)
    if not match:
        text = fallback
        match = re.match(r"^(\d{1,2}):(\d{2})$", text)
    hour = max(0, min(23, int(match.group(1)))) if match else 19
    minute = max(0, min(59, int(match.group(2)))) if match else 0
    return hour, minute


def _read_positive_minutes(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)) and value > 0:
        return int(round(value))
    if isinstance(value, str) and value.strip().isdigit():
        return int(value.strip())
    return None


def _event_interval(event: dict[str, Any], tz: ZoneInfo) -> tuple[datetime, datetime] | None:
    start_raw = str(event.get("startAt") or event.get("startTime") or "").strip()
    end_raw = str(event.get("endAt") or event.get("endTime") or "").strip()
    if not start_raw or not end_raw:
        return None
    try:
        start = _parse_iso_datetime(start_raw).astimezone(tz)
        end = _parse_iso_datetime(end_raw).astimezone(tz)
    except ValueError:
        return None
    if end <= start:
        return None
    return start, end


def _subtract_busy_intervals(
    window_start: datetime,
    window_end: datetime,
    busy_intervals: list[tuple[datetime, datetime]],
) -> list[tuple[datetime, datetime]]:
    free_segments = [(window_start, window_end)]
    for busy_start, busy_end in sorted(busy_intervals, key=lambda item: item[0]):
        next_segments: list[tuple[datetime, datetime]] = []
        for free_start, free_end in free_segments:
            if busy_end <= free_start or busy_start >= free_end:
                next_segments.append((free_start, free_end))
                continue
            if busy_start > free_start:
                next_segments.append((free_start, min(busy_start, free_end)))
            if busy_end < free_end:
                next_segments.append((max(busy_end, free_start), free_end))
        free_segments = next_segments
    return free_segments


def _split_and_label_free_segment(
    free_start: datetime,
    free_end: datetime,
    golden_start: datetime,
    golden_end: datetime,
) -> list[dict[str, Any]]:
    boundaries = [free_start, free_end]
    if free_start < golden_start < free_end:
        boundaries.append(golden_start)
    if free_start < golden_end < free_end:
        boundaries.append(golden_end)
    boundaries = sorted(set(boundaries))

    windows: list[dict[str, Any]] = []
    for index in range(len(boundaries) - 1):
        start = boundaries[index]
        end = boundaries[index + 1]
        if end <= start:
            continue
        is_golden = start >= golden_start and end <= golden_end
        windows.append(
            {
                "startIso": start.isoformat(),
                "endIso": end.isoformat(),
                "minutes": int((end - start).total_seconds() // 60),
                "date": start.date().isoformat(),
                "windowType": "golden" if is_golden else "flexible",
                "isGoldenTime": is_golden,
                "source": "schedulable_day_window_minus_calendar_events",
            }
        )
    return windows


def calculate_free_windows(
    start_iso: str,
    end_iso: str,
    calendar_events: list[dict[str, Any]],
    user_preference: dict[str, Any],
    draft_allocations: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    errors: list[str] = []
    free_windows: list[dict[str, Any]] = []
    timezone_name = str(user_preference.get("timezone") or "Asia/Shanghai").strip()
    try:
        tz = ZoneInfo(timezone_name)
    except Exception:  # noqa: BLE001
        tz = ZoneInfo("Asia/Shanghai")
        errors.append(f"calculate_free_windows: invalid timezone {timezone_name}, fallback Asia/Shanghai")

    try:
        range_start = _parse_iso_datetime(start_iso).astimezone(tz)
        range_end = _parse_iso_datetime(end_iso).astimezone(tz)
    except ValueError as error:
        return {
            "tool": "calculate_free_windows",
            "args": {"startIso": start_iso, "endIso": end_iso, "timezone": timezone_name},
            "freeWindows": [],
            "totalFreeMinutes": 0,
            "errors": [f"calculate_free_windows: invalid ISO range: {error}"],
        }

    if range_end <= range_start:
        return {
            "tool": "calculate_free_windows",
            "args": {"startIso": start_iso, "endIso": end_iso, "timezone": timezone_name},
            "freeWindows": [],
            "totalFreeMinutes": 0,
            "errors": ["calculate_free_windows: endIso must be after startIso"],
        }

    schedulable_start_hour, schedulable_start_minute = _read_time_parts(
        user_preference.get("schedulableStartTime") or user_preference.get("dayStartTime"),
        "08:00",
    )
    schedulable_end_hour, schedulable_end_minute = _read_time_parts(
        user_preference.get("schedulableEndTime") or user_preference.get("nightStartTime"),
        "23:00",
    )
    golden_start_hour, golden_start_minute = _read_time_parts(user_preference.get("preferredStartTime"), "19:00")
    golden_end_hour, golden_end_minute = _read_time_parts(user_preference.get("preferredEndTime"), "23:00")
    daily_limit = _read_positive_minutes(user_preference.get("dailyFocusLimitMinutes"))
    avoid_weekends = bool(user_preference.get("avoidWeekends", False))
    min_window_minutes = _read_positive_minutes(user_preference.get("minWindowMinutes")) or 20

    busy_events = [item for item in calendar_events if isinstance(item, dict)]
    busy_events.extend([item for item in (draft_allocations or []) if isinstance(item, dict)])
    busy_intervals = [interval for event in busy_events if (interval := _event_interval(event, tz))]

    current_day = range_start.date()
    last_day = range_end.date()
    while current_day <= last_day:
        weekday = current_day.weekday()
        if avoid_weekends and weekday >= 5:
            current_day += timedelta(days=1)
            continue

        day_start = datetime(
            current_day.year,
            current_day.month,
            current_day.day,
            schedulable_start_hour,
            schedulable_start_minute,
            tzinfo=tz,
        )
        day_end = datetime(
            current_day.year,
            current_day.month,
            current_day.day,
            schedulable_end_hour,
            schedulable_end_minute,
            tzinfo=tz,
        )
        if day_end <= day_start:
            day_end += timedelta(days=1)
        golden_start = datetime(
            current_day.year,
            current_day.month,
            current_day.day,
            golden_start_hour,
            golden_start_minute,
            tzinfo=tz,
        )
        golden_end = datetime(
            current_day.year,
            current_day.month,
            current_day.day,
            golden_end_hour,
            golden_end_minute,
            tzinfo=tz,
        )
        if golden_end <= golden_start:
            golden_end += timedelta(days=1)

        window_start = max(day_start, range_start)
        window_end = min(day_end, range_end)

        if window_end > window_start:
            for free_start, free_end in _subtract_busy_intervals(window_start, window_end, busy_intervals):
                for labeled_window in _split_and_label_free_segment(free_start, free_end, golden_start, golden_end):
                    if labeled_window["minutes"] >= min_window_minutes:
                        free_windows.append(labeled_window)
        current_day += timedelta(days=1)

    total_free_minutes = sum(item["minutes"] for item in free_windows)
    total_golden_minutes = sum(item["minutes"] for item in free_windows if item.get("isGoldenTime"))
    total_flexible_minutes = total_free_minutes - total_golden_minutes

    payload = {
        "tool": "calculate_free_windows",
        "args": {
            "startIso": start_iso,
            "endIso": end_iso,
            "timezone": timezone_name,
            "schedulableStartTime": f"{schedulable_start_hour:02d}:{schedulable_start_minute:02d}",
            "schedulableEndTime": f"{schedulable_end_hour:02d}:{schedulable_end_minute:02d}",
            "goldenStartTime": f"{golden_start_hour:02d}:{golden_start_minute:02d}",
            "goldenEndTime": f"{golden_end_hour:02d}:{golden_end_minute:02d}",
            "dailyFocusLimitMinutes": daily_limit,
            "avoidWeekends": avoid_weekends,
            "minWindowMinutes": min_window_minutes,
        },
        "freeWindows": free_windows,
        "totalFreeMinutes": total_free_minutes,
        "totalGoldenMinutes": total_golden_minutes,
        "totalFlexibleMinutes": total_flexible_minutes,
        "errors": errors,
    }
    print("[Python Agent Tool] Free windows JSON:")
    print(json.dumps(payload, ensure_ascii=False, indent=2), flush=True)
    return payload


TOOL_REGISTRY = {
    "web_search": {
        "description": "搜索外部网页。参数：q 搜索关键词，count 结果数量。",
        "parameters": {"q": "string", "count": "number"},
        "handler": web_search,
    },
    "page_fetch": {
        "description": "抓取目标网页全文文本。参数：url 目标网页地址。",
        "parameters": {"url": "string"},
        "handler": page_fetch,
    },
    "calculate": {
        "description": "本地四则运算。参数：expr 数学表达式。",
        "parameters": {"expr": "string"},
        "handler": calculate,
    },
    "calendar_events_query": {
        "description": "查询用户已有日程。参数：userId 用户ID，startIso 查询开始时间，endIso 查询结束时间。",
        "parameters": {"userId": "string", "startIso": "string", "endIso": "string"},
        "handler": calendar_events_query,
    },
    "calculate_free_windows": {
        "description": "根据查询范围、用户已有日程、用户偏好和草稿占用计算空闲时间。",
        "parameters": {
            "startIso": "string",
            "endIso": "string",
            "calendarEvents": "array",
            "userPreference": "object",
            "draftAllocations": "array",
        },
        "handler": calculate_free_windows,
    },
}


def get_tool_specs() -> list[dict[str, Any]]:
    return [
        {
            "tool": name,
            "description": spec["description"],
            "parameters": spec["parameters"],
        }
        for name, spec in TOOL_REGISTRY.items()
    ]


def dispatch_tool_call(tool_call: dict[str, Any]) -> dict[str, Any]:
    tool_name = str(tool_call.get("tool", "")).strip()
    args = tool_call.get("args") if isinstance(tool_call.get("args"), dict) else {}

    if tool_name not in TOOL_REGISTRY:
        return {
            "tool": tool_name,
            "results": [],
            "errors": [f"unknown tool: {tool_name}"],
        }

    if tool_name == "web_search":
        q = str(args.get("q") or tool_call.get("q") or "").strip()
        count_raw = args.get("count") or tool_call.get("count") or 5
        try:
            count = max(1, min(10, int(count_raw)))
        except (TypeError, ValueError):
            count = 5
        if not q:
            return {"tool": tool_name, "results": [], "errors": ["web_search: missing q"]}
        return web_search(q, count)

    if tool_name == "page_fetch":
        url = str(args.get("url") or tool_call.get("url") or "").strip()
        if not url:
            return {"tool": tool_name, "text": "", "errors": ["page_fetch: missing url"]}
        return page_fetch(url)

    if tool_name == "calculate":
        expr = str(args.get("expr") or tool_call.get("expr") or "").strip()
        if not expr:
            return {"tool": tool_name, "result": None, "errors": ["calculate: missing expr"]}
        return calculate(expr)

    if tool_name == "calendar_events_query":
        user_id = str(args.get("userId") or tool_call.get("userId") or "").strip()
        start_iso = str(args.get("startIso") or tool_call.get("startIso") or "").strip()
        end_iso = str(args.get("endIso") or tool_call.get("endIso") or "").strip()
        if not user_id:
            return {"tool": tool_name, "events": [], "errors": ["calendar_events_query: missing userId"]}
        if not start_iso:
            return {"tool": tool_name, "events": [], "errors": ["calendar_events_query: missing startIso"]}
        if not end_iso:
            return {"tool": tool_name, "events": [], "errors": ["calendar_events_query: missing endIso"]}
        return calendar_events_query(user_id, start_iso, end_iso)

    if tool_name == "calculate_free_windows":
        start_iso = str(args.get("startIso") or tool_call.get("startIso") or "").strip()
        end_iso = str(args.get("endIso") or tool_call.get("endIso") or "").strip()
        calendar_events = args.get("calendarEvents") or tool_call.get("calendarEvents") or []
        user_preference = args.get("userPreference") or tool_call.get("userPreference") or {}
        draft_allocations = args.get("draftAllocations") or tool_call.get("draftAllocations") or []
        if not start_iso:
            return {"tool": tool_name, "freeWindows": [], "errors": ["calculate_free_windows: missing startIso"]}
        if not end_iso:
            return {"tool": tool_name, "freeWindows": [], "errors": ["calculate_free_windows: missing endIso"]}
        if not isinstance(calendar_events, list):
            return {"tool": tool_name, "freeWindows": [], "errors": ["calculate_free_windows: calendarEvents must be array"]}
        if not isinstance(user_preference, dict):
            return {"tool": tool_name, "freeWindows": [], "errors": ["calculate_free_windows: userPreference must be object"]}
        if not isinstance(draft_allocations, list):
            return {"tool": tool_name, "freeWindows": [], "errors": ["calculate_free_windows: draftAllocations must be array"]}
        return calculate_free_windows(start_iso, end_iso, calendar_events, user_preference, draft_allocations)

    return {
        "tool": tool_name,
        "results": [],
        "errors": [f"unhandled tool: {tool_name}"],
    }


def build_research_queries(raw_input: str, normalized_context: dict[str, Any]) -> list[str]:
    text = raw_input.strip()
    duration = str(normalized_context.get("duration", "")).strip()
    base = re.sub(r"\s+", " ", text)
    queries = [
        f"{base} 学习步骤 耗时 经验",
        f"{base} 任务拆解 学习路径 耗时",
    ]
    if "牛客" in base:
        queries.append("牛客 前端 刷题 复盘 耗时 经验")
    if "前端" in base:
        queries.append("前端 学习 视频 刷题 项目 复盘 耗时")
    if duration:
        queries.append(f"{base} {duration} 如何安排 学习计划")
    return list(dict.fromkeys(queries))[:4]


def research_task_duration(raw_input: str, normalized_context: dict[str, Any]) -> list[dict[str, Any]]:
    return [web_search_tool(query, limit=4) for query in build_research_queries(raw_input, normalized_context)]
