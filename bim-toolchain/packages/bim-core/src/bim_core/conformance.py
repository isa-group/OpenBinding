"""Pure conformance kit for ``bim-engine/v1`` engines (no network).

What stays in the host is everything that talks to a registered engine:
fetching the served OpenAPI, calling the health endpoint and running the probe over HTTP.  What is
here is what can be decided from documents alone:

* :func:`openapi_diagnostics` compares the OpenAPI document a deployment publishes with the
  installed ``bim-engine/v1`` contract (version, pinned protocol digest, the operations a
  registration maps, their authentication and the *semantics* of their request and response
  schemas, with ``$ref`` resolved) and returns the findings as a list.
* :func:`conformance_problem`, :func:`conformance_options` and :func:`conformance_optimization`
  build the deterministic probe an engine must solve for a mode, and
  :func:`assert_conformance_result` judges its answer.

The ``assert_*``/``*_semantics`` helpers raise :class:`~bim_core.errors.ProtocolError`; codes:
``openapi_ref_not_local``, ``openapi_ref_unresolved``, ``openapi_ref_siblings``,
``openapi_ref_unapproved``, ``openapi_ref_recursive``, ``openapi_schema_missing``,
``openapi_schema_not_object``, ``openapi_security_invalid``, ``openapi_auth_mismatch``,
``openapi_schema_not_equivalent``, ``conformance_no_shape``, ``conformance_no_mode``,
``conformance_failed``.
"""

from __future__ import annotations

import copy
from typing import Any, Mapping

from .canonical import canonical_json, digest
from .compiler import compile_instance
from .errors import ProtocolError
from .package import InstancePackage, load_package
from .protocol import protocol_digest, protocol_document

SCHEMA_ANNOTATIONS = frozenset({"title", "description", "$comment", "examples", "deprecated", "readOnly", "writeOnly"})
BINDING_PROBLEM_SCHEMA_REF = "./bim/v1/binding-problem.schema.json"
DEFAULT_MAPPINGS = {
    "request": "/internal/v1/binding-problems",
    "job": "/internal/v1/jobs/{id}",
    "health": "/health",
    "openapi": "/openapi.json",
}
_CANONICAL_REQUEST_PATH = "/internal/v1/binding-problems"
_CANONICAL_JOB_PATH = "/internal/v1/jobs/{id}"
_OBJECTIVE_TYPES = {"SINGLE", "MULTI", "MANY"}


# --- OpenAPI semantics -----------------------------------------------------------------------


def resolve_pointer(document: dict[str, Any], reference: str) -> Any:
    """The value a local ``#/...`` reference points to inside ``document``."""
    if not reference.startswith("#/"):
        raise ProtocolError(
            "openapi_ref_not_local", f"deployment OpenAPI uses a non-local schema reference: {reference}"
        )
    value: Any = document
    for raw in reference[2:].split("/"):
        token = raw.replace("~1", "/").replace("~0", "~")
        if not isinstance(value, dict) or token not in value:
            raise ProtocolError(
                "openapi_ref_unresolved", f"deployment OpenAPI has an unresolved schema reference: {reference}"
            )
        value = value[token]
    return value


def schema_semantics(document: dict[str, Any], value: Any, trail: tuple[str, ...] = ()) -> Any:
    """Dereference a bounded OpenAPI schema into a comparable closed form.

    Annotations are dropped, local ``$ref`` are inlined (a recursive one is an error) and the
    reference to the BindingProblem schema becomes the symbol ``bim-binding-problem/v1``.
    """
    if isinstance(value, list):
        return [schema_semantics(document, item, trail) for item in value]
    if not isinstance(value, dict):
        return value
    reference = value.get("$ref")
    if isinstance(reference, str):
        siblings = set(value) - {"$ref"} - SCHEMA_ANNOTATIONS
        if siblings:
            raise ProtocolError(
                "openapi_ref_siblings", "deployment OpenAPI schema references cannot have semantic siblings"
            )
        if reference == BINDING_PROBLEM_SCHEMA_REF:
            return {"$ref": "bim-binding-problem/v1"}
        if not reference.startswith("#/"):
            raise ProtocolError(
                "openapi_ref_unapproved", f"deployment OpenAPI uses an unapproved schema reference: {reference}"
            )
        if reference in trail:
            raise ProtocolError(
                "openapi_ref_recursive", f"deployment OpenAPI contains a recursive schema reference: {reference}"
            )
        return schema_semantics(document, resolve_pointer(document, reference), (*trail, reference))
    return {
        key: schema_semantics(document, child, trail)
        for key, child in value.items()
        if key not in SCHEMA_ANNOTATIONS
    }


