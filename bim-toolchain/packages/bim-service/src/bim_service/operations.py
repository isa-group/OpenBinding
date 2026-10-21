"""The operations of the service: plain functions from decoded inputs to JSON-ready results.

Each one is a thin composition of ``bim_core`` functions; they hold no state and know nothing about HTTP.
They run in the worker threads of :class:`bim_service.runtime.Gate` (the descriptors at the end are cheap and
cached, and run in the event loop).  ``bim_client.InProcessBim`` composes the same ``bim_core`` functions the
same way; ``packages/bim-client/tests/test_equivalence.py`` is what keeps the two in step.
"""

from __future__ import annotations

import json
from dataclasses import asdict
from functools import lru_cache
from typing import Any, Mapping, Sequence

from bim_core import (
    BindingProblem,
    CompileError,
    ContractError,
    EvaluationError,
    InstancePackage,
    Limits,
    ProtocolError,
    analyze_neighborhood,
    compilation_digest,
    compile_instance,
    compiler_bundle_digest,
    dialect_descriptor,
    digest,
    digest_bytes,
    engine_contract_diagnostics,
    evaluate_many,
    load_package,
    profile_descriptor,
    protocol_digest,
    protocol_document,
    reevaluate_result,
    resolve_optimization,
    resource_schema_diagnostics,
    toolchain_identity,
    validate_result,
)
from bim_core import __version__ as core_version
from bim_core.assets import read_schema
from bim_core.compat import (
    SCHEMA_FILES,
    candidate_count,
    mode_compatibility,
    mode_execution_contract,
    resolve_engine_mode,
)
from bim_core.compiler import (
    BIM_API_VERSION,
    RegisteredResource,
    installed_dialect_manifests,
    installed_profile_manifests,
    manifest_reference,
)
from bim_core.protocol import PROTOCOL_ID

from ._version import API_VERSION
from ._version import __version__ as service_version
from .settings import BimServiceSettings
from .wire import RegisteredSpec

SCHEMA_KINDS = {**SCHEMA_FILES, "BindingProblem": "binding-problem.schema.json"}


# --- compile and validate --------------------------------------------------------------------------


def toolchain_block() -> dict[str, str]:
    return {
        "name": "bim-core",
        "version": core_version,
        "apiVersion": BIM_API_VERSION,
        "compilerDigest": compiler_bundle_digest(),
    }


def input_digest(package_digest: str, registered: Sequence[RegisteredSpec]) -> str:
    """Identity of everything a compilation reads: the portable package and the registered resources."""
    return digest({
        "packageDigest": package_digest,
        "registeredResources": sorted(
            (
                {
                    "namespace": item.namespace,
                    "name": item.name,
                    "version": item.version,
                    "digest": item.digest,
                    "mediaType": item.media_type,
                    "contentDigest": digest_bytes(item.content),
                    "versionManifestDigest": None if item.version_manifest is None else digest(item.version_manifest),
                }
                for item in registered
            ),
            key=lambda entry: (entry["namespace"], entry["name"], entry["version"], entry["digest"]),
        ),
    })


def _registry(registered: Sequence[RegisteredSpec]) -> dict[tuple[str, str, str, str], RegisteredResource] | None:
    return {
        item.key: RegisteredResource(
            content=item.content, media_type=item.media_type, version_manifest=item.version_manifest
        )
        for item in registered
    } or None


def _analysis(problem: Any) -> dict[str, Any] | None:
    if not isinstance(problem, BindingProblem):
        return None
    breakdown = problem.binding_space_breakdown
    return {
        "bindingSpaceLog10": problem.binding_space_log10,
        "bindingSpaceCardinality": problem.binding_space_cardinality_decimal,
        "bindingSpaceBreakdown": breakdown,
        "serviceTasks": len(breakdown),
        "candidates": candidate_count(problem.document["spec"]),
    }


