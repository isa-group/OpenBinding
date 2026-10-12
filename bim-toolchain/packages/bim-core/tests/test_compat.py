"""bim_core.compat: mode compatibility, Engine manifest checks, execution options and optimization selection.

The Engine manifests are inputs: the four manifests of OpenBinding's catalog are copied to
``tests/fixtures/manifests`` for these tests (the bootstrap check copies them).  The tests of the featureValues
capability come from ``test_b5_open_ranges.py`` of OpenBinding.
"""

import copy
import json

import pytest

from bim_core import ContractError, compile_instance, engine_contract_diagnostics, ir_features, mode_compatibility
from bim_core import compat, resolve_optimization
from bim_core.canonical import digest
from core_support import engine_manifest_fixtures, require_corpus_path

from _language import EXECUTION_MODE, base_package, demo_package, problem_with_criteria

OPEN_RANGES = [
    {"min": 100, "max": None},
    {"min": None, "max": 200},
    {"min": None, "max": None},
]


@pytest.fixture(scope="module")
def manifests():
    return engine_manifest_fixtures()


@pytest.fixture(scope="module")
def problem():
    return compile_instance(base_package())


@pytest.fixture(scope="module")
def demo():
    return require_corpus_path("examples/demo/01_simple_seq")


@pytest.fixture()
def seeded(manifests):
    """The mode of the random-search Engine: the most permissive one, a good base to restrict."""
    return copy.deepcopy(manifests["random-search"]["spec"]["modes"][0])


def codes(diagnostics):
    return [item["code"] for item in diagnostics]


# -- ir_features -------------------------------------------------------------------------------------


def test_the_capability_dimensions_a_problem_uses(problem) -> None:
    features = ir_features(problem)
    spec = problem.document["spec"]
    scopes = {
        feature["scope"] for feature in spec["application"]["features"].values() if isinstance(feature.get("scope"), str)
    }

    assert set(features) >= {
        "workflowNodes", "aggregations", "featureScopes", "featureValues",
        "constraints", "expressions", "placement", "irExtensions",
    }
    assert features["featureScopes"] == scopes
    assert features["featureValues"] == {"scalar"}
    assert features["placement"] == set() and features["irExtensions"] == set()
    assert {"sequence", "task", "repeat.expectedCount"} <= features["workflowNodes"]
    assert all(isinstance(value, set) for value in features.values())


def test_constraints_are_classified_by_enforcement_and_shape(problem) -> None:
    assert ir_features(problem)["constraints"] == {"hard.aggregate-bound", "soft.expression"}


def test_a_problem_without_optional_sections_still_has_every_dimension() -> None:
    class Empty:
        document = {"spec": {}}
        source_map: dict = {}

    features = ir_features(Empty())

    assert features["workflowNodes"] == set() and features["constraints"] == set()
    assert features["aggregations"] == set() and features["featureValues"] == set()


@pytest.mark.parametrize("latency", OPEN_RANGES)
def test_an_open_range_counts_as_the_interval_feature_value_kind(demo, latency) -> None:
    assert ir_features(compile_instance(demo_package(demo, latency)))["featureValues"] == {"scalar", "interval"}
    assert ir_features(compile_instance(demo_package(demo, 5)))["featureValues"] == {"scalar"}
    unused = compile_instance(demo_package(demo, 5, extra=latency))
    assert "extra" not in unused.document["spec"]["application"]["requiredFeatures"]
    assert ir_features(unused)["featureValues"] == {"scalar", "interval"}


# -- mode_compatibility --------------------------------------------------------------------------


def test_the_permissive_mode_runs_the_problem(problem, seeded) -> None:
    assert mode_compatibility(problem, seeded) == []


def test_the_profile_and_the_ir_must_match(problem, seeded) -> None:
    seeded["profile"] = "other/v1"
    seeded["ir"] = {"apiVersion": "bim/v1", "kind": "Other"}

    found = mode_compatibility(problem, seeded)

    assert codes(found) == ["profile_incompatible", "ir_incompatible"]
    assert "'other/v1'" in found[0]["message"] and "'qos-binding/v1'" in found[0]["message"]


