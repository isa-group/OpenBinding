"""B5: a candidate feature range {min, max} may have infinite ends; null means infinity.

`{"min": 100, "max": null}` is [100, +inf), `{"min": null, "max": 200}` is (-inf, 200] and
`{"min": null, "max": null}` carries no information.  Both keys are mandatory and each end is a
finite JSON number or null.  Open ranges are IR data: the canonical evaluator still defines no
range semantics and the bundled Engines still declare `featureValues: only scalar`.
"""

from __future__ import annotations

import json

import httpx
import jsonschema
import pytest

from _repo import REPO_ROOT
from openbinding_gateway.routes import v1 as routes
from openbinding_gateway.v1 import remote
from openbinding_gateway.v1.analysis import analyze_neighborhood
from openbinding_gateway.v1.canonical import canonical_json, digest
from openbinding_gateway.v1.compiler import (
    CompileError,
    _feature_slot_value,
    _schema_validator,
    _TaskFeatures,
    _validate_feature_value,
    compile_instance,
)
from openbinding_gateway.v1.package import PackageError, load_package, strict_json_loads

from test_bim_v1_language_final import base_package, envelope

DEMO = REPO_ROOT / "examples/demo/01_simple_seq"
DEMO_BINDING = {
    "t1": {"resource": "catalog", "id": "c1a"},
    "t2": {"resource": "catalog", "id": "c2a"},
    "t3": {"resource": "catalog", "id": "c3a"},
}
POINTER = "/spec/candidates/c1a/features/latency"

OPEN_RANGES = [
    {"min": 100, "max": None},
    {"min": None, "max": 200},
    {"min": None, "max": None},
]
VALID_RANGES = [*OPEN_RANGES, {"min": 100, "max": 200}, {"min": -3.5, "max": None}, {"min": None, "max": -7}]


def demo_package(latency, *, domain=None, extra=None, constraint=None, alternative=None):
    value = load_package(DEMO)
    application = json.loads(value.files["application.json"])
    catalog = json.loads(value.files["candidates.json"])
    candidates = catalog["spec"]["candidates"]
    candidates["c1a"]["features"]["latency"] = latency
    if alternative is not None:
        candidates["c1b"]["features"]["latency"] = alternative
    if domain is not None:
        application["spec"]["features"]["latency"]["domain"] = domain
    if extra is not None:
        application["spec"]["features"]["extra"] = {"unit": "ms"}
        catalog["spec"]["featureBindings"]["extra"] = {"resource": "application", "id": "extra"}
        candidates["c1a"]["features"]["extra"] = extra
        candidates["c1b"]["features"]["extra"] = 3
    value.files["application.json"] = json.dumps(application).encode()
    value.files["candidates.json"] = json.dumps(catalog).encode()
    if constraint is not None:
        instance = json.loads(value.files["instance.json"])
        instance["spec"]["resources"]["constraintSet"] = {"limits": "constraints.json"}
        value.files["instance.json"] = json.dumps(instance).encode()
        value.files["constraints.json"] = json.dumps(
            envelope("ConstraintSet", "limits", {"constraints": {"limit": {"assert": constraint, "enforcement": "hard"}}})
        ).encode()
    return value


def stored_latency(problem):
    return problem.document["spec"]["candidates"]["catalog"]["candidates"]["c1a"]["features"]["latency"]


def codes(diagnostics):
    return [item.code for item in diagnostics]


def validate(value, domain=None):
    diagnostics = []
    _validate_feature_value(value, {"domain": domain or {"kind": "real"}}, "catalog", POINTER, diagnostics)
    return diagnostics


# -- Valid ranges: the four null/finite combinations and the IR ------------------


@pytest.mark.parametrize("latency", VALID_RANGES)
def test_a_range_with_finite_or_null_ends_compiles_and_the_ir_keeps_null(latency):
    problem = compile_instance(demo_package(latency))

    assert stored_latency(problem) == latency
    validator = _schema_validator("BindingProblem")
    assert validator is not None
    assert not list(validator.iter_errors(problem.document))
    assert (b"null" in canonical_json(stored_latency(problem))) == (None in latency.values())


