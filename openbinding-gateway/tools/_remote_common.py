"""Shared pieces of the private SPACE/SPHERE tools (probe, provision, seed_lab).

Nothing here runs at import time except making ``openbinding_gateway`` importable
when the tools are started as scripts. SPACE and SPHERE own prices, versions and
contracts; these helpers only read them, and upload one private development
pricing under explicit guards (see ``remote_provision.py``).

Secrets: only ``SPACE_API_KEY`` and ``SPHERE_API_KEY`` are credentials. They are
read from the environment, never printed, never placed in exception messages and
scrubbed (``Redactor``) from every remote body, header and error before output.
Organization ids are identifiers, but they are still shown masked.
"""

from __future__ import annotations

import hashlib
import json
import re
import sys
from collections.abc import Collection, Iterable, Mapping
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import quote, quote_plus, urljoin, urlsplit

import httpx
import yaml


def _ensure_gateway_importable() -> None:
    """Add ``src`` next to this folder to ``sys.path`` only if the package is not importable."""
    try:
        import openbinding_gateway  # noqa: F401
    except ImportError:
        src = Path(__file__).resolve().parents[1] / "src"
        if src.is_dir() and str(src) not in sys.path:
            sys.path.insert(0, str(src))


_ensure_gateway_importable()

from openbinding_gateway.core.timeutil import utc_timestamp_z  # noqa: E402

__all__ = [
    "ApiResult",
    "ConfigError",
    "Download",
    "EXIT_COLLISION",
    "EXIT_GUARD",
    "EXIT_INTERNAL",
    "EXIT_OK",
    "EXIT_REJECTED",
    "CLASS_COUNTER",
    "CLASS_CU",
    "CU_COUNTERS",
    "Redactor",
    "RemoteEnv",
    "RemoteError",
    "SphereRemote",
    "SpaceRemote",
    "USAGE_COUNTERS",
    "classify_created_at",
    "emit_json",
    "finding_names",
    "load_env",
    "mask_id",
    "normalize_digest",
    "normalize_space_services",
    "parse_digest_spec",
    "normalize_sphere_versions",
    "parse_created_at",
    "scan_cu",
    "sha256_digest",
    "shape_of",
    "unparsed_scan",
    "utc_timestamp_z",
    "version_key",
    "yaml_meta",
]

EXIT_OK = 0
EXIT_GUARD = 2  # bad arguments/configuration, or a guard refused (nothing written)
EXIT_COLLISION = 3  # the development target already exists (nothing written)
EXIT_REJECTED = 4  # a remote refused or did not confirm a step (reported verbatim, redacted)
EXIT_INTERNAL = 5  # unexpected failure of the tool itself

REDACTED = "[REDACTED]"
MAX_YAML_BYTES = 2 * 1024 * 1024
MAX_EXCERPT = 2000
ENV_NAMES = (
    "SPACE_URL",
    "SPACE_API_KEY",
    "SPACE_ORGANIZATION_ID",
    "SPHERE_URL",
    "SPHERE_API_KEY",
    "SPHERE_ORGANIZATION_ID",
)

# --------------------------------------------------------------------------
# Redaction
# --------------------------------------------------------------------------

_SENSITIVE_NAME = re.compile(
    r"^(x-api-key|api[-_]?key|authorization|proxy-authorization|cookie|set-cookie|"
    r"token|access[-_]?token|refresh[-_]?token|pricingtoken|secret|password)$",
    re.IGNORECASE,
)
_INLINE_SECRET = re.compile(
    r"(?i)\b(x-api-key|api[-_]?key|authorization|token|secret|password)\b"
    r"(\"?\s*[:=]\s*\"?)(?:bearer\s+)?([^\s\"',;}]+)"
)


class Redactor:
    """Removes the configured secrets, and values of secret-looking names, from output."""

    def __init__(self, secrets: Iterable[str] = ()):
        variants: set[str] = set()
        for secret in secrets:
            if not secret:
                continue
            variants.update(
                {
                    secret,
                    quote(secret, safe=""),
                    quote_plus(secret),
                    json.dumps(secret)[1:-1],
                }
            )
        self._variants = sorted(variants, key=len, reverse=True)

    def exact(self, value: str) -> str:
        for variant in self._variants:
            if variant:
                value = value.replace(variant, REDACTED)
        return value

    def text(self, value: Any) -> str:
        return _INLINE_SECRET.sub(
            lambda m: f"{m.group(1)}{m.group(2)}{REDACTED}", self.exact(str(value))
        )

    def excerpt(self, value: Any, limit: int = MAX_EXCERPT) -> str:
        text = self.text(value)
        return text if len(text) <= limit else text[:limit] + f"...[{len(text) - limit} more characters]"

    def obj(self, value: Any) -> Any:
        if isinstance(value, Mapping):
            result: dict[str, Any] = {}
            for key, item in value.items():
                name = self.text(key)
                if isinstance(key, str) and _SENSITIVE_NAME.match(key):
                    result[name] = REDACTED
                else:
                    result[name] = self.obj(item)
            return result
        if isinstance(value, (list, tuple, set, frozenset)):
            return [self.obj(item) for item in value]
        if isinstance(value, str):
            return self.text(value)
        return value

    def headers(self, headers: Mapping[str, Any]) -> dict[str, str]:
        return {
            str(name): REDACTED if _SENSITIVE_NAME.match(str(name)) else self.text(value)
            for name, value in headers.items()
        }

    def error(self, exc: BaseException) -> str:
        return self.excerpt(f"{type(exc).__name__}: {exc}", 500)


