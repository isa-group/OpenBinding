"""Request and response models of ``bim-service/v1`` (they document the contract; the operations return plain JSON).

Every request is closed (unknown members are refused) and strict JSON: a NaN or an infinity anywhere in an
input is a ``request_invalid`` error.  Response models are used for the OpenAPI document only.
"""

from __future__ import annotations

from typing import Annotated, Any, Literal

from bim_core.protocol import contains_non_finite
from pydantic import AfterValidator, BaseModel, ConfigDict, Field, StrictInt


def _finite(value: Any) -> Any:
    if contains_non_finite(value):
        raise ValueError("NaN and infinity are not valid JSON numbers")
    return value


#: Any JSON value, with no NaN or infinity inside.
JsonValue = Annotated[Any, AfterValidator(_finite)]
#: A JSON object, with no NaN or infinity inside.
JsonObject = Annotated[dict[str, Any], AfterValidator(_finite)]


class _Closed(BaseModel):
    model_config = ConfigDict(extra="forbid")


# --- requests --------------------------------------------------------------------------------------


class RegisteredResourceModel(_Closed):
    """An already approved registry revision made available to the compiler (pinned by the instance)."""

    namespace: str = Field(min_length=1, max_length=255)
    name: str = Field(min_length=1, max_length=255)
    version: str = Field(min_length=1, max_length=255)
    digest: str = Field(
        min_length=1,
        max_length=255,
        description="The pin written in the instance: `digest` of the content, or `versionDigest` of the manifest.",
    )
    mediaType: str = Field(min_length=1, max_length=255)
    contentBase64: str = Field(description="The exact bytes of the resource, base64 encoded.")
    versionManifest: JsonObject | None = Field(
        default=None, description="Required when the instance pins a `versionDigest`."
    )


class PackageRequest(_Closed):
    """A `.bim.zip` and the registered resources it pins.  `multipart/form-data` is accepted as well."""

    package: str = Field(description="The `.bim.zip`, base64 encoded.")
    registeredResources: list[RegisteredResourceModel] = Field(default_factory=list)


class CompatibilityRequest(_Closed):
    ir: JsonObject
    manifest: JsonObject = Field(description="The Engine manifest (`kind: Engine`).")
    mode: str | None = Field(default=None, description="Mode id; may be omitted when the manifest has one mode.")
    options: JsonObject | None = Field(default=None, description="Execution options to validate against the mode.")


class OptimizationResolveRequest(_Closed):
    ir: JsonObject
    manifest: JsonObject
    mode: str | None = None
    optimization: JsonValue = Field(description="`{type, scalarization, weights?}`.")


class EvaluateRequest(_Closed):
    ir: JsonObject
    bindings: list[JsonValue] = Field(min_length=1, description="Each binding is `{task: {resource, id}}`.")
    execution: JsonObject | None = None
    onError: Literal["raise", "collect"] = "raise"


class ReevaluateRequest(_Closed):
    ir: JsonObject
    result: JsonObject = Field(description="The engine's answer; none of its numbers is believed.")
    execution: JsonObject | None = None
    allowedTerminations: list[JsonValue] | None = Field(
        default=None, description="Defaults to `[FEASIBLE, UNKNOWN]`."
    )


class ValidateResultRequest(_Closed):
    result: JsonValue


class NeighborhoodRequest(_Closed):
    ir: JsonObject
    binding: JsonValue
    task: str | None = None
    limit: StrictInt = 64
    seconds: float = Field(default=2.0, gt=0)
    execution: JsonObject | None = None


class ResourceValidateRequest(_Closed):
    """One resource document against the schema of the installed Dialect that claims its type."""

    document: JsonObject
    apiVersion: JsonValue = Field(description="With `kind` and `mediaType`, the type the document claims.")
    kind: JsonValue
    mediaType: JsonValue
    resource: str = Field(description="Name that the diagnostics give to the document.")
    dialects: list[JsonObject] | None = Field(
        default=None, description="Restricts the Dialects considered (manifests as `/dialects` returns them)."
    )


class EngineValidateRequest(_Closed):
    document: JsonObject = Field(description="The Engine manifest (`kind: Engine`).")


class XmlResourceRequest(_Closed):
    contentBase64: str = Field(description="The exact bytes of the XML resource, base64 encoded.")


# --- responses (documentation) ---------------------------------------------------------------------


class Problem(BaseModel):
    """`application/problem+json` (RFC 9457) with the BIM extension members."""

    model_config = ConfigDict(extra="allow")

    type: str = Field(description="`urn:bim-toolchain:problem:<code>`")
    title: str
    status: int
    detail: str
    code: str
    errorType: str | None = Field(
        default=None, description="Class of the `bim_core` error this reports; absent for service-level problems."
    )
    diagnostics: list[dict[str, Any]] = Field(default_factory=list)
    httpStatus: int | None = None


class ToolchainBlock(BaseModel):
    name: str
    version: str
    apiVersion: str
    compilerDigest: str


class CompileResponse(BaseModel):
    ir: dict[str, Any]
    irDigest: str
    instanceDigest: str | None
    packageDigest: str
    compilationDigest: str
    inputDigest: str
    sourceMap: dict[str, Any]
    analysis: dict[str, Any] | None
    toolchain: ToolchainBlock


class ValidateResponse(BaseModel):
    valid: bool
    diagnostics: list[dict[str, Any]]
    packageDigest: str
    inputDigest: str
    toolchain: ToolchainBlock
    irDigest: str | None = None
    instanceDigest: str | None = None
    compilationDigest: str | None = None
    sourceMap: dict[str, Any] | None = None
    analysis: dict[str, Any] | None = None


class CompatibilityResponse(BaseModel):
    compatible: bool
    diagnostics: list[dict[str, Any]]
    mode: dict[str, Any]
    options: dict[str, Any]


class OptimizationResolveResponse(BaseModel):
    optimization: dict[str, Any]
    mode: dict[str, Any]


class EvaluateResponse(BaseModel):
    results: list[dict[str, Any]] = Field(description="One `{evaluation}` or `{error}` per binding, in order.")


class ValidateResultResponse(BaseModel):
    valid: bool
    error: dict[str, Any] | None = Field(default=None, description="`{code, message}` of the first violation.")


class DiagnosticsResponse(BaseModel):
    diagnostics: list[dict[str, Any]] = Field(description="Empty when the document is valid.")


class XmlRootResponse(BaseModel):
    namespace: str = Field(description="Empty when the root element has no namespace.")
    localName: str


class XmlValidResponse(BaseModel):
    valid: Literal[True]


class Health(BaseModel):
    status: str
