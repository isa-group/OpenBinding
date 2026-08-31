import json
from copy import deepcopy

import pytest

from openbinding_gateway.v1.compiler import (
    CompiledProblem,
    CompileError,
    RegisteredResource,
    ResolvedInstance,
    _schema_root,
    _schema_validator,
    compile_instance,
    installed_dialect_manifests,
    installed_framework_diagnostics,
    installed_profile_manifests,
    install_dialect_contract,
    install_profile_contract,
    uninstall_dialect_contract,
    uninstall_profile_contract,
)
from openbinding_gateway.v1.canonical import digest
from openbinding_gateway.v1.expressions import ExpressionError, compile_expression
from openbinding_gateway.v1.package import InstancePackage, resource_digest


def envelope(kind, name, spec):
    api_version = "qos-binding-placement/v1" if kind == "Placement" else "qos-binding/v1"
    return {"apiVersion": api_version, "kind": kind, "metadata": {"name": name}, "spec": spec}


def package(documents, resources, name="final-language"):
    root = {
        "apiVersion": "bim/v1",
        "kind": "Instance",
        "metadata": {"name": name},
        "spec": {"profile": "qos-binding/v1", "resources": resources},
    }
    files = {"instance.json": json.dumps(root, allow_nan=False).encode()}
    files.update({path: (value if isinstance(value, bytes) else json.dumps(value, allow_nan=False).encode()) for path, value in documents.items()})
    return InstancePackage(files)


def base_package(*, workflow=None, optimization=None, placement=None):
    workflow = workflow or {
        "sequence": [
            {"task": {"resource": "app", "id": "t1"}},
            {"repeat": {"body": {"task": {"resource": "app", "id": "t2"}}, "expectedCount": 2.0}},
            {"task": {"resource": "app", "id": "local"}},
        ]
    }
    application = envelope(
        "Application",
        "app",
        {
            "tasks": {"t1": "svc/v1", "t2": "svc/v1", "local": {"kind": "local"}},
            "metrics": {
                "latency": {"unit": "ms", "direction": "minimize", "aggregation": "sum"},
                "cost": {"unit": "eur", "direction": "minimize", "scope": "selectedCandidate", "aggregation": "sum"},
            },
            "workflow": workflow,
        },
    )
    catalog_a = envelope(
        "CandidateCatalog",
        "catalog-a",
        {
            "providers": {"pa": {"name": "A"}},
            "metricBindings": {
                "latency": {"resource": "app", "id": "latency"},
                "cost": {"resource": "app", "id": "cost"},
            },
            "candidates": {
                "c1": {
                    "provider": {"resource": "cat-a", "id": "pa"},
                    "provides": "svc/v1",
                    "metrics": {"latency": 10, "cost": 5},
                }
            },
        },
    )
    catalog_b = envelope(
        "CandidateCatalog",
        "catalog-b",
        {
            "providers": {"pb": {"name": "B"}},
            "metricBindings": {
                "latency": {"resource": "app", "id": "latency"},
                "cost": {"resource": "app", "id": "cost"},
            },
            "candidates": {
                "c1": {
                    "provider": {"resource": "cat-b", "id": "pb"},
                    "provides": ["svc/v1"],
                    "metrics": {"latency": 20, "cost": 7},
                }
            },
        },
    )
    hard = envelope(
        "ConstraintSet",
        "hard",
        {"constraints": {"limit": {"assert": "metrics.latency <= 100", "enforcement": "hard"}}},
    )
    soft = envelope(
        "ConstraintSet",
        "soft",
        {"constraints": {"limit": {"assert": "has(tasks.t1.provider)", "enforcement": "soft", "penalty": 2}}},
    )
    optimization = optimization or envelope(
        "Optimization",
        "opt",
        {
            "mode": "weighted",
            "terms": [
                {"metric": {"resource": "app", "id": "latency"}, "weight": 3, "normalize": {"min": 0, "max": 100, "clamp": False}},
                {"metric": {"resource": "app", "id": "cost"}, "weight": 1, "normalize": {"min": 0, "max": 20, "clamp": False}},
            ],
            "penalties": [{"constraint": {"resource": "soft", "id": "limit"}, "weight": 1}],
        },
    )
    documents = {
        "application.json": application,
        "catalog-a.json": catalog_a,
        "catalog-b.json": catalog_b,
        "hard.json": hard,
        "soft.json": soft,
        "optimization.json": optimization,
    }
    resources = {
        "application": {"app": "application.json"},
        "candidateCatalog": {"cat-a": "catalog-a.json", "cat-b": "catalog-b.json"},
        "constraintSet": {"hard": "hard.json", "soft": "soft.json"},
        "optimization": {"opt": "optimization.json"},
    }
    if placement is not None:
        documents["placement.json"] = placement
        resources["application"]["place"] = "placement.json"
    return package(documents, resources)


@pytest.mark.parametrize(
    ("objective_type", "mode", "term_count", "valid"),
    [
        ("MONO", "satisfy", 0, True),
        ("MONO", "weighted", 0, False),
        ("MONO", "weighted", 1, True),
        ("MONO", "weighted", 4, True),
        ("MULTI", "pareto", 1, False),
        ("MULTI", "pareto", 2, True),
        ("MULTI", "pareto", 3, True),
        ("MULTI", "pareto", 4, False),
        ("MANY", "pareto", 2, False),
        ("MANY", "pareto", 3, True),
        ("MANY", "pareto", 4, True),
    ],
)
def test_objective_type_has_the_declared_source_cardinality(
    objective_type: str, mode: str, term_count: int, valid: bool
) -> None:
    document = envelope(
        "Optimization",
        "objective-cardinality",
        {
            "mode": mode,
            "type": objective_type,
            "terms": [
                {"metric": {"resource": "app", "id": f"metric-{index}"}}
                for index in range(term_count)
            ],
        },
    )
    validator = _schema_validator("Optimization")
    assert validator is not None
    assert (not list(validator.iter_errors(document))) is valid


def test_compiler_defaults_objective_type_and_preserves_explicit_three_term_multi() -> None:
    value = base_package()
    weighted = compile_instance(value)
    assert weighted.document["spec"]["optimization"]["type"] == "MONO"
    without_type = deepcopy(weighted.document)
    without_type["spec"]["optimization"].pop("type")
    ir_validator = _schema_validator("BindingProblem")
    assert ir_validator is not None
    assert list(ir_validator.iter_errors(without_type))

    optimization = json.loads(value.files["optimization.json"])
    optimization["spec"]["mode"] = "pareto"
    optimization["spec"]["terms"] = optimization["spec"]["terms"][:1]
    value.files["optimization.json"] = json.dumps(optimization).encode()
    assert compile_instance(value).document["spec"]["optimization"]["type"] == "MONO"

    optimization["spec"]["terms"].append(deepcopy(optimization["spec"]["terms"][0]))
    value.files["optimization.json"] = json.dumps(optimization).encode()
    assert compile_instance(value).document["spec"]["optimization"]["type"] == "MULTI"

    optimization["spec"]["terms"].append(deepcopy(optimization["spec"]["terms"][0]))
    value.files["optimization.json"] = json.dumps(optimization).encode()
    assert compile_instance(value).document["spec"]["optimization"]["type"] == "MANY"

    optimization["spec"]["type"] = "MULTI"
    value.files["optimization.json"] = json.dumps(optimization).encode()
    assert compile_instance(value).document["spec"]["optimization"]["type"] == "MULTI"


