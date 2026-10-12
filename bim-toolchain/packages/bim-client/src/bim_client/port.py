"""The BIM port: what a host needs from BIM, independent of where BIM runs.

Both implementations (:class:`bim_client.InProcessBim` and :class:`bim_client.HttpBim`) have exactly these
methods with exactly these signatures, return the same values and raise the same errors:

* the deliberate errors of ``bim_core`` (``PackageError``, ``CompileError``, ``ContractError``,
  ``EvaluationError``, ``ProtocolError``, ...) with their ``code``, message and ``diagnostics``;
* ``ContractError("request_invalid")`` for an input that is not strict JSON (a NaN, an infinity, a value of the
  wrong shape);
* ``HttpBim`` only: :class:`bim_client.errors.BimServiceError` for what is about the service rather than the
  input (authentication, load, size, time, transport).

Inputs are never modified and results never share structure with them.  The IR is passed as the document
(``dict``) that ``compile`` returned; an object with a ``document`` attribute (``BindingProblem``) is accepted too.
"""

from __future__ import annotations

from typing import Any, Mapping, Protocol, Sequence, runtime_checkable

from .types import (
    Capabilities,
    CompatibilityResult,
    CompileResult,
    EvaluationOutcome,
    OptimizationResolution,
    RegisteredResourceSpec,
    ResultValidation,
    ValidationResult,
)


@runtime_checkable
class BimPort(Protocol):
    def capabilities(self) -> Capabilities:
        """Versions, digests, limits and the installed Profiles and Dialects."""
        ...

    def profiles(self) -> list[dict[str, Any]]:
        """Installed Profiles: ``{reference, descriptor, manifest}`` each."""
        ...

    def dialects(self) -> list[dict[str, Any]]:
        """Installed Dialects: ``{reference, descriptor, manifest}`` each."""
        ...

    def schema(self, kind: str) -> dict[str, Any]:
        """The JSON Schema of a document kind (``Instance``, ``BindingProblem``, ...); ``ContractError`` if unknown."""
        ...

    def protocol(self) -> dict[str, Any]:
        """``{id, digest, document}`` of the ``bim-engine/v1`` contract."""
        ...

    def compile(
        self, package: bytes, registered_resources: Sequence[RegisteredResourceSpec] = ()
    ) -> CompileResult:
        """Compile a ``.bim.zip``; ``PackageError`` or ``CompileError`` if it is not a valid package."""
        ...

    def validate(
        self, package: bytes, registered_resources: Sequence[RegisteredResourceSpec] = ()
    ) -> ValidationResult:
        """Like ``compile`` without the IR; compile diagnostics are reported as data (``valid: False``)."""
        ...

    def compatibility(
        self,
        ir: Mapping[str, Any],
        manifest: Mapping[str, Any],
        *,
        mode: str | None = None,
        options: Mapping[str, Any] | None = None,
    ) -> CompatibilityResult:
        """Whether an Engine mode can run the IR; a manifest, mode or option that is refused is a ``ContractError``."""
        ...

    def resolve_optimization(
        self,
        ir: Mapping[str, Any],
        manifest: Mapping[str, Any],
        requested: Any,
        *,
        mode: str | None = None,
    ) -> OptimizationResolution:
        """Validate and canonicalize an execution-time optimization selection against an Engine mode."""
        ...

    def evaluate(
        self, ir: Mapping[str, Any], binding: Mapping[str, Any], execution: Mapping[str, Any] | None = None
    ) -> dict[str, Any]:
        """The canonical evaluation of one binding; ``EvaluationError`` if it is invalid."""
        ...

    def evaluate_many(
        self,
        ir: Mapping[str, Any],
        bindings: Sequence[Mapping[str, Any]],
        execution: Mapping[str, Any] | None = None,
        *,
        on_error: str = "raise",
    ) -> list[EvaluationOutcome]:
        """Evaluate each binding; ``on_error="collect"`` keeps one entry per binding instead of raising the first error."""
        ...

    def reevaluate(
        self,
        ir: Mapping[str, Any],
        result: Mapping[str, Any],
        execution: Mapping[str, Any] | None = None,
        allowed_terminations: Sequence[str] | None = None,
    ) -> dict[str, Any]:
        """The authoritative result for an engine's answer: ``{termination, solutions, provenance}``."""
        ...

    def validate_result(self, payload: Any) -> ResultValidation:
        """Whether ``payload`` has the shape of a ``bim-engine/v1`` result (and only that)."""
        ...

    def neighborhood(
        self,
        ir: Mapping[str, Any],
        binding: Mapping[str, Any],
        *,
        task: str | None = None,
        limit: int = 64,
        seconds: float = 2.0,
        execution: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Evaluate up to ``limit`` one-task alternatives of ``binding``."""
        ...

    def close(self) -> None:
        """Release what the implementation holds (connections); calling it twice is fine."""
        ...