def _compiled(package_digest: str, problem: Any, inputs: str) -> dict[str, Any]:
    document = problem.document
    return {
        "irDigest": problem.digest,
        "instanceDigest": document.get("spec", {}).get("instance", {}).get("digest"),
        "packageDigest": package_digest,
        "compilationDigest": compilation_digest(package_digest, problem),
        "inputDigest": inputs,
        "sourceMap": problem.source_map,
        "analysis": _analysis(problem),
        "toolchain": toolchain_block(),
    }


def compile_package(data: bytes, registered: Sequence[RegisteredSpec], limits: Limits) -> dict[str, Any]:
    package = load_package(data, limits=limits)
    problem = compile_instance(package, _registry(registered))
    package_digest = package.package_digest
    return {"ir": problem.document, **_compiled(package_digest, problem, input_digest(package_digest, registered))}


def validate_package(data: bytes, registered: Sequence[RegisteredSpec], limits: Limits) -> dict[str, Any]:
    package = load_package(data, limits=limits)
    package_digest = package.package_digest
    inputs = input_digest(package_digest, registered)
    try:
        problem = compile_instance(package, _registry(registered))
    except CompileError as exc:
        return {
            "valid": False,
            "diagnostics": [item.as_dict() for item in exc.diagnostics],
            "packageDigest": package_digest,
            "inputDigest": inputs,
            "toolchain": toolchain_block(),
        }
    return {"valid": True, "diagnostics": [], **_compiled(package_digest, problem, inputs)}


# --- engine compatibility and optimization ---------------------------------------------------------


def compatibility(
    ir: Mapping[str, Any], manifest: Mapping[str, Any], mode: str | None, options: Mapping[str, Any] | None
) -> dict[str, Any]:
    problem = BindingProblem.from_document(ir)
    _, selected, effective = resolve_engine_mode(manifest, mode, dict(options) if options is not None else {})
    diagnostics = mode_compatibility(problem, selected)
    return {
        "compatible": not diagnostics,
        "diagnostics": diagnostics,
        "mode": mode_execution_contract(selected),
        "options": effective,
    }


def optimization(
    ir: Mapping[str, Any], manifest: Mapping[str, Any], mode: str | None, requested: Any
) -> dict[str, Any]:
    problem = BindingProblem.from_document(ir)
    _, selected, _ = resolve_engine_mode(manifest, mode, {})
    return {
        "optimization": resolve_optimization(problem, selected, requested),
        "mode": mode_execution_contract(selected),
    }


# --- evaluation ------------------------------------------------------------------------------------


def evaluate(
    ir: Mapping[str, Any], bindings: Sequence[Any], execution: Mapping[str, Any] | None, on_error: str
) -> dict[str, Any]:
    problem = BindingProblem.from_document(ir)
    results = evaluate_many(problem, bindings, execution, on_error=on_error)  # type: ignore[arg-type]
    return {
        "results": [
            {"error": item.as_dict()} if isinstance(item, EvaluationError) else {"evaluation": item}
            for item in results
        ]
    }


def reevaluate(
    ir: Mapping[str, Any],
    result: dict[str, Any],
    execution: Mapping[str, Any] | None,
    allowed_terminations: Sequence[Any] | None,
) -> dict[str, Any]:
    problem = BindingProblem.from_document(ir)
    if allowed_terminations is None:
        return reevaluate_result(problem, result, execution)
    return reevaluate_result(problem, result, execution, list(allowed_terminations))


def check_result(payload: Any) -> dict[str, Any]:
    try:
        validate_result(payload, finite=True)
    except ProtocolError as exc:
        return {"valid": False, "error": {"code": exc.code, "message": exc.message}}
    return {"valid": True, "error": None}


def neighborhood(
    ir: Mapping[str, Any],
    binding: Any,
    task: str | None,
    limit: int,
    seconds: float,
    execution: Mapping[str, Any] | None,
) -> dict[str, Any]:
    problem = BindingProblem.from_document(ir)
    return analyze_neighborhood(
        problem,
        binding,
        task=task,
        limit=limit,
        seconds=seconds,
        execution=dict(execution) if execution is not None else None,
    )


# --- single documents ------------------------------------------------------------------------------


