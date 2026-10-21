"""Return types of the BIM port.

They are ``TypedDict`` s over plain JSON values, with the member names of the wire format (camelCase):
``HttpBim`` returns the decoded response and ``InProcessBim`` returns the same structure after the same JSON
round trip, so ``==`` between the two is meaningful.  Members marked ``NotRequired`` are absent, not ``None``,
when they do not apply.
"""

from __future__ import annotations

from typing import Any, Mapping, NotRequired, TypedDict


class RegisteredResourceSpec(TypedDict):
    """An approved registry revision that the instance pins (input of ``compile`` and ``validate``)."""

    namespace: str
    name: str
    version: str
    #: The pin written in the instance: the ``digest`` of the content, or the ``versionDigest`` of the manifest.
    digest: str
    mediaType: str
    #: The exact bytes of the resource.
    content: bytes
    #: Required when the pin is a ``versionDigest``.
    versionManifest: NotRequired[Mapping[str, Any] | None]


class Toolchain(TypedDict):
    name: str
    version: str
    apiVersion: str
    compilerDigest: str


class Analysis(TypedDict):
    bindingSpaceLog10: float
    #: Decimal string: the cardinality can exceed any float.
    bindingSpaceCardinality: str
    bindingSpaceBreakdown: dict[str, int]
    serviceTasks: int
    candidates: int


class CompileResult(TypedDict):
    ir: dict[str, Any]
    irDigest: str
    instanceDigest: str | None
    packageDigest: str
    compilationDigest: str
    #: Digest of everything the compilation read: the package and the registered resources.
    inputDigest: str
    sourceMap: dict[str, Any]
    analysis: Analysis | None
    toolchain: Toolchain


class ValidationResult(TypedDict):
    valid: bool
    diagnostics: list[dict[str, Any]]
    packageDigest: str
    inputDigest: str
    toolchain: Toolchain
    # Present when `valid` is true (the compilation succeeded):
    irDigest: NotRequired[str]
    instanceDigest: NotRequired[str | None]
    compilationDigest: NotRequired[str]
    sourceMap: NotRequired[dict[str, Any]]
    analysis: NotRequired[Analysis | None]


class ModeContract(TypedDict):
    id: str | None
    terminationGuarantees: list[str]


class CompatibilityResult(TypedDict):
    compatible: bool
    diagnostics: list[dict[str, Any]]
    mode: ModeContract
    #: The options after defaults and validation.
    options: dict[str, Any]


class OptimizationResolution(TypedDict):
    #: ``{type, scalarization, weights}`` with weights normalized to sum to one.
    optimization: dict[str, Any]
    mode: ModeContract


class EvaluationOutcome(TypedDict):
    """One entry of ``evaluate_many``: an ``evaluation`` or, with ``on_error="collect"``, an ``error``."""

    evaluation: NotRequired[dict[str, Any]]
    error: NotRequired[dict[str, Any]]


class ResultValidation(TypedDict):
    valid: bool
    #: ``{code, message}`` of the first violation of ``bim-engine/v1``; ``None`` when valid.
    error: dict[str, Any] | None


class Capabilities(TypedDict):
    apiVersion: str
    #: ``None`` for ``InProcessBim``: there is no service.
    service: dict[str, str] | None
    toolchain: dict[str, Any]
    compilerDigest: str
    protocol: dict[str, str]
    protocolDigest: str
    #: ``{"package": {...bim_core.Limits...}, "service": {...} | None}``.
    limits: dict[str, Any]
    profiles: list[dict[str, Any]]
    dialects: list[dict[str, Any]]
    schemaKinds: list[str]