def operation_schema(operation: Any, *, request: bool = False, response: str | None = None) -> dict[str, Any]:
    """The ``application/json`` schema of the request body or of one response of an operation."""
    try:
        if request:
            schema = operation["requestBody"]["content"]["application/json"]["schema"]
        else:
            schema = operation["responses"][response]["content"]["application/json"]["schema"]
    except (KeyError, TypeError) as exc:
        location = "request" if request else f"response {response}"
        raise ProtocolError(
            "openapi_schema_missing", f"deployment OpenAPI is missing the application/json {location} schema"
        ) from exc
    if not isinstance(schema, dict):
        raise ProtocolError("openapi_schema_not_object", "deployment OpenAPI operation schema must be an object")
    return schema


def assert_operation_auth(
    document: Mapping[str, Any],
    operation: Mapping[str, Any],
    expected: str,
    label: str,
) -> None:
    """Ensure the submitted OpenAPI matches the registration transport auth (``none``, ``bearer`` or ``basic``)."""

    security = operation.get("security", document.get("security", []))
    if not isinstance(security, list):
        raise ProtocolError("openapi_security_invalid", f"deployment OpenAPI {label} security must be an array")
    if any(not isinstance(requirement, Mapping) for requirement in security):
        raise ProtocolError(
            "openapi_security_invalid", f"deployment OpenAPI {label} security requirements must be objects"
        )
    if expected == "none":
        if security and not any(not requirement for requirement in security):
            raise ProtocolError(
                "openapi_auth_mismatch",
                f"deployment OpenAPI {label} requires authentication but registration auth is none",
            )
        return

    if not security or any(not requirement for requirement in security):
        raise ProtocolError(
            "openapi_auth_mismatch",
            f"deployment OpenAPI {label} permits anonymous access but registration auth is {expected}",
        )

    schemes = document.get("components", {}).get("securitySchemes", {})
    if not isinstance(schemes, Mapping):
        raise ProtocolError("openapi_security_invalid", "deployment OpenAPI has no securitySchemes object")
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
        raise ProtocolError(
            "openapi_auth_mismatch",
            f"deployment OpenAPI {label} does not offer the registered {expected} authentication",
        )


def assert_protocol_schema(
    label: str,
    deployed_document: dict[str, Any],
    deployed_schema: dict[str, Any],
    canonical_document: dict[str, Any],
    canonical_schema: dict[str, Any],
) -> None:
    """The deployed schema must have the same semantics as the canonical one."""
    deployed = schema_semantics(deployed_document, deployed_schema)
    canonical = schema_semantics(canonical_document, canonical_schema)
    if digest(deployed) != digest(canonical):
        raise ProtocolError(
            "openapi_schema_not_equivalent", f"deployment OpenAPI {label} schema is not equivalent to bim-engine/v1"
        )