def test_multiple_resources_keep_local_id_identity_and_evaluate_once_selected():
    problem = compile_instance(base_package())
    spec = problem.document["spec"]
    assert set(spec["candidates"]) == {"cat-a", "cat-b"}
    assert spec["candidates"]["cat-a"]["candidates"]["c1"]["ref"] == {"resource": "cat-a", "id": "c1"}
    assert {tuple(item["ref"].values()) for item in spec["constraints"]} == {("hard", "limit"), ("soft", "limit")}
    binding = {"t1": {"resource": "cat-a", "id": "c1"}, "t2": {"resource": "cat-a", "id": "c1"}}
    assert problem.evaluate_binding(binding) == {"latency": 30.0, "cost": 5.0}
    assert problem.evaluate_constraints(binding) == []
    assert [term["weight"] for term in spec["optimization"]["terms"]] == [0.75, 0.25]
    assert spec["profile"]["output"]["apiVersion"] == "bim/v1"
    assert spec["profile"]["output"]["kind"] == "BindingProblem"
    assert "/spec/candidates/cat-a/c1" in spec["sourceMap"]
    assert spec["sourceMap"]["/spec/constraints/0/assert"]["span"]["start"] == 0


def test_compile_diagnostic_serializes_an_ir_path():
    from openbinding_gateway.v1.compiler import CompileDiagnostic

    assert CompileDiagnostic(
        code="ir",
        message="invalid lowered node",
        resource="application.json",
        pointer="/spec/workflow",
        ir_path="/spec/application/workflow",
    ).as_dict()["irPath"] == "/spec/application/workflow"


def test_candidate_predicate_diagnostic_points_to_the_application_source():
    value = base_package()
    application = json.loads(value.files["application.json"])
    application["spec"]["tasks"]["t1"] = {
        "requires": {
            "type": "svc/v1",
            "predicate": "candidate.properties.missing > 0",
        }
    }
    value.files["application.json"] = json.dumps(application).encode()

    with pytest.raises(CompileError) as captured:
        compile_instance(value)

    diagnostic = next(
        item.as_dict()
        for item in captured.value.diagnostics
        if item.code == "capability_predicate"
    )
    assert diagnostic["resource"] == "application.json"
    assert diagnostic["pointer"] == "/spec/tasks/t1/requires/predicate"
    assert diagnostic["span"] == {"start": 0, "end": len("candidate.properties.missing")}


def test_runtime_expression_paths_are_closed_and_inferred_from_stable_properties():
    value = base_package()
    for path in ("catalog-a.json", "catalog-b.json"):
        catalog = json.loads(value.files[path])
        catalog["spec"]["candidates"]["c1"]["properties"] = {
            "region": "eu",
            "tier": 1,
        }
        value.files[path] = json.dumps(catalog).encode()
    hard = json.loads(value.files["hard.json"])
    hard["spec"]["constraints"]["typed"] = {
        "assert": "tasks.t1.properties.region == 'eu' && tasks.t1.properties.tier >= 1",
        "enforcement": "hard",
    }
    value.files["hard.json"] = json.dumps(hard).encode()
    assert compile_instance(value)

    invalid = base_package()
    hard = json.loads(invalid.files["hard.json"])
    hard["spec"]["constraints"]["opaque"] = {
        "assert": "extensions.unknown.flag == true",
        "enforcement": "hard",
    }
    invalid.files["hard.json"] = json.dumps(hard).encode()
    with pytest.raises(CompileError, match="expression path is not declared"):
        compile_instance(invalid)


@pytest.mark.parametrize(
    ("duplicate", "code", "pointer", "related_pointer"),
    [
        ("id", "resource_id_duplicate", "/spec/resources/candidateCatalog/app", "/spec/resources/application/app"),
        ("path", "resource_path_duplicate", "/spec/resources/candidateCatalog/cat-b", "/spec/resources/candidateCatalog/cat-a"),
    ],
)
def test_duplicate_instance_resources_report_the_original_related_location(
    duplicate,
    code,
    pointer,
    related_pointer,
):
    value = base_package()
    instance = json.loads(value.files["instance.json"])
    if duplicate == "id":
        instance["spec"]["resources"]["candidateCatalog"]["app"] = "catalog-a.json"
    else:
        instance["spec"]["resources"]["candidateCatalog"]["cat-b"] = "catalog-a.json"
    value.files["instance.json"] = json.dumps(instance).encode()

    with pytest.raises(CompileError) as captured:
        compile_instance(value)

    diagnostic = next(item.as_dict() for item in captured.value.diagnostics if item.code == code)
    assert diagnostic == {
        "code": code,
        "message": diagnostic["message"],
        "resource": "instance.json",
        "pointer": pointer,
        "related": [{"resource": "instance.json", "pointer": related_pointer}],
    }


def test_binding_problem_schema_closes_expression_workflow_and_placement_ir():
    problem = compile_instance(base_package())
    validator = _schema_validator("BindingProblem")
    assert validator is not None
    assert list(validator.iter_errors(problem.document)) == []

    malformed = deepcopy(problem.document)
    malformed["spec"]["constraints"][0]["assert"]["undeclared"] = True
    assert list(validator.iter_errors(malformed))

    from openbinding_gateway.v1.compiler import _schema_diagnostics

    diagnostic = _schema_diagnostics(malformed, "BindingProblem", "BindingProblem")[0]
    assert diagnostic.as_dict()["irPath"].startswith("/spec/constraints/0/assert")

    malformed = deepcopy(problem.document)
    malformed["spec"]["application"]["workflow"]["steps"][0]["branches"] = []
    assert list(validator.iter_errors(malformed))


def test_binding_must_be_complete_and_candidate_ref_eligible():
    problem = compile_instance(base_package())
    with pytest.raises(ValueError, match="missing"):
        problem.evaluate_binding({"t1": {"resource": "cat-a", "id": "c1"}})
    with pytest.raises(ValueError, match="not eligible"):
        problem.evaluate_binding({"t1": {"resource": "cat-a", "id": "missing"}, "t2": {"resource": "cat-a", "id": "c1"}})


def test_parallel_uses_declared_operator_without_hidden_max():
    workflow = {"parallel": [{"task": {"resource": "app", "id": "t1"}}, {"task": {"resource": "app", "id": "t2"}}]}
    problem = compile_instance(base_package(workflow=workflow))
    binding = {"t1": {"resource": "cat-a", "id": "c1"}, "t2": {"resource": "cat-b", "id": "c1"}}
    assert problem.evaluate_binding(binding)["latency"] == 30.0


def test_routing_weighted_product_is_geometric_and_not_a_scaled_sum():
    value = base_package(
        workflow={
            "exclusive": [
                {"id": "left", "flow": {"task": {"resource": "app", "id": "t1"}}},
                {"id": "right", "flow": {"task": {"resource": "app", "id": "t2"}}},
            ]
        }
    )
    instance = json.loads(value.files["instance.json"])
    instance["spec"]["resources"]["application"]["routes"] = "routing.json"
    value.files["instance.json"] = json.dumps(instance).encode()
    value.files["routing.json"] = json.dumps(envelope("RoutingOverlay", "routes", {
        "entries": [
            {"target": {"resource": "app", "id": "left"}, "probability": 0.25},
            {"target": {"resource": "app", "id": "right"}, "probability": 0.75},
        ]
    })).encode()
    application = json.loads(value.files["application.json"])
    application["spec"]["metrics"]["availability"] = {
        "unit": "1",
        "domain": "ratio",
        "direction": "maximize",
        "aggregation": "product",
    }
    value.files["application.json"] = json.dumps(application).encode()
    for path, amount in (("catalog-a.json", 0.9), ("catalog-b.json", 0.8)):
        catalog = json.loads(value.files[path])
        catalog["spec"]["metricBindings"]["availability"] = {"resource": "app", "id": "availability"}
        catalog["spec"]["candidates"]["c1"]["metrics"]["availability"] = amount
        value.files[path] = json.dumps(catalog).encode()
    optimization = json.loads(value.files["optimization.json"])
    optimization["spec"]["terms"] = [{"metric": {"resource": "app", "id": "availability"}, "weight": 1}]
    value.files["optimization.json"] = json.dumps(optimization).encode()
    problem = compile_instance(value)
    binding = {"t1": {"resource": "cat-a", "id": "c1"}, "t2": {"resource": "cat-b", "id": "c1"}}
    assert problem.evaluate_binding(binding)["availability"] == pytest.approx((0.9**0.25) * (0.8**0.75))


