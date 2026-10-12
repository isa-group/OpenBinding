"""Evaluation, execution-optimization and neighbourhood tests migrated from test_bim_v1_language_final.py.

Source: ``openbinding-gateway/tests/test_bim_v1_language_final.py``.  Mechanical changes only: imports come from
``bim_core``; ``_resolve_execution_optimization`` is ``bim_core.compat.resolve_optimization`` and a rejection is a
``ContractError`` with ``http_status == 422`` instead of an ``HTTPException``; ``analyze_neighborhood`` is
``bim_core.neighborhood``; the demo package comes from the corpus (``BIM_CORPUS_ROOT``).  The compile-time tests of
that file (diagnostics, Profile and Dialect framework, BPMN lowering, placement validation, registered resources)
are not part of this step.
"""

import json
from copy import deepcopy

import pytest

from bim_core import (
    CompileError,
    ContractError,
    PackageError,
    analyze_neighborhood,
    compile_instance,
)
from bim_core.compat import resolve_optimization
from bim_core.compiler import _schema_validator, _TaskFeatures
from conftest import require_corpus_path

from _language import (
    BINDING,
    DEMO_BINDING,
    EXECUTION_MODE,
    SAME_CATALOG_BINDING,
    base_package,
    demo_package,
    envelope,
    problem_with_criteria,
)


@pytest.fixture(scope="module")
def demo():
    return require_corpus_path("examples/demo/01_simple_seq")


@pytest.mark.parametrize(
    ("objective_type", "scalarization", "criteria_count", "valid"),
    [
        ("SINGLE", "feasibility", 0, True),
        ("SINGLE", "weighted-sum", 0, False),
        ("SINGLE", "weighted-sum", 1, True),
        ("SINGLE", "weighted-sum", 4, True),
        ("MULTI", "pareto-front", 1, False),
        ("MULTI", "pareto-front", 2, True),
        ("MULTI", "pareto-front", 3, True),
        ("MULTI", "pareto-front", 4, False),
        ("MANY", "pareto-front", 2, False),
        ("MANY", "pareto-front", 3, True),
        ("MANY", "pareto-front", 4, True),
    ],
)
def test_execution_objective_type_has_the_declared_criteria_cardinality(
    objective_type: str, scalarization: str, criteria_count: int, valid: bool
) -> None:
    # The objective type is chosen at execution time; the Optimization resource
    # only declares criteria, so cardinality is checked against the compiled IR.
    problem = problem_with_criteria(criteria_count)
    requested = {"type": objective_type, "scalarization": scalarization}
    if not valid:
        with pytest.raises(ContractError) as captured:
            resolve_optimization(problem, EXECUTION_MODE, requested)
        assert captured.value.http_status == 422
        return
    resolved = resolve_optimization(problem, EXECUTION_MODE, requested)
    assert resolved["type"] == objective_type
    assert resolved["scalarization"] == scalarization
    if scalarization == "weighted-sum":
        assert [item["value"] for item in resolved["weights"]] == [1.0 / criteria_count] * criteria_count
    else:
        assert resolved["weights"] == []


def test_compiled_optimization_declares_criteria_and_leaves_type_to_execution() -> None:
    value = base_package()
    compiled = compile_instance(value)
    assert set(compiled.document["spec"]["optimization"]) == {"resource", "criteria", "penalties"}
    ir_validator = _schema_validator("BindingProblem")
    assert ir_validator is not None
    assert not list(ir_validator.iter_errors(compiled.document))
    with_type = deepcopy(compiled.document)
    with_type["spec"]["optimization"]["type"] = "SINGLE"
    assert list(ir_validator.iter_errors(with_type))

    optimization = json.loads(value.files["optimization.json"])
    template = optimization["spec"]["criteria"][0]
    for count, objective_type in ((1, "SINGLE"), (2, "MULTI"), (3, "MANY")):
        optimization["spec"]["criteria"] = [
            {**deepcopy(template), "id": f"latency-{index}"} for index in range(count)
        ]
        value.files["optimization.json"] = json.dumps(optimization).encode()
        problem = compile_instance(value)
        assert [item["id"] for item in problem.document["spec"]["optimization"]["criteria"]] == [
            f"latency-{index}" for index in range(count)
        ]
        scalarization = "weighted-sum" if objective_type == "SINGLE" else "pareto-front"
        resolved = resolve_optimization(
            problem,
            EXECUTION_MODE,
            {"type": objective_type, "scalarization": scalarization},
        )
        assert resolved["type"] == objective_type


