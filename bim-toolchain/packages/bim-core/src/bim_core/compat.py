"""Engine manifests, execution options and the compatibility of a problem with an Engine mode.

Only pure functions of their arguments live here.  Engine manifests are **input** (plain
dictionaries, for example the JSON documents of a host's Engine catalog), never resources of this
package; nothing is read from disk except the JSON Schemas bundled with the package.

Where the original raised an HTTP error, the functions raise :class:`~bim_core.errors.ContractError`
with the same ``code`` and ``diagnostics`` and the status the host should answer with in
``error.http_status`` (422 everywhere in this module).  The library does not speak HTTP.

Codes raised: ``engine_contract_invalid``, ``engine_mode_incompatible``, ``invalid_option``,
``unknown_option``, ``option_limit``, ``optimization_required``, ``invalid_optimization_type``,
``scalarization_required``, ``invalid_criteria``, ``objective_cardinality``,
``scalarization_incompatible``, ``optimization_type_incompatible``, ``invalid_weights``,
``weights_forbidden``, ``weights_required``, ``criteria_required``.

Diagnostics of :func:`mode_compatibility` have a ``code`` of ``profile_incompatible``,
``ir_incompatible``, ``missing_capability_selector``, ``unsupported_capability``,
``unsupported_capability_value``, ``invalid_capability_selector`` or ``engine_limit``.
"""

from __future__ import annotations

import json
import math
from typing import Any, Mapping, NoReturn

import jsonschema

from .assets import read_schema
from .canonical import digest
from .compiler import BindingProblem, installed_profile
from .errors import ContractError

SCHEMA_FILES = {
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
}

#: Option names that a mode bounds with a limit, and the limit that bounds each.
OPTION_LIMITS = (
    ("iterations", "maxIterations"),
    ("max_evaluations", "maxIterations"),
    ("population_size", "maxPopulation"),
    ("archive_size", "maxSolutions"),
    ("time_budget_ms", "maxTimeBudgetMs"),
)

_UNPROCESSABLE = 422


def _rejection(
    code: str,
    message: str,
    diagnostics: list[dict[str, Any]] | None = None,
    status: int = _UNPROCESSABLE,
) -> ContractError:
    return ContractError(code, message, diagnostics or [], http_status=status)


# --- manifests -------------------------------------------------------------------------------


def engine_ref(document: Mapping[str, Any], namespace: str | None = None) -> dict[str, str]:
    """The immutable reference of an Engine manifest: namespace, name, version and content digest."""
    metadata = document.get("metadata", {})
    resolved_namespace = namespace or metadata.get("namespace") or "bim.builtin"
    return {
        "namespace": resolved_namespace,
        "name": metadata["name"],
        "version": metadata.get("version", "1.0.0"),
        "digest": digest(document),
    }


def selector_values(mode: Mapping[str, Any], dimension: str, universe: tuple[str, ...]) -> tuple[str, ...]:
    """The values of ``universe`` that ``mode`` selects for one capability dimension."""
    declaration = mode.get("capabilities", {}).get(dimension, {})
    if not isinstance(declaration, Mapping):
        return ()
    if declaration.get("selector") == "all":
        return universe
    if declaration.get("selector") == "only":
        values = declaration.get("values", [])
        return tuple(value for value in values if isinstance(value, str) and value in universe)
    return ()


def mode_execution_contract(mode: Mapping[str, Any]) -> dict[str, Any]:
    """What a job pins about a mode: its id and the terminations it guarantees."""
    guarantees = mode.get("guarantees", {})
    terminations = guarantees.get("termination", []) if isinstance(guarantees, Mapping) else []
    return {
        "id": mode.get("id"),
        "terminationGuarantees": list(terminations) if isinstance(terminations, list) else [],
    }


def persisted_mode_contract(value: Any) -> dict[str, Any] | None:
    """A stored :func:`mode_execution_contract` if it is well formed, else ``None``."""
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
            not isinstance(item, str) or item not in {"OPTIMAL", "FEASIBLE", "INFEASIBLE", "UNKNOWN"}
            for item in terminations
        )
        or len(set(terminations)) != len(terminations)
    ):
        return None
    return {"id": mode_id, "terminationGuarantees": list(terminations)}


