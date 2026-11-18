"""The ``sphere_*`` diagnostics of a SPHERE import: one closed catalogue with a severity per code.

Each finding is ``{code, severity, message, at}``. ``at`` is a JSON Pointer into the recipe
(``/tasks/0/from/1/plans/2``) or a candidate key (``sphere-email/email.mailgun.foundation``); a finding about
the whole recipe has ``at`` ``""``. Errors block ``sphere/apply``; warnings and infos never do.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

ERROR = "error"
WARNING = "warning"
INFO = "info"

#: Every code, with its severity (``docs/ERRORS.md``, "SPHERE imports").
SEVERITIES: dict[str, str] = {
    # errors
    "sphere_recipe_shape": ERROR,
    "sphere_source_unreadable": ERROR,
    "sphere_billing_unknown": ERROR,
    "sphere_syntax_unsupported": ERROR,
    "sphere_pricing_invalid": ERROR,
    "sphere_expand_unsupported": ERROR,
    "sphere_version_unpinned": ERROR,
    "sphere_plan_unknown": ERROR,
    "sphere_addon_unknown": ERROR,
    "sphere_feature_unknown": ERROR,
    "sphere_limit_unknown": ERROR,
    "sphere_guarantee_unmapped": ERROR,
    "sphere_unlimited_unmapped": ERROR,
    "sphere_property_unmapped": ERROR,
    "sphere_currency_mismatch": ERROR,
    "sphere_demand_too_large": ERROR,
    "sphere_too_many_candidates": ERROR,
    "sphere_no_candidates": ERROR,
    "sphere_id_collision": ERROR,
    "sphere_id_too_long": ERROR,
    "sphere_task_unknown": ERROR,
    "sphere_task_capability_conflict": ERROR,
    "sphere_feature_conflict": ERROR,
    "sphere_requires_conflict": ERROR,
    "sphere_resource_conflict": ERROR,
    "sphere_property_missing_on_candidate": ERROR,
    # warnings
    "sphere_limit_assumed": WARNING,
    "sphere_price_not_numeric": WARNING,
    "sphere_price_expression": WARNING,
    "sphere_unit_unknown": WARNING,
    "sphere_unit_per_user": WARNING,
    "sphere_rescaled": WARNING,
    "sphere_objective_manual_only": WARNING,
    "sphere_content_hash_unverified": WARNING,
    # infos
    "sphere_plan_private": INFO,
    "sphere_pruned": INFO,
    "sphere_version_not_latest": INFO,
    "sphere_candidate_removed": INFO,
}


@dataclass(frozen=True)
class SphereDiagnostic:
    code: str
    message: str
    at: str = ""
    severity: str = ERROR
    extra: dict[str, Any] = field(default_factory=dict)

    def as_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {"code": self.code, "severity": self.severity, "message": self.message, "at": self.at}
        out.update(self.extra)
        return out


def diagnostic(code: str, message: str, at: str = "", *, severity: str | None = None, **extra: Any) -> SphereDiagnostic:
    """A finding with its catalogue severity (``severity`` overrides it: a warning that becomes an error when the
    recipe names the excluded plan, for instance)."""
    if code not in SEVERITIES:
        raise KeyError(f"{code} is not a sphere_* diagnostic")
    return SphereDiagnostic(code, message, at, severity or SEVERITIES[code], dict(extra))


def has_errors(diagnostics: list[SphereDiagnostic] | tuple[SphereDiagnostic, ...]) -> bool:
    return any(item.severity == ERROR for item in diagnostics)


def pointer(*segments: object) -> str:
    """A JSON Pointer (RFC 6901) from its reference tokens."""
    return "".join("/" + str(s).replace("~", "~0").replace("/", "~1") for s in segments)