class RemoteError(RuntimeError):
    """A remote operation failed. The message is already redacted; never chain the cause."""


def emit_json(report: Any, redactor: Redactor, stream: Any = None) -> None:
    """Print ``report`` as one JSON document, scrubbed of every configured secret."""
    document = json.dumps(redactor.obj(report), indent=2, sort_keys=True, ensure_ascii=True, default=str)
    print(redactor.exact(document), file=stream or sys.stdout)


def mask_id(value: str | None) -> str | None:
    if not value:
        return None
    return "****" if len(value) <= 8 else f"{value[:4]}...{value[-4:]}"


def shape_of(value: Any, depth: int = 2) -> Any:
    """Type and key names only: describes an unrecognized body without printing its values."""
    if isinstance(value, dict):
        keys = sorted(str(key) for key in value)[:30]
        shape: dict[str, Any] = {"type": "object", "keys": keys}
        if depth > 0:
            shape["children"] = {
                str(key): shape_of(value[key], depth - 1) for key in list(value)[:10] if isinstance(value[key], (dict, list))
            }
        return shape
    if isinstance(value, list):
        item = shape_of(value[0], depth - 1) if value and depth > 0 else None
        return {"type": "array", "length": len(value), "first": item}
    return {"type": type(value).__name__}


# --------------------------------------------------------------------------
# Environment
# --------------------------------------------------------------------------


class ConfigError(Exception):
    """The environment is unusable. Messages name variables, never their values."""


@dataclass(frozen=True)
class RemoteEnv:
    space_url: str = ""
    space_api_key: str = field(default="", repr=False)
    space_organization_id: str = ""
    sphere_url: str = ""
    sphere_api_key: str = field(default="", repr=False)
    sphere_organization_id: str = ""

    def secrets(self) -> tuple[str, ...]:
        return tuple(key for key in (self.space_api_key, self.sphere_api_key) if key)

    def describe(self) -> dict[str, Any]:
        return {
            "spaceOrigin": self.space_url or None,
            "sphereOrigin": self.sphere_url or None,
            "spaceOrganizationId": mask_id(self.space_organization_id),
            "sphereOrganizationId": mask_id(self.sphere_organization_id),
            "spaceKeyConfigured": bool(self.space_api_key),
            "sphereKeyConfigured": bool(self.sphere_api_key),
        }


def _origin(name: str, raw: str | None) -> str:
    value = (raw or "").strip()
    if not value:
        raise ConfigError(f"{name} is not set")
    if any(ch.isspace() or ord(ch) < 32 for ch in value):
        raise ConfigError(f"{name} contains whitespace or control characters")
    try:
        parts = urlsplit(value)
        parts.port  # noqa: B018 - raises ValueError for a malformed port
    except ValueError:
        raise ConfigError(f"{name} is not a valid URL") from None
    if parts.scheme != "https":
        raise ConfigError(f"{name} must use the https scheme")
    if not parts.hostname:
        raise ConfigError(f"{name} has no host")
    if parts.username is not None or parts.password is not None or "@" in parts.netloc:
        raise ConfigError(f"{name} must not embed credentials")
    if parts.query or parts.fragment or "?" in value or "#" in value:
        raise ConfigError(f"{name} must not carry a query or fragment")
    if parts.path not in ("", "/"):
        raise ConfigError(f"{name} must be an origin without a path (the client adds /api/v1)")
    return f"https://{parts.netloc.lower()}"


def _key(name: str, raw: str | None) -> str:
    value = raw or ""
    if not value.strip():
        raise ConfigError(f"{name} is not set")
    if value != value.strip() or not value.isascii() or not value.isprintable() or " " in value:
        raise ConfigError(f"{name} contains whitespace or characters that are not valid in a header")
    if len(value) > 4096:
        raise ConfigError(f"{name} is too long")
    return value


_ORG_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$")


def _org_id(name: str, raw: str | None) -> str:
    value = (raw or "").strip()
    if not value:
        raise ConfigError(f"{name} is not set")
    if not _ORG_ID.match(value):
        raise ConfigError(f"{name} is not a valid organization identifier")
    return value


