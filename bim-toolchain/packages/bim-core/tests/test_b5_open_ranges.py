"""Migrated from openbinding-gateway/tests/test_b5_open_ranges.py (language side only).

A candidate feature range ``{min, max}`` may have infinite ends; ``null`` means infinity.
``{"min": 100, "max": null}`` is [100, +inf), ``{"min": null, "max": 200}`` is (-inf, 200] and
``{"min": null, "max": null}`` carries no information.  Both keys are mandatory and each end is a finite
JSON number or null.  Open ranges are IR data: the canonical evaluator defines no range semantics.

Not migrated (they need the platform; see docs/EXTRACTION_LOG.md): engine ``featureValues`` capability
checks (``routes._mode_compatibility``/``_ir_features``), the remote Engine payload (``v1.remote``),
neighbourhood analysis (``v1.analysis``) and the weighted-product tests that need ``base_package`` of
``test_bim_v1_language_final``.
"""

from __future__ import annotations

import json

import jsonschema
import pytest

from bim_core import CompileError, PackageError, canonical_json, compile_instance, digest, load_package
from bim_core import schema_root
from bim_core.compiler import (
    _feature_slot_value,
    _schema_validator,
    _TaskFeatures,
    _validate_feature_value,
)
from bim_core.package import strict_json_loads
from core_support import require_corpus_path

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


@pytest.fixture(scope="module")
def demo():
    return require_corpus_path("examples/demo/01_simple_seq")


def envelope(kind, name, spec):
    api_version = "qos-binding-placement/v1" if kind == "Placement" else "qos-binding/v1"
    return {"apiVersion": api_version, "kind": kind, "metadata": {"name": name}, "spec": spec}


def demo_package(demo, latency, *, domain=None, extra=None, constraint=None, alternative=None):
    value = load_package(demo)
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
def test_a_range_with_finite_or_null_ends_compiles_and_the_ir_keeps_null(demo, latency):
    problem = compile_instance(demo_package(demo, latency))

    assert stored_latency(problem) == latency
    validator = _schema_validator("BindingProblem")
    assert validator is not None
    assert not list(validator.iter_errors(problem.document))
    assert (b"null" in canonical_json(stored_latency(problem))) == (None in latency.values())


def test_the_four_null_and_finite_combinations_are_distinct_valid_ir_values(demo):
    combinations = [
        {"min": 100, "max": 200},
        {"min": 100, "max": None},
        {"min": None, "max": 200},
        {"min": None, "max": None},
    ]
    problems = [compile_instance(demo_package(demo, value)) for value in combinations]

    assert [stored_latency(problem) for problem in problems] == combinations
    assert len({problem.digest for problem in problems}) == 4
    assert len({digest(stored_latency(problem)) for problem in problems}) == 4
    assert canonical_json(combinations[3]) == b'{"max":null,"min":null}'


@pytest.mark.parametrize("latency", VALID_RANGES)
def test_the_ir_round_trips_through_json_and_canonical_json_without_losing_null(demo, latency):
    document = compile_instance(demo_package(demo, latency)).document

    assert json.loads(json.dumps(document, allow_nan=False)) == document
    assert strict_json_loads(canonical_json(document)) == document
    assert digest(strict_json_loads(canonical_json(document))) == digest(document)


@pytest.mark.parametrize("latency", OPEN_RANGES)
def test_an_open_range_survives_the_portable_zip_round_trip(demo, latency):
    original = compile_instance(demo_package(demo, latency))
    restored = compile_instance(load_package(demo_package(demo, latency).to_zip()))

    assert stored_latency(restored) == latency
    assert restored.digest == original.digest


def test_an_open_end_is_not_checked_against_the_feature_domain(demo):
    domain = {"kind": "real", "minimum": 0, "maximum": 25}
    both_open = compile_instance(demo_package(demo, {"min": None, "max": None}, domain=domain))
    assert stored_latency(both_open) == {"min": None, "max": None}
    assert stored_latency(compile_instance(demo_package(demo, {"min": 5, "max": None}, domain=domain)))["max"] is None
    integer = {"kind": "integer", "minimum": 0, "maximum": 100}
    assert stored_latency(compile_instance(demo_package(demo, {"min": 3, "max": None}, domain=integer))) == {
        "min": 3,
        "max": None,
    }


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
def test_a_malformed_range_or_a_null_scalar_is_rejected_by_the_catalog_schema(demo, latency):
    with pytest.raises(CompileError) as captured:
        compile_instance(demo_package(demo, latency))

    schema = [item for item in captured.value.diagnostics if item.code == "schema"]
    assert schema, captured.value.diagnostics
    assert any("latency" in item.pointer for item in schema)


@pytest.mark.parametrize("latency", [{"min": 9, "max": 3}, {"min": 0, "max": -1}, {"min": -1.5, "max": -2}])
def test_a_finite_range_with_min_above_max_is_still_rejected(demo, latency):
    with pytest.raises(CompileError) as captured:
        compile_instance(demo_package(demo, latency))

    assert any(
        item.code == "feature_interval_order" and item.pointer.endswith("/features/latency")
        for item in captured.value.diagnostics
    )


