"""What a project VIEWER may read of a job.

A VIEWER may follow a project's work - state, engine, times, result and the
digests that pin it - but never the request's credentials, the options a member
chose beyond a short list of harmless ones, or anything that names a private
engine endpoint. Members and above get the stored job unchanged.

Options are redacted by **allow-list**, not deny-list: an option survives only
if it is declared by an installed built-in engine manifest's ``optionsSchema``
(or is one of the generic names below), its name does not look like a
credential, and its value is a short scalar. A federated engine may declare any
option it likes - including one a user fills with a secret - so its names are
not trusted by being in its own schema.

``original_request`` is reduced to the problem document and the pinned
execution choices, and everything else - in particular anything under an
``auth`` key - is dropped. The IR itself is the compiled problem and is not
rewritten. The ``error`` of a failed job is the text of the exception that
stopped it, which can name a private endpoint, so a redacted view replaces it
with a fixed sentence (and the category, when the result has a code).
"""

from __future__ import annotations

import copy
import json
import re
from functools import lru_cache
from pathlib import Path
from typing import Any, Mapping, Optional

from ..core.settings import get_settings

#: Option names that are harmless whichever engine reads them. Built-in
#: manifests add their own (see ``allowed_option_names``).
GENERIC_OPTION_NAMES = frozenset(
    {
        "time_budget_ms",
        "timeout",
        "timeout_s",
        "seed",
        "mode",
        "objective",
        "scalarization",
        "algorithm",
        "iterations",
        "max_evaluations",
    }
)

#: Words that make a key name look like a credential or a connection detail.
_SENSITIVE_WORDS = frozenset(
    {
        "auth", "authorization", "authentication", "credential", "credentials", "secret",
        "secrets", "password", "passwd", "token", "tokens", "bearer", "cookie", "cookies",
        "header", "headers", "private", "certificate", "endpoint", "url", "uri", "host",
        "signature", "session",
    }
)
_WORD = re.compile(r"[A-Z]?[a-z0-9]+|[A-Z]+(?![a-z])")


def _sensitive(name: str) -> bool:
    """Whether a key such as ``auth``, ``apiKey`` or ``engine_url`` names a secret or an address."""
    words = [word.lower() for word in _WORD.findall(name)]
    joined = "".join(words)
    return bool(_SENSITIVE_WORDS.intersection(words)) or "apikey" in joined or "privatekey" in joined

#: Largest string value an allowed option may carry.
_MAX_OPTION_STRING = 128

#: What a pinned reference to an engine registration may show.
_REFERENCE_KEYS = ("namespace", "name", "version", "digest")

#: Top-level keys of ``original_request`` a VIEWER may see.
_REQUEST_KEYS = ("bindingProblem", "timeout", "mode", "optimization", "registration")


@lru_cache(maxsize=4)
def _manifest_option_names(schemas_dir: str) -> frozenset[str]:
    names: set[str] = set()
    root = Path(schemas_dir) / "bim" / "v1" / "manifests"
    if not root.is_dir():
        return frozenset()
    for path in sorted(root.glob("*.json")):
        try:
            document = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        for mode in (document.get("spec", {}) or {}).get("modes", []) or []:
            properties = ((mode or {}).get("optionsSchema") or {}).get("properties") or {}
            names.update(name for name in properties if isinstance(name, str))
    return frozenset(names)


def allowed_option_names() -> frozenset[str]:
    """Option names a VIEWER may see: generic ones plus the built-in engines' own."""
    names = GENERIC_OPTION_NAMES | _manifest_option_names(get_settings().schemas_dir)
    return frozenset(name for name in names if not _sensitive(name))


def _harmless_scalar(value: Any) -> bool:
    if isinstance(value, bool) or value is None:
        return True
    if isinstance(value, (int, float)):
        return True
    return (
        isinstance(value, str)
        and len(value) <= _MAX_OPTION_STRING
        and "://" not in value
    )


def redact_options(options: Optional[Mapping[str, Any]]) -> Optional[dict[str, Any]]:
    """Only the allow-listed, scalar options."""
    if options is None:
        return None
    allowed = allowed_option_names()
    return {
        name: value
        for name, value in options.items()
        if name in allowed and _harmless_scalar(value)
    }