def test_fractional_product_requires_a_nonnegative_metric_domain():
    value = base_package(
        workflow={
            "exclusive": [
                {"id": "left", "flow": {"task": {"resource": "app", "id": "t1"}}},
                {"id": "right", "flow": {"task": {"resource": "app", "id": "t2"}}},
            ]
        }
    )
    instance = json.loads(value.files["instance.json"])
    instance["spec"]["resources"]["application"]["routes"] = "routing.json"
    value.files["instance.json"] = json.dumps(instance).encode()
    value.files["routing.json"] = json.dumps(envelope("RoutingOverlay", "routes", {
        "entries": [
            {"target": {"resource": "app", "id": "left"}, "probability": 0.5},
            {"target": {"resource": "app", "id": "right"}, "probability": 0.5},
        ]
    })).encode()
    application = json.loads(value.files["application.json"])
    application["spec"]["metrics"]["signed"] = {
        "unit": "1",
        "domain": {"kind": "real", "minimum": -1, "maximum": 1},
        "direction": "maximize",
        "aggregation": "product",
    }
    value.files["application.json"] = json.dumps(application).encode()
    for path, amount in (("catalog-a.json", -0.9), ("catalog-b.json", 0.8)):
        catalog = json.loads(value.files[path])
        catalog["spec"]["metricBindings"]["signed"] = {"resource": "app", "id": "signed"}
        catalog["spec"]["candidates"]["c1"]["metrics"]["signed"] = amount
        value.files[path] = json.dumps(catalog).encode()
    optimization = json.loads(value.files["optimization.json"])
    optimization["spec"]["terms"] = [{"metric": {"resource": "app", "id": "signed"}}]
    value.files["optimization.json"] = json.dumps(optimization).encode()
    with pytest.raises(CompileError, match="non-negative domain"):
        compile_instance(value)


def test_metric_neutral_is_used_for_local_activities():
    value = base_package()
    application = json.loads(value.files["application.json"])
    application["spec"]["metrics"]["quality"] = {
        "unit": "score",
        "domain": {"kind": "real", "minimum": 0, "maximum": 100},
        "direction": "maximize",
        "aggregation": "min",
    }
    value.files["application.json"] = json.dumps(application).encode()
    for path, amount in (("catalog-a.json", 80), ("catalog-b.json", 70)):
        catalog = json.loads(value.files[path])
        catalog["spec"]["metricBindings"]["quality"] = {"resource": "app", "id": "quality"}
        catalog["spec"]["candidates"]["c1"]["metrics"]["quality"] = amount
        value.files[path] = json.dumps(catalog).encode()
    optimization = json.loads(value.files["optimization.json"])
    optimization["spec"]["terms"] = [{"metric": {"resource": "app", "id": "quality"}}]
    value.files["optimization.json"] = json.dumps(optimization).encode()
    problem = compile_instance(value)
    binding = {"t1": {"resource": "cat-a", "id": "c1"}, "t2": {"resource": "cat-a", "id": "c1"}}
    assert problem.evaluate_binding(binding)["quality"] == 80


def test_objective_normalization_clamp_and_maximize_loss_are_explicit():
    value = base_package()
    optimization = json.loads(value.files["optimization.json"])
    optimization["spec"]["terms"] = [{
        "metric": {"resource": "app", "id": "latency"},
        "direction": "maximize",
        "normalize": {"min": 0, "max": 20, "clamp": True},
    }]
    optimization["spec"]["penalties"] = [{"constraint": {"resource": "soft", "id": "limit"}}]
    value.files["optimization.json"] = json.dumps(optimization).encode()
    problem = compile_instance(value)
    component = problem.evaluate_objectives({"latency": 30}, [])["components"][0]
    assert component["loss"] == 0
    assert problem.document["spec"]["optimization"]["terms"][0]["normalize"]["clamp"] is True

    unclamped = deepcopy(value)
    document = json.loads(unclamped.files["optimization.json"])
    document["spec"]["terms"][0]["normalize"]["clamp"] = False
    unclamped.files["optimization.json"] = json.dumps(document).encode()
    component = compile_instance(unclamped).evaluate_objectives({"latency": 30}, [])["components"][0]
    assert component["loss"] == -0.5


def test_constraints_have_no_hidden_comparison_epsilon():
    value = base_package()
    hard = json.loads(value.files["hard.json"])
    hard["spec"]["constraints"]["limit"]["assert"] = "metrics.latency <= 29.9999999"
    value.files["hard.json"] = json.dumps(hard).encode()
    problem = compile_instance(value)
    binding = {"t1": {"resource": "cat-a", "id": "c1"}, "t2": {"resource": "cat-a", "id": "c1"}}
    violations = problem.evaluate_constraints(binding)
    assert violations == [{
        "constraint": {"resource": "hard", "id": "limit"},
        "enforcement": "hard",
        "penalty": 0.0,
    }]


def test_constraint_diagnostics_preserve_the_exact_cel_error_span():
    value = base_package()
    hard = json.loads(value.files["hard.json"])
    source = "  metrics.latency <= && 100  "
    hard["spec"]["constraints"]["limit"]["assert"] = source
    value.files["hard.json"] = json.dumps(hard).encode()

    with pytest.raises(CompileError) as captured:
        compile_instance(value)

    diagnostic = next(item for item in captured.value.diagnostics if item.code == "expression")
    start = source.index("&&")
    assert diagnostic.span == {"start": start, "end": start + 2}


def test_cel_and_json_ast_share_ir_and_roots_are_typed():
    kwargs = {"allowed_roots": {"metrics": "object"}, "path_types": {"metrics.latency": "number"}, "expected_type": "bool"}
    cel = compile_expression("metrics.latency <= 50", **kwargs)
    tree = compile_expression({"op": "lte", "left": {"path": "metrics.latency"}, "right": 50}, **kwargs)
    assert cel.ast == tree.ast
    assert cel.span == {"start": 0, "end": 21}
    with pytest.raises(ExpressionError, match="root is not allowed"):
        compile_expression("secrets.token == 'x'", **kwargs)
    with pytest.raises(ExpressionError, match="exactly left and right"):
        compile_expression({"op": "and"}, allowed_roots={"metrics": "object"})
    assert compile_expression("'true && false' == 'true && false'", expected_type="bool").evaluate({})


def test_expression_segments_preserve_dotted_ids_and_comparison_types_are_strict():
    kwargs = {
        "allowed_roots": {"metrics": "closed-object", "tasks": "closed-object"},
        "path_types": {
            ("metrics", "response.time"): "number",
            ("tasks", "checkout.v2", "properties", "region"): "string",
        },
    }
    cel = compile_expression("metrics['response.time'] <= 50", expected_type="bool", **kwargs)
    tree = compile_expression(
        {"op": "lte", "left": {"path": ["metrics", "response.time"]}, "right": 50},
        expected_type="bool",
        **kwargs,
    )
    assert cel.ast == tree.ast
    assert cel.ast["left"] == {"kind": "path", "segments": ["metrics", "response.time"]}
    assert cel.evaluate({"metrics": {"response.time": 40}}) is True
    assert compile_expression(
        "tasks['checkout.v2'].properties.region < 'm'",
        expected_type="bool",
        **kwargs,
    ).evaluate({"tasks": {"checkout.v2": {"properties": {"region": "eu"}}}}) is True
    with pytest.raises(ExpressionError, match="incompatible types"):
        compile_expression({"op": "eq", "left": True, "right": 1}, expected_type="bool")
    with pytest.raises(ExpressionError, match="ordered comparison"):
        compile_expression({"op": "lt", "left": True, "right": 1}, expected_type="bool")
    with pytest.raises(ExpressionError, match="incompatible runtime types"):
        compile_expression(
            {"op": "eq", "left": {"path": ["extensions", "value"]}, "right": 1},
            allowed_roots={"extensions": "object"},
            expected_type="bool",
        ).evaluate({"extensions": {"value": True}})