def test_the_four_null_and_finite_combinations_are_distinct_valid_ir_values():
    combinations = [
        {"min": 100, "max": 200},
        {"min": 100, "max": None},
        {"min": None, "max": 200},
        {"min": None, "max": None},
    ]
    problems = [compile_instance(demo_package(value)) for value in combinations]

    assert [stored_latency(problem) for problem in problems] == combinations
    assert len({problem.digest for problem in problems}) == 4
    assert len({digest(stored_latency(problem)) for problem in problems}) == 4
    assert canonical_json(combinations[3]) == b'{"max":null,"min":null}'


@pytest.mark.parametrize("latency", VALID_RANGES)
def test_the_ir_round_trips_through_json_and_canonical_json_without_losing_null(latency):
    problem = compile_instance(demo_package(latency))
    document = problem.document

    assert json.loads(json.dumps(document, allow_nan=False)) == document
    assert strict_json_loads(canonical_json(document)) == document
    assert digest(strict_json_loads(canonical_json(document))) == digest(document)


@pytest.mark.parametrize("latency", OPEN_RANGES)
def test_an_open_range_survives_the_portable_zip_round_trip(latency):
    original = compile_instance(demo_package(latency))
    restored = compile_instance(load_package(demo_package(latency).to_zip()))

    assert stored_latency(restored) == latency
    assert restored.digest == original.digest


def test_an_open_end_is_not_checked_against_the_feature_domain():
    domain = {"kind": "real", "minimum": 0, "maximum": 25}
    assert stored_latency(compile_instance(demo_package({"min": None, "max": None}, domain=domain))) == {
        "min": None,
        "max": None,
    }
    assert stored_latency(compile_instance(demo_package({"min": 5, "max": None}, domain=domain)))["max"] is None
    integer = {"kind": "integer", "minimum": 0, "maximum": 100}
    assert stored_latency(compile_instance(demo_package({"min": 3, "max": None}, domain=integer))) == {"min": 3, "max": None}


# -- Invalid ranges --------------------------------------------------------------


SCHEMA_INVALID = [
    pytest.param({"min": 1}, id="max-missing"),
    pytest.param({"max": 1}, id="min-missing"),
    pytest.param({}, id="both-missing"),
    pytest.param({"min": 1, "max": 2, "mid": 1}, id="extra-key"),
    pytest.param({"mni": 1, "max": 2}, id="typo-for-min"),
    pytest.param({"min": 1, "mxa": 2}, id="typo-for-max"),
    pytest.param({"mni": None, "max": None}, id="typo-with-nulls"),
    pytest.param({"min": "inf", "max": 2}, id="string-inf-min"),
    pytest.param({"min": 1, "max": "inf"}, id="string-inf-max"),
    pytest.param({"min": "-inf", "max": None}, id="string-minus-inf"),
    pytest.param({"min": "Infinity", "max": 1}, id="string-Infinity"),
    pytest.param({"min": "1", "max": 2}, id="numeric-string"),
    pytest.param({"min": True, "max": 2}, id="bool-min"),
    pytest.param({"min": 1, "max": False}, id="bool-max"),
    pytest.param({"min": [1], "max": 2}, id="list-end"),
    pytest.param({"min": {"v": 1}, "max": 2}, id="object-end"),
    pytest.param([1, 2], id="list-value"),
    pytest.param("5", id="string-scalar"),
    pytest.param("inf", id="string-inf-scalar"),
    pytest.param(True, id="bool-scalar"),
    pytest.param(None, id="null-scalar"),
]


@pytest.mark.parametrize("latency", SCHEMA_INVALID)
def test_a_malformed_range_or_a_null_scalar_is_rejected_by_the_catalog_schema(latency):
    with pytest.raises(CompileError) as captured:
        compile_instance(demo_package(latency))

    schema = [item for item in captured.value.diagnostics if item.code == "schema"]
    assert schema, captured.value.diagnostics
    assert any("latency" in item.pointer for item in schema)


@pytest.mark.parametrize("latency", [{"min": 9, "max": 3}, {"min": 0, "max": -1}, {"min": -1.5, "max": -2}])
def test_a_finite_range_with_min_above_max_is_still_rejected(latency):
    with pytest.raises(CompileError) as captured:
        compile_instance(demo_package(latency))

    assert any(
        item.code == "feature_interval_order" and item.pointer.endswith("/features/latency")
        for item in captured.value.diagnostics
    )