def test_a_dimension_the_mode_does_not_declare_is_missing(problem, seeded) -> None:
    del seeded["capabilities"]["featureScopes"]

    found = mode_compatibility(problem, seeded)

    assert found == [{
        "code": "missing_capability_selector",
        "category": "featureScopes",
        "message": "mode does not declare capability dimension featureScopes",
    }]


def test_selector_none_refuses_every_use_of_the_dimension(problem, seeded) -> None:
    seeded["capabilities"]["constraints"] = {"selector": "none"}

    (found,) = mode_compatibility(problem, seeded)

    assert (found["code"], found["category"], found["unsupported"]) == (
        "unsupported_capability", "constraints", ["hard.aggregate-bound", "soft.expression"],
    )


def test_selector_none_is_fine_if_the_dimension_is_not_used(problem, seeded) -> None:
    seeded["capabilities"]["placement"] = {"selector": "none"}
    seeded["capabilities"]["irExtensions"] = "none"

    assert mode_compatibility(problem, seeded) == []


def test_selector_only_lists_what_is_unsupported_and_what_is_allowed(problem, seeded) -> None:
    seeded["capabilities"]["constraints"] = {"selector": "only", "values": ["hard.aggregate-bound", 3]}

    (found,) = mode_compatibility(problem, seeded)

    assert found["code"] == "unsupported_capability_value"
    assert found["unsupported"] == ["soft.expression"]
    assert found["allowed"] == ["hard.aggregate-bound"]
    assert "featureValues" not in found["message"]


@pytest.mark.parametrize("declaration", ["all", {"selector": "all"}])
def test_selector_all_accepts_anything(problem, seeded, declaration) -> None:
    seeded["capabilities"]["constraints"] = declaration

    assert mode_compatibility(problem, seeded) == []


@pytest.mark.parametrize("declaration", [{"selector": "some"}, {"values": ["x"]}, 3, ["all"], "everything", {"selector": None}])
def test_any_other_selector_is_invalid(problem, seeded, declaration) -> None:
    seeded["capabilities"]["constraints"] = declaration

    (found,) = mode_compatibility(problem, seeded)

    assert (found["code"], found["category"]) == ("invalid_capability_selector", "constraints")


def test_a_string_selector_has_no_values(problem, seeded) -> None:
    seeded["capabilities"]["constraints"] = "only"

    (found,) = mode_compatibility(problem, seeded)

    assert found["code"] == "unsupported_capability_value" and found["allowed"] == []


def test_the_limits_of_the_mode_bound_tasks_candidates_and_objectives(problem, seeded) -> None:
    spec = problem.document["spec"]
    tasks = len(spec["application"]["tasks"])
    candidates = sum(len(catalog["candidates"]) for catalog in spec["candidates"].values())
    objectives = len(spec["optimization"]["criteria"])
    seeded["limits"] = {"maxTasks": tasks - 1, "maxCandidates": candidates - 1, "maxObjectives": objectives - 1}

    found = mode_compatibility(problem, seeded)

    assert [(item["limit"], item["actual"], item["maximum"]) for item in found] == [
        ("maxTasks", tasks, tasks - 1),
        ("maxCandidates", candidates, candidates - 1),
        ("maxObjectives", objectives, objectives - 1),
    ]
    assert found[0]["message"] == f"instance has {tasks} tasks; mode limit is {tasks - 1}"
    assert set(codes(found)) == {"engine_limit"}


def test_a_limit_that_is_met_is_not_a_finding(problem, seeded) -> None:
    spec = problem.document["spec"]
    seeded["limits"] = {
        "maxTasks": len(spec["application"]["tasks"]),
        "maxCandidates": 2,
        "maxObjectives": 2,
        "minObjectives": 2,
    }

    assert mode_compatibility(problem, seeded) == []


def test_a_mode_may_require_a_minimum_number_of_objectives(problem, seeded) -> None:
    seeded["limits"] = {"minObjectives": 3}

    (found,) = mode_compatibility(problem, seeded)

    assert (found["code"], found["limit"], found["actual"], found["minimum"]) == ("engine_limit", "minObjectives", 2, 3)


@pytest.mark.parametrize("limits", [{"maxTasks": "1"}, {"maxTasks": None}, {"maxTasks": 1.5}, [], "x", None])
def test_a_limit_that_is_not_an_integer_is_ignored(problem, seeded, limits) -> None:
    seeded["limits"] = limits

    assert mode_compatibility(problem, seeded) == []