def load_env(environ: Mapping[str, str] | None = None, *, space: bool = True, sphere: bool = True) -> RemoteEnv:
    """Validate the variables of the requested services; every problem is reported at once."""
    import os

    source = os.environ if environ is None else environ
    problems: list[str] = []
    values: dict[str, str] = {}
    checks: list[tuple[str, Any]] = []
    if space:
        checks += [("SPACE_URL", _origin), ("SPACE_API_KEY", _key), ("SPACE_ORGANIZATION_ID", _org_id)]
    if sphere:
        checks += [("SPHERE_URL", _origin), ("SPHERE_API_KEY", _key), ("SPHERE_ORGANIZATION_ID", _org_id)]
    for name, check in checks:
        try:
            values[name] = check(name, source.get(name))
        except ConfigError as exc:
            problems.append(str(exc))
    if problems:
        raise ConfigError("; ".join(problems))
    return RemoteEnv(
        space_url=values.get("SPACE_URL", ""),
        space_api_key=values.get("SPACE_API_KEY", ""),
        space_organization_id=values.get("SPACE_ORGANIZATION_ID", ""),
        sphere_url=values.get("SPHERE_URL", ""),
        sphere_api_key=values.get("SPHERE_API_KEY", ""),
        sphere_organization_id=values.get("SPHERE_ORGANIZATION_ID", ""),
    )


# --------------------------------------------------------------------------
# YAML facts, digests, ordering
# --------------------------------------------------------------------------


def sha256_digest(content: bytes) -> str:
    """``sha256-<hex>`` of the exact bytes (the repository's immutable-content fingerprint)."""
    return f"sha256-{hashlib.sha256(content).hexdigest()}"


def normalize_digest(value: str | None) -> str | None:
    """Lower-case hex of a digest given as ``sha256-<hex>``, ``sha256:<hex>`` or bare hex."""
    if not isinstance(value, str):
        return None
    text = value.strip().lower()
    for prefix in ("sha256-", "sha256:"):
        if text.startswith(prefix):
            text = text[len(prefix):]
    return text if re.fullmatch(r"[0-9a-f]{64}", text) else None


DIGEST_PREFIX_MIN = 12


def parse_digest_spec(value: str | None) -> str | None:
    """Lower-case hex of a full digest or of a prefix of ``DIGEST_PREFIX_MIN``-64 hex characters.

    Accepts ``sha256-<hex>``, ``sha256:<hex>`` or bare hex; ``None`` for anything else (too short included).
    """
    if not isinstance(value, str):
        return None
    text = value.strip().lower()
    for prefix in ("sha256-", "sha256:"):
        if text.startswith(prefix):
            text = text[len(prefix):]
    return text if re.fullmatch(rf"[0-9a-f]{{{DIGEST_PREFIX_MIN},64}}", text) else None


_CREATED_Z = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")
_CREATED_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_CREATED_DATETIME = re.compile(r"^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}(:\d{2})?(\.\d+)?([Zz]|[+-]\d{2}:?\d{2})?$")


def classify_created_at(value: str | None) -> dict[str, str]:
    """``kind``: date | datetime | other | missing; ``format`` is the precise shape."""
    if value is None:
        return {"kind": "missing", "format": "missing"}
    if _CREATED_Z.match(value):
        return {"kind": "datetime", "format": "YYYY-MM-DDTHH:mm:ssZ"}
    if _CREATED_DATE.match(value):
        return {"kind": "date", "format": "YYYY-MM-DD"}
    if _CREATED_DATETIME.match(value):
        return {"kind": "datetime", "format": "other-datetime"}
    return {"kind": "other", "format": "other"}


def parse_created_at(value: str | None) -> datetime | None:
    """Aware UTC datetime for a date or date-time text (a date means 00:00:00Z); else ``None``."""
    if not isinstance(value, str):
        return None
    text = value.strip()
    try:
        if _CREATED_DATE.match(text):
            return datetime.fromisoformat(text).replace(tzinfo=timezone.utc)
        if _CREATED_DATETIME.match(text):
            parsed = datetime.fromisoformat(text.replace(" ", "T").replace("z", "Z"))
            return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed.astimezone(timezone.utc)
    except ValueError:
        return None
    return None


def version_key(version: str) -> tuple:
    """Dotted order: numeric segments by value, text segments after numbers, as text."""
    parts = re.split(r"[.\-+]", version)
    return tuple((0, int(part), "") if part.isdigit() else (1, 0, part) for part in parts)


