"""The transport-neutral rejection every plan and technical limit reports."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class Refusal:
    """A transport-neutral rejection: callers render it as a response or an exception."""

    status: int
    code: str
    detail: str
    extra: dict[str, Any] = field(default_factory=dict)
    headers: dict[str, str] = field(default_factory=dict)
