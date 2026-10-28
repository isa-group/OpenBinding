"""The Engine registry: what the platform does when an Engine or a deployment of one is registered.

``routes.v1`` authenticates the caller, reads and parses the body and turns the outcome into a response;
everything between those is here, with explicit inputs and outputs:

* a refusal is a ``RegistryProblem`` (status, code, detail, diagnostics) and never a response object;
* the process settings, the endpoint validator and the transport that reaches a deployment are arguments,
  so the HTTP layer decides which ones to hand over (the tests replace them there) and a test can hand over its own;
* a credential is encrypted with ``security.secrets.CredentialStore`` (``MultiFernet``) on the way in, decrypted
  only to talk to the deployment, and never part of a document, a summary, a report or a message.

Whether a mode can run an IR is the toolchain's (``services.engines`` asks it through the port); what is
here is the platform's: the destination policy (HTTPS, no private, loopback or link-local address, no
redirects), the immutable revisions, the publication lifecycle and the conformance check of a deployment.
"""

from __future__ import annotations

import copy
import logging
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import timedelta
from functools import partial
from typing import Any, Mapping

from bim_core.canonical import digest
from fastapi import HTTPException
from sqlalchemy import delete, func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from ..core import revision as core_revision
from ..core.settings import Settings
from ..models.problem import split_detail
from ..db.models import (
    EngineCredential,
    EngineRegistrationRevision,
    EngineRevision,
    ManifestPublication,
    Notification,
    User,
    UserRole,
    utcnow,
)
from ..integrations.bim_host import engine_contract_diagnostics
from ..security.apikeys import allows_engine
from ..security.secrets import CredentialStore, SecretsUnavailable
from ..v1.remote import (
    RemoteEngineError,
    RemoteRegistration,
    avalidate_endpoint,
    fetch_remote_document,
    solve_remote,
    validate_endpoint,
)
from .engines import (
    embedded_secret_paths,
    engine_document_for_registration,
    manifest_async,
    protocol_digest,
    protocol_document,
    registration_engine_reference,
    registration_summary,
    schema_diagnostics,
    validate_engine_result,
)
from .probe import probe_ir

logger = logging.getLogger(__name__)

_ACCOUNTS_REQUIRED = "Engine registrations require the accounts database"
_NOT_FOUND = "Engine registration not found"


class RegistryProblem(Exception):
    """A refusal the HTTP layer renders as ``application/problem+json``."""

    def __init__(
        self,
        status: int,
        code: str,
        detail: str,
        diagnostics: list[dict[str, Any]] | None = None,
        extra: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
    ) -> None:
        super().__init__(detail)
        #: Response headers of the refusal (the current ``ETag`` of a 412).
        self.headers = headers
        self.status = status
        self.code = code
        self.detail = detail
        self.diagnostics = diagnostics
        #: Members added to the problem document beside the code (a ``quota``, for instance).
        self.extra = extra


@dataclass(frozen=True)
class RegistrationKey:
    """The identity of one registration revision, as the routes carry it in the query string."""

    namespace: str
    name: str
    version: str
    manifest_digest: str


#: ``(document, credential, engine manifest) -> (report, served OpenAPI, its digest)``: how a deployment is checked.
RegistrationVerifier = Callable[
    [dict[str, Any], str | None, Mapping[str, Any]],
    Awaitable[tuple[dict[str, Any], dict[str, Any] | None, str | None]],
]

_SCHEMA_ANNOTATIONS = frozenset({"title", "description", "$comment", "examples", "deprecated", "readOnly", "writeOnly"})
_BINDING_PROBLEM_SCHEMA_REF = "./bim/v1/binding-problem.schema.json"


# -- Conformance of a deployment ------------------------------------------------------------------


def pointer(document: dict[str, Any], reference: str) -> Any:
    if not reference.startswith("#/"):
        raise RemoteEngineError(f"deployment OpenAPI uses a non-local schema reference: {reference}")
    value: Any = document
    for raw in reference[2:].split("/"):
        token = raw.replace("~1", "/").replace("~0", "~")
        if not isinstance(value, dict) or token not in value:
            raise RemoteEngineError(f"deployment OpenAPI has an unresolved schema reference: {reference}")
        value = value[token]
    return value


def schema_semantics(document: dict[str, Any], value: Any, trail: tuple[str, ...] = ()) -> Any:
    """Dereference a bounded OpenAPI schema into a comparable closed form."""
    if isinstance(value, list):
        return [schema_semantics(document, item, trail) for item in value]
    if not isinstance(value, dict):
        return value
    reference = value.get("$ref")
    if isinstance(reference, str):
        siblings = set(value) - {"$ref"} - _SCHEMA_ANNOTATIONS
        if siblings:
            raise RemoteEngineError("deployment OpenAPI schema references cannot have semantic siblings")
        if reference == _BINDING_PROBLEM_SCHEMA_REF:
            return {"$ref": "bim-binding-problem/v1"}
        if not reference.startswith("#/"):
            raise RemoteEngineError(f"deployment OpenAPI uses an unapproved schema reference: {reference}")
        if reference in trail:
            raise RemoteEngineError(f"deployment OpenAPI contains a recursive schema reference: {reference}")
        return schema_semantics(document, pointer(document, reference), (*trail, reference))
    return {
        key: schema_semantics(document, child, trail)
        for key, child in value.items()
        if key not in _SCHEMA_ANNOTATIONS
    }


def operation_schema(operation: Any, *, request: bool = False, response: str | None = None) -> dict[str, Any]:
    try:
        if request:
            schema = operation["requestBody"]["content"]["application/json"]["schema"]
        else:
            schema = operation["responses"][response]["content"]["application/json"]["schema"]
    except (KeyError, TypeError) as exc:
        location = "request" if request else f"response {response}"
        raise RemoteEngineError(f"deployment OpenAPI is missing the application/json {location} schema") from exc
    if not isinstance(schema, dict):
        raise RemoteEngineError("deployment OpenAPI operation schema must be an object")
    return schema