def _scalar(raw: str) -> tuple[str, str | None]:
    """Value and quote character of the right-hand side of a top-level ``key: value`` line."""
    text = raw.strip()
    if text[:1] in ("'", '"'):
        quote_char = text[0]
        end = text.find(quote_char, 1)
        if end > 0:
            return text[1:end], quote_char
    comment = re.search(r"\s#", text)
    if comment:
        text = text[: comment.start()]
    return text.strip(), None


def top_level_line(text: str, key: str) -> re.Match[str] | None:
    """The single top-level ``key:`` line, ``None`` if absent; duplicates are an error."""
    matches = list(re.finditer(rf"(?m)^{re.escape(key)}[ \t]*:[ \t]*([^\r\n]*)(?=\r?\n|\Z)", text))
    if len(matches) > 1:
        raise ValueError(f"top-level key {key!r} appears more than once")
    return matches[0] if matches else None


def yaml_meta(content: bytes) -> dict[str, Any]:
    """version/createdAt/saasName of a Pricing2Yaml document, without printing its body."""
    meta: dict[str, Any] = {
        "parsed": False,
        "parseError": None,
        "version": None,
        "createdAt": None,
        "createdAtQuoted": None,
        "createdAtKind": "missing",
        "createdAtFormat": "missing",
        "saasName": None,
    }
    try:
        text = content.decode("utf-8-sig")
    except UnicodeDecodeError:
        meta["parseError"] = "UnicodeDecodeError"
        return meta
    data: Any = None
    try:
        data = yaml.safe_load(text)
        meta["parsed"] = isinstance(data, dict)
        if not meta["parsed"]:
            meta["parseError"] = "not-a-mapping"
    except yaml.YAMLError as exc:
        mark = getattr(exc, "problem_mark", None)
        meta["parseError"] = f"{type(exc).__name__}" + (f" at line {mark.line + 1}" if mark is not None else "")
    for key in ("version", "createdAt", "saasName"):
        try:
            line = top_level_line(text, key)
        except ValueError:
            meta["parseError"] = meta["parseError"] or f"duplicate-{key}"
            line = None
        value: str | None = None
        quoted: str | None = None
        if line is not None:
            value, quoted = _scalar(line.group(1))
        elif isinstance(data, dict) and key in data:
            raw = data[key]
            value = raw.isoformat() if isinstance(raw, (datetime, date)) else str(raw)
        if value is not None and value != "":
            meta[key] = value
            if key == "createdAt":
                meta["createdAtQuoted"] = quoted is not None
    classification = classify_created_at(meta["createdAt"])
    meta["createdAtKind"] = classification["kind"]
    meta["createdAtFormat"] = classification["format"]
    return meta


# --------------------------------------------------------------------------
# Capacity-unit scan
# --------------------------------------------------------------------------

#: Class A: credits / capacity units. The OpenBinding system has no currency of this kind.
CU_COUNTERS = ("capacityUnits",)
#: Class B: monthly usage counters declared by the remote pricings. Also retired from OpenBinding,
#: but a base that declares them can be used for development when the operator accepts it.
USAGE_COUNTERS = (
    "taskStarts",
    "solverSeconds",
    "federatedTaskStarts",
    "concurrentJobs",
    "studyRuns",
)
CLASS_CU = "A"
CLASS_COUNTER = "B"


def _alnum(text: str) -> str:
    return re.sub(r"[^a-z0-9]", "", text.lower())


_CU_NORMALIZED = {_alnum(name) for name in CU_COUNTERS}
_COUNTER_NORMALIZED = {_alnum(name) for name in USAGE_COUNTERS}
_TIME_WORDS = {"second", "seconds", "sec", "secs", "minute", "minutes", "hour", "hours", "time", "runtime", "duration"}


def _tokens(*texts: Any) -> list[str]:
    words: list[str] = []
    for text in texts:
        if isinstance(text, str):
            spaced = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", text)
            words += re.findall(r"[a-z0-9]+", spaced.lower())
    return words


def _classify(name: str, unit: Any = None) -> tuple[str, str] | None:
    """``(kind, class)`` of a limit/identifier by its name and unit; class A is checked before B."""
    words = _tokens(name, unit)
    pairs = set(zip(words, words[1:], strict=False))
    normalized = _alnum(name)
    if normalized in _CU_NORMALIZED:
        return "counter-key", CLASS_CU
    if {"credit", "credits"} & set(words):
        return "credit-like", CLASS_CU
    if {"cu", "cus"} & set(words) or pairs & {
        ("capacity", "unit"),
        ("capacity", "units"),
        ("compute", "unit"),
        ("compute", "units"),
        ("capacity", "credit"),
    }:
        return "capacity-unit-like", CLASS_CU
    if normalized in _COUNTER_NORMALIZED:
        return "counter-key", CLASS_COUNTER
    if "solver" in words and _TIME_WORDS & set(words):
        return "solver-time-like", CLASS_COUNTER
    return None


