"""Compile a package with the installed toolchain, and say in stable terms why one was refused.

Uploading a problem, adding a revision, validating a package (``/v1/bim/validate``) and recompiling a
stored revision for a new toolchain all go through ``compile_package``, so a package that validates is a
package that saves, and a refusal reads the same everywhere.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping

from bim_core import BimError, CompileError, PackageError
from fastapi import HTTPException
from sqlalchemy.exc import SQLAlchemyError

from ....core.logging import redact
from ....integrations import bim, packages
from ....models.problem import split_detail
from ..domain.compilation import Compilation

#: The code of a package the toolchain cannot read as a package at all.
INVALID_REQUEST = "invalid_request"


async def compile_package(archive: bytes) -> Compilation:
    """Compile ``archive``: a refused source is ``422 invalid_instance`` with the located diagnostics.

    An archive the toolchain cannot read as a package is ``422 invalid_request`` with its message.
    """
    try:
        result = await bim.abim().compile(archive, [])
    except CompileError as exc:
        raise bim.http_exception_for(exc) from exc
    except PackageError as exc:
        raise HTTPException(422, detail={"code": INVALID_REQUEST, "message": str(exc)}) from exc
    instance = packages.instance_document(archive)
    if instance is None:
        raise HTTPException(422, detail={"code": INVALID_REQUEST, "message": "the package has no readable instance.json"})
    return Compilation.from_result(archive, instance, result)


# -- Why a compilation was refused ---------------------------------------------------------------

#: Verdicts of a refused compilation that are about the package itself, as opposed to the toolchain or the
#: database being unavailable (which says nothing about the package).
_PACKAGE_VERDICTS = frozenset({"invalid_package", "unreadable_package", "refused"})
_MAX_DIAGNOSTICS = 5
_MAX_TEXT = 300


def _clip(value: Any, limit: int = _MAX_TEXT) -> str:
    """One line of text without credential forms, no longer than ``limit``."""
    text = redact(" ".join(str(value).split()))
    return text if len(text) <= limit else text[: limit - 3] + "..."


def _clean_diagnostic(item: Any) -> dict[str, str]:
    if hasattr(item, "as_dict"):
        item = item.as_dict()
    item = item if isinstance(item, Mapping) else {"message": item}
    cleaned = {"code": _clip(item.get("code", ""), 80)}
    for key in ("resource", "pointer", "irPath", "bpmnElement"):
        if item.get(key):
            cleaned[key] = _clip(item[key], 200)
    cleaned["message"] = _clip(item.get("message", ""))
    return cleaned


@dataclass(frozen=True)
class CompileRefusal:
    """A refused compilation in stable, redacted terms: the toolchain's code, its findings and a verdict.

    ``verdict`` is ``invalid_package`` (the compiler's diagnostics), ``unreadable_package`` (not a package
    the toolchain can read), ``refused`` (another refusal of the input), ``unavailable`` (the toolchain or the
    database could not answer: no verdict on the package) or ``error`` (unexpected; only its type is named).
    """

    verdict: str
    code: str
    message: str
    diagnostics: tuple[dict[str, str], ...] = ()
    diagnostic_count: int = 0

    @property
    def about_the_package(self) -> bool:
        return self.verdict in _PACKAGE_VERDICTS

    def as_dict(self) -> dict[str, Any]:
        return {
            "verdict": self.verdict,
            "code": self.code,
            "message": self.message,
            "diagnostics": [dict(item) for item in self.diagnostics],
            "diagnosticCount": self.diagnostic_count,
        }


def compile_refusal(exc: BaseException) -> CompileRefusal:
    """The refusal ``exc`` stands for. Nothing but the toolchain's own findings is echoed."""
    if isinstance(exc, BimError):
        status, code, message, diagnostics, _, _ = bim.problem_for(exc)
        if isinstance(exc, CompileError):
            verdict = "invalid_package"
        elif isinstance(exc, PackageError):
            verdict = "unreadable_package"
        else:
            verdict = "unavailable" if status >= 500 else "refused"
    elif isinstance(exc, HTTPException):
        code, message, diagnostics, _ = split_detail(exc.detail, "request_invalid")
        if exc.status_code >= 500:
            verdict = "unavailable"
        elif code == "invalid_instance":
            verdict = "invalid_package"
        elif code == INVALID_REQUEST:
            verdict = "unreadable_package"
        else:
            verdict = "refused"
    elif isinstance(exc, SQLAlchemyError):
        return CompileRefusal("unavailable", "database_error", "The database could not be read.")
    else:
        return CompileRefusal("error", type(exc).__name__, "The compilation failed unexpectedly.")
    cleaned = tuple(_clean_diagnostic(item) for item in list(diagnostics)[:_MAX_DIAGNOSTICS])
    return CompileRefusal(verdict, _clip(code, 80), _clip(message), cleaned, len(diagnostics))