def assert_operation_auth(
    document: Mapping[str, Any],
    operation: Mapping[str, Any],
    expected: str,
    label: str,
) -> None:
    """Ensure the submitted OpenAPI matches the registration transport auth."""

    security = operation.get("security", document.get("security", []))
    if not isinstance(security, list):
        raise RemoteEngineError(f"deployment OpenAPI {label} security must be an array")
    if any(not isinstance(requirement, Mapping) for requirement in security):
        raise RemoteEngineError(
            f"deployment OpenAPI {label} security requirements must be objects"
        )
    if expected == "none":
        if security and not any(not requirement for requirement in security):
            raise RemoteEngineError(
                f"deployment OpenAPI {label} requires authentication but registration auth is none"
            )
        return

    if not security or any(not requirement for requirement in security):
        raise RemoteEngineError(
            f"deployment OpenAPI {label} permits anonymous access but registration auth is {expected}"
        )

    schemes = document.get("components", {}).get("securitySchemes", {})
    if not isinstance(schemes, Mapping):
        raise RemoteEngineError("deployment OpenAPI has no securitySchemes object")
    matching_names = {
        name
        for name, declaration in schemes.items()
        if isinstance(name, str)
        and isinstance(declaration, Mapping)
        and declaration.get("type") == "http"
        and str(declaration.get("scheme", "")).casefold() == expected
    }
    if not any(
        isinstance(requirement, Mapping)
        and len(requirement) == 1
        and next(iter(requirement), None) in matching_names
        for requirement in security
    ):
        raise RemoteEngineError(
            f"deployment OpenAPI {label} does not offer the registered {expected} authentication"
        )


def assert_protocol_schema(
    label: str,
    deployed_document: dict[str, Any],
    deployed_schema: dict[str, Any],
    canonical_document: dict[str, Any],
    canonical_schema: dict[str, Any],
) -> None:
    deployed = schema_semantics(deployed_document, deployed_schema)
    canonical = schema_semantics(canonical_document, canonical_schema)
    if digest(deployed) != digest(canonical):
        raise RemoteEngineError(f"deployment OpenAPI {label} schema is not equivalent to bim-engine/v1")


def conformance_shape(mode: Mapping[str, Any]) -> tuple[str, str, int]:
    scalarizations = mode.get("capabilities", {}).get("scalarizations", {})
    descriptors = scalarizations.get("values", []) if isinstance(scalarizations, Mapping) else []
    limits = mode.get("limits", {})
    minimum = limits.get("minObjectives", 0) if isinstance(limits, Mapping) else 0
    maximum = limits.get("maxObjectives") if isinstance(limits, Mapping) else None
    minimum = minimum if isinstance(minimum, int) else 0
    maximum = maximum if isinstance(maximum, int) else None
    for descriptor in descriptors:
        if not isinstance(descriptor, Mapping):
            continue
        scalarization = descriptor.get("id")
        for objective_type in descriptor.get("objectiveTypes", []):
            if not isinstance(scalarization, str) or objective_type not in {"SINGLE", "MULTI", "MANY"}:
                continue
            if scalarization == "feasibility" and objective_type == "SINGLE" and minimum == 0:
                return scalarization, objective_type, 0
            objective_count = max(minimum, {"SINGLE": 1, "MULTI": 2, "MANY": 3}[objective_type])
            if objective_type == "MULTI" and objective_count > 3:
                continue
            if maximum is not None and objective_count > maximum:
                continue
            return scalarization, objective_type, objective_count
    raise RemoteEngineError("Engine has no mode shape suitable for a deterministic conformance probe")


def conformance_mode(engine: Mapping[str, Any]) -> Mapping[str, Any]:
    modes = engine.get("spec", {}).get("modes", [])
    for mode in modes if isinstance(modes, list) else []:
        if not isinstance(mode, Mapping):
            continue
        try:
            conformance_shape(mode)
            return mode
        except RemoteEngineError:
            continue
    raise RemoteEngineError("Engine has no published mode suitable for a deterministic conformance probe")


def conformance_options(mode: Mapping[str, Any]) -> dict[str, Any]:
    properties = mode.get("optionsSchema", {}).get("properties", {})
    if not isinstance(properties, Mapping):
        return {}
    return {
        name: copy.deepcopy(option["default"])
        for name, option in properties.items()
        if isinstance(name, str) and isinstance(option, Mapping) and "default" in option
    }


def conformance_optimization(mode: Mapping[str, Any]) -> dict[str, Any]:
    _, objective_type, objective_count = conformance_shape(mode)
    scalarization, _, _ = conformance_shape(mode)
    return {
        "type": objective_type,
        "scalarization": scalarization,
        "weights": [
            {"criteria": f"probe-objective-{index + 1}", "value": 1.0 / objective_count}
            for index in range(objective_count)
        ],
    }


#: ``spec.extensions`` key under which a deployment declares that it can stop a job (open by schema:
#: ``bim-engine/v1`` has no cancellation operation and the registration schema's ``mappings`` is closed).
CANCELLATION_EXTENSION = "cancellation"

#: ``idScope`` that says the engine does not deduplicate by ``X-Openbinding-Job-Id`` (the id of the gateway's
#: job, the same in every attempt), so the id it hands out is per attempt and cancelling one attempt cannot
#: reach another.
ATTEMPT_ID_SCOPE = "attempt"


@dataclass(frozen=True)
class CancellationCapability:
    """What a registration promises about stopping a remote job, and whether the gateway may rely on it.

    ``supported`` is true only for a declaration (``extensions.cancellation = {"supported": true,
    "idScope": "attempt"}``) whose deployment OpenAPI also describes ``DELETE`` on the mapped job path with
    a 2xx response and the registered authentication. A declaration the OpenAPI does not back is off:
    ``declared`` stays true and ``reason`` says why, so it can be logged and shown in the report; the
    registration itself is not changed.
    """

    declared: bool = False
    supported: bool = False
    id_scope: str | None = None
    reason: str | None = None

    @property
    def per_attempt(self) -> bool:
        return self.supported and self.id_scope == ATTEMPT_ID_SCOPE


