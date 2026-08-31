"""The public BIM v1 API exposed by the OpenBinding platform.

This router intentionally deals in snapshots and canonical IR. It never passes
a source ZIP to an engine: engines receive only the compiled BindingProblem.
"""

from __future__ import annotations

import asyncio
import copy
import json
import time
import uuid
from datetime import datetime, timezone
from email.parser import BytesParser
from email.policy import default as email_policy
from typing import Any, Mapping

import jsonschema
import yaml
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, Request, status
from fastapi.responses import JSONResponse, Response
from sqlalchemy import or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from .. import space_client
from ..access import metering
from ..access.dependencies import optional_session, require_v1_admin, solve_caller
from ..access.policy import clamp_options, solve_timeout_s
from ..core.settings import get_settings
from ..db import base as db_base
from ..db.models import (
    BindingIRSnapshot,
    DialectRevision,
    EngineCredential,
    EngineRegistrationRevision,
    EngineRevision,
    InstanceResource,
    InstanceSnapshot,
    Job,
    JobProvenance,
    JobState,
    ManifestPublication,
    RegisteredResourceRevision,
    User,
    utcnow,
)
from ..security.apikeys import allows_engine
from ..v1.canonical import canonical_json, digest, digest_bytes
from ..v1.compiler import (
    BindingProblem,
    CompileError,
    RegisteredResource,
    compile_instance,
    compiler_bundle_digest,
    _dialect_descriptor,
    _dialect_type_matches,
    _dialect_xml_type_matches,
    _resource_schema_diagnostics,
    _schema_root,
    installed_dialect_manifests,
    installed_profile,
    installed_profile_manifests,
    instance_digest,
    manifest_id,
)
from ..v1.package import (
    MAX_COMPRESSED,
    MAX_EXPANDED,
    InstancePackage,
    PackageError,
    load_package,
    resource_digest,
    strict_json_loads,
)
from ..v1.remote import RemoteEngineError, RemoteRegistration, fetch_remote_document, solve_remote, validate_endpoint

router = APIRouter(prefix="/v1", tags=["BIM v1"])

_SNAPSHOTS: dict[str, dict[str, Any]] = {}
_JOBS: dict[str, dict[str, Any]] = {}
_BUILTIN_REGISTRATIONS: dict[tuple[str, str, str, str], dict[str, Any]] = {}
_CUSTOM_RESOURCES: dict[tuple[str, str, str, str], RegisteredResource] = {}
_CUSTOM_RESOURCE_RECORDS: dict[tuple[str, str, str, str], dict[str, Any]] = {}
_MANIFEST_DIR = _schema_root() / "manifests"
_ENGINE_PROTOCOL_PATH = _schema_root().parents[1] / "engine-contract.openapi.yaml"
_BIM_ZIP_TYPES = {"application/zip", "application/octet-stream", "application/vnd.bim+zip", "application/x-bim+zip"}


def _problem(status_code: int, code: str, detail: str, diagnostics: list[dict[str, Any]] | None = None) -> JSONResponse:
    body: dict[str, Any] = {"type": f"https://openbinding.dev/problems/{code}", "title": code, "status": status_code, "detail": detail}
    if diagnostics:
        body["diagnostics"] = diagnostics
    return JSONResponse(body, status_code=status_code, media_type="application/problem+json")


def _instance_identity(package: InstancePackage) -> str:
    """Identity of the strict root index plus every package resource."""
    portable = load_package(package.to_zip())
    return instance_digest(portable.instance(), portable.resource_digests)


def _protocol_document() -> dict[str, Any]:
    document = yaml.safe_load(_ENGINE_PROTOCOL_PATH.read_text(encoding="utf-8"))
    if not isinstance(document, dict):
        raise RuntimeError("BIM engine OpenAPI contract must be an object")
    return document


def _protocol_digest() -> str:
    # The OpenAPI refers to the BindingProblem schema by a local relative path.
    # Pin that external contract as part of the protocol identity so changing
    # the IR schema cannot leave a deceptively unchanged protocol revision.
    binding_problem_schema = _ENGINE_PROTOCOL_PATH.parent / "bim" / "v1" / "binding-problem.schema.json"
    return digest({
        "openapi": _protocol_document(),
        "externalSchemas": {
            "bim/v1/BindingProblem": digest_bytes(binding_problem_schema.read_bytes()),
        },
    })


_BUILTIN_ENGINE_MAPPINGS = {
    "request": "/internal/v1/binding-problems",
    "job": "/internal/v1/jobs/{id}",
    "health": "/health",
    "openapi": "/openapi.json",
}


def _builtin_engine_registration(
    manifest: dict[str, Any],
    endpoint: str,
) -> dict[str, Any]:
    """Install the immutable deployment contract for one bundled Engine.

    Bundled engines are deployments too.  Their registration is generated
    from the exact Engine revision and process configuration, so an endpoint
    or protocol change creates a new immutable reference instead of silently
    changing the meaning of an existing job.  The returned runtime marker is
    deliberately outside the public document: only this installer can grant
    access to trusted internal HTTP endpoints.
    """

    engine_ref = _engine_ref(manifest, "bim.builtin")
    installation = {
        "engine": engine_ref,
        "endpoint": endpoint,
        "protocol": {
            "id": "bim-engine/v1",
            "mediaType": "application/json",
            "digest": _protocol_digest(),
        },
        "mappings": dict(_BUILTIN_ENGINE_MAPPINGS),
        "auth": {"scheme": "none"},
        "openapi": {
            **_protocol_document(),
            "x-bim-protocol": "bim-engine/v1",
            "x-bim-protocol-digest": _protocol_digest(),
        },
    }
    installation_digest = digest(installation).removeprefix("sha256-")
    engine_version = str(engine_ref["version"]).split("+", 1)[0]
    document = {
        "apiVersion": "bim/v1",
        "kind": "EngineRegistration",
        "metadata": {
            "namespace": "bim.builtin",
            "name": f"{engine_ref['name']}-deployment",
            "version": f"{engine_version}+builtin.{installation_digest}",
        },
        "spec": installation,
    }
    registration_ref = {
        "namespace": document["metadata"]["namespace"],
        "name": document["metadata"]["name"],
        "version": document["metadata"]["version"],
        "digest": digest(document),
    }
    key = tuple(registration_ref[field] for field in ("namespace", "name", "version", "digest"))
    installed = {
        **registration_ref,
        "document": document,
        "publicationStatus": "published",
        "active": True,
        "installedBuiltin": True,
        "allowInternalHttp": True,
    }
    existing = _BUILTIN_REGISTRATIONS.get(key)
    if existing is not None:
        if existing != installed:
            raise RuntimeError("built-in EngineRegistration identity is immutable")
        return existing
    _BUILTIN_REGISTRATIONS[key] = installed
    return installed


def _installed_builtin_registration(
    manifest: dict[str, Any],
    endpoint: str | None,
    registration_ref: Mapping[str, Any] | None = None,
) -> dict[str, Any] | None:
    """Resolve an exact installed bundled registration, never user input."""

    if not isinstance(endpoint, str) or not endpoint:
        return None
    metadata = manifest.get("metadata", {})
    name = metadata.get("name")
    if not isinstance(name, str):
        return None
    path = _MANIFEST_DIR / f"{name}.json"
    try:
        installed_manifest = json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return None
    if digest(installed_manifest) != digest(manifest):
        return None
    installed = _builtin_engine_registration(installed_manifest, endpoint)
    if registration_ref is not None and any(
        registration_ref.get(field) != installed[field]
        for field in ("namespace", "name", "version", "digest")
    ):
        return None
    return installed


_SCHEMA_ANNOTATIONS = {"title", "description", "$comment", "examples", "deprecated", "readOnly", "writeOnly"}
_BINDING_PROBLEM_SCHEMA_REF = "./bim/v1/binding-problem.schema.json"


def _pointer(document: dict[str, Any], reference: str) -> Any:
    if not reference.startswith("#/"):
        raise RemoteEngineError(f"deployment OpenAPI uses a non-local schema reference: {reference}")
    value: Any = document
    for raw in reference[2:].split("/"):
        token = raw.replace("~1", "/").replace("~0", "~")
        if not isinstance(value, dict) or token not in value:
            raise RemoteEngineError(f"deployment OpenAPI has an unresolved schema reference: {reference}")
        value = value[token]
    return value


def _schema_semantics(document: dict[str, Any], value: Any, trail: tuple[str, ...] = ()) -> Any:
    """Dereference a bounded OpenAPI schema into a comparable closed form."""
    if isinstance(value, list):
        return [_schema_semantics(document, item, trail) for item in value]
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
        return _schema_semantics(document, _pointer(document, reference), (*trail, reference))
    return {
        key: _schema_semantics(document, child, trail)
        for key, child in value.items()
        if key not in _SCHEMA_ANNOTATIONS
    }


def _operation_schema(operation: Any, *, request: bool = False, response: str | None = None) -> dict[str, Any]:
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