@pytest.mark.parametrize("latency", OPEN_RANGES)
def test_open_ranges_fail_closed_against_every_engine_mode_like_finite_ones(demo, manifests, latency) -> None:
    problem = compile_instance(demo_package(demo, latency))
    modes = [(name, mode) for name, manifest in manifests.items() for mode in manifest["spec"]["modes"]]

    assert modes
    for name, mode in modes:
        assert mode["capabilities"]["featureValues"] == {"selector": "only", "values": ["scalar"]}, name
        found = [item for item in mode_compatibility(problem, mode) if item.get("category") == "featureValues"]
        assert [item["code"] for item in found] == ["unsupported_capability_value"], name
        assert found[0]["unsupported"] == ["interval"] and found[0]["allowed"] == ["scalar"], name


def test_the_refusal_of_a_range_points_at_the_value_in_the_catalog_and_in_the_ir(demo, seeded) -> None:
    problem = compile_instance(demo_package(demo, {"min": 1, "max": None}))

    found = [item for item in mode_compatibility(problem, seeded) if item.get("category") == "featureValues"]

    assert found[0]["irPath"] == "/spec/candidates/catalog/candidates/c1a/features/latency"
    assert found[0]["resource"] == "candidates.json"
    assert found[0]["pointer"] == "/spec/candidates/c1a/features/latency"


def test_open_and_finite_ranges_produce_the_same_capability_diagnostic(demo, manifests) -> None:
    finite = compile_instance(demo_package(demo, {"min": 1, "max": 2}))
    open_range = compile_instance(demo_package(demo, {"min": 1, "max": None}))
    for name, manifest in manifests.items():
        for mode in manifest["spec"]["modes"]:
            assert mode_compatibility(finite, mode) == mode_compatibility(open_range, mode), name


def test_scalar_problems_remain_compatible_with_the_scalar_modes(demo, manifests) -> None:
    problem = compile_instance(demo_package(demo, 5))
    for name, manifest in manifests.items():
        for mode in manifest["spec"]["modes"]:
            found = [item for item in mode_compatibility(problem, mode) if item.get("category") == "featureValues"]
            assert found == [], name


def test_an_engine_declaring_all_or_interval_values_is_the_only_way_to_accept_open_ranges(demo, seeded) -> None:
    problem = compile_instance(demo_package(demo, {"min": None, "max": None}))

    def feature_values(declaration):
        seeded["capabilities"]["featureValues"] = declaration
        return [item for item in mode_compatibility(problem, seeded) if item.get("category") == "featureValues"]

    assert feature_values({"selector": "all"}) == []
    assert feature_values({"selector": "only", "values": ["scalar", "interval"]}) == []
    assert [item["code"] for item in feature_values({"selector": "none"})] == ["unsupported_capability"]


# -- Engine manifests --------------------------------------------------------------------------------


def test_the_catalog_manifests_have_no_contract_findings(manifests) -> None:
    assert sorted(manifests) == ["evolutionary-heuristics", "many-heuristic", "minizinc-csp", "random-search"]
    for name, manifest in manifests.items():
        assert engine_contract_diagnostics(manifest) == [], name


def test_engine_refs_are_immutable_references(manifests) -> None:
    reference = compat.engine_ref(manifests["random-search"])

    assert reference == {
        "namespace": "bim.builtin", "name": "random-search", "version": "1.0.0",
        "digest": digest(manifests["random-search"]),
    }
    assert compat.engine_ref({"metadata": {"name": "x"}}, "acme")["namespace"] == "acme"
    assert compat.engine_ref({"metadata": {"name": "x"}}) == {
        "namespace": "bim.builtin", "name": "x", "version": "1.0.0", "digest": digest({"metadata": {"name": "x"}}),
    }
    with pytest.raises(KeyError):
        compat.engine_ref({"metadata": {}})


def engine_with(manifests, change):
    document = copy.deepcopy(manifests["random-search"])
    change(document["spec"]["modes"][0], document)
    return document