def openapi_diagnostics(
    document: Any,
    *,
    auth_scheme: str = "none",
    mappings: Mapping[str, Any] | None = None,
    expected_digest: str | None = None,
) -> list[dict[str, Any]]:
    """Findings of a deployment's OpenAPI document against the installed ``bim-engine/v1``; ``[]`` if it conforms.

    ``auth_scheme`` and ``mappings`` are those of the EngineRegistration (``request``, ``job`` and
    ``health`` paths).  Without ``mappings`` the mappings of a bundled engine (``DEFAULT_MAPPINGS``) apply;
    a mapping that is given is used as it is, so an asynchronous deployment must map ``job`` itself and
    a missing ``request`` or ``health`` falls back to the default path.
    ``expected_digest`` is the protocol digest the registration pins; by default the installed one.
    Each finding is ``{"code", "check", "message"}`` with ``check`` one of ``openapi``, ``solve``,
    ``async`` or ``health``; the codes are those of :class:`ProtocolError`, plus
    ``openapi_not_object``, ``openapi_version``, ``openapi_protocol``, ``openapi_digest_unpinned``,
    ``protocol_not_installed``, ``openapi_operation_missing``, ``openapi_responses_missing``,
    ``openapi_job_path`` and ``openapi_malformed``.  Independent checks all run, so one finding
    does not hide the others.
    """
    findings: list[dict[str, Any]] = []
    if not isinstance(document, dict):
        return [{"code": "openapi_not_object", "check": "openapi", "message": "deployment OpenAPI must be an object"}]
    mapped = dict(DEFAULT_MAPPINGS) if mappings is None else dict(mappings) if isinstance(mappings, Mapping) else {}
    installed_digest = protocol_digest()
    pinned = installed_digest if expected_digest is None else expected_digest
    canonical = protocol_document()

    def find(check: str, code: str, message: str) -> None:
        findings.append({"code": code, "check": check, "message": message})

    def attempt(check: str, action: Any) -> bool:
        try:
            action()
        except ProtocolError as exc:
            find(check, exc.code, exc.message)
            return False
        except (AttributeError, KeyError, TypeError) as exc:
            find(check, "openapi_malformed", f"deployment OpenAPI is malformed: {exc!r}")
            return False
        return True

    if document.get("openapi") != "3.1.0":
        find("openapi", "openapi_version", "served OpenAPI must declare version 3.1.0")
    if document.get("x-bim-protocol") != "bim-engine/v1":
        find("openapi", "openapi_protocol", "deployment OpenAPI must declare x-bim-protocol: bim-engine/v1")
    if document.get("x-bim-protocol-digest") != pinned:
        find("openapi", "openapi_digest_unpinned", "deployment OpenAPI does not pin the canonical bim-engine/v1 digest")
    if pinned != installed_digest:
        find("openapi", "protocol_not_installed", "registration does not pin the installed bim-engine/v1 contract")

    request_path = mapped.get("request", DEFAULT_MAPPINGS["request"])
    paths = document.get("paths", {})
    paths = paths if isinstance(paths, dict) else {}

    def operation_at(path: Any, method: str) -> Any:
        item = paths.get(path, {}) if isinstance(path, str) else {}
        return item.get(method) if isinstance(item, dict) else None

    operation = operation_at(request_path, "post")
    if not isinstance(operation, dict):
        find("solve", "openapi_operation_missing", "deployment OpenAPI does not describe the mapped solve operation")
    else:
        attempt("solve", lambda: assert_operation_auth(document, operation, auth_scheme, "solve operation"))
        canonical_operation = canonical["paths"][_CANONICAL_REQUEST_PATH]["post"]
        attempt("solve", lambda: assert_protocol_schema(
            "solve request",
            document,
            operation_schema(operation, request=True),
            canonical,
            operation_schema(canonical_operation, request=True),
        ))
        responses = operation.get("responses", {})
        if not isinstance(responses, dict) or not ({"200", "202"} & set(responses)):
            find(
                "solve",
                "openapi_responses_missing",
                "deployment OpenAPI does not describe a synchronous or asynchronous result",
            )
            responses = {}
        if "200" in responses:
            attempt("solve", lambda: assert_protocol_schema(
                "synchronous result",
                document,
                operation_schema(operation, response="200"),
                canonical,
                operation_schema(canonical_operation, response="200"),
            ))
        if "202" in responses:
            attempt("async", lambda: assert_protocol_schema(
                "asynchronous receipt",
                document,
                operation_schema(operation, response="202"),
                canonical,
                operation_schema(canonical_operation, response="202"),
            ))
            job_path = mapped.get("job")
            if not isinstance(job_path, str) or "{id}" not in job_path:
                find(
                    "async",
                    "openapi_job_path",
                    "an asynchronous deployment requires a mapped job path containing {id}",
                )
            else:
                job_operation = operation_at(job_path, "get")
                if not isinstance(job_operation, dict):
                    find(
                        "async",
                        "openapi_operation_missing",
                        "deployment OpenAPI does not describe the mapped async job operation",
                    )
                else:
                    attempt("async", lambda: assert_operation_auth(
                        document, job_operation, auth_scheme, "asynchronous job operation"
                    ))
                    canonical_job = canonical["paths"][_CANONICAL_JOB_PATH]["get"]
                    attempt("async", lambda: assert_protocol_schema(
                        "asynchronous job",
                        document,
                        operation_schema(job_operation, response="200"),
                        canonical,
                        operation_schema(canonical_job, response="200"),
                    ))

    health_path = mapped.get("health", DEFAULT_MAPPINGS["health"])
    health_operation = operation_at(health_path, "get")
    health_responses = health_operation.get("responses", {}) if isinstance(health_operation, dict) else {}
    if not isinstance(health_operation, dict) or not (
        isinstance(health_responses, dict) and "200" in health_responses
    ):
        find(
            "health",
            "openapi_health_missing",
            "deployment OpenAPI must describe the mapped GET health operation and its 200 response",
        )
    else:
        attempt("health", lambda: assert_operation_auth(document, health_operation, auth_scheme, "health operation"))
    return findings


# --- the deterministic probe -----------------------------------------------------------------


