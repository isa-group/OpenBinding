"""Validation and canonical lowering of a modular BIM v1 package."""

from __future__ import annotations

import json
import math
import os
import re
from copy import deepcopy
from dataclasses import dataclass
from decimal import Decimal
from functools import lru_cache
from pathlib import Path
from typing import Any, Iterable, Mapping

import jsonschema

from .canonical import canonical_json, digest, digest_bytes
from .expressions import Expression, ExpressionError, compile_expression
from .package import InstancePackage, PackageError, resource_digest


BIM_API_VERSION = "bim/v1"
PROFILE_ID = "qos-binding/v1"
QOS_API_VERSION = "qos-binding/v1"
CORE_DIALECT_ID = "qos-binding/v1"
BPMN_DIALECT_ID = "bpmn-workflow/v1"
PLACEMENT_DIALECT_ID = "qos-binding-placement/v1"
OMG_BPMN_API_VERSION = "omg/bpmn/2.0.2"

_ADDITIONAL_INSTALLED_PROFILES: dict[tuple[str, str, str, str], dict[str, Any]] = {}
_ADDITIONAL_INSTALLED_DIALECTS: dict[tuple[str, str, str, str], dict[str, Any]] = {}
_DIALECT_RESOURCE_LOWERERS: dict[
    tuple[str, str, str, str, str, str, str, str], Any,
] = {}
_DIALECT_EXTENSION_LOWERERS: dict[
    tuple[str, str, str, str, str, str, str, str], Any,
] = {}
_PROFILE_OUTPUT_VALIDATORS: dict[
    tuple[str, str, str, str, str], jsonschema.Draft202012Validator,
] = {}


def compiler_bundle_digest() -> str:
    """Digest every installed module that can change lowering or evaluation."""

    module_root = Path(__file__).parent
    members = {
        name: digest_bytes((module_root / name).read_bytes())
        for name in ("canonical.py", "compiler.py", "expressions.py", "package.py")
    }
    return digest(members)


def _schema_root() -> Path:
    configured = os.environ.get("SCHEMAS_DIR")
    if configured:
        return Path(configured) / "bim" / "v1"
    return Path(__file__).parents[4] / "schemas" / "bim" / "v1"


def installed_profile_manifests() -> list[dict[str, Any]]:
    """Return immutable container profiles backed by deployed local adapters.

    Profiles own role/cardinality, output-IR and capability vocabularies.  None
    of those service-binding concepts are rules of the BIM container itself.
    A versioned profile id is intentionally the only extra field an Instance
    author writes; its complete manifest and adapter are pinned in the IR.
    """

    schema_root = _schema_root()
    compiler_digest = compiler_bundle_digest()
    aggregation_values = [
        f"{context}.{operator}"
        for context, operators in {
            "sequence": ("sum", "product", "min", "max", "expression"),
            "parallel": ("sum", "product", "min", "max", "expression"),
            "exclusive": ("weightedSum", "weightedProduct", "min", "max", "expression"),
            "repeat": ("scale", "power", "identity", "expression"),
            "selection": ("sum", "product", "min", "max", "expression"),
        }.items()
        for operator in operators
    ]
    builtins = [
        {
            "apiVersion": BIM_API_VERSION,
            "kind": "Profile",
            "metadata": {
                "namespace": "bim.builtin",
                "name": "qos-binding",
                "version": "1.0.0",
                "description": "Deterministic scalar-QoS service composition and binding",
            },
            "spec": {
                "deterministic": True,
                "roles": {
                    "application": {
                        "resourceTypes": [
                            {"apiVersion": QOS_API_VERSION, "kind": "Application", "minimum": 1, "maximum": 1},
                            {"apiVersion": QOS_API_VERSION, "kind": "RoutingOverlay", "minimum": 0, "maximum": 1},
                            {"apiVersion": OMG_BPMN_API_VERSION, "kind": "BPMN", "minimum": 0},
                        ],
                        "extensionTypes": "installed",
                    },
                    "candidateCatalog": {
                        "resourceTypes": [
                            {"apiVersion": QOS_API_VERSION, "kind": "CandidateCatalog", "minimum": 1},
                        ],
                        "extensionTypes": "installed",
                    },
                    "constraintSet": {
                        "resourceTypes": [
                            {"apiVersion": QOS_API_VERSION, "kind": "ConstraintSet", "minimum": 0},
                        ],
                        "extensionTypes": "installed",
                    },
                    "optimization": {
                        "resourceTypes": [
                            {"apiVersion": QOS_API_VERSION, "kind": "Optimization", "minimum": 1, "maximum": 1},
                        ],
                        "extensionTypes": "installed",
                    },
                },
                "output": {
                    "apiVersion": BIM_API_VERSION,
                    "kind": "BindingProblem",
                    "schemaDigest": digest_bytes((schema_root / "binding-problem.schema.json").read_bytes()),
                    "engineProtocol": "bim-engine/v1",
                },
                "capabilityVocabulary": {
                    "dimensions": {
                        "workflowNodes": {
                            "values": [
                                "task", "empty", "sequence", "parallel",
                                "exclusive.conditional", "exclusive.probabilistic",
                                "repeat.count", "repeat.expectedCount",
                            ],
                            "openValues": False,
                        },
                        "aggregations": {"values": aggregation_values, "openValues": False},
                        "metricScopes": {"values": ["invocation", "selectedCandidate"], "openValues": False},
                        "constraints": {
                            "values": [
                                "hard.aggregate-bound", "hard.expression",
                                "soft.aggregate-bound", "soft.expression",
                            ],
                            "openValues": False,
                        },
                        "optimization": {
                            "values": ["satisfy", "weighted", "lexicographic", "pareto"],
                            "openValues": False,
                        },
                        "objectiveTypes": {
                            "values": ["MONO", "MULTI", "MANY"],
                            "openValues": False,
                        },
                        "expressions": {
                            "values": [
                                "literal", "not", "negate", "and", "or", "compare", "arithmetic",
                                "path.binding", "path.tasks", "path.metrics", "path.extensions",
                                "path.candidate", "path.capability", "path.values",
                                "path.weights", "path.count", "call.has", "call.min", "call.max",
                                "call.sum", "call.product", "call.weightedSum", "call.weightedProduct",
                            ],
                            "openValues": False,
                        },
                        "placement": {"values": ["placement"], "openValues": False},
                        "irExtensions": {"values": [], "openValues": True},
                    }
                },
                "limitVocabulary": [
                    "maxTasks", "maxCandidates", "minObjectives", "maxObjectives",
                    "maxIterations", "maxPopulation",
                    "maxSolutions", "maxTimeBudgetMs",
                ],
                "adapter": {"id": "qos-binding-profile", "version": "1.0.0", "binaryDigest": compiler_digest},
            },
        }
    ]
    return [*builtins, *_ADDITIONAL_INSTALLED_PROFILES.values()]


def manifest_id(manifest: Mapping[str, Any]) -> str:
    """Derive the stable public id without duplicating mutable identity fields."""

    metadata = manifest["metadata"]
    version = str(metadata["version"])
    match = re.fullmatch(
        r"([1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)"
        r"(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?"
        r"(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?",
        version,
    )
    if match is None:
        raise ValueError(f"manifest metadata.version is not SemVer: {version!r}")
    major = match.group(1)
    return f"{metadata['name']}/v{major}"


def _dialect_id(manifest: Mapping[str, Any]) -> str:
    return manifest_id(manifest)


def _dialect_resource_lowerer_key(
    manifest: Mapping[str, Any],
    api_version: str,
    kind: str,
    media_type: str,
) -> tuple[str, str, str, str, str, str, str, str]:
    adapter = manifest["spec"]["adapter"]
    return (
        _dialect_id(manifest),
        digest(manifest),
        str(adapter["id"]),
        str(adapter["version"]),
        str(adapter["binaryDigest"]),
        api_version,
        kind,
        media_type,
    )


def _dialect_extension_lowerer_key(
    manifest: Mapping[str, Any],
    target_api_version: str,
    target_kind: str,
    pointer: str,
) -> tuple[str, str, str, str, str, str, str, str]:
    adapter = manifest["spec"]["adapter"]
    return (
        _dialect_id(manifest),
        digest(manifest),
        str(adapter["id"]),
        str(adapter["version"]),
        str(adapter["binaryDigest"]),
        target_api_version,
        target_kind,
        pointer or "/",
    )


def _profile_output_key(
    manifest: Mapping[str, Any],
) -> tuple[str, str, str, str, str]:
    adapter = manifest["spec"]["adapter"]
    return (
        manifest_id(manifest),
        digest(manifest),
        str(adapter["id"]),
        str(adapter["version"]),
        str(adapter["binaryDigest"]),
    )


