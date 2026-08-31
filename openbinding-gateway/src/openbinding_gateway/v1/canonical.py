"""RFC 8785 deterministic JSON and digest helpers for BIM v1."""

from __future__ import annotations

import hashlib
import json
import math
from decimal import Decimal
from typing import Any


class CanonicalizationError(ValueError):
    pass


def _check(value: Any, path: str = "$") -> None:
    if isinstance(value, float):
        if not math.isfinite(value):
            raise CanonicalizationError(f"non-finite number at {path}")
    elif isinstance(value, int) and not isinstance(value, bool):
        # RFC 8785 uses the ECMAScript/IEEE-754 JSON number model.  Larger
        # integers cannot be carried losslessly between conforming runtimes and
        # therefore have to be represented as strings by the language using
        # them (RFC 8785, Appendix D).
        if abs(value) > 9_007_199_254_740_991:
            raise CanonicalizationError(f"integer is outside the interoperable JSON range at {path}")
    elif isinstance(value, str):
        try:
            value.encode("utf-8")
        except UnicodeEncodeError as exc:
            raise CanonicalizationError(f"string contains an invalid Unicode scalar at {path}") from exc
    elif isinstance(value, dict):
        for key, child in value.items():
            if not isinstance(key, str):
                raise CanonicalizationError(f"object key is not a string at {path}")
            _check(key, f"{path}.<key>")
            _check(child, f"{path}.{key}")
    elif isinstance(value, list):
        for index, child in enumerate(value):
            _check(child, f"{path}[{index}]")


def canonical_json(value: Any) -> bytes:
    """Return the UTF-8 JSON Canonicalization Scheme representation.

    Python's shortest-round-trip float representation uses the same Ryu-class
    result as ECMAScript.  JCS differs only in its fixed/exponential display
    thresholds and exponent spelling; those transformations are applied below.
    NaN, infinities, lone surrogates and non-interoperable native integers are
    rejected before serialization.
    """

    _check(value)
    def number(item: int | float) -> str:
        if isinstance(item, int):
            return str(item)
        if item == 0:
            return "0"
        absolute = abs(item)
        text = repr(item).lower()
        if 1e-6 <= absolute < 1e21 and "e" in text:
            fixed = format(Decimal(text), "f")
            if "." in fixed:
                fixed = fixed.rstrip("0").rstrip(".")
            return fixed if fixed not in {"-0", ""} else "0"
        if "e" not in text and text.endswith(".0"):
            return text[:-2]
        if "e" in text:
            mantissa, exponent = text.split("e", 1)
            sign = "+" if not exponent.startswith("-") else "-"
            exponent = exponent.lstrip("+-0") or "0"
            return f"{mantissa}e{sign if sign == '+' else '-'}{exponent}"
        return text

    def encode(item: Any) -> str:
        if item is None:
            return "null"
        if item is True:
            return "true"
        if item is False:
            return "false"
        if isinstance(item, (int, float)):
            return number(item)
        if isinstance(item, str):
            return json.dumps(item, ensure_ascii=False, separators=(",", ":"))
        if isinstance(item, list):
            return "[" + ",".join(encode(child) for child in item) + "]"
        if isinstance(item, dict):
            # JCS sorts property names by their raw UTF-16 code units, not by
            # Unicode code point (which is Python's native string ordering).
            # The distinction matters for supplementary-plane characters.
            ordered = sorted(item, key=lambda key: key.encode("utf-16-be"))
            return "{" + ",".join(json.dumps(key, ensure_ascii=False) + ":" + encode(item[key]) for key in ordered) + "}"
        raise CanonicalizationError(f"unsupported JSON value: {type(item).__name__}")

    return encode(value).encode("utf-8")


def digest(value: Any) -> str:
    return "sha256-" + hashlib.sha256(canonical_json(value)).hexdigest()


def digest_bytes(value: bytes) -> str:
    return "sha256-" + hashlib.sha256(value).hexdigest()