def unparsed_scan() -> dict[str, Any]:
    """The scan result for a document that is missing or cannot be read (never clean)."""
    return {
        "status": "unparsed",
        "parsed": False,
        "hasCu": None,
        "hasUsageCounters": None,
        "cuCount": 0,
        "counterCount": 0,
        "findings": [],
        "limitNames": [],
        "planLimitNames": [],
    }


def finding_names(scan: Mapping[str, Any], finding_class: str) -> list[str]:
    """Sorted distinct names of the findings of one class in a ``scan_cu`` result."""
    return sorted({str(item.get("name")) for item in scan.get("findings") or [] if item.get("class") == finding_class})


def _walk_keys(node: Any, path: str = ""):
    if isinstance(node, dict):
        for key, value in node.items():
            here = f"{path}.{key}" if path else str(key)
            yield here, str(key)
            yield from _walk_keys(value, here)
    elif isinstance(node, list):
        for index, value in enumerate(node):
            yield from _walk_keys(value, f"{path}[{index}]")


def scan_cu(content: bytes | Mapping[str, Any]) -> dict[str, Any]:
    """Deterministic scan of a pricing for two classes of findings.

    Class A (credits/CU): any key named ``capacityUnits``, limits whose name or unit
    suggest credits, CU or capacity/compute units, and expressions referencing them.
    Class B (usage counters): keys named ``taskStarts``, ``solverSeconds``,
    ``federatedTaskStarts``, ``concurrentJobs`` or ``studyRuns``, limits whose
    name or unit suggest solver time, and expressions referencing them.
    Every finding carries its ``class``. ``status`` is ``cu`` (any A), ``counters``
    (B only), ``clean``, or ``unparsed`` when the document cannot be read: that is
    never treated as clean.
    """
    if isinstance(content, (bytes, bytearray)):
        try:
            data = yaml.safe_load(bytes(content).decode("utf-8-sig"))
        except (yaml.YAMLError, UnicodeDecodeError):
            data = None
    else:
        data = dict(content)
    if not isinstance(data, dict):
        return unparsed_scan()

    findings: dict[tuple[str, str, str], dict[str, Any]] = {}

    def add(kind: str, finding_class: str, path: str, name: str, unit: Any = None) -> None:
        entry: dict[str, Any] = {"kind": kind, "class": finding_class, "path": path, "name": name}
        if isinstance(unit, str):
            entry["unit"] = unit
        findings.setdefault((kind, path, name), entry)

    for path, key in _walk_keys(data):
        normalized = _alnum(key)
        if normalized in _CU_NORMALIZED:
            add("counter-key", CLASS_CU, path, key)
        elif normalized in _COUNTER_NORMALIZED:
            add("counter-key", CLASS_COUNTER, path, key)

    def limits_in(container: Any, base: str) -> list[str]:
        names: list[str] = []
        if isinstance(container, dict):
            for name, spec in container.items():
                names.append(str(name))
                unit = spec.get("unit") if isinstance(spec, dict) else None
                verdict = _classify(str(name), unit)
                if verdict:
                    add(verdict[0], verdict[1], f"{base}.{name}", str(name), unit)
        return names

    limit_names = limits_in(data.get("usageLimits"), "usageLimits")
    plan_names: set[str] = set()
    for group, field_name in (("plans", "usageLimits"), ("addOns", "usageLimitsExtensions"), ("addOns", "usageLimits")):
        section = data.get(group)
        if isinstance(section, dict):
            for item_name, item in section.items():
                if isinstance(item, dict):
                    plan_names.update(limits_in(item.get(field_name), f"{group}.{item_name}.{field_name}"))

    features = data.get("features")
    if isinstance(features, dict):
        for name, feature in features.items():
            expression = feature.get("expression") if isinstance(feature, dict) else None
            if isinstance(expression, str):
                for identifier in dict.fromkeys(re.findall(r"[A-Za-z_][A-Za-z0-9_]*", expression)):
                    verdict = _classify(identifier)
                    if verdict:
                        add("expression-reference", verdict[1], f"features.{name}.expression", identifier)

    ordered = sorted(findings.values(), key=lambda item: (item["kind"], item["path"], item["name"]))
    cu_count = sum(1 for item in ordered if item["class"] == CLASS_CU)
    counter_count = sum(1 for item in ordered if item["class"] == CLASS_COUNTER)
    return {
        "status": "cu" if cu_count else "counters" if counter_count else "clean",
        "parsed": True,
        "hasCu": cu_count > 0,
        "hasUsageCounters": counter_count > 0,
        "cuCount": cu_count,
        "counterCount": counter_count,
        "findings": ordered,
        "limitNames": sorted(limit_names),
        "planLimitNames": sorted(plan_names),
    }


# --------------------------------------------------------------------------
# HTTP plumbing
# --------------------------------------------------------------------------


