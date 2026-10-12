"""Injected settings of the BIM core.

Nothing here reads the process environment on its own.  :meth:`Limits.from_env`
is a pure function of the mapping it is given, so a host decides where the
values come from (the process environment, a config file, a test).  The one piece of
process-wide state is the explicit default installed with :func:`configure`.
"""

from __future__ import annotations

from dataclasses import dataclass, fields
from typing import Mapping

from .errors import ContractError

_ENV_NAMES = {
    "max_compressed_bytes": "BIM_MAX_COMPRESSED_BYTES",
    "max_expanded_bytes": "BIM_MAX_EXPANDED_BYTES",
    "max_entry_bytes": "BIM_MAX_ENTRY_BYTES",
    "max_entries": "BIM_MAX_ENTRIES",
    "max_compression_ratio": "BIM_MAX_COMPRESSION_RATIO",
    "max_path_depth": "BIM_MAX_PATH_DEPTH",
}


@dataclass(frozen=True)
class Limits:
    """Resource limits applied when a package is read."""

    max_compressed_bytes: int = 16 * 1024 * 1024
    max_expanded_bytes: int = 64 * 1024 * 1024
    max_entry_bytes: int = 16 * 1024 * 1024
    max_entries: int = 256
    max_compression_ratio: int = 100
    max_path_depth: int = 16

    def __post_init__(self) -> None:
        for field in fields(self):
            value = getattr(self, field.name)
            if isinstance(value, bool) or not isinstance(value, int):
                raise ContractError("invalid_limit", f"{_ENV_NAMES[field.name]} must be an integer")
            if value <= 0:
                raise ContractError("invalid_limit", f"{_ENV_NAMES[field.name]} must be positive")

    @classmethod
    def from_env(cls, environ: Mapping[str, str]) -> Limits:
        """Build limits from ``BIM_MAX_*`` entries of ``environ``; missing ones keep the default."""
        defaults = cls()
        values: dict[str, int] = {}
        for name, variable in _ENV_NAMES.items():
            raw = environ.get(variable)
            if raw is None:
                values[name] = getattr(defaults, name)
                continue
            try:
                values[name] = int(raw)
            except ValueError as exc:
                raise ContractError("invalid_limit", f"{variable} must be an integer") from exc
        return cls(**values)


_active = Limits()


def default_limits() -> Limits:
    """The limits used when a call does not pass ``limits=``."""
    return _active


def configure(limits: Limits) -> None:
    """Install ``limits`` as the process-wide default (optional; the defaults are safe)."""
    global _active
    if not isinstance(limits, Limits):
        raise TypeError("configure() requires a Limits instance")
    _active = limits