def test_multiple_resources_keep_local_id_identity_and_evaluate_once_selected():
    problem = compile_instance(base_package())
    spec = problem.document["spec"]
    assert set(spec["candidates"]) == {"cat-a", "cat-b"}
    assert spec["candidates"]["cat-a"]["candidates"]["c1"]["ref"] == {"resource": "cat-a", "id": "c1"}
    assert {tuple(item["ref"].values()) for item in spec["constraints"]} == {("hard", "limit"), ("soft", "limit")}
    binding = SAME_CATALOG_BINDING
    assert problem.evaluate_binding(binding) == {"latency": 30.0, "cost": 5.0}
    assert problem.evaluate_constraints(binding) == []
    assert spec["optimization"]["criteria"] == [
        {
            "id": "latency",
            "feature": {"resource": "app", "id": "latency"},
            "direction": "minimize",
            "normalize": {"min": 0.0, "max": 100.0, "clamp": False},
        },
        {
            "id": "cost",
            "feature": {"resource": "app", "id": "cost"},
            "direction": "minimize",
            "normalize": {"min": 0.0, "max": 20.0, "clamp": False},
        },
    ]
    assert spec["optimization"]["penalties"] == [
        {"constraint": {"resource": "soft", "id": "limit"}, "weight": 1.0}
    ]
    # Weights belong to the execution selection, not to the compiled problem.
    objectives = problem.evaluate_objectives(
        {"latency": 30.0, "cost": 5.0},
        [],
        {
            "type": "SINGLE",
            "scalarization": "weighted-sum",
            "weights": [
                {"criteria": "latency", "value": 0.75},
                {"criteria": "cost", "value": 0.25},
            ],
        },
    )
    assert objectives["score"] == pytest.approx(0.75 * 0.3 + 0.25 * 0.25)
    assert spec["profile"]["output"]["apiVersion"] == "bim/v1"
    assert spec["profile"]["output"]["kind"] == "BindingProblem"
    assert "/spec/candidates/cat-a/c1" in spec["sourceMap"]
    assert spec["sourceMap"]["/spec/constraints/0/assert"]["span"]["start"] == 0


def test_binding_must_be_complete_and_candidate_ref_eligible():
    problem = compile_instance(base_package())
    with pytest.raises(ValueError, match="missing"):
        problem.evaluate_binding({"t1": {"resource": "cat-a", "id": "c1"}})
    with pytest.raises(ValueError, match="not eligible"):
        problem.evaluate_binding({"t1": {"resource": "cat-a", "id": "missing"}, "t2": {"resource": "cat-a", "id": "c1"}})


def test_parallel_uses_declared_operator_without_hidden_max():
    workflow = {"parallel": [{"task": {"resource": "app", "id": "t1"}}, {"task": {"resource": "app", "id": "t2"}}]}
    problem = compile_instance(base_package(workflow=workflow))
    assert problem.evaluate_binding(BINDING)["latency"] == 30.0


def _exclusive_with_routing(left, right):
    value = base_package(
        workflow={
            "exclusive": [
                {"id": "left", "flow": {"task": {"resource": "app", "id": "t1"}}},
                {"id": "right", "flow": {"task": {"resource": "app", "id": "t2"}}},
            ]
        }
    )
    instance = json.loads(value.files["instance.json"])
    instance["spec"]["resources"]["candidateCatalog"]["routes"] = "routing.json"
    value.files["instance.json"] = json.dumps(instance).encode()
    value.files["routing.json"] = json.dumps(envelope("RoutingOverlay", "routes", {
        "entries": [
            {"target": {"resource": "app", "id": "left"}, "probability": left},
            {"target": {"resource": "app", "id": "right"}, "probability": right},
        ]
    })).encode()
    return value


