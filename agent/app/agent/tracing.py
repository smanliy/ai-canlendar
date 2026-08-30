from __future__ import annotations

from datetime import datetime, timezone
from typing import Any


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def create_trace(name: str, request: dict[str, Any] | None = None) -> dict[str, Any]:
    return {
        "name": name,
        "startedAt": _now_iso(),
        "finishedAt": None,
        "nodes": [],
        "edges": [],
        "events": [],
        "request": request or {},
    }


def add_node(
    trace: dict[str, Any],
    node_id: str,
    label: str,
    *,
    kind: str = "step",
    status: str = "running",
    detail: dict[str, Any] | None = None,
) -> None:
    nodes = trace.setdefault("nodes", [])
    existing = next((node for node in nodes if isinstance(node, dict) and node.get("id") == node_id), None)
    payload = {
        "id": node_id,
        "label": label,
        "kind": kind,
        "status": status,
        "detail": detail or {},
        "startedAt": _now_iso(),
        "finishedAt": None,
    }
    if existing:
        existing.update({key: value for key, value in payload.items() if key not in {"startedAt"}})
    else:
        nodes.append(payload)

    trace.setdefault("events", []).append(
        {
            "type": "node_started" if status == "running" else "node_updated",
            "nodeId": node_id,
            "label": label,
            "status": status,
            "detail": detail or {},
            "at": _now_iso(),
        }
    )


def finish_node(trace: dict[str, Any], node_id: str, *, status: str = "success", detail: dict[str, Any] | None = None) -> None:
    nodes = trace.setdefault("nodes", [])
    for node in nodes:
        if isinstance(node, dict) and node.get("id") == node_id:
            node["status"] = status
            node["finishedAt"] = _now_iso()
            if detail:
                node["detail"] = {**(node.get("detail") if isinstance(node.get("detail"), dict) else {}), **detail}
            break

    trace.setdefault("events", []).append(
        {
            "type": "node_finished",
            "nodeId": node_id,
            "status": status,
            "detail": detail or {},
            "at": _now_iso(),
        }
    )


def add_edge(trace: dict[str, Any], source: str, target: str, *, label: str = "") -> None:
    edges = trace.setdefault("edges", [])
    edge_id = f"{source}->{target}:{label}"
    if any(isinstance(edge, dict) and edge.get("id") == edge_id for edge in edges):
        return
    edges.append(
        {
            "id": edge_id,
            "source": source,
            "target": target,
            "label": label,
        }
    )


def finish_trace(trace: dict[str, Any], *, status: str = "success", detail: dict[str, Any] | None = None) -> dict[str, Any]:
    trace["status"] = status
    trace["finishedAt"] = _now_iso()
    if detail:
        trace["detail"] = detail
    return trace