def test_installed_profiles_and_dialects_form_a_closed_extensible_framework():
    assert installed_framework_diagnostics() == ()
    for profile in installed_profile_manifests():
        assert list(_schema_validator("Profile").iter_errors(profile)) == []
    for dialect in installed_dialect_manifests():
        assert list(_schema_validator("Dialect").iter_errors(dialect)) == []

    instance_validator = _schema_validator("Instance")
    generic_instance = {
        "apiVersion": "bim/v1",
        "kind": "Instance",
        "metadata": {"name": "future-profile"},
        "spec": {
            "profile": "scheduling/v1",
            "resources": {"jobs": {"workload": "jobs.json"}},
        },
    }
    assert list(instance_validator.iter_errors(generic_instance)) == []
    with pytest.raises(CompileError, match="has no installed"):
        compile_instance(InstancePackage({"instance.json": json.dumps(generic_instance).encode()}))

    extension_only = {
        "apiVersion": "bim/v1",
        "kind": "Dialect",
        "metadata": {"namespace": "research.example", "name": "uncertain-qos", "version": "1.0.0"},
        "spec": {
            "compatibleProfiles": ["qos-binding/v1"],
            "resourceTypes": [],
            "extensionPoints": [{
                "target": {"apiVersion": "qos-binding/v1", "kind": "CandidateCatalog"},
                "pointer": "/spec/candidates",
                "schemaDigest": "sha256-" + "a" * 64,
            }],
            "irFeatures": [{"dimension": "irExtensions", "value": "uncertain-qos/v1"}],
            "adapter": {"id": "uncertain-qos", "version": "1.0.0", "binaryDigest": "sha256-" + "b" * 64},
        },
    }
    assert list(_schema_validator("Dialect").iter_errors(extension_only)) == []


def test_profile_adapter_pins_cannot_replace_or_uninstall_the_builtin_abi():
    relabelled = deepcopy(installed_profile_manifests()[0])
    relabelled["metadata"] = {
        **relabelled["metadata"],
        "namespace": "research.example",
        "name": "other-profile",
    }
    with pytest.raises(ValueError, match="adapter descriptor is already installed"):
        install_profile_contract(relabelled, lambda *_args: None)

    # Uninstall is an exact-revision operation; a manifest that was never
    # installed cannot remove the deployed adapter named in its descriptor.
    uninstall_profile_contract(relabelled)
    assert compile_instance(base_package()).document["spec"]["profile"]["id"] == "qos-binding/v1"


def test_profile_adapter_receives_core_resolved_input_and_must_return_pinned_output():
    output_schema = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "required": ["apiVersion", "kind", "metadata", "spec"],
        "properties": {
            "apiVersion": {"const": "audit.example/v1"},
            "kind": {"const": "AuditProblem"},
            "metadata": {
                "type": "object",
                "required": ["name"],
                "properties": {"name": {"type": "string", "minLength": 1}},
                "additionalProperties": False,
            },
            "spec": {
                "type": "object",
                "required": ["inputs"],
                "properties": {
                    "inputs": {"type": "array", "items": {"type": "string"}},
                    "nonce": {"type": "integer"},
                },
                "additionalProperties": False,
            },
        },
        "additionalProperties": False,
    }
    input_schema = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "required": ["apiVersion", "kind", "metadata", "spec"],
        "properties": {
            "apiVersion": {"const": "audit.example/input/v1"},
            "kind": {"const": "AuditInput"},
            "metadata": {
                "type": "object",
                "required": ["name"],
                "properties": {"name": {"type": "string"}},
                "additionalProperties": False,
            },
            "spec": {
                "type": "object",
                "required": ["value"],
                "properties": {"value": {"type": "string"}},
                "additionalProperties": False,
            },
        },
        "additionalProperties": False,
    }
    profile = {
        "apiVersion": "bim/v1",
        "kind": "Profile",
        "metadata": {
            "namespace": "audit.example",
            "name": "audit-profile",
            "version": "1.0.0",
        },
        "spec": {
            "deterministic": True,
            "roles": {
                "terms": {
                    "resourceTypes": [{
                        "apiVersion": "audit.example/input/v1",
                        "kind": "AuditInput",
                        "minimum": 1,
                        "maximum": 1,
                    }],
                    "extensionTypes": "none",
                }
            },
            "output": {
                "apiVersion": "audit.example/v1",
                "kind": "AuditProblem",
                "schemaDigest": digest(output_schema),
                "engineProtocol": "audit-engine/v1",
            },
            "capabilityVocabulary": {
                "dimensions": {
                    "terms": {"values": ["input"], "openValues": False}
                }
            },
            "limitVocabulary": [],
            "adapter": {
                "id": "audit-profile",
                "version": "1.0.0",
                "binaryDigest": "sha256-" + "1" * 64,
            },
        },
    }
    identity = ("audit.example/input/v1", "AuditInput", "application/json")
    dialect = {
        "apiVersion": "bim/v1",
        "kind": "Dialect",
        "metadata": {
            "namespace": "audit.example",
            "name": "audit-input",
            "version": "1.0.0",
        },
        "spec": {
            "compatibleProfiles": ["audit-profile/v1"],
            "resourceTypes": [{
                "apiVersion": identity[0],
                "kind": identity[1],
                "roles": ["terms"],
                "mediaType": identity[2],
                "schemaDigest": digest(input_schema),
            }],
            "extensionPoints": [],
            "irFeatures": [],
            "adapter": {
                "id": "audit-input",
                "version": "1.0.0",
                "binaryDigest": "sha256-" + "2" * 64,
            },
        },
    }
    adapter_calls: list[str] = []
    nondeterministic_nonce = 0

    def adapter(resolved):
        nonlocal nondeterministic_nonce
        assert isinstance(resolved, ResolvedInstance)
        name = resolved.instance["metadata"]["name"]
        adapter_calls.append(name)
        if name == "wrong-type":
            return "not-a-compiled-problem"
        document = {
            "apiVersion": "audit.example/v1",
            "kind": "AuditProblem",
            "metadata": {"name": name},
            "spec": {"inputs": sorted(resolved.resources)},
        }
        if name == "nondeterministic":
            nondeterministic_nonce += 1
            document["spec"]["nonce"] = nondeterministic_nonce
        return CompiledProblem(
            document=document,
            digest=digest(document),
            source_map={
                "/": {"resource": "instance", "path": "instance.json", "pointer": "/"}
            },
        )

    def audit_package(name, *, include_input=True):
        root = {
            "apiVersion": "bim/v1",
            "kind": "Instance",
            "metadata": {"name": name},
            "spec": {
                "profile": "audit-profile/v1",
                "resources": {"terms": {"input": "input.json"}},
            },
        }
        files = {"instance.json": json.dumps(root).encode()}
        if include_input:
            files["input.json"] = json.dumps({
                "apiVersion": identity[0],
                "kind": identity[1],
                "metadata": {"name": "input"},
                "spec": {"value": "ok"},
            }).encode()
        return InstancePackage(files)

    install_profile_contract(profile, adapter, output_schema=output_schema)
    install_dialect_contract(
        dialect,
        resource_schemas={identity: input_schema},
        resource_lowerers={identity: lambda document, _context: document["spec"]},
    )
    try:
        compiled = compile_instance(audit_package("valid"))
        assert compiled.document["spec"]["inputs"] == ["input"]
        assert adapter_calls == ["valid", "valid"]

        with pytest.raises(CompileError, match="profile role 'terms' requires 1 resources"):
            compile_instance(audit_package("missing", include_input=False))
        assert adapter_calls == ["valid", "valid"]

        with pytest.raises(CompileError, match="must return CompiledProblem"):
            compile_instance(audit_package("wrong-type"))

        with pytest.raises(CompileError, match="different canonical outputs"):
            compile_instance(audit_package("nondeterministic"))
    finally:
        uninstall_dialect_contract(dialect)
        uninstall_profile_contract(profile)


