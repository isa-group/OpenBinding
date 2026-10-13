"""Strict JSON for documents the platform reads: no duplicate names, no NaN or infinity.

This is the parser the platform has always used for request bodies, stored artifacts and
engine answers. A failure is a ``bim_core.PackageError``, the class every caller already
catches for "this is not acceptable JSON".
"""

from __future__ import annotations

import json
from typing import Any

from bim_core import PackageError


def strict_json_loads(data: str | bytes) -> Any:
    """Parse I-JSON without silently accepting duplicate object names."""

    def object_pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in pairs:
            if key in result:
                raise PackageError(f"duplicate JSON object member: {key!r}")
            result[key] = value
        return result

    def invalid_constant(value: str) -> None:
        raise PackageError(f"non-finite JSON number: {value}")

    try:
        return json.loads(data, object_pairs_hook=object_pairs, parse_constant=invalid_constant)
    except UnicodeDecodeError as exc:
        raise PackageError("JSON is not valid UTF-8") from exc
    except json.JSONDecodeError as exc:
        raise PackageError(f"invalid JSON: {exc.msg}") from exc