@pytest.mark.parametrize(
    ("change", "expected", "pointer"),
    [
        (lambda m, d: d["spec"]["modes"].append(copy.deepcopy(m)), "mode_id_duplicate", "/spec/modes/1/id"),
        (lambda m, d: m.__setitem__("profile", "nobody/v1"), "profile_adapter_not_installed", "/spec/modes/0/profile"),
        (lambda m, d: m.__setitem__("profile", 3), "profile_adapter_not_installed", "/spec/modes/0/profile"),
        (lambda m, d: m.__setitem__("ir", {"apiVersion": "bim/v1", "kind": "Plan"}), "profile_ir", "/spec/modes/0/ir"),
        (lambda m, d: m["capabilities"].pop("placement"), "capability_dimension_missing", "/spec/modes/0/capabilities"),
        (lambda m, d: m["capabilities"].__setitem__("telepathy", {"selector": "all"}), "capability_dimension_unknown", "/spec/modes/0/capabilities/telepathy"),
        (lambda m, d: m["capabilities"].__setitem__("featureValues", {"selector": "only", "values": ["quantum"]}), "capability_value_unknown", "/spec/modes/0/capabilities/featureValues/values"),
        (lambda m, d: m["limits"].__setitem__("maxGalaxies", 3), "limit_unknown", "/spec/modes/0/limits/maxGalaxies"),
        (lambda m, d: m["optionsSchema"].__setitem__("required", ["ghost"]), "required_option_unknown", "/spec/modes/0/optionsSchema/required"),
        (lambda m, d: m["optionsSchema"]["properties"]["iterations"].update({"minimum": 10, "maximum": 5}), "option_range_empty", "/spec/modes/0/optionsSchema/properties/iterations"),
        (lambda m, d: m["optionsSchema"]["properties"]["iterations"].update({"default": "many"}), "option_default_invalid", "/spec/modes/0/optionsSchema/properties/iterations/default"),
    ],
)
def test_the_declarations_of_a_manifest_are_checked_against_its_profile(manifests, change, expected, pointer) -> None:
    found = engine_contract_diagnostics(engine_with(manifests, change))

    assert expected in codes(found)
    assert pointer in [item["pointer"] for item in found if item["code"] == expected]
    assert all(set(item) == {"code", "pointer", "message"} for item in found)


def test_a_manifest_without_modes_has_nothing_to_check() -> None:
    assert engine_contract_diagnostics({}) == []
    assert engine_contract_diagnostics({"spec": {"modes": "x"}}) == []
    assert engine_contract_diagnostics({"spec": {"modes": [1, None]}}) == []


def test_schema_diagnostics_validate_against_the_bundled_schemas(manifests) -> None:
    assert compat.schema_diagnostics(manifests["random-search"], "Engine") == []

    broken = copy.deepcopy(manifests["random-search"])
    broken["spec"]["modes"][0]["surprise"] = True
    found = compat.schema_diagnostics(broken, "Engine")

    assert found and {item["code"] for item in found} == {"schema"}
    assert all(item["pointer"].startswith("/") for item in found)


def test_schema_diagnostics_know_the_documented_kinds_only(manifests) -> None:
    assert compat.schema_diagnostics({}, "Mystery") == []
    assert compat.schema_diagnostics({}, "") == []
    assert sorted(compat.SCHEMA_FILES) == sorted({
        "Instance", "Profile", "Application", "CandidateCatalog", "ConstraintSet", "Optimization",
        "RoutingOverlay", "Placement", "Engine", "Dialect", "EngineRegistration",
    })
    for kind in compat.SCHEMA_FILES:
        assert compat.schema_diagnostics("not an object", kind)


def test_a_missing_schema_is_reported_not_raised(monkeypatch) -> None:
    def missing(name):
        raise FileNotFoundError(name)

    monkeypatch.setattr(compat, "read_schema", missing)

    (found,) = compat.schema_diagnostics({}, "Engine")

    assert found["code"] == "schema_unavailable" and "engine.schema.json" in found["message"]


def test_a_manifest_must_not_embed_credentials() -> None:
    document = {
        "spec": {
            "auth": {"scheme": "bearer", "apiKey": "x"},
            "endpoint": "https://e",
            "openapi": {"components": {"securitySchemes": {"token": {}}}},
            "list": [{"Client-Secret": 1}, {"fine": 2}],
        },
        "password": "p",
    }

    assert compat.embedded_secret_paths(document) == ["/spec/auth/apiKey", "/spec/list/0/Client-Secret", "/password"]
    assert compat.embedded_secret_paths({"a": [{"b": []}]}) == []
    assert compat.embedded_secret_paths("secret") == []