def _with_feature(value, feature_id, definition, amounts):
    application = json.loads(value.files["application.json"])
    application["spec"]["features"][feature_id] = definition
    value.files["application.json"] = json.dumps(application).encode()
    for path, amount in amounts:
        catalog = json.loads(value.files[path])
        catalog["spec"]["featureBindings"][feature_id] = {"resource": "app", "id": feature_id}
        catalog["spec"]["candidates"]["c1"]["features"][feature_id] = amount
        value.files[path] = json.dumps(catalog).encode()
    optimization = json.loads(value.files["optimization.json"])
    optimization["spec"]["criteria"] = [{"id": feature_id, "feature": {"resource": "app", "id": feature_id}}]
    value.files["optimization.json"] = json.dumps(optimization).encode()
    return value


def test_routing_weighted_product_is_geometric_and_not_a_scaled_sum():
    value = _with_feature(
        _exclusive_with_routing(0.25, 0.75),
        "availability",
        {"unit": "1", "domain": "ratio", "direction": "maximize", "aggregation": "product"},
        (("catalog-a.json", 0.9), ("catalog-b.json", 0.8)),
    )
    problem = compile_instance(value)
    assert problem.evaluate_binding(BINDING)["availability"] == pytest.approx((0.9**0.25) * (0.8**0.75))


def test_fractional_product_requires_a_nonnegative_metric_domain():
    value = _with_feature(
        _exclusive_with_routing(0.5, 0.5),
        "signed",
        {"unit": "1", "domain": {"kind": "real", "minimum": -1, "maximum": 1}, "direction": "maximize", "aggregation": "product"},
        (("catalog-a.json", -0.9), ("catalog-b.json", 0.8)),
    )
    with pytest.raises(CompileError, match="non-negative domain"):
        compile_instance(value)


def test_metric_neutral_is_used_for_local_activities():
    value = _with_feature(
        base_package(),
        "quality",
        {"unit": "score", "domain": {"kind": "real", "minimum": 0, "maximum": 100}, "direction": "maximize", "aggregation": "min"},
        (("catalog-a.json", 80), ("catalog-b.json", 70)),
    )
    problem = compile_instance(value)
    assert problem.evaluate_binding(SAME_CATALOG_BINDING)["quality"] == 80


def test_objective_normalization_clamp_and_maximize_loss_are_explicit():
    value = base_package()
    optimization = json.loads(value.files["optimization.json"])
    optimization["spec"]["criteria"] = [{
        "id": "latency",
        "feature": {"resource": "app", "id": "latency"},
        "direction": "maximize",
        "normalize": {"min": 0, "max": 20, "clamp": True},
    }]
    optimization["spec"]["penalties"] = [{"constraint": {"resource": "soft", "id": "limit"}}]
    value.files["optimization.json"] = json.dumps(optimization).encode()
    problem = compile_instance(value)
    component = problem.evaluate_objectives({"latency": 30}, [])["components"][0]
    assert component["loss"] == 0
    assert problem.document["spec"]["optimization"]["criteria"][0]["normalize"]["clamp"] is True

    unclamped = deepcopy(value)
    document = json.loads(unclamped.files["optimization.json"])
    document["spec"]["criteria"][0]["normalize"]["clamp"] = False
    unclamped.files["optimization.json"] = json.dumps(document).encode()
    component = compile_instance(unclamped).evaluate_objectives({"latency": 30}, [])["components"][0]
    assert component["loss"] == -0.5