def conformance_shape(mode: Mapping[str, Any]) -> tuple[str, str, int]:
    """``(scalarization, objective type, objective count)`` of the probe for ``mode``."""
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
            if (
                not isinstance(scalarization, str)
                or not isinstance(objective_type, str)
                or objective_type not in _OBJECTIVE_TYPES
            ):
                continue
            if scalarization == "feasibility" and objective_type == "SINGLE" and minimum == 0:
                return scalarization, objective_type, 0
            objective_count = max(minimum, {"SINGLE": 1, "MULTI": 2, "MANY": 3}[objective_type])
            if objective_type == "MULTI" and objective_count > 3:
                continue
            if maximum is not None and objective_count > maximum:
                continue
            return scalarization, objective_type, objective_count
    raise ProtocolError(
        "conformance_no_shape", "Engine has no mode shape suitable for a deterministic conformance probe"
    )


def conformance_mode(engine: Mapping[str, Any]) -> Mapping[str, Any]:
    """The first mode of an Engine manifest that a deterministic probe can exercise."""
    modes = engine.get("spec", {}).get("modes", [])
    for mode in modes if isinstance(modes, list) else []:
        if not isinstance(mode, Mapping):
            continue
        try:
            conformance_shape(mode)
            return mode
        except ProtocolError:
            continue
    raise ProtocolError(
        "conformance_no_mode", "Engine has no published mode suitable for a deterministic conformance probe"
    )


def conformance_options(mode: Mapping[str, Any]) -> dict[str, Any]:
    """The default option values of ``mode`` (the probe runs with them)."""
    properties = mode.get("optionsSchema", {}).get("properties", {})
    if not isinstance(properties, Mapping):
        return {}
    return {
        name: copy.deepcopy(option["default"])
        for name, option in properties.items()
        if isinstance(name, str) and isinstance(option, Mapping) and "default" in option
    }


def conformance_problem(mode: Mapping[str, Any]) -> dict[str, Any]:
    """The compiled BindingProblem document of the probe: one task, one candidate, ``n`` zero-valued features."""
    scalarization, objective_type, objective_count = conformance_shape(mode)
    feature_ids = [f"probe-objective-{index + 1}" for index in range(objective_count)]
    application = {
        "apiVersion": "qos-binding/v1",
        "kind": "Application",
        "metadata": {"name": "probe-application"},
        "spec": {
            "tasks": {"probe-task": {"requires": "bim.conformance.probe"}},
            "features": {
                feature_id: {
                    "unit": "1",
                    "direction": "minimize",
                    "scope": "selectedCandidate",
                    "aggregation": "sum",
                    "domain": {"kind": "real", "minimum": 0, "maximum": 1},
                }
                for feature_id in feature_ids
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
            "featureBindings": {
                feature_id: {"resource": "probe-application", "id": feature_id}
                for feature_id in feature_ids
            },
            "candidates": {
                "probe-candidate": {
                    "provides": "bim.conformance.probe",
                    "features": {feature_id: 0 for feature_id in feature_ids},
                }
            }
        },
    }
    optimization = {
        "apiVersion": "qos-binding/v1",
        "kind": "Optimization",
        "metadata": {"name": "probe-optimization"},
        "spec": {
            "criteria": [
                {"id": feature_id, "feature": {"resource": "probe-application", "id": feature_id}}
                for feature_id in feature_ids
            ],
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


def conformance_optimization(mode: Mapping[str, Any]) -> dict[str, Any]:
    """The execution-time optimization the probe asks for, with equal weights."""
    scalarization, objective_type, objective_count = conformance_shape(mode)
    return {
        "type": objective_type,
        "scalarization": scalarization,
        "weights": [
            {"criteria": f"probe-objective-{index + 1}", "value": 1.0 / objective_count}
            for index in range(objective_count)
        ],
    }


#: The only correct answer of an engine to the probe.
EXPECTED_PROBE_BINDING = {"probe-task": {"resource": "probe-catalog", "id": "probe-candidate"}}


def assert_conformance_result(result: Mapping[str, Any]) -> None:
    """Judge an engine's (already validated) answer to the probe: it must contain the only possible binding."""
    solutions = result.get("solutions", [])
    bindings = [
        item["decision"].get("binding")
        for item in (solutions if isinstance(solutions, list) else [])
        if isinstance(item, dict) and isinstance(item.get("decision"), dict)
    ]
    if result.get("termination") not in ("OPTIMAL", "FEASIBLE") or EXPECTED_PROBE_BINDING not in bindings:
        raise ProtocolError("conformance_failed", "engine did not solve the deterministic conformance problem")
