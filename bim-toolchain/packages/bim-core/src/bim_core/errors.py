"""Error hierarchy of the BIM core.

Every error raised on purpose by ``bim_core`` is a :class:`BimError`.  It carries
a machine-readable ``code``, the human ``message`` (which is also ``str(error)``)
and, when there are several findings, a list of ``diagnostics``.  Concrete
errors also derive from :class:`ValueError`, as they did before this hierarchy
existed, so callers that catch ``ValueError`` keep working.
"""

from __future__ import annotations

from typing import Any, Iterable


class BimError(Exception):
    """Base class of every deliberate BIM core error."""

    def __init__(self, code: str, message: str, diagnostics: Iterable[Any] = ()) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.diagnostics = diagnostics if isinstance(diagnostics, list) else list(diagnostics)

    def as_dict(self) -> dict[str, Any]:
        """A JSON-compatible description: code, message and the diagnostics, if any."""
        result: dict[str, Any] = {"code": self.code, "message": self.message}
        if self.diagnostics:
            result["diagnostics"] = [
                item.as_dict() if hasattr(item, "as_dict") else item for item in self.diagnostics
            ]
        return result


class PackageError(BimError, ValueError):
    """A package failed the v1 transport/security contract."""

    def __init__(
        self, message: str, *, code: str = "package_error", diagnostics: Iterable[Any] = ()
    ) -> None:
        super().__init__(code, message, diagnostics)


class CompileError(BimError, ValueError):
    """Compilation found one or more diagnostics (each has ``message`` and ``as_dict``)."""

    def __init__(self, diagnostics: list[Any]) -> None:
        super().__init__(
            "compile_error", "; ".join(item.message for item in diagnostics), diagnostics
        )


class EvaluationError(BimError, ValueError):
    """A binding could not be validated or evaluated against a BindingProblem."""


class ProtocolError(BimError, ValueError):
    """A message violates the engine protocol (``bim-engine/v1``)."""


class ContractError(BimError, ValueError):
    """A pinned contract (Profile, Dialect, IR document, configuration, Engine declaration) is not satisfied.

    ``http_status`` is a suggestion for a host that exposes the error over HTTP (for example 422 for a
    rejected execution option); the library itself never speaks HTTP.
    """

    def __init__(
        self,
        code: str,
        message: str,
        diagnostics: Iterable[Any] = (),
        *,
        http_status: int | None = None,
    ) -> None:
        super().__init__(code, message, diagnostics)
        self.http_status = http_status

    def as_dict(self) -> dict[str, Any]:
        result = super().as_dict()
        if self.http_status is not None:
            result["httpStatus"] = self.http_status
        return result