@pytest.mark.parametrize("bound", ["min", "max"])
@pytest.mark.parametrize("constant", ["Infinity", "-Infinity", "NaN"])
def test_non_json_constants_never_reach_the_compiler(bound, constant):
    latency = {"min": 1, "max": 2, bound: "__constant__"}
    package = demo_package(latency)
    package.files["candidates.json"] = package.files["candidates.json"].replace(b'"__constant__"', constant.encode())

    with pytest.raises(PackageError, match="candidates.json"):
        compile_instance(package)


@pytest.mark.parametrize("bound", ["min", "max"])
def test_python_infinity_reaching_the_compiler_by_another_route_is_rejected(bound):
    for endpoint in (float("inf"), float("-inf"), float("nan")):
        # json.dumps writes the non-JSON constant; the package layer refuses it.
        with pytest.raises(PackageError):
            compile_instance(demo_package({"min": 1, "max": 2, bound: endpoint}))


@pytest.mark.parametrize("bound", ["min", "max"])
def test_an_overflowing_number_literal_is_a_finite_number_diagnostic_not_infinity(bound):
    package = demo_package({"min": 1, "max": 2, bound: "__big__"})
    package.files["candidates.json"] = package.files["candidates.json"].replace(b'"__big__"', b"1e999")

    with pytest.raises((PackageError, CompileError)) as captured:
        compile_instance(package)
    if isinstance(captured.value, CompileError):
        assert "finite_number" in codes(captured.value.diagnostics)


# -- The compiler validator used directly (second line of defence) ---------------


@pytest.mark.parametrize("latency", VALID_RANGES)
def test_validator_accepts_finite_and_null_ends(latency):
    assert validate(latency) == []


def test_validator_rejects_a_non_finite_end_with_finite_number_at_that_end():
    for bound in ("min", "max"):
        other = "max" if bound == "min" else "min"
        for bad in (float("inf"), float("-inf"), float("nan"), "inf", "-inf", "Infinity", True, False, [1], {"a": 1}, 10**400):
            diagnostics = validate({bound: bad, other: 1})
            assert codes(diagnostics) == ["finite_number"], (bound, bad)
            assert diagnostics[0].pointer == f"{POINTER}/{bound}"
        # an open end next to a bad end still reports only the bad end
        diagnostics = validate({bound: float("inf"), other: None})
        assert codes(diagnostics) == ["finite_number"]
        assert diagnostics[0].pointer == f"{POINTER}/{bound}"


def test_validator_reports_both_bad_ends():
    diagnostics = validate({"min": float("nan"), "max": "inf"})
    assert [item.pointer for item in diagnostics] == [f"{POINTER}/min", f"{POINTER}/max"]
    assert codes(diagnostics) == ["finite_number", "finite_number"]


@pytest.mark.parametrize("value", [{"min": 1}, {"max": 1}, {}, {"min": 1, "max": 2, "mid": 3}, {"mni": 1, "max": 2}])
def test_validator_rejects_missing_extra_or_misspelled_keys_with_the_shape_code(value):
    assert codes(validate(value)) == ["feature_interval_shape"]


def test_validator_orders_only_two_finite_ends():
    assert codes(validate({"min": 9, "max": 3})) == ["feature_interval_order"]
    assert validate({"min": 3, "max": 3}) == []
    assert validate({"min": 3, "max": 3.0}) == []
    assert validate({"min": 9, "max": None}) == []
    assert validate({"min": None, "max": -9}) == []
    assert validate({"min": None, "max": None}) == []


def test_validator_rejects_null_and_other_non_numbers_as_scalars():
    for scalar in (None, "inf", "5", True, [1], float("inf"), float("nan")):
        assert codes(validate(scalar)) == ["finite_number"], scalar
    assert validate(5) == []


def test_validator_still_checks_the_finite_end_against_the_domain():
    bounded = {"kind": "real", "minimum": 0, "maximum": 25}
    below = validate({"min": -1, "max": None}, bounded)
    assert [(item.code, item.pointer) for item in below] == [("feature_value_domain", f"{POINTER}/min")]
    above = validate({"min": None, "max": 50}, bounded)
    assert [(item.code, item.pointer) for item in above] == [("feature_value_domain", f"{POINTER}/max")]
    assert validate({"min": None, "max": None}, bounded) == []
    integer = validate({"min": None, "max": 4.5}, {"kind": "integer"})
    assert [(item.code, item.pointer) for item in integer] == [("feature_value_domain", f"{POINTER}/max")]
    assert validate({"min": 4, "max": None}, {"kind": "integer"}) == []