def cancellation_capability(spec: Any, openapi_document: Any) -> CancellationCapability:
    """The cancellation capability of a registration ``spec`` against its pinned OpenAPI document."""
    extensions = spec.get("extensions") if isinstance(spec, Mapping) else None
    declaration = extensions.get(CANCELLATION_EXTENSION) if isinstance(extensions, Mapping) else None
    if not isinstance(declaration, Mapping) or declaration.get("supported") is not True:
        return CancellationCapability()
    scope = declaration.get("idScope")
    scope = scope if isinstance(scope, str) else None
    mappings = spec.get("mappings") if isinstance(spec.get("mappings"), Mapping) else {}
    job_path = mappings.get("job", "/internal/v1/jobs/{id}")
    paths = openapi_document.get("paths") if isinstance(openapi_document, Mapping) else None
    path_item = paths.get(job_path) if isinstance(paths, Mapping) else None
    operation = path_item.get("delete") if isinstance(path_item, Mapping) else None
    reason = None
    if not isinstance(operation, Mapping):
        reason = "the deployment OpenAPI does not describe DELETE on the mapped job path"
    else:
        responses = operation.get("responses")
        if not isinstance(responses, Mapping) or not any(str(code).startswith("2") for code in responses):
            reason = "the deployment OpenAPI does not describe a 2xx response of DELETE on the mapped job path"
        else:
            auth = spec.get("auth")
            try:
                assert_operation_auth(
                    openapi_document,
                    operation,
                    auth.get("scheme", "none") if isinstance(auth, Mapping) else "none",
                    "cancellation operation",
                )
            except RemoteEngineError as exc:
                reason = str(exc)
    if reason is not None:
        return CancellationCapability(declared=True, supported=False, id_scope=scope, reason=reason)
    return CancellationCapability(declared=True, supported=True, id_scope=scope)


async def verify_registration(
    document: dict[str, Any],
    credential: str | None,
    engine: Mapping[str, Any],
    *,
    settings: Settings,
    fetch: Callable[..., Awaitable[dict[str, Any]]] = fetch_remote_document,
    solve: Callable[..., Awaitable[dict[str, Any]]] = solve_remote,
) -> tuple[dict[str, Any], dict[str, Any] | None, str | None]:
    """Fetch the pinned OpenAPI and execute a deterministic response probe.

    A deployment that is down, slow, redirects or answers something else is a ``failed`` report with
    the reason in its checks, never an exception.  ``fetch`` and ``solve`` are the transport.
    """

    spec = document["spec"]
    transport = RemoteRegistration(
        endpoint=spec["endpoint"],
        mappings=spec.get("mappings", {}),
        auth_scheme=spec.get("auth", {}).get("scheme", "none"),
        credential=credential,
        allow_internal_http=not settings.federation_require_https,
    )
    expected_digest = spec["protocol"]["digest"]
    checks: list[dict[str, Any]] = []
    submitted_openapi = spec.get("openapi")
    openapi_document: dict[str, Any] | None = (
        submitted_openapi if isinstance(submitted_openapi, dict) else None
    )
    openapi_digest: str | None = (
        digest(openapi_document) if openapi_document is not None else None
    )
    started = time.monotonic()
    try:
        openapi_path = spec.get("mappings", {}).get("openapi", "/openapi.json")
        if openapi_document is None:
            raise RemoteEngineError("registration must include the deployment OpenAPI document")
        live_openapi = await fetch(transport, openapi_path)
        if digest(live_openapi) != openapi_digest:
            raise RemoteEngineError(
                "served OpenAPI differs from the immutable document submitted for review"
            )
        if openapi_document.get("openapi") != "3.1.0":
            raise RemoteEngineError("served OpenAPI must declare version 3.1.0")
        if openapi_document.get("x-bim-protocol") != "bim-engine/v1":
            raise RemoteEngineError("deployment OpenAPI must declare x-bim-protocol: bim-engine/v1")
        if openapi_document.get("x-bim-protocol-digest") != expected_digest:
            raise RemoteEngineError("deployment OpenAPI does not pin the canonical bim-engine/v1 digest")

        canonical_document = protocol_document()
        if expected_digest != protocol_digest():
            raise RemoteEngineError("registration does not pin the installed bim-engine/v1 contract")
        request_path = spec.get("mappings", {}).get("request", "/internal/v1/binding-problems")
        operation = openapi_document.get("paths", {}).get(request_path, {}).get("post")
        if not isinstance(operation, dict):
            raise RemoteEngineError("deployment OpenAPI does not describe the mapped solve operation")
        assert_operation_auth(
            openapi_document,
            operation,
            spec.get("auth", {}).get("scheme", "none"),
            "solve operation",
        )
        canonical_operation = canonical_document["paths"]["/internal/v1/binding-problems"]["post"]
        assert_protocol_schema(
            "solve request",
            openapi_document,
            operation_schema(operation, request=True),
            canonical_document,
            operation_schema(canonical_operation, request=True),
        )
        responses = operation.get("responses", {})
        if not isinstance(responses, dict) or not ({"200", "202"} & set(responses)):
            raise RemoteEngineError("deployment OpenAPI does not describe a synchronous or asynchronous result")
        response_modes: list[str] = []
        if "200" in responses:
            assert_protocol_schema(
                "synchronous result",
                openapi_document,
                operation_schema(operation, response="200"),
                canonical_document,
                operation_schema(canonical_operation, response="200"),
            )
            response_modes.append("synchronous")
        if "202" in responses:
            assert_protocol_schema(
                "asynchronous receipt",
                openapi_document,
                operation_schema(operation, response="202"),
                canonical_document,
                operation_schema(canonical_operation, response="202"),
            )
            job_path = spec.get("mappings", {}).get("job")
            if not isinstance(job_path, str) or "{id}" not in job_path:
                raise RemoteEngineError("an asynchronous deployment requires a mapped job path containing {id}")
            job_operation = openapi_document.get("paths", {}).get(job_path, {}).get("get")
            if not isinstance(job_operation, dict):
                raise RemoteEngineError("deployment OpenAPI does not describe the mapped async job operation")
            assert_operation_auth(
                openapi_document,
                job_operation,
                spec.get("auth", {}).get("scheme", "none"),
                "asynchronous job operation",
            )
            canonical_job = canonical_document["paths"]["/internal/v1/jobs/{id}"]["get"]
            assert_protocol_schema(
                "asynchronous job",
                openapi_document,
                operation_schema(job_operation, response="200"),
                canonical_document,
                operation_schema(canonical_job, response="200"),
            )
            response_modes.append("asynchronous")
        checks.append(
            {
                "id": "openapi",
                "status": "passed",
                "deploymentDigest": openapi_digest,
                "protocolDigest": expected_digest,
                "requestPath": request_path,
                "responseModes": response_modes,
            }
        )

        health_path = spec.get("mappings", {}).get("health", "/health")
        health_operation = openapi_document.get("paths", {}).get(health_path, {}).get("get")
        if not isinstance(health_operation, dict) or "200" not in health_operation.get("responses", {}):
            raise RemoteEngineError(
                "deployment OpenAPI must describe the mapped GET health operation and its 200 response"
            )
        assert_operation_auth(
            openapi_document,
            health_operation,
            spec.get("auth", {}).get("scheme", "none"),
            "health operation",
        )
        await fetch(transport, health_path)
        checks.append({"id": "health", "status": "passed"})

        capability = cancellation_capability(spec, openapi_document)
        if capability.declared:
            # Informational: a declaration the OpenAPI does not back turns the capability off, it does not
            # fail the registration.
            if capability.supported:
                checks.append({"id": "cancellation", "status": "passed", "idScope": capability.id_scope})
            else:
                logger.warning(
                    "Registration %s/%s declares cancellation but it is off: %s",
                    document.get("metadata", {}).get("namespace"),
                    document.get("metadata", {}).get("name"),
                    capability.reason,
                )
                checks.append({"id": "cancellation", "status": "disabled", "message": capability.reason})

        probe_mode = conformance_mode(engine)
        result = await solve(
            transport,
            await probe_ir(conformance_shape(probe_mode)[2]),
            conformance_options(probe_mode),
            conformance_optimization(probe_mode),
            timeout_s=10.0,
            validate_result=validate_engine_result,
        )
        expected_binding = {"probe-task": {"resource": "probe-catalog", "id": "probe-candidate"}}
        bindings = [
            item.get("decision", {}).get("binding")
            for item in result.get("solutions", [])
            if isinstance(item, dict)
        ]
        if result.get("termination") not in {"OPTIMAL", "FEASIBLE"} or expected_binding not in bindings:
            raise RemoteEngineError("engine did not solve the deterministic conformance problem")
        checks.append({"id": "binding-result", "status": "passed", "termination": result["termination"]})
    except (RemoteEngineError, KeyError, TypeError, ValueError) as exc:
        checks.append({"id": "conformance", "status": "failed", "message": str(exc)})
        return (
            {
                "protocol": "bim-engine/v1",
                "protocolDigest": expected_digest,
                "status": "failed",
                "checks": checks,
                "durationMs": round((time.monotonic() - started) * 1000, 3),
            },
            openapi_document,
            openapi_digest,
        )
    return (
        {
            "protocol": "bim-engine/v1",
            "protocolDigest": expected_digest,
            "status": "verified",
            "checks": checks,
            "durationMs": round((time.monotonic() - started) * 1000, 3),
        },
        openapi_document,
        openapi_digest,
    )