@dataclass
class ApiResult:
    """What a call returned. HTTP statuses never raise; ``status`` is ``None`` on transport failure."""

    status: int | None
    data: Any = None
    text: str = ""
    error: str | None = None

    @property
    def ok(self) -> bool:
        return self.status is not None and 200 <= self.status < 300

    def describe(self) -> dict[str, Any]:
        summary: dict[str, Any] = {"status": self.status}
        if self.error:
            summary["error"] = self.error
        if self.text:
            summary["body"] = self.text
        return summary


@dataclass
class Download:
    content: bytes | None
    error: str | None = None
    status: int | None = None


class _Http:
    def __init__(self, api_base: str, key: str, redactor: Redactor, transport: httpx.AsyncBaseTransport | None, timeout: float):
        self._base = api_base
        self._redactor = redactor
        self._client = httpx.AsyncClient(
            headers={"x-api-key": key},
            timeout=timeout,
            follow_redirects=False,
            transport=transport,
        )

    @property
    def client(self) -> httpx.AsyncClient:
        return self._client

    async def aclose(self) -> None:
        await self._client.aclose()

    async def request(self, method: str, path: str, **kwargs: Any) -> ApiResult:
        failure: str | None = None
        response: httpx.Response | None = None
        try:
            response = await self._client.request(method, f"{self._base}{path}", **kwargs)
        except httpx.HTTPError as exc:
            failure = self._redactor.error(exc)
        if response is None:
            return ApiResult(status=None, error=failure)
        data: Any = None
        try:
            data = response.json()
        except ValueError:
            data = None
        text = ""
        if data is None or not 200 <= response.status_code < 300:
            text = self._redactor.excerpt(response.text)
        return ApiResult(status=response.status_code, data=data, text=text)


def _seg(value: str) -> str:
    return quote(str(value), safe="")


def _first(mapping: Mapping[str, Any], *names: str) -> Any:
    for name in names:
        if name in mapping and mapping[name] not in (None, ""):
            return mapping[name]
    return None


def _tristate(value: Any) -> bool | None:
    if isinstance(value, bool):
        return value
    if isinstance(value, str) and value.strip().lower() in ("true", "false"):
        return value.strip().lower() == "true"
    return None


# --------------------------------------------------------------------------
# SPHERE
# --------------------------------------------------------------------------


def normalize_sphere_versions(body: Any) -> tuple[list[dict[str, Any]], list[str]]:
    """Versions of one SPHERE pricing from whatever shape came back, plus notes on oddities."""
    notes: list[str] = []
    raw: list[Any]
    if isinstance(body, dict) and isinstance(body.get("versions"), list):
        raw = body["versions"]
    elif isinstance(body, dict) and body.get("version"):
        raw = [body]
    elif isinstance(body, list):
        raw = body
    else:
        return [], [f"unrecognized-versions-shape:{json.dumps(shape_of(body), sort_keys=True)}"]
    versions: list[dict[str, Any]] = []
    for item in raw:
        if not isinstance(item, dict):
            notes.append("non-object-version-entry")
            continue
        version = item.get("version")
        if not isinstance(version, str) or not version.strip():
            notes.append("version-without-string-version")
            continue
        private = _tristate(item.get("private") if "private" in item else item.get("isPrivate"))
        if private is None and isinstance(item.get("visibility"), str):
            private = item["visibility"].strip().lower() == "private" if item["visibility"].strip().lower() in ("private", "public") else None
        url = _first(item, "yaml", "url")
        versions.append(
            {
                "version": version.strip(),
                "private": private,
                "yamlUrl": url if isinstance(url, str) else None,
                "apiCreatedAt": _first(item, "createdAt", "created_at", "_createdAt", "extractionDate", "date"),
                "id": _first(item, "id", "_id"),
            }
        )
    return versions, notes


def _slug_names(body: Any) -> list[str] | None:
    """Pricing slugs from a listing body; ``None`` if the body is not a recognizable listing."""
    items: Any = None
    if isinstance(body, list):
        items = body
    elif isinstance(body, dict):
        for key in ("pricings", "items", "data", "results"):
            if isinstance(body.get(key), list):
                items = body[key]
                break
    if items is None:
        return None
    slugs: list[str] = []
    for item in items:
        if isinstance(item, str):
            slugs.append(item)
        elif isinstance(item, dict):
            value = _first(item, "slug", "name", "pricingName", "saasName")
            if isinstance(value, str):
                slugs.append(value)
    return sorted(set(slugs))