@pytest.mark.parametrize("bound", ["min", "max"])
@pytest.mark.parametrize("constant", ["Infinity", "-Infinity", "NaN"])
def test_non_json_constants_never_reach_the_compiler(demo, bound, constant):
    package = demo_package(demo, {"min": 1, "max": 2, bound: "__constant__"})
    package.files["candidates.json"] = package.files["candidates.json"].replace(b'"__constant__"', constant.encode())

    with pytest.raises(PackageError, match="candidates.json"):
        compile_instance(package)


@pytest.mark.parametrize("bound", ["min", "max"])
def test_python_infinity_reaching_the_compiler_by_another_route_is_rejected(demo, bound):
    for endpoint in (float("inf"), float("-inf"), float("nan")):
        # json.dumps writes the non-JSON constant; the package layer refuses it.
        with pytest.raises(PackageError):
            compile_instance(demo_package(demo, {"min": 1, "max": 2, bound: endpoint}))


@pytest.mark.parametrize("bound", ["min", "max"])
def test_an_overflowing_number_literal_is_a_finite_number_diagnostic_not_infinity(demo, bound):
    package = demo_package(demo, {"min": 1, "max": 2, bound: "__big__"})
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
        bad_values = (
            float("inf"), float("-inf"), float("nan"), "inf", "-inf", "Infinity", True, False, [1], {"a": 1}, 10**400,
        )
        for bad in bad_values:
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


# -- Catalog and BindingProblem schemas (shipped inside bim_core) -----------------


@pytest.mark.parametrize("schema_file", ["candidate-catalog.schema.json", "binding-problem.schema.json"])
def test_both_schemas_accept_open_ends_and_reject_the_rest(schema_file):
    schema = json.loads(schema_root().joinpath(schema_file).read_text(encoding="utf-8"))
    validator = jsonschema.Draft202012Validator({"$ref": "#/$defs/featureValue", "$defs": schema["$defs"]})

    for value in (5, 0, -2.5, *VALID_RANGES):
        assert not list(validator.iter_errors(value)), value
    rejected = (
        None, "inf", True, [1, 2], {"min": 1}, {"max": None}, {}, {"min": 1, "max": 2, "x": 0},
        {"mni": 1, "max": 2}, {"min": "inf", "max": None}, {"min": True, "max": None},
    )
    for value in rejected:
        assert list(validator.iter_errors(value)), value


# -- The evaluator never reads or coerces a range --------------------------------


@pytest.mark.parametrize("latency", OPEN_RANGES)
def test_the_canonical_evaluator_rejects_a_selected_open_range_with_a_clear_error(demo, latency):
    problem = compile_instance(demo_package(demo, latency))
    with pytest.raises(ValueError) as captured:
        problem.evaluate_binding(DEMO_BINDING)

    message = str(captured.value)
    assert "latency" in message and "catalog/c1a" in message and "interval" in message
    assert "TypeError" not in message and "float" not in message


@pytest.mark.parametrize("latency", OPEN_RANGES)
def test_an_open_range_that_is_not_selected_does_not_affect_evaluation(demo, latency):
    problem = compile_instance(demo_package(demo, 5, alternative=latency))
    assert problem.evaluate_binding(DEMO_BINDING) == {"latency": 25.0}


@pytest.mark.parametrize("extra", OPEN_RANGES)
def test_an_expression_reading_an_open_range_compiles_and_fails_explicitly_at_evaluation(demo, extra):
    problem = compile_instance(demo_package(demo, 5, extra=extra, constraint="tasks.t1.features.extra <= 100"))
    assert problem.evaluate_binding(DEMO_BINDING) == {"latency": 25.0}
    with pytest.raises(ValueError) as captured:
        problem.evaluate_constraints(DEMO_BINDING)

    assert "extra" in str(captured.value) and "interval" in str(captured.value)


@pytest.mark.parametrize("extra", OPEN_RANGES)
def test_comparison_and_arithmetic_over_an_open_range_raise_instead_of_computing(demo, extra):
    for constraint in (
        "tasks.t1.features.extra + 1 <= 100",
        "tasks.t1.features.extra * 2 >= 0",
        "min(tasks.t1.features.extra, 3) <= 3",
        "tasks.t1.features.extra == 3",
    ):
        problem = compile_instance(demo_package(demo, 5, extra=extra, constraint=constraint))
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
def test_selected_candidate_scope_rejects_a_selected_open_range_explicitly(demo, latency):
    value = demo_package(demo, latency)
    application = json.loads(value.files["application.json"])
    application["spec"]["features"]["latency"].update({"scope": "selectedCandidate", "aggregation": "sum"})
    value.files["application.json"] = json.dumps(application).encode()

    with pytest.raises(ValueError, match="interval"):
        compile_instance(value).evaluate_binding(DEMO_BINDING)