def test_schema_root_prefers_the_deployment_configuration(monkeypatch, tmp_path):
    monkeypatch.setenv("SCHEMAS_DIR", str(tmp_path))
    assert _schema_root() == tmp_path / "bim" / "v1"


def test_inline_extension_validator_is_installed_by_exact_schema_digest():
    schema = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "required": ["confidence"],
        "properties": {"confidence": {"type": "number", "minimum": 0, "maximum": 1}},
        "additionalProperties": False,
    }
    dialect = {
        "apiVersion": "bim/v1",
        "kind": "Dialect",
        "metadata": {"namespace": "research.example", "name": "confidence", "version": "1.0.0"},
        "spec": {
            "compatibleProfiles": ["qos-binding/v1"],
            "resourceTypes": [],
            "extensionPoints": [{
                "target": {"apiVersion": "qos-binding/v1", "kind": "CandidateCatalog"},
                "pointer": "/spec",
                "schemaDigest": digest(schema),
            }],
            "irFeatures": [{"dimension": "irExtensions", "value": "confidence/v1"}],
            "adapter": {
                "id": "confidence",
                "version": "1.0.0",
                "binaryDigest": "sha256-" + "b" * 64,
            },
        },
    }
    identity = ("qos-binding/v1", "CandidateCatalog", "/spec")
    with pytest.raises(ValueError, match="missing deployed lowering"):
        install_dialect_contract(
            dialect,
            extension_schemas={identity: schema},
        )

    def lower(payload, context):
        return {
            "confidenceBasisPoints": payload["confidence"] * 10_000,
            "target": context["target"]["kind"],
        }

    install_dialect_contract(
        dialect,
        extension_schemas={identity: schema},
        extension_lowerers={identity: lower},
    )
    try:
        value = base_package()
        catalog = json.loads(value.files["catalog-a.json"])
        catalog["spec"]["extensions"] = {"confidence/v1": {"confidence": 0.9}}
        value.files["catalog-a.json"] = json.dumps(catalog).encode()
        compiled = compile_instance(value)
        assert compiled.document["spec"]["extensions"]["confidence/v1"] == {
            "inline": {
                "cat-a:/spec": {
                    "confidenceBasisPoints": 9_000,
                    "target": "CandidateCatalog",
                }
            }
        }
        assert compiled.document["spec"]["sourceMap"][
            "/spec/extensions/confidence~1v1/inline/cat-a:~1spec"
        ]["pointer"] == "/spec/extensions/confidence~1v1"

        catalog["spec"]["extensions"]["confidence/v1"]["confidence"] = 2
        value.files["catalog-a.json"] = json.dumps(catalog).encode()
        with pytest.raises(CompileError, match="maximum of 1"):
            compile_instance(value)
    finally:
        uninstall_dialect_contract(dialect)


def _resource_dialect_fixture(name="carbon-budget"):
    schema = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "required": ["apiVersion", "kind", "metadata", "spec"],
        "properties": {
            "apiVersion": {"const": "research.example/carbon/v1"},
            "kind": {"const": "CarbonBudget"},
            "metadata": {
                "type": "object",
                "required": ["name"],
                "properties": {"name": {"type": "string", "minLength": 1}},
                "additionalProperties": False,
            },
            "spec": {
                "type": "object",
                "required": ["maximumKg"],
                "properties": {"maximumKg": {"type": "number", "minimum": 0}},
                "additionalProperties": False,
            },
        },
        "additionalProperties": False,
    }
    identity = ("research.example/carbon/v1", "CarbonBudget", "application/json")
    dialect = {
        "apiVersion": "bim/v1",
        "kind": "Dialect",
        "metadata": {"namespace": "research.example", "name": name, "version": "1.0.0"},
        "spec": {
            "compatibleProfiles": ["qos-binding/v1"],
            "resourceTypes": [{
                "apiVersion": identity[0],
                "kind": identity[1],
                "roles": ["application"],
                "mediaType": identity[2],
                "schemaDigest": digest(schema),
            }],
            "extensionPoints": [],
            "irFeatures": [{"dimension": "irExtensions", "value": f"{name}/v1"}],
            "adapter": {
                "id": name,
                "version": "1.0.0",
                "binaryDigest": "sha256-" + "c" * 64,
            },
        },
    }
    return schema, identity, dialect


def _package_with_external_resource():
    value = base_package()
    instance = json.loads(value.files["instance.json"])
    instance["spec"]["resources"]["application"]["carbon"] = "carbon.json"
    value.files["instance.json"] = json.dumps(instance).encode()
    value.files["carbon.json"] = json.dumps({
        "apiVersion": "research.example/carbon/v1",
        "kind": "CarbonBudget",
        "metadata": {"name": "carbon"},
        "spec": {"maximumKg": 42},
    }).encode()
    return value


def test_installed_resource_dialect_lowers_to_pinned_canonical_ir_extension():
    schema, identity, dialect = _resource_dialect_fixture()

    def lower(document, context):
        return {
            "limitKg": document["spec"]["maximumKg"],
            "role": context["resource"]["role"],
        }

    install_dialect_contract(
        dialect,
        resource_schemas={identity: schema},
        resource_lowerers={identity: lower},
    )
    try:
        first = compile_instance(_package_with_external_resource())
        second = compile_instance(_package_with_external_resource())
        assert first.digest == second.digest
        assert first.document["spec"]["extensions"]["carbon-budget/v1"] == {
            "resources": {"carbon": {"limitKg": 42, "role": "application"}}
        }
        assert first.document["spec"]["sourceMap"][
            "/spec/extensions/carbon-budget~1v1/resources/carbon"
        ]["path"] == "carbon.json"
        descriptor = next(
            item for item in first.document["spec"]["dialects"]
            if item["id"] == "carbon-budget/v1"
        )
        assert descriptor["irFeatures"] == [
            {"dimension": "irExtensions", "value": "carbon-budget/v1"}
        ]
    finally:
        uninstall_dialect_contract(dialect)


def test_resource_dialect_cannot_be_installed_or_compiled_without_valid_lowering():
    schema, identity, dialect = _resource_dialect_fixture("carbon-invalid")
    dialect["spec"]["irFeatures"][0]["value"] = "carbon-invalid/v1"
    dialect["spec"]["adapter"]["id"] = "carbon-invalid"
    with pytest.raises(ValueError, match="missing deployed lowering"):
        install_dialect_contract(dialect, resource_schemas={identity: schema})

    install_dialect_contract(
        dialect,
        resource_schemas={identity: schema},
        resource_lowerers={identity: lambda _document, _context: []},
    )
    try:
        with pytest.raises(CompileError, match="lowering must return a JSON object"):
            compile_instance(_package_with_external_resource())
    finally:
        uninstall_dialect_contract(dialect)


def test_constraints_use_declared_service_paths_and_when_short_circuits():
    value = base_package()
    hard = json.loads(value.files["hard.json"])
    hard["spec"]["constraints"]["limit"] = {
        "when": False,
        "assert": "1 / 0 > 0",
        "enforcement": "hard",
    }
    value.files["hard.json"] = json.dumps(hard).encode()
    problem = compile_instance(value)
    binding = {"t1": {"resource": "cat-a", "id": "c1"}, "t2": {"resource": "cat-b", "id": "c1"}}
    assert problem.evaluate_constraints(binding) == []

    invalid = base_package()
    hard = json.loads(invalid.files["hard.json"])
    hard["spec"]["constraints"]["limit"]["assert"] = "tasks.local.provider == ''"
    invalid.files["hard.json"] = json.dumps(hard).encode()
    with pytest.raises(CompileError, match="path is not declared"):
        compile_instance(invalid)