class SphereRemote:
    """The few SPHERE calls the tools need: reads, and one guarded private upload."""

    def __init__(self, env: RemoteEnv, *, transport: httpx.AsyncBaseTransport | None = None, timeout: float = 20.0):
        self.env = env
        self.redactor = Redactor(env.secrets())
        self._origin = env.sphere_url
        self._http = _Http(f"{env.sphere_url}/api/v1", env.sphere_api_key, self.redactor, transport, timeout)

    async def aclose(self) -> None:
        await self._http.aclose()

    @property
    def org_id(self) -> str:
        return self.env.sphere_organization_id

    async def my_orgs(self) -> ApiResult:
        return await self._http.request("GET", "/users/me/orgs")

    async def org(self) -> ApiResult:
        return await self._http.request("GET", f"/orgs/{_seg(self.org_id)}")

    async def list_pricings(self) -> ApiResult:
        return await self._http.request("GET", f"/pricings/{_seg(self.org_id)}", params={"includePrivate": "true"})

    async def pricing_versions(self, slug: str) -> ApiResult:
        return await self._http.request(
            "GET", f"/pricings/{_seg(self.org_id)}/{_seg(slug)}", params={"includePrivate": "true"}
        )

    def trusted_yaml_url(self, value: str) -> str | None:
        url = urljoin(f"{self._origin}/", value)
        expected, actual = urlsplit(self._origin), urlsplit(url)
        if (actual.scheme, actual.netloc) != (expected.scheme, expected.netloc):
            return None
        if actual.path.startswith("/static/pricings/") or re.fullmatch(r"/[^/]+/[^/]+/[^/]+\.ya?ml", actual.path):
            return url
        return None

    async def download_yaml(self, value: str | None) -> Download:
        if not value:
            return Download(None, "no yaml url in the version metadata")
        url = self.trusted_yaml_url(value)
        if url is None:
            return Download(None, "yaml url rejected: other origin or unexpected path")
        failure: str | None = None
        response: httpx.Response | None = None
        try:
            response = await self._http.client.get(url)
        except httpx.HTTPError as exc:
            failure = self.redactor.error(exc)
        if response is None:
            return Download(None, failure)
        if not 200 <= response.status_code < 300:
            return Download(None, f"yaml download returned {response.status_code}", response.status_code)
        if len(response.content) > MAX_YAML_BYTES:
            return Download(None, "yaml exceeds 2 MB", response.status_code)
        return Download(response.content, None, response.status_code)

    async def upload_private(
        self,
        *,
        slug: str,
        version: str,
        saas_name: str,
        content: bytes,
        endpoint: str,
        protected_slugs: Collection[str],
    ) -> ApiResult:
        """Upload ``content`` as a PRIVATE pricing. There is no way to ask for a public one here."""
        if slug.casefold() in {item.casefold() for item in protected_slugs}:
            raise RemoteError("refusing to upload under a protected (production) slug")
        fields = {"private": "true", "saasName": saas_name, "name": slug, "version": version}
        files = {"yaml": (f"{slug}-{version}.yaml", content, "application/yaml")}
        if endpoint == "version":
            path = f"/pricings/{_seg(self.org_id)}/{_seg(slug)}/{_seg(version)}"
        elif endpoint == "create":
            path = f"/pricings/{_seg(self.org_id)}"
        else:
            raise RemoteError("unknown SPHERE upload endpoint")
        return await self._http.request("POST", path, data=fields, files=files)


# --------------------------------------------------------------------------
# SPACE
# --------------------------------------------------------------------------


def _space_versions(value: Any, status: str | None) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    if isinstance(value, dict):
        for key, item in value.items():
            detail = item if isinstance(item, dict) else {}
            version = detail.get("version") if isinstance(detail.get("version"), str) else str(key)
            entries.append(
                {
                    "version": version,
                    "status": status or detail.get("status"),
                    "id": _first(detail, "id", "_id"),
                    "createdAt": _first(detail, "createdAt", "extractionDate"),
                }
            )
    elif isinstance(value, list):
        for item in value:
            if isinstance(item, str):
                entries.append({"version": item, "status": status, "id": None, "createdAt": None})
            elif isinstance(item, dict) and isinstance(item.get("version"), str):
                entries.append(
                    {
                        "version": item["version"],
                        "status": status or item.get("status"),
                        "id": _first(item, "id", "_id"),
                        "createdAt": _first(item, "createdAt", "extractionDate"),
                    }
                )
    return entries