def test_selector_values_follow_the_mode_declaration() -> None:
    universe = ("a", "b", "c")
    mode = {"capabilities": {
        "x": {"selector": "all"}, "y": {"selector": "only", "values": ["b", "z", 3, "a"]},
        "z": {"selector": "none"}, "w": "all", "v": {"selector": "only"},
    }}

    assert compat.selector_values(mode, "x", universe) == universe
    assert compat.selector_values(mode, "y", universe) == ("b", "a")
    assert compat.selector_values(mode, "z", universe) == ()
    assert compat.selector_values(mode, "w", universe) == ()
    assert compat.selector_values(mode, "v", universe) == ()
    assert compat.selector_values(mode, "missing", universe) == ()
    assert compat.selector_values({}, "x", universe) == ()


def test_candidate_count_adds_up_the_catalogs() -> None:
    assert compat.candidate_count({"candidates": {"a": {"candidates": {"x": {}, "y": {}}}, "b": {"candidates": {"z": {}}}}}) == 3
    assert compat.candidate_count({}) == 0
    assert compat.candidate_count({"candidates": []}) == 0
    assert compat.candidate_count({"candidates": {"a": {"candidates": []}, "b": 1}}) == 0


def test_a_job_pins_the_id_and_the_termination_guarantees_of_its_mode(manifests) -> None:
    mode = manifests["random-search"]["spec"]["modes"][0]
    pinned = compat.mode_execution_contract(mode)

    assert pinned == {"id": "seeded", "terminationGuarantees": ["FEASIBLE", "UNKNOWN"]}
    assert compat.persisted_mode_contract(pinned) == pinned
    assert compat.mode_execution_contract({"guarantees": {"termination": "x"}}) == {"id": None, "terminationGuarantees": []}
    assert compat.mode_execution_contract({}) == {"id": None, "terminationGuarantees": []}


@pytest.mark.parametrize(
    "stored",
    [
        None, [], {}, {"id": "m"}, {"id": "m", "terminationGuarantees": []},
        {"id": "", "terminationGuarantees": ["OPTIMAL"]},
        {"id": 1, "terminationGuarantees": ["OPTIMAL"]},
        {"id": "m", "terminationGuarantees": ["OPTIMAL", "OPTIMAL"]},
        {"id": "m", "terminationGuarantees": ["SOMETIMES"]},
        {"id": "m", "terminationGuarantees": [["OPTIMAL"]]},
        {"id": "m", "terminationGuarantees": "OPTIMAL"},
        {"id": "m", "terminationGuarantees": ["OPTIMAL"], "extra": 1},
    ],
)
def test_a_stored_mode_contract_is_trusted_only_if_it_is_exactly_well_formed(stored) -> None:
    assert compat.persisted_mode_contract(stored) is None


# -- execution options ---------------------------------------------------------------------------


def rejected(call, *arguments):
    with pytest.raises(ContractError) as caught:
        call(*arguments)
    error = caught.value
    assert error.http_status == 422 and isinstance(error, ValueError)
    assert error.as_dict()["httpStatus"] == 422
    return error


def test_options_start_from_the_defaults_of_the_mode(seeded) -> None:
    assert compat.validate_options(seeded, {}) == {"iterations": 1000, "seed": 0}
    assert compat.validate_options(seeded, {"iterations": 5, "time_budget_ms": 10}) == {
        "iterations": 5, "seed": 0, "time_budget_ms": 10,
    }


def test_the_supplied_options_are_not_modified(seeded) -> None:
    supplied = {"iterations": 5}

    compat.validate_options(seeded, supplied)

    assert supplied == {"iterations": 5}


@pytest.mark.parametrize("supplied", [None, [], "x", 3, [("iterations", 1)]])
def test_options_must_be_an_object(seeded, supplied) -> None:
    error = rejected(compat.validate_options, seeded, supplied)

    assert error.code == "invalid_option"
    assert error.diagnostics == [
        {"code": "option_type", "message": "engine options must be a JSON object", "pointer": "/options"}
    ]


