"""A run preset's settings: what a run started from a preset runs with, checked for shape only.

A preset names the engine, registration, mode, options and optimization of a run request
(``RunRequest``). Only the shape is checked here, the rules the job submission relies on when it reads
those fields: whether the engine is installed or visible, whether the mode takes the options and whether
the optimization fits the problem's criteria are decided when a run uses the preset, where the revision is
known.
"""

from __future__ import annotations

import json
import math
import uuid
from dataclasses import dataclass, field
from typing import Any, Mapping

#: The settings a preset holds, which a run request naming a preset may not also give.
SETTINGS_FIELDS = ("engine", "registration", "mode", "options", "optimization")

#: The fields of an immutable engine or registration reference.
REFERENCE_FIELDS = frozenset({"namespace", "name", "version", "digest"})

#: The objective types an optimization selection may name (the toolchain's).
OPTIMIZATION_TYPES = frozenset({"SINGLE", "MULTI", "MANY"})

#: The keys an optimization selection may have.
OPTIMIZATION_FIELDS = frozenset({"type", "scalarization", "weights"})

#: Largest ``options`` object, as compact JSON in UTF-8.
MAX_OPTIONS_BYTES = 64 * 1024

#: Longest mode id (the column's length).
MAX_MODE_LENGTH = 64


class PresetShapeError(ValueError):
    """A preset setting of the wrong shape; ``pointer`` names it (``/optimization/weights/0``)."""

    def __init__(self, pointer: str, message: str) -> None:
        super().__init__(message)
        self.pointer = pointer
        self.message = message


@dataclass(frozen=True, slots=True)
class PresetRef:
    """The preset a run started from: recorded on the run, never followed again."""

    id: uuid.UUID
    slug: str

    def as_json(self) -> dict[str, str]:
        return {"id": str(self.id), "slug": self.slug}


@dataclass(frozen=True, slots=True)
class PresetSettings:
    """A preset's run settings, as a run request holds them."""

    engine: Any
    registration: dict[str, str] | None = None
    mode: str | None = None
    options: dict[str, Any] = field(default_factory=dict)
    optimization: dict[str, Any] | None = None

    @classmethod
    def from_fields(cls, fields: Mapping[str, Any]) -> "PresetSettings":
        """The settings in ``fields`` (absent optional ones default), or ``PresetShapeError``."""
        if fields.get("engine") is None:
            raise PresetShapeError("/engine", "A preset names the engine it runs: a built-in name or an immutable reference.")
        return cls(
            engine=_engine(fields["engine"]),
            registration=_registration(fields.get("registration")),
            mode=_mode(fields.get("mode")),
            options=_options(fields.get("options", {})),
            optimization=_optimization(fields.get("optimization")),
        )

    def as_fields(self) -> dict[str, Any]:
        return {name: getattr(self, name) for name in SETTINGS_FIELDS}


def _text(value: Any) -> bool:
    return isinstance(value, str) and bool(value)


def _reference(value: Any, pointer: str, what: str) -> dict[str, str]:
    if not isinstance(value, Mapping) or set(value) != REFERENCE_FIELDS or not all(map(_text, value.values())):
        raise PresetShapeError(pointer, f"{what} is an immutable reference of exactly namespace, name, version and digest.")
    return {key: value[key] for key in sorted(REFERENCE_FIELDS)}


def _engine(value: Any) -> Any:
    if _text(value):
        return value
    if isinstance(value, Mapping):
        return _reference(value, "/engine", "An engine named by reference")
    raise PresetShapeError("/engine", "engine is a built-in engine name or an immutable reference.")


def _registration(value: Any) -> dict[str, str] | None:
    return None if value is None else _reference(value, "/registration", "registration")


def _mode(value: Any) -> str | None:
    if value is None:
        return None
    if not _text(value) or len(value) > MAX_MODE_LENGTH:
        raise PresetShapeError("/mode", f"mode is the id of an engine mode (1 to {MAX_MODE_LENGTH} characters).")
    return value


def _options(value: Any) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        raise PresetShapeError("/options", "options is an object.")
    try:
        size = len(json.dumps(value, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode("utf-8"))
    except (TypeError, ValueError):
        raise PresetShapeError("/options", "options holds only JSON values (finite numbers).") from None
    if size > MAX_OPTIONS_BYTES:
        raise PresetShapeError("/options", f"options is longer than {MAX_OPTIONS_BYTES} bytes as JSON.")
    return dict(value)


def _optimization(value: Any) -> dict[str, Any] | None:
    if value is None:
        return None
    if not isinstance(value, Mapping):
        raise PresetShapeError("/optimization", "optimization is an object {type, scalarization, weights}.")
    unknown = sorted(set(value) - OPTIMIZATION_FIELDS)
    if unknown:
        raise PresetShapeError(f"/optimization/{unknown[0]}", "optimization has only type, scalarization and weights.")
    if value.get("type") not in OPTIMIZATION_TYPES:
        raise PresetShapeError("/optimization/type", "optimization.type is SINGLE, MULTI or MANY.")
    if not _text(value.get("scalarization")):
        raise PresetShapeError("/optimization/scalarization", "optimization.scalarization names a scalarization.")
    weights = value.get("weights")
    if weights is not None:
        if not isinstance(weights, list):
            raise PresetShapeError("/optimization/weights", "optimization.weights is a list of {criteria, value}.")
        for index, weight in enumerate(weights):
            if (
                not isinstance(weight, Mapping)
                or set(weight) != {"criteria", "value"}
                or not _text(weight["criteria"])
                or isinstance(weight["value"], bool)
                or not isinstance(weight["value"], (int, float))
                or not math.isfinite(weight["value"])
            ):
                raise PresetShapeError(
                    f"/optimization/weights/{index}",
                    "Each weight is exactly {criteria, value}: a criterion id and a finite number.",
                )
    return dict(value)