# -- Engine revisions -----------------------------------------------------------------------------


async def create_engine_revision(
    document: Any,
    caller: User,
    session: AsyncSession | None,
) -> dict[str, Any]:
    """Store a new private Engine revision, or answer the identical one that is already stored."""
    diagnostics = (
        schema_diagnostics(document, "Engine")
        if isinstance(document, dict)
        else [{"code": "document", "message": "Engine must be an object"}]
    )
    if isinstance(document, Mapping):
        diagnostics.extend(engine_contract_diagnostics(document))
    if diagnostics:
        raise RegistryProblem(422, "invalid_engine", "Engine manifest does not satisfy bim/v1", diagnostics)
    name = document["metadata"]["name"]
    version = document["metadata"].get("version", "1.0.0")
    revision_digest = digest(document)
    target_reference = {
        "namespace": document["metadata"]["namespace"],
        "name": name,
        "version": version,
        "digest": revision_digest,
    }
    if not allows_engine(caller, target_reference):
        raise RegistryProblem(
            403,
            "engine_not_granted",
            "This API key does not grant this exact Engine revision; use an all-Engines key to create new revisions",
        )
    if session is None:
        raise RegistryProblem(503, "accounts_unavailable", "Registering an Engine requires the accounts database")
    namespace = document["metadata"]["namespace"]
    if namespace != caller.username:
        raise RegistryProblem(403, "forbidden", "Engine namespace must match the caller")
    existing = (
        await session.execute(
            select(EngineRevision).where(
                EngineRevision.namespace == namespace,
                EngineRevision.name == name,
                EngineRevision.version == version,
            )
        )
    ).scalars().first()
    if existing is not None:
        if existing.digest != revision_digest:
            raise RegistryProblem(409, "immutable_engine", "Engine revisions are immutable; create a new version")
        return {"namespace": namespace, "name": name, "version": version, "digest": existing.digest, "status": existing.state}
    row = EngineRevision(
        owner_id=caller.id,
        namespace=namespace,
        name=name,
        version=version,
        digest=revision_digest,
        document=document,
        state="private",
    )
    try:
        async with session.begin_nested():
            session.add(row)
            await session.flush()
    except IntegrityError:
        raise RegistryProblem(409, "immutable_engine", "Engine identity already exists with different content") from None
    return {"namespace": namespace, "name": name, "version": version, "digest": revision_digest, "status": "private"}


