"""``InProcessBim``: the BIM port implemented by calling ``bim_core`` in the current process.

This composes the ``bim_core`` functions exactly as ``bim_service.operations`` does (the service is this class
behind HTTP); ``tests/test_equivalence.py`` runs the same cases through both and compares the answers.
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
    default_limits,
    dialect_descriptor,
    digest,
    digest_bytes,
    engine_contract_diagnostics,
    evaluate,
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

from . import wire
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

SCHEMA_KINDS = {**SCHEMA_FILES, "BindingProblem": "binding-problem.schema.json"}


def _engine_contract_invalid(message: str) -> dict[str, str]:
    return {"code": "engine_contract_invalid", "message": message, "pointer": "/spec"}


def _input_digest(package_digest: str, registered: Sequence[wire.Registered]) -> str:
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


def _registry(registered: Sequence[wire.Registered]) -> dict[tuple[str, str, str, str], RegisteredResource] | None:
    return {
        item.key: RegisteredResource(
            content=item.content, media_type=item.media_type, version_manifest=item.version_manifest
        )
        for item in registered
    } or None


def _toolchain() -> dict[str, str]:
    return {
        "name": "bim-core",
        "version": core_version,
        "apiVersion": BIM_API_VERSION,
        "compilerDigest": compiler_bundle_digest(),
    }


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
    return {
        "irDigest": problem.digest,
        "instanceDigest": problem.document.get("spec", {}).get("instance", {}).get("digest"),
        "packageDigest": package_digest,
        "compilationDigest": compilation_digest(package_digest, problem),
        "inputDigest": inputs,
        "sourceMap": problem.source_map,
        "analysis": _analysis(problem),
        "toolchain": _toolchain(),
    }


@lru_cache(maxsize=1)
def _static_capabilities() -> dict[str, Any]:
    digest_value = protocol_digest()
    return {
        "apiVersion": wire.API_VERSION,
        "toolchain": toolchain_identity(),
        "compilerDigest": compiler_bundle_digest(),
        "protocol": {"id": PROTOCOL_ID, "digest": digest_value},
        "protocolDigest": digest_value,
        "profiles": [profile_descriptor(item) for item in installed_profile_manifests()],
        "dialects": [dialect_descriptor(item) for item in installed_dialect_manifests()],
        "schemaKinds": sorted(SCHEMA_KINDS),
    }


class InProcessBim:
    """BIM in this process.  ``limits`` are the package limits (default: those of ``bim_core``), also applied to the
    size of a standalone XML resource."""

    def __init__(self, limits: Limits | None = None) -> None:
        self._limits = limits if limits is not None else default_limits()

    def __enter__(self) -> InProcessBim:
        return self

    def __exit__(self, *exc_info: object) -> None:
        self.close()

    def close(self) -> None:
        return None

    def __repr__(self) -> str:
        return "InProcessBim()"

    # --- descriptors ---------------------------------------------------------------------------

    @wire.normalized
    def capabilities(self) -> Capabilities:
        return wire.output({
            **_static_capabilities(),
            "service": None,
            "limits": {"package": asdict(self._limits), "service": None},
        })

    @wire.normalized
    def profiles(self) -> list[dict[str, Any]]:
        return wire.output([
            {"reference": manifest_reference(item), "descriptor": profile_descriptor(item), "manifest": item}
            for item in installed_profile_manifests()
        ])

    @wire.normalized
    def dialects(self) -> list[dict[str, Any]]:
        return wire.output([
            {"reference": manifest_reference(item), "descriptor": dialect_descriptor(item), "manifest": item}
            for item in installed_dialect_manifests()
        ])

    @wire.normalized
    def schema(self, kind: str) -> dict[str, Any]:
        filename = SCHEMA_KINDS.get(kind) if isinstance(kind, str) else None
        if filename is None:
            raise ContractError(
                "schema_not_found",
                f"there is no schema of kind {str(kind)[:64]!r}; the kinds are {', '.join(sorted(SCHEMA_KINDS))}",
                http_status=404,
            )
        return json.loads(read_schema(filename))

    @wire.normalized
    def protocol(self) -> dict[str, Any]:
        return wire.output({"id": PROTOCOL_ID, "digest": protocol_digest(), "document": protocol_document()})

    # --- compile and validate ------------------------------------------------------------------

    @wire.normalized
    def compile(
        self, package: bytes, registered_resources: Sequence[RegisteredResourceSpec] = ()
    ) -> CompileResult:
        data = wire.package_bytes(package)
        registered = wire.registered_resources(registered_resources)
        loaded = load_package(data, limits=self._limits)
        problem = compile_instance(loaded, _registry(registered))
        package_digest = loaded.package_digest
        return wire.output({
            "ir": problem.document,
            **_compiled(package_digest, problem, _input_digest(package_digest, registered)),
        })

    @wire.normalized
    def validate(
        self, package: bytes, registered_resources: Sequence[RegisteredResourceSpec] = ()
    ) -> ValidationResult:
        data = wire.package_bytes(package)
        registered = wire.registered_resources(registered_resources)
        loaded = load_package(data, limits=self._limits)
        package_digest = loaded.package_digest
        inputs = _input_digest(package_digest, registered)
        try:
            problem = compile_instance(loaded, _registry(registered))
        except CompileError as exc:
            return wire.output({
                "valid": False,
                "diagnostics": [item.as_dict() for item in exc.diagnostics],
                "packageDigest": package_digest,
                "inputDigest": inputs,
                "toolchain": _toolchain(),
            })
        return wire.output({"valid": True, "diagnostics": [], **_compiled(package_digest, problem, inputs)})

    # --- engine compatibility and optimization -------------------------------------------------

    @wire.normalized
    def compatibility(
        self,
        ir: Mapping[str, Any],
        manifest: Mapping[str, Any],
        *,
        mode: str | None = None,
        options: Mapping[str, Any] | None = None,
    ) -> CompatibilityResult:
        document = wire.ir_document(ir)
        engine = wire.require_object(manifest, "manifest")
        mode_id = wire.optional_text(mode, "mode")
        supplied = wire.optional_object(options, "options")
        problem = BindingProblem.from_document(document)
        _, selected, effective = resolve_engine_mode(engine, mode_id, supplied if supplied is not None else {})
        diagnostics = mode_compatibility(problem, selected)
        return wire.output({
            "compatible": not diagnostics,
            "diagnostics": diagnostics,
            "mode": mode_execution_contract(selected),
            "options": effective,
        })

    @wire.normalized
    def resolve_optimization(
        self,
        ir: Mapping[str, Any],
        manifest: Mapping[str, Any],
        requested: Any,
        *,
        mode: str | None = None,
    ) -> OptimizationResolution:
        document = wire.ir_document(ir)
        engine = wire.require_object(manifest, "manifest")
        mode_id = wire.optional_text(mode, "mode")
        selection = wire.strict_json(requested, "optimization")
        problem = BindingProblem.from_document(document)
        _, selected, _ = resolve_engine_mode(engine, mode_id, {})
        return wire.output({
            "optimization": resolve_optimization(problem, selected, selection),
            "mode": mode_execution_contract(selected),
        })

    # --- evaluation ----------------------------------------------------------------------------

    @wire.normalized
    def evaluate(
        self, ir: Mapping[str, Any], binding: Mapping[str, Any], execution: Mapping[str, Any] | None = None
    ) -> dict[str, Any]:
        document = wire.ir_document(ir)
        selection = wire.strict_json(binding, "binding")
        plan = wire.optional_object(execution, "execution")
        problem = BindingProblem.from_document(document)
        return wire.output(evaluate(problem, selection, plan))

    @wire.normalized
    def evaluate_many(
        self,
        ir: Mapping[str, Any],
        bindings: Sequence[Mapping[str, Any]],
        execution: Mapping[str, Any] | None = None,
        *,
        on_error: str = "raise",
    ) -> list[EvaluationOutcome]:
        document = wire.ir_document(ir)
        selections = wire.strict_json(list(bindings), "bindings")
        if not selections:
            raise wire.request_invalid("bindings must hold at least one binding", "/bindings")
        plan = wire.optional_object(execution, "execution")
        mode = wire.choice(on_error, "on_error", ("raise", "collect"))
        problem = BindingProblem.from_document(document)
        results = evaluate_many(problem, selections, plan, on_error=mode)  # type: ignore[arg-type]
        return wire.output([
            {"error": item.as_dict()} if isinstance(item, EvaluationError) else {"evaluation": item}
            for item in results
        ])

    @wire.normalized
    def reevaluate(
        self,
        ir: Mapping[str, Any],
        result: Mapping[str, Any],
        execution: Mapping[str, Any] | None = None,
        allowed_terminations: Sequence[str] | None = None,
    ) -> dict[str, Any]:
        document = wire.ir_document(ir)
        answer = wire.require_object(result, "result")
        plan = wire.optional_object(execution, "execution")
        allowed = None if allowed_terminations is None else wire.strict_json(list(allowed_terminations), "allowed_terminations")
        problem = BindingProblem.from_document(document)
        if allowed is None:
            return wire.output(reevaluate_result(problem, answer, plan))
        return wire.output(reevaluate_result(problem, answer, plan, allowed))

    @wire.normalized
    def validate_result(self, payload: Any) -> ResultValidation:
        message = wire.strict_json(payload, "payload")
        try:
            validate_result(message, finite=True)
        except ProtocolError as exc:
            return {"valid": False, "error": {"code": exc.code, "message": exc.message}}
        return {"valid": True, "error": None}

    @wire.normalized
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
        document = wire.ir_document(ir)
        selection = wire.strict_json(binding, "binding")
        name = wire.optional_text(task, "task")
        count = wire.integer(limit, "limit")
        budget = wire.positive_number(seconds, "seconds")
        plan = wire.optional_object(execution, "execution")
        problem = BindingProblem.from_document(document)
        return wire.output(
            analyze_neighborhood(problem, selection, task=name, limit=count, seconds=budget, execution=plan)
        )

    # --- single documents (``BimResourcePort``) ------------------------------------------------

    @wire.normalized
    def validate_resource(
        self,
        document: Mapping[str, Any],
        api_version: Any,
        kind: Any,
        media_type: Any,
        resource: str,
        dialects: Sequence[Mapping[str, Any]] | None = None,
    ) -> list[dict[str, Any]]:
        body = wire.require_object(document, "document")
        # The type is looked up by equality, as ``bim_core`` does: an identity that matches nothing is a
        # ``schema_unavailable`` diagnostic, not a refused request.
        identity = (
            wire.strict_json(api_version, "apiVersion"),
            wire.strict_json(kind, "kind"),
            wire.strict_json(media_type, "mediaType"),
        )
        name = wire.required_text(resource, "resource")
        considered = wire.optional_objects(dialects, "dialects")
        found = resource_schema_diagnostics(body, *identity, name, considered)
        return wire.output([item.as_dict() for item in found])

    @wire.normalized
    def validate_engine(self, document: Mapping[str, Any]) -> list[dict[str, Any]]:
        engine = wire.require_object(document, "document")
        # ``engine_contract_diagnostics`` raises on a ``spec`` that is not an object; that is a finding, not a failure.
        if "spec" in engine and not isinstance(engine["spec"], Mapping):
            return wire.output([_engine_contract_invalid("engine document 'spec' must be an object")])
        try:
            return wire.output(engine_contract_diagnostics(engine))
        except (AttributeError, KeyError, TypeError):
            return wire.output([_engine_contract_invalid("engine document does not have the shape of an engine contract")])

    @wire.normalized
    def xml_resource_root(self, content: bytes) -> dict[str, str]:
        root = _xml_resource(content, self._limits).xml_root("resource.xml")
        tag = root.tag
        if isinstance(tag, str) and tag.startswith("{") and "}" in tag:
            namespace, local_name = tag[1:].split("}", 1)
        else:
            namespace, local_name = "", str(tag)
        return {"namespace": namespace, "localName": local_name}

    @wire.normalized
    def validate_bpmn_resource(self, content: bytes) -> dict[str, bool]:
        _xml_resource(content, self._limits).xml("resource.xml")
        return {"valid": True}


def _xml_resource(content: bytes, limits: Limits) -> InstancePackage:
    return InstancePackage(
        {"instance.json": b"{}", "resource.xml": wire.binary(content, "content")}, limits=limits
    )
