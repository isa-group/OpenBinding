"""Engine manifests, registrations and the compatibility of a problem with an Engine mode."""

from __future__ import annotations

import json
import uuid
from typing import Any, Mapping

import jsonschema
import yaml
from fastapi import HTTPException
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..core.settings import get_settings
from ..db.models import EngineRegistrationRevision, EngineRevision, Job, User
from ..security.apikeys import allows_engine
from ..v1.canonical import digest, digest_bytes
from ..v1.compiler import BindingProblem, _schema_root, installed_profile
from ..v1.remote import RemoteEngineError, RemoteRegistration

#: Built-in registrations installed in this process.  ``routes.v1`` shares this very dict.
BUILTIN_REGISTRATIONS: dict[tuple[str, str, str, str], dict[str, Any]] = {}
#: ``routes.v1`` shares these very paths.
MANIFEST_DIR = _schema_root() / "manifests"
ENGINE_PROTOCOL_PATH = _schema_root().parents[1] / "engine-contract.openapi.yaml"


def protocol_document() -> dict[str, Any]:
    document = yaml.safe_load(ENGINE_PROTOCOL_PATH.read_text(encoding="utf-8"))
    if not isinstance(document, dict):
        raise RuntimeError("BIM engine OpenAPI contract must be an object")
    return document


def protocol_digest() -> str:
    # The OpenAPI refers to the BindingProblem schema by a local relative path.
    # Pin that external contract as part of the protocol identity so changing
    # the IR schema cannot leave a deceptively unchanged protocol revision.
    binding_problem_schema = ENGINE_PROTOCOL_PATH.parent / "bim" / "v1" / "binding-problem.schema.json"
    return digest({
        "openapi": protocol_document(),
        "externalSchemas": {
            "bim/v1/BindingProblem": digest_bytes(binding_problem_schema.read_bytes()),
        },
    })


BUILTIN_ENGINE_MAPPINGS = {
    "request": "/internal/v1/binding-problems",
    "job": "/internal/v1/jobs/{id}",
    "health": "/health",
    "openapi": "/openapi.json",
}