def test_unknown_options_are_refused_one_diagnostic_each(seeded) -> None:
    error = rejected(compat.validate_options, seeded, {"zeta": 1, "alpha": 2, "iterations": 3})

    assert error.code == "unknown_option"
    assert error.diagnostics == [
        {"code": "unknown_option", "message": "unknown engine option 'alpha'"},
        {"code": "unknown_option", "message": "unknown engine option 'zeta'"},
    ]
    assert str(error) == "unknown engine option 'alpha'; unknown engine option 'zeta'"


@pytest.mark.parametrize(
    "supplied",
    [{"iterations": 0}, {"iterations": 1000001}, {"iterations": 2.5}, {"iterations": "5"}, {"iterations": True},
     {"iterations": None}, {"seed": 9007199254740992}, {"time_budget_ms": 0}, {"time_budget_ms": 3600001}],
)
def test_values_outside_the_options_schema_are_refused(seeded, supplied) -> None:
    error = rejected(compat.validate_options, seeded, supplied)

    assert error.code == "invalid_option"
    assert {item["code"] for item in error.diagnostics} == {"option_schema"}
    assert all(item["pointer"] == "/options" for item in error.diagnostics)


def test_an_option_may_not_exceed_a_limit_of_the_mode(seeded) -> None:
    seeded["limits"] = {"maxIterations": 10, "maxTimeBudgetMs": 100}

    error = rejected(compat.validate_options, seeded, {"iterations": 11})

    assert error.code == "option_limit"
    assert error.diagnostics == [{"code": "effective_limit", "message": "option 'iterations' exceeds mode limit 10"}]
    assert compat.validate_options(seeded, {"iterations": 10, "time_budget_ms": 100})["iterations"] == 10
    assert rejected(compat.validate_options, seeded, {"iterations": 1, "time_budget_ms": 101}).code == "option_limit"


def test_a_default_that_exceeds_a_limit_is_refused_too(seeded) -> None:
    seeded["limits"] = {"maxIterations": 10}

    assert rejected(compat.validate_options, seeded, {}).code == "option_limit"


@pytest.mark.parametrize("value", ["many", True, None, [3]])
def test_a_limited_option_must_be_a_number_even_if_the_schema_does_not_say_so(seeded, value) -> None:
    seeded["optionsSchema"] = {"type": "object", "properties": {"iterations": {}}}
    seeded["limits"] = {"maxIterations": 10}

    error = rejected(compat.validate_options, seeded, {"iterations": value})

    assert error.code == "invalid_option"
    assert error.diagnostics == [{"code": "option_type", "message": "option 'iterations' must be numeric"}]


def test_a_mode_without_an_options_schema_accepts_no_option() -> None:
    assert compat.validate_options({"id": "m"}, {}) == {}
    assert rejected(compat.validate_options, {"id": "m"}, {"a": 1}).code == "unknown_option"
    assert compat.validate_options({"optionsSchema": []}, {}) == {}


def test_options_without_limits_are_not_bounded_by_them(seeded) -> None:
    del seeded["limits"]

    assert compat.validate_options(seeded, {"iterations": 999999})["iterations"] == 999999


# -- choosing the mode ---------------------------------------------------------------------------


def test_a_mode_is_chosen_by_id_or_is_the_only_one(manifests) -> None:
    single = manifests["random-search"]
    pair = manifests["evolutionary-heuristics"]

    assert compat.select_mode(single, "seeded")["id"] == "seeded"
    assert compat.select_mode(single, None)["id"] == "seeded"
    assert compat.select_mode(pair, "pareto-genetic")["id"] == "pareto-genetic"


@pytest.mark.parametrize(("requested", "label"), [("nope", "'nope'"), (None, "None"), ("", "''")])
def test_a_mode_that_does_not_exist_is_refused(manifests, requested, label) -> None:
    error = rejected(compat.select_mode, manifests["evolutionary-heuristics"], requested)

    assert error.code == "engine_mode_incompatible"
    assert error.diagnostics == [{
        "code": "mode",
        "message": f"engine 'evolutionary-heuristics' does not provide mode {label}",
    }]