def normalize_space_services(body: Any) -> tuple[list[dict[str, Any]], list[str]]:
    """Services (name, id, versions with status) from whatever shape SPACE answered."""
    notes: list[str] = []
    items: Any = None
    if isinstance(body, list):
        items = body
    elif isinstance(body, dict):
        for key in ("services", "items", "data", "results"):
            if isinstance(body.get(key), list):
                items = body[key]
                break
        if items is None and isinstance(body.get("name"), str):
            items = [body]
    if items is None:
        return [], [f"unrecognized-services-shape:{json.dumps(shape_of(body), sort_keys=True)}"]
    services: list[dict[str, Any]] = []
    for raw in items:
        if not isinstance(raw, dict):
            notes.append("non-object-service-entry")
            continue
        name = raw.get("name")
        if not isinstance(name, str) or not name:
            notes.append("service-without-name")
            continue
        versions: list[dict[str, Any]] = []
        for key, status in (("activePricings", "active"), ("archivedPricings", "archived"), ("pricings", None)):
            versions += _space_versions(raw.get(key), status)
        seen: set[tuple[str, Any]] = set()
        unique = []
        for entry in versions:
            marker = (entry["version"], entry["status"])
            if marker not in seen:
                seen.add(marker)
                unique.append(entry)
        disabled = raw.get("disabled")
        services.append(
            {
                "name": name,
                "id": _first(raw, "id", "_id"),
                "disabled": disabled if isinstance(disabled, bool) else None,
                "organizationId": _first(raw, "organizationId", "_organizationId"),
                "versions": sorted(unique, key=lambda entry: (version_key(entry["version"]), str(entry["status"]))),
            }
        )
    return services, notes


class SpaceRemote:
    """SPACE: the official async SDK for health and contracts; plain httpx for services.

    The SDK (``space-python-client``) has no services/pricings operations, so those use the same
    ``x-api-key`` header the SDK sends. ``remove_contract`` and usage adjustments are deliberately
    not exposed here.
    """

    def __init__(self, env: RemoteEnv, *, transport: httpx.AsyncBaseTransport | None = None, timeout_ms: int = 20000):
        from space_client import SpaceClientFactory

        self.env = env
        self.redactor = Redactor(env.secrets())
        self._sdk = SpaceClientFactory.connect_async(env.space_url, env.space_api_key, timeout_ms)
        if transport is not None:
            # The SDK builds its own httpx client; tests substitute a simulated transport for it.
            self._sdk._http_client = httpx.AsyncClient(timeout=timeout_ms / 1000, transport=transport)
        self._http = _Http(f"{env.space_url}/api/v1", env.space_api_key, self.redactor, transport, timeout_ms / 1000)

    async def aclose(self) -> None:
        try:
            await self._sdk.close()
        except Exception:  # noqa: BLE001 - closing must not mask the real result
            pass
        await self._http.aclose()

    async def healthcheck(self) -> dict[str, Any]:
        from space_client import SpaceApiError, SpaceError

        outcome: dict[str, Any] = {"ok": False, "status": None, "error": None}
        try:
            outcome["ok"] = bool(await self._sdk.is_connected_to_space())
            outcome["status"] = 200
        except SpaceApiError as exc:
            outcome["status"] = exc.status_code
            outcome["error"] = self.redactor.error(exc)
        except SpaceError as exc:
            outcome["error"] = self.redactor.error(exc)
        return outcome

    async def services(self) -> ApiResult:
        return await self._http.request("GET", "/services")

    async def service(self, name: str) -> ApiResult:
        return await self._http.request("GET", f"/services/{_seg(name)}")

    async def service_pricings(self, name: str) -> ApiResult:
        return await self._http.request("GET", f"/services/{_seg(name)}/pricings")

    async def upload_service(self, *, content: bytes, filename: str, protected_service_names: Collection[str]) -> ApiResult:
        """Create a service from an uploaded (private, native) pricing file.

        SPACE names the service after the document's ``saasName``, so that name is checked against the
        protected (production) names before anything is sent.
        """
        saas_name = yaml_meta(content).get("saasName") or ""
        if not saas_name or saas_name.casefold() in {item.casefold() for item in protected_service_names}:
            raise RemoteError("refusing to upload: the pricing's saasName is missing or names a protected service")
        files = {"pricing": (filename, content, "application/yaml")}
        return await self._http.request("POST", "/services", files=files)

    async def get_contract(self, user_id: str) -> tuple[str, Any, str | None]:
        """``("found"|"missing"|"error", contract, redacted_error)``."""
        from space_client import SpaceApiError, SpaceError

        try:
            contract = await self._sdk.contracts.get_contract(user_id)
        except SpaceApiError as exc:
            if exc.status_code == 404:
                return "missing", None, None
            return "error", None, self.redactor.error(exc)
        except (SpaceError, ValueError, TypeError, AttributeError) as exc:
            return "error", None, self.redactor.error(exc)
        return ("found", contract, None) if contract is not None else ("missing", None, None)

    async def add_contract(self, contract_to_create: Any) -> tuple[bool, Any, str | None]:
        from space_client import SpaceError

        try:
            contract = await self._sdk.contracts.add_contract(contract_to_create)
        except (SpaceError, ValueError, TypeError, AttributeError) as exc:
            return False, None, self.redactor.error(exc)
        return contract is not None, contract, None
