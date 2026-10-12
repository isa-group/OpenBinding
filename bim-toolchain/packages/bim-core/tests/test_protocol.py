"""bim_core.protocol: the bim-engine/v1 contract, its digest and the validation of engine messages."""

import copy
import json
import math

import pytest

from bim_core import ProtocolError, protocol_digest, protocol_document, validate_result
from bim_core import protocol
from bim_core.canonical import digest, digest_bytes
from conftest import GOLDEN_DIR


def solution():
    return {
        "decision": {"kind": "binding", "binding": {"t1": {"resource": "catalog", "id": "c1"}}},
        "features": {"latency": 1.0, "count": 2},
        "objectives": {
            "type": "SINGLE",
            "scalarization": "weighted-sum",
            "components": [
                {"criteria": "latency", "feature": {"resource": "app", "id": "latency"}, "value": 1.0, "loss": 0.5, "weight": 1.0}
            ],
            "penalty": 0.0,
            "score": 0.5,
        },
        "penalties": [0.0],
        "violations": [
            {"constraint": {"resource": "soft", "id": "limit"}, "enforcement": "soft", "penalty": 2.0, "message": "m"}
        ],
    }


def result(**changes):
    value = {"termination": "FEASIBLE", "solutions": [solution()], "provenance": {"engine": "x"}}
    value.update(changes)
    return value


def edited(change):
    value = result()
    change(value["solutions"][0])
    return value


def refusal(payload, **options):
    with pytest.raises(ProtocolError) as caught:
        validate_result(payload, **options)
    assert isinstance(caught.value, ValueError)
    assert caught.value.as_dict() == {"code": caught.value.code, "message": str(caught.value)}
    return caught.value


# -- the contract ----------------------------------------------------------------------------------


def test_the_contract_is_the_bundled_openapi_document() -> None:
    document = protocol_document()

    assert document["openapi"] == "3.1.0"
    assert "/internal/v1/binding-problems" in document["paths"]
    assert "/internal/v1/jobs/{id}" in document["paths"]
    assert protocol_document() == document and protocol_document() is not document


def test_the_protocol_digest_is_the_one_recorded_by_openbinding() -> None:
    golden = json.loads((GOLDEN_DIR / "protocol.json").read_text(encoding="utf-8"))

    assert protocol_digest() == golden["protocolDigest"]
    assert digest(protocol_document()) == golden["engineContract"]["openapiDocument"]


def test_the_protocol_digest_pins_the_binding_problem_schema(monkeypatch) -> None:
    original = protocol_digest()

    monkeypatch.setattr(protocol, "read_schema", lambda name: b"{}")

    assert protocol_digest() != original


def test_the_protocol_digest_follows_the_openapi_document(monkeypatch) -> None:
    original = protocol_digest()
    changed = protocol_document()
    changed["x-test-marker"] = "changed"

    monkeypatch.setattr(protocol, "protocol_document", lambda: changed)

    assert protocol_digest() != original


def test_a_contract_that_is_not_an_object_is_a_protocol_error(monkeypatch) -> None:
    monkeypatch.setattr(protocol, "engine_contract_bytes", lambda: b"- a\n- b\n")

    with pytest.raises(ProtocolError) as caught:
        protocol_document()

    assert caught.value.code == "protocol_document_invalid"


def test_the_bytes_of_the_contract_do_not_depend_on_how_they_are_read() -> None:
    assert digest_bytes(protocol.engine_contract_bytes()).startswith("sha256-")


# -- results -----------------------------------------------------------------------------------------


def test_a_complete_result_is_valid_and_returned_as_it_is() -> None:
    payload = result()

    assert validate_result(payload) is payload
    assert validate_result(payload, finite=True) is payload


@pytest.mark.parametrize("termination", ["OPTIMAL", "FEASIBLE", "INFEASIBLE", "UNKNOWN"])
def test_every_termination_of_the_protocol_is_valid(termination) -> None:
    assert validate_result({"termination": termination, "solutions": []})["termination"] == termination


def test_provenance_is_optional_and_a_solution_is_optional() -> None:
    assert validate_result({"termination": "UNKNOWN", "solutions": []}) == {"termination": "UNKNOWN", "solutions": []}


@pytest.mark.parametrize("payload", [[], "x", 1, None, [result()], True])
def test_a_result_must_be_an_object(payload) -> None:
    assert refusal(payload).code == "result_not_object"


@pytest.mark.parametrize("termination", ["optimal", "", None, 1, True, ["OPTIMAL"], {"a": 1}, "OPTIMAL "])
def test_the_termination_must_be_one_of_the_four_names(termination) -> None:
    assert refusal(result(termination=termination)).code == "invalid_termination"