def validate_resource(
    document: Mapping[str, Any],
    api_version: Any,
    kind: Any,
    media_type: Any,
    resource: str,
    dialects: Sequence[Mapping[str, Any]] | None,
) -> dict[str, Any]:
    found = resource_schema_diagnostics(
        dict(document), api_version, kind, media_type, resource, None if dialects is None else list(dialects)
    )
    return {"diagnostics": [item.as_dict() for item in found]}


def validate_engine(document: Mapping[str, Any]) -> dict[str, Any]:
    # ``engine_contract_diagnostics`` raises on a ``spec`` that is not an object; that is a finding, not a failure.
    if "spec" in document and not isinstance(document["spec"], Mapping):
        return {"diagnostics": [_engine_contract_invalid("engine document 'spec' must be an object")]}
    try:
        return {"diagnostics": engine_contract_diagnostics(document)}
    except (AttributeError, KeyError, TypeError):
        return {"diagnostics": [_engine_contract_invalid("engine document does not have the shape of an engine contract")]}


def _engine_contract_invalid(message: str) -> dict[str, str]:
    return {"code": "engine_contract_invalid", "message": message, "pointer": "/spec"}


def _xml_resource(content: bytes, limits: Limits) -> InstancePackage:
    # The package limits bound the resource as they bound an entry of a package.
    return InstancePackage({"instance.json": b"{}", "resource.xml": content}, limits=limits)


def xml_resource_root(content: bytes, limits: Limits) -> dict[str, str]:
    tag = _xml_resource(content, limits).xml_root("resource.xml").tag
    if isinstance(tag, str) and tag.startswith("{") and "}" in tag:
        namespace, local_name = tag[1:].split("}", 1)
    else:
        namespace, local_name = "", str(tag)
    return {"namespace": namespace, "localName": local_name}


def validate_bpmn_resource(content: bytes, limits: Limits) -> dict[str, bool]:
    _xml_resource(content, limits).xml("resource.xml")
    return {"valid": True}


# --- descriptors (cheap, cached: the installed toolchain does not change while the process lives) -----


@lru_cache(maxsize=1)
def _static_capabilities() -> dict[str, Any]:
    digest_value = protocol_digest()
    return {
        "apiVersion": API_VERSION,
        "toolchain": toolchain_identity(),
        "compilerDigest": compiler_bundle_digest(),
        "protocol": {"id": PROTOCOL_ID, "digest": digest_value},
        "protocolDigest": digest_value,
        "profiles": [profile_descriptor(item) for item in installed_profile_manifests()],
        "dialects": [dialect_descriptor(item) for item in installed_dialect_manifests()],
        "schemaKinds": sorted(SCHEMA_KINDS),
    }


def capabilities(settings: BimServiceSettings) -> dict[str, Any]:
    return {
        **_static_capabilities(),
        "service": {"name": "bim-service", "version": service_version},
        "limits": {"package": asdict(settings.limits), "service": settings.public_limits()},
    }


@lru_cache(maxsize=1)
def profiles() -> dict[str, Any]:
    return {
        "profiles": [
            {"reference": manifest_reference(item), "descriptor": profile_descriptor(item), "manifest": item}
            for item in installed_profile_manifests()
        ]
    }


@lru_cache(maxsize=1)
def dialects() -> dict[str, Any]:
    return {
        "dialects": [
            {"reference": manifest_reference(item), "descriptor": dialect_descriptor(item), "manifest": item}
            for item in installed_dialect_manifests()
        ]
    }


def schema(kind: str) -> dict[str, Any]:
    filename = SCHEMA_KINDS.get(kind)
    if filename is None:
        raise ContractError(
            "schema_not_found",
            f"there is no schema of kind {kind[:64]!r}; the kinds are {', '.join(sorted(SCHEMA_KINDS))}",
            http_status=404,
        )
    return json.loads(read_schema(filename))


@lru_cache(maxsize=1)
def protocol() -> dict[str, Any]:
    return {"id": PROTOCOL_ID, "digest": protocol_digest(), "document": protocol_document()}


def warm_up() -> None:
    """Compute what every request needs once, so a broken installation stops the start and not the first request."""
    _static_capabilities()
    profiles()
    dialects()
    protocol()