def test_slot_conversion_keeps_null_and_converts_finite_ends_to_float():
    assert _feature_slot_value({"min": None, "max": 3}) == {"min": None, "max": 3.0}
    assert _feature_slot_value({"min": 1, "max": None}) == {"min": 1.0, "max": None}
    assert _feature_slot_value({"min": None, "max": None}) == {"min": None, "max": None}
    assert _feature_slot_value({"min": 1, "max": 2}) == {"min": 1.0, "max": 2.0}
    assert _feature_slot_value(4) == 4.0


# -- Catalog and BindingProblem schemas ------------------------------------------


@pytest.mark.parametrize("schema_file", ["candidate-catalog.schema.json", "binding-problem.schema.json"])
def test_both_schemas_accept_open_ends_and_reject_the_rest(schema_file):
    schema = json.loads((REPO_ROOT / "schemas/bim/v1" / schema_file).read_text(encoding="utf-8"))
    validator = jsonschema.Draft202012Validator({"$ref": "#/$defs/featureValue", "$defs": schema["$defs"]})

    for value in (5, 0, -2.5, *VALID_RANGES):
        assert not list(validator.iter_errors(value)), value
    for value in (None, "inf", True, [1, 2], {"min": 1}, {"max": None}, {}, {"min": 1, "max": 2, "x": 0}, {"mni": 1, "max": 2}, {"min": "inf", "max": None}, {"min": True, "max": None}):
        assert list(validator.iter_errors(value)), value


# -- Evaluator, expressions and analysis never read or coerce a range ------------


@pytest.mark.parametrize("latency", OPEN_RANGES)
def test_the_canonical_evaluator_rejects_a_selected_open_range_with_a_clear_error(latency):
    problem = compile_instance(demo_package(latency))
    with pytest.raises(ValueError) as captured:
        problem.evaluate_binding(DEMO_BINDING)

    message = str(captured.value)
    assert "latency" in message and "catalog/c1a" in message and "interval" in message
    assert "TypeError" not in message and "float" not in message


@pytest.mark.parametrize("latency", OPEN_RANGES)
def test_an_open_range_that_is_not_selected_does_not_affect_evaluation(latency):
    problem = compile_instance(demo_package(5, alternative=latency))
    assert problem.evaluate_binding(DEMO_BINDING) == {"latency": 25.0}


@pytest.mark.parametrize("extra", OPEN_RANGES)
def test_an_expression_reading_an_open_range_compiles_and_fails_explicitly_at_evaluation(extra):
    problem = compile_instance(demo_package(5, extra=extra, constraint="tasks.t1.features.extra <= 100"))
    assert problem.evaluate_binding(DEMO_BINDING) == {"latency": 25.0}
    with pytest.raises(ValueError) as captured:
        problem.evaluate_constraints(DEMO_BINDING)

    assert "extra" in str(captured.value) and "interval" in str(captured.value)


@pytest.mark.parametrize("extra", OPEN_RANGES)
def test_comparison_and_arithmetic_over_an_open_range_raise_instead_of_computing(extra):
    for constraint in (
        "tasks.t1.features.extra + 1 <= 100",
        "tasks.t1.features.extra * 2 >= 0",
        "min(tasks.t1.features.extra, 3) <= 3",
        "tasks.t1.features.extra == 3",
    ):
        problem = compile_instance(demo_package(5, extra=extra, constraint=constraint))
        with pytest.raises(ValueError, match="interval"):
            problem.evaluate_constraints(DEMO_BINDING)


@pytest.mark.parametrize("latency", OPEN_RANGES)
def test_task_features_refuses_to_read_an_open_range_but_reports_membership(latency):
    features = _TaskFeatures({"cost": latency, "latency": 3.0}, {"resource": "catalog", "id": "c1a"})

    assert "cost" in features and "latency" in features and len(features) == 2
    assert features["latency"] == 3.0
    with pytest.raises(ValueError, match="interval"):
        features["cost"]