def test_a_missing_termination_is_invalid() -> None:
    assert refusal({"solutions": []}).code == "invalid_termination"


@pytest.mark.parametrize("solutions", [None, {}, "x", 1, ()])
def test_solutions_must_be_an_array(solutions) -> None:
    assert refusal(result(solutions=solutions)).code == "solutions_missing"
    assert refusal({"termination": "UNKNOWN"}).code == "solutions_missing"


@pytest.mark.parametrize(
    "change",
    [
        lambda s: s.pop("penalties"),
        lambda s: s.pop("decision"),
        lambda s: s.__setitem__("rank", 1),
        lambda s: s.__setitem__("decision", []),
        lambda s: s.__setitem__("decision", {"kind": "binding"}),
        lambda s: s["decision"].__setitem__("note", "x"),
        lambda s: s["decision"].__setitem__("kind", "plan"),
        lambda s: s["decision"].__setitem__("binding", []),
        lambda s: s["decision"].__setitem__("binding", {"t1": "catalog/c1"}),
        lambda s: s["decision"]["binding"].__setitem__("t1", {"resource": "catalog"}),
        lambda s: s["decision"]["binding"].__setitem__("t1", {"resource": "", "id": "c1"}),
        lambda s: s["decision"]["binding"].__setitem__("t1", {"resource": "catalog", "id": ""}),
        lambda s: s["decision"]["binding"].__setitem__("t1", {"resource": "catalog", "id": "c1", "x": 1}),
        lambda s: s["decision"]["binding"].__setitem__("t1", {"resource": "catalog", "id": 1}),
    ],
)
def test_a_solution_has_exactly_five_fields_and_a_closed_binding(change) -> None:
    assert refusal(edited(change)).code == "solution_decision_invalid"


def test_a_solution_must_be_an_object() -> None:
    assert refusal(result(solutions=[1])).code == "solution_decision_invalid"
    assert refusal(result(solutions=[solution(), None])).code == "solution_decision_invalid"


@pytest.mark.parametrize(
    "features",
    [[], None, "x", {"latency": "1"}, {"latency": None}, {"latency": True}, {"latency": [1]}, {"latency": {"min": 1}}],
)
def test_features_are_an_object_of_numbers(features) -> None:
    assert refusal(edited(lambda s: s.__setitem__("features", features))).code == "solution_features_invalid"


def test_features_may_be_empty_and_integers_are_numbers() -> None:
    validate_result(edited(lambda s: s.__setitem__("features", {})))
    validate_result(edited(lambda s: s.__setitem__("features", {"a": 1, "b": -2.5, "c": 0})))


@pytest.mark.parametrize(
    "change",
    [
        lambda o: o.pop("score"),
        lambda o: o.__setitem__("extra", 1),
        lambda o: o.__setitem__("type", "NONE"),
        lambda o: o.__setitem__("type", ["SINGLE"]),
        lambda o: o.__setitem__("scalarization", 3),
        lambda o: o.__setitem__("components", {}),
        lambda o: o.__setitem__("penalty", "0"),
        lambda o: o.__setitem__("penalty", True),
        lambda o: o.__setitem__("penalty", -0.1),
        lambda o: o.__setitem__("score", "0.5"),
        lambda o: o.__setitem__("score", None),
        lambda o: o.__setitem__("score", [0.5, "x"]),
        lambda o: o.__setitem__("score", [True]),
    ],
)
def test_objectives_are_a_closed_canonical_evaluation(change) -> None:
    assert refusal(edited(lambda s: change(s["objectives"]))).code == "solution_objectives_invalid"


def test_objectives_is_an_object() -> None:
    assert refusal(edited(lambda s: s.__setitem__("objectives", []))).code == "solution_objectives_invalid"


@pytest.mark.parametrize("score", [0.5, 0, -3, [0.1, 0.2], []])
def test_the_score_is_a_number_or_a_vector_of_numbers(score) -> None:
    validate_result(edited(lambda s: s["objectives"].__setitem__("score", score)))


@pytest.mark.parametrize(
    "change",
    [
        lambda c: c.pop("loss"),
        lambda c: c.__setitem__("extra", 1),
        lambda c: c.__setitem__("criteria", 1),
        lambda c: c.__setitem__("feature", {"resource": "app"}),
        lambda c: c.__setitem__("feature", "app/latency"),
        lambda c: c.__setitem__("value", "1"),
        lambda c: c.__setitem__("loss", None),
        lambda c: c.__setitem__("weight", -1),
        lambda c: c.__setitem__("weight", True),
    ],
)
def test_objective_components_are_closed(change) -> None:
    assert refusal(edited(lambda s: change(s["objectives"]["components"][0]))).code == "objective_component_invalid"