def scrub(value: Any) -> Any:
    """A deep copy without any key that looks like a credential or an address."""
    if isinstance(value, Mapping):
        return {
            key: scrub(child)
            for key, child in value.items()
            if not (isinstance(key, str) and _sensitive(key))
        }
    if isinstance(value, list):
        return [scrub(child) for child in value]
    return value


def _reference(value: Any) -> Any:
    if isinstance(value, Mapping):
        return {key: value[key] for key in _REFERENCE_KEYS if key in value}
    return None


def redact_original_request(request: Optional[Mapping[str, Any]]) -> Optional[dict[str, Any]]:
    """The problem document and the pinned execution choices, nothing else."""
    if request is None:
        return None
    redacted: dict[str, Any] = {}
    for key in _REQUEST_KEYS:
        if key not in request:
            continue
        if key == "bindingProblem":
            redacted[key] = copy.deepcopy(request[key])
        elif key == "registration":
            redacted[key] = _reference(request[key])
        else:
            redacted[key] = scrub(request[key])
    return redacted


def redact_provenance(provenance: Optional[Mapping[str, Any]]) -> Optional[dict[str, Any]]:
    """Provenance with its options redacted; the digests and pins stay."""
    if provenance is None:
        return None
    redacted = dict(provenance)
    for key in ("options", "requestedOptions"):
        if isinstance(redacted.get(key), Mapping):
            redacted[key] = redact_options(redacted[key])
    if "registration" in redacted:
        redacted["registration"] = _reference(redacted["registration"])
    if "engineReported" in redacted:
        redacted["engineReported"] = scrub(redacted["engineReported"])
    return redacted


#: What a redacted view says of a failed job; the stored message is free text.
GENERIC_ERROR = "The job failed. The details are visible to project members."
_ERROR_CODE_KEYS = ("errorCode", "error_code")
_ERROR_CODE = re.compile(r"[a-z][a-z0-9_]{0,63}")


def redact_error(result: Mapping[str, Any]) -> str:
    """A stable text for the ``error`` of a failed job, without its free-text message.

    The stored message is ``str(exc)`` and may name the host or address of a
    private federated endpoint. Only a category survives, and only when the
    result carries a code of the form ``engine_error``.
    """
    for key in _ERROR_CODE_KEYS:
        code = result.get(key)
        if isinstance(code, str) and _ERROR_CODE.fullmatch(code):
            return f"{GENERIC_ERROR} (category: {code})"
    return GENERIC_ERROR


def redact_result(result: Optional[Mapping[str, Any]]) -> Optional[dict[str, Any]]:
    """The result as stored, with the provenance and the error message redacted.

    A code under ``errorCode`` / ``error_code`` is kept as the category of the
    failure; it is a name, not a message.
    """
    if result is None:
        return None
    redacted = dict(result)
    if isinstance(redacted.get("provenance"), Mapping):
        redacted["provenance"] = redact_provenance(redacted["provenance"])
    if redacted.get("error") is not None:
        redacted["error"] = redact_error(result)
    return redacted


async def must_redact_jobs(session: Any, organization_id: Any, user: Any) -> bool:
    """Whether ``user`` may follow a project's jobs but not read their inputs.

    True below MEMBER (and for anyone without a role) and for an API key that
    cannot write projects: such a key is a read-only credential and must not
    carry out the options or request a member chose. Shared by every route that
    serialises a project's jobs.
    """
    # Imported here: ``collaboration`` imports models that import this module.
    from ..collaboration import ROLE_STRENGTH, effective_role
    from ..db.platform_models import OrganizationRole
    from .apikeys import ApiKeyPermission, authenticated_api_key, permissions_of

    role = await effective_role(session, organization_id, user)
    if role is None or ROLE_STRENGTH[role] < ROLE_STRENGTH[OrganizationRole.MEMBER]:
        return True
    api_key = authenticated_api_key(user)
    return api_key is not None and ApiKeyPermission.PROJECTS_WRITE.value not in permissions_of(api_key)


__all__ = [
    "GENERIC_OPTION_NAMES",
    "allowed_option_names",
    "must_redact_jobs",
    "redact_error",
    "redact_options",
    "redact_original_request",
    "redact_provenance",
    "redact_result",
    "scrub",
]