def test_optional_provider_is_absent_for_has_and_guarded_access():
    value = base_package()
    catalog = json.loads(value.files["catalog-a.json"])
    catalog["spec"]["candidates"]["c1"].pop("provider")
    value.files["catalog-a.json"] = json.dumps(catalog).encode()
    hard = json.loads(value.files["hard.json"])
    hard["spec"]["constraints"]["limit"]["assert"] = (
        "!has(tasks.t1.provider) || tasks.t1.provider.resource == 'cat-a'"
    )
    value.files["hard.json"] = json.dumps(hard).encode()

    problem = compile_instance(value)
    binding = {
        "t1": {"resource": "cat-a", "id": "c1"},
        "t2": {"resource": "cat-b", "id": "c1"},
    }
    violations = problem.evaluate_constraints(binding)
    assert [item["constraint"] for item in violations] == [
        {"resource": "soft", "id": "limit"}
    ]


def test_instance_digest_changes_when_a_resource_changes():
    first = compile_instance(base_package())
    changed = base_package()
    application = json.loads(changed.files["application.json"])
    application["metadata"]["description"] = "changed"
    changed.files["application.json"] = json.dumps(application).encode()
    second = compile_instance(changed)
    assert first.document["spec"]["instance"]["digest"] != second.document["spec"]["instance"]["digest"]


def test_registered_resources_are_exact_digest_pinned_and_source_free_in_ir():
    value = base_package()
    instance = json.loads(value.files["instance.json"])
    optimization = json.loads(value.files.pop("optimization.json"))
    optimization["metadata"]["name"] = "shared-optimization"
    optimization["metadata"]["version"] = "1.2.3"
    content = json.dumps(optimization).encode()
    pinned = resource_digest("registered.json", content)
    reference = {
        "namespace": "research.example",
        "name": "shared-optimization",
        "version": "1.2.3",
        "digest": pinned,
    }
    instance["spec"]["resources"]["optimization"]["opt"] = reference
    value.files["instance.json"] = json.dumps(instance).encode()
    registry = {
        ("research.example", "shared-optimization", "1.2.3", pinned):
            RegisteredResource(content, "application/json")
    }
    problem = compile_instance(value, registry)
    identity = problem.document["spec"]["instance"]["resources"]["opt"]
    assert identity == {
        "role": "optimization",
        "apiVersion": "qos-binding/v1",
        "kind": "Optimization",
        "registered": reference,
        "digest": pinned,
    }
    assert "shared-optimization" not in json.dumps(problem.document["spec"]["optimization"])

    with pytest.raises(CompileError, match="not installed, approved"):
        compile_instance(value)
    wrong = dict(registry)
    wrong[("research.example", "shared-optimization", "1.2.3", pinned)] = RegisteredResource(
        content.replace(b"weighted", b"pareto"), "application/json"
    )
    with pytest.raises(CompileError, match="not pinned"):
        compile_instance(value, wrong)


def test_only_semantically_used_metrics_are_required():
    value = base_package()
    optimization = json.loads(value.files["optimization.json"])
    optimization["spec"]["terms"] = [
        {"metric": {"resource": "app", "id": "latency"}, "weight": 1}
    ]
    value.files["optimization.json"] = json.dumps(optimization).encode()
    catalog = json.loads(value.files["catalog-b.json"])
    catalog["spec"]["candidates"]["c1"]["metrics"].pop("cost")
    value.files["catalog-b.json"] = json.dumps(catalog).encode()
    problem = compile_instance(value)
    assert problem.document["spec"]["application"]["requiredMetrics"] == ["latency"]
    binding = {"t1": {"resource": "cat-a", "id": "c1"}, "t2": {"resource": "cat-b", "id": "c1"}}
    assert problem.evaluate_binding(binding) == {"latency": 50.0}


def test_task_metric_requirements_are_scoped_and_dynamic_penalties_are_checked():
    value = base_package()
    application = json.loads(value.files["application.json"])
    application["spec"]["tasks"]["t1"] = "svc/a"
    application["spec"]["tasks"]["t2"] = "svc/b"
    value.files["application.json"] = json.dumps(application).encode()
    catalog_a = json.loads(value.files["catalog-a.json"])
    catalog_a["spec"]["candidates"]["c1"]["provides"] = "svc/a"
    value.files["catalog-a.json"] = json.dumps(catalog_a).encode()
    catalog_b = json.loads(value.files["catalog-b.json"])
    catalog_b["spec"]["candidates"]["c1"]["provides"] = "svc/b"
    catalog_b["spec"]["candidates"]["c1"]["metrics"].pop("cost")
    value.files["catalog-b.json"] = json.dumps(catalog_b).encode()
    hard = json.loads(value.files["hard.json"])
    hard["spec"]["constraints"]["limit"]["assert"] = "tasks.t1.metrics.cost <= 10"
    value.files["hard.json"] = json.dumps(hard).encode()
    soft = json.loads(value.files["soft.json"])
    soft["spec"]["constraints"] = {}
    value.files["soft.json"] = json.dumps(soft).encode()
    optimization = json.loads(value.files["optimization.json"])
    optimization["spec"] = {"mode": "satisfy"}
    value.files["optimization.json"] = json.dumps(optimization).encode()
    problem = compile_instance(value)
    assert problem.document["spec"]["application"]["requiredMetrics"] == []
    assert problem.document["spec"]["application"]["taskRequiredMetrics"] == {"t1": ["cost"]}

    dynamic = base_package()
    soft = json.loads(dynamic.files["soft.json"])
    soft["spec"]["constraints"]["limit"]["assert"] = False
    soft["spec"]["constraints"]["limit"]["penalty"] = "tasks.t1.metrics.latency - 20"
    dynamic.files["soft.json"] = json.dumps(soft).encode()
    checked = compile_instance(dynamic)
    binding = {"t1": {"resource": "cat-a", "id": "c1"}, "t2": {"resource": "cat-b", "id": "c1"}}
    with pytest.raises(ValueError, match="invalid penalty"):
        checked.evaluate(binding)


def test_placement_is_cross_referenced_and_groups_expand():
    placement = envelope(
        "Placement",
        "place",
        {
            "pools": {"edge": {"kind": "EDGE", "capacity": {"memory": 8}}},
            "groups": {
                "svc": {
                    "pool": {"resource": "place", "id": "edge"},
                    "capability": "svc/v1",
                    "resources": {"memory": 2},
                }
            },
            "network": [{
                "from": {"resource": "place", "id": "edge"},
                "to": {"resource": "place", "id": "edge"},
                "latency": 0,
            }],
            "events": {"user": {
                "pool": {"resource": "place", "id": "edge"},
                "latency": [{"pool": {"resource": "place", "id": "edge"}, "latency": 1}],
            }},
            "transitions": {
                "login": {
                    "from": {"resource": "place", "id": "user"},
                    "to": {"resource": "app", "id": "t1"},
                    "metric": {"resource": "app", "id": "latency"},
                    "maximum": 10,
                }
            },
            "capacityRules": [{"resources": ["memory"], "scope": "selectedCandidate"}],
            "globalLatency": {
                "metric": {"resource": "app", "id": "latency"},
                "includeExecution": True,
                "exclusive": "routing",
                "parallel": "max",
            },
        },
    )
    problem = compile_instance(base_package(placement=placement))
    lowered = problem.document["spec"]["placement"][0]
    assert len(lowered["demands"]) == 2
    assert lowered["transitions"][0]["from"] == {"resource": "place", "id": "user"}
    assert lowered["capacityRules"][0]["ref"] == {
        "resource": "place",
        "id": "capacityRules/0",
    }
    binding = {
        "t1": {"resource": "cat-a", "id": "c1"},
        "t2": {"resource": "cat-b", "id": "c1"},
    }
    evaluation = problem.evaluate(binding)
    # Event transfer (1) + t1 execution (10) + expected two t2 executions (40).
    assert evaluation["metrics"]["latency"] == 51
    assert evaluation["violations"] == []
    broken = deepcopy(placement)
    broken["spec"]["groups"]["svc"]["pool"]["id"] = "missing"
    with pytest.raises(CompileError, match="unknown pool"):
        compile_instance(base_package(placement=broken))