@pytest.mark.parametrize("latency", OPEN_RANGES)
def test_selected_candidate_scope_rejects_a_selected_open_range_explicitly(latency):
    value = demo_package(latency)
    application = json.loads(value.files["application.json"])
    application["spec"]["features"]["latency"].update({"scope": "selectedCandidate", "aggregation": "sum"})
    value.files["application.json"] = json.dumps(application).encode()

    with pytest.raises(ValueError, match="interval"):
        compile_instance(value).evaluate_binding(DEMO_BINDING)


@pytest.mark.parametrize("alternative", OPEN_RANGES)
def test_neighborhood_analysis_reports_open_range_moves_as_failures(alternative):
    problem = compile_instance(demo_package(5, alternative=alternative))
    analysis = analyze_neighborhood(problem, DEMO_BINDING)

    assert analysis["moves"] == []
    assert [item["to"] for item in analysis["failures"]] == [{"resource": "catalog", "id": "c1b"}]
    assert "interval" in analysis["failures"][0]["message"]
    assert analysis["coverage"]["complete"] is False


def weighted_product_package(availability):
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
            {"target": {"resource": "app", "id": "left"}, "probability": 0.25},
            {"target": {"resource": "app", "id": "right"}, "probability": 0.75},
        ]
    })).encode()
    application = json.loads(value.files["application.json"])
    application["spec"]["features"]["availability"] = {
        "unit": "1",
        "domain": "ratio",
        "direction": "maximize",
        "aggregation": "product",
    }
    value.files["application.json"] = json.dumps(application).encode()
    for path, amount in (("catalog-a.json", availability), ("catalog-b.json", 0.8)):
        catalog = json.loads(value.files[path])
        catalog["spec"]["featureBindings"]["availability"] = {"resource": "app", "id": "availability"}
        catalog["spec"]["candidates"]["c1"]["features"]["availability"] = amount
        value.files[path] = json.dumps(catalog).encode()
    optimization = json.loads(value.files["optimization.json"])
    optimization["spec"]["criteria"] = [{"id": "availability", "feature": {"resource": "app", "id": "availability"}}]
    value.files["optimization.json"] = json.dumps(optimization).encode()
    return value


@pytest.mark.parametrize("availability", [{"min": None, "max": 0.9}, {"min": None, "max": None}])
def test_fractional_product_treats_an_open_lower_end_as_negative_infinity(availability):
    with pytest.raises(CompileError) as captured:
        compile_instance(weighted_product_package(availability))

    assert "fractional_product_value" in codes(captured.value.diagnostics)


@pytest.mark.parametrize("availability", [0.9, {"min": 0.5, "max": 0.9}, {"min": 0.5, "max": None}, {"min": 0, "max": None}])
def test_fractional_product_accepts_scalars_and_ranges_whose_lower_end_is_non_negative(availability):
    problem = compile_instance(weighted_product_package(availability))
    stored = problem.document["spec"]["candidates"]["cat-a"]["candidates"]["c1"]["features"]["availability"]
    assert stored == availability


# -- Engine capabilities (featureValues) -----------------------------------------


def engine_modes():
    paths = [*sorted(routes._MANIFEST_DIR.glob("*.json")), REPO_ROOT / "examples/federation/multi-heuristic/engine.json"]
    manifests = [json.loads(path.read_text(encoding="utf-8")) for path in paths]
    return [
        (f"{manifest['metadata']['name']}/{mode['id']}", mode)
        for manifest in manifests
        for mode in manifest["spec"]["modes"]
    ]


def feature_value_diagnostics(problem, mode):
    return [item for item in routes._mode_compatibility(problem, mode) if item.get("category") == "featureValues"]


@pytest.mark.parametrize("latency", OPEN_RANGES)
def test_an_open_range_counts_as_the_interval_feature_value_kind(latency):
    assert routes._ir_features(compile_instance(demo_package(latency)))["featureValues"] == {"scalar", "interval"}
    assert routes._ir_features(compile_instance(demo_package(5)))["featureValues"] == {"scalar"}
    unused = compile_instance(demo_package(5, extra=latency))
    assert "extra" not in unused.document["spec"]["application"]["requiredFeatures"]
    assert routes._ir_features(unused)["featureValues"] == {"scalar", "interval"}