# -- Registrations: create and read ---------------------------------------------------------------


async def _registration_at(
    session: AsyncSession, namespace: str, name: str, version: str
) -> EngineRegistrationRevision | None:
    """The stored registration of this identity, whatever its content."""
    return (
        await session.execute(
            select(EngineRegistrationRevision).where(
                EngineRegistrationRevision.namespace == namespace,
                EngineRegistrationRevision.name == name,
                EngineRegistrationRevision.version == version,
            )
        )
    ).scalars().first()


async def register_engine(
    document: Any,
    caller: User,
    session: AsyncSession | None,
    *,
    settings: Settings,
    validate: Callable[..., tuple[str, ...]] = validate_endpoint,
) -> dict[str, Any]:
    """Store a new private, inactive registration (a deployment of an Engine revision), idempotently.

    The destination is checked here, before anything is stored: HTTPS (or trusted internal HTTP when the
    deployment allows it), no userinfo, and every address the name resolves to in the permitted network
    class (``validate`` is ``v1.remote.validate_endpoint``, run off the event loop).  Nothing is fetched from
    the endpoint yet; that is the verification at activation.
    """
    diagnostics = (
        schema_diagnostics(document, "EngineRegistration")
        if isinstance(document, dict)
        else [{"code": "document", "message": "EngineRegistration must be an object"}]
    )
    if diagnostics:
        raise RegistryProblem(422, "invalid_registration", "registration must satisfy bim/v1", diagnostics)
    spec = document.get("spec", {})
    endpoint = spec.get("endpoint")
    if not isinstance(endpoint, str):
        raise RegistryProblem(422, "invalid_registration", "registration endpoint must be a URI")
    try:
        await avalidate_endpoint(
            endpoint, allow_internal_http=not settings.federation_require_https, validate=validate
        )
    except RemoteEngineError as exc:
        raise RegistryProblem(422, "invalid_registration", str(exc)) from None
    secret_paths = embedded_secret_paths(document)
    if secret_paths:
        raise RegistryProblem(
            422,
            "secret_in_document",
            "credentials must be supplied through the secret store",
            [{"code": "secret_in_document", "pointer": path, "message": "secret-like field is forbidden"} for path in secret_paths],
        )
    if spec.get("auth", {}).get("scheme") == "mtls":
        raise RegistryProblem(
            422,
            "unsupported_auth",
            "mTLS needs a versioned certificate-bundle credential contract and is not available in BIM v1",
        )
    name = document.get("metadata", {}).get("name")
    if not isinstance(name, str) or not name:
        raise RegistryProblem(422, "invalid_registration", "metadata.name is required")
    namespace = document["metadata"]["namespace"]
    if namespace != caller.username:
        raise RegistryProblem(403, "forbidden", "EngineRegistration namespace must match the caller")
    version = document["metadata"]["version"]
    revision = digest(document)
    submitted_digest = spec.get("protocol", {}).get("digest")
    protocol_id = spec.get("protocol", {}).get("id", "bim-engine/v1")
    if protocol_id != "bim-engine/v1":
        raise RegistryProblem(409, "protocol_mismatch", "registration must use bim-engine/v1")
    if submitted_digest != protocol_digest():
        raise RegistryProblem(409, "protocol_digest_mismatch", "registration must pin the exact bim-engine/v1 OpenAPI digest")
    submitted_openapi = spec.get("openapi")
    if (
        not isinstance(submitted_openapi, dict)
        or submitted_openapi.get("x-bim-protocol-digest") != submitted_digest
    ):
        raise RegistryProblem(
            409,
            "openapi_protocol_mismatch",
            "submitted OpenAPI must pin the same bim-engine/v1 digest as the registration",
        )
    engine_reference = spec.get("engine", {})
    engine_name = engine_reference.get("name") if isinstance(engine_reference, dict) else None
    if not allows_engine(caller, engine_reference if isinstance(engine_reference, Mapping) else {}):
        raise RegistryProblem(404, "not_found", "Engine revision not found")
    try:
        engine_document = await manifest_async(
            engine_name,
            session,
            caller=caller,
            namespace=engine_reference.get("namespace"),
            version=engine_reference.get("version"),
            manifest_digest=engine_reference.get("digest"),
        )
    except HTTPException:
        raise RegistryProblem(422, "unknown_engine", "registration references an unknown Engine revision") from None
    if digest(engine_document) != engine_reference.get("digest"):
        raise RegistryProblem(409, "engine_digest_mismatch", "registration must pin the exact Engine revision digest")
    if session is None:
        raise RegistryProblem(503, "accounts_unavailable", "Registering an engine requires the accounts database")
    existing = await _registration_at(session, namespace, name, version)
    if existing is not None:
        if existing.manifest_digest != revision:
            raise RegistryProblem(409, "immutable_registration", "Registration revisions are immutable; use a new version")
        return registration_summary(existing)
    registration = EngineRegistrationRevision(
        owner_id=caller.id,
        namespace=namespace,
        name=name,
        version=version,
        manifest_digest=revision,
        engine_digest=engine_reference["digest"],
        document=document,
        endpoint=endpoint,
        protocol_digest=submitted_digest,
        openapi_document=submitted_openapi,
        openapi_digest=digest(submitted_openapi),
        mappings=spec.get("mappings", {}),
        auth_scheme=spec.get("auth", {}).get("scheme", "none"),
        verification_report={"protocol": "bim-engine/v1", "protocolDigest": submitted_digest, "status": "pending", "checks": []},
        publication_status="private",
        is_active=False,
    )
    try:
        async with session.begin_nested():
            session.add(registration)
            await session.flush()
    except IntegrityError:
        # A concurrent request stored the identity between the lookup and the insert. If what it stored is this
        # same document, this request is its repetition and gets the registration; only different content conflicts.
        existing = await _registration_at(session, namespace, name, version)
        if existing is not None and existing.manifest_digest == revision:
            return registration_summary(existing)
        raise RegistryProblem(409, "immutable_registration", "Registration identity already exists with different content") from None
    return registration_summary(registration)