def test_placement_rejects_non_executable_workflow_expansion_limits():
    placement = envelope(
        "Placement",
        "place",
        {
            "pools": {"edge": {"capacity": {}}},
            "groups": {
                "all": {
                    "pool": {"resource": "place", "id": "edge"},
                    "capability": "svc/v1",
                    "resources": {},
                }
            },
            "globalLatency": {
                "metric": {"resource": "app", "id": "latency"},
                "includeExecution": True,
                "exclusive": "routing",
                "parallel": "max",
            },
        },
    )
    too_many_repeats = base_package(
        workflow={
            "repeat": {
                "body": {"task": {"resource": "app", "id": "t1"}},
                "count": 10001,
            }
        },
        placement=placement,
    )
    with pytest.raises(CompileError, match="exact repeat count exceeds 10000"):
        compile_instance(too_many_repeats)

    variants = base_package(
        workflow={
            "repeat": {
                "body": {
                    "exclusive": [
                        {"id": "left", "flow": {"task": {"resource": "app", "id": "t1"}}},
                        {"id": "right", "flow": {"task": {"resource": "app", "id": "t2"}}},
                    ]
                },
                "count": 13,
            }
        },
        placement=placement,
    )
    instance = json.loads(variants.files["instance.json"])
    instance["spec"]["resources"]["application"]["routes"] = "routing.json"
    variants.files["instance.json"] = json.dumps(instance).encode()
    variants.files["routing.json"] = json.dumps(envelope("RoutingOverlay", "routes", {
        "entries": [
            {"target": {"resource": "app", "id": "left"}, "probability": 0.5},
            {"target": {"resource": "app", "id": "right"}, "probability": 0.5},
        ]
    })).encode()
    with pytest.raises(CompileError, match="more than 4096 deterministic routing variants"):
        compile_instance(variants)


def test_placement_membership_is_fail_closed_per_model():
    def placement(resource, catalog, *, global_latency=False, transition=False):
        spec = {
            "pools": {"edge": {"capacity": {}}},
            "demands": [{
                "candidate": {"resource": catalog, "id": "c1"},
                "pool": {"resource": resource, "id": "edge"},
                "resources": {},
            }],
        }
        if global_latency:
            spec["globalLatency"] = {
                "metric": {"resource": "app", "id": "latency"},
                "includeExecution": True,
                "exclusive": "routing",
                "parallel": "max",
            }
        if transition:
            spec["transitions"] = {"hop": {
                "from": {"resource": "app", "id": "t1"},
                "to": {"resource": "app", "id": "t2"},
                "metric": {"resource": "app", "id": "latency"},
                "maximum": 10,
            }}
        return envelope("Placement", resource, spec)

    for feature in ("global", "transition"):
        value = base_package()
        instance = json.loads(value.files["instance.json"])
        instance["spec"]["resources"]["application"].update({
            "place-a": "place-a.json",
            "place-b": "place-b.json",
        })
        value.files["instance.json"] = json.dumps(instance).encode()
        value.files["place-a.json"] = json.dumps(placement(
            "place-a", "cat-a",
            global_latency=feature == "global",
            transition=feature == "transition",
        )).encode()
        value.files["place-b.json"] = json.dumps(placement("place-b", "cat-b")).encode()
        with pytest.raises(CompileError, match="not assigned in .*placement 'place-a'"):
            compile_instance(value)


def test_placement_capacity_scope_and_soft_transition_penalty_are_authoritative():
    placement = envelope(
        "Placement",
        "place",
        {
            "pools": {"edge": {"capacity": {"memory": 5}}},
            "groups": {
                "svc": {
                    "pool": {"resource": "place", "id": "edge"},
                    "capability": "svc/v1",
                    "resources": {"memory": 2},
                }
            },
            "transitions": {
                "slow": {
                    "from": {"resource": "app", "id": "t1"},
                    "to": {"resource": "app", "id": "t2"},
                    "metric": {"resource": "app", "id": "latency"},
                    "maximum": 0,
                    "enforcement": "soft",
                    "penalty": 7,
                }
            },
            "capacityRules": [{"resources": ["memory"], "scope": "invocation"}],
        },
    )
    value = base_package(placement=placement)
    optimization = json.loads(value.files["optimization.json"])
    optimization["spec"]["penalties"].append({
        "constraint": {"resource": "place", "id": "slow"},
        "weight": 1,
    })
    value.files["optimization.json"] = json.dumps(optimization).encode()
    problem = compile_instance(value)
    binding = {
        "t1": {"resource": "cat-a", "id": "c1"},
        "t2": {"resource": "cat-b", "id": "c1"},
    }
    violations = problem.evaluate(binding)["violations"]
    assert {tuple(item["constraint"].values()) for item in violations} == {
        ("place", "capacityRules/0"),
    }

    # A non-zero explicit directed link makes the soft transition visible too.
    document = json.loads(value.files["placement.json"])
    document["spec"]["network"] = [{
        "from": {"resource": "place", "id": "edge"},
        "to": {"resource": "place", "id": "edge"},
        "latency": 1,
    }]
    value.files["placement.json"] = json.dumps(document).encode()
    evaluated = compile_instance(value).evaluate(binding)
    by_ref = {tuple(item["constraint"].values()): item for item in evaluated["violations"]}
    assert by_ref[("place", "slow")]["penalty"] == 7
    assert evaluated["objectives"]["penalty"] > 0

    inert = base_package(placement=placement)
    with pytest.raises(CompileError, match="not in Optimization"):
        compile_instance(inert)


def test_unknown_nested_extension_blocks_compilation():
    value = base_package()
    application = json.loads(value.files["application.json"])
    application["spec"]["workflow"]["extensions"] = {"unknown/v1": {"x": 1}}
    value.files["application.json"] = json.dumps(application).encode()
    with pytest.raises(CompileError, match="not installed"):
        compile_instance(value)


def bpmn_package(*, conditions=False, routing=True, loop=False, gateway="exclusiveGateway"):
    value = base_package()
    instance = json.loads(value.files["instance.json"])
    instance["spec"]["resources"]["application"]["flow"] = "workflow.bpmn"
    if routing:
        instance["spec"]["resources"]["application"]["routes"] = "routing.json"
        value.files["routing.json"] = json.dumps(envelope("RoutingOverlay", "routes", {
            "entries": [
                {"target": {"resource": "flow", "id": "f-left"}, "probability": 0.25},
                {"target": {"resource": "flow", "id": "f-right"}, "probability": 0.75},
            ]
        })).encode()
    application = json.loads(value.files["application.json"])
    application["spec"]["workflow"] = {"bpmn": {"resource": "flow", "id": "p"}}
    value.files["application.json"] = json.dumps(application).encode()
    value.files["instance.json"] = json.dumps(instance).encode()
    left_condition = "<conditionExpression>tasks.t1.provider.resource == 'cat-a'</conditionExpression>" if conditions else ""
    right_condition = "<conditionExpression>tasks.t1.provider.resource != 'cat-a'</conditionExpression>" if conditions else ""
    loop_xml = '<multiInstanceLoopCharacteristics isSequential="true"><loopCardinality>2</loopCardinality></multiInstanceLoopCharacteristics>' if loop else ""
    if loop:
        body = f"""
          <startEvent id="start"/><task id="t1">{loop_xml}</task><endEvent id="end"/>
          <sequenceFlow id="f-start" sourceRef="start" targetRef="t1"/>
          <sequenceFlow id="f-end" sourceRef="t1" targetRef="end"/>
        """
    else:
        body = f"""
          <startEvent id="start"/><{gateway} id="split"/><task id="t1"/><task id="t2"/>
          <{gateway} id="join"/><endEvent id="end"/>
          <sequenceFlow id="f-start" sourceRef="start" targetRef="split"/>
          <sequenceFlow id="f-left" sourceRef="split" targetRef="t1">{left_condition}</sequenceFlow>
          <sequenceFlow id="f-right" sourceRef="split" targetRef="t2">{right_condition}</sequenceFlow>
          <sequenceFlow id="f-ljoin" sourceRef="t1" targetRef="join"/>
          <sequenceFlow id="f-rjoin" sourceRef="t2" targetRef="join"/>
          <sequenceFlow id="f-end" sourceRef="join" targetRef="end"/>
        """
    value.files["workflow.bpmn"] = f"""<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" id="d" targetNamespace="urn:test"><process id="p">{body}</process></definitions>""".encode()
    return value


