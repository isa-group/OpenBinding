"""The errors of reading a pricing, shared by the domain (YAML limits, the normaliser) and the port."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class PricingDiagnostic:
    """One finding about a pricing document: ``code`` is stable, ``message`` is for people, ``at`` a pointer."""

    code: str
    message: str
    at: str = ""
    severity: str = "error"
    extra: dict[str, Any] = field(default_factory=dict)

    def as_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {"code": self.code, "severity": self.severity, "message": self.message, "at": self.at}
        out.update(self.extra)
        return out


class PricingError(Exception):
    """Base of every pricing read failure."""


class PricingInvalid(PricingError):
    """The bytes are not a pricing this gateway reads (not YAML, over the YAML limits, refused by the normaliser).

    ``code`` is the main reason (``yaml_limits``, ``yaml_invalid``, ``sphere_syntax_unsupported``,
    ``sphere_pricing_invalid``); ``diagnostics`` carries the located findings.
    """

    def __init__(self, code: str, message: str = "", diagnostics: tuple[PricingDiagnostic, ...] = ()) -> None:
        super().__init__(message or code)
        self.code = code
        self.message = message or code
        self.diagnostics = diagnostics or (PricingDiagnostic(code, self.message),)