def _assert_operation_auth(
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


def _assert_protocol_schema(
    label: str,
    deployed_document: dict[str, Any],
    deployed_schema: dict[str, Any],
    canonical_document: dict[str, Any],
    canonical_schema: dict[str, Any],
) -> None:
    deployed = _schema_semantics(deployed_document, deployed_schema)
    canonical = _schema_semantics(canonical_document, canonical_schema)
    if digest(deployed) != digest(canonical):
        raise RemoteEngineError(f"deployment OpenAPI {label} schema is not equivalent to bim-engine/v1")


def _selector_values(mode: Mapping[str, Any], dimension: str, universe: tuple[str, ...]) -> tuple[str, ...]:
    declaration = mode.get("capabilities", {}).get(dimension, {})
    if not isinstance(declaration, Mapping):
        return ()
    if declaration.get("selector") == "all":
        return universe
    if declaration.get("selector") == "only":
        values = declaration.get("values", [])
        return tuple(value for value in values if isinstance(value, str) and value in universe)
    return ()


def _conformance_shape(mode: Mapping[str, Any]) -> tuple[str, str, int]:
    optimization_modes = _selector_values(
        mode, "optimization", ("satisfy", "weighted", "lexicographic", "pareto")
    )
    objective_types = _selector_values(mode, "objectiveTypes", ("MONO", "MULTI", "MANY"))
    limits = mode.get("limits", {})
    minimum = limits.get("minObjectives", 0) if isinstance(limits, Mapping) else 0
    maximum = limits.get("maxObjectives") if isinstance(limits, Mapping) else None
    minimum = minimum if isinstance(minimum, int) else 0
    maximum = maximum if isinstance(maximum, int) else None
    for optimization_mode in optimization_modes:
        for objective_type in objective_types:
            if optimization_mode == "satisfy":
                if objective_type == "MONO" and minimum == 0:
                    return optimization_mode, objective_type, 0
                continue
            objective_count = max(minimum, {"MONO": 1, "MULTI": 2, "MANY": 3}[objective_type])
            if objective_type == "MULTI" and objective_count > 3:
                continue
            if maximum is not None and objective_count > maximum:
                continue
            return optimization_mode, objective_type, objective_count
    raise RemoteEngineError("Engine has no mode shape suitable for a deterministic conformance probe")


def _conformance_mode(engine: Mapping[str, Any]) -> Mapping[str, Any]:
    modes = engine.get("spec", {}).get("modes", [])
    for mode in modes if isinstance(modes, list) else []:
        if not isinstance(mode, Mapping):
            continue
        try:
            _conformance_shape(mode)
            return mode
        except RemoteEngineError:
            continue
    raise RemoteEngineError("Engine has no published mode suitable for a deterministic conformance probe")


def _conformance_options(mode: Mapping[str, Any]) -> dict[str, Any]:
    properties = mode.get("optionsSchema", {}).get("properties", {})
    if not isinstance(properties, Mapping):
        return {}
    return {
        name: copy.deepcopy(option["default"])
        for name, option in properties.items()
        if isinstance(name, str) and isinstance(option, Mapping) and "default" in option
    }


def _conformance_problem(mode: Mapping[str, Any]) -> dict[str, Any]:
    optimization_mode, objective_type, objective_count = _conformance_shape(mode)
    metric_ids = [f"probe-objective-{index + 1}" for index in range(objective_count)]
    application = {
        "apiVersion": "qos-binding/v1",
        "kind": "Application",
        "metadata": {"name": "probe-application"},
        "spec": {
            "tasks": {"probe-task": {"requires": "bim.conformance.probe"}},
            "metrics": {
                metric_id: {
                    "unit": "1",
                    "direction": "minimize",
                    "scope": "selectedCandidate",
                    "aggregation": "sum",
                    "domain": {"kind": "real", "minimum": 0, "maximum": 1},
                }
                for metric_id in metric_ids
            },
            "workflow": {
                "task": {"resource": "probe-application", "id": "probe-task"}
            },
        },
    }
    candidates = {
        "apiVersion": "qos-binding/v1",
        "kind": "CandidateCatalog",
        "metadata": {"name": "probe-catalog"},
        "spec": {
            "metricBindings": {
                metric_id: {"resource": "probe-application", "id": metric_id}
                for metric_id in metric_ids
            },
            "candidates": {
                "probe-candidate": {
                    "provides": "bim.conformance.probe",
                    "metrics": {metric_id: 0 for metric_id in metric_ids},
                }
            }
        },
    }
    optimization = {
        "apiVersion": "qos-binding/v1",
        "kind": "Optimization",
        "metadata": {"name": "probe-optimization"},
        "spec": {
            "mode": optimization_mode,
            "type": objective_type,
            **({
                "terms": [
                    {"metric": {"resource": "probe-application", "id": metric_id}}
                    for metric_id in metric_ids
                ]
            } if metric_ids else {}),
        },
    }
    instance = {
        "apiVersion": "bim/v1",
        "kind": "Instance",
        "metadata": {"name": "bim-engine-conformance-probe"},
        "spec": {
            "profile": "qos-binding/v1",
            "resources": {
                "application": {"probe-application": "application.json"},
                "candidateCatalog": {"probe-catalog": "candidates.json"},
                "optimization": {"probe-optimization": "optimization.json"},
            }
        },
    }
    package = load_package(
        InstancePackage(
            {
                "instance.json": canonical_json(instance),
                "application.json": canonical_json(application),
                "candidates.json": canonical_json(candidates),
                "optimization.json": canonical_json(optimization),
            }
        ).to_zip()
    )
    return compile_instance(package).document


async def _verify_registration(
    document: dict[str, Any],
    credential: str | None,
    engine: Mapping[str, Any],
) -> tuple[dict[str, Any], dict[str, Any] | None, str | None]:
    """Fetch the pinned OpenAPI and execute a deterministic response probe."""

    spec = document["spec"]
    transport = RemoteRegistration(
        endpoint=spec["endpoint"],
        mappings=spec.get("mappings", {}),
        auth_scheme=spec.get("auth", {}).get("scheme", "none"),
        credential=credential,
        allow_internal_http=not get_settings().federation_require_https,
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
        live_openapi = await fetch_remote_document(transport, openapi_path)
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

        canonical_document = _protocol_document()
        if expected_digest != _protocol_digest():
            raise RemoteEngineError("registration does not pin the installed bim-engine/v1 contract")
        request_path = spec.get("mappings", {}).get("request", "/internal/v1/binding-problems")
        operation = openapi_document.get("paths", {}).get(request_path, {}).get("post")
        if not isinstance(operation, dict):
            raise RemoteEngineError("deployment OpenAPI does not describe the mapped solve operation")
        _assert_operation_auth(
            openapi_document,
            operation,
            spec.get("auth", {}).get("scheme", "none"),
            "solve operation",
        )
        canonical_operation = canonical_document["paths"]["/internal/v1/binding-problems"]["post"]
        _assert_protocol_schema(
            "solve request",
            openapi_document,
            _operation_schema(operation, request=True),
            canonical_document,
            _operation_schema(canonical_operation, request=True),
        )
        responses = operation.get("responses", {})
        if not isinstance(responses, dict) or not ({"200", "202"} & set(responses)):
            raise RemoteEngineError("deployment OpenAPI does not describe a synchronous or asynchronous result")
        response_modes: list[str] = []
        if "200" in responses:
            _assert_protocol_schema(
                "synchronous result",
                openapi_document,
                _operation_schema(operation, response="200"),
                canonical_document,
                _operation_schema(canonical_operation, response="200"),
            )
            response_modes.append("synchronous")
        if "202" in responses:
            _assert_protocol_schema(
                "asynchronous receipt",
                openapi_document,
                _operation_schema(operation, response="202"),
                canonical_document,
                _operation_schema(canonical_operation, response="202"),
            )
            job_path = spec.get("mappings", {}).get("job")
            if not isinstance(job_path, str) or "{id}" not in job_path:
                raise RemoteEngineError("an asynchronous deployment requires a mapped job path containing {id}")
            job_operation = openapi_document.get("paths", {}).get(job_path, {}).get("get")
            if not isinstance(job_operation, dict):
                raise RemoteEngineError("deployment OpenAPI does not describe the mapped async job operation")
            _assert_operation_auth(
                openapi_document,
                job_operation,
                spec.get("auth", {}).get("scheme", "none"),
                "asynchronous job operation",
            )
            canonical_job = canonical_document["paths"]["/internal/v1/jobs/{id}"]["get"]
            _assert_protocol_schema(
                "asynchronous job",
                openapi_document,
                _operation_schema(job_operation, response="200"),
                canonical_document,
                _operation_schema(canonical_job, response="200"),
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
        _assert_operation_auth(
            openapi_document,
            health_operation,
            spec.get("auth", {}).get("scheme", "none"),
            "health operation",
        )
        await fetch_remote_document(transport, health_path)
        checks.append({"id": "health", "status": "passed"})

        conformance_mode = _conformance_mode(engine)
        result = await solve_remote(
            transport,
            _conformance_problem(conformance_mode),
            _conformance_options(conformance_mode),
            timeout_s=10.0,
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


def _manifest(
    name: str,
    *,
    namespace: str | None = None,
    version: str | None = None,
    manifest_digest: str | None = None,
) -> dict[str, Any]:
    candidates = []
    path = _MANIFEST_DIR / f"{name}.json"
    try:
        builtin = json.loads(path.read_text(encoding="utf-8"))
        builtin_namespace = builtin.get("metadata", {}).get("namespace")
        builtin_version = builtin.get("metadata", {}).get("version")
        if (
            (namespace is None or builtin_namespace == namespace)
            and (version is None or builtin_version == version)
            and (manifest_digest is None or digest(builtin) == manifest_digest)
        ):
            candidates.append(builtin)
    except (FileNotFoundError, json.JSONDecodeError):
        pass
    if not candidates:
        raise HTTPException(status_code=404, detail=f"Unknown v1 engine: {name}")
    if len(candidates) > 1:
        raise HTTPException(status_code=409, detail=f"Engine identity is ambiguous; pin namespace, version, and digest: {name}")
    return candidates[0]


async def _manifest_async(
    name: str,
    session: AsyncSession | None = None,
    *,
    caller: User | None = None,
    namespace: str | None = None,
    version: str | None = None,
    manifest_digest: str | None = None,
) -> dict[str, Any]:
    """Resolve a built-in, public, or caller-owned private Engine revision."""
    try:
        document = _manifest(
            name,
            namespace=namespace,
            version=version,
            manifest_digest=manifest_digest,
        )
        document_namespace = document.get("metadata", {}).get("namespace") or "bim.builtin"
        if namespace and document_namespace != namespace:
            raise HTTPException(status_code=404, detail=f"Unknown Engine namespace: {namespace}")
        if version and document.get("metadata", {}).get("version") != version:
            raise HTTPException(status_code=404, detail=f"Unknown Engine revision: {name}@{version}")
        if manifest_digest and digest(document) != manifest_digest:
            raise HTTPException(status_code=404, detail=f"Unknown Engine digest: {manifest_digest}")
        return document
    except HTTPException:
        if session is not None:
            query = select(EngineRevision).where(EngineRevision.name == name)
            if caller is None:
                query = query.where(EngineRevision.state == "published")
            else:
                query = query.where(
                    or_(
                        EngineRevision.state == "published",
                        EngineRevision.owner_id == caller.id,
                    )
                )
            if namespace:
                query = query.where(EngineRevision.namespace == namespace)
            if version:
                query = query.where(EngineRevision.version == version)
            if manifest_digest:
                query = query.where(EngineRevision.digest == manifest_digest)
            revision = (await session.execute(query.order_by(EngineRevision.created_at.desc()))).scalars().first()
            if revision is not None:
                return revision.document
        raise


def _schema_diagnostics(document: dict[str, Any], kind: str) -> list[dict[str, Any]]:
    filename = {
        "Instance": "instance.schema.json",
        "Profile": "profile.schema.json",
        "Application": "application.schema.json",
        "CandidateCatalog": "candidate-catalog.schema.json",
        "ConstraintSet": "constraint-set.schema.json",
        "Optimization": "optimization.schema.json",
        "RoutingOverlay": "routing-overlay.schema.json",
        "Placement": "placement.schema.json",
        "Engine": "engine.schema.json",
        "Dialect": "dialect.schema.json",
        "EngineRegistration": "engine-registration.schema.json",
    }.get(kind)
    if not filename:
        return []
    path = _MANIFEST_DIR.parent / filename
    try:
        schema = json.loads(path.read_text(encoding="utf-8"))
        validator = jsonschema.Draft202012Validator(schema)
        return [{"code": "schema", "message": error.message, "pointer": "/" + "/".join(str(part) for part in error.path)} for error in validator.iter_errors(document)]
    except (OSError, json.JSONDecodeError) as exc:
        return [{"code": "schema_unavailable", "message": str(exc)}]


def _embedded_secret_paths(value: Any, pointer: str = "") -> list[str]:
    paths: list[str] = []
    if isinstance(value, dict):
        for key, child in value.items():
            normalized = "".join(character for character in str(key).casefold() if character.isalnum())
            child_pointer = f"{pointer}/{key}"
            # OpenAPI documents routinely describe fields named token,
            # password or apiKey. Those are schema names, not embedded values.
            if child_pointer == "/spec/openapi":
                continue
            if any(marker in normalized for marker in ("secret", "password", "token", "credential", "apikey")):
                paths.append(child_pointer)
            paths.extend(_embedded_secret_paths(child, child_pointer))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            paths.extend(_embedded_secret_paths(child, f"{pointer}/{index}"))
    return paths


def _engine_contract_diagnostics(document: Mapping[str, Any]) -> list[dict[str, Any]]:
    """Validate generic Engine declarations against their installed Profile.

    JSON Schema deliberately knows no QoS capability names.  The selected
    Profile owns that vocabulary and output type; an unavailable profile is a
    runtime/installation error, not an invalid BIM core document shape.
    """

    diagnostics: list[dict[str, Any]] = []
    modes = document.get("spec", {}).get("modes", [])
    seen_mode_ids: set[str] = set()
    for index, mode in enumerate(modes if isinstance(modes, list) else []):
        if not isinstance(mode, Mapping):
            continue
        pointer = f"/spec/modes/{index}"
        mode_id = mode.get("id")
        if isinstance(mode_id, str) and mode_id in seen_mode_ids:
            diagnostics.append({
                "code": "mode_id_duplicate",
                "pointer": pointer + "/id",
                "message": f"mode id {mode_id!r} is repeated",
            })
        elif isinstance(mode_id, str):
            seen_mode_ids.add(mode_id)
        profile_id = mode.get("profile")
        profile = installed_profile(profile_id) if isinstance(profile_id, str) else None
        if profile is None:
            diagnostics.append({
                "code": "profile_adapter_not_installed",
                "pointer": pointer + "/profile",
                "message": f"profile {profile_id!r} has no installed adapter",
            })
            continue
        profile_spec = profile["spec"]
        output = profile_spec["output"]
        expected_ir = {"apiVersion": output["apiVersion"], "kind": output["kind"]}
        if mode.get("ir") != expected_ir:
            diagnostics.append({
                "code": "profile_ir",
                "pointer": pointer + "/ir",
                "message": f"mode IR must equal installed profile output {expected_ir!r}",
            })
        dimensions = profile_spec["capabilityVocabulary"]["dimensions"]
        capabilities = mode.get("capabilities", {})
        if isinstance(capabilities, Mapping):
            missing = sorted(set(dimensions) - set(capabilities))
            unknown = sorted(set(capabilities) - set(dimensions))
            for dimension in missing:
                diagnostics.append({
                    "code": "capability_dimension_missing",
                    "pointer": pointer + "/capabilities",
                    "message": f"mode must explicitly select capability dimension {dimension!r}",
                })
            for dimension in unknown:
                diagnostics.append({
                    "code": "capability_dimension_unknown",
                    "pointer": pointer + f"/capabilities/{dimension}",
                    "message": f"dimension {dimension!r} is not declared by profile {profile_id!r}",
                })
            for dimension, declaration in capabilities.items():
                vocabulary = dimensions.get(dimension)
                if not isinstance(vocabulary, Mapping) or not isinstance(declaration, Mapping):
                    continue
                selector = declaration.get("selector")
                if selector == "all" and vocabulary.get("openValues", False):
                    diagnostics.append({
                        "code": "open_capability_requires_explicit_values",
                        "pointer": pointer + f"/capabilities/{dimension}/selector",
                        "message": f"open dimension {dimension!r} requires selector none or only",
                    })
                if selector == "only" and not vocabulary.get("openValues", False):
                    unknown_values = sorted(
                        set(declaration.get("values", [])) - set(vocabulary.get("values", []))
                    )
                    if unknown_values:
                        diagnostics.append({
                            "code": "capability_value_unknown",
                            "pointer": pointer + f"/capabilities/{dimension}/values",
                            "message": f"values are outside profile vocabulary: {', '.join(unknown_values)}",
                        })
        limits = mode.get("limits", {})
        if isinstance(limits, Mapping):
            unknown_limits = sorted(set(limits) - set(profile_spec.get("limitVocabulary", [])))
            for limit in unknown_limits:
                diagnostics.append({
                    "code": "limit_unknown",
                    "pointer": pointer + f"/limits/{limit}",
                    "message": f"limit {limit!r} is not declared by profile {profile_id!r}",
                })
        options_schema = mode.get("optionsSchema", {})
        if isinstance(options_schema, Mapping):
            properties = options_schema.get("properties", {})
            required = options_schema.get("required", [])
            if isinstance(properties, Mapping) and isinstance(required, list):
                for missing_name in sorted(set(required) - set(properties)):
                    diagnostics.append({
                        "code": "required_option_unknown",
                        "pointer": pointer + "/optionsSchema/required",
                        "message": f"required option {missing_name!r} has no property schema",
                    })
                for option_name, option_schema in properties.items():
                    if not isinstance(option_schema, Mapping):
                        continue
                    option_pointer = pointer + f"/optionsSchema/properties/{option_name}"
                    lower = option_schema.get("minimum", option_schema.get("exclusiveMinimum"))
                    upper = option_schema.get("maximum", option_schema.get("exclusiveMaximum"))
                    if isinstance(lower, (int, float)) and isinstance(upper, (int, float)) and lower > upper:
                        diagnostics.append({
                            "code": "option_range_empty",
                            "pointer": option_pointer,
                            "message": "option lower bound exceeds its upper bound",
                        })
                    if "default" in option_schema:
                        executable_schema = {
                            key: value
                            for key, value in option_schema.items()
                            if key not in {"default", "description"}
                        }
                        if not jsonschema.Draft202012Validator(executable_schema).is_valid(option_schema["default"]):
                            diagnostics.append({
                                "code": "option_default_invalid",
                                "pointer": option_pointer + "/default",
                                "message": f"default for option {option_name!r} does not satisfy its schema",
                            })
    return diagnostics


async def _engine_mode(
    name: str,
    requested: str | None,
    supplied: Any,
    session: AsyncSession | None = None,
    *,
    caller: User | None = None,
    namespace: str | None = None,
    version: str | None = None,
    manifest_digest: str | None = None,
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    manifest = await _manifest_async(
        name,
        session,
        caller=caller,
        namespace=namespace,
        version=version,
        manifest_digest=manifest_digest,
    )
    contract_diagnostics = _engine_contract_diagnostics(manifest)
    if contract_diagnostics:
        raise HTTPException(
            status_code=422,
            detail={"code": "engine_contract_invalid", "diagnostics": contract_diagnostics},
        )
    modes = manifest.get("spec", {}).get("modes", [])
    mode = next((item for item in modes if item.get("id") == (requested or "")), None)
    if mode is None and requested is None and len(modes) == 1:
        mode = modes[0]
    if mode is None:
        raise HTTPException(status_code=422, detail={"code": "engine_mode_incompatible", "diagnostics": [{"code": "mode", "message": f"engine {name!r} does not provide mode {requested!r}"}]})
    if not isinstance(supplied, dict):
        raise HTTPException(
            status_code=422,
            detail={
                "code": "invalid_option",
                "diagnostics": [
                    {
                        "code": "option_type",
                        "message": "engine options must be a JSON object",
                        "pointer": "/options",
                    }
                ],
            },
        )
    schema = mode.get("optionsSchema", {})
    properties = schema.get("properties", {}) if isinstance(schema, dict) else {}
    unknown = sorted(set(supplied) - set(properties))
    if unknown:
        raise HTTPException(status_code=422, detail={"code": "unknown_option", "diagnostics": [{"code": "unknown_option", "message": f"unknown engine option {key!r}"} for key in unknown]})
    effective = {key: value.get("default") for key, value in properties.items() if isinstance(value, dict) and "default" in value}
    effective.update(supplied)
    if isinstance(schema, dict):
        option_errors = list(jsonschema.Draft202012Validator(schema).iter_errors(effective))
        if option_errors:
            raise HTTPException(status_code=422, detail={"code": "invalid_option", "diagnostics": [{"code": "option_schema", "message": error.message, "pointer": "/options"} for error in option_errors]})
    for key, value in effective.items():
        definition = properties.get(key, {})
        if definition.get("type") == "integer" and (not isinstance(value, int) or isinstance(value, bool)):
            raise HTTPException(status_code=422, detail={"code": "invalid_option", "diagnostics": [{"code": "option_type", "message": f"option {key!r} must be an integer"}]})
        if definition.get("type") == "number" and (not isinstance(value, (int, float)) or isinstance(value, bool)):
            raise HTTPException(status_code=422, detail={"code": "invalid_option", "diagnostics": [{"code": "option_type", "message": f"option {key!r} must be numeric"}]})
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            if "minimum" in definition and value < definition["minimum"]:
                raise HTTPException(status_code=422, detail={"code": "invalid_option", "diagnostics": [{"code": "option_minimum", "message": f"option {key!r} is below its minimum"}]})
            if "maximum" in definition and value > definition["maximum"]:
                raise HTTPException(status_code=422, detail={"code": "invalid_option", "diagnostics": [{"code": "option_maximum", "message": f"option {key!r} exceeds its maximum"}]})
    for option, limit_name in (
        ("iterations", "maxIterations"),
        ("max_evaluations", "maxIterations"),
        ("population_size", "maxPopulation"),
        ("archive_size", "maxSolutions"),
        ("time_budget_ms", "maxTimeBudgetMs"),
    ):
        limit = mode.get("limits", {}).get(limit_name)
        if limit is not None and option in effective and effective[option] > limit:
            raise HTTPException(status_code=422, detail={"code": "option_limit", "diagnostics": [{"code": "effective_limit", "message": f"option {option!r} exceeds mode limit {limit}"}]})
    return manifest, mode, effective


_EXPRESSION_KINDS = {"literal", "path", "not", "negate", "and", "or", "compare", "arithmetic", "call"}


def _candidate_count(spec: Mapping[str, Any]) -> int:
    catalogs = spec.get("candidates", {})
    if not isinstance(catalogs, dict):
        return 0
    return sum(
        len(catalog.get("candidates", {}))
        for catalog in catalogs.values()
        if isinstance(catalog, dict) and isinstance(catalog.get("candidates"), dict)
    )


def _expression_features(value: Any) -> set[str]:
    found: set[str] = set()
    if isinstance(value, dict):
        kind = value.get("kind")
        if kind in _EXPRESSION_KINDS:
            if kind == "path":
                segments = value.get("segments", [])
                root = segments[0] if isinstance(segments, list) and segments else "unknown"
                found.add(f"path.{root}")
            elif kind == "call" and isinstance(value.get("name"), str):
                found.add(f"call.{value['name']}")
            else:
                found.add(kind)
        for child in value.values():
            found.update(_expression_features(child))
    elif isinstance(value, list):
        for child in value:
            found.update(_expression_features(child))
    return found


def _workflow_features(workflow: Any, routing: dict[str, Any]) -> set[str]:
    if not isinstance(workflow, dict):
        return set()
    kind = workflow.get("kind")
    if kind in {"task", "empty"}:
        return {kind}
    if kind in {"sequence", "parallel"}:
        result = {kind}
        children = workflow.get("steps", []) if kind == "sequence" else workflow.get("branches", [])
        for child in children:
            result.update(_workflow_features(child, routing))
        return result
    if kind == "exclusive":
        branches = workflow.get("branches", [])
        conditional = any(isinstance(branch, dict) and branch.get("when") is not None for branch in branches)
        result = {"exclusive.conditional" if conditional else "exclusive.probabilistic"}
        for branch in branches:
            flow = branch.get("flow") if isinstance(branch, dict) and "flow" in branch else branch
            result.update(_workflow_features(flow, routing))
        return result
    if kind == "repeat":
        repeat_kind = "repeat.count" if "count" in workflow else "repeat.expectedCount"
        return {repeat_kind} | _workflow_features(workflow.get("body"), routing)
    return {str(kind)} if isinstance(kind, str) else set()


def _workflow_aggregation_contexts(workflow: Any) -> set[str]:
    """Return only aggregation slots that can execute in this workflow."""

    if not isinstance(workflow, Mapping):
        return set()
    kind = workflow.get("kind")
    if kind == "sequence":
        return {"sequence"} | set().union(*(
            _workflow_aggregation_contexts(child) for child in workflow.get("steps", [])
        ))
    if kind == "parallel":
        return {"parallel"} | set().union(*(
            _workflow_aggregation_contexts(child) for child in workflow.get("branches", [])
        ))
    if kind == "exclusive":
        branches = workflow.get("branches", [])
        own = set() if any(isinstance(branch, Mapping) and "when" in branch for branch in branches) else {"exclusive"}
        return own | set().union(*(
            _workflow_aggregation_contexts(branch.get("flow", {}))
            for branch in branches if isinstance(branch, Mapping)
        ))
    if kind == "repeat":
        return {"repeat"} | _workflow_aggregation_contexts(workflow.get("body", {}))
    return set()


def _aggregate_bound(constraint: dict[str, Any]) -> bool:
    assertion = constraint.get("assert")
    when = constraint.get("when")
    if not isinstance(assertion, dict) or assertion.get("kind") != "compare":
        return False
    if isinstance(when, dict) and not (when.get("kind") == "literal" and when.get("value") is True):
        return False
    children = (assertion.get("left"), assertion.get("right"))
    return any(
        isinstance(child, dict)
        and child.get("kind") == "path"
        and child.get("segments", [None])[0] == "metrics"
        for child in children
    ) and any(isinstance(child, dict) and child.get("kind") == "literal" for child in children)


def _ir_features(problem: BindingProblem) -> dict[str, set[str]]:
    spec = problem.document.get("spec", {})
    application = spec.get("application", {})
    metrics = application.get("metrics", {}) if isinstance(application, dict) else {}
    workflow = application.get("workflow", {}) if isinstance(application, dict) else {}
    workflow_contexts = _workflow_aggregation_contexts(workflow)
    required_metrics = set(application.get("requiredMetrics", [])) if isinstance(application, dict) else set()
    aggregations: set[str] = set()
    metric_scopes: set[str] = set()
    for metric_id, metric in metrics.items() if isinstance(metrics, dict) else []:
        if metric_id not in required_metrics:
            continue
        aggregation = metric.get("aggregation", {}) if isinstance(metric, dict) else {}
        if isinstance(aggregation, dict):
            scope = metric.get("scope")
            active_contexts = {"selection"} if scope == "selectedCandidate" else workflow_contexts
            for context in active_contexts:
                value = aggregation.get(context)
                if value is None:
                    continue
                operator = value if isinstance(value, str) else "expression"
                aggregations.add(f"{context}.{operator}")
        if isinstance(metric, dict) and isinstance(metric.get("scope"), str):
            metric_scopes.add(metric["scope"])
    constraints = spec.get("constraints", [])
    constraint_features: set[str] = set()
    if isinstance(constraints, list):
        for constraint in constraints:
            if not isinstance(constraint, dict):
                continue
            enforcement = constraint.get("enforcement")
            if isinstance(enforcement, str):
                shape = "aggregate-bound" if _aggregate_bound(constraint) else "expression"
                constraint_features.add(f"{enforcement}.{shape}")
    active_aggregation_expressions: list[Any] = []
    for metric_id, metric in metrics.items() if isinstance(metrics, Mapping) else ():
        if metric_id not in required_metrics or not isinstance(metric, Mapping):
            continue
        aggregation = metric.get("aggregation", {})
        if not isinstance(aggregation, Mapping):
            continue
        contexts = (
            {"selection"}
            if metric.get("scope") == "selectedCandidate"
            else workflow_contexts
        )
        active_aggregation_expressions.extend(
            aggregation[context] for context in contexts if context in aggregation
        )
    expression_features = _expression_features({
        "workflow": workflow,
        "constraints": constraints,
        "aggregations": active_aggregation_expressions,
    })
    dialect_features: dict[str, set[str]] = {}
    for item in spec.get("dialects", []):
        if not isinstance(item, Mapping):
            continue
        for feature in item.get("irFeatures", []):
            if isinstance(feature, Mapping) and isinstance(feature.get("dimension"), str) and isinstance(feature.get("value"), str):
                dialect_features.setdefault(feature["dimension"], set()).add(feature["value"])
    placement = spec.get("placement")
    placement_features = {"placement"} if isinstance(placement, (list, dict)) and placement else set()
    optimization = spec.get("optimization", {})
    optimization_mode = optimization.get("mode") if isinstance(optimization, dict) else None
    objective_type = optimization.get("type") if isinstance(optimization, dict) else None
    routing = spec.get("routing", {}) if isinstance(spec.get("routing"), dict) else {}
    features = {
        "workflowNodes": _workflow_features(workflow, routing),
        "aggregations": aggregations,
        "metricScopes": metric_scopes,
        "constraints": constraint_features,
        "optimization": {optimization_mode} if isinstance(optimization_mode, str) else set(),
        "objectiveTypes": {objective_type} if isinstance(objective_type, str) else set(),
        "expressions": expression_features,
        "placement": placement_features,
        "irExtensions": set(),
    }
    for dimension, values in dialect_features.items():
        features.setdefault(dimension, set()).update(values)
    return features


def _mode_compatibility(problem: BindingProblem, mode: dict[str, Any]) -> list[dict[str, Any]]:
    features = _ir_features(problem)
    capabilities = mode.get("capabilities", {})
    diagnostics: list[dict[str, Any]] = []
    problem_profile = problem.document.get("spec", {}).get("profile", {}).get("id")
    if mode.get("profile") != problem_profile:
        diagnostics.append({
            "code": "profile_incompatible",
            "message": f"mode profile {mode.get('profile')!r} does not match problem profile {problem_profile!r}",
        })
    problem_ir = {
        "apiVersion": problem.document.get("apiVersion"),
        "kind": problem.document.get("kind"),
    }
    if mode.get("ir") != problem_ir:
        diagnostics.append({
            "code": "ir_incompatible",
            "message": f"mode IR {mode.get('ir')!r} does not match problem IR {problem_ir!r}",
        })
    for category, used in features.items():
        declaration = capabilities.get(category)
        if declaration is None:
            diagnostics.append({
                "code": "missing_capability_selector",
                "category": category,
                "message": f"mode does not declare capability dimension {category}",
            })
            continue
        if isinstance(declaration, str):
            selector = declaration
            allowed: set[str] = set()
        elif isinstance(declaration, dict):
            selector = declaration.get("selector")
            allowed = {value for value in declaration.get("values", []) if isinstance(value, str)}
        else:
            selector = None
            allowed = set()
        if selector == "none":
            if used:
                diagnostics.append(
                    {
                        "code": "unsupported_capability",
                        "category": category,
                        "unsupported": sorted(used),
                        "message": f"mode does not support {category}: {', '.join(sorted(used))}",
                    }
                )
        elif selector == "only":
            unsupported = used - allowed
            if unsupported:
                diagnostics.append(
                    {
                        "code": "unsupported_capability_value",
                        "category": category,
                        "unsupported": sorted(unsupported),
                        "allowed": sorted(allowed),
                        "message": f"mode does not support requested {category} values",
                    }
                )
        elif selector != "all":
            diagnostics.append(
                {
                    "code": "invalid_capability_selector",
                    "category": category,
                    "message": f"mode has an invalid {category} selector",
                }
            )
    spec = problem.document.get("spec", {})
    tasks = spec.get("application", {}).get("tasks", {})
    task_count = len(tasks) if isinstance(tasks, (dict, list)) else 0
    candidate_count = _candidate_count(spec)
    optimization = spec.get("optimization", {})
    terms = optimization.get("terms", []) if isinstance(optimization, Mapping) else []
    objective_count = len(terms) if isinstance(terms, list) else 0
    limits = mode.get("limits", {})
    for key, actual, label in (
        ("maxTasks", task_count, "tasks"),
        ("maxCandidates", candidate_count, "candidates"),
        ("maxObjectives", objective_count, "objectives"),
    ):
        limit = limits.get(key) if isinstance(limits, dict) else None
        if isinstance(limit, int) and actual > limit:
            diagnostics.append(
                {
                    "code": "engine_limit",
                    "limit": key,
                    "actual": actual,
                    "maximum": limit,
                    "message": f"instance has {actual} {label}; mode limit is {limit}",
                }
            )
    minimum = limits.get("minObjectives") if isinstance(limits, dict) else None
    if isinstance(minimum, int) and objective_count < minimum:
        diagnostics.append(
            {
                "code": "engine_limit",
                "limit": "minObjectives",
                "actual": objective_count,
                "minimum": minimum,
                "message": f"instance has {objective_count} objectives; mode minimum is {minimum}",
            }
        )
    return diagnostics


def _engine_ref(document: dict[str, Any], namespace: str | None = None) -> dict[str, str]:
    metadata = document.get("metadata", {})
    resolved_namespace = namespace or metadata.get("namespace") or "bim.builtin"
    return {
        "namespace": resolved_namespace,
        "name": metadata["name"],
        "version": metadata.get("version", "1.0.0"),
        "digest": digest(document),
    }


async def _available_engine_documents(
    session: AsyncSession | None,
    caller: User | None = None,
) -> list[tuple[dict[str, Any], str | None]]:
    documents: list[tuple[dict[str, Any], str | None]] = []
    for path in sorted(_MANIFEST_DIR.glob("*.json")):
        documents.append((json.loads(path.read_text(encoding="utf-8")), "bim.builtin"))
    if session is not None:
        query = select(EngineRevision)
        if caller is None:
            query = query.where(EngineRevision.state == "published")
        else:
            query = query.where(
                or_(
                    EngineRevision.state == "published",
                    EngineRevision.owner_id == caller.id,
                )
            )
        revisions = (
            await session.execute(
                query.order_by(EngineRevision.name, EngineRevision.created_at.desc())
            )
        ).scalars().all()
        documents.extend((revision.document, revision.namespace) for revision in revisions)
    unique: dict[tuple[str, str, str, str], tuple[dict[str, Any], str | None]] = {}
    for document, namespace in documents:
        reference = _engine_ref(document, namespace)
        key = (reference["namespace"], reference["name"], reference["version"], reference["digest"])
        unique[key] = (document, namespace)
    return list(unique.values())


def _registration_engine_reference(
    registration: EngineRegistrationRevision | Mapping[str, Any],
) -> dict[str, str] | None:
    document = (
        registration.document
        if isinstance(registration, EngineRegistrationRevision)
        else registration.get("document")
    )
    if not isinstance(document, Mapping):
        return None
    engine = document.get("spec", {}).get("engine")
    if (
        not isinstance(engine, Mapping)
        or set(engine) != {"namespace", "name", "version", "digest"}
        or not all(isinstance(engine.get(field), str) and engine.get(field) for field in engine)
    ):
        return None
    return {field: str(engine[field]) for field in ("namespace", "name", "version", "digest")}


async def _visible_engine_registrations(
    engine_reference: dict[str, str],
    engine_document: dict[str, Any],
    caller: User | None,
    session: AsyncSession | None,
) -> list[EngineRegistrationRevision | dict[str, Any]]:
    """Return only installed deployments the caller can execute exactly.

    Compatibility is an execution claim, not merely an IR feature match.  A
    mode therefore becomes selectable only through an active registration
    whose immutable Engine reference is byte-for-byte the analyzed revision.
    Multiple deployments stay as separate choices instead of being collapsed
    into an ambiguous engine/mode pair.
    """

    if caller is not None and not allows_engine(caller, engine_reference):
        return []

    candidates: list[EngineRegistrationRevision | dict[str, Any]] = []
    if caller is not None:
        installed_builtin = _installed_builtin_registration(
            engine_document,
            get_settings().engine_urls.get(engine_reference["name"]),
        )
        if installed_builtin is not None:
            candidates.append(installed_builtin)

    if session is not None:
        if caller is not None:
            query = select(EngineRegistrationRevision).where(
                EngineRegistrationRevision.engine_digest == engine_reference["digest"],
                or_(
                    (
                        (EngineRegistrationRevision.owner_id == caller.id)
                        & EngineRegistrationRevision.is_active.is_(True)
                    ),
                    (
                        (EngineRegistrationRevision.owner_id != caller.id)
                        & (
                            EngineRegistrationRevision.publication_status
                            == "published"
                        )
                    ),
                ),
            )
            candidates.extend((await session.execute(query)).scalars().all())

    exact: dict[
        tuple[str, str, str, str],
        EngineRegistrationRevision | dict[str, Any],
    ] = {}
    for registration in candidates:
        if _registration_engine_reference(registration) != engine_reference:
            continue
        reference = _registration_reference(registration)
        key = tuple(reference[field] for field in ("namespace", "name", "version", "digest"))
        exact[key] = registration
    return [exact[key] for key in sorted(exact)]


async def _compatible_modes(
    problem: BindingProblem,
    caller: User | None,
    session: AsyncSession | None,
) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for document, namespace in await _available_engine_documents(session, caller):
        reference = _engine_ref(document, namespace)
        registrations = await _visible_engine_registrations(
            reference,
            document,
            caller,
            session,
        )
        if not registrations:
            continue
        for mode in document.get("spec", {}).get("modes", []):
            if not isinstance(mode, dict) or not isinstance(mode.get("id"), str):
                continue
            diagnostics = _mode_compatibility(problem, mode)
            for registration in registrations:
                result.append(
                    {
                        "engine": reference,
                        "registration": _registration_reference(registration),
                        "mode": mode["id"],
                        "compatible": not diagnostics,
                        "diagnostics": diagnostics,
                    }
                )
    return sorted(
        result,
        key=lambda item: (
            item["engine"]["namespace"],
            item["engine"]["name"],
            item["engine"]["version"],
            item["mode"],
            item["registration"]["namespace"],
            item["registration"]["name"],
            item["registration"]["version"],
            item["registration"]["digest"],
        ),
    )


async def _read_package(request: Request) -> InstancePackage:
    content_type = (request.headers.get("content-type") or "").split(";", 1)[0].lower()
    if content_type not in _BIM_ZIP_TYPES:
        raise HTTPException(
            status_code=415,
            detail="BIM source uploads must use a .bim.zip media type",
        )
    ceiling = MAX_COMPRESSED
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > ceiling:
        raise HTTPException(status_code=413, detail=f"request body exceeds {ceiling} bytes")
    body = await request.body()
    if len(body) > ceiling:
        raise HTTPException(status_code=413, detail=f"request body exceeds {ceiling} bytes")
    try:
        return load_package(body)
    except PackageError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


def _multipart_zip(body: bytes, content_type: str) -> bytes:
    """Parse one bounded MIME file part without trusting its supplied name."""
    if "\r" in content_type or "\n" in content_type or len(content_type) > 4096:
        raise PackageError("invalid multipart Content-Type")
    try:
        envelope = (
            f"Content-Type: {content_type}\r\nMIME-Version: 1.0\r\n\r\n".encode("ascii")
            + body
        )
    except UnicodeEncodeError as exc:
        raise PackageError("multipart Content-Type must be ASCII") from exc
    message = BytesParser(policy=email_policy).parsebytes(envelope)
    if not message.is_multipart():
        raise PackageError("multipart/form-data requires a valid boundary")
    files: list[bytes] = []
    for part in message.iter_parts():
        if part.get_content_disposition() != "form-data" or part.get_filename() is None:
            continue
        transfer_encoding = (part.get("Content-Transfer-Encoding") or "binary").casefold()
        if transfer_encoding not in {"binary", "8bit"}:
            raise PackageError("multipart ZIP must use binary transfer encoding")
        content = part.get_payload(decode=True)
        if not isinstance(content, bytes) or not content:
            raise PackageError("multipart ZIP part is empty")
        if len(content) > MAX_COMPRESSED:
            raise PackageError(f"compressed package exceeds {MAX_COMPRESSED} bytes")
        files.append(content)
    if len(files) != 1:
        raise PackageError("multipart request must contain exactly one ZIP file part")
    return files[0]


def _compile(
    package: InstancePackage,
    registered_resources: Mapping[tuple[str, str, str, str], RegisteredResource] | None = None,
) -> BindingProblem:
    try:
        return compile_instance(package, registered_resources)
    except CompileError as exc:
        raise HTTPException(status_code=422, detail={"code": "invalid_instance", "diagnostics": [item.as_dict() for item in exc.diagnostics]}) from exc


def _registered_keys(package: InstancePackage) -> set[tuple[str, str, str, str]]:
    instance = package.instance()
    resources = instance.get("spec", {}).get("resources", {})
    if not isinstance(resources, dict):
        return set()
    keys: set[tuple[str, str, str, str]] = set()
    for group in resources.values():
        if not isinstance(group, dict):
            continue
        for target in group.values():
            if isinstance(target, dict) and all(
                isinstance(target.get(key), str)
                for key in ("namespace", "name", "version", "digest")
            ):
                keys.add((target["namespace"], target["name"], target["version"], target["digest"]))
    return keys


async def _installed_registered_resources(
    package: InstancePackage,
    session: AsyncSession | None,
) -> dict[tuple[str, str, str, str], RegisteredResource]:
    keys = _registered_keys(package)
    resolved = {key: value for key, value in _CUSTOM_RESOURCES.items() if key in keys}
    if not keys or session is None:
        return resolved
    digests = {key[3] for key in keys}
    rows = (
        await session.execute(
            select(RegisteredResourceRevision).where(
                RegisteredResourceRevision.state == "published",
                RegisteredResourceRevision.digest.in_(digests),
            )
        )
    ).scalars().all()
    for row in rows:
        key = (row.namespace, row.name, row.version, row.digest)
        if key in keys:
            resolved[key] = RegisteredResource(row.content, row.media_type)
    return resolved


async def _compile_resolved(
    package: InstancePackage,
    session: AsyncSession | None,
) -> BindingProblem:
    return _compile(package, await _installed_registered_resources(package, session))


def _snapshot_payload(package: InstancePackage, problem: BindingProblem) -> dict[str, Any]:
    portable = load_package(package.to_zip())
    return {
        "package": portable,
        "problem": problem,
        "digest": _instance_identity(portable),
        "packageDigest": portable.package_digest,
        "fileDigests": portable.resource_digests,
        "resourceDigests": _source_resource_digests(problem),
        "createdAt": datetime.now(timezone.utc).isoformat(),
    }


def _source_resource_digests(problem: BindingProblem) -> dict[str, str]:
    resources = problem.document.get("spec", {}).get("instance", {}).get("resources", {})
    return {
        resource_id: descriptor["digest"]
        for resource_id, descriptor in sorted(resources.items())
        if isinstance(descriptor, dict) and isinstance(descriptor.get("digest"), str)
    }


def _snapshot_resource_contract(
    problem: BindingProblem,
    descriptor: Mapping[str, Any],
    role: str,
    media_type: str,
) -> tuple[str, str, str]:
    """Resolve the exact installed-and-pinned Dialect for one IR resource."""
    api_version = descriptor.get("apiVersion")
    kind = descriptor.get("kind")
    if not isinstance(api_version, str) or not api_version:
        raise RuntimeError("compiled resource is missing apiVersion")
    if not isinstance(kind, str) or not kind:
        raise RuntimeError("compiled resource is missing kind")
    if descriptor.get("role") != role:
        raise RuntimeError("compiled resource role does not match the Instance index")

    pinned_dialects = {
        item.get("id"): item
        for item in problem.document.get("spec", {}).get("dialects", [])
        if isinstance(item, Mapping) and isinstance(item.get("id"), str)
    }
    matches = [
        manifest_id(dialect)
        for dialect, resource_type in _dialect_type_matches(
            installed_dialect_manifests(), api_version, kind, media_type
        )
        if role in resource_type.get("roles", [])
        and pinned_dialects.get(manifest_id(dialect)) == _dialect_descriptor(dialect)
    ]
    if len(matches) != 1:
        raise RuntimeError(
            "compiled resource does not resolve to exactly one installed and pinned Dialect"
        )
    return api_version, kind, matches[0]


async def _persist_snapshot(
    package: InstancePackage,
    problem: BindingProblem,
    caller: User | None,
    session: AsyncSession | None,
) -> str | None:
    """Persist a source snapshot and its canonical IR when accounts are enabled."""
    if session is None:
        return None
    archive = package.to_zip()
    portable = load_package(archive)
    instance = portable.instance()
    instance_hash = _instance_identity(package)
    package_hash = digest_bytes(archive)
    owner_id = caller.id if caller else None
    query = select(InstanceSnapshot).where(
        InstanceSnapshot.package_digest == package_hash,
        InstanceSnapshot.owner_id == owner_id,
    )
    existing = (await session.execute(query)).scalars().first()
    if existing is not None:
        return str(existing.id)

    snapshot = InstanceSnapshot(
        owner_id=owner_id,
        name=instance.get("metadata", {}).get("name", "instance"),
        instance_digest=instance_hash,
        package_digest=package_hash,
        root_document=portable.json("instance.json"),
        resource_digests=_source_resource_digests(problem),
        source_archive=archive,
    )
    session.add(snapshot)
    await session.flush()

    resources = instance.get("spec", {}).get("resources", {})
    manifest = problem.document.get("spec", {}).get("instance", {}).get("resources", {})
    installed_registered = await _installed_registered_resources(portable, session)
    for role, group in resources.items() if isinstance(resources, dict) else []:
        if not isinstance(group, dict):
            continue
        for resource_id, target in group.items():
            path = target if isinstance(target, str) else None
            registered = target if isinstance(target, dict) else None
            descriptor = manifest.get(resource_id, {}) if isinstance(manifest, dict) else {}
            if isinstance(path, str):
                content = portable.bytes(path)
                document = None
                if path.lower().endswith(".json"):
                    try:
                        document = portable.json(path)
                    except PackageError:
                        document = None
                media_type = (
                    "application/json"
                    if path.lower().endswith(".json")
                    else "application/xml" if path.lower().endswith(".xml") else "application/vnd.omg.bpmn+xml"
                )
                resource_digest = portable.digest(path)
            elif registered is not None:
                key = tuple(
                    registered.get(field, "")
                    for field in ("namespace", "name", "version", "digest")
                )
                resolved = installed_registered.get(key)
                if resolved is None:
                    raise RuntimeError("compiled registered resource is no longer published locally")
                content = resolved.content
                media_type = resolved.media_type
                resource_digest = registered["digest"]
                document = None
                if media_type == "application/json":
                    parsed = strict_json_loads(content)
                    document = parsed if isinstance(parsed, dict) else None
            else:
                continue
            api_version, kind, dialect_id = _snapshot_resource_contract(
                problem, descriptor, role, media_type
            )
            session.add(
                InstanceResource(
                    snapshot_id=snapshot.id,
                    resource_id=resource_id,
                    role=role,
                    api_version=api_version,
                    kind=kind,
                    dialect_id=dialect_id,
                    path=path,
                    digest=resource_digest,
                    registered_namespace=registered.get("namespace") if registered else None,
                    registered_name=registered.get("name") if registered else None,
                    registered_version=registered.get("version") if registered else None,
                    registered_digest=registered.get("digest") if registered else None,
                    media_type=media_type,
                    document=document,
                    content=content,
                )
            )
    session.add(
        BindingIRSnapshot(
            snapshot_id=snapshot.id,
            ir_digest=problem.digest,
            document=problem.document,
            source_map=problem.source_map,
            compiler_version="bim-compiler/v1",
        )
    )
    await session.flush()
    return str(snapshot.id)


async def _owned_snapshot(snapshot_id: str, caller: User | None, session: AsyncSession | None):
    if session is None:
        return None
    try:
        parsed = uuid.UUID(snapshot_id)
    except ValueError:
        return None
    if caller is None:
        return None
    return (
        await session.execute(
            select(InstanceSnapshot).where(
                InstanceSnapshot.id == parsed,
                InstanceSnapshot.owner_id == caller.id,
            )
        )
    ).scalars().first()


async def _owned_job(job_id: str, caller: User | None, session: AsyncSession | None):
    if session is None:
        return None
    try:
        parsed = uuid.UUID(job_id)
    except ValueError:
        return None
    if caller is None:
        return None
    job = (
        await session.execute(
            select(Job).where(Job.id == parsed, Job.owner_id == caller.id)
        )
    ).scalars().first()
    if job is None:
        return None
    provenance = job.provenance if isinstance(job.provenance, dict) else {}
    if not allows_engine(caller, provenance.get("engine", {})):
        return None
    return job


async def _registration_for_engine(
    namespace: str | None,
    name: str | None,
    version: str | None,
    manifest_digest: str | None,
    caller: User | None,
    session: AsyncSession | None,
) -> EngineRegistrationRevision | dict[str, Any] | None:
    if name is None:
        return None
    if not all(
        isinstance(value, str) and value
        for value in (namespace, name, version, manifest_digest)
    ):
        return None
    if session is not None and caller is not None:
        query = select(EngineRegistrationRevision).where(
            EngineRegistrationRevision.namespace == namespace,
            EngineRegistrationRevision.name == name,
            EngineRegistrationRevision.version == version,
            EngineRegistrationRevision.manifest_digest == manifest_digest,
            or_(
                (
                    (EngineRegistrationRevision.owner_id == caller.id)
                    & EngineRegistrationRevision.is_active.is_(True)
                ),
                (
                    (EngineRegistrationRevision.owner_id != caller.id)
                    & (
                        EngineRegistrationRevision.publication_status == "published"
                    )
                ),
            ),
        )
        return (await session.execute(query)).scalars().first()
    return None


def _registration_reference(registration: Mapping[str, Any]) -> dict[str, str]:
    if isinstance(registration, EngineRegistrationRevision):
        return {
            "namespace": registration.namespace,
            "name": registration.name,
            "version": registration.version,
            "digest": registration.manifest_digest,
        }
    document = registration.get("document", {})
    metadata = document.get("metadata", {}) if isinstance(document, Mapping) else {}
    return {
        "namespace": str(registration.get("namespace", metadata.get("namespace"))),
        "name": str(registration.get("name", metadata.get("name"))),
        "version": str(registration.get("version", metadata.get("version"))),
        "digest": str(registration.get("digest")),
    }


def _registration_summary(
    registration: EngineRegistrationRevision | Mapping[str, Any],
) -> dict[str, Any]:
    reference = _registration_reference(registration)
    if isinstance(registration, EngineRegistrationRevision):
        publication_status = registration.publication_status
        active = registration.is_active
    else:
        publication_status = str(
            registration.get("publicationStatus", registration.get("state", "private"))
        )
        active = bool(registration.get("active", False))
    return {
        **reference,
        "status": publication_status,
        "active": active,
    }


def _is_installed_builtin_registration(registration: Mapping[str, Any]) -> bool:
    reference = _registration_reference(registration)
    key = tuple(reference[field] for field in ("namespace", "name", "version", "digest"))
    installed = _BUILTIN_REGISTRATIONS.get(key)
    return bool(
        installed is not None
        and installed.get("installedBuiltin") is True
        and installed.get("document") == registration.get("document")
    )


def _registration_transport(
    registration: Mapping[str, Any],
    credential: str | None = None,
) -> RemoteRegistration:
    document = registration.get("document")
    if not isinstance(document, Mapping):
        raise RemoteEngineError("installed EngineRegistration document is missing")
    spec = document.get("spec")
    if not isinstance(spec, Mapping):
        raise RemoteEngineError("installed EngineRegistration spec is missing")
    endpoint = spec.get("endpoint")
    if not isinstance(endpoint, str):
        raise RemoteEngineError("installed EngineRegistration endpoint is missing")
    return RemoteRegistration(
        endpoint=endpoint,
        mappings=dict(spec.get("mappings", {})),
        auth_scheme=spec.get("auth", {}).get("scheme", "none"),
        credential=credential,
        allow_internal_http=(
            _is_installed_builtin_registration(registration)
            or not get_settings().federation_require_https
        ),
    )


def _mode_execution_contract(mode: Mapping[str, Any]) -> dict[str, Any]:
    guarantees = mode.get("guarantees", {})
    terminations = guarantees.get("termination", []) if isinstance(guarantees, Mapping) else []
    return {
        "id": mode.get("id"),
        "terminationGuarantees": list(terminations) if isinstance(terminations, list) else [],
    }


def _persisted_mode_contract(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict) or set(value) != {"id", "terminationGuarantees"}:
        return None
    mode_id = value.get("id")
    terminations = value.get("terminationGuarantees")
    if (
        not isinstance(mode_id, str)
        or not mode_id
        or not isinstance(terminations, list)
        or not terminations
        or any(
            item not in {"OPTIMAL", "FEASIBLE", "INFEASIBLE", "UNKNOWN"}
            for item in terminations
        )
        or len(set(terminations)) != len(terminations)
    ):
        return None
    return {"id": mode_id, "terminationGuarantees": list(terminations)}


async def _persisted_engine_contract(
    engine_name: str,
    reference: Any,
    mode: dict[str, Any],
    session: AsyncSession,
    owner_id: uuid.UUID | None = None,
) -> dict[str, Any] | None:
    """Resolve the pinned Engine and re-authorize its stored mode guarantees."""

    if (
        not isinstance(reference, dict)
        or set(reference) != {"namespace", "name", "version", "digest"}
        or reference.get("name") != engine_name
        or not all(isinstance(value, str) and value for value in reference.values())
    ):
        return None
    manifest: dict[str, Any] | None
    try:
        manifest = _manifest(
            engine_name,
            namespace=reference["namespace"],
            version=reference["version"],
            manifest_digest=reference["digest"],
        )
    except HTTPException:
        revision = (
            await session.execute(
                select(EngineRevision).where(
                    EngineRevision.namespace == reference["namespace"],
                    EngineRevision.name == reference["name"],
                    EngineRevision.version == reference["version"],
                    EngineRevision.digest == reference["digest"],
                    or_(
                        EngineRevision.state == "published",
                        EngineRevision.owner_id == owner_id,
                    ),
                )
            )
        ).scalars().first()
        manifest = revision.document if revision is not None else None
    if manifest is None or digest(manifest) != reference["digest"]:
        return None
    selected = next(
        (
            item
            for item in manifest.get("spec", {}).get("modes", [])
            if isinstance(item, Mapping) and item.get("id") == mode["id"]
        ),
        None,
    )
    if selected is None or _mode_execution_contract(selected) != mode:
        return None
    return manifest


def _candidate_ref(value: Any) -> tuple[str, str] | None:
    if not isinstance(value, dict) or set(value) != {"resource", "id"}:
        return None
    if not isinstance(value.get("resource"), str) or not isinstance(value.get("id"), str):
        return None
    return value["resource"], value["id"]


def _binding_violations(problem: BindingProblem, binding: dict[str, Any]) -> list[dict[str, Any]]:
    try:
        problem.validate_binding(binding)
    except (KeyError, TypeError, ValueError) as exc:
        return [{"code": "binding_invalid", "message": str(exc), "enforcement": "hard"}]
    return []


def _authoritative_evaluation(
    problem: BindingProblem, binding: dict[str, Any]
) -> tuple[dict[str, float], dict[str, Any], list[dict[str, Any]]]:
    """Reevaluate a returned decision against the gateway's canonical IR."""
    violations = _binding_violations(problem, binding)
    metric_definitions = problem.document["spec"].get("application", {}).get("metrics", {})
    empty_metrics = (
        {metric_id: 0.0 for metric_id in metric_definitions}
        if isinstance(metric_definitions, dict)
        else {}
    )
    if violations:
        return empty_metrics, {}, violations
    try:
        evaluation = problem.evaluate(binding)
        metrics = evaluation["metrics"]
        objectives = evaluation["objectives"]
        violations.extend(evaluation["violations"])
    except (ArithmeticError, KeyError, TypeError, ValueError) as exc:
        metrics = empty_metrics
        objectives = {}
        violations.append({"code": "binding_evaluation", "message": str(exc), "enforcement": "hard"})
    return metrics, objectives, violations


def _reevaluate_result(
    problem: BindingProblem,
    result: dict[str, Any],
    allowed_terminations: list[str] | tuple[str, ...] | set[str] = ("FEASIBLE", "UNKNOWN"),
) -> dict[str, Any]:
    """Replace engine-reported QoS fields with authoritative gateway values."""
    solutions: list[dict[str, Any]] = []
    invalid = False
    for item in result.get("solutions", []) if isinstance(result.get("solutions"), list) else []:
        decision = item.get("decision") if isinstance(item, dict) else None
        binding = decision.get("binding") if isinstance(decision, dict) else None
        if (
            not isinstance(decision, dict)
            or decision.get("kind") != "binding"
            or not isinstance(binding, dict)
            or any(not isinstance(key, str) or _candidate_ref(value) is None for key, value in binding.items())
        ):
            invalid = True
            continue
        metrics, objectives, violations = _authoritative_evaluation(problem, binding)
        if not objectives:
            invalid = True
            continue
        soft_by_ref = {
            _candidate_ref(entry["constraint"]): float(entry.get("penalty", 0.0))
            for entry in violations
            if entry.get("enforcement") == "soft"
            and _candidate_ref(entry.get("constraint")) is not None
        }
        penalties = [
            soft_by_ref.get(_candidate_ref(item["constraint"]), 0.0) * float(item["weight"])
            for item in problem.document["spec"]["optimization"].get("penalties", [])
        ]
        solutions.append({
            "decision": {"kind": "binding", "binding": binding},
            "metrics": metrics,
            "objectives": objectives,
            "penalties": penalties,
            "violations": violations,
        })
        if any(entry.get("enforcement") == "hard" for entry in violations):
            invalid = True
    termination = result.get("termination")
    if termination not in {"OPTIMAL", "FEASIBLE", "INFEASIBLE", "UNKNOWN"} or invalid:
        termination = "UNKNOWN"
    declared_terminations = {
        value
        for value in allowed_terminations
        if value in {"OPTIMAL", "FEASIBLE", "INFEASIBLE", "UNKNOWN"}
    }
    if termination != "UNKNOWN" and termination not in declared_terminations:
        termination = "UNKNOWN"
    if not solutions and termination in {"OPTIMAL", "FEASIBLE"}:
        termination = "UNKNOWN"
    if termination == "INFEASIBLE" and solutions:
        termination = "UNKNOWN"
    return {"termination": termination, "solutions": solutions, "provenance": result.get("provenance", {})}


def _error_from_http(exc: HTTPException) -> JSONResponse:
    detail = exc.detail
    if isinstance(detail, dict):
        diagnostics = detail.get("diagnostics")
        code = detail.get("code", "request_invalid")
        message = detail.get("message", code)
    else:
        diagnostics = None
        code = "request_invalid"
        message = str(detail)
    return _problem(exc.status_code, code, message, diagnostics)


@router.get("/profiles")
async def list_profiles() -> dict[str, Any]:
    return {
        "profiles": [
            {
                **profile,
                "id": manifest_id(profile),
                "digest": digest(profile),
                "output": profile["spec"]["output"],
                "protocol": profile["spec"]["output"]["engineProtocol"],
                "protocolDigest": _protocol_digest(),
            }
            for profile in installed_profile_manifests()
        ]
    }


def _builtin_profiles() -> list[dict[str, Any]]:
    return installed_profile_manifests()


def _builtin_dialects() -> list[dict[str, Any]]:
    return installed_dialect_manifests()


def _installed_dialect_contract(document: Mapping[str, Any]) -> bool:
    """Whether a manifest exactly describes a locally installed adapter ABI."""

    metadata = document.get("metadata")
    spec = document.get("spec")
    if not isinstance(metadata, Mapping) or not isinstance(spec, Mapping):
        return False
    for installed in _builtin_dialects():
        if digest(document) == digest(installed):
            return True
    return False


@router.get("/dialects")
async def list_dialects(session: AsyncSession | None = Depends(optional_session, scope="function")) -> dict[str, Any]:
    # Publication records are audit state, not an installation mechanism.
    # Expose only contracts backed by the adapter/schema registry active in
    # this process, so the catalog can never promise a stale deployment.
    del session
    return {
        "dialects": [
            {**item, "digest": digest(item)} for item in _builtin_dialects()
        ]
    }


@router.post("/dialects", status_code=status.HTTP_201_CREATED)
async def publish_dialect(
    request: Request,
    caller: User = Depends(solve_caller),
    session: AsyncSession | None = Depends(optional_session, scope="function"),
):
    try:
        body = await request.body()
        if len(body) > MAX_EXPANDED:
            return _problem(413, "payload_too_large", f"request body exceeds {MAX_EXPANDED} bytes")
        document = strict_json_loads(body)
    except PackageError as exc:
        return _problem(422, "invalid_dialect", str(exc))
    diagnostics = (
        _schema_diagnostics(document, "Dialect")
        if isinstance(document, dict)
        else [{"code": "document", "message": "Dialect must be an object"}]
    )
    secret_paths = _embedded_secret_paths(document)
    diagnostics.extend(
        {"code": "secret_in_document", "pointer": path, "message": "secret-like field is forbidden"}
        for path in secret_paths
    )
    if diagnostics:
        return _problem(422, "invalid_dialect", "Dialect manifest does not satisfy bim/v1", diagnostics)
    name = document["metadata"]["name"]
    version = document["metadata"]["version"]
    revision_digest = digest(document)
    adapter_digest = document["spec"]["adapter"]["binaryDigest"]
    if session is not None:
        if caller is None:
            return _problem(401, "unauthorized", "Publishing a Dialect requires an account")
        namespace = document["metadata"]["namespace"]
        if not caller.is_admin and namespace != caller.username:
            return _problem(403, "forbidden", "Dialect namespace must match the caller")
        existing = (
            await session.execute(
                select(DialectRevision).where(
                    DialectRevision.namespace == namespace,
                    DialectRevision.name == name,
                    DialectRevision.version == version,
                )
            )
        ).scalars().first()
        if existing is not None:
            if existing.digest != revision_digest:
                return _problem(409, "immutable_dialect", "Dialect revisions are immutable; publish a new version")
            return {"namespace": namespace, "name": name, "version": version, "digest": revision_digest, "status": existing.state}
        row = DialectRevision(
                owner_id=caller.id,
                namespace=namespace,
                name=name,
                version=version,
                digest=revision_digest,
                adapter_digest=adapter_digest,
                document=document,
                state="pending_review",
            )
        try:
            async with session.begin_nested():
                session.add(row)
                await session.flush()
        except IntegrityError:
            return _problem(409, "immutable_dialect", "Dialect identity already exists with different content")
        return {"namespace": namespace, "name": name, "version": version, "digest": revision_digest, "status": "pending_review"}
    if not _installed_dialect_contract(document):
        return _problem(409, "adapter_not_installed", "Dialect does not match an installed adapter and schema contract")
    namespace = document["metadata"]["namespace"]
    return {"namespace": namespace, "name": name, "version": version, "digest": revision_digest, "status": "published"}


@router.post("/dialects/{name}/approve")
async def approve_dialect(
    name: str,
    namespace: str,
    version: str,
    revision: str,
    caller: User = Depends(require_v1_admin),
    session: AsyncSession | None = Depends(optional_session, scope="function"),
):
    if session is None or caller is None:
        return _problem(404, "not_found", "Dialect revision not found")
    if not caller.is_admin:
        return _problem(403, "forbidden", "Only an administrator may approve Dialects")
    row = (
        await session.execute(
            select(DialectRevision).where(
                DialectRevision.namespace == namespace,
                DialectRevision.name == name,
                DialectRevision.version == version,
                DialectRevision.digest == revision,
            )
        )
    ).scalars().first()
    if row is None:
        return _problem(404, "not_found", "Dialect revision not found")
    if not _installed_dialect_contract(row.document):
        return _problem(409, "adapter_not_installed", "Dialect does not match an installed adapter and schema contract")
    row.state = "published"
    publication = (
        await session.execute(
            select(ManifestPublication).where(
                ManifestPublication.resource_kind == "Dialect",
                ManifestPublication.resource_digest == row.digest,
            )
        )
    ).scalars().first()
    if publication is None:
        session.add(
            ManifestPublication(
                resource_kind="Dialect",
                resource_digest=row.digest,
                publisher_id=caller.id,
                state="public",
            )
        )
    await session.flush()
    return {"namespace": namespace, "name": name, "version": version, "digest": revision, "status": "published"}


@router.post("/resources", status_code=status.HTTP_201_CREATED)
async def register_bim_resource(
    request: Request,
    namespace: str = Query(min_length=1, max_length=128),
    name: str = Query(min_length=1, max_length=128),
    version: str = Query(min_length=1, max_length=64),
    role: str = Query(),
    caller: User = Depends(solve_caller),
    session: AsyncSession | None = Depends(optional_session, scope="function"),
):
    """Store an immutable BIM source resource; no executable adapter is accepted."""
    if session is not None and caller is None:
        return _problem(401, "unauthorized", "Registering a BIM resource requires an account")
    if caller is not None and not caller.is_admin and namespace != caller.username:
        return _problem(403, "forbidden", "Resource namespace must match the caller")
    content_type = (request.headers.get("content-type") or "").split(";", 1)[0].casefold()
    body = await request.body()
    if len(body) > MAX_EXPANDED:
        return _problem(413, "payload_too_large", f"resource exceeds {MAX_EXPANDED} bytes")
    document: dict[str, Any] | None = None
    dialects = installed_dialect_manifests()
    dialect_id: str
    api_version: str
    if content_type == "application/json":
        try:
            parsed = strict_json_loads(body)
        except PackageError as exc:
            return _problem(422, "invalid_resource", str(exc))
        if not isinstance(parsed, dict):
            return _problem(422, "invalid_resource", "registered JSON resource must be an object")
        document = parsed
        kind = document.get("kind")
        api_version = document.get("apiVersion")
        if not isinstance(api_version, str) or not isinstance(kind, str):
            return _problem(422, "invalid_resource_identity", "resource requires string apiVersion and kind")
        matches = [
            pair for pair in _dialect_type_matches(dialects, api_version, kind, content_type)
            if role in pair[1].get("roles", [])
        ]
        if not matches:
            return _problem(
                422,
                "invalid_resource_contract",
                f"no installed Dialect permits {api_version!r} {kind!r} in role {role!r}",
            )
        if len(matches) != 1:
            return _problem(409, "ambiguous_resource_contract", "more than one installed Dialect claims this resource identity")
        dialect, resource_type = matches[0]
        dialect_id = manifest_id(dialect)
        diagnostics = _resource_schema_diagnostics(document, api_version, kind, content_type, "resource")
        if diagnostics:
            return _problem(422, "invalid_resource", "resource does not satisfy its installed Dialect schema", [item.as_dict() for item in diagnostics])
        metadata = document.get("metadata", {})
        if metadata.get("name") != name or metadata.get("version") != version:
            return _problem(
                422,
                "resource_identity",
                "registered JSON metadata.name/version must match the requested identity",
            )
        content = canonical_json(document)
        media_type = "application/json"
        filename = "resource.json"
    elif content_type in {"application/vnd.omg.bpmn+xml", "application/xml", "text/xml"} or content_type.endswith("+xml"):
        content = body.replace(b"\r\n", b"\n").replace(b"\r", b"\n")
        try:
            source_package = InstancePackage({"instance.json": b"{}", "resource.xml": content})
            xml_root = source_package.xml_root("resource.xml")
        except PackageError as exc:
            return _problem(422, "invalid_resource", str(exc))
        if isinstance(xml_root.tag, str) and xml_root.tag.startswith("{") and "}" in xml_root.tag:
            xml_namespace, local_name = xml_root.tag[1:].split("}", 1)
        else:
            xml_namespace, local_name = "", str(xml_root.tag)
        matches = [
            pair for pair in _dialect_xml_type_matches(dialects, xml_namespace, local_name, content_type)
            if role in pair[1].get("roles", [])
        ]
        if not matches:
            return _problem(
                422,
                "invalid_resource_contract",
                f"no installed Dialect permits XML {{{xml_namespace}}}{local_name} ({content_type}) in role {role!r}",
            )
        if len(matches) != 1:
            return _problem(409, "ambiguous_resource_contract", "more than one installed Dialect claims this XML resource")
        dialect, resource_type = matches[0]
        if dialect.get("spec", {}).get("adapter", {}).get("id") == "bim-bpmn":
            try:
                source_package.xml("resource.xml")
            except PackageError as exc:
                return _problem(422, "invalid_resource", str(exc))
        else:
            return _problem(409, "adapter_not_installed", "the XML Dialect has no deployed validator adapter")
        dialect_id = manifest_id(dialect)
        api_version = str(resource_type["apiVersion"])
        kind = str(resource_type["kind"])
        media_type = content_type
        filename = "resource.xml"
    else:
        return _problem(
            415,
            "unsupported_media_type",
            "BIM resources use application/json or application/vnd.omg.bpmn+xml",
        )
    revision_digest = resource_digest(filename, content)
    key = (namespace, name, version, revision_digest)
    state = "published" if caller is None or caller.is_admin else "pending_review"
    if session is not None:
        existing = (
            await session.execute(
                select(RegisteredResourceRevision).where(
                    RegisteredResourceRevision.namespace == namespace,
                    RegisteredResourceRevision.name == name,
                    RegisteredResourceRevision.version == version,
                )
            )
        ).scalars().first()
        if existing is not None:
            if existing.digest != revision_digest:
                return _problem(409, "immutable_resource", "resource revisions are immutable; register a new version")
            return {
                "namespace": namespace,
                "name": name,
                "version": version,
                "digest": revision_digest,
                "status": existing.state,
            }
        row = RegisteredResourceRevision(
            owner_id=caller.id,
            namespace=namespace,
            name=name,
            version=version,
            digest=revision_digest,
            role=role,
            api_version=api_version,
            kind=str(kind),
            dialect_id=dialect_id,
            media_type=media_type,
            document=document,
            content=content,
            state=state,
        )
        try:
            async with session.begin_nested():
                session.add(row)
                await session.flush()
        except IntegrityError:
            return _problem(409, "immutable_resource", "resource identity already exists")
    else:
        conflicting = next(
            (
                record
                for record_key, record in _CUSTOM_RESOURCE_RECORDS.items()
                if record_key[:3] == key[:3] and record_key != key
            ),
            None,
        )
        if conflicting is not None:
            return _problem(409, "immutable_resource", "resource revisions are immutable; register a new version")
        _CUSTOM_RESOURCES[key] = RegisteredResource(content, media_type)
        _CUSTOM_RESOURCE_RECORDS[key] = {
            "namespace": namespace,
            "name": name,
            "version": version,
            "digest": revision_digest,
            "role": role,
            "apiVersion": api_version,
            "kind": kind,
            "dialect": dialect_id,
            "mediaType": media_type,
            "status": "published",
        }
        state = "published"
    return {
        "namespace": namespace,
        "name": name,
        "version": version,
        "digest": revision_digest,
        "status": state,
    }


@router.get("/resources")
async def list_registered_bim_resources(
    session: AsyncSession | None = Depends(optional_session, scope="function"),
) -> dict[str, Any]:
    resources = list(_CUSTOM_RESOURCE_RECORDS.values())
    if session is not None:
        rows = (
            await session.execute(
                select(RegisteredResourceRevision)
                .where(RegisteredResourceRevision.state == "published")
                .order_by(
                    RegisteredResourceRevision.namespace,
                    RegisteredResourceRevision.name,
                    RegisteredResourceRevision.version,
                )
            )
        ).scalars().all()
        resources.extend({
            "namespace": row.namespace,
            "name": row.name,
            "version": row.version,
            "digest": row.digest,
            "role": row.role,
            "apiVersion": row.api_version,
            "kind": row.kind,
            "dialect": row.dialect_id,
            "mediaType": row.media_type,
            "status": row.state,
        } for row in rows)
    unique = {
        (item["namespace"], item["name"], item["version"], item["digest"]): item
        for item in resources
        if item.get("status") == "published"
    }
    return {"resources": [unique[key] for key in sorted(unique)]}


@router.get("/resources/{name}")
async def get_registered_bim_resource(
    name: str,
    namespace: str,
    version: str,
    revision: str,
    session: AsyncSession | None = Depends(optional_session, scope="function"),
):
    key = (namespace, name, version, revision)
    local = _CUSTOM_RESOURCES.get(key)
    if local is not None:
        return Response(
            local.content,
            media_type=local.media_type,
            headers={"Digest": f"sha-256={revision.removeprefix('sha256-')}"},
        )
    if session is not None:
        row = (
            await session.execute(
                select(RegisteredResourceRevision).where(
                    RegisteredResourceRevision.namespace == namespace,
                    RegisteredResourceRevision.name == name,
                    RegisteredResourceRevision.version == version,
                    RegisteredResourceRevision.digest == revision,
                    RegisteredResourceRevision.state == "published",
                )
            )
        ).scalars().first()
        if row is not None:
            return Response(
                row.content,
                media_type=row.media_type,
                headers={"Digest": f"sha-256={row.digest.removeprefix('sha256-')}"},
            )
    return _problem(404, "not_found", "Registered BIM resource not found")


@router.post("/resources/{name}/approve")
async def approve_registered_bim_resource(
    name: str,
    namespace: str,
    version: str,
    revision: str,
    caller: User = Depends(require_v1_admin),
    session: AsyncSession | None = Depends(optional_session, scope="function"),
):
    if session is None or caller is None:
        return _problem(404, "not_found", "Registered BIM resource not found")
    if not caller.is_admin:
        return _problem(403, "forbidden", "Only an administrator may approve BIM resources")
    row = (
        await session.execute(
            select(RegisteredResourceRevision).where(
                RegisteredResourceRevision.namespace == namespace,
                RegisteredResourceRevision.name == name,
                RegisteredResourceRevision.version == version,
                RegisteredResourceRevision.digest == revision,
            )
        )
    ).scalars().first()
    if row is None:
        return _problem(404, "not_found", "Registered BIM resource not found")
    row.state = "published"
    publication = (
        await session.execute(
            select(ManifestPublication).where(
                ManifestPublication.resource_kind == "RegisteredResource",
                ManifestPublication.resource_digest == row.digest,
            )
        )
    ).scalars().first()
    if publication is None:
        session.add(ManifestPublication(
            resource_kind="RegisteredResource",
            resource_digest=row.digest,
            publisher_id=caller.id,
            state="public",
        ))
    await session.flush()
    return {
        "namespace": namespace,
        "name": name,
        "version": version,
        "digest": revision,
        "status": "published",
    }


@router.get("/catalog")
async def get_catalog(
    session: AsyncSession | None = Depends(optional_session, scope="function"),
    caller: User = Depends(solve_caller),
) -> dict[str, Any]:
    return {
        "apiVersion": "bim/v1",
        **(await list_profiles()),
        **(await list_dialects(session=session)),
        **(await list_registered_bim_resources(session=session)),
        **(await list_examples()),
        **(await list_v1_engines(session=session, caller=caller)),
    }


@router.get("/schemas/{kind}")
async def get_v1_schema(kind: str):
    if kind in {"engine-contract", "bim-engine-v1"}:
        return {
            "protocol": "bim-engine/v1",
            "digest": _protocol_digest(),
            "openapi": _protocol_document(),
        }
    filename = {"Instance": "instance.schema.json", "Profile": "profile.schema.json", "Application": "application.schema.json", "CandidateCatalog": "candidate-catalog.schema.json", "ConstraintSet": "constraint-set.schema.json", "Optimization": "optimization.schema.json", "Placement": "placement.schema.json", "RoutingOverlay": "routing-overlay.schema.json", "BindingProblem": "binding-problem.schema.json", "Engine": "engine.schema.json", "Dialect": "dialect.schema.json", "EngineRegistration": "engine-registration.schema.json"}.get(kind)
    if not filename:
        return _problem(404, "not_found", "Unknown v1 kind")
    path = _MANIFEST_DIR.parent / filename
    if not path.exists():
        return _problem(404, "not_found", "Schema not found")
    return json.loads(path.read_text(encoding="utf-8"))


@router.get(
    "/pricing",
    operation_id="getPricing",
    summary="The pricing document enforced by this deployment",
    tags=["Accounts"],
    responses={404: {"description": "This deployment ships no pricing document."}},
)
async def get_pricing_document():
    """Serve the non-BIM Pricing2Yaml contract used for plans and quotas."""

    path = _MANIFEST_DIR.parents[3] / "space" / "pricing" / "openbinding.yml"
    if not path.is_file():
        return _problem(404, "not_found", "No pricing document on this server")
    return Response(path.read_text(encoding="utf-8"), media_type="application/yaml")


@router.get("/examples")
async def list_examples() -> dict[str, Any]:
    root = _MANIFEST_DIR.parents[3] / "examples"
    paths = []
    for path in root.rglob("instance.json"):
        try:
            document = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if isinstance(document, dict) and document.get("apiVersion") == "bim/v1" and document.get("kind") == "Instance":
            paths.append(path.parent.relative_to(root).as_posix())
    paths.sort()
    return {"examples": paths}


@router.get("/examples/{example_path:path}")
async def get_example_package(example_path: str):
    root = (_MANIFEST_DIR.parents[3] / "examples").resolve()
    requested = (root / example_path).resolve()
    try:
        requested.relative_to(root)
    except ValueError:
        return _problem(404, "not_found", "Example not found")
    if requested.name == "instance.json":
        requested = requested.parent
    if not requested.is_dir() or not (requested / "instance.json").is_file():
        return _problem(404, "not_found", "Example not found")
    try:
        archive = load_package(requested).to_zip()
    except PackageError as exc:
        return _problem(422, "invalid_example", str(exc))
    safe_name = requested.name.replace('"', "") or "example"
    return Response(
        archive,
        media_type="application/vnd.bim+zip",
        headers={
            "Content-Disposition": f'attachment; filename="{safe_name}.bim.zip"',
            "Digest": f"sha-256={digest_bytes(archive).removeprefix('sha256-')}",
        },
    )


@router.get("/engines")
async def list_v1_engines(
    session: AsyncSession | None = Depends(optional_session, scope="function"),
    caller: User = Depends(solve_caller),
) -> dict[str, Any]:
    engines = []
    for document, namespace in await _available_engine_documents(session, caller):
        reference = _engine_ref(document, namespace)
        if not allows_engine(caller, reference):
            continue
        engines.append(
            {
                "id": reference["name"],
                "name": reference["name"],
                "namespace": reference["namespace"],
                "version": reference["version"],
                "digest": reference["digest"],
                "ref": reference,
                "modes": document.get("spec", {}).get("modes", []),
            }
        )
    return {"engines": engines}


@router.get("/engines/{name}")
async def get_v1_engine(
    name: str,
    namespace: str = Query(...),
    version: str = Query(...),
    manifest_digest: str = Query(..., alias="digest"),
    caller: User = Depends(solve_caller),
    session: AsyncSession | None = Depends(optional_session, scope="function"),
) -> dict[str, Any]:
    if not allows_engine(
        caller,
        {
            "namespace": namespace,
            "name": name,
            "version": version,
            "digest": manifest_digest,
        },
    ):
        return _problem(404, "not_found", "Engine revision not found")
    try:
        return await _manifest_async(
            name,
            session,
            caller=caller,
            namespace=namespace,
            version=version,
            manifest_digest=manifest_digest,
        )
    except HTTPException as exc:
        return _problem(exc.status_code, "not_found", str(exc.detail))


@router.post(
    "/engines",
    status_code=status.HTTP_201_CREATED,
    operation_id="createEngine",
)
async def create_engine(
    request: Request,
    caller: User = Depends(solve_caller),
    session: AsyncSession | None = Depends(optional_session, scope="function"),
):
    try:
        body = await request.body()
        if len(body) > MAX_EXPANDED:
            return _problem(413, "payload_too_large", f"request body exceeds {MAX_EXPANDED} bytes")
        document = strict_json_loads(body)
    except PackageError as exc:
        return _problem(422, "invalid_engine", str(exc))
    diagnostics = _schema_diagnostics(document, "Engine") if isinstance(document, dict) else [{"code": "document", "message": "Engine must be an object"}]
    if isinstance(document, Mapping):
        diagnostics.extend(_engine_contract_diagnostics(document))
    if diagnostics:
        return _problem(422, "invalid_engine", "Engine manifest does not satisfy bim/v1", diagnostics)
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
        return _problem(
            403,
            "engine_not_granted",
            "This API key does not grant this exact Engine revision; use an all-Engines key to create new revisions",
        )
    if session is not None:
        namespace = document["metadata"]["namespace"]
        if namespace != caller.username:
            return _problem(403, "forbidden", "Engine namespace must match the caller")
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
                return _problem(409, "immutable_engine", "Engine revisions are immutable; create a new version")
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
            return _problem(409, "immutable_engine", "Engine identity already exists with different content")
        return {"namespace": namespace, "name": name, "version": version, "digest": revision_digest, "status": "private"}
    return _problem(503, "accounts_unavailable", "Registering an Engine requires the accounts database")


@router.post("/engine-registrations", status_code=status.HTTP_201_CREATED)
async def register_engine(
    request: Request,
    caller: User = Depends(solve_caller),
    session: AsyncSession | None = Depends(optional_session, scope="function"),
):
    try:
        body = await request.body()
        if len(body) > MAX_EXPANDED:
            return _problem(413, "payload_too_large", f"request body exceeds {MAX_EXPANDED} bytes")
        document = strict_json_loads(body)
    except PackageError as exc:
        return _problem(422, "invalid_registration", str(exc))
    diagnostics = _schema_diagnostics(document, "EngineRegistration") if isinstance(document, dict) else [{"code": "document", "message": "EngineRegistration must be an object"}]
    if diagnostics:
        return _problem(422, "invalid_registration", "registration must satisfy bim/v1", diagnostics)
    spec = document.get("spec", {})
    endpoint = spec.get("endpoint")
    if not isinstance(endpoint, str):
        return _problem(422, "invalid_registration", "registration endpoint must be a URI")
    allow_internal_http = not get_settings().federation_require_https
    try:
        validate_endpoint(endpoint, allow_internal_http=allow_internal_http)
    except RemoteEngineError as exc:
        return _problem(422, "invalid_registration", str(exc))
    secret_paths = _embedded_secret_paths(document)
    if secret_paths:
        return _problem(
            422,
            "secret_in_document",
            "credentials must be supplied through the secret store",
            [{"code": "secret_in_document", "pointer": path, "message": "secret-like field is forbidden"} for path in secret_paths],
        )
    if spec.get("auth", {}).get("scheme") == "mtls":
        return _problem(
            422,
            "unsupported_auth",
            "mTLS needs a versioned certificate-bundle credential contract and is not available in BIM v1",
        )
    name = document.get("metadata", {}).get("name")
    if not isinstance(name, str) or not name:
        return _problem(422, "invalid_registration", "metadata.name is required")
    namespace = document["metadata"]["namespace"]
    if namespace != caller.username:
        return _problem(403, "forbidden", "EngineRegistration namespace must match the caller")
    version = document["metadata"]["version"]
    revision = digest(document)
    protocol_digest = spec.get("protocol", {}).get("digest")
    protocol_id = spec.get("protocol", {}).get("id", "bim-engine/v1")
    if protocol_id != "bim-engine/v1":
        return _problem(409, "protocol_mismatch", "registration must use bim-engine/v1")
    if protocol_digest != _protocol_digest():
        return _problem(409, "protocol_digest_mismatch", "registration must pin the exact bim-engine/v1 OpenAPI digest")
    submitted_openapi = spec.get("openapi")
    if (
        not isinstance(submitted_openapi, dict)
        or submitted_openapi.get("x-bim-protocol-digest") != protocol_digest
    ):
        return _problem(
            409,
            "openapi_protocol_mismatch",
            "submitted OpenAPI must pin the same bim-engine/v1 digest as the registration",
        )
    engine_ref = spec.get("engine", {})
    engine_name = engine_ref.get("name") if isinstance(engine_ref, dict) else None
    if not allows_engine(caller, engine_ref if isinstance(engine_ref, Mapping) else {}):
        return _problem(404, "not_found", "Engine revision not found")
    try:
        engine_document = await _manifest_async(
            engine_name,
            session,
            caller=caller,
            namespace=engine_ref.get("namespace"),
            version=engine_ref.get("version"),
            manifest_digest=engine_ref.get("digest"),
        )
    except HTTPException:
        return _problem(422, "unknown_engine", "registration references an unknown Engine revision")
    if digest(engine_document) != engine_ref.get("digest"):
        return _problem(409, "engine_digest_mismatch", "registration must pin the exact Engine revision digest")
    if session is not None:
        existing = (
            await session.execute(
                select(EngineRegistrationRevision).where(
                    EngineRegistrationRevision.namespace == namespace,
                    EngineRegistrationRevision.name == name,
                    EngineRegistrationRevision.version == version,
                )
            )
        ).scalars().first()
        if existing is not None:
            if existing.manifest_digest != revision:
                return _problem(409, "immutable_registration", "Registration revisions are immutable; use a new version")
            return _registration_summary(existing)
        registration = EngineRegistrationRevision(
            owner_id=caller.id,
            namespace=namespace,
            name=name,
            version=version,
            manifest_digest=revision,
            engine_digest=engine_ref["digest"],
            document=document,
            endpoint=endpoint,
            protocol_digest=protocol_digest,
            openapi_document=submitted_openapi,
            openapi_digest=digest(submitted_openapi),
            mappings=spec.get("mappings", {}),
            auth_scheme=spec.get("auth", {}).get("scheme", "none"),
            verification_report={"protocol": "bim-engine/v1", "protocolDigest": protocol_digest, "status": "pending", "checks": []},
            publication_status="private",
            is_active=False,
        )
        try:
            async with session.begin_nested():
                session.add(registration)
                await session.flush()
        except IntegrityError:
            return _problem(409, "immutable_registration", "Registration identity already exists with different content")
        return _registration_summary(registration)
    return _problem(503, "accounts_unavailable", "Registering an engine requires the accounts database")


@router.get("/engine-registrations")
async def list_engine_registrations(
    review: bool = Query(
        False,
        description="Administrators may request only registrations explicitly submitted for review.",
    ),
    caller: User = Depends(solve_caller),
    session: AsyncSession | None = Depends(optional_session, scope="function"),
):
    if session is not None:
        if review:
            if not caller.is_admin:
                return _problem(403, "forbidden", "Only an administrator may read publication requests")
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
        rows = (await session.execute(query.order_by(EngineRegistrationRevision.namespace, EngineRegistrationRevision.name, EngineRegistrationRevision.version))).scalars().all()
        return {
            "registrations": [
                _registration_summary(row)
                for row in rows
                if allows_engine(caller, _registration_engine_reference(row) or {})
            ]
        }
    return _problem(503, "accounts_unavailable", "Engine registrations require the accounts database")


@router.get("/engine-registrations/{name}")
async def get_engine_registration(
    name: str,
    namespace: str = Query(...),
    version: str = Query(...),
    manifest_digest: str = Query(..., alias="digest"),
    caller: User = Depends(solve_caller),
    session: AsyncSession | None = Depends(optional_session, scope="function"),
):
    if session is not None:
        query = select(EngineRegistrationRevision).where(
            EngineRegistrationRevision.namespace == namespace,
            EngineRegistrationRevision.name == name,
            EngineRegistrationRevision.version == version,
            EngineRegistrationRevision.manifest_digest == manifest_digest,
        )
        visible = [
            EngineRegistrationRevision.owner_id == caller.id,
            EngineRegistrationRevision.publication_status == "published",
        ]
        if caller.is_admin:
            visible.append(
                EngineRegistrationRevision.publication_status == "pending_review"
            )
        query = query.where(or_(*visible))
        row = (await session.execute(query)).scalars().first()
        if row is None or not allows_engine(
            caller, _registration_engine_reference(row) or {}
        ):
            return _problem(404, "not_found", "Engine registration not found")
        return row.document
    return _problem(503, "accounts_unavailable", "Engine registrations require the accounts database")


async def _engine_document_for_registration(
    registration: EngineRegistrationRevision | Mapping[str, Any],
    session: AsyncSession | None,
) -> dict[str, Any]:
    document = (
        registration.document
        if isinstance(registration, EngineRegistrationRevision)
        else registration.get("document", {})
    )
    if not isinstance(document, Mapping):
        raise HTTPException(status_code=409, detail="EngineRegistration document is missing")
    engine = document.get("spec", {}).get("engine", {})
    if not isinstance(engine, Mapping):
        raise HTTPException(status_code=409, detail="EngineRegistration has no immutable Engine reference")
    try:
        return _manifest(
            str(engine.get("name", "")),
            namespace=str(engine.get("namespace", "")),
            version=str(engine.get("version", "")),
            manifest_digest=str(engine.get("digest", "")),
        )
    except HTTPException:
        pass
    if session is not None and isinstance(registration, EngineRegistrationRevision):
        revision = (
            await session.execute(
                select(EngineRevision).where(
                    EngineRevision.namespace == engine.get("namespace"),
                    EngineRevision.name == engine.get("name"),
                    EngineRevision.version == engine.get("version"),
                    EngineRevision.digest == engine.get("digest"),
                    or_(
                        EngineRevision.state == "published",
                        EngineRevision.owner_id == registration.owner_id,
                    ),
                )
            )
        ).scalars().first()
        if revision is not None:
            return revision.document
    raise HTTPException(status_code=404, detail="Engine revision not found")


async def _verify_registration_row(
    registration: EngineRegistrationRevision,
    session: AsyncSession,
) -> JSONResponse | None:
    if registration.protocol_digest != _protocol_digest():
        return _problem(
            409,
            "protocol_digest_mismatch",
            "Registration protocol is no longer the pinned bim-engine/v1 contract",
        )
    try:
        engine_document = await _engine_document_for_registration(registration, session)
    except HTTPException:
        return _problem(409, "engine_revision_unavailable", "Registration Engine revision is unavailable")

    credential_value = None
    credential_row = (
        await session.execute(
            select(EngineCredential).where(
                EngineCredential.registration_id == registration.id
            )
        )
    ).scalars().first()
    if credential_row is not None:
        from ..security.secrets import CredentialStore, SecretsUnavailable

        try:
            credential_value = CredentialStore.from_settings(get_settings()).decrypt(
                credential_row.credential_encrypted
            )
        except SecretsUnavailable as exc:
            return _problem(503, "credential_store_unavailable", str(exc))

    report, openapi_document, openapi_digest = await _verify_registration(
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
        return _problem(
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
    return None


async def _change_registration(
    namespace: str,
    name: str,
    version: str,
    manifest_digest: str,
    caller: User,
    session: AsyncSession | None,
    *,
    action: str,
):
    if session is None:
        return _problem(503, "accounts_unavailable", "Engine registrations require the accounts database")
    admin_action = action in {"approve", "reject"}
    if admin_action and not caller.is_admin:
        return _problem(403, "forbidden", "Only an administrator may review publication requests")
    query = select(EngineRegistrationRevision).where(
        EngineRegistrationRevision.namespace == namespace,
        EngineRegistrationRevision.name == name,
        EngineRegistrationRevision.version == version,
        EngineRegistrationRevision.manifest_digest == manifest_digest,
    )
    if admin_action:
        query = query.where(
            EngineRegistrationRevision.publication_status == "pending_review"
        )
    else:
        query = query.where(EngineRegistrationRevision.owner_id == caller.id)
    registration = (await session.execute(query)).scalars().first()
    if registration is None:
        return _problem(404, "not_found", "Engine registration not found")
    if not allows_engine(caller, _registration_engine_reference(registration) or {}):
        return _problem(404, "not_found", "Engine registration not found")

    if action == "activate":
        failure = await _verify_registration_row(registration, session)
        if failure is not None:
            return failure
        registration.is_active = True
    elif action == "deactivate":
        registration.is_active = False
    elif action == "request_publication":
        if registration.publication_status == "published":
            return _registration_summary(registration)
        if not registration.is_active:
            return _problem(
                409,
                "registration_inactive",
                "Activate and verify the private registration before requesting publication",
            )
        failure = await _verify_registration_row(registration, session)
        if failure is not None:
            return failure
        registration.publication_status = "pending_review"
    elif action == "reject":
        registration.publication_status = "rejected"
    elif action == "approve":
        failure = await _verify_registration_row(registration, session)
        if failure is not None:
            return failure
        registration.publication_status = "published"
        registration.published_at = utcnow()
        engine_ref = registration.document.get("spec", {}).get("engine", {})
        engine_revision = (
            await session.execute(
                select(EngineRevision).where(
                    EngineRevision.namespace == engine_ref.get("namespace"),
                    EngineRevision.name == engine_ref.get("name"),
                    EngineRevision.version == engine_ref.get("version"),
                    EngineRevision.digest == engine_ref.get("digest"),
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
    return _registration_summary(registration)


@router.post("/engine-registrations/{name}/approve")
async def approve_engine_registration(
    name: str,
    namespace: str = Query(...),
    version: str = Query(...),
    manifest_digest: str = Query(..., alias="digest"),
    caller: User = Depends(require_v1_admin),
    session: AsyncSession | None = Depends(optional_session, scope="function"),
):
    return await _change_registration(namespace, name, version, manifest_digest, caller, session, action="approve")


@router.post("/engine-registrations/{name}/reject")
async def reject_engine_registration(
    name: str,
    namespace: str = Query(...),
    version: str = Query(...),
    manifest_digest: str = Query(..., alias="digest"),
    caller: User = Depends(require_v1_admin),
    session: AsyncSession | None = Depends(optional_session, scope="function"),
):
    return await _change_registration(namespace, name, version, manifest_digest, caller, session, action="reject")


@router.post("/engine-registrations/{name}/activate")
async def activate_engine_registration(
    name: str,
    namespace: str = Query(...),
    version: str = Query(...),
    manifest_digest: str = Query(..., alias="digest"),
    caller: User = Depends(solve_caller),
    session: AsyncSession | None = Depends(optional_session, scope="function"),
):
    return await _change_registration(namespace, name, version, manifest_digest, caller, session, action="activate")


@router.post("/engine-registrations/{name}/deactivate")
async def deactivate_engine_registration(
    name: str,
    namespace: str = Query(...),
    version: str = Query(...),
    manifest_digest: str = Query(..., alias="digest"),
    caller: User = Depends(solve_caller),
    session: AsyncSession | None = Depends(optional_session, scope="function"),
):
    return await _change_registration(namespace, name, version, manifest_digest, caller, session, action="deactivate")


@router.post("/engine-registrations/{name}/publication-request")
async def request_engine_registration_publication(
    name: str,
    namespace: str = Query(...),
    version: str = Query(...),
    manifest_digest: str = Query(..., alias="digest"),
    caller: User = Depends(solve_caller),
    session: AsyncSession | None = Depends(optional_session, scope="function"),
):
    """Make a private registration visible to administrators for moderation."""
    return await _change_registration(namespace, name, version, manifest_digest, caller, session, action="request_publication")


@router.get("/engine-registrations/{name}/report")
async def get_engine_registration_report(
    name: str,
    namespace: str = Query(...),
    version: str = Query(...),
    manifest_digest: str = Query(..., alias="digest"),
    caller: User = Depends(solve_caller),
    session: AsyncSession | None = Depends(optional_session, scope="function"),
):
    if session is not None:
        query = select(EngineRegistrationRevision).where(
            EngineRegistrationRevision.namespace == namespace,
            EngineRegistrationRevision.name == name,
            EngineRegistrationRevision.version == version,
            EngineRegistrationRevision.manifest_digest == manifest_digest,
        )
        visible = [
            EngineRegistrationRevision.owner_id == caller.id,
            EngineRegistrationRevision.publication_status == "published",
        ]
        if caller.is_admin:
            visible.append(
                EngineRegistrationRevision.publication_status == "pending_review"
            )
        query = query.where(or_(*visible))
        row = (await session.execute(query)).scalars().first()
        if row is None or not allows_engine(
            caller, _registration_engine_reference(row) or {}
        ):
            return _problem(404, "not_found", "Engine registration not found")
        try:
            engine_document = await _engine_document_for_registration(row, session)
        except HTTPException:
            engine_document = None
        return {
            **_registration_summary(row),
            "openapiDigest": row.openapi_digest,
            "openapi": row.openapi_document,
            "engine": engine_document,
            "report": row.verification_report,
        }
    return _problem(503, "accounts_unavailable", "Engine registrations require the accounts database")


@router.put("/engine-registrations/{name}/credential")
async def set_engine_registration_credential(
    name: str,
    request: Request,
    namespace: str = Query(...),
    version: str = Query(...),
    manifest_digest: str = Query(..., alias="digest"),
    caller: User = Depends(solve_caller),
    session: AsyncSession | None = Depends(optional_session, scope="function"),
):
    """Replace a deployment credential without ever placing it in a manifest."""
    try:
        body = await request.body()
        if len(body) > MAX_EXPANDED:
            return _problem(413, "payload_too_large", f"request body exceeds {MAX_EXPANDED} bytes")
        payload = strict_json_loads(body)
    except PackageError as exc:
        return _problem(422, "invalid_credential", str(exc))
    secret = payload.get("secret") if isinstance(payload, dict) else None
    if not isinstance(secret, str) or not secret:
        return _problem(422, "invalid_credential", "credential payload requires a non-empty secret")
    from ..security.secrets import CredentialStore, SecretsUnavailable

    if session is not None:
        query = select(EngineRegistrationRevision).where(
            EngineRegistrationRevision.namespace == namespace,
            EngineRegistrationRevision.name == name,
            EngineRegistrationRevision.version == version,
            EngineRegistrationRevision.manifest_digest == manifest_digest,
        )
        query = query.where(EngineRegistrationRevision.owner_id == caller.id)
        row = (await session.execute(query)).scalars().first()
        if row is None or not allows_engine(
            caller, _registration_engine_reference(row) or {}
        ):
            return _problem(404, "not_found", "Engine registration not found")
        if row.publication_status == "published":
            return _problem(
                409,
                "immutable_published_registration",
                "A published registration cannot change credentials; create a new revision",
            )
        try:
            encrypted = CredentialStore.from_settings(get_settings()).encrypt(secret)
        except SecretsUnavailable as exc:
            return _problem(503, "credential_store_unavailable", str(exc))
        credential = (
            await session.execute(
                select(EngineCredential).where(EngineCredential.registration_id == row.id)
            )
        ).scalars().first()
        if credential is None:
            credential = EngineCredential(
                registration_id=row.id,
                credential_ref=f"registration:{row.manifest_digest}",
                credential_encrypted=encrypted,
            )
            session.add(credential)
        else:
            credential.credential_encrypted = encrypted
            credential.updated_at = utcnow()
        # Credentials are deployment material.  Replacing one does not mutate
        # the immutable manifest, but any previous live conformance result is no
        # longer evidence for the new authentication context.
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
        return _registration_summary(row)
    return _problem(503, "accounts_unavailable", "Engine registrations require the accounts database")


@router.post("/instances/validate")
async def validate_instance(
    request: Request,
    session: AsyncSession | None = Depends(optional_session, scope="function"),
):
    try:
        package = await _read_package(request)
        problem = await _compile_resolved(package, session)
    except HTTPException as exc:
        return _error_from_http(exc)
    portable = load_package(package.to_zip())
    return {
        "valid": True,
        "instanceDigest": _instance_identity(package),
        "packageDigest": package.package_digest,
        "fileDigests": portable.resource_digests,
        "resourceDigests": _source_resource_digests(problem),
        "irDigest": problem.digest,
        "diagnostics": [],
    }


@router.post("/analyze")
async def analyze_instance(
    request: Request,
    caller: User = Depends(solve_caller),
    session: AsyncSession | None = Depends(optional_session, scope="function"),
):
    try:
        content_type = (request.headers.get("content-type") or "").split(";", 1)[0].lower()
        if content_type in _BIM_ZIP_TYPES:
            package = await _read_package(request)
        else:
            body = await request.body()
            if len(body) > MAX_EXPANDED:
                return _problem(413, "payload_too_large", f"request body exceeds {MAX_EXPANDED} bytes")
            payload = strict_json_loads(body)
            snapshot_id = payload.get("snapshot") if isinstance(payload, dict) else None
            if not isinstance(payload, dict) or set(payload) != {"snapshot"} or not isinstance(snapshot_id, str) or not snapshot_id:
                return _problem(
                    422,
                    "snapshot_or_package_required",
                    "BIM analysis accepts an exact snapshot reference or a .bim.zip upload",
                )
            if session is not None:
                snapshot = await _owned_snapshot(snapshot_id, caller, session)
                if snapshot is None:
                    return _problem(404, "not_found", "Snapshot not found")
                package = load_package(snapshot.source_archive)
            else:
                snapshot = _SNAPSHOTS.get(snapshot_id)
                if snapshot is None:
                    return _problem(404, "not_found", "Snapshot not found")
                package = snapshot["package"]
        problem = await _compile_resolved(package, session)
    except PackageError as exc:
        return _problem(422, "invalid_request", str(exc))
    except HTTPException as exc:
        return _error_from_http(exc)
    spec = problem.document["spec"]
    candidate_count = _candidate_count(spec)
    compatible_modes = await _compatible_modes(problem, caller, session)
    return {
        "valid": True,
        "instanceDigest": _instance_identity(package),
        "packageDigest": package.package_digest,
        "fileDigests": load_package(package.to_zip()).resource_digests,
        "resourceDigests": _source_resource_digests(problem),
        "irDigest": problem.digest,
        "analysis": {
            "tasks": len(spec.get("application", {}).get("tasks", [])),
            "candidates": candidate_count,
            "constraints": len(spec.get("constraints", [])),
            "placement": bool(spec.get("placement")),
        },
        "compatibleModes": compatible_modes,
        "diagnostics": [],
    }


@router.post("/instances", status_code=status.HTTP_201_CREATED)
async def create_snapshot(
    request: Request,
    caller: User | None = Depends(solve_caller),
    session: AsyncSession | None = Depends(optional_session, scope="function"),
):
    try:
        package = await _read_package(request)
        problem = await _compile_resolved(package, session)
    except HTTPException as exc:
        return _error_from_http(exc)
    snapshot_id = await _persist_snapshot(package, problem, caller, session)
    if snapshot_id is None:
        snapshot_id = str(uuid.uuid4())
        _SNAPSHOTS[snapshot_id] = _snapshot_payload(package, problem)
    portable = load_package(package.to_zip())
    return {
        "id": snapshot_id,
        "kind": "InstanceSnapshot",
        "instanceDigest": _instance_identity(package),
        "packageDigest": package.package_digest,
        "irDigest": problem.digest,
        "fileDigests": portable.resource_digests,
        "resourceDigests": _source_resource_digests(problem),
    }


@router.get("/instances/{snapshot_id}")
async def get_snapshot(
    snapshot_id: str,
    caller: User | None = Depends(solve_caller),
    session: AsyncSession | None = Depends(optional_session, scope="function"),
):
    if session is not None:
        snapshot = await _owned_snapshot(snapshot_id, caller, session)
        if snapshot is None:
            return _problem(404, "not_found", "Snapshot not found")
        ir = (await session.execute(select(BindingIRSnapshot).where(BindingIRSnapshot.snapshot_id == snapshot.id))).scalars().first()
        return {
            "id": snapshot_id,
            "kind": "InstanceSnapshot",
            "instanceDigest": snapshot.instance_digest,
            "packageDigest": snapshot.package_digest,
            "irDigest": ir.ir_digest if ir else None,
            "fileDigests": load_package(snapshot.source_archive).resource_digests,
            "resourceDigests": snapshot.resource_digests,
            "instance": snapshot.root_document,
            "createdAt": snapshot.created_at.isoformat(),
        }
    snapshot = _SNAPSHOTS.get(snapshot_id)
    if not snapshot:
        return _problem(404, "not_found", "Snapshot not found")
    return {
        "id": snapshot_id,
        "kind": "InstanceSnapshot",
        "instanceDigest": snapshot["digest"],
        "packageDigest": snapshot["packageDigest"],
        "irDigest": snapshot["problem"].digest,
        "fileDigests": snapshot["fileDigests"],
        "resourceDigests": snapshot["resourceDigests"],
        "instance": snapshot["package"].json("instance.json"),
        "createdAt": snapshot["createdAt"],
    }


@router.get("/instances/{snapshot_id}/source")
async def get_snapshot_source(
    snapshot_id: str,
    caller: User | None = Depends(solve_caller),
    session: AsyncSession | None = Depends(optional_session, scope="function"),
):
    if session is not None:
        snapshot = await _owned_snapshot(snapshot_id, caller, session)
        if snapshot is None:
            return _problem(404, "not_found", "Snapshot not found")
        archive = snapshot.source_archive
    else:
        snapshot = _SNAPSHOTS.get(snapshot_id)
        if snapshot is None:
            return _problem(404, "not_found", "Snapshot not found")
        archive = snapshot["package"].to_zip()
    return Response(
        archive,
        media_type="application/vnd.bim+zip",
        headers={"Content-Disposition": f'attachment; filename="{snapshot_id}.bim.zip"', "Digest": f"sha-256={digest_bytes(archive).removeprefix('sha256-')}"},
    )


@router.get("/instances/{snapshot_id}/ir")
async def get_snapshot_ir(
    snapshot_id: str,
    caller: User | None = Depends(solve_caller),
    session: AsyncSession | None = Depends(optional_session, scope="function"),
):
    if session is not None:
        snapshot = await _owned_snapshot(snapshot_id, caller, session)
        if snapshot is None:
            return _problem(404, "not_found", "Snapshot not found")
        ir = (await session.execute(select(BindingIRSnapshot).where(BindingIRSnapshot.snapshot_id == snapshot.id))).scalars().first()
        if ir is None:
            return _problem(404, "not_found", "IR not found")
        return ir.document
    snapshot = _SNAPSHOTS.get(snapshot_id)
    if not snapshot:
        return _problem(404, "not_found", "Snapshot not found")
    return snapshot["problem"].as_dict()


async def _run_job(job_id: str) -> None:
    job = _JOBS.get(job_id)
    if not job:
        return
    job["status"] = "running"
    await asyncio.sleep(0)
    try:
        engine_result = await solve_remote(
            job["transport"],
            job["problem"].document,
            job["options"],
            timeout_s=job["timeout"],
        )
        result = _reevaluate_result(
            job["problem"],
            engine_result,
            job["mode"]["terminationGuarantees"],
        )
        result["provenance"] = {**job["provenance"], "engineReported": engine_result.get("provenance", {})}
        job["result"] = result
        job["status"] = "completed"
    except RemoteEngineError as exc:
        job["status"] = "failed"
        job["result"] = {"termination": "UNKNOWN", "solutions": [], "error": str(exc), "provenance": job["provenance"]}


async def _fail_persisted_job(
    job: Job,
    session: AsyncSession,
    message: str,
    started: float,
) -> None:
    job.state = JobState.FAILED
    job.result = {
        "termination": "UNKNOWN",
        "solutions": [],
        "error": message,
        "provenance": job.provenance or {},
    }
    job.termination = "UNKNOWN"
    job.finished_at = utcnow()
    await metering.settle(
        space_client.get_gate(),
        session,
        job.id,
        solver_seconds=max(0.0, time.monotonic() - started),
    )
    await session.flush()


async def _finish_persisted_job(job_id: str, session: AsyncSession) -> None:
    """Dispatch a persisted BIM v1 job using only its stored canonical IR."""
    try:
        parsed = uuid.UUID(job_id)
    except ValueError:
        return
    job = (await session.execute(select(Job).where(Job.id == parsed))).scalars().first()
    if job is None:
        return
    started = time.monotonic()
    job.state = JobState.RUNNING
    await session.flush()
    request = job.original_request or {}
    document = request.get("bindingProblem")
    if not isinstance(document, dict):
        await _fail_persisted_job(job, session, "persisted BindingProblem is missing", started)
        return
    problem = BindingProblem(
        document=document,
        digest=job.provenance.get("irDigest", digest(document)) if isinstance(job.provenance, dict) else digest(document),
        source_map=document.get("spec", {}).get("sourceMap", {}) if isinstance(document.get("spec"), dict) else {},
    )
    mode_contract = _persisted_mode_contract(request.get("mode"))
    if mode_contract is None:
        await _fail_persisted_job(job, session, "Persisted Engine mode contract is invalid", started)
        return
    if not isinstance(job.options, dict):
        await _fail_persisted_job(job, session, "Persisted Engine options must be an object", started)
        return
    provenance = job.provenance if isinstance(job.provenance, dict) else {}
    engine_ref = provenance.get("engine")
    manifest = await _persisted_engine_contract(
        job.engine_id,
        engine_ref,
        mode_contract,
        session,
        job.owner_id,
    )
    if (
        manifest is None
        or provenance.get("engineDigest") != digest(manifest)
        or provenance.get("mode") != mode_contract["id"]
        or provenance.get("terminationGuarantees")
        != mode_contract["terminationGuarantees"]
    ):
        await _fail_persisted_job(job, session, "Persisted Engine mode contract is inconsistent", started)
        return
    registration_ref = request.get("registration")
    if (
        not isinstance(registration_ref, dict)
        or set(registration_ref) != {"namespace", "name", "version", "digest"}
        or not all(isinstance(value, str) and value for value in registration_ref.values())
    ):
        await _fail_persisted_job(job, session, "Persisted EngineRegistration reference is invalid", started)
        return

    registration: EngineRegistrationRevision | dict[str, Any] | None = None
    if registration_ref["namespace"] == "bim.builtin" and isinstance(engine_ref, dict):
        registration = _installed_builtin_registration(
            manifest,
            get_settings().engine_urls.get(job.engine_id),
            registration_ref,
        )
    if registration is None:
        registration = (
            await session.execute(
                select(EngineRegistrationRevision).where(
                    EngineRegistrationRevision.namespace == registration_ref["namespace"],
                    EngineRegistrationRevision.name == registration_ref["name"],
                    EngineRegistrationRevision.version == registration_ref["version"],
                    EngineRegistrationRevision.manifest_digest == registration_ref["digest"],
                    or_(
                        (
                            (EngineRegistrationRevision.owner_id == job.owner_id)
                            & EngineRegistrationRevision.is_active.is_(True)
                        ),
                        (
                            (EngineRegistrationRevision.owner_id != job.owner_id)
                            & (
                                EngineRegistrationRevision.publication_status
                                == "published"
                            )
                        ),
                    ),
                )
            )
        ).scalars().first()
    if registration is None:
        await _fail_persisted_job(job, session, "Engine registration is no longer active", started)
        return

    registered_engine_digest = (
        registration.engine_digest
        if isinstance(registration, EngineRegistrationRevision)
        else registration.get("document", {}).get("spec", {}).get("engine", {}).get("digest")
    )
    if registered_engine_digest != provenance.get("engineDigest"):
        await _fail_persisted_job(job, session, "Engine registration no longer pins the persisted Engine", started)
        return

    credential_value = None
    if isinstance(registration, EngineRegistrationRevision):
        credential_value = None
        credential_row = (
            await session.execute(
                select(EngineCredential).where(EngineCredential.registration_id == registration.id)
            )
        ).scalars().first()
        if credential_row is not None:
            from ..security.secrets import CredentialStore, SecretsUnavailable

            try:
                credential_value = CredentialStore.from_settings(get_settings()).decrypt(credential_row.credential_encrypted)
            except SecretsUnavailable as exc:
                await _fail_persisted_job(job, session, str(exc), started)
                return
        transport = RemoteRegistration(
            endpoint=registration.endpoint,
            mappings=registration.mappings,
            auth_scheme=registration.auth_scheme,
            credential=credential_value,
            allow_internal_http=not get_settings().federation_require_https,
        )
        protocol_digest = registration.protocol_digest
    else:
        try:
            transport = _registration_transport(registration)
        except RemoteEngineError as exc:
            await _fail_persisted_job(job, session, str(exc), started)
            return
        protocol_digest = registration["document"]["spec"]["protocol"]["digest"]
    if job.service_url != transport.endpoint:
        await _fail_persisted_job(job, session, "Persisted EngineRegistration endpoint changed", started)
        return
    if provenance.get("registration") != registration_ref or provenance.get("protocolDigest") != protocol_digest:
        await _fail_persisted_job(job, session, "Persisted EngineRegistration provenance is inconsistent", started)
        return
    try:
        remote_result = await solve_remote(
            transport,
            problem.document,
            job.options,
            timeout_s=float(request.get("timeout", get_settings().engine_solve_timeout_s)),
        )
    except RemoteEngineError as exc:
        await _fail_persisted_job(job, session, str(exc), started)
        return
    reevaluated = _reevaluate_result(
        problem,
        remote_result,
        mode_contract["terminationGuarantees"],
    )
    reevaluated["provenance"] = {
        **provenance,
        "registration": registration_ref,
        "protocolDigest": protocol_digest,
        "engineReported": remote_result.get("provenance", {}),
    }
    job.result = reevaluated
    job.termination = reevaluated["termination"]
    job.state = JobState.COMPLETED
    job.finished_at = utcnow()
    await metering.settle(
        space_client.get_gate(),
        session,
        job.id,
        solver_seconds=time.monotonic() - started,
    )
    await session.flush()


async def _run_persisted_job(job_id: str, request_session: AsyncSession | None = None) -> None:
    if request_session is not None:
        await _finish_persisted_job(job_id, request_session)
        return
    if not db_base.is_configured():
        return
    async with db_base.session_factory()() as session:
        await _finish_persisted_job(job_id, session)
        await session.commit()


@router.post("/jobs", status_code=status.HTTP_202_ACCEPTED)
async def create_job(
    request: Request,
    background_tasks: BackgroundTasks,
    caller: User | None = Depends(solve_caller),
    session: AsyncSession | None = Depends(optional_session, scope="function"),
):
    idempotency_key = request.headers.get("Idempotency-Key")
    if idempotency_key is not None and not (1 <= len(idempotency_key) <= 255):
        return _problem(
            422,
            "invalid_idempotency_key",
            "Idempotency-Key must contain between 1 and 255 characters",
        )
    body_size = 0
    try:
        content_type = (request.headers.get("content-type") or "").split(";", 1)[0].lower()
        if content_type.startswith("multipart/form-data"):
            body = await request.body()
            body_size = len(body)
            if body_size > MAX_COMPRESSED + 1024 * 1024:
                return _problem(413, "payload_too_large", "multipart BIM package is too large")
            package = load_package(_multipart_zip(body, request.headers.get("content-type", "")))
            payload = {}
        elif content_type in _BIM_ZIP_TYPES:
            package = await _read_package(request)
            body_size = int(request.headers.get("content-length", "0") or 0)
            payload: dict[str, Any] = {}
        else:
            body = await request.body()
            body_size = len(body)
            if body_size > MAX_EXPANDED:
                return _problem(413, "payload_too_large", f"request body exceeds {MAX_EXPANDED} bytes")
            payload = strict_json_loads(body)
            snapshot_id = payload.get("snapshot") if isinstance(payload, dict) else None
            if snapshot_id:
                allowed_fields = {"snapshot", "engine", "registration", "mode", "options"}
                if set(payload) - allowed_fields:
                    return _problem(
                        422,
                        "invalid_request_fields",
                        "job request contains fields outside the BIM v1 job contract",
                    )
                if session is not None:
                    snapshot = await _owned_snapshot(snapshot_id, caller, session)
                    if snapshot is None:
                        return _problem(404, "not_found", "Snapshot not found")
                    package = load_package(snapshot.source_archive)
                else:
                    snapshot = _SNAPSHOTS.get(snapshot_id)
                    if not snapshot:
                        return _problem(404, "not_found", "Snapshot not found")
                    package = snapshot["package"]
            else:
                return _problem(
                    422,
                    "snapshot_or_package_required",
                    "BIM v1 jobs accept an existing snapshot or a ZIP package upload",
                )
        problem = await _compile_resolved(package, session)
    except PackageError as exc:
        return _problem(422, "invalid_request", str(exc))
    except HTTPException as exc:
        return _error_from_http(exc)
    job_id = str(uuid.uuid4())
    engine_selector = payload.get("engine", "random-search") if isinstance(payload, dict) else "random-search"
    if isinstance(engine_selector, dict):
        engine = engine_selector.get("name")
        engine_namespace = engine_selector.get("namespace")
        engine_version = engine_selector.get("version")
        requested_engine_digest = engine_selector.get("digest")
        if not all(
            isinstance(value, str) and value
            for value in (engine, engine_namespace, engine_version, requested_engine_digest)
        ):
            return _problem(
                422,
                "invalid_engine",
                "engine references require namespace, name, version and digest",
            )
    else:
        engine = engine_selector
        engine_namespace = engine_version = requested_engine_digest = None
    if not isinstance(engine, str) or not engine:
        return _problem(422, "invalid_engine", "engine must be a name or immutable reference")
    if not isinstance(engine_selector, dict) and not (_MANIFEST_DIR / f"{engine}.json").is_file():
        return _problem(
            422,
            "immutable_engine_required",
            "non-built-in engines must be selected by namespace, name, version and digest",
        )
    requested_mode = payload.get("mode") if isinstance(payload, dict) else None
    try:
        manifest, selected_mode, effective_options = await _engine_mode(
            engine,
            requested_mode,
            payload.get("options", {}) if isinstance(payload, dict) else {},
            session,
            caller=caller,
            namespace=engine_namespace,
            version=engine_version,
            manifest_digest=requested_engine_digest,
        )
    except HTTPException as exc:
        return _error_from_http(exc)
    engine_hash = digest(manifest)
    immutable_engine_ref = _engine_ref(manifest, engine_namespace or "bim.builtin")
    if caller is not None and not allows_engine(caller, immutable_engine_ref):
        return _problem(404, "not_found", "Engine revision not found")
    settings = get_settings()
    option_warnings: list[dict[str, Any]] = []
    effective_timeout = settings.engine_solve_timeout_s
    if caller is not None:
        try:
            caps = await space_client.get_gate().caps(caller.id)
        except space_client.PricingUnavailable as exc:
            return _problem(503, "pricing_unavailable", str(exc))
        if body_size and body_size > caps.max_payload_mb * 1024 * 1024:
            return _problem(413, "payload_too_large", "BIM package exceeds the caller plan limit")
        clamped = clamp_options(effective_options, caps)
        effective_options = clamped.options
        option_warnings = [warning.model_dump(mode="json") for warning in clamped.warnings]
        effective_timeout = solve_timeout_s(caps, settings.engine_solve_timeout_s)
    compatibility_diagnostics = _mode_compatibility(problem, selected_mode)
    if compatibility_diagnostics:
        return _problem(
            422,
            "engine_mode_incompatible",
            "selected engine mode cannot execute every construct in this BindingProblem",
            compatibility_diagnostics,
        )
    limits = dict(selected_mode.get("limits", {}))
    tasks = problem.document["spec"].get("application", {}).get("tasks", {})
    task_count = len(tasks) if isinstance(tasks, (dict, list)) else 0
    candidate_count = _candidate_count(problem.document["spec"])
    mode = selected_mode["id"]
    mode_contract = _mode_execution_contract(selected_mode)
    requested_registration = payload.get("registration") if isinstance(payload, dict) else None
    if requested_registration is not None and (
        not isinstance(requested_registration, dict)
        or set(requested_registration) != {"namespace", "name", "version", "digest"}
        or not all(isinstance(value, str) and value for value in requested_registration.values())
    ):
        return _problem(
            422,
            "invalid_registration",
            "registration references require exactly namespace, name, version and digest",
        )
    registration = await _registration_for_engine(
        requested_registration.get("namespace") if requested_registration else None,
        requested_registration.get("name") if requested_registration else None,
        requested_registration.get("version") if requested_registration else None,
        requested_registration.get("digest") if requested_registration else None,
        caller,
        session,
    )
    builtin_registration = _installed_builtin_registration(
        manifest,
        settings.engine_urls.get(engine),
        requested_registration,
    )
    if registration is None and builtin_registration is not None:
        registration = builtin_registration
    if requested_registration is not None and registration is None:
        return _problem(404, "not_found", "Engine registration not found or not active")
    if registration is None:
        return _problem(
            422,
            "engine_registration_required",
            "the selected Engine revision has no installed EngineRegistration",
        )
    if isinstance(registration, EngineRegistrationRevision):
        registration_ref = _registration_reference(registration)
        if (
            registration.engine_digest != engine_hash
            or _registration_engine_reference(registration) != immutable_engine_ref
        ):
            return _problem(409, "engine_reference_mismatch", "registration does not pin the exact selected Engine revision")
        endpoint = registration.endpoint
        protocol_hash = registration.protocol_digest
    elif isinstance(registration, dict):
        registration_ref = _registration_reference(registration)
        if _registration_engine_reference(registration) != immutable_engine_ref:
            return _problem(409, "engine_reference_mismatch", "registration does not pin the exact selected Engine revision")
        endpoint = registration["document"]["spec"]["endpoint"]
        protocol_hash = registration["document"]["spec"]["protocol"]["digest"]

    portable = load_package(package.to_zip())
    instance_hash = _instance_identity(package)
    package_hash = digest_bytes(package.to_zip())
    profile = problem.document["spec"]["profile"]
    evaluator_hash = compiler_bundle_digest()
    dialects = problem.document["spec"]["dialects"]
    adapters = [item["adapter"] for item in dialects if isinstance(item, dict) and isinstance(item.get("adapter"), dict)]
    request_fingerprint = digest({
        "packageDigest": package_hash,
        "fileDigests": portable.resource_digests,
        "resourceDigests": _source_resource_digests(problem),
        "irDigest": problem.digest,
        "dialects": dialects,
        "adapters": adapters,
        "engineDigest": engine_hash,
        "registration": registration_ref,
        "protocolDigest": protocol_hash,
        "mode": mode,
        "algorithm": selected_mode.get("algorithm"),
        "options": effective_options,
        "limits": limits,
    })
    if session is not None and caller is not None and idempotency_key:
        existing = (
            await session.execute(
                select(Job).where(Job.owner_id == caller.id, Job.idempotency_key == idempotency_key)
            )
        ).scalars().first()
        if existing is not None:
            if existing.idempotency_fingerprint != request_fingerprint:
                return _problem(409, "idempotency_conflict", "Idempotency-Key was already used for a different request")
            existing_provenance = existing.provenance or {}
            existing_profile = existing_provenance.get("profile", {})
            return JSONResponse(
                {
                    "id": str(existing.id),
                    "status": existing.state.value,
                    "profile": existing_profile.get("id"),
                    "irDigest": existing_provenance.get("irDigest"),
                    "idempotent": True,
                },
                status_code=202,
            )
    if idempotency_key:
        for existing_job_id, job in _JOBS.items():
            if job.get("idempotencyKey") == idempotency_key:
                if job.get("idempotencyFingerprint") != request_fingerprint:
                    return _problem(409, "idempotency_conflict", "Idempotency-Key was already used for a different request")
                existing_profile = job["provenance"].get("profile", {})
                return JSONResponse(
                    {
                        "id": existing_job_id,
                        "status": job["status"],
                        "profile": existing_profile.get("id"),
                        "irDigest": job["provenance"].get("irDigest"),
                        "idempotent": True,
                    },
                    status_code=202,
                )
    provenance = {
        "engine": immutable_engine_ref,
        "engineDigest": engine_hash,
        "registration": registration_ref,
        "protocol": "bim-engine/v1",
        "protocolDigest": protocol_hash,
        "mode": mode,
        "algorithm": selected_mode.get("algorithm"),
        "profile": profile,
        "profileDigest": profile["digest"],
        "ir": {"apiVersion": problem.document["apiVersion"], "kind": problem.document["kind"]},
        "irDigest": problem.digest,
        "instanceDigest": instance_hash,
        "packageDigest": package_hash,
        "fileDigests": portable.resource_digests,
        "resourceDigests": _source_resource_digests(problem),
        "dialects": dialects,
        "adapters": adapters,
        "compiler": "bim-compiler/v1",
        "compilerDigest": evaluator_hash,
        "evaluator": "bim-reference-evaluator/v1",
        "evaluatorDigest": evaluator_hash,
        "options": effective_options,
        "limits": {**limits, "effectiveTimeoutSeconds": effective_timeout},
        "warnings": option_warnings,
        "terminationGuarantees": mode_contract["terminationGuarantees"],
    }
    reservation = None
    if caller is not None:
        try:
            verdict, reservation = await metering.reserve(
                space_client.get_gate(),
                caller.id,
                federated=not (
                    isinstance(registration, dict)
                    and _is_installed_builtin_registration(registration)
                ),
            )
        except space_client.PricingUnavailable as exc:
            return _problem(503, "pricing_unavailable", str(exc))
        if not verdict.allowed:
            return _problem(429, "quota_exhausted", verdict.reason or "solve quota exhausted")
    if session is not None and caller is not None:
        try:
            async with session.begin_nested():
                snapshot_db_id = await _persist_snapshot(package, problem, caller, session)
        except IntegrityError:
            await metering.release(space_client.get_gate(), reservation)
            return _problem(409, "snapshot_conflict", "snapshot identity conflicted with another revision")
        try:
            parsed_snapshot_id = uuid.UUID(snapshot_db_id) if snapshot_db_id else None
        except ValueError:
            parsed_snapshot_id = None
        db_job = Job(
            id=uuid.UUID(job_id),
            owner_id=caller.id,
            engine_id=engine,
            engine_job_id=job_id,
            service_url=endpoint,
            state=JobState.QUEUED,
            original_request={
                "bindingProblem": problem.document,
                "timeout": effective_timeout,
                "mode": mode_contract,
                "registration": registration_ref,
            },
            options=effective_options,
            warnings=option_warnings,
            instance_complexity={"instanceDigest": instance_hash, "resourceCount": len(portable.resource_digests), "tasks": task_count, "candidates": candidate_count},
            instance_snapshot_id=parsed_snapshot_id,
            provenance=provenance,
            idempotency_key=idempotency_key,
            idempotency_fingerprint=request_fingerprint,
            requested_budget_s=effective_timeout,
        )
        try:
            async with session.begin_nested():
                session.add(db_job)
                session.add(JobProvenance(job_id=db_job.id, document=provenance, digest=digest(provenance)))
                await session.flush()
        except IntegrityError:
            await metering.release(space_client.get_gate(), reservation)
            return _problem(409, "job_conflict", "job identity conflicted with another request")
        await session.commit()
        background_tasks.add_task(_run_persisted_job, job_id, None if db_base.is_configured() else session)
        return {"id": job_id, "status": "queued", "profile": profile["id"], "irDigest": problem.digest}
    if isinstance(registration, dict):
        transport = _registration_transport(
            registration,
            credential=registration.get("credential"),
        )
    else:
        transport = RemoteRegistration(
            endpoint=registration.endpoint,
            mappings=registration.mappings,
            auth_scheme=registration.auth_scheme,
            allow_internal_http=not get_settings().federation_require_https,
        )
    job = {
        "status": "queued",
        "problem": problem,
        "transport": transport,
        "options": effective_options,
        "timeout": effective_timeout,
        "mode": mode_contract,
        "idempotencyKey": idempotency_key,
        "idempotencyFingerprint": request_fingerprint,
        "provenance": provenance,
    }
    _JOBS[job_id] = job
    background_tasks.add_task(_run_job, job_id)
    return {"id": job_id, "status": "queued", "profile": profile["id"], "irDigest": problem.digest}


@router.get("/jobs/{job_id}")
async def get_v1_job(
    job_id: str,
    caller: User | None = Depends(solve_caller),
    session: AsyncSession | None = Depends(optional_session, scope="function"),
):
    if session is not None:
        job = await _owned_job(job_id, caller, session)
        if job is None:
            return _problem(404, "not_found", "Job not found")
        result = {"id": job_id, "status": job.state.value, "provenance": job.provenance or {}}
        if job.result is not None:
            result["result"] = job.result
        return result
    job = _JOBS.get(job_id)
    if not job:
        return _problem(404, "not_found", "Job not found")
    result = {"id": job_id, "status": job["status"], "provenance": job["provenance"]}
    if "result" in job:
        result["result"] = job["result"]
    return result


@router.get("/jobs/{job_id}/ir")
async def get_v1_job_ir(
    job_id: str,
    caller: User | None = Depends(solve_caller),
    session: AsyncSession | None = Depends(optional_session, scope="function"),
):
    if session is not None:
        job = await _owned_job(job_id, caller, session)
        if job is None:
            return _problem(404, "not_found", "Job not found")
        document = (job.original_request or {}).get("bindingProblem")
    else:
        job = _JOBS.get(job_id)
        if job is None:
            return _problem(404, "not_found", "Job not found")
        document = job["problem"].document
    if not isinstance(document, dict):
        return _problem(404, "not_found", "BindingProblem not found")
    return document


@router.get("/jobs/{job_id}/instance")
async def get_v1_job_instance(
    job_id: str,
    caller: User | None = Depends(solve_caller),
    session: AsyncSession | None = Depends(optional_session, scope="function"),
):
    if session is not None:
        job = await _owned_job(job_id, caller, session)
        if job is None:
            return _problem(404, "not_found", "Job not found")
        if job.instance_snapshot_id is None:
            return _problem(404, "not_found", "Instance snapshot not found")
        snapshot = (
            await session.execute(
                select(InstanceSnapshot).where(
                    InstanceSnapshot.id == job.instance_snapshot_id,
                    InstanceSnapshot.owner_id == caller.id,
                )
            )
        ).scalars().first()
        if snapshot is None:
            return _problem(404, "not_found", "Instance snapshot not found")
        return {
            "id": str(snapshot.id),
            "instanceDigest": snapshot.instance_digest,
            "packageDigest": snapshot.package_digest,
            "fileDigests": load_package(snapshot.source_archive).resource_digests,
            "resourceDigests": snapshot.resource_digests,
            "instance": snapshot.root_document,
        }
    job = _JOBS.get(job_id)
    if job is None:
        return _problem(404, "not_found", "Job not found")
    spec = job["problem"].document.get("spec", {})
    return {"instance": spec.get("instance"), "instanceDigest": job["provenance"].get("instanceDigest")}


@router.get("/jobs/{job_id}/report")
async def get_v1_job_report(
    job_id: str,
    caller: User | None = Depends(solve_caller),
    session: AsyncSession | None = Depends(optional_session, scope="function"),
):
    if session is not None:
        job = await _owned_job(job_id, caller, session)
        if job is None:
            return _problem(404, "not_found", "Job not found")
        result = job.result or {}
        provenance = job.provenance or {}
    else:
        job = _JOBS.get(job_id)
        if job is None:
            return _problem(404, "not_found", "Job not found")
        result = job.get("result", {})
        provenance = job["provenance"]
    return {
        "id": job_id,
        "gatewayEvaluation": {
            "termination": result.get("termination"),
            "solutions": result.get("solutions", []),
        },
        "remote": result.get("provenance", {}).get("engineReported", {}),
        "provenance": provenance,
    }