def test_the_name_in_the_refusal_can_be_given(manifests) -> None:
    error = rejected(lambda: compat.select_mode(manifests["random-search"], "x", name="my-engine"))

    assert "engine 'my-engine'" in str(error)


def test_resolving_a_mode_checks_the_manifest_the_mode_and_the_options(manifests) -> None:
    document, mode, effective = compat.resolve_engine_mode(manifests["random-search"], None, {"iterations": 7})

    assert document is manifests["random-search"]
    assert mode["id"] == "seeded"
    assert effective == {"iterations": 7, "seed": 0}


def test_resolving_a_mode_refuses_an_invalid_manifest_before_anything_else(manifests) -> None:
    broken = engine_with(manifests, lambda m, d: m.__setitem__("profile", "nobody/v1"))

    error = rejected(compat.resolve_engine_mode, broken, "nope", {"unknown": 1})

    assert error.code == "engine_contract_invalid"
    assert codes(error.diagnostics) == ["profile_adapter_not_installed"]


def test_resolving_a_mode_reports_a_missing_mode_before_bad_options(manifests) -> None:
    error = rejected(compat.resolve_engine_mode, manifests["random-search"], "nope", [])

    assert error.code == "engine_mode_incompatible"
    assert rejected(compat.resolve_engine_mode, manifests["random-search"], "seeded", []).code == "invalid_option"


# -- the optimization the job runs ------------------------------------------------------------


def optimization_error(count, requested, mode=EXECUTION_MODE):
    return rejected(resolve_optimization, problem_with_criteria(count), mode, requested).code


@pytest.mark.parametrize("requested", [None, [], "SINGLE", 1, [("type", "SINGLE")]])
def test_the_optimization_must_be_an_object(requested) -> None:
    assert optimization_error(2, requested) == "optimization_required"


@pytest.mark.parametrize("objective_type", [None, "single", "", 1, ["SINGLE"], "NONE"])
def test_the_objective_type_is_one_of_three(objective_type) -> None:
    assert optimization_error(2, {"type": objective_type, "scalarization": "weighted-sum"}) in {
        "invalid_optimization_type",
    }


@pytest.mark.parametrize("scalarization", [None, "", 3, ["x"]])
def test_the_scalarization_is_a_name(scalarization) -> None:
    assert optimization_error(2, {"type": "SINGLE", "scalarization": scalarization}) == "scalarization_required"


def test_criteria_ids_must_be_unique() -> None:
    problem = problem_with_criteria(2)
    problem.document["spec"]["optimization"]["criteria"][1]["id"] = "criterion-0"

    error = rejected(resolve_optimization, problem, EXECUTION_MODE, {"type": "SINGLE", "scalarization": "weighted-sum"})

    assert error.code == "invalid_criteria"


def test_the_mode_must_support_the_scalarization_and_the_type() -> None:
    assert optimization_error(2, {"type": "SINGLE", "scalarization": "borda"}) == "scalarization_incompatible"
    assert optimization_error(2, {"type": "MULTI", "scalarization": "weighted-sum"}) == "optimization_type_incompatible"
    assert optimization_error(2, {"type": "SINGLE", "scalarization": "weighted-sum"}, {}) == "scalarization_incompatible"
    assert optimization_error(
        2, {"type": "SINGLE", "scalarization": "weighted-sum"}, {"capabilities": {"scalarizations": "all"}}
    ) == "scalarization_incompatible"


def test_cardinality_errors_name_the_rule() -> None:
    assert str(rejected(resolve_optimization, problem_with_criteria(1), EXECUTION_MODE, {"type": "MULTI", "scalarization": "pareto-front"})) == (
        "MULTI requires two or three criteria"
    )
    assert str(rejected(resolve_optimization, problem_with_criteria(2), EXECUTION_MODE, {"type": "MANY", "scalarization": "pareto-front"})) == (
        "MANY requires at least three criteria"
    )


def test_a_weighted_scalarization_defaults_to_equal_weights_that_sum_to_one() -> None:
    resolved = resolve_optimization(problem_with_criteria(4), EXECUTION_MODE, {"type": "SINGLE", "scalarization": "weighted-sum"})

    assert resolved == {
        "type": "SINGLE",
        "scalarization": "weighted-sum",
        "weights": [{"criteria": f"criterion-{index}", "value": 0.25} for index in range(4)],
    }