async def list_registrations(
    caller: User,
    session: AsyncSession | None,
    *,
    review: bool = False,
) -> dict[str, Any]:
    """The registrations the caller may see (their own and the published ones), or the publication requests."""
    if session is None:
        raise RegistryProblem(503, "accounts_unavailable", _ACCOUNTS_REQUIRED)
    if review:
        if not caller.is_admin:
            raise RegistryProblem(403, "forbidden", "Only an administrator may read publication requests")
        query = select(EngineRegistrationRevision).where(
            EngineRegistrationRevision.publication_status == "pending_review"
        )
    else:
        query = select(EngineRegistrationRevision).where(
            or_(
                EngineRegistrationRevision.owner_id == caller.id,
                EngineRegistrationRevision.publication_status == "published",
            )
        )
    rows = (
        await session.execute(
            query.order_by(
                EngineRegistrationRevision.namespace,
                EngineRegistrationRevision.name,
                EngineRegistrationRevision.version,
            )
        )
    ).scalars().all()
    return {
        "registrations": [
            registration_summary(row)
            for row in rows
            if allows_engine(caller, registration_engine_reference(row) or {})
        ]
    }


async def _readable_registration(
    key: RegistrationKey,
    caller: User,
    session: AsyncSession,
) -> EngineRegistrationRevision:
    """The registration the caller may read (own, published, or pending review for an administrator)."""
    query = select(EngineRegistrationRevision).where(
        EngineRegistrationRevision.namespace == key.namespace,
        EngineRegistrationRevision.name == key.name,
        EngineRegistrationRevision.version == key.version,
        EngineRegistrationRevision.manifest_digest == key.manifest_digest,
    )
    visible = [
        EngineRegistrationRevision.owner_id == caller.id,
        EngineRegistrationRevision.publication_status == "published",
    ]
    if caller.is_admin:
        visible.append(EngineRegistrationRevision.publication_status == "pending_review")
    row = (await session.execute(query.where(or_(*visible)))).scalars().first()
    if row is None or not allows_engine(caller, registration_engine_reference(row) or {}):
        raise RegistryProblem(404, "not_found", _NOT_FOUND)
    return row


async def read_registration(
    key: RegistrationKey,
    caller: User,
    session: AsyncSession | None,
) -> dict[str, Any]:
    """The registration document, exactly as it was submitted (it never holds a credential)."""
    if session is None:
        raise RegistryProblem(503, "accounts_unavailable", _ACCOUNTS_REQUIRED)
    return (await _readable_registration(key, caller, session)).document


async def registration_report(
    key: RegistrationKey,
    caller: User,
    session: AsyncSession | None,
) -> dict[str, Any]:
    """The summary, the served OpenAPI, the pinned Engine and the last verification report."""
    if session is None:
        raise RegistryProblem(503, "accounts_unavailable", _ACCOUNTS_REQUIRED)
    row = await _readable_registration(key, caller, session)
    try:
        engine_document = await engine_document_for_registration(row, session)
    except HTTPException:
        engine_document = None
    return {
        **registration_summary(row),
        "openapiDigest": row.openapi_digest,
        "openapi": row.openapi_document,
        "engine": engine_document,
        "report": row.verification_report,
    }


# -- Registrations: state changes -----------------------------------------------------------------


async def _verify_registration_row(
    registration: EngineRegistrationRevision,
    session: AsyncSession,
    *,
    settings: Settings,
    verify: RegistrationVerifier,
) -> None:
    """Check the deployment now and record the report; ``RegistryProblem`` if it is not what was registered."""
    if registration.protocol_digest != protocol_digest():
        raise RegistryProblem(
            409,
            "protocol_digest_mismatch",
            "Registration protocol is no longer the pinned bim-engine/v1 contract",
        )
    try:
        engine_document = await engine_document_for_registration(registration, session)
    except HTTPException:
        raise RegistryProblem(409, "engine_revision_unavailable", "Registration Engine revision is unavailable") from None

    credential_value = None
    credential_row = (
        await session.execute(
            select(EngineCredential).where(EngineCredential.registration_id == registration.id)
        )
    ).scalars().first()
    if credential_row is not None:
        try:
            credential_value = CredentialStore.from_settings(settings).decrypt(
                credential_row.credential_encrypted
            )
        except SecretsUnavailable as exc:
            raise RegistryProblem(503, "credential_store_unavailable", str(exc)) from None

    report, openapi_document, openapi_digest = await verify(
        registration.document,
        credential_value,
        engine_document,
    )
    registration.verification_report = report
    registration.openapi_document = openapi_document
    registration.openapi_digest = openapi_digest
    if report["status"] != "verified":
        registration.is_active = False
        await session.flush()
        raise RegistryProblem(
            409,
            "conformance_failed",
            "Engine registration failed its OpenAPI and response-contract checks",
            report["checks"],
        )
    registration.verified_at = utcnow()
    registration.verification_report = {
        **report,
        "verifiedAt": registration.verified_at.isoformat(),
    }


async def _notify_admins(
    session: AsyncSession,
    kind: str,
    subject: str,
    body: str,
    payload: dict[str, Any],
) -> None:
    admins = (
        await session.execute(
            select(User).where(User.role == UserRole.ADMIN, User.is_active.is_(True))
        )
    ).scalars().all()
    for admin in admins:
        session.add(
            Notification(
                user_id=admin.id,
                kind=kind,
                subject=subject,
                body=body,
                payload=payload,
            )
        )


def _event_payload(registration: EngineRegistrationRevision, caller: User) -> dict[str, Any]:
    return {
        "namespace": registration.namespace,
        "name": registration.name,
        "version": registration.version,
        "digest": registration.manifest_digest,
        "actor": caller.username,
    }