def test_a_component_must_be_an_object() -> None:
    assert refusal(edited(lambda s: s["objectives"].__setitem__("components", [1]))).code == "objective_component_invalid"


@pytest.mark.parametrize("penalties", [{}, None, "x", [-1], [True], ["1"], [None], [0, -0.5]])
def test_penalties_are_an_array_of_non_negative_numbers(penalties) -> None:
    assert refusal(edited(lambda s: s.__setitem__("penalties", penalties))).code == "penalties_invalid"


def test_penalties_may_be_empty() -> None:
    validate_result(edited(lambda s: s.__setitem__("penalties", [])))


@pytest.mark.parametrize("violations", [{}, None, "x", 3])
def test_violations_must_be_an_array(violations) -> None:
    assert refusal(edited(lambda s: s.__setitem__("violations", violations))).code == "violations_not_array"


@pytest.mark.parametrize(
    "violation",
    [
        1,
        {},
        {"constraint": {"resource": "s", "id": "l"}, "enforcement": "soft"},
        {"constraint": {"resource": "s", "id": "l"}, "enforcement": "hard", "penalty": 0, "extra": 1},
        {"constraint": {"resource": "s", "id": "l"}, "enforcement": "medium", "penalty": 0},
        {"constraint": {"resource": "s", "id": "l"}, "enforcement": ["hard"], "penalty": 0},
        {"constraint": {"resource": "s"}, "enforcement": "hard", "penalty": 0},
        {"constraint": {"resource": "s", "id": "l"}, "enforcement": "hard", "penalty": -1},
        {"constraint": {"resource": "s", "id": "l"}, "enforcement": "hard", "penalty": True},
        {"constraint": {"resource": "s", "id": "l"}, "enforcement": "hard", "penalty": 0, "message": 3},
    ],
)
def test_a_violation_needs_constraint_enforcement_and_penalty_and_nothing_else(violation) -> None:
    assert refusal(edited(lambda s: s.__setitem__("violations", [violation]))).code == "violation_invalid"


def test_a_violation_without_a_message_is_valid() -> None:
    violation = {"constraint": {"resource": "s", "id": "l"}, "enforcement": "hard", "penalty": 0}

    validate_result(edited(lambda s: s.__setitem__("violations", [violation])))


@pytest.mark.parametrize("extra", [{"elapsed": 1}, {"error": "x"}, {"Termination": "x"}])
def test_the_result_has_no_other_fields_than_the_protocol_defines(extra) -> None:
    assert refusal(result(**extra)).code == "unknown_fields"


@pytest.mark.parametrize("provenance", ["x", [], None, 1])
def test_provenance_must_be_an_object(provenance) -> None:
    assert refusal(result(provenance=provenance)).code == "provenance_invalid"


def test_validation_does_not_modify_the_payload() -> None:
    payload = result()
    before = copy.deepcopy(payload)

    validate_result(payload)

    assert payload == before


def test_the_messages_are_the_ones_of_the_platform() -> None:
    assert str(refusal([])) == "engine response must be an object"
    assert str(refusal(result(termination="x"))) == "engine response has an invalid termination"
    assert str(refusal(result(solutions=1))) == "engine response must contain a solutions array"
    assert str(refusal(result(extra=1))) == "engine response contains fields outside bim-engine/v1"


# -- non-finite numbers ------------------------------------------------------------------------------


@pytest.mark.parametrize("value", [math.nan, math.inf, -math.inf])
@pytest.mark.parametrize(
    "place",
    ["feature", "penalty", "score", "score_vector", "loss", "provenance", "violation_penalty"],
)
def test_finite_mode_rejects_a_non_finite_number_wherever_it_is(place, value) -> None:
    def put(solution_, provenance):
        if place == "feature":
            solution_["features"]["latency"] = value
        elif place == "penalty":
            solution_["objectives"]["penalty"] = value
        elif place == "score":
            solution_["objectives"]["score"] = value
        elif place == "score_vector":
            solution_["objectives"]["score"] = [0.0, value]
        elif place == "loss":
            solution_["objectives"]["components"][0]["loss"] = value
        elif place == "violation_penalty":
            solution_["violations"][0]["penalty"] = value
        else:
            provenance["elapsed"] = value

    payload = result()
    put(payload["solutions"][0], payload["provenance"])

    assert refusal(payload, finite=True).code == "non_finite_number"