def test_constraints_have_no_hidden_comparison_epsilon():
    value = base_package()
    hard = json.loads(value.files["hard.json"])
    hard["spec"]["constraints"]["limit"]["assert"] = "features.latency <= 29.9999999"
    value.files["hard.json"] = json.dumps(hard).encode()
    problem = compile_instance(value)
    violations = problem.evaluate_constraints(SAME_CATALOG_BINDING)
    assert violations == [{
        "constraint": {"resource": "hard", "id": "limit"},
        "enforcement": "hard",
        "penalty": 0.0,
    }]


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
    assert problem.evaluate_constraints(BINDING) == []

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
    violations = problem.evaluate_constraints(BINDING)
    assert [item["constraint"] for item in violations] == [
        {"resource": "soft", "id": "limit"}
    ]


@pytest.mark.parametrize(
    ("objective_type", "scalarization"),
    [
        ("SINGLE", "feasibility"),
        ("SINGLE", "weighted-sum"),
        ("MULTI", "lexicographic"),
        ("MULTI", "pareto-front"),
    ],
)
def test_soft_penalty_affects_every_execution_scalarization(objective_type, scalarization):
    value = base_package()
    soft = json.loads(value.files["soft.json"])
    soft["spec"]["constraints"]["limit"]["assert"] = "tasks.t1.provider.resource == 'never'"
    value.files["soft.json"] = json.dumps(soft).encode()
    problem = compile_instance(value)
    execution = {"type": objective_type, "scalarization": scalarization}
    if scalarization == "weighted-sum":
        execution["weights"] = [
            {"criteria": "latency", "value": 0.75},
            {"criteria": "cost", "value": 0.25},
        ]
    objectives = problem.evaluate(BINDING, execution)["objectives"]
    assert objectives["penalty"] == 2
    if scalarization == "feasibility":
        assert objectives["score"] == 2
    elif scalarization == "weighted-sum":
        assert objectives["score"] >= 2
    else:
        assert objectives["score"][-1] == 2


# -- intervals in the canonical evaluator (need the corpus demo) ---------------------------------


def test_canonical_evaluator_rejects_an_interval_with_an_explicit_diagnostic(demo):
    problem = compile_instance(demo_package(demo, {"min": 8, "max": 12}))
    with pytest.raises(ValueError) as captured:
        problem.evaluate_binding(DEMO_BINDING)

    message = str(captured.value)
    assert "latency" in message and "catalog/c1a" in message and "interval" in message
    assert "float" not in message and "TypeError" not in message


def test_canonical_evaluator_still_accepts_an_interval_that_is_not_bound_to_the_selection(demo):
    problem = compile_instance(demo_package(demo, 5, alternative={"min": 8, "max": 12}))
    assert problem.evaluate_binding(DEMO_BINDING) == {"latency": 25.0}


def test_expression_reading_an_interval_compiles_and_is_rejected_by_the_evaluator(demo):
    problem = compile_instance(
        demo_package(demo, 5, extra={"min": 1, "max": 2}, constraint="tasks.t1.features.extra <= 100")
    )
    assert problem.evaluate_binding(DEMO_BINDING) == {"latency": 25.0}
    with pytest.raises(ValueError) as captured:
        problem.evaluate_constraints(DEMO_BINDING)

    message = str(captured.value)
    assert "extra" in message and "catalog/c1a" in message and "interval" in message


def test_task_features_membership_does_not_read_interval_values():
    features = _TaskFeatures({"cost": {"min": 1.0, "max": 2.0}, "latency": 3.0}, {"resource": "catalog", "id": "c1a"})

    assert "cost" in features and "latency" in features and "missing" not in features
    with pytest.raises(ValueError, match="interval"):
        features["cost"]