def schema_diagnostics(document: dict[str, Any], kind: str) -> list[dict[str, Any]]:
    """JSON Schema findings of ``document`` against the bundled schema of ``kind`` (``[]`` for unknown kinds)."""
    filename = SCHEMA_FILES.get(kind)
    if not filename:
        return []
    try:
        schema = json.loads(read_schema(filename))
        validator = jsonschema.Draft202012Validator(schema)
        return [
            {"code": "schema", "message": error.message, "pointer": "/" + "/".join(str(part) for part in error.path)}
            for error in validator.iter_errors(document)
        ]
    except (OSError, json.JSONDecodeError) as exc:
        return [{"code": "schema_unavailable", "message": str(exc)}]


def embedded_secret_paths(value: Any, pointer: str = "") -> list[str]:
    """JSON pointers of keys that look like embedded credentials (the OpenAPI under ``/spec/openapi`` is skipped)."""
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


# --- execution options -----------------------------------------------------------------------


def select_mode(
    document: Mapping[str, Any], requested: str | None, *, name: str | None = None
) -> dict[str, Any]:
    """The mode of an Engine manifest named ``requested``; the only mode if none is requested.

    Raises ``engine_mode_incompatible`` (422) when there is no such mode.
    """
    modes = document.get("spec", {}).get("modes", [])
    mode = next((item for item in modes if item.get("id") == (requested or "")), None)
    if mode is None and requested is None and len(modes) == 1:
        mode = modes[0]
    if mode is None:
        engine_name = name if name is not None else document.get("metadata", {}).get("name")
        message = f"engine {engine_name!r} does not provide mode {requested!r}"
        raise _rejection("engine_mode_incompatible", message, [{"code": "mode", "message": message}])
    return mode


def validate_options(mode: Mapping[str, Any], supplied: Any) -> dict[str, Any]:
    """The effective options of an execution: defaults of the mode plus ``supplied``, validated.

    Rejections (all 422): options that are not an object, unknown options, values that violate the
    ``optionsSchema`` of the mode, non-integer or non-numeric values, values outside
    ``minimum``/``maximum``, and values above a limit of the mode (``maxIterations``,
    ``maxPopulation``, ``maxSolutions``, ``maxTimeBudgetMs``).
    """
    if not isinstance(supplied, dict):
        message = "engine options must be a JSON object"
        raise _rejection(
            "invalid_option", message, [{"code": "option_type", "message": message, "pointer": "/options"}]
        )
    schema = mode.get("optionsSchema", {})
    properties = schema.get("properties", {}) if isinstance(schema, dict) else {}
    unknown = sorted(set(supplied) - set(properties))
    if unknown:
        diagnostics = [{"code": "unknown_option", "message": f"unknown engine option {key!r}"} for key in unknown]
        raise _rejection("unknown_option", "; ".join(item["message"] for item in diagnostics), diagnostics)
    effective = {
        key: value.get("default")
        for key, value in properties.items()
        if isinstance(value, dict) and "default" in value
    }
    effective.update(supplied)
    if isinstance(schema, dict):
        option_errors = list(jsonschema.Draft202012Validator(schema).iter_errors(effective))
        if option_errors:
            diagnostics = [
                {"code": "option_schema", "message": error.message, "pointer": "/options"}
                for error in option_errors
            ]
            raise _rejection("invalid_option", "; ".join(item["message"] for item in diagnostics), diagnostics)
    for key, value in effective.items():
        definition = properties.get(key, {})
        if definition.get("type") == "integer" and (not isinstance(value, int) or isinstance(value, bool)):
            _invalid_option("option_type", f"option {key!r} must be an integer")
        if definition.get("type") == "number" and (not isinstance(value, (int, float)) or isinstance(value, bool)):
            _invalid_option("option_type", f"option {key!r} must be numeric")
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            if "minimum" in definition and value < definition["minimum"]:
                _invalid_option("option_minimum", f"option {key!r} is below its minimum")
            if "maximum" in definition and value > definition["maximum"]:
                _invalid_option("option_maximum", f"option {key!r} exceeds its maximum")
    limits = mode.get("limits", {})
    for option, limit_name in OPTION_LIMITS:
        limit = limits.get(limit_name) if isinstance(limits, Mapping) else None
        if limit is None or option not in effective:
            continue
        value = effective[option]
        if not isinstance(value, (int, float)) or isinstance(value, bool):
            _invalid_option("option_type", f"option {option!r} must be numeric")
        if value > limit:
            message = f"option {option!r} exceeds mode limit {limit}"
            raise _rejection("option_limit", message, [{"code": "effective_limit", "message": message}])
    return effective


