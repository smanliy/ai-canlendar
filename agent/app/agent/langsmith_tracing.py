from __future__ import annotations

from collections.abc import Callable
from typing import Any, TypeVar, overload


F = TypeVar("F", bound=Callable[..., Any])


try:
    from langsmith import traceable as _langsmith_traceable
except Exception:  # noqa: BLE001 - tracing must never prevent the local agent from booting
    _langsmith_traceable = None


@overload
def traceable(func: F, /) -> F:
    ...


@overload
def traceable(*, name: str | None = None, run_type: str | None = None, **kwargs: Any) -> Callable[[F], F]:
    ...


def traceable(func: F | None = None, /, **kwargs: Any) -> F | Callable[[F], F]:
    if _langsmith_traceable is None:
        if func is not None:
            return func

        def identity(inner: F) -> F:
            return inner

        return identity

    if func is not None:
        return _langsmith_traceable(func, **kwargs)
    return _langsmith_traceable(**kwargs)