@pytest.mark.xfail(
    strict=True,
    raises=ValueError,
    reason="expressions._path_value reads value[segment] right after the membership check, so has() still "
    "reads the interval; fixing it needs a change in expressions.py",
)
def test_has_on_an_interval_slot_is_true_without_reading_the_value(demo):
    present = compile_instance(
        demo_package(demo, 5, extra={"min": 1, "max": 2}, constraint="has(tasks.t1.features.extra)")
    )
    assert present.evaluate_constraints(DEMO_BINDING) == []

    # `!has(...)` is violated only if has() evaluated to true for the interval slot.
    negated = compile_instance(
        demo_package(demo, 5, extra={"min": 1, "max": 2}, constraint="!has(tasks.t1.features.extra)")
    )
    violations = negated.evaluate_constraints(DEMO_BINDING)
    assert [item["enforcement"] for item in violations] == ["hard"]


def test_selected_candidate_scope_rejects_a_selected_interval_with_an_explicit_error(demo):
    def selected_scope(latency):
        value = demo_package(demo, latency)
        application = json.loads(value.files["application.json"])
        application["spec"]["features"]["latency"].update({"scope": "selectedCandidate", "aggregation": "sum"})
        value.files["application.json"] = json.dumps(application).encode()
        return compile_instance(value)

    scalar = selected_scope(5)
    assert scalar.document["spec"]["application"]["features"]["latency"]["scope"] == "selectedCandidate"
    assert scalar.evaluate_binding(DEMO_BINDING) == {"latency": 25.0}
    with pytest.raises(ValueError) as captured:
        selected_scope({"min": 8, "max": 12}).evaluate_binding(DEMO_BINDING)

    message = str(captured.value)
    assert "latency" in message and "catalog/c1a" in message and "interval" in message


def test_placement_execution_time_rejects_a_selected_interval_with_an_explicit_error(demo):
    placement = envelope(
        "Placement",
        "place",
        {
            "pools": {"edge": {"capacity": {}}},
            "groups": {
                f"g{index}": {
                    "pool": {"resource": "place", "id": "edge"},
                    "capability": f"service/t{index}",
                    "resources": {},
                }
                for index in (1, 2, 3)
            },
            "globalLatency": {
                "feature": {"resource": "application", "id": "latency"},
                "includeExecution": True,
                "exclusive": "routing",
                "parallel": "max",
            },
        },
    )
    value = demo_package(demo, {"min": 8, "max": 12})
    value.files["placement.json"] = json.dumps(placement).encode()
    instance = json.loads(value.files["instance.json"])
    instance["spec"]["resources"]["candidateCatalog"]["place"] = "placement.json"
    value.files["instance.json"] = json.dumps(instance).encode()
    problem = compile_instance(value)

    # evaluate_binding would fail earlier in the invocation aggregation of the
    # same required feature, so the placement derivation is called directly.
    with pytest.raises(ValueError) as captured:
        problem._placement_feature_overrides(DEMO_BINDING)

    message = str(captured.value)
    assert "latency" in message and "catalog/c1a" in message and "interval" in message


@pytest.mark.parametrize("bound", ["min", "max"])
@pytest.mark.parametrize("endpoint", [float("nan"), float("inf"), float("-inf")])
def test_non_finite_interval_endpoint_never_reaches_the_compiler(demo, bound, endpoint):
    # The package layer refuses the non-finite JSON constants before the
    # compiler could report finite_number; that code is covered by the direct
    # validator test in test_b5_open_ranges.
    with pytest.raises(PackageError, match="candidates.json"):
        compile_instance(demo_package(demo, {"min": 1, "max": 2, bound: endpoint}))


def test_neighborhood_analysis_reports_interval_moves_as_failures_instead_of_breaking(demo):
    problem = compile_instance(demo_package(demo, 5, alternative={"min": 8, "max": 12}))
    analysis = analyze_neighborhood(problem, DEMO_BINDING)

    assert analysis["moves"] == []
    assert [item["to"] for item in analysis["failures"]] == [{"resource": "catalog", "id": "c1b"}]
    assert "interval" in analysis["failures"][0]["message"]
    assert analysis["coverage"]["complete"] is False

    selected = compile_instance(demo_package(demo, {"min": 8, "max": 12}))
    with pytest.raises(ValueError, match="interval"):
        analyze_neighborhood(selected, DEMO_BINDING)
