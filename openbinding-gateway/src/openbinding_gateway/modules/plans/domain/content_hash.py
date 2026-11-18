"""SPHERE's functional content hash of a Pricing2Yaml document.

Ported from SPHERE api/src/main/services/PermanentLinkService.ts (functionalHash) at 73779a8a; MIT,
Copyright (c) 2024 Alejandro García Fernández (THIRD_PARTY_NOTICES.md).

SPHERE loads the YAML with js-yaml, drops the top-level ``saasName``, sorts the mapping keys, serialises the
value with ``JSON.stringify`` and takes the SHA-256 of that text. The manifest's ``contentHash`` is that hash,
not a digest of the bytes (the bytes are covered by the YAML route's ``ETag``). A rename (only ``saasName``
changed) therefore keeps the hash. Reproducing it needs js-yaml's reading (``yaml12``), JavaScript's number
formatting and its key order: integer-like keys (``0`` or ``[1-9][0-9]*`` below 2^32 - 1) come first in
ascending numeric order, then the others in the sorted order (UTF-16 code units).
"""

from __future__ import annotations

import datetime as _dt
import hashlib
import json
import math
import re
from collections.abc import Mapping
from typing import Any

from . import yaml12
from .errors import PricingInvalid

_INDEX_KEY = re.compile(r"0|[1-9][0-9]*")
_ARRAY_INDEX_LIMIT = 2**32 - 1


def js_number(value: float | int | bool) -> str:
    """``String(value)`` in JavaScript: ``1.0`` is ``1``, ``1e21`` is ``1e+21``, non-finite is ``null`` in JSON."""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        if abs(value) <= 2**53:
            return str(value)
        value = float(value)
    if math.isnan(value) or math.isinf(value):
        return "null"
    if value == 0:
        return "0"
    sign = "-" if value < 0 else ""
    digits, exponent = _shortest(abs(value))
    k = len(digits)
    n = exponent + k  # the position of the decimal point relative to the digits
    if k <= n <= 21:
        return sign + digits + "0" * (n - k)
    if 0 < n <= 21:
        return sign + digits[:n] + "." + digits[n:]
    if -6 < n <= 0:
        return sign + "0." + "0" * (-n) + digits
    mantissa = digits[0] + ("." + digits[1:] if k > 1 else "")
    e = n - 1
    return f"{sign}{mantissa}e{'+' if e > 0 else '-'}{abs(e)}"


def _shortest(value: float) -> tuple[str, int]:
    """The shortest round-tripping digits of ``value`` and the exponent of their last digit."""
    text = repr(value)
    mantissa, _, exp = text.partition("e")
    exponent = int(exp) if exp else 0
    whole, _, fraction = mantissa.partition(".")
    if fraction == "0":
        fraction = ""
    digits = (whole + fraction).lstrip("0")
    exponent -= len(fraction)
    stripped = digits.rstrip("0")
    exponent += len(digits) - len(stripped)
    return stripped or "0", exponent


def _js_key(key: Any) -> str:
    if isinstance(key, str):
        return key
    if key is None:
        return "null"
    if isinstance(key, (bool, int, float)):
        return js_number(key)
    return str(key)


def _ordered_keys(keys: list[str]) -> list[str]:
    ordered = sorted(keys, key=lambda k: k.encode("utf-16-be"))
    index = [k for k in ordered if _INDEX_KEY.fullmatch(k) and int(k) < _ARRAY_INDEX_LIMIT]
    seen = set(index)
    return sorted(index, key=int) + [k for k in ordered if k not in seen]


def js_json(value: Any) -> str:
    """``JSON.stringify`` of a js-yaml value with the keys sorted as SPHERE sorts them (no spaces)."""
    if value is None:
        return "null"
    if isinstance(value, (bool, int, float)):
        return js_number(value)
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, _dt.datetime):
        if value.tzinfo is not None:
            value = value.astimezone(_dt.timezone.utc).replace(tzinfo=None)
        return '"' + value.strftime("%Y-%m-%dT%H:%M:%S.") + f"{value.microsecond // 1000:03d}Z" + '"'
    if isinstance(value, _dt.date):
        return '"' + value.isoformat() + 'T00:00:00.000Z"'
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(js_json(item) for item in value) + "]"
    if isinstance(value, Mapping):
        items = {_js_key(k): v for k, v in value.items()}
        return "{" + ",".join(json.dumps(k, ensure_ascii=False) + ":" + js_json(items[k]) for k in _ordered_keys(list(items))) + "}"
    if isinstance(value, bytes):
        raise PricingInvalid("yaml_invalid", "binary values are not part of a pricing")
    raise PricingInvalid("yaml_invalid", f"unsupported YAML value of type {type(value).__name__}")


def functional_hash_of(document: Mapping[str, Any]) -> str:
    """The functional hash of an already loaded document (a mapping)."""
    value = {k: v for k, v in document.items() if k != "saasName"}
    return hashlib.sha256(js_json(value).encode("utf-8")).hexdigest()


def functional_hash(text: str | bytes) -> str:
    """SPHERE's ``contentHash`` of a Pricing2Yaml text."""
    document = yaml12.load(text)
    if not isinstance(document, Mapping):
        raise PricingInvalid("yaml_invalid", "a pricing is a YAML mapping")
    return functional_hash_of(document)