def installed_dialect_manifests() -> list[dict[str, Any]]:
    """Return immutable sublanguage contracts backed by local adapters.

    A published manifest is not an adapter installer.  Extending BIM therefore
    requires deploying an adapter first; the public manifest can only name and
    pin code and schemas that this process already has.  Keeping this registry
    beside lowering also prevents the catalog and the compiler from drifting.
    """

    schema_root = _schema_root()
    compiler_digest = compiler_bundle_digest()

    def resource_type(
        kind: str,
        filename: str,
        roles: list[str],
        *,
        api_version: str = QOS_API_VERSION,
        media_type: str = "application/json",
        xml_root: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        result: dict[str, Any] = {
            "apiVersion": api_version,
            "kind": kind,
            "roles": roles,
            "mediaType": media_type,
            "schemaDigest": digest_bytes((schema_root / filename).read_bytes()),
        }
        if xml_root is not None:
            result["xmlRoot"] = xml_root
        return result

    base_types = [
        resource_type("Application", "application.schema.json", ["application"]),
        resource_type("CandidateCatalog", "candidate-catalog.schema.json", ["candidateCatalog"]),
        resource_type("ConstraintSet", "constraint-set.schema.json", ["constraintSet"]),
        resource_type("Optimization", "optimization.schema.json", ["optimization"]),
        resource_type("RoutingOverlay", "routing-overlay.schema.json", ["application"]),
    ]
    bpmn_type = {
        "apiVersion": OMG_BPMN_API_VERSION,
        "kind": "BPMN",
        "roles": ["application"],
        "mediaType": "application/vnd.omg.bpmn+xml",
        "schemaDigest": digest_bytes(
            (Path(__file__).parent / "vendor" / "omg" / "bpmn" / "2.0.2" / "BPMN20.xsd").read_bytes()
        ),
        "xmlRoot": {
            "namespace": "http://www.omg.org/spec/BPMN/20100524/MODEL",
            "localName": "definitions",
        },
    }
    placement_type = resource_type(
        "Placement",
        "placement.schema.json",
        ["application"],
        api_version=PLACEMENT_DIALECT_ID,
    )
    builtins = [
        {
            "apiVersion": BIM_API_VERSION,
            "kind": "Dialect",
            "metadata": {
                "namespace": "bim.builtin",
                "name": "qos-binding",
                "version": "1.0.0",
            },
            "spec": {
                "compatibleProfiles": [PROFILE_ID],
                "resourceTypes": base_types,
                "extensionPoints": [],
                "irFeatures": [],
                "adapter": {"id": "bim-core", "version": "1.0.0", "binaryDigest": compiler_digest},
            },
        },
        {
            "apiVersion": BIM_API_VERSION,
            "kind": "Dialect",
            "metadata": {
                "namespace": "bim.builtin",
                "name": "bpmn-workflow",
                "version": "1.0.0",
            },
            "spec": {
                "compatibleProfiles": [PROFILE_ID],
                "resourceTypes": [bpmn_type],
                "extensionPoints": [],
                "irFeatures": [],
                "adapter": {"id": "bim-bpmn", "version": "1.0.0", "binaryDigest": compiler_digest},
            },
        },
        {
            "apiVersion": BIM_API_VERSION,
            "kind": "Dialect",
            "metadata": {
                "namespace": "bim.builtin",
                "name": "qos-binding-placement",
                "version": "1.0.0",
            },
            "spec": {
                "compatibleProfiles": [PROFILE_ID],
                "resourceTypes": [placement_type],
                "extensionPoints": [],
                "irFeatures": [
                    {"dimension": "placement", "value": "placement"},
                    {"dimension": "irExtensions", "value": PLACEMENT_DIALECT_ID},
                ],
                "adapter": {"id": "bim-placement", "version": "1.0.0", "binaryDigest": compiler_digest},
            },
        },
    ]
    return [*builtins, *_ADDITIONAL_INSTALLED_DIALECTS.values()]


def _dialect_descriptor(manifest: Mapping[str, Any]) -> dict[str, Any]:
    metadata = manifest["metadata"]
    adapter = manifest["spec"]["adapter"]
    return {
        "namespace": metadata["namespace"],
        "id": _dialect_id(manifest),
        "version": metadata["version"],
        "digest": digest(manifest),
        "irFeatures": manifest["spec"]["irFeatures"],
        "adapter": {
            "id": adapter["id"],
            "version": adapter["version"],
            "digest": adapter["binaryDigest"],
        },
    }


def _profile_descriptor(manifest: Mapping[str, Any]) -> dict[str, Any]:
    metadata = manifest["metadata"]
    spec = manifest["spec"]
    adapter = spec["adapter"]
    output = spec["output"]
    return {
        "namespace": metadata["namespace"],
        "id": manifest_id(manifest),
        "version": metadata["version"],
        "output": {
            "apiVersion": output["apiVersion"],
            "kind": output["kind"],
            "schemaDigest": output["schemaDigest"],
        },
        "deterministic": spec["deterministic"],
        "digest": digest(manifest),
        "adapter": {
            "id": adapter["id"],
            "version": adapter["version"],
            "digest": adapter["binaryDigest"],
        },
    }


@dataclass(frozen=True)
class CompileDiagnostic:
    code: str
    message: str
    resource: str | None = None
    pointer: str | None = None
    span: dict[str, int] | None = None
    bpmn_element: str | None = None
    ir_path: str | None = None
    related: tuple[dict[str, Any], ...] = ()

    def as_dict(self) -> dict[str, Any]:
        result: dict[str, Any] = {"code": self.code, "message": self.message}
        if self.resource:
            result["resource"] = self.resource
        if self.pointer:
            result["pointer"] = self.pointer
        if self.span:
            result["span"] = self.span
        if self.bpmn_element:
            result["bpmnElement"] = self.bpmn_element
        if self.ir_path:
            result["irPath"] = self.ir_path
        if self.related:
            result["related"] = list(self.related)
        return result


class CompileError(ValueError):
    def __init__(self, diagnostics: list[CompileDiagnostic]):
        self.diagnostics = diagnostics
        super().__init__("; ".join(d.message for d in diagnostics))


def _diagnostic_location(
    resource: str,
    pointer: str | None = None,
    *,
    bpmn_element: str | None = None,
) -> dict[str, str]:
    """Build a closed, navigable related-location object."""
    if bpmn_element is None and isinstance(pointer, str):
        suffix = Path(resource).suffix.casefold()
        segments = pointer.split("/")
        if suffix in {".bpmn", ".xml"} and len(segments) > 2 and segments[1] == "process":
            bpmn_element = segments[2] or None
    result = {"resource": resource}
    if pointer is not None:
        result["pointer"] = pointer
    if bpmn_element is not None:
        result["bpmnElement"] = bpmn_element
    return result


def _diag(
    code: str,
    message: str,
    resource: str | None = None,
    pointer: str | None = None,
    *,
    span: dict[str, int] | None = None,
    bpmn_element: str | None = None,
    ir_path: str | None = None,
    related: Iterable[dict[str, Any]] = (),
) -> CompileDiagnostic:
    if bpmn_element is None and isinstance(resource, str):
        bpmn_element = _diagnostic_location(resource, pointer).get("bpmnElement")
    return CompileDiagnostic(
        code=code,
        message=message,
        resource=resource,
        pointer=pointer,
        span=span,
        bpmn_element=bpmn_element,
        ir_path=ir_path,
        related=tuple(related),
    )


@lru_cache(maxsize=None)
def _schema_validator(kind: str) -> jsonschema.Draft202012Validator | None:
    schema_name = {
        "Instance": "instance.schema.json",
        "Profile": "profile.schema.json",
        "Dialect": "dialect.schema.json",
        "Engine": "engine.schema.json",
        "Application": "application.schema.json",
        "CandidateCatalog": "candidate-catalog.schema.json",
        "ConstraintSet": "constraint-set.schema.json",
        "Optimization": "optimization.schema.json",
        "RoutingOverlay": "routing-overlay.schema.json",
        "Placement": "placement.schema.json",
        "BindingProblem": "binding-problem.schema.json",
    }.get(kind)
    if schema_name is None:
        return None
    schema_path = _schema_root() / schema_name
    try:
        return jsonschema.Draft202012Validator(json.loads(schema_path.read_text(encoding="utf-8")))
    except (OSError, json.JSONDecodeError):
        return None


def _profile_output_validator(
    manifest: Mapping[str, Any],
) -> jsonschema.Draft202012Validator | None:
    """Resolve the exact locally installed output schema for one Profile."""

    try:
        builtin = installed_profile_manifests()[0]
        if digest(manifest) == digest(builtin):
            schema_path = _schema_root() / "binding-problem.schema.json"
            if digest_bytes(schema_path.read_bytes()) != manifest["spec"]["output"]["schemaDigest"]:
                return None
            return jsonschema.Draft202012Validator(
                json.loads(schema_path.read_text(encoding="utf-8"))
            )
        return _PROFILE_OUTPUT_VALIDATORS.get(_profile_output_key(manifest))
    except (KeyError, OSError, json.JSONDecodeError, TypeError, ValueError):
        return None


def _finite(value: Any, pointer: str, diagnostics: list[CompileDiagnostic], resource: str, *, nonnegative: bool = False) -> bool:
    if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(float(value)):
        diagnostics.append(_diag("finite_number", "value must be a finite scalar number", resource, pointer))
        return False
    if nonnegative and float(value) < 0:
        diagnostics.append(_diag("nonnegative_number", "value must be non-negative", resource, pointer))
        return False
    return True


def _ref_key(ref: Mapping[str, Any]) -> tuple[str, str]:
    return str(ref.get("resource", "")), str(ref.get("id", ""))


def _ref(resource: str, local_id: str) -> dict[str, str]:
    return {"resource": resource, "id": local_id}


def _validate_ref(value: Any, resource: str, pointer: str, diagnostics: list[CompileDiagnostic]) -> dict[str, str] | None:
    if not isinstance(value, dict) or set(value) != {"resource", "id"} or not all(isinstance(value.get(key), str) and value[key] for key in ("resource", "id")):
        diagnostics.append(_diag("reference", "reference must be exactly {resource,id}", resource, pointer))
        return None
    return _ref(value["resource"], value["id"])


def _envelope(
    document: Any,
    expected_kind: str,
    resource: str,
    *,
    expected_api_version: str = BIM_API_VERSION,
) -> list[CompileDiagnostic]:
    if not isinstance(document, dict):
        return [_diag("document_not_object", "resource must be a JSON object", resource)]
    diagnostics: list[CompileDiagnostic] = []
    if document.get("apiVersion") != expected_api_version:
        diagnostics.append(_diag("api_version", f"apiVersion must be {expected_api_version}", resource, "/apiVersion"))
    if document.get("kind") != expected_kind:
        diagnostics.append(_diag("kind", f"kind must be {expected_kind}", resource, "/kind"))
    if set(document) - {"apiVersion", "kind", "metadata", "spec"}:
        diagnostics.append(_diag("closed_envelope", "document envelope contains unknown properties", resource, "/"))
    metadata = document.get("metadata")
    if not isinstance(metadata, dict) or not isinstance(metadata.get("name"), str) or not metadata.get("name"):
        diagnostics.append(_diag("metadata_name", "metadata.name is required", resource, "/metadata/name"))
    if not isinstance(document.get("spec"), dict):
        diagnostics.append(_diag("spec", "spec must be an object", resource, "/spec"))
    return diagnostics


def _schema_diagnostics(document: dict[str, Any], kind: str, resource: str) -> list[CompileDiagnostic]:
    validator = _schema_validator(kind)
    if validator is None:
        return [_diag("schema_unavailable", f"schema is unavailable for {kind}", resource)]
    diagnostics: list[CompileDiagnostic] = []
    for error in validator.iter_errors(document):
        pointer = "/" + "/".join(
            _json_pointer_segment(str(part)) for part in error.absolute_path
        )
        diagnostics.append(_diag(
            "schema",
            error.message,
            resource,
            pointer,
            ir_path=pointer if kind == "BindingProblem" else None,
        ))
    return diagnostics


_INSTALLED_JSON_RESOURCE_SCHEMAS = {
    (QOS_API_VERSION, "Application", "application/json"): "application.schema.json",
    (QOS_API_VERSION, "CandidateCatalog", "application/json"): "candidate-catalog.schema.json",
    (QOS_API_VERSION, "ConstraintSet", "application/json"): "constraint-set.schema.json",
    (QOS_API_VERSION, "Optimization", "application/json"): "optimization.schema.json",
    (QOS_API_VERSION, "RoutingOverlay", "application/json"): "routing-overlay.schema.json",
    (PLACEMENT_DIALECT_ID, "Placement", "application/json"): "placement.schema.json",
}

_QOS_PROFILE_NATIVE_RESOURCE_TYPES = {
    *_INSTALLED_JSON_RESOURCE_SCHEMAS,
    (OMG_BPMN_API_VERSION, "BPMN", "application/vnd.omg.bpmn+xml"),
}

_ADDITIONAL_RESOURCE_SCHEMA_VALIDATORS: dict[
    tuple[str, str, str], jsonschema.Draft202012Validator,
] = {}


@lru_cache(maxsize=None)
def _resource_schema_validator(
    api_version: str,
    kind: str,
    media_type: str,
) -> jsonschema.Draft202012Validator | None:
    """Resolve validators by full sublanguage identity, never by kind alone."""

    filename = _INSTALLED_JSON_RESOURCE_SCHEMAS.get((api_version, kind, media_type))
    if filename is None:
        return _ADDITIONAL_RESOURCE_SCHEMA_VALIDATORS.get((api_version, kind, media_type))
    try:
        return jsonschema.Draft202012Validator(
            json.loads((_schema_root() / filename).read_text(encoding="utf-8"))
        )
    except (OSError, json.JSONDecodeError):
        return None


def _resource_schema_diagnostics(
    document: dict[str, Any],
    api_version: str,
    kind: str,
    media_type: str,
    resource: str,
) -> list[CompileDiagnostic]:
    validator = _resource_schema_validator(api_version, kind, media_type)
    if validator is None:
        return [_diag(
            "schema_unavailable",
            f"installed dialect schema is unavailable for {api_version!r} {kind!r} ({media_type})",
            resource,
        )]
    return [
        _diag("schema", error.message, resource, "/" + "/".join(str(part) for part in error.absolute_path))
        for error in validator.iter_errors(document)
    ]


_INSTALLED_EXTENSION_VALIDATORS: dict[
    tuple[str, str, str, str, str],
    jsonschema.Draft202012Validator,
] = {}


def install_extension_validator(
    dialect: Mapping[str, Any],
    target_api_version: str,
    target_kind: str,
    pointer: str,
    schema: Mapping[str, Any],
) -> None:
    """Register a locally deployed inline-extension schema by exact pins.

    This is deliberately an installation API, not a package or public-manifest
    code-loading mechanism.  The caller must already have the Dialect adapter
    deployed in-process; its public contract and the supplied schema are
    accepted only when their digests match exactly.
    """

    dialect_id = _dialect_id(dialect)
    normalized_pointer = pointer or "/"
    matching = [
        point
        for point in dialect.get("spec", {}).get("extensionPoints", [])
        if point.get("target") == {"apiVersion": target_api_version, "kind": target_kind}
        and point.get("pointer") == normalized_pointer
    ]
    if len(matching) != 1:
        raise ValueError("Dialect does not declare exactly one matching extension point")
    actual_digest = digest(schema)
    if actual_digest != matching[0].get("schemaDigest"):
        raise ValueError("installed extension schema does not match the Dialect schemaDigest")
    jsonschema.Draft202012Validator.check_schema(dict(schema))
    _INSTALLED_EXTENSION_VALIDATORS[(
        dialect_id,
        target_api_version,
        target_kind,
        normalized_pointer,
        actual_digest,
    )] = jsonschema.Draft202012Validator(dict(schema))


def uninstall_extension_validator(
    dialect_id: str,
    target_api_version: str,
    target_kind: str,
    pointer: str,
    schema_digest: str,
) -> None:
    """Remove a validator from the local adapter registry (primarily tests)."""

    _INSTALLED_EXTENSION_VALIDATORS.pop((
        dialect_id,
        target_api_version,
        target_kind,
        pointer or "/",
        schema_digest,
    ), None)


def _check_extensions(
    value: Any,
    resource: str,
    pointer: str,
    diagnostics: list[CompileDiagnostic],
    dialects: Iterable[Mapping[str, Any]],
    target_api_version: str,
    target_kind: str,
    used_dialects: set[str],
) -> None:
    if isinstance(value, dict):
        extensions = value.get("extensions")
        if isinstance(extensions, dict):
            installed = {_dialect_id(manifest): manifest for manifest in dialects}
            for namespace, payload in extensions.items():
                dialect = installed.get(namespace)
                if dialect is None:
                    diagnostics.append(_diag(
                        "unsupported_extension",
                        f"extension {namespace!r} is not installed for this profile",
                        resource,
                        pointer + "/extensions",
                    ))
                    continue
                points = [
                    point
                    for point in dialect.get("spec", {}).get("extensionPoints", [])
                    if point.get("target") == {
                        "apiVersion": target_api_version,
                        "kind": target_kind,
                    }
                    and point.get("pointer") == (pointer or "/")
                ]
                if len(points) != 1:
                    diagnostics.append(_diag(
                        "unsupported_extension_point",
                        f"dialect {namespace!r} does not declare extension point {target_api_version!r} {target_kind!r} at {pointer or '/'}",
                        resource,
                        pointer + "/extensions",
                    ))
                    continue
                point = points[0]
                validator = _INSTALLED_EXTENSION_VALIDATORS.get((
                    namespace,
                    target_api_version,
                    target_kind,
                    pointer or "/",
                    str(point["schemaDigest"]),
                ))
                if validator is None:
                    diagnostics.append(_diag(
                        "extension_schema_unavailable",
                        f"extension {namespace!r} has no installed validator at its pinned schema digest",
                        resource,
                        pointer + "/extensions",
                    ))
                    continue
                extension_errors = list(validator.iter_errors(payload))
                diagnostics.extend(
                    _diag(
                        "extension_schema",
                        error.message,
                        resource,
                        pointer + "/extensions/" + namespace + "/" + "/".join(str(part) for part in error.absolute_path),
                    )
                    for error in extension_errors
                )
                if not extension_errors:
                    used_dialects.add(namespace)
        for key, child in value.items():
            if key == "extensions":
                continue
            _check_extensions(
                child,
                resource,
                f"{pointer}/{key}",
                diagnostics,
                dialects,
                target_api_version,
                target_kind,
                used_dialects,
            )
    elif isinstance(value, list):
        for index, child in enumerate(value):
            _check_extensions(
                child,
                resource,
                f"{pointer}/{index}",
                diagnostics,
                dialects,
                target_api_version,
                target_kind,
                used_dialects,
            )


def _lower_inline_extensions(
    value: Any,
    *,
    resource_id: str,
    resource_path: str,
    target_api_version: str,
    target_kind: str,
    pointer: str,
    profile: Mapping[str, Any],
    dialects: Mapping[str, Mapping[str, Any]],
    diagnostics: list[CompileDiagnostic],
    source_map: dict[str, Any],
    out: dict[str, Any],
) -> None:
    """Validate-to-IR boundary for installed inline Dialect payloads.

    Validation alone cannot assign semantics.  Each accepted payload is sent
    through the exact deployed lowerer pinned by its Dialect manifest.  The
    source value is never copied into IR as an implicit passthrough language.
    """

    if isinstance(value, dict):
        extensions = value.get("extensions")
        if isinstance(extensions, dict):
            for dialect_id, payload in sorted(extensions.items()):
                dialect = dialects.get(dialect_id)
                if dialect is None:
                    continue  # `_check_extensions` already emitted the diagnostic.
                lowerer = _DIALECT_EXTENSION_LOWERERS.get(
                    _dialect_extension_lowerer_key(
                        dialect,
                        target_api_version,
                        target_kind,
                        pointer or "/",
                    )
                )
                if lowerer is None:
                    diagnostics.append(_diag(
                        "extension_lowering_unavailable",
                        f"Dialect {dialect_id!r} has no deployed lowering for inline extension point {pointer or '/'}",
                        resource_path,
                        f"{pointer}/extensions/{_json_pointer_segment(dialect_id)}",
                    ))
                    continue
                context = {
                    "profile": _profile_descriptor(profile),
                    "dialect": _dialect_descriptor(dialect),
                    "target": {
                        "resource": resource_id,
                        "apiVersion": target_api_version,
                        "kind": target_kind,
                        "pointer": pointer or "/",
                    },
                }

                def invoke(
                    installed_lowerer: Any = lowerer,
                    source_payload: Any = payload,
                    lowering_context: Mapping[str, Any] = context,
                ) -> bytes:
                    lowered = installed_lowerer(
                        json.loads(json.dumps(source_payload)),
                        json.loads(json.dumps(lowering_context)),
                    )
                    if not isinstance(lowered, dict):
                        raise ValueError("inline extension lowering must return a JSON object")
                    return canonical_json(lowered)

                try:
                    first = invoke()
                    second = invoke()
                except Exception as exc:
                    diagnostics.append(_diag(
                        "extension_lowering",
                        f"Dialect {dialect_id!r} could not lower inline extension: {exc}",
                        resource_path,
                        f"{pointer}/extensions/{_json_pointer_segment(dialect_id)}",
                    ))
                    continue
                if first != second:
                    diagnostics.append(_diag(
                        "extension_lowering_nondeterministic",
                        f"Dialect {dialect_id!r} produced different canonical inline results for the same payload",
                        resource_path,
                        f"{pointer}/extensions/{_json_pointer_segment(dialect_id)}",
                    ))
                    continue
                location = f"{resource_id}:{pointer or '/'}"
                inline = out.setdefault(dialect_id, {}).setdefault("inline", {})
                if location in inline:
                    diagnostics.append(_diag(
                        "extension_lowering_collision",
                        f"inline Dialect output collides at {location!r}",
                        resource_path,
                        pointer or "/",
                    ))
                    continue
                inline[location] = json.loads(first)
                ir_pointer = (
                    f"/spec/extensions/{_json_pointer_segment(dialect_id)}"
                    f"/inline/{_json_pointer_segment(location)}"
                )
                source_map[ir_pointer] = {
                    "resource": resource_id,
                    "path": resource_path,
                    "pointer": f"{pointer}/extensions/{_json_pointer_segment(dialect_id)}",
                }
        for key, child in value.items():
            if key == "extensions":
                continue
            _lower_inline_extensions(
                child,
                resource_id=resource_id,
                resource_path=resource_path,
                target_api_version=target_api_version,
                target_kind=target_kind,
                pointer=f"{pointer}/{key}",
                profile=profile,
                dialects=dialects,
                diagnostics=diagnostics,
                source_map=source_map,
                out=out,
            )
    elif isinstance(value, list):
        for index, child in enumerate(value):
            _lower_inline_extensions(
                child,
                resource_id=resource_id,
                resource_path=resource_path,
                target_api_version=target_api_version,
                target_kind=target_kind,
                pointer=f"{pointer}/{index}",
                profile=profile,
                dialects=dialects,
                diagnostics=diagnostics,
                source_map=source_map,
                out=out,
            )


def _json_pointer_segment(value: str) -> str:
    return value.replace("~", "~0").replace("/", "~1")


def _lower_installed_dialect_resources(
    resources: Mapping[str, _Resource],
    dialects: Mapping[str, Mapping[str, Any]],
    profile: Mapping[str, Any],
    diagnostics: list[CompileDiagnostic],
    source_map: dict[str, Any],
) -> dict[str, Any]:
    """Lower non-native resources through their exact deployed Dialect ABI.

    The callable is installed by the host and pinned by the Dialect manifest;
    source packages cannot supply code or installation URLs.  Calling it twice
    protects a deterministic Profile from accidentally installed stateful or
    random lowering, while JCS validation prevents non-portable JSON values.
    """

    lowered: dict[str, dict[str, Any]] = {}
    profile_descriptor = _profile_descriptor(profile)
    for resource_id, resource in sorted(resources.items()):
        media_type = (
            "application/vnd.omg.bpmn+xml" if resource.xml is not None
            else "application/json"
        )
        identity = (resource.api_version, resource.kind, media_type)
        if identity in _QOS_PROFILE_NATIVE_RESOURCE_TYPES:
            continue
        dialect = dialects.get(resource.dialect_id)
        if dialect is None:
            diagnostics.append(_diag(
                "dialect_lowering_unavailable",
                f"resource {resource_id!r} resolved to unavailable Dialect {resource.dialect_id!r}",
                resource.path,
                "/",
            ))
            continue
        lowerer = _DIALECT_RESOURCE_LOWERERS.get(_dialect_resource_lowerer_key(
            dialect,
            resource.api_version,
            resource.kind,
            media_type,
        ))
        if lowerer is None:
            diagnostics.append(_diag(
                "dialect_lowering_unavailable",
                f"Dialect {resource.dialect_id!r} has no deployed lowering for {resource.api_version!r} {resource.kind!r}",
                resource.path,
                "/",
            ))
            continue
        context = {
            "profile": profile_descriptor,
            "dialect": _dialect_descriptor(dialect),
            "resource": {
                "id": resource.id,
                "role": resource.role,
                "apiVersion": resource.api_version,
                "kind": resource.kind,
            },
        }

        def invoke(
            installed_lowerer: Any = lowerer,
            source_document: Mapping[str, Any] = resource.document,
            lowering_context: Mapping[str, Any] = context,
        ) -> bytes:
            value = installed_lowerer(
                json.loads(json.dumps(source_document)),
                json.loads(json.dumps(lowering_context)),
            )
            if not isinstance(value, dict):
                raise ValueError("lowering must return a JSON object")
            return canonical_json(value)

        try:
            first = invoke()
            second = invoke()
        except Exception as exc:
            diagnostics.append(_diag(
                "dialect_lowering",
                f"Dialect {resource.dialect_id!r} could not lower resource: {exc}",
                resource.path,
                "/",
            ))
            continue
        if first != second:
            diagnostics.append(_diag(
                "dialect_lowering_nondeterministic",
                f"Dialect {resource.dialect_id!r} produced different canonical results for the same resource",
                resource.path,
                "/",
            ))
            continue
        payload = json.loads(first)
        lowered.setdefault(resource.dialect_id, {})[resource_id] = payload
        ir_pointer = (
            f"/spec/extensions/{_json_pointer_segment(resource.dialect_id)}"
            f"/resources/{_json_pointer_segment(resource_id)}"
        )
        source_map[ir_pointer] = {
            "resource": resource.id,
            "path": resource.path,
            "pointer": "/",
        }
    return {
        dialect_id: {"resources": payloads}
        for dialect_id, payloads in sorted(lowered.items())
    }


@dataclass(frozen=True)
class _Resource:
    id: str
    role: str
    api_version: str
    kind: str
    dialect_id: str
    path: str
    document: dict[str, Any]
    xml: Any = None
    digest: str | None = None
    registered: dict[str, str] | None = None


@dataclass(frozen=True)
class RegisteredResource:
    """One already approved local registry revision available to the compiler."""

    content: bytes
    media_type: str


@dataclass(frozen=True)
class ResolvedInstance:
    """Profile-neutral result of the BIM container resolution phase.

    The core resolves the root index, roles, cardinalities, registered/local
    references and exact Dialect schemas once.  A Profile adapter receives
    this closed context and owns only domain lowering; it never reparses an
    unchecked package or reimplements container rules.
    """

    package: InstancePackage
    profile: Mapping[str, Any]
    resources: dict[str, _Resource]
    resources_by_type: dict[tuple[str, str], list[_Resource]]
    instance: dict[str, Any]
    inline_dialects: set[str]


def instance_digest(instance: dict[str, Any], resource_digests: Mapping[str, str] | None = None) -> str:
    """Digest the logical index together with every exact source resource."""
    normalized = json.loads(json.dumps(instance))
    payload = {
        "instance": normalized,
        "resources": {path: value for path, value in sorted((resource_digests or {}).items()) if path != "instance.json"},
    }
    return digest(payload)


@lru_cache(maxsize=1)
def installed_framework_diagnostics() -> tuple[str, ...]:
    """Validate the deployed Profile/Dialect registry as one closed ABI.

    JSON Schema validates each manifest in isolation.  These checks validate
    the relationships that make BIM an extensible container without making
    profile semantics part of the container itself: identities are unique,
    every dialect names an installed profile, roles and feature vocabularies
    come from that profile, and every base resource type has a deployed
    dialect adapter.
    """

    diagnostics: list[str] = []
    profiles = installed_profile_manifests()
    dialects = installed_dialect_manifests()
    profile_validator = _schema_validator("Profile")
    dialect_validator = _schema_validator("Dialect")
    profile_by_id: dict[str, Mapping[str, Any]] = {}
    dialect_by_id: dict[str, Mapping[str, Any]] = {}

    for manifest in profiles:
        if profile_validator is None:
            diagnostics.append("the installed Profile schema is unavailable")
            break
        diagnostics.extend(
            f"Profile {manifest.get('metadata', {}).get('name', '?')}: {error.message}"
            for error in sorted(profile_validator.iter_errors(manifest), key=lambda item: list(item.absolute_path))
        )
        try:
            identity = manifest_id(manifest)
        except (KeyError, TypeError, ValueError) as exc:
            diagnostics.append(f"invalid installed Profile identity: {exc}")
            continue
        if identity in profile_by_id:
            diagnostics.append(f"duplicate installed Profile id {identity!r}")
        profile_by_id[identity] = manifest
        if _profile_output_validator(manifest) is None:
            diagnostics.append(
                f"Profile {identity!r} has no installed output schema at its pinned digest"
            )
        roles = manifest.get("spec", {}).get("roles", {})
        for role, contract in roles.items() if isinstance(roles, Mapping) else ():
            for resource_type in contract.get("resourceTypes", []) if isinstance(contract, Mapping) else ():
                minimum = resource_type.get("minimum")
                maximum = resource_type.get("maximum")
                if isinstance(minimum, int) and isinstance(maximum, int) and maximum < minimum:
                    diagnostics.append(
                        f"Profile {identity!r} role {role!r} has maximum below minimum"
                    )

    claims: dict[tuple[str, str, str, str], list[str]] = {}
    xml_claims: dict[tuple[str, str, str, str], list[str]] = {}
    for manifest in dialects:
        if dialect_validator is None:
            diagnostics.append("the installed Dialect schema is unavailable")
            break
        diagnostics.extend(
            f"Dialect {manifest.get('metadata', {}).get('name', '?')}: {error.message}"
            for error in sorted(dialect_validator.iter_errors(manifest), key=lambda item: list(item.absolute_path))
        )
        try:
            identity = _dialect_id(manifest)
        except (KeyError, TypeError, ValueError) as exc:
            diagnostics.append(f"invalid installed Dialect identity: {exc}")
            continue
        if identity in dialect_by_id:
            diagnostics.append(f"duplicate installed Dialect id {identity!r}")
        dialect_by_id[identity] = manifest
        spec = manifest.get("spec", {})
        compatible_profiles = spec.get("compatibleProfiles", []) if isinstance(spec, Mapping) else []
        for profile_id in compatible_profiles:
            profile = profile_by_id.get(profile_id)
            if profile is None:
                diagnostics.append(f"Dialect {identity!r} names unavailable Profile {profile_id!r}")
                continue
            roles = profile["spec"]["roles"]
            vocabulary = profile["spec"]["capabilityVocabulary"]["dimensions"]
            for resource_type in spec.get("resourceTypes", []):
                for role in resource_type.get("roles", []):
                    if role not in roles:
                        diagnostics.append(
                            f"Dialect {identity!r} exposes resource type in undeclared role {role!r}"
                        )
                claim = (
                    profile_id,
                    str(resource_type.get("apiVersion")),
                    str(resource_type.get("kind")),
                    str(resource_type.get("mediaType")),
                )
                claims.setdefault(claim, []).append(identity)
                xml_root = resource_type.get("xmlRoot")
                if isinstance(xml_root, Mapping):
                    xml_claim = (
                        profile_id,
                        str(resource_type.get("mediaType")),
                        str(xml_root.get("namespace")),
                        str(xml_root.get("localName")),
                    )
                    xml_claims.setdefault(xml_claim, []).append(identity)
            for feature in spec.get("irFeatures", []):
                dimension = vocabulary.get(feature.get("dimension"))
                if not isinstance(dimension, Mapping):
                    diagnostics.append(
                        f"Dialect {identity!r} uses unknown capability dimension {feature.get('dimension')!r}"
                    )
                elif not dimension.get("openValues") and feature.get("value") not in dimension.get("values", []):
                    diagnostics.append(
                        f"Dialect {identity!r} uses unknown closed feature value {feature.get('value')!r}"
                    )
            known_targets = {
                (item.get("apiVersion"), item.get("kind"))
                for candidate in dialects
                if profile_id in candidate.get("spec", {}).get("compatibleProfiles", [])
                for item in candidate.get("spec", {}).get("resourceTypes", [])
            }
            for point in spec.get("extensionPoints", []):
                target = point.get("target", {})
                if (target.get("apiVersion"), target.get("kind")) not in known_targets:
                    diagnostics.append(
                        f"Dialect {identity!r} extends unavailable type "
                        f"{target.get('apiVersion')!r} {target.get('kind')!r}"
                    )

    for claim, owners in claims.items():
        if len(owners) > 1:
            diagnostics.append(f"ambiguous installed resource type {claim!r}: {owners!r}")
    for claim, owners in xml_claims.items():
        if len(owners) > 1:
            diagnostics.append(f"ambiguous installed XML root {claim!r}: {owners!r}")
    for profile_id, profile in profile_by_id.items():
        compatible = [
            dialect
            for dialect in dialects
            if profile_id in dialect.get("spec", {}).get("compatibleProfiles", [])
        ]
        claimed_identities = {
            (resource_type.get("apiVersion"), resource_type.get("kind"))
            for dialect in compatible
            for resource_type in dialect.get("spec", {}).get("resourceTypes", [])
        }
        for role, contract in profile["spec"]["roles"].items():
            for resource_type in contract.get("resourceTypes", []):
                identity = (resource_type.get("apiVersion"), resource_type.get("kind"))
                if identity not in claimed_identities:
                    diagnostics.append(
                        f"Profile {profile_id!r} role {role!r} requires resource type {identity!r} "
                        "without an installed Dialect"
                    )
    return tuple(diagnostics)


def installed_profile(profile_id: str) -> dict[str, Any] | None:
    """Resolve a versioned profile only from the immutable local registry."""

    return next(
        (manifest for manifest in installed_profile_manifests() if manifest_id(manifest) == profile_id),
        None,
    )


def _compatible_dialects(profile_id: str) -> list[dict[str, Any]]:
    return [
        manifest
        for manifest in installed_dialect_manifests()
        if profile_id in manifest.get("spec", {}).get("compatibleProfiles", [])
    ]


def _dialect_type_matches(
    dialects: Iterable[Mapping[str, Any]],
    api_version: str,
    kind: str,
    media_type: str,
) -> list[tuple[Mapping[str, Any], Mapping[str, Any]]]:
    return [
        (dialect, resource_type)
        for dialect in dialects
        for resource_type in dialect.get("spec", {}).get("resourceTypes", [])
        if resource_type.get("apiVersion") == api_version
        and resource_type.get("kind") == kind
        and resource_type.get("mediaType") == media_type
    ]


def _dialect_xml_type_matches(
    dialects: Iterable[Mapping[str, Any]],
    namespace: str,
    local_name: str,
    media_type: str | None = None,
) -> list[tuple[Mapping[str, Any], Mapping[str, Any]]]:
    return [
        (dialect, resource_type)
        for dialect in dialects
        for resource_type in dialect.get("spec", {}).get("resourceTypes", [])
        if (media_type is None or resource_type.get("mediaType") == media_type)
        and resource_type.get("xmlRoot") == {
            "namespace": namespace,
            "localName": local_name,
        }
    ]


def _resource_index(
    package: InstancePackage,
    profile: Mapping[str, Any],
    registered_resources: Mapping[tuple[str, str, str, str], RegisteredResource] | None = None,
) -> tuple[
    dict[str, _Resource],
    dict[tuple[str, str], list[_Resource]],
    dict[str, Any],
    list[CompileDiagnostic],
    set[str],
]:
    diagnostics: list[CompileDiagnostic] = []
    try:
        instance = package.json("instance.json")
    except PackageError as exc:
        raise CompileError([_diag("instance", str(exc), "instance.json")]) from exc
    diagnostics.extend(_envelope(instance, "Instance", "instance.json"))
    diagnostics.extend(_schema_diagnostics(instance, "Instance", "instance.json"))
    profile_id = manifest_id(profile)
    if instance.get("spec", {}).get("profile") != profile_id:
        diagnostics.append(_diag(
            "profile",
            f"Instance profile must resolve to installed profile {profile_id!r}",
            "instance.json",
            "/spec/profile",
        ))
    dialects = _compatible_dialects(profile_id)
    used_extension_dialects: set[str] = set()
    _check_extensions(
        instance,
        "instance.json",
        "",
        diagnostics,
        dialects,
        BIM_API_VERSION,
        "Instance",
        used_extension_dialects,
    )
    resources_source = instance.get("spec", {}).get("resources", {})
    if not isinstance(resources_source, dict):
        return {}, {}, instance, diagnostics, used_extension_dialects
    roles = profile.get("spec", {}).get("roles", {})
    known_types = {
        (resource_type["apiVersion"], resource_type["kind"])
        for manifest in dialects
        for resource_type in manifest.get("spec", {}).get("resourceTypes", [])
        if isinstance(resource_type, Mapping)
        and isinstance(resource_type.get("apiVersion"), str)
        and isinstance(resource_type.get("kind"), str)
    }
    indexed: dict[str, _Resource] = {}
    by_type: dict[tuple[str, str], list[_Resource]] = {identity: [] for identity in known_types}
    paths: dict[str, dict[str, str]] = {}
    declared_ids: dict[str, dict[str, str]] = {}
    registry = registered_resources or {}
    for role, group in resources_source.items():
        if not isinstance(group, dict):
            continue
        role_contract = roles.get(role) if isinstance(roles, Mapping) else None
        if not isinstance(role_contract, Mapping):
            diagnostics.append(_diag(
                "profile_role",
                f"role {role!r} is not declared by profile {profile_id!r}",
                "instance.json",
                f"/spec/resources/{role}",
            ))
        for resource_id, target in group.items():
            pointer = f"/spec/resources/{role}/{resource_id}"
            if resource_id in declared_ids:
                diagnostics.append(_diag(
                    "resource_id_duplicate",
                    f"duplicate resource id {resource_id!r}",
                    "instance.json",
                    pointer,
                    related=(declared_ids[resource_id],),
                ))
                continue
            declared_ids[resource_id] = _diagnostic_location("instance.json", pointer)
            registered: dict[str, str] | None = None
            resolved: RegisteredResource | None = None
            if isinstance(target, dict):
                if not all(isinstance(target.get(key), str) for key in ("namespace", "name", "version", "digest")):
                    continue
                registered = {key: str(target[key]) for key in ("namespace", "name", "version", "digest")}
                key = (
                    registered["namespace"],
                    registered["name"],
                    registered["version"],
                    registered["digest"],
                )
                resolved = registry.get(key)
                if resolved is None:
                    diagnostics.append(_diag(
                        "registered_ref_unresolved",
                        "registered resource is not installed, approved, and available at the pinned digest",
                        "instance.json",
                        pointer,
                    ))
                    continue
                is_xml = resolved.media_type in {"application/xml", "text/xml"} or resolved.media_type.endswith("+xml")
                declared_xml_media_type = resolved.media_type if is_xml else None
                synthetic_path = "registered.bpmn" if is_xml else "registered.json"
                try:
                    actual_digest = resource_digest(synthetic_path, resolved.content)
                except PackageError as exc:
                    diagnostics.append(_diag("registered_resource", str(exc), "instance.json", pointer))
                    continue
                if actual_digest != registered["digest"]:
                    diagnostics.append(_diag(
                        "registered_digest",
                        f"registered resource digest is {actual_digest}, not pinned {registered['digest']}",
                        "instance.json",
                        pointer,
                    ))
                    continue
                path = (
                    f"@{registered['namespace']}/{registered['name']}"
                    f"/{registered['version']}"
                )
                parser_package = InstancePackage({
                    "instance.json": b"{}",
                    synthetic_path: resolved.content,
                })
                resource_hash = actual_digest
            elif isinstance(target, str):
                path = target
                if path in paths:
                    diagnostics.append(_diag(
                        "resource_path_duplicate",
                        f"duplicate resource path {path!r}",
                        "instance.json",
                        pointer,
                        related=(paths[path],),
                    ))
                    continue
                paths[path] = _diagnostic_location("instance.json", pointer)
                parser_package = package
                synthetic_path = path
                resource_hash = package.digest(path) if path in package.files else None
                suffix = Path(path).suffix.lower()
                is_xml = suffix in {".bpmn", ".xml"}
                declared_xml_media_type = "application/vnd.omg.bpmn+xml" if suffix == ".bpmn" else None
            else:
                continue
            try:
                if is_xml:
                    xml = parser_package.xml_root(synthetic_path)
                    if isinstance(xml.tag, str) and xml.tag.startswith("{") and "}" in xml.tag:
                        namespace, local_name = xml.tag[1:].split("}", 1)
                    else:
                        namespace, local_name = "", str(xml.tag)
                    matches = _dialect_xml_type_matches(
                        dialects,
                        namespace,
                        local_name,
                        declared_xml_media_type,
                    )
                    if not matches:
                        diagnostics.append(_diag(
                            "unsupported_dialect",
                            f"no installed XML dialect for QName {{{namespace}}}{local_name}"
                            + (f" ({declared_xml_media_type})" if declared_xml_media_type else "")
                            + f" in profile {profile_id!r}",
                            path,
                            "/",
                        ))
                        continue
                    if len(matches) > 1:
                        diagnostics.append(_diag(
                            "ambiguous_dialect",
                            f"more than one installed dialect claims XML QName {{{namespace}}}{local_name}"
                            + (f" ({declared_xml_media_type})" if declared_xml_media_type else ""),
                            path,
                            "/",
                        ))
                        continue
                    dialect, resource_type = matches[0]
                    api_version = str(resource_type["apiVersion"])
                    kind = str(resource_type["kind"])
                    media_type = str(resource_type["mediaType"])
                    # Parser/schema execution belongs to the installed adapter,
                    # after the generic container resolved the QName contract.
                    if dialect["spec"]["adapter"]["id"] == "bim-bpmn":
                        xml = parser_package.xml(synthetic_path)
                    document = {"apiVersion": api_version, "kind": kind, "metadata": {"name": resource_id}, "spec": {}}
                else:
                    xml = None
                    document = parser_package.json(synthetic_path)
                    kind = document.get("kind") if isinstance(document, dict) else None
                    api_version = document.get("apiVersion") if isinstance(document, dict) else None
                    media_type = "application/json"
                    if not isinstance(api_version, str) or not isinstance(kind, str):
                        diagnostics.append(_diag("resource_identity", "resource requires string apiVersion and kind", path, "/"))
                        continue
                    if registered is not None:
                        metadata = document.get("metadata", {})
                        if metadata.get("name") != registered["name"] or metadata.get("version") != registered["version"]:
                            diagnostics.append(_diag(
                                "registered_identity",
                                "registered JSON metadata.name/version must match its pinned registry identity",
                                path,
                                "/metadata",
                            ))
            except PackageError as exc:
                error_message = str(exc)
                id_match = re.search(r"attribute 'id': '([^']+)'", error_message) if is_xml else None
                bpmn_element = id_match.group(1) if id_match else None
                error_pointer = f"/process/{bpmn_element}" if bpmn_element else "/"
                related: tuple[dict[str, str], ...] = ()
                if bpmn_element:
                    try:
                        location_root = parser_package.xml_root(synthetic_path)
                        occurrences = sum(
                            1
                            for element in location_root.iter()
                            if element.get("id") == bpmn_element
                        )
                    except PackageError:
                        occurrences = 0
                    if occurrences > 1:
                        related = (_diagnostic_location(path, error_pointer),)
                diagnostics.append(_diag(
                    "resource_missing",
                    error_message,
                    path,
                    error_pointer,
                    bpmn_element=bpmn_element,
                    related=related,
                ))
                continue

            if not is_xml:
                matches = _dialect_type_matches(dialects, api_version, kind, media_type)
            if not matches:
                diagnostics.append(_diag(
                    "unsupported_dialect",
                    f"no installed dialect for {api_version!r} {kind!r} ({media_type}) in profile {profile_id!r}",
                    path,
                    "/",
                ))
                continue
            if len(matches) > 1:
                diagnostics.append(_diag(
                    "ambiguous_dialect",
                    f"more than one installed dialect claims {api_version!r} {kind!r} ({media_type})",
                    path,
                    "/",
                ))
                continue
            dialect, resource_type = matches[0]
            dialect_id = _dialect_id(dialect)
            if role not in resource_type.get("roles", []):
                diagnostics.append(_diag(
                    "resource_role_type",
                    f"dialect {dialect_id!r} does not permit {api_version!r} {kind!r} in role {role!r}",
                    "instance.json",
                    pointer,
                ))
                continue
            base_type = False
            if isinstance(role_contract, Mapping):
                base_type = any(
                    rule.get("apiVersion") == api_version and rule.get("kind") == kind
                    for rule in role_contract.get("resourceTypes", [])
                    if isinstance(rule, Mapping)
                )
                if not base_type and role_contract.get("extensionTypes") != "installed":
                    diagnostics.append(_diag(
                        "profile_resource_type",
                        f"profile {profile_id!r} does not open role {role!r} to installed extension types",
                        "instance.json",
                        pointer,
                    ))
                    continue
            else:
                continue
            if not is_xml:
                diagnostics.extend(_envelope(document, kind, path, expected_api_version=api_version))
                diagnostics.extend(_resource_schema_diagnostics(document, api_version, kind, media_type, path))
                _check_extensions(
                    document,
                    path,
                    "",
                    diagnostics,
                    dialects,
                    api_version,
                    kind,
                    used_extension_dialects,
                )
            resource = _Resource(
                id=resource_id,
                role=role,
                api_version=api_version,
                kind=kind,
                dialect_id=dialect_id,
                path=path,
                document=document,
                xml=xml,
                digest=resource_hash,
                registered=registered,
            )
            indexed[resource_id] = resource
            by_type.setdefault((api_version, kind), []).append(resource)
    declared = {"instance.json", *paths}
    for path in sorted(set(package.files) - declared):
        diagnostics.append(_diag("undeclared_resource", f"package entry {path!r} is not declared", path, "/"))
    for role, role_contract in roles.items() if isinstance(roles, Mapping) else ():
        if not isinstance(role_contract, Mapping):
            continue
        for rule in role_contract.get("resourceTypes", []):
            if not isinstance(rule, Mapping):
                continue
            api_version = rule.get("apiVersion")
            kind = rule.get("kind")
            minimum = int(rule.get("minimum", 0))
            maximum = rule.get("maximum")
            count = sum(
                1
                for resource in indexed.values()
                if resource.role == role and resource.api_version == api_version and resource.kind == kind
            )
            if count < minimum or (isinstance(maximum, int) and count > maximum):
                expected = f"{minimum}+" if maximum is None else str(minimum) if minimum == maximum else f"{minimum}..{maximum}"
                diagnostics.append(_diag(
                    "cardinality",
                    f"profile role {role!r} requires {expected} resources of type {api_version!r} {kind!r}, got {count}",
                    "instance.json",
                    f"/spec/resources/{role}",
                ))
    return indexed, by_type, instance, diagnostics, used_extension_dialects


def _resolve_instance(
    package: InstancePackage,
    profile: Mapping[str, Any],
    registered_resources: Mapping[tuple[str, str, str, str], RegisteredResource] | None,
) -> ResolvedInstance:
    indexed, by_type, instance, diagnostics, inline_dialects = _resource_index(
        package,
        profile,
        registered_resources,
    )
    if diagnostics:
        raise CompileError(diagnostics)
    return ResolvedInstance(
        package=package,
        profile=profile,
        resources=indexed,
        resources_by_type=by_type,
        instance=instance,
        inline_dialects=inline_dialects,
    )


def _normalize_requirement(value: Any) -> dict[str, Any]:
    if isinstance(value, str):
        return {"type": value}
    result = {"type": value["type"]}
    if "predicate" in value:
        result["predicateSource"] = value["predicate"]
    return result


def _normalize_tasks(application: _Resource, diagnostics: list[CompileDiagnostic], source_map: dict[str, Any]) -> dict[str, dict[str, Any]]:
    tasks_source = application.document.get("spec", {}).get("tasks", {})
    tasks: dict[str, dict[str, Any]] = {}
    if not isinstance(tasks_source, dict):
        return tasks
    for task_id, value in tasks_source.items():
        pointer = f"/spec/tasks/{task_id}"
        if isinstance(value, str):
            task = {"kind": "service", "requires": {"type": value}}
        elif isinstance(value, dict):
            kind = value.get("kind", "service")
            task = {"kind": kind}
            if isinstance(value.get("name"), str):
                task["name"] = value["name"]
            if kind == "service" and "requires" in value:
                task["requires"] = _normalize_requirement(value["requires"])
        else:
            continue
        tasks[task_id] = task
        source_map[f"/spec/application/tasks/{task_id}"] = {"resource": application.id, "path": application.path, "pointer": pointer}
    return tasks


def _normalize_operator(value: Any, allowed: set[str], diagnostics: list[CompileDiagnostic], resource: str, pointer: str) -> Any:
    if isinstance(value, str):
        if value not in allowed:
            diagnostics.append(_diag("aggregation_operator", f"operator {value!r} is not allowed here", resource, pointer))
        return value
    if isinstance(value, dict) and "expression" in value:
        try:
            expression = compile_expression(
                value["expression"],
                allowed_roots={"values": "list<number>", "weights": "list<number>", "count": "number"},
                expected_type="number",
            )
            return {"expression": expression.ast}
        except ExpressionError as exc:
            diagnostics.append(_diag("aggregation_expression", str(exc), resource, pointer, span=getattr(exc, "span", None)))
    return value


def _aggregation_policy(value: Any, diagnostics: list[CompileDiagnostic], resource: str, pointer: str) -> dict[str, Any]:
    if value is None:
        value = "sum"
    if isinstance(value, str):
        if value not in {"sum", "product", "min", "max"}:
            diagnostics.append(_diag("aggregation", "aggregation shorthand must be sum, product, min or max", resource, pointer))
            value = "sum"
        return {
            "sequence": value,
            "parallel": value,
            "exclusive": "weightedSum" if value == "sum" else "weightedProduct" if value == "product" else value,
            "repeat": "scale" if value == "sum" else "power" if value == "product" else "identity",
            "selection": value,
        }
    defaults: dict[str, Any] = {"sequence": "sum", "parallel": "sum", "exclusive": "weightedSum", "repeat": "scale", "selection": "sum"}
    if not isinstance(value, dict):
        diagnostics.append(_diag("aggregation", "aggregation must be a shorthand or block policy", resource, pointer))
        return defaults
    allowed = {
        "sequence": {"sum", "product", "min", "max"},
        "parallel": {"sum", "product", "min", "max"},
        "exclusive": {"weightedSum", "weightedProduct", "min", "max"},
        "repeat": {"scale", "power", "identity"},
        "selection": {"sum", "product", "min", "max"},
    }
    for block, operator_value in value.items():
        defaults[block] = _normalize_operator(operator_value, allowed[block], diagnostics, resource, f"{pointer}/{block}")
    return defaults


def _normalize_metrics(application: _Resource, diagnostics: list[CompileDiagnostic], source_map: dict[str, Any]) -> dict[str, dict[str, Any]]:
    source = application.document.get("spec", {}).get("metrics", {})
    metrics: dict[str, dict[str, Any]] = {}
    if not isinstance(source, dict):
        return metrics
    for metric_id, value in source.items():
        if not isinstance(value, dict):
            continue
        domain = value.get("domain", "real")
        if isinstance(domain, str):
            domain = {"kind": domain}
        else:
            domain = dict(domain)
        domain_kind = domain.get("kind")
        for bound in ("minimum", "maximum"):
            if bound in domain:
                _finite(domain[bound], f"/spec/metrics/{metric_id}/domain/{bound}", diagnostics, application.path)
                if domain_kind == "integer" and isinstance(domain[bound], (int, float)) and not float(domain[bound]).is_integer():
                    diagnostics.append(_diag("metric_domain", "integer metric bounds must be integers", application.path, f"/spec/metrics/{metric_id}/domain/{bound}"))
        if domain_kind == "ratio":
            minimum = domain.setdefault("minimum", 0.0)
            maximum = domain.setdefault("maximum", 1.0)
            if isinstance(minimum, (int, float)) and isinstance(maximum, (int, float)) and (minimum < 0 or maximum > 1):
                diagnostics.append(_diag("metric_domain", "ratio metric domains must stay within [0, 1]", application.path, f"/spec/metrics/{metric_id}/domain"))
        if isinstance(domain.get("minimum"), (int, float)) and isinstance(domain.get("maximum"), (int, float)) and domain["maximum"] < domain["minimum"]:
            diagnostics.append(_diag("metric_domain", "metric domain maximum must not be lower than minimum", application.path, f"/spec/metrics/{metric_id}/domain"))
        aggregation = _aggregation_policy(value.get("aggregation"), diagnostics, application.path, f"/spec/metrics/{metric_id}/aggregation")
        neutral = value.get("neutral")
        if neutral is None:
            sequence_operator = aggregation.get("sequence")
            if sequence_operator == "sum":
                neutral = 0.0
            elif sequence_operator == "product":
                neutral = 1.0
            elif sequence_operator == "min":
                neutral = 1.0 if domain.get("kind") == "ratio" else domain.get("maximum")
            elif sequence_operator == "max":
                neutral = 0.0 if domain.get("kind") == "ratio" else domain.get("minimum")
            if neutral is None:
                diagnostics.append(_diag("metric_neutral", "metric.neutral is required when it cannot be inferred from aggregation and domain", application.path, f"/spec/metrics/{metric_id}/neutral"))
                neutral = 0.0
        if _finite(neutral, f"/spec/metrics/{metric_id}/neutral", diagnostics, application.path):
            minimum = 0.0 if domain.get("kind") == "ratio" else domain.get("minimum")
            maximum = 1.0 if domain.get("kind") == "ratio" else domain.get("maximum")
            if (minimum is not None and float(neutral) < float(minimum)) or (maximum is not None and float(neutral) > float(maximum)):
                diagnostics.append(_diag("metric_neutral_domain", "metric.neutral must be inside the declared domain", application.path, f"/spec/metrics/{metric_id}/neutral"))
        metric = {
            "type": "number",
            "unit": value.get("unit", "1"),
            "domain": domain,
            "direction": value.get("direction", "minimize"),
            "scope": value.get("scope", "invocation"),
            "aggregation": aggregation,
            "neutral": float(neutral),
        }
        if isinstance(value.get("name"), str):
            metric["name"] = value["name"]
        metrics[metric_id] = metric
        source_map[f"/spec/application/metrics/{metric_id}"] = {"resource": application.id, "path": application.path, "pointer": f"/spec/metrics/{metric_id}"}
    return metrics


def _validate_metric_value(
    value: Any,
    metric: Mapping[str, Any],
    resource: str,
    pointer: str,
    diagnostics: list[CompileDiagnostic],
) -> None:
    if not _finite(value, pointer, diagnostics, resource):
        return
    numeric = float(value)
    domain = metric.get("domain", {})
    minimum = domain.get("minimum") if isinstance(domain, Mapping) else None
    maximum = domain.get("maximum") if isinstance(domain, Mapping) else None
    if minimum is not None and numeric < float(minimum):
        diagnostics.append(_diag("metric_value_domain", "candidate metric value is below its declared domain", resource, pointer))
    if maximum is not None and numeric > float(maximum):
        diagnostics.append(_diag("metric_value_domain", "candidate metric value is above its declared domain", resource, pointer))
    if isinstance(domain, Mapping) and domain.get("kind") == "integer" and not numeric.is_integer():
        diagnostics.append(_diag("metric_value_domain", "candidate value for an integer metric must be integral", resource, pointer))


def _normalize_capabilities(value: Any) -> list[dict[str, Any]]:
    values = value if isinstance(value, list) else [value]
    result: list[dict[str, Any]] = []
    for item in values:
        if isinstance(item, str):
            result.append({"type": item, "properties": {}})
        elif isinstance(item, dict) and isinstance(item.get("type"), str):
            result.append({"type": item["type"], "properties": item.get("properties", {})})
    return result


def _property_path_types(prefix: tuple[str, ...], value: Any, out: dict[tuple[str, ...], str]) -> None:
    if value is None:
        out[prefix] = "null"
    elif isinstance(value, bool):
        out[prefix] = "bool"
    elif isinstance(value, (int, float)) and not isinstance(value, bool):
        out[prefix] = "number"
    elif isinstance(value, str):
        out[prefix] = "string"
    elif isinstance(value, dict):
        out[prefix] = "object"
        for key, child in value.items():
            if isinstance(key, str) and key and "\x00" not in key:
                _property_path_types((*prefix, key), child, out)
    elif isinstance(value, list) and all(
        isinstance(item, (int, float)) and not isinstance(item, bool)
        for item in value
    ):
        out[prefix] = "list<number>"


def _shared_property_path_types(
    prefix: tuple[str, ...],
    values: Iterable[Any],
    out: dict[tuple[str, ...], str],
) -> None:
    """Expose only paths whose runtime type is stable for every eligible value."""

    typed_values: list[dict[tuple[str, ...], str]] = []
    for value in values:
        current: dict[tuple[str, ...], str] = {}
        _property_path_types(prefix, value, current)
        typed_values.append(current)
    if not typed_values:
        out[prefix] = "object"
        return
    common = set(typed_values[0]).intersection(*(set(value) for value in typed_values[1:]))
    for path in common:
        path_types = {value[path] for value in typed_values}
        if len(path_types) == 1:
            out[path] = path_types.pop()


def re_identifier(value: str) -> bool:
    return bool(value) and (value[0].isalpha() or value[0] == "_") and all(char.isalnum() or char == "_" for char in value)


def _normalize_candidates(
    catalogs: list[_Resource],
    tasks: dict[str, dict[str, Any]],
    application: _Resource,
    metric_definitions: Mapping[str, Any],
    diagnostics: list[CompileDiagnostic],
    source_map: dict[str, Any],
) -> tuple[dict[str, dict[str, Any]], dict[str, list[dict[str, str]]]]:
    application_id = application.id
    candidates: dict[str, dict[str, Any]] = {}
    eligibility: dict[str, list[dict[str, str]]] = {task_id: [] for task_id, task in tasks.items() if task["kind"] == "service"}
    for catalog in catalogs:
        spec = catalog.document.get("spec", {})
        providers_source = spec.get("providers", {})
        providers = {
            provider_id: {
                **({"name": value["name"]} if isinstance(value, dict) and isinstance(value.get("name"), str) else {}),
                "properties": value.get("properties", {}) if isinstance(value, dict) else {},
            }
            for provider_id, value in providers_source.items()
        } if isinstance(providers_source, dict) else {}
        bindings_source = spec.get("metricBindings", {})
        metric_bindings: dict[str, dict[str, str]] = {}
        bound_refs: set[tuple[str, str]] = set()
        for alias, value in bindings_source.items() if isinstance(bindings_source, dict) else []:
            reference = _validate_ref(value, catalog.path, f"/spec/metricBindings/{alias}", diagnostics)
            if reference is None:
                continue
            if reference["resource"] != application_id or reference["id"] not in metric_definitions:
                diagnostics.append(_diag("candidate_metric_ref", f"metric binding {alias!r} must reference a metric in the Application", catalog.path, f"/spec/metricBindings/{alias}"))
                continue
            key = _ref_key(reference)
            if key in bound_refs:
                diagnostics.append(_diag("candidate_metric_ref_duplicate", f"metric {reference!r} is bound by more than one alias", catalog.path, f"/spec/metricBindings/{alias}"))
                continue
            bound_refs.add(key)
            metric_bindings[alias] = reference
        source = spec.get("candidates", {})
        catalog_candidates: dict[str, Any] = {}
        if not isinstance(source, dict):
            continue
        for candidate_id, value in source.items():
            if not isinstance(value, dict):
                continue
            provider = value.get("provider")
            provider_ref = None
            if provider is not None:
                provider_ref = _validate_ref(provider, catalog.path, f"/spec/candidates/{candidate_id}/provider", diagnostics)
                if provider_ref and (provider_ref["resource"] != catalog.id or provider_ref["id"] not in providers):
                    diagnostics.append(_diag("candidate_provider", f"provider must reference a declaration in catalog {catalog.id!r}", catalog.path, f"/spec/candidates/{candidate_id}/provider"))
            metrics = value.get("metrics", {})
            for alias, metric_value in metrics.items() if isinstance(metrics, dict) else []:
                if alias not in metric_bindings:
                    diagnostics.append(_diag("candidate_metric_alias", f"unknown metric alias {alias!r}", catalog.path, f"/spec/candidates/{candidate_id}/metrics/{alias}"))
                    _finite(metric_value, f"/spec/candidates/{candidate_id}/metrics/{alias}", diagnostics, catalog.path)
                else:
                    metric_id = metric_bindings[alias]["id"]
                    _validate_metric_value(
                        metric_value,
                        metric_definitions[metric_id],
                        catalog.path,
                        f"/spec/candidates/{candidate_id}/metrics/{alias}",
                        diagnostics,
                    )
            normalized = {
                "ref": _ref(catalog.id, candidate_id),
                "provides": _normalize_capabilities(value.get("provides")),
                "properties": value.get("properties", {}),
                "metrics": metrics if isinstance(metrics, dict) else {},
            }
            if provider_ref is not None:
                normalized["provider"] = provider_ref
            if isinstance(value.get("name"), str):
                normalized["name"] = value["name"]
            catalog_candidates[candidate_id] = normalized
            source_map[f"/spec/candidates/{catalog.id}/{candidate_id}"] = {"resource": catalog.id, "path": catalog.path, "pointer": f"/spec/candidates/{candidate_id}"}
            for task_id, task in tasks.items():
                if task["kind"] != "service":
                    continue
                requirement = task["requires"]
                matches = [capability for capability in normalized["provides"] if capability["type"] == requirement["type"]]
                if not matches:
                    continue
                predicate_source = requirement.get("predicateSource")
                if predicate_source is not None:
                    accepted = False
                    for capability in matches:
                        path_types: dict[tuple[str, ...], str] = {}
                        _property_path_types(("candidate", "properties"), normalized["properties"], path_types)
                        _property_path_types(("capability", "properties"), capability["properties"], path_types)
                        try:
                            predicate = compile_expression(
                                predicate_source,
                                allowed_roots={"candidate": "closed-object", "capability": "closed-object"},
                                path_types=path_types,
                                expected_type="bool",
                            )
                            requirement["predicate"] = predicate.ast
                            if predicate.evaluate({"candidate": normalized, "capability": capability}):
                                accepted = True
                                break
                        except ExpressionError as exc:
                            diagnostics.append(_diag(
                                "capability_predicate",
                                str(exc),
                                application.path,
                                f"/spec/tasks/{_json_pointer_segment(task_id)}/requires/predicate",
                                span=getattr(exc, "span", None),
                            ))
                            break
                    if not accepted:
                        continue
                eligibility[task_id].append(_ref(catalog.id, candidate_id))
        candidates[catalog.id] = {"providers": providers, "metricBindings": metric_bindings, "candidates": catalog_candidates}
    for task_id, eligible in eligibility.items():
        if not eligible:
            diagnostics.append(_diag("ineligible_task", f"no candidate satisfies task {task_id!r}", "Application", f"/spec/tasks/{task_id}"))
    for task in tasks.values():
        requirement = task.get("requires")
        if isinstance(requirement, dict):
            requirement.pop("predicateSource", None)
            # Candidate predicates are a compile-time sublanguage. Engines
            # consume the resulting eligibility matrix, not executable source
            # predicates or their AST.
            requirement.pop("predicate", None)
    return candidates, eligibility


def _condition_environment(
    tasks: Mapping[str, Any],
    metrics: Mapping[str, Any],
    candidates: Mapping[str, Any],
    eligibility: Mapping[str, list[dict[str, str]]],
    extensions: Mapping[str, Any],
) -> tuple[dict[str, str], dict[tuple[str, ...], str]]:
    roots = {
        "binding": "closed-object",
        "tasks": "closed-object",
        "metrics": "closed-object",
        "extensions": "closed-object",
    }
    paths: dict[tuple[str, ...], str] = {("metrics", metric_id): "number" for metric_id in metrics}
    for task_id, task in tasks.items():
        # Local activities have no binding, provider, candidate, or candidate
        # metrics.  Do not advertise paths the runtime can never materialize.
        if task.get("kind") != "service":
            continue
        paths[("binding", task_id)] = "object"
        paths[("tasks", task_id)] = "object"
        paths[("tasks", task_id, "candidate")] = "object"
        paths[("tasks", task_id, "candidate", "resource")] = "string"
        paths[("tasks", task_id, "candidate", "id")] = "string"
        paths[("tasks", task_id, "provider")] = "object"
        paths[("tasks", task_id, "provider", "resource")] = "string"
        paths[("tasks", task_id, "provider", "id")] = "string"
        paths[("tasks", task_id, "metrics")] = "object"
        paths[("tasks", task_id, "properties")] = "object"
        eligible_properties = [
            candidate.get("properties", {})
            for reference in eligibility.get(task_id, [])
            if (candidate := _lookup_candidate(candidates, reference)) is not None
        ]
        _shared_property_path_types(
            ("tasks", task_id, "properties"),
            eligible_properties,
            paths,
        )
        for metric_id in metrics:
            paths[("tasks", task_id, "metrics", metric_id)] = "number"
    _property_path_types(("extensions",), dict(extensions), paths)
    return roots, paths


def _compile_condition(value: Any, roots: Mapping[str, str], paths: Mapping[Any, str], diagnostics: list[CompileDiagnostic], resource: str, pointer: str) -> dict[str, Any] | None:
    try:
        expression = compile_expression(value, allowed_roots=roots, path_types=paths, expected_type="bool")
        return expression.ast
    except ExpressionError as exc:
        diagnostics.append(
            _diag(
                "expression",
                str(exc),
                resource,
                pointer,
                span=getattr(exc, "span", None),
            )
        )
        return None


def _compile_workflow(
    source: Any,
    application: _Resource,
    tasks: Mapping[str, Any],
    roots: Mapping[str, str],
    paths: Mapping[str, str],
    diagnostics: list[CompileDiagnostic],
    source_map: dict[str, Any],
    pointer: str = "/spec/workflow",
    ir_pointer: str = "/spec/application/workflow",
) -> dict[str, Any] | None:
    if not isinstance(source, dict):
        diagnostics.append(_diag("workflow", "workflow block must be an object", application.path, pointer))
        return None
    discriminators = [key for key in ("task", "empty", "sequence", "parallel", "exclusive", "repeat", "bpmn") if key in source]
    if len(discriminators) != 1:
        diagnostics.append(_diag("workflow", "workflow block requires exactly one keyed discriminator", application.path, pointer))
        return None
    kind = discriminators[0]
    source_map[ir_pointer] = {"resource": application.id, "path": application.path, "pointer": pointer}
    common = {"id": source["id"]} if isinstance(source.get("id"), str) else {}
    if kind == "task":
        reference = _validate_ref(source["task"], application.path, pointer + "/task", diagnostics)
        if reference is None or reference["resource"] != application.id or reference["id"] not in tasks:
            diagnostics.append(_diag("workflow_task", "workflow task must reference a task in its Application resource", application.path, pointer + "/task"))
            return None
        return {"kind": "task", "task": reference, **common}
    if kind == "empty":
        return {"kind": "empty", **common}
    if kind in {"sequence", "parallel"}:
        children = source[kind]
        field = "steps" if kind == "sequence" else "branches"
        compiled = [
            _compile_workflow(child, application, tasks, roots, paths, diagnostics, source_map, f"{pointer}/{kind}/{index}", f"{ir_pointer}/{field}/{index}")
            for index, child in enumerate(children)
        ]
        return {"kind": kind, field: [child for child in compiled if child is not None], **common}
    if kind == "exclusive":
        branches: list[dict[str, Any]] = []
        seen: set[str] = set()
        for index, branch in enumerate(source[kind]):
            branch_pointer = f"{pointer}/exclusive/{index}"
            branch_id = branch.get("id") if isinstance(branch, dict) else None
            if not isinstance(branch_id, str) or not branch_id or branch_id in seen:
                diagnostics.append(_diag("workflow_branch_id", "exclusive branch ids must be non-empty and globally unique", application.path, branch_pointer + "/id"))
                continue
            seen.add(branch_id)
            child = _compile_workflow(branch.get("flow"), application, tasks, roots, paths, diagnostics, source_map, branch_pointer + "/flow", f"{ir_pointer}/branches/{index}/flow")
            if child is None:
                continue
            item: dict[str, Any] = {"id": branch_id, "flow": child}
            if "when" in branch:
                condition = _compile_condition(branch["when"], roots, paths, diagnostics, application.path, branch_pointer + "/when")
                if condition is not None:
                    item["when"] = condition
            branches.append(item)
            source_map[f"{ir_pointer}/branches/{index}"] = {"resource": application.id, "path": application.path, "pointer": branch_pointer}
        return {"kind": "exclusive", "branches": branches, **common}
    if kind == "repeat":
        repeat = source[kind]
        child = _compile_workflow(repeat.get("body"), application, tasks, roots, paths, diagnostics, source_map, pointer + "/repeat/body", ir_pointer + "/body")
        count_key = "count" if "count" in repeat else "expectedCount"
        return {"kind": "repeat", "body": child, count_key: repeat.get(count_key), **common} if child else None
    # BPMN is lowered by compile_instance after resolving the resource.
    reference = _validate_ref(source["bpmn"], application.path, pointer + "/bpmn", diagnostics)
    return {"kind": "bpmnRef", "workflow": reference} if reference else None


def _bpmn_workflow(
    workflow_resource: _Resource,
    process_id: str | None,
    application: _Resource,
    tasks: Mapping[str, Any],
    roots: Mapping[str, str],
    paths: Mapping[str, str],
    diagnostics: list[CompileDiagnostic],
    source_map: dict[str, Any],
) -> dict[str, Any] | None:
    root = workflow_resource.xml
    processes = [element for element in list(root) if element.tag.rsplit("}", 1)[-1] == "process"] if root is not None else []
    if process_id:
        processes = [element for element in processes if element.get("id") == process_id]
    if len(processes) != 1:
        diagnostics.append(_diag("bpmn_process", "BPMN requires exactly one selected process", workflow_resource.path, "/process"))
        return None
    process = processes[0]
    elements: dict[str, Any] = {}
    outgoing: dict[str, list[tuple[str, str, str | None]]] = {}
    incoming: dict[str, list[str]] = {}
    allowed = {
        "startEvent",
        "endEvent",
        "task",
        "serviceTask",
        "userTask",
        "scriptTask",
        "exclusiveGateway",
        "parallelGateway",
        "sequenceFlow",
        "incoming",
        "outgoing",
        "standardLoopCharacteristics",
        "multiInstanceLoopCharacteristics",
        "loopCardinality",
        "loopCondition",
        "conditionExpression",
    }
    for element in process.iter():
        local = element.tag.rsplit("}", 1)[-1]
        if element is process:
            continue
        if local not in allowed:
            diagnostics.append(_diag("bpmn_unsupported", f"unsupported BPMN element {local!r}", workflow_resource.path, f"/process/{element.get('id', local)}"))
    seen_ids: dict[str, dict[str, str]] = {}
    flows: list[tuple[str, str, str, str | None]] = []
    for element in list(process):
        element_id = element.get("id")
        if not element_id:
            diagnostics.append(_diag("bpmn_id", "executable BPMN elements require an id", workflow_resource.path, "/process"))
            continue
        element_pointer = f"/process/{element_id}"
        if element_id in seen_ids:
            diagnostics.append(_diag(
                "bpmn_id",
                f"duplicate BPMN id {element_id!r}",
                workflow_resource.path,
                element_pointer,
                related=(seen_ids[element_id],),
            ))
            continue
        seen_ids[element_id] = _diagnostic_location(workflow_resource.path, element_pointer)
        local = element.tag.rsplit("}", 1)[-1]
        if local == "sequenceFlow":
            source, target = element.get("sourceRef"), element.get("targetRef")
            if not source or not target:
                diagnostics.append(_diag("bpmn_flow", "sequenceFlow requires sourceRef and targetRef", workflow_resource.path, f"/process/{element_id}"))
                continue
            condition = next((child.text.strip() for child in list(element) if child.tag.rsplit("}", 1)[-1] == "conditionExpression" and child.text), None)
            outgoing.setdefault(source, []).append((target, element_id, condition))
            incoming.setdefault(target, []).append(source)
            flows.append((element_id, source, target, condition))
        else:
            elements[element_id] = element
    for flow_id, source, target, condition in flows:
        if source not in elements:
            diagnostics.append(_diag("bpmn_flow", f"sequenceFlow sourceRef targets unknown element {source!r}", workflow_resource.path, f"/process/{flow_id}/sourceRef"))
            continue
        if target not in elements:
            diagnostics.append(_diag("bpmn_flow", f"sequenceFlow targetRef targets unknown element {target!r}", workflow_resource.path, f"/process/{flow_id}/targetRef"))
        source_kind = elements[source].tag.rsplit("}", 1)[-1]
        if condition is not None and source_kind != "exclusiveGateway":
            diagnostics.append(_diag("bpmn_condition", "the executable profile only permits conditions on XOR split sequenceFlows", workflow_resource.path, f"/process/{flow_id}/conditionExpression"))
    starts = [key for key, element in elements.items() if element.tag.rsplit("}", 1)[-1] == "startEvent"]
    ends = [key for key, element in elements.items() if element.tag.rsplit("}", 1)[-1] == "endEvent"]
    if len(starts) != 1 or len(ends) != 1:
        diagnostics.append(_diag("bpmn_sese", "BPMN executable subset requires exactly one start and one end", workflow_resource.path, "/process"))
        return None
    if incoming.get(starts[0]):
        diagnostics.append(_diag("bpmn_sese", "startEvent cannot have incoming sequenceFlows", workflow_resource.path, f"/process/{starts[0]}"))
    if outgoing.get(ends[0]):
        diagnostics.append(_diag("bpmn_sese", "endEvent cannot have outgoing sequenceFlows", workflow_resource.path, f"/process/{ends[0]}"))
    task_map: dict[str, str] = {}
    for element_id, element in elements.items():
        if element.tag.rsplit("}", 1)[-1] not in {"task", "serviceTask", "userTask", "scriptTask"}:
            continue
        name = element.get("name")
        if element_id in tasks:
            task_map[element_id] = element_id
        elif isinstance(name, str) and name in tasks:
            task_map[element_id] = name
        else:
            diagnostics.append(_diag("bpmn_task_ref", f"BPMN task {element_id!r} has no Application task", workflow_resource.path, f"/process/{element_id}"))

    def sequence(items: list[dict[str, Any]]) -> dict[str, Any]:
        values = [item for item in items if item.get("kind") != "empty"]
        if not values:
            return {"kind": "empty"}
        return values[0] if len(values) == 1 else {"kind": "sequence", "steps": values}

    def reachable(start: str) -> dict[str, int]:
        result = {start: 0}
        queue = [start]
        while queue and len(result) <= 4096:
            current = queue.pop(0)
            for target, _flow, _condition in outgoing.get(current, []):
                if target not in result:
                    result[target] = result[current] + 1
                    queue.append(target)
        return result

    def common_join(successors: list[str]) -> str | None:
        reachability = [reachable(successor) for successor in successors]
        common = set(reachability[0])
        for values in reachability[1:]:
            common &= set(values)
        joins = [candidate for candidate in common if len(incoming.get(candidate, [])) >= 2]
        return min(joins, key=lambda candidate: sum(values[candidate] for values in reachability)) if joins else None

    active: set[str] = set()

    def loop_count(element: Any) -> tuple[str, int | float] | None:
        standard = next((child for child in list(element) if child.tag.rsplit("}", 1)[-1] == "standardLoopCharacteristics"), None)
        if standard is not None:
            # BPMN's loopMaximum is only an upper bound and loopCondition is
            # dynamic.  Neither is an exact or expected execution count, so
            # lowering either to BIM repeat would change the model.
            diagnostics.append(_diag(
                "bpmn_loop",
                "standardLoopCharacteristics cannot be reduced to a deterministic BIM count; use a static sequential multiInstanceLoopCharacteristics",
                workflow_resource.path,
                f"/process/{element.get('id')}",
            ))
            return ("invalid", 0)
        loop = next((child for child in list(element) if child.tag.rsplit("}", 1)[-1] == "multiInstanceLoopCharacteristics"), None)
        if loop is None:
            return None
        if loop.get("isSequential", "false").lower() not in {"true", "1"}:
            diagnostics.append(_diag("bpmn_loop", "only sequential multi-instance activities are executable in qos-binding/v1", workflow_resource.path, f"/process/{element.get('id')}"))
            return ("invalid", 0)
        cardinality = next((child.text.strip() for child in list(loop) if child.tag.rsplit("}", 1)[-1] == "loopCardinality" and child.text), None)
        if cardinality is None:
            diagnostics.append(_diag("bpmn_loop", "sequential multi-instance activity requires a static loopCardinality", workflow_resource.path, f"/process/{element.get('id')}"))
            return ("invalid", 0)
        try:
            numeric = Decimal(cardinality)
        except Exception:
            diagnostics.append(_diag("bpmn_loop", "loopCardinality must be a finite non-negative number", workflow_resource.path, f"/process/{element.get('id')}"))
            return ("invalid", 0)
        if not numeric.is_finite() or numeric < 0 or numeric != numeric.to_integral_value():
            diagnostics.append(_diag("bpmn_loop", "BPMN loopCardinality must be a finite non-negative integer", workflow_resource.path, f"/process/{element.get('id')}"))
            return ("invalid", 0)
        return ("count", int(numeric))

    def walk(node_id: str, stop: str | None = None) -> dict[str, Any] | None:
        if stop is not None and node_id == stop:
            return {"kind": "empty"}
        if node_id in active:
            diagnostics.append(_diag(
                "bpmn_cycle",
                "graph cycles are outside the executable subset; use a static sequential multiInstanceLoopCharacteristics for exact repetition",
                workflow_resource.path,
                f"/process/{node_id}",
            ))
            return None
        element = elements.get(node_id)
        if element is None:
            diagnostics.append(_diag("bpmn_flow", f"flow targets unknown element {node_id!r}", workflow_resource.path, f"/process/{node_id}"))
            return None
        active.add(node_id)
        try:
            local = element.tag.rsplit("}", 1)[-1]
            successors = outgoing.get(node_id, [])
            source_map[f"/spec/application/workflow/elements/{node_id}"] = {"resource": workflow_resource.id, "path": workflow_resource.path, "bpmnElement": node_id}
            if local == "endEvent":
                return {"kind": "empty"}
            if local == "startEvent":
                if len(successors) != 1:
                    diagnostics.append(_diag("bpmn_start", "startEvent requires one outgoing flow", workflow_resource.path, f"/process/{node_id}"))
                    return None
                return walk(successors[0][0], stop)
            if local in {"task", "serviceTask", "userTask", "scriptTask"}:
                if len(successors) != 1 or node_id not in task_map:
                    diagnostics.append(_diag("bpmn_task_flow", "BPMN task requires one outgoing flow and a task mapping", workflow_resource.path, f"/process/{node_id}"))
                    return None
                head: dict[str, Any] = {"kind": "task", "task": _ref(application.id, task_map[node_id])}
                repetition = loop_count(element)
                if repetition is not None:
                    if repetition[0] == "invalid":
                        return None
                    head = {"kind": "repeat", "body": head, repetition[0]: repetition[1]}
                tail = walk(successors[0][0], stop)
                return sequence([head, tail]) if tail else None
            if local in {"exclusiveGateway", "parallelGateway"}:
                # A converging gateway is a join, not another split.
                if len(incoming.get(node_id, [])) >= 2 and len(successors) == 1:
                    return walk(successors[0][0], stop)
                if len(successors) < 2:
                    diagnostics.append(_diag("bpmn_gateway", "split gateway requires at least two outgoing flows", workflow_resource.path, f"/process/{node_id}"))
                    return None
                join = common_join([target for target, _flow, _condition in successors])
                if join is None:
                    diagnostics.append(_diag("bpmn_gateway_join", "split branches must reconverge at a structured join", workflow_resource.path, f"/process/{node_id}"))
                    return None
                join_kind = elements[join].tag.rsplit("}", 1)[-1]
                if join_kind != local:
                    diagnostics.append(_diag("bpmn_gateway_join", f"{local} split must reconverge at a matching {local} join", workflow_resource.path, f"/process/{join}"))
                    return None
                branches: list[dict[str, Any]] = []
                for target, flow_id, condition_source in successors:
                    child = walk(target, join)
                    if child is None:
                        return None
                    item: dict[str, Any] = {"id": flow_id, "flow": child}
                    if condition_source is not None:
                        condition = _compile_condition(condition_source, roots, paths, diagnostics, workflow_resource.path, f"/process/{flow_id}/conditionExpression")
                        if condition is not None:
                            item["when"] = condition
                    branches.append(item)
                if local == "exclusiveGateway":
                    head = {"kind": "exclusive", "branches": branches}
                else:
                    # Flow ids and conditions are XOR semantics.  Parallel IR
                    # contains workflow children directly, matching native JSON.
                    head = {"kind": "parallel", "branches": [branch["flow"] for branch in branches]}
                tail = walk(join, stop)
                return sequence([head, tail]) if tail else None
            diagnostics.append(_diag("bpmn_unsupported", f"unsupported BPMN element {local!r}", workflow_resource.path, f"/process/{node_id}"))
            return None
        finally:
            active.discard(node_id)

    workflow = walk(starts[0])
    visited_elements = {location.get("bpmnElement") for location in source_map.values() if isinstance(location, dict)}
    unreachable = sorted(set(elements) - set(visited_elements))
    if unreachable:
        diagnostics.append(_diag("bpmn_unreachable", f"BPMN has unreachable elements: {', '.join(unreachable)}", workflow_resource.path, "/process"))
    return workflow


def _walk_exclusive(node: Mapping[str, Any]) -> Iterable[dict[str, Any]]:
    if node.get("kind") == "exclusive":
        yield dict(node)
        for branch in node.get("branches", []):
            yield from _walk_exclusive(branch.get("flow", {}))
    elif node.get("kind") in {"sequence", "parallel"}:
        for child in node.get("steps", node.get("branches", [])):
            yield from _walk_exclusive(child)
    elif node.get("kind") == "repeat":
        yield from _walk_exclusive(node.get("body", {}))


def _routing(
    workflow: dict[str, Any],
    routing_resources: list[_Resource],
    source_workflow_owner: str,
    semantic_workflow_owner: str,
    diagnostics: list[CompileDiagnostic],
    source_map: dict[str, Any],
) -> list[dict[str, Any]]:
    overlay = routing_resources[0] if routing_resources else None
    source = overlay.document.get("spec", {}) if overlay else {}
    explicit = source.get("entries") if overlay else None
    uniform = source.get("uniform") is True if overlay else False
    probabilities: dict[tuple[str, str], float] = {}
    probability_locations: dict[tuple[str, str], dict[str, str]] = {}
    if explicit is not None:
        for index, entry in enumerate(explicit) if isinstance(explicit, list) else []:
            target = _validate_ref(entry.get("target"), overlay.path, f"/spec/entries/{index}/target", diagnostics)
            value = entry.get("probability")
            if target is None or not _finite(value, f"/spec/entries/{index}/probability", diagnostics, overlay.path):
                continue
            key = _ref_key(target)
            if key in probabilities:
                diagnostics.append(_diag(
                    "routing_target_duplicate",
                    f"duplicate routing target {target!r}",
                    overlay.path,
                    f"/spec/entries/{index}/target",
                    related=(probability_locations[key],),
                ))
                continue
            probabilities[key] = float(value)
            probability_locations[key] = _diagnostic_location(
                overlay.path,
                f"/spec/entries/{index}/target",
            )
            source_map[f"/spec/routing/{len(probabilities) - 1}"] = {"resource": overlay.id, "path": overlay.path, "pointer": f"/spec/entries/{index}"}
    known: set[tuple[str, str]] = set()
    for exclusive in _walk_exclusive(workflow):
        branches = exclusive.get("branches", [])
        targets = [_ref(source_workflow_owner, branch["id"]) for branch in branches]
        keys = [_ref_key(target) for target in targets]
        if known.intersection(keys):
            diagnostics.append(_diag("routing_branch_id", "exclusive branch/sequenceFlow ids must be unique within their workflow resource", overlay.path if overlay else source_workflow_owner, "/spec/entries" if overlay else "/spec/workflow"))
        known.update(keys)
        supplied = [key for key in keys if key in probabilities]
        if supplied and len(supplied) != len(keys):
            diagnostics.append(_diag("routing_partial", "an XOR must provide every probability or none", overlay.path, "/spec/entries"))
        if len(supplied) == len(keys) and supplied:
            if sum((Decimal(str(probabilities[key])) for key in keys), Decimal(0)) != Decimal(1):
                diagnostics.append(_diag("routing_sum", "XOR probabilities must sum exactly to decimal 1", overlay.path, "/spec/entries"))
            for branch in branches:
                if "when" in branch:
                    diagnostics.append(_diag("routing_condition_conflict", "static condition and probability cannot coexist", overlay.path, "/spec/entries"))
        elif uniform:
            share = Decimal(1) / Decimal(len(keys))
            for index, key in enumerate(keys):
                value = Decimal(1) - share * Decimal(len(keys) - 1) if index == len(keys) - 1 else share
                probabilities[key] = float(value)
            if any("when" in branch for branch in branches):
                diagnostics.append(_diag("routing_condition_conflict", "static condition and probability cannot coexist", overlay.path, "/spec/uniform"))
        else:
            conditioned = ["when" in branch for branch in branches]
            if any(conditioned) and not all(conditioned):
                diagnostics.append(_diag("routing_condition_partial", "a conditional XOR must define a condition on every branch", overlay.path if overlay else source_workflow_owner, "/spec/entries" if overlay else "/spec/workflow"))
            elif not all(conditioned):
                diagnostics.append(_diag(
                    "routing_missing",
                    "each XOR must be fully probabilistic, explicitly uniform, or fully conditional",
                    overlay.path if overlay else source_workflow_owner,
                    "/spec/entries" if overlay else "/spec/workflow",
                ))
    unknown = set(probabilities) - known
    if unknown:
        rendered = ", ".join(f"{resource}:{local_id}" for resource, local_id in sorted(unknown))
        diagnostics.append(_diag("routing_target", f"unknown routing targets: {rendered}", overlay.path, "/spec/entries"))
    return [
        {"target": _ref(semantic_workflow_owner, local_id), "probability": probability}
        for (_resource, local_id), probability in sorted(probabilities.items())
    ]


def _validate_xor_aggregation(
    workflow: Mapping[str, Any],
    routing: list[dict[str, Any]],
    workflow_owner: str,
    metrics: Mapping[str, Any],
    required_global: set[str],
    diagnostics: list[CompileDiagnostic],
) -> None:
    routed = {_ref_key(entry["target"]) for entry in routing}
    for exclusive in _walk_exclusive(workflow):
        branches = exclusive.get("branches", [])
        targets = {_ref_key(_ref(workflow_owner, branch["id"])) for branch in branches}
        if targets and targets.issubset(routed) or all("when" in branch for branch in branches):
            continue
        for metric_id in sorted(required_global):
            operator = metrics[metric_id]["aggregation"]["exclusive"]
            if operator in {"weightedSum", "weightedProduct"}:
                diagnostics.append(_diag("routing_required", f"metric {metric_id!r} uses {operator} and requires probabilities for every branch of this XOR", workflow_owner, "/spec/workflow"))


def _walk_repeats(node: Mapping[str, Any]) -> Iterable[Mapping[str, Any]]:
    if node.get("kind") == "repeat":
        yield node
        yield from _walk_repeats(node.get("body", {}))
    elif node.get("kind") in {"sequence", "parallel"}:
        for child in node.get("steps", node.get("branches", [])):
            yield from _walk_repeats(child)
    elif node.get("kind") == "exclusive":
        for branch in node.get("branches", []):
            yield from _walk_repeats(branch.get("flow", {}))


def _validate_fractional_products(
    workflow: Mapping[str, Any],
    routing: list[dict[str, Any]],
    metrics: Mapping[str, Any],
    required_global: set[str],
    candidates: Mapping[str, Any],
    diagnostics: list[CompileDiagnostic],
) -> None:
    fractional_routing = any(
        not float(entry["probability"]).is_integer() for entry in routing
    )
    fractional_repeat = any(
        "expectedCount" in repeat
        and not float(repeat["expectedCount"]).is_integer()
        for repeat in _walk_repeats(workflow)
    )
    for metric_id in sorted(required_global):
        metric = metrics[metric_id]
        if metric.get("scope") != "invocation":
            continue
        aggregation = metric.get("aggregation", {})
        needs_nonnegative = (
            fractional_routing and aggregation.get("exclusive") == "weightedProduct"
        ) or (
            fractional_repeat and aggregation.get("repeat") == "power"
        )
        if not needs_nonnegative:
            continue
        domain = metric.get("domain", {})
        minimum = domain.get("minimum") if isinstance(domain, Mapping) else None
        if minimum is None or float(minimum) < 0 or float(metric.get("neutral", 0)) < 0:
            diagnostics.append(_diag(
                "fractional_product_domain",
                f"metric {metric_id!r} requires an explicitly non-negative domain and neutral for fractional product/power aggregation",
                "Application",
                f"/spec/metrics/{metric_id}/domain",
            ))
        for catalog_id, catalog in candidates.items():
            for candidate_id in catalog.get("candidates", {}):
                reference = _ref(catalog_id, candidate_id)
                value = _resolved_candidate_metrics(candidates, reference).get(metric_id)
                if value is not None and value < 0:
                    diagnostics.append(_diag(
                        "fractional_product_value",
                        f"candidate {reference!r} has a negative value for fractional product/power metric {metric_id!r}",
                        catalog_id,
                        f"/spec/candidates/{candidate_id}/metrics",
                    ))


def _expression_paths(node: Any) -> set[tuple[str, ...]]:
    paths: set[tuple[str, ...]] = set()
    if isinstance(node, dict):
        if (
            node.get("kind") == "path"
            and isinstance(node.get("segments"), list)
            and all(isinstance(segment, str) for segment in node["segments"])
        ):
            paths.add(tuple(node["segments"]))
        for child in node.values():
            paths |= _expression_paths(child)
    elif isinstance(node, list):
        for child in node:
            paths |= _expression_paths(child)
    return paths


def _constraints(
    resources: list[_Resource],
    roots: Mapping[str, str],
    paths: Mapping[str, str],
    diagnostics: list[CompileDiagnostic],
    source_map: dict[str, Any],
) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for resource in resources:
        source = resource.document.get("spec", {}).get("constraints", {})
        for constraint_id, value in source.items() if isinstance(source, dict) else []:
            pointer = f"/spec/constraints/{constraint_id}"
            if not isinstance(value, dict):
                continue
            assertion = _compile_condition(value.get("assert"), roots, paths, diagnostics, resource.path, pointer + "/assert")
            when = _compile_condition(value.get("when", True), roots, paths, diagnostics, resource.path, pointer + "/when")
            if assertion is None or when is None:
                continue
            item: dict[str, Any] = {"ref": _ref(resource.id, constraint_id), "when": when, "assert": assertion, "enforcement": value.get("enforcement")}
            if item["enforcement"] == "soft":
                try:
                    penalty = compile_expression(value.get("penalty"), allowed_roots=roots, path_types=paths, expected_type="number")
                    # Constant penalties can be rejected immediately; dynamic
                    # penalties are checked authoritatively for every solution.
                    try:
                        constant = penalty.evaluate({})
                    except ExpressionError:
                        constant = None
                    if constant is not None and (not isinstance(constant, (int, float)) or isinstance(constant, bool) or not math.isfinite(float(constant)) or constant < 0):
                        diagnostics.append(_diag("soft_penalty", "soft penalty must be finite and non-negative", resource.path, pointer + "/penalty"))
                    item["penalty"] = penalty.ast
                except ExpressionError as exc:
                    diagnostics.append(
                        _diag(
                            "soft_penalty",
                            str(exc),
                            resource.path,
                            pointer + "/penalty",
                            span=getattr(exc, "span", None),
                        )
                    )
                    continue
            result.append(item)
            ir_index = len(result) - 1
            source_map[f"/spec/constraints/{ir_index}"] = {"resource": resource.id, "path": resource.path, "pointer": pointer}
            for field in ("when", "assert", "penalty"):
                if field in value:
                    location: dict[str, Any] = {"resource": resource.id, "path": resource.path, "pointer": f"{pointer}/{field}"}
                    if isinstance(value[field], str):
                        location["span"] = {"start": 0, "end": len(value[field].strip())}
                    source_map[f"/spec/constraints/{ir_index}/{field}"] = location
    return result


def _lookup_candidate(candidates: Mapping[str, Any], reference: Mapping[str, Any]) -> dict[str, Any] | None:
    catalog = candidates.get(reference.get("resource"))
    values = catalog.get("candidates") if isinstance(catalog, Mapping) else None
    return values.get(reference.get("id")) if isinstance(values, Mapping) else None


def _resolved_candidate_metrics(candidates: Mapping[str, Any], reference: Mapping[str, Any]) -> dict[str, float]:
    catalog = candidates.get(reference.get("resource"))
    candidate = _lookup_candidate(candidates, reference)
    if not isinstance(catalog, Mapping) or candidate is None:
        return {}
    bindings = catalog.get("metricBindings", {})
    slots = candidate.get("metrics", {})
    return {
        metric_ref["id"]: float(slots[alias])
        for alias, metric_ref in bindings.items()
        if isinstance(metric_ref, Mapping) and alias in slots
    }


def _placement(
    resources: list[_Resource],
    indexed: Mapping[str, _Resource],
    candidates: Mapping[str, Any],
    tasks: Mapping[str, Any],
    metrics: Mapping[str, Any],
    application_id: str,
    diagnostics: list[CompileDiagnostic],
    source_map: dict[str, Any],
) -> list[dict[str, Any]]:
    lowered: list[dict[str, Any]] = []
    for resource in resources:
        spec = resource.document.get("spec", {})
        pools_source = spec.get("pools", {})
        pools: dict[str, Any] = {}
        for pool_id, value in pools_source.items() if isinstance(pools_source, dict) else []:
            capacity = value.get("capacity", {}) if isinstance(value, dict) else {}
            for dimension, amount in capacity.items() if isinstance(capacity, dict) else []:
                _finite(amount, f"/spec/pools/{pool_id}/capacity/{dimension}", diagnostics, resource.path, nonnegative=True)
            pools[pool_id] = {"ref": _ref(resource.id, pool_id), "kind": value.get("kind", "generic"), "capacity": capacity, "properties": value.get("properties", {})}
            if isinstance(value.get("name"), str):
                pools[pool_id]["name"] = value["name"]
            source_map[f"/spec/placement/{len(lowered)}/pools/{pool_id}"] = {"resource": resource.id, "path": resource.path, "pointer": f"/spec/pools/{pool_id}"}
        defaults = spec.get("defaults", {}) if isinstance(spec.get("defaults"), dict) else {}
        assignments: dict[tuple[str, str], dict[str, Any]] = {}

        def assign(
            candidate_ref: dict[str, str],
            pool_ref: dict[str, str],
            values: Mapping[str, Any],
            pointer: str,
            *,
            override: bool = False,
            _resource: _Resource = resource,
            _pools: Mapping[str, Any] = pools,
            _defaults: Mapping[str, Any] = defaults,
            _assignments: dict[tuple[str, str], dict[str, Any]] = assignments,
        ) -> None:
            key = _ref_key(candidate_ref)
            candidate = _lookup_candidate(candidates, candidate_ref)
            if candidate is None:
                diagnostics.append(_diag("placement_candidate_ref", f"unknown candidate ref {candidate_ref!r}", _resource.path, pointer + "/candidate"))
                return
            if pool_ref.get("resource") != _resource.id or pool_ref.get("id") not in _pools:
                diagnostics.append(_diag("placement_pool_ref", f"unknown pool ref {pool_ref!r}", _resource.path, pointer + "/pool"))
                return
            merged = {**_defaults, **dict(values)}
            for dimension, amount in merged.items():
                if not _finite(amount, f"{pointer}/resources/{dimension}", diagnostics, _resource.path, nonnegative=True):
                    continue
                capacity = _pools[pool_ref["id"]]["capacity"]
                if dimension not in capacity:
                    diagnostics.append(_diag("placement_dimension", f"pool lacks capacity dimension {dimension!r}", _resource.path, f"{pointer}/resources/{dimension}"))
                elif float(amount) > float(capacity[dimension]):
                    diagnostics.append(_diag("placement_capacity", f"candidate demand exceeds pool capacity for {dimension!r}", _resource.path, f"{pointer}/resources/{dimension}"))
            if key in _assignments and not override:
                diagnostics.append(_diag("placement_duplicate_assignment", f"candidate {candidate_ref!r} is assigned by multiple groups", _resource.path, pointer))
                return
            _assignments[key] = {"candidate": candidate_ref, "pool": pool_ref, "resources": merged}

        groups = spec.get("groups", {})
        for group_id, group in groups.items() if isinstance(groups, dict) else []:
            pool_ref = _validate_ref(group.get("pool"), resource.path, f"/spec/groups/{group_id}/pool", diagnostics)
            if pool_ref is None:
                continue
            refs: list[dict[str, str]] = []
            if isinstance(group.get("capability"), str):
                for catalog_id, catalog in candidates.items():
                    catalog_candidates = catalog.get("candidates", {}) if isinstance(catalog, Mapping) else {}
                    for candidate_id, candidate in catalog_candidates.items():
                        if any(capability.get("type") == group["capability"] for capability in candidate.get("provides", [])):
                            refs.append(_ref(catalog_id, candidate_id))
            else:
                for candidate_ref in group.get("candidates", []):
                    normalized = _validate_ref(candidate_ref, resource.path, f"/spec/groups/{group_id}/candidates", diagnostics)
                    if normalized:
                        refs.append(normalized)
            for candidate_ref in refs:
                assign(candidate_ref, pool_ref, group.get("resources", {}), f"/spec/groups/{group_id}")
        for index, demand in enumerate(spec.get("demands", [])):
            candidate_ref = _validate_ref(demand.get("candidate"), resource.path, f"/spec/demands/{index}/candidate", diagnostics)
            pool_ref = _validate_ref(demand.get("pool"), resource.path, f"/spec/demands/{index}/pool", diagnostics)
            if candidate_ref and pool_ref:
                assign(candidate_ref, pool_ref, demand.get("resources", {}), f"/spec/demands/{index}", override=True)
        network: list[dict[str, Any]] = []
        network_pairs: set[tuple[tuple[str, str], tuple[str, str]]] = set()
        network_values: dict[tuple[tuple[str, str], tuple[str, str]], float] = {}
        for index, link in enumerate(spec.get("network", [])):
            from_ref = _validate_ref(link.get("from"), resource.path, f"/spec/network/{index}/from", diagnostics)
            to_ref = _validate_ref(link.get("to"), resource.path, f"/spec/network/{index}/to", diagnostics)
            if from_ref is None or to_ref is None:
                continue
            if from_ref["resource"] != resource.id or from_ref["id"] not in pools:
                diagnostics.append(_diag("placement_network_ref", f"unknown source pool {from_ref!r}", resource.path, f"/spec/network/{index}/from"))
            if to_ref["resource"] != resource.id or to_ref["id"] not in pools:
                diagnostics.append(_diag("placement_network_ref", f"unknown target pool {to_ref!r}", resource.path, f"/spec/network/{index}/to"))
            key = (_ref_key(from_ref), _ref_key(to_ref))
            if key in network_pairs:
                diagnostics.append(_diag("placement_network_duplicate", "network contains a duplicate directed pool pair", resource.path, f"/spec/network/{index}"))
            network_pairs.add(key)
            latency = link.get("latency")
            _finite(latency, f"/spec/network/{index}/latency", diagnostics, resource.path, nonnegative=True)
            network.append({"from": from_ref, "to": to_ref, "latency": latency})
            if isinstance(latency, (int, float)) and not isinstance(latency, bool):
                network_values[key] = float(latency)
        if spec.get("networkMode", "directed") == "symmetric":
            for link in list(network):
                forward = (_ref_key(link["from"]), _ref_key(link["to"]))
                reverse = (forward[1], forward[0])
                if forward[0] == forward[1] or forward not in network_values:
                    continue
                if reverse in network_values:
                    if network_values[reverse] != network_values[forward]:
                        diagnostics.append(_diag(
                            "placement_network_symmetric_conflict",
                            "symmetric network declares different latency in opposite directions",
                            resource.path,
                            "/spec/network",
                        ))
                    continue
                network.append({"from": link["to"], "to": link["from"], "latency": link["latency"]})
                network_pairs.add(reverse)
                network_values[reverse] = network_values[forward]
        events: dict[str, Any] = {}
        for event_id, event in spec.get("events", {}).items() if isinstance(spec.get("events"), dict) else []:
            pool_ref = _validate_ref(event.get("pool"), resource.path, f"/spec/events/{event_id}/pool", diagnostics)
            if pool_ref and pool_ref.get("resource") == resource.id and pool_ref.get("id") in pools:
                latency_entries: list[dict[str, Any]] = []
                latency_pools: set[tuple[str, str]] = set()
                for index, entry in enumerate(event.get("latency", [])):
                    target = _validate_ref(entry.get("pool"), resource.path, f"/spec/events/{event_id}/latency/{index}/pool", diagnostics)
                    if target is None:
                        continue
                    if target["resource"] != resource.id or target["id"] not in pools:
                        diagnostics.append(_diag("placement_event_pool", f"unknown event latency pool {target!r}", resource.path, f"/spec/events/{event_id}/latency/{index}/pool"))
                    if _ref_key(target) in latency_pools:
                        diagnostics.append(_diag("placement_event_duplicate", "event contains duplicate latency pool", resource.path, f"/spec/events/{event_id}/latency/{index}/pool"))
                    latency_pools.add(_ref_key(target))
                    latency = entry.get("latency")
                    _finite(latency, f"/spec/events/{event_id}/latency/{index}/latency", diagnostics, resource.path, nonnegative=True)
                    latency_entries.append({"pool": target, "latency": latency})
                events[event_id] = {"ref": _ref(resource.id, event_id), "pool": pool_ref, "latency": latency_entries}
            elif pool_ref:
                diagnostics.append(_diag("placement_event_pool", f"unknown event source pool {pool_ref!r}", resource.path, f"/spec/events/{event_id}/pool"))
        transitions: list[dict[str, Any]] = []
        for transition_id, transition in spec.get("transitions", {}).items() if isinstance(spec.get("transitions"), dict) else []:
            endpoints: dict[str, Any] = {}
            for endpoint in ("from", "to"):
                endpoint_ref = _validate_ref(transition.get(endpoint), resource.path, f"/spec/transitions/{transition_id}/{endpoint}", diagnostics)
                if endpoint_ref is None:
                    continue
                target_resource = indexed.get(endpoint_ref["resource"])
                valid = (
                    target_resource
                    and target_resource.kind == "Application"
                    and endpoint_ref["id"] in tasks
                    and tasks[endpoint_ref["id"]].get("kind") == "service"
                ) or (endpoint_ref["resource"] == resource.id and endpoint_ref["id"] in events)
                if not valid:
                    diagnostics.append(_diag("placement_transition_ref", f"unknown transition endpoint {endpoint_ref!r}", resource.path, f"/spec/transitions/{transition_id}/{endpoint}"))
                endpoints[endpoint] = endpoint_ref
            maximum = transition.get("maximum")
            _finite(maximum, f"/spec/transitions/{transition_id}/maximum", diagnostics, resource.path, nonnegative=True)
            metric_ref = _validate_ref(transition.get("metric"), resource.path, f"/spec/transitions/{transition_id}/metric", diagnostics)
            if metric_ref and (metric_ref["resource"] != application_id or metric_ref["id"] not in metrics):
                diagnostics.append(_diag("placement_transition_metric", "transition metric must reference an Application metric", resource.path, f"/spec/transitions/{transition_id}/metric"))
            normalized_transition = {"ref": _ref(resource.id, transition_id), **endpoints, "metric": metric_ref, "maximum": maximum, "enforcement": transition.get("enforcement", "hard")}
            if normalized_transition["enforcement"] == "soft":
                penalty = transition.get("penalty")
                _finite(penalty, f"/spec/transitions/{transition_id}/penalty", diagnostics, resource.path, nonnegative=True)
                normalized_transition["penalty"] = penalty
            transitions.append(normalized_transition)
        global_latency_source = spec.get("globalLatency")
        global_latency: dict[str, Any] | None = None
        if isinstance(global_latency_source, dict):
            metric_ref = _validate_ref(global_latency_source.get("metric"), resource.path, "/spec/globalLatency/metric", diagnostics)
            if metric_ref and (metric_ref["resource"] != application_id or metric_ref["id"] not in metrics):
                diagnostics.append(_diag("placement_global_metric", "global latency metric must reference the Application", resource.path, "/spec/globalLatency/metric"))
            if metric_ref:
                global_latency = {
                    "metric": metric_ref,
                    "includeExecution": bool(global_latency_source.get("includeExecution", True)),
                    "exclusive": global_latency_source.get("exclusive", "routing"),
                    "parallel": global_latency_source.get("parallel", "max"),
                }
                source_map[f"/spec/placement/{len(lowered)}/globalLatency"] = {
                    "resource": resource.id,
                    "path": resource.path,
                    "pointer": "/spec/globalLatency",
                }
        capacity_rules: list[dict[str, Any]] = []
        available_dimensions = {dimension for pool in pools.values() for dimension in pool.get("capacity", {})}
        for index, rule in enumerate(spec.get("capacityRules", [])):
            unknown = sorted(set(rule.get("resources", [])) - available_dimensions)
            if unknown:
                diagnostics.append(_diag("placement_capacity_rule", f"capacity rule uses unknown dimensions: {', '.join(unknown)}", resource.path, f"/spec/capacityRules/{index}/resources"))
            capacity_rules.append({
                "ref": _ref(resource.id, f"capacityRules/{index}"),
                "resources": sorted(set(rule.get("resources", []))),
                "scope": rule.get("scope"),
            })
            source_map[f"/spec/placement/{len(lowered)}/capacityRules/{index}"] = {
                "resource": resource.id,
                "path": resource.path,
                "pointer": f"/spec/capacityRules/{index}",
            }
        lowered.append({
            "resource": resource.id,
            "pools": pools,
            "demands": list(assignments.values()),
            "network": network,
            "events": events,
            "transitions": transitions,
            **({"globalLatency": global_latency} if global_latency is not None else {}),
            **({"capacityRules": capacity_rules} if capacity_rules else {}),
        })
    return lowered


def _placement_constraints(placement: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Expose placement constraints to Optimization without pretending they are CEL.

    Capacity rules are always hard. Transition bounds may be soft and therefore
    participate in the same explicit penalty contract as a ConstraintSet item.
    """
    result: list[dict[str, Any]] = []
    for model in placement:
        for rule in model.get("capacityRules", []):
            result.append({"ref": rule["ref"], "enforcement": "hard"})
        for transition in model.get("transitions", []):
            result.append({
                "ref": transition["ref"],
                "enforcement": transition["enforcement"],
            })
    return result


def _placement_variant_bound(
    node: Mapping[str, Any], routed_branch_ids: set[str], limit: int = 4096
) -> int:
    """Return a capped upper bound for latency variants materialized at runtime."""

    cap = limit + 1

    def multiply(values: Iterable[int]) -> int:
        result = 1
        for value in values:
            if value and result > limit // value:
                return cap
            result *= value
        return min(result, cap)

    kind = node.get("kind")
    if kind in {"task", "empty"}:
        return 1
    if kind in {"sequence", "parallel"}:
        children = node.get("steps", node.get("branches", []))
        return multiply(
            _placement_variant_bound(child, routed_branch_ids, limit)
            for child in children
        )
    if kind == "exclusive":
        branches = node.get("branches", [])
        bounds = [
            _placement_variant_bound(branch.get("flow", {}), routed_branch_ids, limit)
            for branch in branches
        ]
        if branches and all(str(branch.get("id")) in routed_branch_ids for branch in branches):
            return min(sum(bounds), cap)
        return max(bounds, default=1)
    if kind == "repeat":
        body = _placement_variant_bound(node.get("body", {}), routed_branch_ids, limit)
        if "count" not in node:
            return body
        count = int(node.get("count", 0))
        result, factor = 1, body
        while count:
            if count & 1:
                result = multiply((result, factor))
                if result > limit:
                    return cap
            count //= 2
            if count:
                factor = multiply((factor, factor))
        return result
    return 1


def _workflow_service_tasks(
    node: Mapping[str, Any], eligibility: Mapping[str, list[dict[str, str]]]
) -> set[str]:
    result: set[str] = set()
    kind = node.get("kind")
    if kind == "task":
        task_id = str(node.get("task", {}).get("id"))
        if task_id in eligibility:
            result.add(task_id)
    elif kind in {"sequence", "parallel"}:
        for child in node.get("steps", node.get("branches", [])):
            result |= _workflow_service_tasks(child, eligibility)
    elif kind == "exclusive":
        for branch in node.get("branches", []):
            result |= _workflow_service_tasks(branch.get("flow", {}), eligibility)
    elif kind == "repeat":
        result |= _workflow_service_tasks(node.get("body", {}), eligibility)
    return result


def _validate_placement_contract(
    placement: list[dict[str, Any]],
    workflow: Mapping[str, Any],
    routing: list[dict[str, Any]],
    eligibility: Mapping[str, list[dict[str, str]]],
    diagnostics: list[CompileDiagnostic],
) -> None:
    if not placement:
        return

    assigned: dict[tuple[str, str], str] = {}
    global_metrics: dict[tuple[str, str], str] = {}
    workflow_tasks = _workflow_service_tasks(workflow, eligibility)
    routed_branch_ids = {str(entry["target"]["id"]) for entry in routing}
    for model in placement:
        resource = str(model["resource"])
        for demand in model.get("demands", []):
            key = _ref_key(demand["candidate"])
            previous = assigned.get(key)
            if previous is not None:
                diagnostics.append(_diag(
                    "placement_duplicate_assignment",
                    f"candidate {demand['candidate']!r} is assigned in both {previous!r} and {resource!r}",
                    resource,
                    "/spec/demands",
                ))
            else:
                assigned[key] = resource
        global_latency = model.get("globalLatency")
        if isinstance(global_latency, Mapping):
            metric_key = _ref_key(global_latency["metric"])
            previous = global_metrics.get(metric_key)
            if previous is not None:
                diagnostics.append(_diag(
                    "placement_global_metric_duplicate",
                    f"metric {global_latency['metric']!r} is derived by both {previous!r} and {resource!r}",
                    resource,
                    "/spec/globalLatency/metric",
                ))
            else:
                global_metrics[metric_key] = resource
            oversized_repeat = any(
                int(repeat.get("count", 0)) > 10_000
                for repeat in _walk_repeats(workflow)
                if "count" in repeat
            )
            if oversized_repeat:
                diagnostics.append(_diag(
                    "placement_repeat_limit",
                    "placement latency exact repeat count exceeds 10000",
                    resource,
                    "/spec/globalLatency",
                ))
            elif _placement_variant_bound(workflow, routed_branch_ids) > 4096:
                diagnostics.append(_diag(
                    "placement_variant_limit",
                    "placement latency expands to more than 4096 deterministic routing variants",
                    resource,
                    "/spec/globalLatency",
                ))
            exclusive_mode = global_latency.get("exclusive")
            routed = {_ref_key(entry["target"]) for entry in routing}
            for exclusive in _walk_exclusive(workflow):
                branches = exclusive.get("branches", [])
                branch_ids = {str(branch.get("id")) for branch in branches}
                has_routing = branch_ids and branch_ids.issubset({local_id for _, local_id in routed})
                has_conditions = bool(branches) and all("when" in branch for branch in branches)
                if exclusive_mode == "routing" and not has_routing:
                    diagnostics.append(_diag(
                        "placement_global_routing",
                        "globalLatency.exclusive=routing requires probabilities for every XOR",
                        resource,
                        "/spec/globalLatency/exclusive",
                    ))
                if exclusive_mode == "condition" and not has_conditions:
                    diagnostics.append(_diag(
                        "placement_global_condition",
                        "globalLatency.exclusive=condition requires a condition on every XOR branch",
                        resource,
                        "/spec/globalLatency/exclusive",
                    ))

            for task_id in sorted(workflow_tasks):
                for reference in eligibility.get(task_id, []):
                    if assigned.get(_ref_key(reference)) != resource:
                        diagnostics.append(_diag(
                            "placement_assignment_wrong_model",
                            f"eligible candidate {reference!r} for workflow task {task_id!r} is not assigned in global latency placement {resource!r}",
                            resource,
                            "/spec/globalLatency",
                        ))

        for transition in model.get("transitions", []):
            for endpoint_name in ("from", "to"):
                endpoint = transition.get(endpoint_name)
                if not isinstance(endpoint, Mapping) or endpoint.get("resource") == resource:
                    continue
                task_id = str(endpoint.get("id"))
                for reference in eligibility.get(task_id, []):
                    if assigned.get(_ref_key(reference)) != resource:
                        diagnostics.append(_diag(
                            "placement_assignment_wrong_model",
                            f"eligible candidate {reference!r} for transition task {task_id!r} is not assigned in placement {resource!r}",
                            resource,
                            "/spec/transitions",
                        ))
        rules = model.get("capacityRules", [])
        for rule in rules:
            for pool_id, pool in model.get("pools", {}).items():
                absent = sorted(set(rule["resources"]) - set(pool.get("capacity", {})))
                if absent:
                    diagnostics.append(_diag(
                        "placement_capacity_dimension",
                        f"pool {pool_id!r} does not declare constrained dimensions: {', '.join(absent)}",
                        resource,
                        "/spec/pools",
                    ))

        if global_latency or model.get("transitions"):
            assigned_pools = {
                _ref_key(demand["pool"]) for demand in model.get("demands", [])
            }
            links = {
                (_ref_key(link["from"]), _ref_key(link["to"]))
                for link in model.get("network", [])
            }
            missing_links = [
                (source, target)
                for source in sorted(assigned_pools)
                for target in sorted(assigned_pools)
                if source != target and (source, target) not in links
            ]
            if missing_links:
                preview = ", ".join(
                    f"{source[1]}->{target[1]}" for source, target in missing_links[:8]
                )
                suffix = " ..." if len(missing_links) > 8 else ""
                diagnostics.append(_diag(
                    "placement_network_incomplete",
                    f"directed network lacks required pool links: {preview}{suffix}",
                    resource,
                    "/spec/network",
                ))
            for event_id, event in model.get("events", {}).items():
                explicit_targets = {_ref_key(entry["pool"]) for entry in event.get("latency", [])}
                event_pool = _ref_key(event["pool"])
                unreachable = [
                    target
                    for target in sorted(assigned_pools)
                    if target not in explicit_targets
                    and target != event_pool
                    and (event_pool, target) not in links
                ]
                if unreachable:
                    diagnostics.append(_diag(
                        "placement_event_latency_incomplete",
                        f"event {event_id!r} cannot reach pools: {', '.join(target[1] for target in unreachable)}",
                        resource,
                        f"/spec/events/{event_id}",
                    ))

    eligible = {
        _ref_key(reference)
        for references in eligibility.values()
        for reference in references
    }
    missing = eligible - set(assigned)
    for catalog_id, candidate_id in sorted(missing):
        diagnostics.append(_diag(
            "placement_assignment_missing",
            f"eligible candidate {_ref(catalog_id, candidate_id)!r} has no placement demand/pool assignment",
            catalog_id,
            f"/spec/candidates/{candidate_id}",
        ))


def _optimization(
    resource: _Resource,
    application_id: str,
    metrics: Mapping[str, Any],
    constraints: list[dict[str, Any]],
    diagnostics: list[CompileDiagnostic],
    source_map: dict[str, Any],
) -> dict[str, Any]:
    spec = resource.document.get("spec", {})
    mode = spec.get("mode")
    terms: list[dict[str, Any]] = []
    units: set[str] = set()
    for index, value in enumerate(spec.get("terms", [])):
        metric_ref = _validate_ref(value.get("metric"), resource.path, f"/spec/terms/{index}/metric", diagnostics)
        if metric_ref is None or metric_ref["resource"] != application_id or metric_ref["id"] not in metrics:
            diagnostics.append(_diag("optimization_metric", "optimization term must reference an Application metric", resource.path, f"/spec/terms/{index}/metric"))
            continue
        weight = value.get("weight", 1)
        if not _finite(weight, f"/spec/terms/{index}/weight", diagnostics, resource.path) or float(weight) <= 0:
            diagnostics.append(_diag("optimization_weight", "term weight must be positive", resource.path, f"/spec/terms/{index}/weight"))
            continue
        item = {"metric": metric_ref, "direction": value.get("direction", metrics[metric_ref["id"]]["direction"]), "weight": float(weight)}
        normalize = value.get("normalize")
        # `ratio` is a normative, typed domain contract, not a heuristic based
        # on metric name or unit.  Its closed [0,1] bounds are therefore a safe
        # concise spelling of the same explicit optimization normalization.
        if normalize is None and metrics[metric_ref["id"]].get("domain", {}).get("kind") == "ratio":
            normalize = {"min": 0.0, "max": 1.0, "clamp": False}
        if normalize is not None:
            if not all(_finite(normalize.get(key), f"/spec/terms/{index}/normalize/{key}", diagnostics, resource.path) for key in ("min", "max")) or float(normalize.get("max", 0)) <= float(normalize.get("min", 0)):
                diagnostics.append(_diag("normalization", "normalize.max must be greater than normalize.min", resource.path, f"/spec/terms/{index}/normalize"))
            else:
                item["normalize"] = {
                    "min": float(normalize["min"]),
                    "max": float(normalize["max"]),
                    "clamp": bool(normalize.get("clamp", False)),
                }
        units.add(metrics[metric_ref["id"]]["unit"])
        terms.append(item)
        source_map[f"/spec/optimization/terms/{len(terms) - 1}"] = {"resource": resource.id, "path": resource.path, "pointer": f"/spec/terms/{index}"}
    if mode == "satisfy" and terms:
        diagnostics.append(_diag("satisfy_terms", "satisfy mode cannot contain objective terms", resource.path, "/spec/terms"))
    if mode != "satisfy" and not terms:
        diagnostics.append(_diag("optimization_terms", f"{mode} mode requires at least one term", resource.path, "/spec/terms"))
    objective_type = spec.get("type")
    if objective_type is None:
        objective_type = (
            "MONO"
            if mode != "pareto" or len(terms) <= 1
            else "MULTI"
            if len(terms) == 2
            else "MANY"
        )
    cardinality = len(terms)
    if objective_type == "MULTI" and not 2 <= cardinality <= 3:
        diagnostics.append(_diag("objective_cardinality", "MULTI requires two or three objective terms", resource.path, "/spec/terms"))
    elif objective_type == "MANY" and cardinality < 3:
        diagnostics.append(_diag("objective_cardinality", "MANY requires at least three objective terms", resource.path, "/spec/terms"))
    elif objective_type == "MONO" and mode != "satisfy" and cardinality < 1:
        diagnostics.append(_diag("objective_cardinality", "MONO requires at least one objective term", resource.path, "/spec/terms"))
    if len(units) > 1:
        for index, term in enumerate(terms):
            if "normalize" not in term:
                diagnostics.append(_diag("normalization_required", "terms with different units require explicit normalization", resource.path, f"/spec/terms/{index}/normalize"))
    if mode == "weighted":
        total = sum(term["weight"] for term in terms)
        for term in terms:
            term["weight"] /= total
    elif mode in {"lexicographic", "pareto"}:
        # Weights are irrelevant to these strategies; canonicalize them to one
        # instead of smuggling weighted semantics into the mode.
        for term in terms:
            term["weight"] = 1.0
    constraint_index = {_ref_key(constraint["ref"]): constraint for constraint in constraints}
    penalties: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for index, value in enumerate(spec.get("penalties", [])):
        constraint_ref = _validate_ref(value.get("constraint"), resource.path, f"/spec/penalties/{index}/constraint", diagnostics)
        if constraint_ref is None:
            continue
        key = _ref_key(constraint_ref)
        target = constraint_index.get(key)
        if target is None or target.get("enforcement") != "soft":
            diagnostics.append(_diag("optimization_penalty_ref", "penalty must reference an existing soft constraint", resource.path, f"/spec/penalties/{index}/constraint"))
            continue
        if key in seen:
            diagnostics.append(_diag("optimization_penalty_duplicate", "soft constraint is referenced more than once", resource.path, f"/spec/penalties/{index}/constraint"))
            continue
        seen.add(key)
        weight = value.get("weight", 1)
        if not _finite(weight, f"/spec/penalties/{index}/weight", diagnostics, resource.path) or float(weight) <= 0:
            diagnostics.append(_diag("optimization_penalty_weight", "penalty weight must be positive", resource.path, f"/spec/penalties/{index}/weight"))
            continue
        penalties.append({"constraint": constraint_ref, "weight": float(weight)})
    for key, constraint in constraint_index.items():
        if constraint["enforcement"] == "soft" and key not in seen:
            diagnostics.append(_diag("inert_soft", f"soft constraint {constraint['ref']!r} is not in Optimization", resource.path, "/spec/penalties"))
    if penalties:
        total = sum(item["weight"] for item in penalties)
        for item in penalties:
            item["weight"] /= total
    return {"resource": resource.id, "mode": mode, "type": objective_type, "terms": terms, "penalties": penalties}


def _required_metrics(
    optimization: Mapping[str, Any],
    constraints: list[dict[str, Any]],
    placement: list[dict[str, Any]],
) -> tuple[set[str], dict[str, set[str]]]:
    global_metrics = {term["metric"]["id"] for term in optimization.get("terms", [])}
    local: dict[str, set[str]] = {}
    for constraint in constraints:
        for segments in _expression_paths(constraint):
            if len(segments) == 2 and segments[0] == "metrics":
                global_metrics.add(segments[1])
            elif len(segments) == 4 and segments[0] == "tasks" and segments[2] == "metrics":
                local.setdefault(segments[1], set()).add(segments[3])
    for model in placement:
        global_latency = model.get("globalLatency")
        if isinstance(global_latency, Mapping):
            global_metrics.add(global_latency["metric"]["id"])
    return global_metrics, local


@dataclass(frozen=True)
class CompiledProblem:
    """Canonical, schema-validated output of an installed Profile adapter."""

    document: dict[str, Any]
    digest: str
    source_map: dict[str, Any]

    def as_dict(self) -> dict[str, Any]:
        return self.document


@dataclass(frozen=True)
class BindingProblem(CompiledProblem):
    """Canonical BIM v1 engine input; no source files or URLs are retained."""

    def _candidate(self, reference: Mapping[str, Any]) -> dict[str, Any]:
        candidate = _lookup_candidate(self.document["spec"]["candidates"], reference)
        if candidate is None:
            raise ValueError(f"unknown candidate reference: {dict(reference)!r}")
        return candidate

    def validate_binding(self, binding: Mapping[str, Any]) -> dict[str, dict[str, str]]:
        if not isinstance(binding, Mapping):
            raise ValueError("binding must be an object")
        spec = self.document["spec"]
        tasks = spec["application"]["tasks"]
        required = {task_id for task_id, task in tasks.items() if task["kind"] == "service"}
        if set(binding) != required:
            missing, extra = sorted(required - set(binding)), sorted(set(binding) - required)
            raise ValueError(f"binding must contain exactly service tasks; missing={missing}, extra={extra}")
        normalized: dict[str, dict[str, str]] = {}
        for task_id, value in binding.items():
            if not isinstance(value, Mapping) or set(value) != {"resource", "id"} or not all(isinstance(value.get(key), str) for key in ("resource", "id")):
                raise ValueError(f"binding value for {task_id!r} must be {{resource,id}}")
            reference = _ref(str(value["resource"]), str(value["id"]))
            if reference not in spec["eligibility"].get(task_id, []):
                raise ValueError(f"candidate {reference!r} is not eligible for task {task_id!r}")
            self._candidate(reference)
            normalized[task_id] = reference
        return normalized

    @staticmethod
    def _neutral(operator_name: str) -> float:
        return 1.0 if operator_name in {"product", "weightedProduct", "power"} else 0.0

    @staticmethod
    def _apply_operator(operator_value: Any, values: list[float], *, weights: list[float] | None = None, count: float | None = None) -> float:
        if isinstance(operator_value, dict) and "expression" in operator_value:
            result = Expression(operator_value["expression"], "number").evaluate({"values": values, "weights": weights or [], "count": count or 0.0})
            if not isinstance(result, (int, float)) or isinstance(result, bool) or not math.isfinite(float(result)):
                raise ValueError("aggregation expression returned a non-finite number")
            return float(result)
        operator_name = str(operator_value)
        if not values:
            return BindingProblem._neutral(operator_name)
        if operator_name == "sum":
            return sum(values)
        if operator_name == "product":
            result = 1.0
            for value in values:
                result *= value
            return result
        if operator_name == "min":
            return min(values)
        if operator_name == "max":
            return max(values)
        if operator_name == "weightedSum":
            if weights is None or len(weights) != len(values):
                raise ValueError("weightedSum requires one routing weight per value")
            return sum(value * weight for value, weight in zip(values, weights, strict=True))
        if operator_name == "weightedProduct":
            if weights is None or len(weights) != len(values):
                raise ValueError("weightedProduct requires one routing weight per value")
            result = 1.0
            for value, weight in zip(values, weights, strict=True):
                if weight == 0:
                    continue
                if value < 0 and not float(weight).is_integer():
                    raise ValueError("weightedProduct cannot raise a negative value to a fractional routing weight")
                result *= value ** weight
            return result
        if operator_name == "scale":
            return values[0] * float(count or 0.0)
        if operator_name == "power":
            if values[0] < 0 and not float(count or 0.0).is_integer():
                raise ValueError("power cannot raise a negative value to a fractional expected count")
            return values[0] ** float(count or 0.0)
        if operator_name == "identity":
            return values[0]
        raise ValueError(f"unknown aggregation operator: {operator_name}")

    def _task_context(self, binding: Mapping[str, dict[str, str]]) -> dict[str, Any]:
        tasks: dict[str, Any] = {}
        for task_id, reference in binding.items():
            candidate = self._candidate(reference)
            task_context = {
                "candidate": reference,
                "metrics": _resolved_candidate_metrics(self.document["spec"]["candidates"], reference),
                "properties": candidate.get("properties", {}),
            }
            if "provider" in candidate:
                task_context["provider"] = candidate["provider"]
            tasks[task_id] = task_context
        return {
            "binding": dict(binding),
            "tasks": tasks,
            "placement": self.document["spec"].get("placement", []),
            "extensions": self.document["spec"].get("extensions", {}),
        }

    def _placement_assignment(
        self, reference: Mapping[str, Any]
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        key = _ref_key(reference)
        found: list[tuple[dict[str, Any], dict[str, Any]]] = []
        for model in self.document["spec"].get("placement", []):
            for demand in model.get("demands", []):
                if _ref_key(demand["candidate"]) == key:
                    found.append((model, demand))
        if len(found) != 1:
            raise ValueError(
                f"candidate {dict(reference)!r} must have exactly one placement assignment; found {len(found)}"
            )
        return found[0]

    @staticmethod
    def _network_latency(
        model: Mapping[str, Any],
        source: Mapping[str, Any],
        target: Mapping[str, Any],
    ) -> float:
        source_key, target_key = _ref_key(source), _ref_key(target)
        for link in model.get("network", []):
            if _ref_key(link["from"]) == source_key and _ref_key(link["to"]) == target_key:
                return float(link["latency"])
        # Co-location has a compact, normative zero default.  Every non-local
        # direction must be present explicitly; there is no reverse lookup.
        if source_key == target_key:
            return 0.0
        raise ValueError(
            f"placement {model.get('resource')!r} has no directed network latency "
            f"from {dict(source)!r} to {dict(target)!r}"
        )

    @staticmethod
    def _event_latency(
        model: Mapping[str, Any], event_id: str, target: Mapping[str, Any]
    ) -> float:
        event = model.get("events", {}).get(event_id)
        if not isinstance(event, Mapping):
            raise ValueError(f"unknown placement event {event_id!r}")
        target_key = _ref_key(target)
        for entry in event.get("latency", []):
            if _ref_key(entry["pool"]) == target_key:
                return float(entry["latency"])
        # An event may compactly inherit the explicit directed pool network
        # from its declared source pool.  This is deterministic and never
        # falls back to the reverse direction.
        return BindingProblem._network_latency(model, event["pool"], target)

    def _task_invocations(
        self,
        node: Mapping[str, Any],
        binding: Mapping[str, dict[str, str]],
        multiplier: float = 1.0,
    ) -> dict[str, float]:
        result: dict[str, float] = {}

        def add(task_id: str, amount: float) -> None:
            result[task_id] = result.get(task_id, 0.0) + amount

        def walk(value: Mapping[str, Any], factor: float) -> None:
            kind = value.get("kind")
            if kind == "task":
                task_id = value.get("task", {}).get("id")
                if task_id in binding:
                    add(str(task_id), factor)
                return
            if kind in {"sequence", "parallel"}:
                for child in value.get("steps", value.get("branches", [])):
                    walk(child, factor)
                return
            if kind == "repeat":
                walk(value.get("body", {}), factor * float(value.get("count", value.get("expectedCount"))))
                return
            if kind == "exclusive":
                branches = value.get("branches", [])
                routing = {
                    entry["target"]["id"]: float(entry["probability"])
                    for entry in self.document["spec"].get("routing", [])
                }
                if branches and all(branch.get("id") in routing for branch in branches):
                    for branch in branches:
                        walk(branch.get("flow", {}), factor * routing[branch["id"]])
                    return
                context = self._task_context(binding)
                selected = [
                    branch
                    for branch in branches
                    if "when" in branch and bool(Expression(branch["when"], "bool").evaluate(context))
                ]
                if len(selected) != 1:
                    raise ValueError(f"static XOR must select exactly one branch, got {len(selected)}")
                walk(selected[0].get("flow", {}), factor)

        walk(node, multiplier)
        return result

    def _global_latency(
        self,
        model: Mapping[str, Any],
        binding: Mapping[str, dict[str, str]],
    ) -> float:
        """Schedule structured workflow variants for one placement latency model.

        A state is a probability plus the ready times of its current frontier.
        Routing XORs enumerate weighted variants, conditional XORs select one,
        AND frontiers join through max-ready semantics, and expected repeats
        scale the duration of one representative iteration deterministically.
        """
        config = model["globalLatency"]
        metric_id = config["metric"]["id"]
        context = self._task_context(binding)
        routing = {
            entry["target"]["id"]: float(entry["probability"])
            for entry in self.document["spec"].get("routing", [])
        }
        # frontier entries are (kind, identifier/ref-key, ready-time)
        Frontier = list[tuple[str, Any, float]]
        Variant = tuple[float, Frontier]
        initial: Frontier = [
            ("event", event_id, 0.0)
            for event_id in sorted(model.get("events", {}))
        ]
        limit = 4096

        def bounded(values: list[Variant]) -> list[Variant]:
            if len(values) > limit:
                raise ValueError(
                    f"placement latency expands to more than {limit} deterministic routing variants"
                )
            return values

        def pool_for_task(task_id: str) -> dict[str, str] | None:
            if task_id not in binding:
                return None
            assigned_model, demand = self._placement_assignment(binding[task_id])
            if assigned_model.get("resource") != model.get("resource"):
                raise ValueError(
                    f"task {task_id!r} is assigned outside global latency placement {model.get('resource')!r}"
                )
            return demand["pool"]

        def transfer(source: tuple[str, Any, float], target: Mapping[str, Any]) -> float:
            if source[0] == "event":
                return self._event_latency(model, str(source[1]), target)
            source_ref = _ref(str(source[1][0]), str(source[1][1]))
            return self._network_latency(model, source_ref, target)

        def evaluate_node(node: Mapping[str, Any], variants: list[Variant]) -> list[Variant]:
            kind = node.get("kind")
            if kind == "empty":
                return variants
            if kind == "task":
                task_id = str(node.get("task", {}).get("id"))
                pool = pool_for_task(task_id)
                if pool is None:  # local task: no placement or transfer boundary
                    return variants
                candidate = binding[task_id]
                execution = 0.0
                if config.get("includeExecution"):
                    execution = float(_resolved_candidate_metrics(
                        self.document["spec"]["candidates"], candidate
                    )[metric_id])
                output: list[Variant] = []
                for probability, frontier in variants:
                    start = max(
                        (source[2] + transfer(source, pool) for source in frontier),
                        default=0.0,
                    )
                    output.append((probability, [("pool", _ref_key(pool), start + execution)]))
                return output
            if kind == "sequence":
                current = variants
                for child in node.get("steps", []):
                    current = evaluate_node(child, current)
                return current
            if kind == "parallel":
                branches = node.get("branches", [])
                # Evaluate all branches from the same incoming frontier, then
                # take the Cartesian product of their routing alternatives.
                result: list[Variant] = []
                for base_probability, base_frontier in variants:
                    combinations: list[tuple[float, list[Frontier]]] = [(base_probability, [])]
                    for branch in branches:
                        branch_variants = evaluate_node(branch, [(1.0, list(base_frontier))])
                        next_combinations: list[tuple[float, list[Frontier]]] = []
                        for probability, frontiers in combinations:
                            for branch_probability, branch_frontier in branch_variants:
                                next_combinations.append((
                                    probability * branch_probability,
                                    frontiers + [branch_frontier],
                                ))
                        if len(next_combinations) > limit:
                            raise ValueError(
                                f"placement latency expands to more than {limit} deterministic routing variants"
                            )
                        combinations = next_combinations
                    if config.get("parallel") == "sum":
                        baseline = max((source[2] for source in base_frontier), default=0.0)
                        for probability, frontiers in combinations:
                            durations = [
                                max((source[2] - baseline for source in frontier), default=0.0)
                                for frontier in frontiers
                            ]
                            finish = baseline + sum(max(0.0, value) for value in durations)
                            flattened = [
                                (source[0], source[1], finish)
                                for frontier in frontiers
                                for source in frontier
                            ]
                            result.append((probability, flattened))
                    else:
                        result.extend(
                            (probability, [source for frontier in frontiers for source in frontier])
                            for probability, frontiers in combinations
                        )
                return bounded(result)
            if kind == "exclusive":
                branches = node.get("branches", [])
                result: list[Variant] = []
                if config.get("exclusive") == "routing":
                    for branch in branches:
                        branch_probability = routing[branch["id"]]
                        for probability, frontier in variants:
                            for nested_probability, nested_frontier in evaluate_node(
                                branch.get("flow", {}), [(1.0, list(frontier))]
                            ):
                                result.append((
                                    probability * branch_probability * nested_probability,
                                    nested_frontier,
                                ))
                    return bounded(result)
                selected = [
                    branch
                    for branch in branches
                    if "when" in branch and bool(Expression(branch["when"], "bool").evaluate(context))
                ]
                if len(selected) != 1:
                    raise ValueError(f"static XOR must select exactly one branch, got {len(selected)}")
                return evaluate_node(selected[0].get("flow", {}), variants)
            if kind == "repeat":
                count = float(node.get("count", node.get("expectedCount")))
                if "count" in node:
                    if count > 10_000:
                        raise ValueError("placement latency exact repeat count exceeds 10000")
                    current = variants
                    for _ in range(int(count)):
                        current = evaluate_node(node.get("body", {}), current)
                    return bounded(current)
                scaled: list[Variant] = []
                for base_probability, base_frontier in variants:
                    baseline = max((source[2] for source in base_frontier), default=0.0)
                    once = evaluate_node(
                        node.get("body", {}), [(1.0, list(base_frontier))]
                    )
                    for probability, frontier in once:
                        scaled.append((base_probability * probability, [
                            (
                                source[0],
                                source[1],
                                baseline + (source[2] - baseline) * count,
                            )
                            for source in frontier
                        ]))
                return bounded(scaled)
            raise ValueError(f"unknown workflow kind in placement latency: {kind!r}")

        variants = evaluate_node(
            self.document["spec"]["application"]["workflow"], [(1.0, initial)]
        )
        total_probability = sum(probability for probability, _ in variants)
        if not math.isclose(total_probability, 1.0, rel_tol=0.0, abs_tol=1e-12):
            raise ValueError(f"placement latency routing probability is {total_probability}, expected 1")
        value = sum(
            probability * max((source[2] for source in frontier), default=0.0)
            for probability, frontier in variants
        )
        if not math.isfinite(value) or value < 0:
            raise ValueError("placement global latency is not finite and non-negative")
        return value

    def _placement_metric_overrides(
        self, binding: Mapping[str, dict[str, str]]
    ) -> dict[str, float]:
        overrides: dict[str, float] = {}
        for model in self.document["spec"].get("placement", []):
            if "globalLatency" not in model:
                continue
            metric_id = model["globalLatency"]["metric"]["id"]
            if metric_id in overrides:
                raise ValueError(f"more than one placement derives metric {metric_id!r}")
            overrides[metric_id] = self._global_latency(model, binding)
        return overrides

    def _placement_violations(
        self, binding: Mapping[str, dict[str, str]]
    ) -> list[dict[str, Any]]:
        violations: list[dict[str, Any]] = []
        invocation_counts = self._task_invocations(
            self.document["spec"]["application"]["workflow"], binding
        )
        for model in self.document["spec"].get("placement", []):
            assignment_by_candidate = {
                _ref_key(demand["candidate"]): demand for demand in model.get("demands", [])
            }
            pool_by_key = {
                _ref_key(pool["ref"]): pool for pool in model.get("pools", {}).values()
            }
            for rule in model.get("capacityRules", []):
                usage: dict[tuple[str, str], dict[str, float]] = {}
                if rule["scope"] == "selectedCandidate":
                    selected = {
                        _ref_key(reference): reference for reference in binding.values()
                    }
                    charges = [(reference, 1.0) for reference in selected.values()]
                else:
                    charges = [
                        (binding[task_id], invocation_counts.get(task_id, 0.0))
                        for task_id in binding
                    ]
                for candidate, multiplier in charges:
                    demand = assignment_by_candidate.get(_ref_key(candidate))
                    if demand is None:
                        continue
                    pool_usage = usage.setdefault(_ref_key(demand["pool"]), {})
                    for resource in rule["resources"]:
                        amount = float(demand.get("resources", {}).get(resource, 0.0)) * multiplier
                        pool_usage[resource] = pool_usage.get(resource, 0.0) + amount
                for pool_key, pool_usage in usage.items():
                    pool = pool_by_key[pool_key]
                    for resource in rule["resources"]:
                        used = pool_usage.get(resource, 0.0)
                        capacity = float(pool.get("capacity", {}).get(resource, 0.0))
                        if used > capacity:
                            violations.append({
                                "constraint": rule["ref"],
                                "enforcement": "hard",
                                "penalty": 0.0,
                                "message": (
                                    f"pool {pool['ref']!r} uses {used} {resource}, "
                                    f"above capacity {capacity}"
                                ),
                            })
            def endpoint_pool(
                reference: Mapping[str, Any],
                placement_model: Mapping[str, Any] = model,
            ) -> tuple[str, dict[str, str]]:
                if reference["resource"] == placement_model["resource"]:
                    event = placement_model.get("events", {}).get(reference["id"])
                    if not isinstance(event, Mapping):
                        raise ValueError(f"unknown placement event {reference!r}")
                    return "event", event["pool"]
                task_id = reference["id"]
                if task_id not in binding:
                    raise ValueError(
                        f"placement transition endpoint {reference!r} is not a service task"
                    )
                assigned_model, demand = self._placement_assignment(binding[task_id])
                if assigned_model["resource"] != placement_model["resource"]:
                    raise ValueError(
                        f"transition endpoint {reference!r} is assigned to another placement resource"
                    )
                return "task", demand["pool"]

            for transition in model.get("transitions", []):
                from_kind, from_pool = endpoint_pool(transition["from"])
                _, to_pool = endpoint_pool(transition["to"])
                if from_kind == "event":
                    current = self._event_latency(model, transition["from"]["id"], to_pool)
                else:
                    current = self._network_latency(model, from_pool, to_pool)
                if current > float(transition["maximum"]):
                    penalty = float(transition.get("penalty", 0.0)) if transition["enforcement"] == "soft" else 0.0
                    violations.append({
                        "constraint": transition["ref"],
                        "enforcement": transition["enforcement"],
                        "penalty": penalty,
                        "message": (
                            f"transition latency {current} exceeds maximum {transition['maximum']}"
                        ),
                    })
        return violations

    def evaluate_binding(self, binding: Mapping[str, Any]) -> dict[str, float]:
        normalized = self.validate_binding(binding)
        spec = self.document["spec"]
        application = spec["application"]
        routing = {entry["target"]["id"]: float(entry["probability"]) for entry in spec["routing"]}
        context = self._task_context(normalized)

        def invocation(metric_id: str, metric: Mapping[str, Any], node: Mapping[str, Any]) -> float:
            kind = node.get("kind")
            if kind == "task":
                task_id = node.get("task", {}).get("id")
                task = application["tasks"].get(task_id, {})
                if task.get("kind") == "local":
                    return float(metric["neutral"])
                values = _resolved_candidate_metrics(spec["candidates"], normalized[task_id])
                return float(values[metric_id])
            if kind == "empty":
                return float(metric["neutral"])
            if kind in {"sequence", "parallel"}:
                children = node.get("steps", node.get("branches", []))
                values = [invocation(metric_id, metric, child) for child in children]
                return self._apply_operator(metric["aggregation"][kind], values)
            if kind == "repeat":
                value = invocation(metric_id, metric, node.get("body", {}))
                count = float(node.get("count", node.get("expectedCount")))
                return self._apply_operator(metric["aggregation"]["repeat"], [value], count=count)
            if kind == "exclusive":
                branches = node.get("branches", [])
                branch_ids = [branch["id"] for branch in branches]
                if all(branch_id in routing for branch_id in branch_ids):
                    operator_name = metric["aggregation"]["exclusive"]
                    values = [invocation(metric_id, metric, branch["flow"]) for branch in branches]
                    return self._apply_operator(operator_name, values, weights=[routing[branch_id] for branch_id in branch_ids])
                selected: list[dict[str, Any]] = []
                for branch in branches:
                    condition = branch.get("when")
                    if condition is not None and bool(Expression(condition, "bool").evaluate(context)):
                        selected.append(branch)
                if len(selected) != 1:
                    raise ValueError(f"static XOR must select exactly one branch, got {len(selected)}")
                return invocation(metric_id, metric, selected[0]["flow"])
            raise ValueError(f"unknown workflow kind: {kind}")

        result: dict[str, float] = {}
        for metric_id in application.get("requiredMetrics", []):
            metric = application["metrics"][metric_id]
            if metric["scope"] == "selectedCandidate":
                unique: dict[tuple[str, str], dict[str, str]] = {_ref_key(reference): reference for reference in normalized.values()}
                values = [float(_resolved_candidate_metrics(spec["candidates"], reference)[metric_id]) for reference in unique.values()]
                value = self._apply_operator(metric["aggregation"]["selection"], values)
            else:
                value = invocation(metric_id, metric, application["workflow"])
            if not math.isfinite(float(value)):
                raise ValueError(f"metric {metric_id!r} evaluated to a non-finite number")
            result[metric_id] = float(value)
        result.update(self._placement_metric_overrides(normalized))
        return result

    def evaluate_constraints(self, binding: Mapping[str, Any], metrics: Mapping[str, float] | None = None) -> list[dict[str, Any]]:
        normalized = self.validate_binding(binding)
        metric_values = dict(metrics or self.evaluate_binding(normalized))
        context = {**self._task_context(normalized), "metrics": metric_values}
        violations: list[dict[str, Any]] = []
        for constraint in self.document["spec"].get("constraints", []):
            when = Expression(constraint["when"], "bool").evaluate(context)
            if not isinstance(when, bool):
                raise ValueError(f"constraint {constraint['ref']!r} when-clause did not evaluate to boolean")
            if not when:
                continue
            assertion = Expression(constraint["assert"], "bool").evaluate(context)
            if not isinstance(assertion, bool):
                raise ValueError(f"constraint {constraint['ref']!r} assertion did not evaluate to boolean")
            if not assertion:
                penalty = 0.0
                if constraint["enforcement"] == "soft":
                    penalty_value = Expression(constraint["penalty"], "number").evaluate(context)
                    if not isinstance(penalty_value, (int, float)) or isinstance(penalty_value, bool) or not math.isfinite(float(penalty_value)) or penalty_value < 0:
                        raise ValueError(f"constraint {constraint['ref']!r} produced an invalid penalty")
                    penalty = float(penalty_value)
                violations.append({"constraint": constraint["ref"], "enforcement": constraint["enforcement"], "penalty": penalty})
        violations.extend(self._placement_violations(normalized))
        return violations

    def evaluate_objectives(self, metrics: Mapping[str, float], violations: list[dict[str, Any]]) -> dict[str, Any]:
        optimization = self.document["spec"]["optimization"]
        components: list[dict[str, Any]] = []
        for term in optimization["terms"]:
            value = float(metrics[term["metric"]["id"]])
            normalized = value
            if "normalize" in term:
                bounds = term["normalize"]
                normalized = (value - bounds["min"]) / (bounds["max"] - bounds["min"])
                if bounds["clamp"]:
                    normalized = min(1.0, max(0.0, normalized))
                loss = normalized if term["direction"] == "minimize" else 1.0 - normalized
            else:
                loss = value if term["direction"] == "minimize" else -value
            components.append({"metric": term["metric"], "value": value, "loss": loss, "weight": term["weight"]})
        penalty_weights = {_ref_key(item["constraint"]): item["weight"] for item in optimization["penalties"]}
        penalty = sum(float(item["penalty"]) * penalty_weights.get(_ref_key(item["constraint"]), 0.0) for item in violations if item["enforcement"] == "soft")
        mode = optimization["mode"]
        if mode == "weighted":
            score: Any = sum(item["loss"] * item["weight"] for item in components) + penalty
        elif mode in {"lexicographic", "pareto"}:
            # A declared soft constraint must never be inert.  For ordered and
            # Pareto objectives, the aggregate penalty is an explicit final
            # dimension (a lexicographic tiebreaker in the former case).
            score = [item["loss"] for item in components] + [penalty]
        else:
            # `satisfy` ranks feasible bindings by declared soft penalties and
            # is constant when no soft constraints exist.
            score = penalty
        return {"mode": mode, "components": components, "penalty": penalty, "score": score}

    def evaluate(self, binding: Mapping[str, Any]) -> dict[str, Any]:
        metrics = self.evaluate_binding(binding)
        violations = self.evaluate_constraints(binding, metrics)
        return {"metrics": metrics, "violations": violations, "objectives": self.evaluate_objectives(metrics, violations)}


def _compile_qos_binding(
    resolved: ResolvedInstance,
) -> BindingProblem:
    package = resolved.package
    profile_manifest = resolved.profile
    indexed = resolved.resources
    by_type = resolved.resources_by_type
    instance = resolved.instance
    inline_dialects = resolved.inline_dialects
    diagnostics: list[CompileDiagnostic] = []
    source_map: dict[str, Any] = {
        "/": {"resource": "instance", "path": "instance.json", "pointer": "/"},
    }
    for role, group in instance.get("spec", {}).get("resources", {}).items():
        for resource_id in group if isinstance(group, dict) else []:
            source_map[f"/spec/instance/resources/{resource_id}"] = {
                "resource": "instance",
                "path": "instance.json",
                "pointer": f"/spec/resources/{role}/{resource_id}",
            }
    application_resource = by_type[(QOS_API_VERSION, "Application")][0]
    tasks = _normalize_tasks(application_resource, diagnostics, source_map)
    metrics = _normalize_metrics(application_resource, diagnostics, source_map)
    candidates, eligibility = _normalize_candidates(
        by_type[(QOS_API_VERSION, "CandidateCatalog")],
        tasks,
        application_resource,
        metrics,
        diagnostics,
        source_map,
    )
    installed_dialects = {
        _dialect_id(manifest): manifest for manifest in installed_dialect_manifests()
    }
    extensions: dict[str, Any] = {}
    _lower_inline_extensions(
        instance,
        resource_id="instance",
        resource_path="instance.json",
        target_api_version=BIM_API_VERSION,
        target_kind="Instance",
        pointer="",
        profile=profile_manifest,
        dialects=installed_dialects,
        diagnostics=diagnostics,
        source_map=source_map,
        out=extensions,
    )
    for resource in indexed.values():
        if resource.kind != "BPMN":
            _lower_inline_extensions(
                resource.document,
                resource_id=resource.id,
                resource_path=resource.path,
                target_api_version=resource.api_version,
                target_kind=resource.kind,
                pointer="",
                profile=profile_manifest,
                dialects=installed_dialects,
                diagnostics=diagnostics,
                source_map=source_map,
                out=extensions,
            )
    lowered_extensions = _lower_installed_dialect_resources(
        indexed,
        installed_dialects,
        profile_manifest,
        diagnostics,
        source_map,
    )
    for dialect_id, payload in lowered_extensions.items():
        bucket = extensions.setdefault(dialect_id, {})
        for section, value in payload.items():
            if section in bucket:
                diagnostics.append(_diag(
                    "dialect_lowering_collision",
                    f"lowered Dialect output collides with extension section {dialect_id!r}/{section!r}",
                    "instance.json",
                    "/spec/extensions",
                ))
            else:
                bucket[section] = value
    roots, paths = _condition_environment(
        tasks,
        metrics,
        candidates,
        eligibility,
        extensions,
    )
    routing_roots = {root: value for root, value in roots.items() if root != "metrics"}
    routing_paths = {path: value for path, value in paths.items() if path[0] != "metrics"}
    workflow_source = application_resource.document.get("spec", {}).get("workflow")
    workflow = _compile_workflow(workflow_source, application_resource, tasks, routing_roots, routing_paths, diagnostics, source_map)
    source_workflow_owner = application_resource.id
    if workflow and workflow.get("kind") == "bpmnRef":
        reference = workflow["workflow"]
        target = indexed.get(reference["resource"])
        if target is None or target.kind != "BPMN":
            diagnostics.append(_diag("bpmn_ref", "bpmn must reference a workflow resource", application_resource.path, "/spec/workflow/bpmn"))
            workflow = None
        else:
            source_workflow_owner = target.id
            workflow = _bpmn_workflow(target, reference.get("id"), application_resource, tasks, routing_roots, routing_paths, diagnostics, source_map)
    if workflow is None:
        diagnostics.append(_diag("workflow", "Application has no executable workflow", application_resource.path, "/spec/workflow"))
    routing = _routing(
        workflow or {"kind": "empty"},
        by_type[(QOS_API_VERSION, "RoutingOverlay")],
        source_workflow_owner,
        application_resource.id,
        diagnostics,
        source_map,
    )
    constraints = _constraints(
        by_type[(QOS_API_VERSION, "ConstraintSet")], roots, paths, diagnostics, source_map
    )
    placement = _placement(
        by_type[(PLACEMENT_DIALECT_ID, "Placement")],
        indexed,
        candidates,
        tasks,
        metrics,
        application_resource.id,
        diagnostics,
        source_map,
    )
    _validate_placement_contract(placement, workflow or {"kind": "empty"}, routing, eligibility, diagnostics)
    optimization = _optimization(
        by_type[(QOS_API_VERSION, "Optimization")][0],
        application_resource.id,
        metrics,
        constraints + _placement_constraints(placement),
        diagnostics,
        source_map,
    )
    required_global, required_local = _required_metrics(optimization, constraints, placement)
    _validate_xor_aggregation(
        workflow or {"kind": "empty"},
        routing,
        application_resource.id,
        metrics,
        required_global,
        diagnostics,
    )
    _validate_fractional_products(
        workflow or {"kind": "empty"},
        routing,
        metrics,
        required_global,
        candidates,
        diagnostics,
    )
    for task_id, eligible in eligibility.items():
        required = required_global | required_local.get(task_id, set())
        for candidate_ref in eligible:
            candidate = _lookup_candidate(candidates, candidate_ref)
            available = set(_resolved_candidate_metrics(candidates, candidate_ref))
            missing = sorted(required - available) if candidate else sorted(required)
            if missing:
                diagnostics.append(_diag("missing_metric", f"eligible candidate {candidate_ref!r} is missing used metrics: {', '.join(missing)}", candidate_ref["resource"], f"/spec/candidates/{candidate_ref['id']}/metrics"))
    resource_digests = package.resource_digests
    identity = instance_digest(instance, resource_digests)
    resource_manifest = {
        resource_id: {
            "role": resource.role,
            "apiVersion": resource.api_version,
            "kind": resource.kind,
            **({"registered": resource.registered} if resource.registered else {"path": resource.path}),
            "digest": resource.digest,
        }
        for resource_id, resource in sorted(indexed.items())
    }
    profile = _profile_descriptor(profile_manifest)
    used_dialects = sorted(
        {resource.dialect_id for resource in indexed.values()} | inline_dialects
    )
    dialects = [
        _dialect_descriptor(installed_dialects[dialect_id])
        for dialect_id in used_dialects
    ]
    output = profile_manifest["spec"]["output"]
    document = {
        "apiVersion": output["apiVersion"],
        "kind": output["kind"],
        "metadata": {"name": instance["metadata"]["name"]},
        "spec": {
            "profile": profile,
            "dialects": dialects,
            "instance": {"digest": identity, "resources": resource_manifest},
            "application": {
                "resource": application_resource.id,
                "tasks": tasks,
                "metrics": metrics,
                "requiredMetrics": sorted(required_global),
                "taskRequiredMetrics": {task_id: sorted(values) for task_id, values in sorted(required_local.items())},
                "workflow": workflow,
            },
            "candidates": candidates,
            "eligibility": eligibility,
            "routing": routing,
            "constraints": constraints,
            "placement": placement,
            "optimization": optimization,
            "extensions": extensions,
            "sourceMap": source_map,
        },
    }
    if diagnostics:
        raise CompileError(diagnostics)
    ir_diagnostics = _schema_diagnostics(document, "BindingProblem", "BindingProblem")
    if ir_diagnostics:
        raise CompileError(ir_diagnostics)
    # Source representation and provenance are intentionally excluded: a JSON
    # workflow and an equivalent BPMN workflow must identify the same lowered
    # problem.  They remain attached to the document for diagnostics/audit and
    # are pinned separately by Instance, resource and dialect digests.
    semantic_document = json.loads(json.dumps(document))
    semantic_document.pop("metadata", None)
    for provenance_key in ("instance", "dialects", "sourceMap"):
        semantic_document["spec"].pop(provenance_key, None)
    return BindingProblem(document=document, digest=digest(semantic_document), source_map=source_map)


_BUILTIN_PROFILE_ADAPTER = installed_profile_manifests()[0]["spec"]["adapter"]
_PROFILE_ADAPTERS = {
    (
        _BUILTIN_PROFILE_ADAPTER["id"],
        _BUILTIN_PROFILE_ADAPTER["version"],
        _BUILTIN_PROFILE_ADAPTER["binaryDigest"],
    ): _compile_qos_binding,
}


def install_profile_contract(
    manifest: dict[str, Any],
    adapter: Any,
    *,
    output_schema: Mapping[str, Any] | None = None,
) -> None:
    """Install an immutable Profile manifest together with deployed lowering.

    Packages and published manifests cannot call this API.  It is the host
    integration point used by trusted deployment code, keeping executable code
    and installation URLs out of BIM documents while avoiding a hardcoded
    profile dispatcher.
    """

    validator = _schema_validator("Profile")
    errors = list(validator.iter_errors(manifest)) if validator is not None else []
    if validator is None or errors:
        message = errors[0].message if errors else "Profile schema is unavailable"
        raise ValueError(f"invalid installed Profile: {message}")
    metadata = manifest["metadata"]
    identity = (
        str(metadata["namespace"]),
        str(metadata["name"]),
        str(metadata["version"]),
        digest(manifest),
    )
    adapter_descriptor = manifest["spec"]["adapter"]
    adapter_key = (
        str(adapter_descriptor["id"]),
        str(adapter_descriptor["version"]),
        str(adapter_descriptor["binaryDigest"]),
    )
    if not callable(adapter):
        raise ValueError("Profile adapter must be callable")
    existing_ids = {manifest_id(item) for item in installed_profile_manifests()}
    if manifest_id(manifest) in existing_ids:
        raise ValueError(f"Profile id {manifest_id(manifest)!r} is already installed")
    if adapter_key in _PROFILE_ADAPTERS:
        raise ValueError("Profile adapter descriptor is already installed for another contract")
    if output_schema is None:
        raise ValueError("Profile output schema must be installed with the adapter")
    if digest(output_schema) != manifest["spec"]["output"]["schemaDigest"]:
        raise ValueError("installed Profile output schema does not match schemaDigest")
    jsonschema.Draft202012Validator.check_schema(dict(output_schema))
    _ADDITIONAL_INSTALLED_PROFILES[identity] = manifest
    _PROFILE_ADAPTERS[adapter_key] = adapter
    _PROFILE_OUTPUT_VALIDATORS[_profile_output_key(manifest)] = (
        jsonschema.Draft202012Validator(dict(output_schema))
    )
    installed_framework_diagnostics.cache_clear()


def uninstall_profile_contract(manifest: Mapping[str, Any]) -> None:
    """Remove one host-installed Profile contract (primarily tests)."""

    metadata = manifest["metadata"]
    removed = _ADDITIONAL_INSTALLED_PROFILES.pop((
        str(metadata["namespace"]),
        str(metadata["name"]),
        str(metadata["version"]),
        digest(manifest),
    ), None)
    if removed is None:
        return
    descriptor = manifest["spec"]["adapter"]
    _PROFILE_ADAPTERS.pop((
        str(descriptor["id"]),
        str(descriptor["version"]),
        str(descriptor["binaryDigest"]),
    ), None)
    _PROFILE_OUTPUT_VALIDATORS.pop(_profile_output_key(removed), None)
    installed_framework_diagnostics.cache_clear()


def install_dialect_contract(
    manifest: dict[str, Any],
    *,
    resource_schemas: Mapping[tuple[str, str, str], Mapping[str, Any]] | None = None,
    resource_lowerers: Mapping[tuple[str, str, str], Any] | None = None,
    extension_schemas: Mapping[tuple[str, str, str], Mapping[str, Any]] | None = None,
    extension_lowerers: Mapping[tuple[str, str, str], Any] | None = None,
) -> None:
    """Install a Dialect contract with exact validators and pure lowering.

    Keys in ``resource_schemas`` are ``(apiVersion, kind, mediaType)``. Keys in
    ``resource_lowerers`` use the same identities and map to deployed callables
    with signature ``(document, context) -> JSON object``. Keys in
    ``extension_schemas`` and ``extension_lowerers`` are
    ``(targetApiVersion, targetKind, pointer)``. XML dialects additionally
    require a deployed parser/lowering adapter and are not admitted by this
    generic JSON installation function. Packages never supply these callables:
    this is a trusted host installation boundary.
    """

    validator = _schema_validator("Dialect")
    errors = list(validator.iter_errors(manifest)) if validator is not None else []
    if validator is None or errors:
        message = errors[0].message if errors else "Dialect schema is unavailable"
        raise ValueError(f"invalid installed Dialect: {message}")
    resource_schemas = resource_schemas or {}
    resource_lowerers = resource_lowerers or {}
    extension_schemas = extension_schemas or {}
    extension_lowerers = extension_lowerers or {}
    for profile_id in manifest["spec"]["compatibleProfiles"]:
        if installed_profile(profile_id) is None:
            raise ValueError(f"Dialect names unavailable Profile {profile_id!r}")
    resource_identities: set[tuple[str, str, str]] = set()
    for resource_type in manifest["spec"]["resourceTypes"]:
        identity = (
            str(resource_type["apiVersion"]),
            str(resource_type["kind"]),
            str(resource_type["mediaType"]),
        )
        resource_identities.add(identity)
        if "xmlRoot" in resource_type:
            raise ValueError("XML Dialects require a dedicated installed parser adapter")
        schema = resource_schemas.get(identity)
        if schema is None or digest(schema) != resource_type["schemaDigest"]:
            raise ValueError(f"missing exact installed schema for Dialect resource type {identity!r}")
        jsonschema.Draft202012Validator.check_schema(dict(schema))
        if not callable(resource_lowerers.get(identity)):
            raise ValueError(f"missing deployed lowering for Dialect resource type {identity!r}")
    if set(resource_schemas) != resource_identities:
        raise ValueError("resource_schemas must exactly match the Dialect resourceTypes")
    if set(resource_lowerers) != resource_identities:
        raise ValueError("resource_lowerers must exactly match the Dialect resourceTypes")
    dialect_id = _dialect_id(manifest)
    if resource_identities and PROFILE_ID in manifest["spec"]["compatibleProfiles"]:
        advertised = {
            (feature["dimension"], feature["value"])
            for feature in manifest["spec"]["irFeatures"]
        }
        if ("irExtensions", dialect_id) not in advertised:
            raise ValueError(
                f"Dialect resource lowering for {PROFILE_ID!r} must advertise "
                f"irExtensions={dialect_id!r}"
            )
    points = manifest["spec"]["extensionPoints"]
    point_identities: set[tuple[str, str, str]] = set()
    for point in points:
        target = point["target"]
        identity = (str(target["apiVersion"]), str(target["kind"]), str(point["pointer"]))
        point_identities.add(identity)
        schema = extension_schemas.get(identity)
        if schema is None or digest(schema) != point["schemaDigest"]:
            raise ValueError(f"missing exact installed schema for extension point {identity!r}")
        jsonschema.Draft202012Validator.check_schema(dict(schema))
        if not callable(extension_lowerers.get(identity)):
            raise ValueError(f"missing deployed lowering for extension point {identity!r}")
    if set(extension_schemas) != point_identities:
        raise ValueError("extension_schemas must exactly match the Dialect extensionPoints")
    if set(extension_lowerers) != point_identities:
        raise ValueError("extension_lowerers must exactly match the Dialect extensionPoints")
    metadata = manifest["metadata"]
    key = (
        str(metadata["namespace"]),
        str(metadata["name"]),
        str(metadata["version"]),
        digest(manifest),
    )
    if manifest_id(manifest) in {manifest_id(item) for item in installed_dialect_manifests()}:
        raise ValueError(f"Dialect id {manifest_id(manifest)!r} is already installed")
    _ADDITIONAL_INSTALLED_DIALECTS[key] = manifest
    for identity, schema in resource_schemas.items():
        _ADDITIONAL_RESOURCE_SCHEMA_VALIDATORS[identity] = jsonschema.Draft202012Validator(dict(schema))
        _DIALECT_RESOURCE_LOWERERS[
            _dialect_resource_lowerer_key(manifest, *identity)
        ] = resource_lowerers[identity]
    for point in points:
        target = point["target"]
        identity = (str(target["apiVersion"]), str(target["kind"]), str(point["pointer"]))
        install_extension_validator(manifest, *identity, extension_schemas[identity])
        _DIALECT_EXTENSION_LOWERERS[
            _dialect_extension_lowerer_key(manifest, *identity)
        ] = extension_lowerers[identity]
    _resource_schema_validator.cache_clear()
    installed_framework_diagnostics.cache_clear()


def uninstall_dialect_contract(manifest: Mapping[str, Any]) -> None:
    """Remove one host-installed Dialect contract (primarily tests)."""

    metadata = manifest["metadata"]
    removed = _ADDITIONAL_INSTALLED_DIALECTS.pop((
        str(metadata["namespace"]),
        str(metadata["name"]),
        str(metadata["version"]),
        digest(manifest),
    ), None)
    if removed is None:
        return
    dialect_id = manifest_id(manifest)
    for resource_type in manifest["spec"]["resourceTypes"]:
        identity = (
            str(resource_type["apiVersion"]),
            str(resource_type["kind"]),
            str(resource_type["mediaType"]),
        )
        _ADDITIONAL_RESOURCE_SCHEMA_VALIDATORS.pop(identity, None)
        _DIALECT_RESOURCE_LOWERERS.pop(
            _dialect_resource_lowerer_key(manifest, *identity),
            None,
        )
    for point in manifest["spec"]["extensionPoints"]:
        target = point["target"]
        identity = (
            str(target["apiVersion"]),
            str(target["kind"]),
            str(point["pointer"]),
        )
        uninstall_extension_validator(
            dialect_id,
            *identity,
            str(point["schemaDigest"]),
        )
        _DIALECT_EXTENSION_LOWERERS.pop(
            _dialect_extension_lowerer_key(manifest, *identity),
            None,
        )
    _resource_schema_validator.cache_clear()
    installed_framework_diagnostics.cache_clear()


def _validated_profile_output(
    value: Any,
    profile: Mapping[str, Any],
) -> CompiledProblem:
    output = profile["spec"]["output"]
    if not isinstance(value, CompiledProblem):
        raise CompileError([_diag(
            "profile_output_type",
            "Profile adapter must return CompiledProblem",
            "instance.json",
            "/spec/profile",
        )])
    diagnostics: list[CompileDiagnostic] = []
    document = value.document
    if not isinstance(document, dict):
        diagnostics.append(_diag(
            "profile_output",
            "Profile adapter output document must be a JSON object",
            "Profile output",
            "/",
            ir_path="/",
        ))
    else:
        if document.get("apiVersion") != output["apiVersion"]:
            diagnostics.append(_diag(
                "profile_output_identity",
                f"Profile output apiVersion must be {output['apiVersion']!r}",
                "Profile output",
                "/apiVersion",
                ir_path="/apiVersion",
            ))
        if document.get("kind") != output["kind"]:
            diagnostics.append(_diag(
                "profile_output_identity",
                f"Profile output kind must be {output['kind']!r}",
                "Profile output",
                "/kind",
                ir_path="/kind",
            ))
        validator = _profile_output_validator(profile)
        if validator is None:
            diagnostics.append(_diag(
                "profile_output_schema_unavailable",
                "Profile output schema is not installed at its pinned digest",
                "instance.json",
                "/spec/profile",
            ))
        else:
            for error in validator.iter_errors(document):
                pointer = "/" + "/".join(
                    _json_pointer_segment(str(part)) for part in error.absolute_path
                )
                diagnostics.append(_diag(
                    "profile_output_schema",
                    error.message,
                    "Profile output",
                    pointer,
                    ir_path=pointer,
                ))
        try:
            canonical_json(document)
        except ValueError as exc:
            diagnostics.append(_diag(
                "profile_output_canonical",
                str(exc),
                "Profile output",
                "/",
                ir_path="/",
            ))
    if not isinstance(value.source_map, dict):
        diagnostics.append(_diag(
            "profile_source_map",
            "Profile adapter source_map must be an object",
            "Profile output",
            "/",
        ))
    else:
        try:
            canonical_json(value.source_map)
        except ValueError as exc:
            diagnostics.append(_diag(
                "profile_source_map",
                str(exc),
                "Profile output",
                "/",
            ))
    if not isinstance(value.digest, str) or re.fullmatch(r"sha256-[0-9a-f]{64}", value.digest) is None:
        diagnostics.append(_diag(
            "profile_output_digest",
            "Profile adapter digest must be a canonical sha256 digest",
            "Profile output",
            "/",
        ))
    if diagnostics:
        raise CompileError(diagnostics)
    return value


def compile_instance(
    package: InstancePackage,
    registered_resources: Mapping[tuple[str, str, str, str], RegisteredResource] | None = None,
) -> CompiledProblem:
    """Resolve the BIM container profile and dispatch to its installed adapter."""

    framework_errors = installed_framework_diagnostics()
    if framework_errors:
        raise CompileError([
            _diag("installed_framework", message, "instance.json", "/spec/profile")
            for message in framework_errors
        ])

    try:
        instance = package.json("instance.json")
    except PackageError as exc:
        raise CompileError([_diag("instance", str(exc), "instance.json")]) from exc
    diagnostics = [
        *_envelope(instance, "Instance", "instance.json"),
        *_schema_diagnostics(instance, "Instance", "instance.json"),
    ]
    profile_id = instance.get("spec", {}).get("profile") if isinstance(instance, Mapping) else None
    profile = installed_profile(profile_id) if isinstance(profile_id, str) else None
    if profile is None:
        diagnostics.append(_diag(
            "unsupported_profile",
            f"profile {profile_id!r} has no installed, digest-pinned adapter",
            "instance.json",
            "/spec/profile",
        ))
    if diagnostics:
        raise CompileError(diagnostics)
    adapter = profile["spec"]["adapter"]
    adapter_fn = _PROFILE_ADAPTERS.get((
        str(adapter.get("id")),
        str(adapter.get("version")),
        str(adapter.get("binaryDigest")),
    ))
    if adapter_fn is None:
        raise CompileError([_diag(
            "profile_adapter_not_installed",
            f"profile {profile_id!r} does not match an installed adapter ABI",
            "instance.json",
            "/spec/profile",
        )])
    if _profile_output_validator(profile) is None:
        raise CompileError([_diag(
            "profile_output_schema_unavailable",
            f"profile {profile_id!r} has no installed output schema at its pinned digest",
            "instance.json",
            "/spec/profile",
        )])
    resolved = _resolve_instance(package, profile, registered_resources)

    def invoke() -> CompiledProblem:
        try:
            result = adapter_fn(deepcopy(resolved))
        except CompileError:
            raise
        except Exception as exc:
            raise CompileError([_diag(
                "profile_lowering",
                f"Profile {profile_id!r} could not lower the resolved Instance: {exc}",
                "instance.json",
                "/spec/profile",
            )]) from exc
        return _validated_profile_output(result, profile)

    first = invoke()
    # Bundled Profile reproducibility is covered by its corpus/round-trip
    # conformance suite; recompiling every production instance twice would
    # double the cost of the complete QoS lowering. Dynamically installed
    # deterministic adapters are untrusted integration points and are checked
    # on every invocation until they have an equivalent deployment gate.
    if (
        profile["spec"].get("deterministic")
        and _profile_output_key(profile) in _PROFILE_OUTPUT_VALIDATORS
    ):
        second = invoke()
        if (
            canonical_json(first.document) != canonical_json(second.document)
            or canonical_json(first.source_map) != canonical_json(second.source_map)
            or first.digest != second.digest
        ):
            raise CompileError([_diag(
                "profile_lowering_nondeterministic",
                f"Profile {profile_id!r} produced different canonical outputs for the same resolved Instance",
                "instance.json",
                "/spec/profile",
            )])
    return first