def test_supplied_weights_are_normalized_to_sum_to_one() -> None:
    requested = {
        "type": "SINGLE",
        "scalarization": "weighted-sum",
        "weights": [{"criteria": "criterion-0", "value": 3}, {"criteria": "criterion-1", "value": 1}],
    }

    resolved = resolve_optimization(problem_with_criteria(2), EXECUTION_MODE, requested)

    assert resolved["weights"] == [{"criteria": "criterion-0", "value": 0.75}, {"criteria": "criterion-1", "value": 0.25}]
    assert requested["weights"][0]["value"] == 3


def test_a_weighted_scalarization_needs_a_criterion() -> None:
    assert optimization_error(0, {"type": "SINGLE", "scalarization": "weighted-sum"}) == "weights_required"


def test_criteria_are_needed_unless_the_scalarization_is_feasibility() -> None:
    mode = {"capabilities": {"scalarizations": {"values": [
        {"id": "plain", "objectiveTypes": ["SINGLE"], "weightPolicy": "optional"},
        {"id": "feasibility", "objectiveTypes": ["SINGLE"]},
    ]}}}

    assert optimization_error(0, {"type": "SINGLE", "scalarization": "plain"}, mode) == "criteria_required"
    assert resolve_optimization(problem_with_criteria(0), mode, {"type": "SINGLE", "scalarization": "feasibility"})["weights"] == []


def test_weights_are_refused_where_the_policy_forbids_them() -> None:
    assert optimization_error(
        2, {"type": "MULTI", "scalarization": "pareto-front", "weights": [{"criteria": "criterion-0", "value": 1}]}
    ) == "weights_forbidden"
    resolved = resolve_optimization(
        problem_with_criteria(2), EXECUTION_MODE, {"type": "MULTI", "scalarization": "pareto-front", "weights": []}
    )
    assert resolved["weights"] == []


@pytest.mark.parametrize(
    "weights",
    [
        "x", {"criteria": "criterion-0", "value": 1},
        [1], [{"criteria": "criterion-0"}], [{"criteria": "criterion-0", "value": 1, "extra": 1}],
        [{"criteria": "criterion-0", "value": 1}, {"criteria": "criterion-0", "value": 1}],
        [{"criteria": "ghost", "value": 1}, {"criteria": "criterion-1", "value": 1}],
        [{"criteria": "criterion-0", "value": 0}, {"criteria": "criterion-1", "value": 1}],
        [{"criteria": "criterion-0", "value": -1}, {"criteria": "criterion-1", "value": 1}],
        [{"criteria": "criterion-0", "value": True}, {"criteria": "criterion-1", "value": 1}],
        [{"criteria": "criterion-0", "value": "1"}, {"criteria": "criterion-1", "value": 1}],
        [{"criteria": "criterion-0", "value": float("nan")}, {"criteria": "criterion-1", "value": 1}],
        [{"criteria": "criterion-0", "value": float("inf")}, {"criteria": "criterion-1", "value": 1}],
        [{"criteria": "criterion-0", "value": 1}],
        [],
    ],
)
def test_weights_must_be_positive_finite_and_cover_every_criterion_exactly_once(weights) -> None:
    assert optimization_error(2, {"type": "SINGLE", "scalarization": "weighted-sum", "weights": weights}) == "invalid_weights"


def test_resolving_does_not_depend_on_the_order_of_the_keys() -> None:
    first = resolve_optimization(problem_with_criteria(2), EXECUTION_MODE, {"scalarization": "weighted-sum", "type": "SINGLE"})
    second = resolve_optimization(problem_with_criteria(2), EXECUTION_MODE, {"type": "SINGLE", "scalarization": "weighted-sum"})

    assert first == second
    assert json.dumps(first, sort_keys=True) == json.dumps(second, sort_keys=True)


def test_a_rejection_is_a_contract_error_with_a_suggested_status() -> None:
    error = rejected(resolve_optimization, problem_with_criteria(0), EXECUTION_MODE, "x")

    assert error.as_dict() == {
        "code": "optimization_required",
        "message": "job execution requires an optimization object",
        "httpStatus": 422,
    }