def _invalid_option(code: str, message: str) -> NoReturn:
    raise _rejection("invalid_option", message, [{"code": code, "message": message}])


def resolve_engine_mode(
    document: Mapping[str, Any],
    requested: str | None,
    supplied: Any,
    *,
    name: str | None = None,
) -> tuple[Mapping[str, Any], dict[str, Any], dict[str, Any]]:
    """``(document, mode, effective options)`` for a job that asks an Engine for ``requested`` with ``supplied``.

    The pure part of the platform's ``engine_mode``: the declarations of the manifest must be
    valid against their Profile (``engine_contract_invalid``), the mode must exist, and the options
    must be acceptable.  Finding the manifest is the host's job.
    """
    contract_diagnostics = engine_contract_diagnostics(document)
    if contract_diagnostics:
        raise _rejection(
            "engine_contract_invalid",
            "; ".join(item["message"] for item in contract_diagnostics),
            contract_diagnostics,
        )
    mode = select_mode(document, requested, name=name)
    return document, mode, validate_options(mode, supplied)


def resolve_optimization(
    problem: BindingProblem,
    mode: Mapping[str, Any],
    requested: Any,
) -> dict[str, Any]:
    """Validate and canonicalize the execution-time optimization selection.

    Returns ``{"type", "scalarization", "weights"}`` with weights normalized to sum to one.
    ``problem`` only needs a ``document`` attribute with the IR.
    """
    if not isinstance(requested, Mapping):
        raise _rejection("optimization_required", "job execution requires an optimization object")
    objective_type = requested.get("type")
    scalarization = requested.get("scalarization")
    if not isinstance(objective_type, str) or objective_type not in {"SINGLE", "MULTI", "MANY"}:
        raise _rejection("invalid_optimization_type", "optimization.type must be SINGLE, MULTI or MANY")
    if not isinstance(scalarization, str) or not scalarization:
        raise _rejection("scalarization_required", "optimization.scalarization is required")
    criteria = problem.document.get("spec", {}).get("optimization", {}).get("criteria", [])
    criteria_ids = [item.get("id") for item in criteria if isinstance(item, Mapping)]
    if len(criteria_ids) != len(set(criteria_ids)):
        raise _rejection("invalid_criteria", "BindingProblem contains duplicate criterion ids")
    count = len(criteria_ids)
    if objective_type == "MULTI" and not 2 <= count <= 3:
        raise _rejection("objective_cardinality", "MULTI requires two or three criteria")
    if objective_type == "MANY" and count < 3:
        raise _rejection("objective_cardinality", "MANY requires at least three criteria")
    capabilities = mode.get("capabilities", {})
    declaration = capabilities.get("scalarizations") if isinstance(capabilities, Mapping) else None
    descriptors = declaration.get("values", []) if isinstance(declaration, Mapping) else []
    descriptor = next(
        (item for item in descriptors if isinstance(item, Mapping) and item.get("id") == scalarization), None
    )
    if descriptor is None:
        raise _rejection(
            "scalarization_incompatible", f"engine mode does not support scalarization {scalarization!r}"
        )
    if objective_type not in descriptor.get("objectiveTypes", []):
        raise _rejection(
            "optimization_type_incompatible", f"scalarization {scalarization!r} does not support {objective_type}"
        )
    weight_policy = descriptor.get("weightPolicy")
    supplied = requested.get("weights")
    if supplied is not None and not isinstance(supplied, list):
        raise _rejection("invalid_weights", "optimization.weights must be an array")
    if weight_policy == "forbidden" and supplied not in (None, []):
        raise _rejection("weights_forbidden", f"scalarization {scalarization!r} does not accept weights")
    if weight_policy == "required" and supplied is None:
        if count == 0:
            raise _rejection("weights_required", "a weighted scalarization requires at least one criterion")
        supplied = [{"criteria": criterion_id, "value": 1.0 / count} for criterion_id in criteria_ids]
    if supplied is None:
        supplied = []
    weights: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in supplied:
        if not isinstance(item, Mapping) or set(item) != {"criteria", "value"}:
            raise _rejection("invalid_weights", "each weight must contain exactly criteria and value")
        criterion_id = item.get("criteria")
        value = item.get("value")
        if criterion_id not in criteria_ids or criterion_id in seen:
            raise _rejection("invalid_weights", "weights must reference each criterion exactly once")
        if (
            not isinstance(value, (int, float))
            or isinstance(value, bool)
            or not math.isfinite(float(value))
            or float(value) <= 0
        ):
            raise _rejection("invalid_weights", "criterion weights must be positive finite numbers")
        seen.add(criterion_id)
        weights.append({"criteria": criterion_id, "value": float(value)})
    if weight_policy == "required" and set(seen) != set(criteria_ids):
        raise _rejection("invalid_weights", "weights must cover all criteria")
    if weights:
        total = sum(item["value"] for item in weights)
        weights = [{**item, "value": item["value"] / total} for item in weights]
    if count == 0 and scalarization != "feasibility":
        raise _rejection("criteria_required", "criteria are required unless using feasibility scalarization")
    return {"type": objective_type, "scalarization": scalarization, "weights": weights}