@pytest.mark.parametrize("value", [math.nan, math.inf])
def test_the_default_mode_accepts_what_the_transport_already_refused(value) -> None:
    # Same as the platform: strict_json_loads rejects NaN/Infinity while parsing, so the structural
    # check does not repeat it.  Hosts that did not parse strictly pass finite=True.
    payload = edited(lambda s: s["features"].__setitem__("latency", value))

    assert validate_result(payload) is payload


def test_contains_non_finite_handles_deep_nesting_without_recursion() -> None:
    nested: object = [math.nan]
    for _ in range(50_000):
        nested = [nested]

    assert protocol.contains_non_finite(nested) is True
    assert protocol.contains_non_finite([[1.0, {"a": (2, 3.5)}]]) is False


# -- jobs --------------------------------------------------------------------------------------------


def test_a_receipt_carries_the_job_id() -> None:
    assert protocol.validate_job_receipt({"id": "job-1", "status": "queued"}) == "job-1"


@pytest.mark.parametrize(
    "receipt",
    [
        None, [], "job-1", {}, {"id": "job-1"}, {"status": "queued"},
        {"id": "", "status": "queued"}, {"id": 1, "status": "queued"},
        {"id": "job-1", "status": "running"}, {"id": "job-1", "status": "queued", "x": 1},
    ],
)
def test_a_receipt_is_exactly_id_and_queued(receipt) -> None:
    with pytest.raises(ProtocolError) as caught:
        protocol.validate_job_receipt(receipt)

    assert caught.value.code == "job_receipt_invalid"


def job(**changes):
    value = {"id": "job-1", "status": "completed", "created_at": 1700000000, "result": result()}
    value.update(changes)
    return value


@pytest.mark.parametrize("status", ["queued", "running"])
def test_a_job_that_is_not_finished_has_no_result_yet(status) -> None:
    assert protocol.validate_job({"id": "job-1", "status": status, "created_at": 0}, "job-1") is None


def test_a_completed_job_returns_its_validated_result() -> None:
    value = job()

    assert protocol.validate_job(value, "job-1") is value["result"]


def test_a_completed_job_with_an_invalid_result_is_refused_with_the_code_of_the_result() -> None:
    with pytest.raises(ProtocolError) as caught:
        protocol.validate_job(job(result={"termination": "x", "solutions": []}), "job-1")

    assert caught.value.code == "invalid_termination"


def test_a_failed_job_reports_the_engine_message() -> None:
    failed = {"id": "job-1", "status": "failed", "created_at": 5, "error": "out of memory"}

    with pytest.raises(ProtocolError) as caught:
        protocol.validate_job(failed, "job-1")
    assert (caught.value.code, str(caught.value)) == ("engine_job_failed", "out of memory")
    with pytest.raises(ProtocolError, match="remote engine failed"):
        protocol.validate_job({**failed, "error": ""}, "job-1")


@pytest.mark.parametrize(
    "payload",
    [
        {"id": "other", "status": "queued", "created_at": 0},
        {"id": "job-1", "status": "queued", "created_at": -1},
        {"id": "job-1", "status": "queued", "created_at": True},
        {"id": "job-1", "status": "queued", "created_at": 1.5},
        {"id": "job-1", "status": "queued", "created_at": "0"},
        {"id": "job-1", "status": "paused", "created_at": 0},
        {"id": "job-1", "status": ["queued"], "created_at": 0},
        {"id": "job-1", "status": "queued", "created_at": 0, "result": {}},
        {"id": "job-1", "status": "running", "created_at": 0, "error": "x"},
        {"id": "job-1", "status": "failed", "created_at": 0},
        {"id": "job-1", "status": "failed", "created_at": 0, "error": 3},
        {"id": "job-1", "status": "completed", "created_at": 0},
        {"id": "job-1", "status": "completed", "created_at": 0, "result": result(), "error": "x"},
    ],
)
def test_a_polled_job_must_satisfy_the_engine_job_shape(payload) -> None:
    with pytest.raises(ProtocolError) as caught:
        protocol.validate_job(payload, "job-1")

    assert caught.value.code == "job_invalid"


def test_a_polled_job_must_be_an_object() -> None:
    with pytest.raises(ProtocolError) as caught:
        protocol.validate_job([], "job-1")

    assert caught.value.code == "job_not_object"


def test_a_job_can_be_validated_in_finite_mode() -> None:
    poisoned = job(result=result(provenance={"elapsed": math.nan}))

    protocol.validate_job(poisoned, "job-1")
    with pytest.raises(ProtocolError) as caught:
        protocol.validate_job(poisoned, "job-1", finite=True)

    assert caught.value.code == "non_finite_number"