@pytest.mark.parametrize("latency", OPEN_RANGES)
def test_open_ranges_fail_closed_against_every_engine_mode_like_finite_ones(latency):
    modes = engine_modes()
    assert modes
    problem = compile_instance(demo_package(latency))
    for name, mode in modes:
        assert mode["capabilities"]["featureValues"] == {"selector": "only", "values": ["scalar"]}, name
        diagnostics = feature_value_diagnostics(problem, mode)
        assert [item["code"] for item in diagnostics] == ["unsupported_capability_value"], name
        assert diagnostics[0]["unsupported"] == ["interval"], name
        assert diagnostics[0]["allowed"] == ["scalar"], name


def test_open_and_finite_ranges_produce_the_same_capability_diagnostic():
    finite = compile_instance(demo_package({"min": 1, "max": 2}))
    open_range = compile_instance(demo_package({"min": 1, "max": None}))
    for name, mode in engine_modes():
        assert feature_value_diagnostics(finite, mode) == feature_value_diagnostics(open_range, mode), name


def test_scalar_problems_remain_compatible_with_every_engine_mode():
    problem = compile_instance(demo_package(5))
    for name, mode in engine_modes():
        assert not feature_value_diagnostics(problem, mode), name


def test_an_engine_declaring_all_or_interval_values_is_the_only_way_to_accept_open_ranges():
    problem = compile_instance(demo_package({"min": None, "max": None}))
    _, mode = engine_modes()[0]
    accepting = json.loads(json.dumps(mode))

    accepting["capabilities"]["featureValues"] = {"selector": "all"}
    assert feature_value_diagnostics(problem, accepting) == []
    accepting["capabilities"]["featureValues"] = {"selector": "only", "values": ["scalar", "interval"]}
    assert feature_value_diagnostics(problem, accepting) == []
    accepting["capabilities"]["featureValues"] = {"selector": "none"}
    assert [item["code"] for item in feature_value_diagnostics(problem, accepting)] == ["unsupported_capability"]


# -- Serialization towards a remote Engine ---------------------------------------


def engine_result():
    return {
        "termination": "FEASIBLE",
        "solutions": [
            {
                "decision": {"kind": "binding", "binding": {}},
                "features": {},
                "objectives": {"type": "SINGLE", "scalarization": "feasibility", "components": [], "penalty": 0, "score": 0},
                "penalties": [],
                "violations": [],
            }
        ],
    }


@pytest.mark.asyncio
@pytest.mark.parametrize("latency", OPEN_RANGES)
async def test_the_remote_payload_carries_open_ends_as_json_null(monkeypatch, latency):
    monkeypatch.setattr(remote, "validate_endpoint", lambda endpoint, **kwargs: None)
    problem = compile_instance(demo_package(latency))
    seen = {}

    async def handler(request: httpx.Request) -> httpx.Response:
        seen["body"] = request.read()
        return httpx.Response(200, json=engine_result())

    await remote.solve_remote(
        remote.RemoteRegistration("https://engine.example", {}, "bearer", "secret"),
        problem.document,
        {"seed": 7},
        {"type": "SINGLE", "scalarization": "feasibility"},
        transport=httpx.MockTransport(handler),
    )

    sent = json.loads(seen["body"])
    assert sent["problem"] == problem.document
    assert stored_latency_of(sent["problem"]) == latency
    assert b"NaN" not in seen["body"] and b"Infinity" not in seen["body"]
    assert strict_json_loads(seen["body"]) == sent


def stored_latency_of(document):
    return document["spec"]["candidates"]["catalog"]["candidates"]["c1a"]["features"]["latency"]


@pytest.mark.asyncio
@pytest.mark.parametrize("endpoint", [float("inf"), float("-inf"), float("nan")])
async def test_a_non_finite_number_is_never_serialized_towards_an_engine(monkeypatch, endpoint):
    monkeypatch.setattr(remote, "validate_endpoint", lambda endpoint, **kwargs: None)
    called = []

    async def handler(request: httpx.Request) -> httpx.Response:
        called.append(request)
        return httpx.Response(200, json=engine_result())

    problem = {"apiVersion": "bim/v1", "kind": "BindingProblem", "x": {"min": endpoint, "max": None}}
    with pytest.raises(remote.RemoteEngineError, match="not valid JSON"):
        await remote.solve_remote(
            remote.RemoteRegistration("https://engine.example", {}, "none", None),
            problem,
            {},
            {"type": "SINGLE", "scalarization": "feasibility"},
            transport=httpx.MockTransport(handler),
        )
    assert called == []