async def change_registration(
    key: RegistrationKey,
    caller: User,
    session: AsyncSession | None,
    *,
    action: str,
    settings: Settings,
    verify: RegistrationVerifier | None = None,
    max_active: float | None = None,
) -> dict[str, Any]:
    """``activate``, ``deactivate``, ``request_publication`` (owner) or ``approve``, ``reject`` (administrator).

    Activating, requesting publication and approving verify the deployment first (``verify``, by default
    ``verify_registration`` with the process transport); a failed check leaves the registration inactive.

    ``max_active`` is the plan's ``federatedEngines``: activating an inactive registration of an owner who
    already has that many active ones is refused with 402 before anything is verified. It counts rows (the
    registrations that exist and are active now), like the other structure limits; ``None`` sets no limit,
    and activating a registration that is active already is not a second one.
    """
    if session is None:
        raise RegistryProblem(503, "accounts_unavailable", _ACCOUNTS_REQUIRED)
    verifier = verify or partial(verify_registration, settings=settings)
    admin_action = action in {"approve", "reject"}
    if admin_action and not caller.is_admin:
        raise RegistryProblem(403, "forbidden", "Only an administrator may review publication requests")
    query = select(EngineRegistrationRevision).where(
        EngineRegistrationRevision.namespace == key.namespace,
        EngineRegistrationRevision.name == key.name,
        EngineRegistrationRevision.version == key.version,
        EngineRegistrationRevision.manifest_digest == key.manifest_digest,
    )
    if admin_action:
        query = query.where(EngineRegistrationRevision.publication_status == "pending_review")
    else:
        query = query.where(EngineRegistrationRevision.owner_id == caller.id)
    registration = (await session.execute(query)).scalars().first()
    if registration is None:
        raise RegistryProblem(404, "not_found", _NOT_FOUND)
    if not allows_engine(caller, registration_engine_reference(registration) or {}):
        raise RegistryProblem(404, "not_found", _NOT_FOUND)

    if action == "activate":
        if max_active is not None and not registration.is_active:
            # Serialise this owner's count-and-activate, as the API-key limit does.
            await session.execute(select(User.id).where(User.id == registration.owner_id).with_for_update())
            # The row was read before the lock was got, and a request that held the lock may have activated this
            # very registration meanwhile: that is a repeated activation, not a second place, so it is answered
            # with the active registration instead of being counted against the limit.
            await session.refresh(registration)
            if registration.is_active:
                return registration_summary(registration)
            active = int(
                await session.scalar(
                    select(func.count()).select_from(EngineRegistrationRevision).where(
                        EngineRegistrationRevision.owner_id == registration.owner_id,
                        EngineRegistrationRevision.is_active.is_(True),
                    )
                )
                or 0
            )
            if active >= max_active:
                raise RegistryProblem(
                    402,
                    "quota_exceeded",
                    f"Your plan allows {int(max_active)} active federated engine"
                    f"{'' if int(max_active) == 1 else 's'}, and you have {active}. Deactivate one first.",
                    extra={
                        "quota": {
                            "limit_id": "federatedEngines", "state": "exhausted", "unit": "engine",
                            "source": "plan", "limit": int(max_active), "used": active,
                        }
                    },
                )
        await _verify_registration_row(registration, session, settings=settings, verify=verifier)
        registration.is_active = True
    elif action == "deactivate":
        was_published = registration.publication_status == "published"
        registration.is_active = False
        if was_published:
            await _notify_admins(
                session,
                kind="engine.deactivated",
                subject=f"Published engine paused: {registration.namespace}/{registration.name}",
                body=f"The published federated engine {registration.namespace}/{registration.name}@{registration.version} has been paused by {caller.username}.",
                payload=_event_payload(registration, caller),
            )
    elif action == "request_publication":
        if registration.publication_status == "published":
            return registration_summary(registration)
        if not registration.is_active:
            raise RegistryProblem(
                409,
                "registration_inactive",
                "Activate and verify the private registration before requesting publication",
            )
        await _verify_registration_row(registration, session, settings=settings, verify=verifier)
        registration.publication_status = "pending_review"
        await _notify_admins(
            session,
            kind="engine.publication_requested",
            subject=f"Engine publication requested: {registration.namespace}/{registration.name}",
            body=f"User {caller.username} has requested publication for engine registration {registration.namespace}/{registration.name}@{registration.version}.",
            payload=_event_payload(registration, caller),
        )
    elif action == "reject":
        registration.publication_status = "rejected"
    elif action == "approve":
        await _verify_registration_row(registration, session, settings=settings, verify=verifier)
        registration.publication_status = "published"
        registration.published_at = utcnow()
        pinned = registration.document.get("spec", {}).get("engine", {})
        engine_revision = (
            await session.execute(
                select(EngineRevision).where(
                    EngineRevision.namespace == pinned.get("namespace"),
                    EngineRevision.name == pinned.get("name"),
                    EngineRevision.version == pinned.get("version"),
                    EngineRevision.digest == pinned.get("digest"),
                )
            )
        ).scalars().first()
        publications = [
            ("EngineRegistration", registration.manifest_digest),
        ]
        if engine_revision is not None:
            engine_revision.state = "published"
            publications.append(("Engine", engine_revision.digest))
        for resource_kind, resource_digest in publications:
            publication = (
                await session.execute(
                    select(ManifestPublication).where(
                        ManifestPublication.resource_kind == resource_kind,
                        ManifestPublication.resource_digest == resource_digest,
                    )
                )
            ).scalars().first()
            if publication is None:
                session.add(
                    ManifestPublication(
                        resource_kind=resource_kind,
                        resource_digest=resource_digest,
                        publisher_id=caller.id,
                        state="public",
                    )
                )
            else:
                publication.state = "public"
    else:
        raise AssertionError(f"unknown EngineRegistration action: {action}")
    await session.flush()
    return registration_summary(registration)