def test_bpmn_structured_split_join_and_sequence_flow_routing_lower():
    problem = compile_instance(bpmn_package())
    workflow = problem.document["spec"]["application"]["workflow"]
    assert workflow["kind"] == "exclusive"
    assert [branch["id"] for branch in workflow["branches"]] == ["f-left", "f-right"]
    assert problem.document["spec"]["routing"] == [
        {"target": {"resource": "app", "id": "f-left"}, "probability": 0.25},
        {"target": {"resource": "app", "id": "f-right"}, "probability": 0.75},
    ]


def test_bpmn_duplicate_id_diagnostic_serializes_navigable_element_and_related_location():
    value = bpmn_package(routing=False)
    value.files["workflow.bpmn"] = value.files["workflow.bpmn"].replace(b'<task id="t2"/>', b'<task id="t1"/>')

    with pytest.raises(CompileError) as captured:
        compile_instance(value)

    diagnostic = next(item.as_dict() for item in captured.value.diagnostics if item.bpmn_element == "t1")
    assert diagnostic == {
        "code": "resource_missing",
        "message": diagnostic["message"],
        "resource": "workflow.bpmn",
        "pointer": "/process/t1",
        "bpmnElement": "t1",
        "related": [
            {
                "resource": "workflow.bpmn",
                "pointer": "/process/t1",
                "bpmnElement": "t1",
            }
        ],
    }


def test_duplicate_routing_target_reports_the_first_entry_as_related_location():
    value = bpmn_package()
    routing = json.loads(value.files["routing.json"])
    routing["spec"]["entries"][1]["target"] = {"resource": "flow", "id": "f-left"}
    value.files["routing.json"] = json.dumps(routing).encode()

    with pytest.raises(CompileError) as captured:
        compile_instance(value)

    diagnostic = next(item.as_dict() for item in captured.value.diagnostics if item.code == "routing_target_duplicate")
    assert diagnostic == {
        "code": "routing_target_duplicate",
        "message": "duplicate routing target {'resource': 'flow', 'id': 'f-left'}",
        "resource": "routing.json",
        "pointer": "/spec/entries/1/target",
        "related": [{"resource": "routing.json", "pointer": "/spec/entries/0/target"}],
    }


def test_equivalent_json_and_bpmn_workflows_have_the_same_ir_digest():
    bpmn = bpmn_package()
    native = bpmn_package()
    instance = json.loads(native.files["instance.json"])
    instance["spec"]["resources"]["application"].pop("flow")
    native.files["instance.json"] = json.dumps(instance).encode()
    native.files.pop("workflow.bpmn")
    application = json.loads(native.files["application.json"])
    application["spec"]["workflow"] = {
        "exclusive": [
            {"id": "f-left", "flow": {"task": {"resource": "app", "id": "t1"}}},
            {"id": "f-right", "flow": {"task": {"resource": "app", "id": "t2"}}},
        ]
    }
    native.files["application.json"] = json.dumps(application).encode()
    routing = json.loads(native.files["routing.json"])
    for entry in routing["spec"]["entries"]:
        entry["target"]["resource"] = "app"
    native.files["routing.json"] = json.dumps(routing).encode()

    bpmn_problem = compile_instance(bpmn)
    native_problem = compile_instance(native)
    assert bpmn_problem.document["spec"]["application"]["workflow"] == native_problem.document["spec"]["application"]["workflow"]
    assert bpmn_problem.document["spec"]["routing"] == native_problem.document["spec"]["routing"]
    assert bpmn_problem.digest == native_problem.digest


def test_bpmn_parallel_lowers_to_native_parallel_shape_and_executes():
    problem = compile_instance(bpmn_package(routing=False, gateway="parallelGateway"))
    workflow = problem.document["spec"]["application"]["workflow"]
    assert workflow == {
        "kind": "parallel",
        "branches": [
            {"kind": "task", "task": {"resource": "app", "id": "t1"}},
            {"kind": "task", "task": {"resource": "app", "id": "t2"}},
        ],
    }
    binding = {"t1": {"resource": "cat-a", "id": "c1"}, "t2": {"resource": "cat-b", "id": "c1"}}
    assert problem.evaluate_binding(binding)["latency"] == 30


@pytest.mark.parametrize("mode", ["satisfy", "weighted", "lexicographic", "pareto"])
def test_soft_penalty_affects_every_optimization_mode(mode):
    value = base_package()
    soft = json.loads(value.files["soft.json"])
    soft["spec"]["constraints"]["limit"]["assert"] = "tasks.t1.provider.resource == 'never'"
    value.files["soft.json"] = json.dumps(soft).encode()
    optimization = json.loads(value.files["optimization.json"])
    optimization["spec"]["mode"] = mode
    if mode == "satisfy":
        optimization["spec"].pop("terms")
    value.files["optimization.json"] = json.dumps(optimization).encode()
    problem = compile_instance(value)
    binding = {"t1": {"resource": "cat-a", "id": "c1"}, "t2": {"resource": "cat-b", "id": "c1"}}
    objectives = problem.evaluate(binding)["objectives"]
    assert objectives["penalty"] == 2
    if mode in {"lexicographic", "pareto"}:
        assert objectives["score"][-1] == 2
    elif mode == "satisfy":
        assert objectives["score"] == 2
    else:
        assert objectives["score"] >= 2


def test_bpmn_and_json_conditions_share_expression_ir_and_are_executable():
    problem = compile_instance(bpmn_package(conditions=True, routing=False))
    branch = problem.document["spec"]["application"]["workflow"]["branches"][0]
    expected = compile_expression(
        "tasks.t1.provider.resource == 'cat-a'",
        allowed_roots={"tasks": "object"},
        path_types={"tasks.t1.provider.resource": "string"},
        expected_type="bool",
    ).ast
    assert branch["when"] == expected
    binding = {"t1": {"resource": "cat-a", "id": "c1"}, "t2": {"resource": "cat-b", "id": "c1"}}
    assert problem.evaluate_binding(binding)["latency"] == 10


def test_bpmn_static_sequential_multi_instance_lowers_to_repeat():
    problem = compile_instance(bpmn_package(routing=False, loop=True))
    workflow = problem.document["spec"]["application"]["workflow"]
    assert workflow == {"kind": "repeat", "body": {"kind": "task", "task": {"resource": "app", "id": "t1"}}, "count": 2}
    binding = {"t1": {"resource": "cat-a", "id": "c1"}, "t2": {"resource": "cat-b", "id": "c1"}}
    assert problem.evaluate_binding(binding)["latency"] == 20


def test_bpmn_rejects_unknown_sequence_flow_target_and_condition_probability_conflict():
    value = bpmn_package()
    routing_doc = json.loads(value.files["routing.json"])
    routing_doc["spec"]["entries"] = [
        {"target": {"resource": "flow", "id": "not-a-flow"}, "probability": 1}
    ]
    value.files["routing.json"] = json.dumps(routing_doc).encode()
    with pytest.raises(CompileError, match="unknown routing targets"):
        compile_instance(value)
    with pytest.raises(CompileError, match="cannot coexist"):
        compile_instance(bpmn_package(conditions=True, routing=True))


def test_bpmn_rejects_conditions_outside_xor_and_dangling_flow_sources():
    with pytest.raises(CompileError, match="only permits conditions on XOR"):
        compile_instance(bpmn_package(conditions=True, routing=False, gateway="parallelGateway"))

    value = bpmn_package(routing=False)
    value.files["workflow.bpmn"] = value.files["workflow.bpmn"].replace(b'sourceRef="start"', b'sourceRef="missing"', 1)
    with pytest.raises(CompileError, match="sourceRef targets unknown"):
        compile_instance(value)