# --- compatibility ---------------------------------------------------------------------------

_EXPRESSION_KINDS = {"literal", "path", "not", "negate", "and", "or", "compare", "arithmetic", "call"}


def candidate_count(spec: Mapping[str, Any]) -> int:
    """Number of candidates over all catalogs of an IR ``spec``."""
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
                location = {
                    "irPath": f"/spec/candidates/{_pointer_segment(catalog_id)}/candidates/"
                    f"{_pointer_segment(candidate_id)}/features/{_pointer_segment(alias)}"
                }
                source = problem.source_map.get(f"/spec/candidates/{catalog_id}/{candidate_id}")
                if (
                    isinstance(source, dict)
                    and isinstance(source.get("path"), str)
                    and isinstance(source.get("pointer"), str)
                ):
                    location["resource"] = source["path"]
                    location["pointer"] = f"{source['pointer']}/features/{alias}"
                return location
    return {}


def ir_features(problem: BindingProblem) -> dict[str, set[str]]:
    """The capabilities a problem uses, by dimension (``workflowNodes``, ``aggregations``, ``featureValues``, ...)."""
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
            if (
                isinstance(feature, Mapping)
                and isinstance(feature.get("dimension"), str)
                and isinstance(feature.get("value"), str)
            ):
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


def mode_compatibility(problem: BindingProblem, mode: Mapping[str, Any]) -> list[dict[str, Any]]:
    """Why ``mode`` cannot run ``problem``: one diagnostic per unmet requirement; ``[]`` if it can."""
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
                diagnostics.append({
                    "code": "unsupported_capability",
                    "category": category,
                    "unsupported": sorted(used),
                    "message": f"mode does not support {category}: {', '.join(sorted(used))}",
                })
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
            diagnostics.append({
                "code": "invalid_capability_selector",
                "category": category,
                "message": f"mode has an invalid {category} selector",
            })
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
            diagnostics.append({
                "code": "engine_limit",
                "limit": key,
                "actual": actual,
                "maximum": limit,
                "message": f"instance has {actual} {label}; mode limit is {limit}",
            })
    minimum = limits.get("minObjectives") if isinstance(limits, dict) else None
    if isinstance(minimum, int) and objective_count < minimum:
        diagnostics.append({
            "code": "engine_limit",
            "limit": "minObjectives",
            "actual": objective_count,
            "minimum": minimum,
            "message": f"instance has {objective_count} objectives; mode minimum is {minimum}",
        })
    return diagnostics