async def delete_registration(
    key: RegistrationKey,
    caller: User,
    session: AsyncSession | None,
) -> None:
    """Remove a registration and its credential; an administrator may remove any, an owner their own."""
    if session is None:
        raise RegistryProblem(503, "accounts_unavailable", _ACCOUNTS_REQUIRED)
    query = select(EngineRegistrationRevision).where(
        EngineRegistrationRevision.namespace == key.namespace,
        EngineRegistrationRevision.name == key.name,
        EngineRegistrationRevision.version == key.version,
        EngineRegistrationRevision.manifest_digest == key.manifest_digest,
    )
    if not caller.is_admin:
        query = query.where(EngineRegistrationRevision.owner_id == caller.id)
    registration = (await session.execute(query)).scalars().first()
    if registration is None:
        raise RegistryProblem(404, "not_found", _NOT_FOUND)

    was_published = registration.publication_status == "published"

    publication = (
        await session.execute(
            select(ManifestPublication).where(
                ManifestPublication.resource_kind == "EngineRegistration",
                ManifestPublication.resource_digest == registration.manifest_digest,
            )
        )
    ).scalars().first()
    if publication is not None:
        await session.delete(publication)

    if was_published:
        await _notify_admins(
            session,
            kind="engine.deregistered",
            subject=f"Published engine deregistered: {registration.namespace}/{registration.name}",
            body=f"The published federated engine {registration.namespace}/{registration.name}@{registration.version} has been deregistered by {caller.username}.",
            payload=_event_payload(registration, caller),
        )

    await session.execute(
        delete(EngineCredential).where(EngineCredential.registration_id == registration.id)
    )
    await session.delete(registration)
    await session.flush()


def _conditional_problem(exc: HTTPException) -> RegistryProblem:
    """A refusal of ``core.revision`` (platform shape) as this family's problem, keeping its ``ETag`` header."""
    code, message, diagnostics, extra = split_detail(exc.detail, "request_invalid")
    return RegistryProblem(
        exc.status_code, code, message, diagnostics or None, extra or None, headers=dict(exc.headers or {}) or None
    )


async def set_credential(
    key: RegistrationKey,
    secret: str,
    caller: User,
    session: AsyncSession | None,
    *,
    settings: Settings,
    if_match: str | None = None,
) -> dict[str, Any]:
    """``set_credential_revision`` without the ETag of the stored credential."""
    summary, _ = await set_credential_revision(key, secret, caller, session, settings=settings, if_match=if_match)
    return summary


async def set_credential_revision(
    key: RegistrationKey,
    secret: str,
    caller: User,
    session: AsyncSession | None,
    *,
    settings: Settings,
    if_match: str | None = None,
) -> tuple[dict[str, Any], str]:
    """Replace the deployment credential without ever placing it in a manifest.

    Only the owner may, and not once the registration is published.  The secret is encrypted before it is
    stored and the answer is the registration summary and the ETag of the stored credential: nothing derived
    from the secret leaves this function.
    The change resets the registration (inactive, private, report pending): a previous conformance result
    is no evidence for the new authentication context.

    ``if_match`` is checked right after the registration is found and before every refusal that depends on
    stored state.  With no credential stored yet any ``If-Match`` is a 412 (there is no revision to match, and
    no ETag to report).  Otherwise the credential row is claimed with ``core.revision.guard``; a refusal after
    that claim rolls the transaction back, so a refused request never leaves the bumped revision committed.
    """
    if session is None:
        raise RegistryProblem(503, "accounts_unavailable", _ACCOUNTS_REQUIRED)
    query = select(EngineRegistrationRevision).where(
        EngineRegistrationRevision.namespace == key.namespace,
        EngineRegistrationRevision.name == key.name,
        EngineRegistrationRevision.version == key.version,
        EngineRegistrationRevision.manifest_digest == key.manifest_digest,
        EngineRegistrationRevision.owner_id == caller.id,
    )
    row = (await session.execute(query)).scalars().first()
    if row is None or not allows_engine(caller, registration_engine_reference(row) or {}):
        raise RegistryProblem(404, "not_found", _NOT_FOUND)
    credential = (
        await session.execute(
            select(EngineCredential).where(EngineCredential.registration_id == row.id)
        )
    ).scalars().first()
    try:
        if if_match is not None and credential is None:
            core_revision.parse_if_match(if_match)  # a malformed header is 400 even here
            raise RegistryProblem(
                412, "precondition_failed", "The resource changed since it was read; fetch it again and retry."
            )
        await core_revision.guard(session, credential, if_match)
    except HTTPException as exc:
        raise _conditional_problem(exc) from None
    claimed = if_match is not None
    try:
        if row.publication_status == "published":
            raise RegistryProblem(
                409,
                "immutable_published_registration",
                "A published registration cannot change credentials; create a new revision",
            )
        try:
            encrypted = CredentialStore.from_settings(settings).encrypt(secret)
        except SecretsUnavailable as exc:
            raise RegistryProblem(503, "credential_store_unavailable", str(exc)) from None
    except RegistryProblem:
        if claimed:
            await session.rollback()
        raise
    if credential is None:
        credential = EngineCredential(
            registration_id=row.id,
            credential_ref=f"registration:{row.manifest_digest}",
            credential_encrypted=encrypted,
        )
        session.add(credential)
    else:
        credential.credential_encrypted = encrypted
        # Never at or before the revision the guard claimed: the tag must change with the edit.
        credential.updated_at = max(utcnow(), core_revision.normalise(credential.updated_at) + timedelta(microseconds=1))
    row.is_active = False
    row.publication_status = "private"
    row.verified_at = None
    row.published_at = None
    row.verification_report = {
        "protocol": "bim-engine/v1",
        "protocolDigest": row.protocol_digest,
        "status": "pending",
        "checks": [],
    }
    row.openapi_document = row.document["spec"]["openapi"]
    row.openapi_digest = digest(row.openapi_document)
    await session.flush()
    return registration_summary(row), core_revision.etag_for(credential)