def builtin_engine_registration(
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

    engine_reference = engine_ref(manifest, "bim.builtin")
    installation = {
        "engine": engine_reference,
        "endpoint": endpoint,
        "protocol": {
            "id": "bim-engine/v1",
            "mediaType": "application/json",
            "digest": protocol_digest(),
        },
        "mappings": dict(BUILTIN_ENGINE_MAPPINGS),
        "auth": {"scheme": "none"},
        "openapi": {
            **protocol_document(),
            "x-bim-protocol": "bim-engine/v1",
            "x-bim-protocol-digest": protocol_digest(),
        },
    }
    installation_digest = digest(installation).removeprefix("sha256-")
    engine_version = str(engine_reference["version"]).split("+", 1)[0]
    document = {
        "apiVersion": "bim/v1",
        "kind": "EngineRegistration",
        "metadata": {
            "namespace": "bim.builtin",
            "name": f"{engine_reference['name']}-deployment",
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
    existing = BUILTIN_REGISTRATIONS.get(key)
    if existing is not None:
        if existing != installed:
            raise RuntimeError("built-in EngineRegistration identity is immutable")
        return existing
    BUILTIN_REGISTRATIONS[key] = installed
    return installed


def installed_builtin_registration(
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
    path = MANIFEST_DIR / f"{name}.json"
    try:
        installed_manifest = json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return None
    if digest(installed_manifest) != digest(manifest):
        return None
    installed = builtin_engine_registration(installed_manifest, endpoint)
    if registration_ref is not None and any(
        registration_ref.get(field) != installed[field]
        for field in ("namespace", "name", "version", "digest")
    ):
        return None
    return installed


def selector_values(mode: Mapping[str, Any], dimension: str, universe: tuple[str, ...]) -> tuple[str, ...]:
    declaration = mode.get("capabilities", {}).get(dimension, {})
    if not isinstance(declaration, Mapping):
        return ()
    if declaration.get("selector") == "all":
        return universe
    if declaration.get("selector") == "only":
        values = declaration.get("values", [])
        return tuple(value for value in values if isinstance(value, str) and value in universe)
    return ()


def manifest(
    name: str,
    *,
    namespace: str | None = None,
    version: str | None = None,
    manifest_digest: str | None = None,
    allow_internal: bool = False,
) -> dict[str, Any]:
    candidates = []
    path = MANIFEST_DIR / f"{name}.json"
    try:
        builtin = json.loads(path.read_text(encoding="utf-8"))
        if not allow_internal and builtin.get("metadata", {}).get("internal", False):
            raise HTTPException(status_code=404, detail=f"Unknown v1 engine: {name}")
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


async def manifest_async(
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
        document = manifest(
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


def schema_diagnostics(document: dict[str, Any], kind: str) -> list[dict[str, Any]]:
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
    path = MANIFEST_DIR.parent / filename
    try:
        schema = json.loads(path.read_text(encoding="utf-8"))
        validator = jsonschema.Draft202012Validator(schema)
        return [{"code": "schema", "message": error.message, "pointer": "/" + "/".join(str(part) for part in error.path)} for error in validator.iter_errors(document)]
    except (OSError, json.JSONDecodeError) as exc:
        return [{"code": "schema_unavailable", "message": str(exc)}]


def embedded_secret_paths(value: Any, pointer: str = "") -> list[str]:
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
            paths.extend(embedded_secret_paths(child, child_pointer))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            paths.extend(embedded_secret_paths(child, f"{pointer}/{index}"))
    return paths


def engine_contract_diagnostics(document: Mapping[str, Any]) -> list[dict[str, Any]]:
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


async def engine_mode(
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
    engine_document = await manifest_async(
        name,
        session,
        caller=caller,
        namespace=namespace,
        version=version,
        manifest_digest=manifest_digest,
    )
    contract_diagnostics = engine_contract_diagnostics(engine_document)
    if contract_diagnostics:
        raise HTTPException(
            status_code=422,
            detail={"code": "engine_contract_invalid", "diagnostics": contract_diagnostics},
        )
    modes = engine_document.get("spec", {}).get("modes", [])
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
    return engine_document, mode, effective


_EXPRESSION_KINDS = {"literal", "path", "not", "negate", "and", "or", "compare", "arithmetic", "call"}


def candidate_count(spec: Mapping[str, Any]) -> int:
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
        and child.get("segments", [None])[0] == "features"
        for child in children
    ) and any(isinstance(child, dict) and child.get("kind") == "literal" for child in children)


def _feature_value_kinds(spec: Mapping[str, Any]) -> set[str]:
    kinds: set[str] = set()
    catalogs = spec.get("candidates", {})
    for catalog in catalogs.values() if isinstance(catalogs, dict) else ():
        if not isinstance(catalog, dict) or not isinstance(catalog.get("candidates"), dict):
            continue
        bindings = catalog.get("featureBindings", {})
        for candidate in catalog["candidates"].values():
            slots = candidate.get("features", {}) if isinstance(candidate, dict) else {}
            for alias, value in slots.items() if isinstance(slots, dict) else ():
                if isinstance(bindings, dict) and alias in bindings:
                    kinds.add("interval" if isinstance(value, dict) else "scalar")
    return kinds


def _pointer_segment(value: Any) -> str:
    return str(value).replace("~", "~0").replace("/", "~1")


def _feature_value_location(problem: BindingProblem, kinds: set[str]) -> dict[str, str]:
    """Where the first candidate feature value of one of ``kinds`` is, in the style of the compiler's diagnostics.

    ``resource`` and ``pointer`` name the value inside the catalog file of the package; ``irPath`` names it in the
    BindingProblem.  Empty when no such value exists, and without ``resource``/``pointer`` when the source of the
    candidate is not known.
    """
    catalogs = problem.document.get("spec", {}).get("candidates", {})
    for catalog_id, catalog in catalogs.items() if isinstance(catalogs, dict) else ():
        if not isinstance(catalog, dict) or not isinstance(catalog.get("candidates"), dict):
            continue
        bindings = catalog.get("featureBindings", {})
        for candidate_id, candidate in catalog["candidates"].items():
            slots = candidate.get("features", {}) if isinstance(candidate, dict) else {}
            for alias, value in slots.items() if isinstance(slots, dict) else ():
                if not isinstance(bindings, dict) or alias not in bindings:
                    continue
                if ("interval" if isinstance(value, dict) else "scalar") not in kinds:
                    continue
                location = {"irPath": f"/spec/candidates/{_pointer_segment(catalog_id)}/candidates/{_pointer_segment(candidate_id)}/features/{_pointer_segment(alias)}"}
                source = problem.source_map.get(f"/spec/candidates/{catalog_id}/{candidate_id}")
                if isinstance(source, dict) and isinstance(source.get("path"), str) and isinstance(source.get("pointer"), str):
                    location["resource"] = source["path"]
                    location["pointer"] = f"{source['pointer']}/features/{alias}"
                return location
    return {}


def ir_features(problem: BindingProblem) -> dict[str, set[str]]:
    spec = problem.document.get("spec", {})
    application = spec.get("application", {})
    features_dict = application.get("features", {}) if isinstance(application, dict) else {}
    workflow = application.get("workflow", {}) if isinstance(application, dict) else {}
    workflow_contexts = _workflow_aggregation_contexts(workflow)
    required_features = set(application.get("requiredFeatures", [])) if isinstance(application, dict) else set()
    aggregations: set[str] = set()
    feature_scopes: set[str] = set()
    for feature_id, feature in features_dict.items() if isinstance(features_dict, dict) else []:
        if feature_id not in required_features:
            continue
        aggregation = feature.get("aggregation", {}) if isinstance(feature, dict) else {}
        if isinstance(aggregation, dict):
            scope = feature.get("scope")
            active_contexts = {"selection"} if scope == "selectedCandidate" else workflow_contexts
            for context in active_contexts:
                value = aggregation.get(context)
                if value is None:
                    continue
                operator = value if isinstance(value, str) else "expression"
                aggregations.add(f"{context}.{operator}")
        if isinstance(feature, dict) and isinstance(feature.get("scope"), str):
            feature_scopes.add(feature["scope"])
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
    for feature_id, feature in features_dict.items() if isinstance(features_dict, Mapping) else ():
        if feature_id not in required_features or not isinstance(feature, Mapping):
            continue
        aggregation = feature.get("aggregation", {})
        if not isinstance(aggregation, Mapping):
            continue
        contexts = (
            {"selection"}
            if feature.get("scope") == "selectedCandidate"
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
    routing = spec.get("routing", {}) if isinstance(spec.get("routing"), dict) else {}
    features = {
        "workflowNodes": _workflow_features(workflow, routing),
        "aggregations": aggregations,
        "featureScopes": feature_scopes,
        "featureValues": _feature_value_kinds(spec),
        "constraints": constraint_features,
        "expressions": expression_features,
        "placement": placement_features,
        "irExtensions": set(),
    }
    for dimension, values in dialect_features.items():
        features.setdefault(dimension, set()).update(values)
    return features


def mode_compatibility(problem: BindingProblem, mode: dict[str, Any]) -> list[dict[str, Any]]:
    features = ir_features(problem)
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
                diagnostic = {
                    "code": "unsupported_capability_value",
                    "category": category,
                    "unsupported": sorted(unsupported),
                    "allowed": sorted(allowed),
                    "message": f"mode does not support requested {category} values",
                }
                if category == "featureValues":
                    diagnostic.update(_feature_value_location(problem, unsupported))
                diagnostics.append(diagnostic)
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
    candidates_total = candidate_count(spec)
    optimization = spec.get("optimization", {})
    criteria = optimization.get("criteria", []) if isinstance(optimization, Mapping) else []
    objective_count = len(criteria) if isinstance(criteria, list) else 0
    limits = mode.get("limits", {})
    for key, actual, label in (
        ("maxTasks", task_count, "tasks"),
        ("maxCandidates", candidates_total, "candidates"),
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


def engine_ref(document: dict[str, Any], namespace: str | None = None) -> dict[str, str]:
    metadata = document.get("metadata", {})
    resolved_namespace = namespace or metadata.get("namespace") or "bim.builtin"
    return {
        "namespace": resolved_namespace,
        "name": metadata["name"],
        "version": metadata.get("version", "1.0.0"),
        "digest": digest(document),
    }


async def available_engine_documents(
    session: AsyncSession | None,
    caller: User | None = None,
) -> list[tuple[dict[str, Any], str | None]]:
    documents: list[tuple[dict[str, Any], str | None]] = []
    for path in sorted(MANIFEST_DIR.glob("*.json")):
        doc = json.loads(path.read_text(encoding="utf-8"))
        if doc.get("metadata", {}).get("internal", False):
            continue
        documents.append((doc, "bim.builtin"))
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
        documents.extend(
            (revision.document, revision.namespace)
            for revision in revisions
            if not revision.document.get("metadata", {}).get("internal", False)
        )
    unique: dict[tuple[str, str, str, str], tuple[dict[str, Any], str | None]] = {}
    for document, namespace in documents:
        reference = engine_ref(document, namespace)
        key = (reference["namespace"], reference["name"], reference["version"], reference["digest"])
        unique[key] = (document, namespace)
    return list(unique.values())


def registration_engine_reference(
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


async def visible_engine_registrations(
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
        installed_builtin = installed_builtin_registration(
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
        if registration_engine_reference(registration) != engine_reference:
            continue
        reference = registration_reference(registration)
        key = tuple(reference[field] for field in ("namespace", "name", "version", "digest"))
        exact[key] = registration
    return [exact[key] for key in sorted(exact)]


async def compatible_modes(
    problem: BindingProblem,
    caller: User | None,
    session: AsyncSession | None,
) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for document, namespace in await available_engine_documents(session, caller):
        reference = engine_ref(document, namespace)
        registrations = await visible_engine_registrations(
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
            diagnostics = mode_compatibility(problem, mode)
            for registration in registrations:
                result.append(
                    {
                        "engine": reference,
                        "registration": registration_reference(registration),
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


async def owned_job(job_id: str, caller: User | None, session: AsyncSession | None):
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


async def registration_for_engine(
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


def registration_reference(registration: Mapping[str, Any]) -> dict[str, str]:
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


def registration_summary(
    registration: EngineRegistrationRevision | Mapping[str, Any],
) -> dict[str, Any]:
    reference = registration_reference(registration)
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


def is_installed_builtin_registration(registration: Mapping[str, Any]) -> bool:
    reference = registration_reference(registration)
    key = tuple(reference[field] for field in ("namespace", "name", "version", "digest"))
    installed = BUILTIN_REGISTRATIONS.get(key)
    return bool(
        installed is not None
        and installed.get("installedBuiltin") is True
        and installed.get("document") == registration.get("document")
    )


def registration_transport(
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
            is_installed_builtin_registration(registration)
            or not get_settings().federation_require_https
        ),
    )


def mode_execution_contract(mode: Mapping[str, Any]) -> dict[str, Any]:
    guarantees = mode.get("guarantees", {})
    terminations = guarantees.get("termination", []) if isinstance(guarantees, Mapping) else []
    return {
        "id": mode.get("id"),
        "terminationGuarantees": list(terminations) if isinstance(terminations, list) else [],
    }


def persisted_mode_contract(value: Any) -> dict[str, Any] | None:
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


async def persisted_engine_contract(
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
    engine_document: dict[str, Any] | None
    try:
        engine_document = manifest(
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
        engine_document = revision.document if revision is not None else None
    if engine_document is None or digest(engine_document) != reference["digest"]:
        return None
    selected = next(
        (
            item
            for item in engine_document.get("spec", {}).get("modes", [])
            if isinstance(item, Mapping) and item.get("id") == mode["id"]
        ),
        None,
    )
    if selected is None or mode_execution_contract(selected) != mode:
        return None
    return engine_document
