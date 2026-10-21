"""The consumer fixtures of OpenBinding: what the platform sends to BIM and what it expects back.

``contracts/consumers/openbinding/*.json`` are written by ``tools/consumer_fixtures.py``.  A missing one is
created by this test, which fails once to say so (the new files must be reviewed and committed); the others are
replayed against the service and must still be answered as recorded.
"""

from __future__ import annotations

import pytest
from service_support import BASE_URL, TOOLCHAIN_ROOT, bearer
from starlette.testclient import TestClient

import consumer_fixtures as fixtures


def executor(client: TestClient):
    def execute(method: str, path: str, body):
        response = client.request(method, path, json=body)
        return response.status_code, response.json()

    return execute


@pytest.fixture
def execute(make_app):
    return executor(TestClient(make_app(), base_url=BASE_URL, headers=bearer()))


def test_the_fixtures_exist_or_are_created(execute) -> None:
    missing = sorted(set(fixtures.scripts()) - set(fixtures.load_fixtures()))
    if not missing:
        return
    fixtures.FIXTURE_DIR.mkdir(parents=True, exist_ok=True)
    built = fixtures.build_fixtures(execute)
    for name in missing:
        (fixtures.FIXTURE_DIR / f"{name}.json").write_bytes(fixtures.dump(built[name]))
    created = ", ".join(f"{name}.json" for name in missing)
    pytest.fail(f"consumer fixtures created in {fixtures.FIXTURE_DIR.relative_to(TOOLCHAIN_ROOT)}: {created}; review and commit")


def test_there_is_a_fixture_for_every_interaction() -> None:
    assert set(fixtures.load_fixtures()) == set(fixtures.scripts()) == {
        "compile", "compatibility", "optimization", "evaluate",
        "reevaluate-agreement", "reevaluate-discrepancy", "validate-result",
    }  # fmt: skip


def test_the_recorded_requests_are_the_ones_the_scripts_produce() -> None:
    committed = fixtures.load_fixtures()
    for name, script in fixtures.scripts().items():
        recorded = [{key: step[key] for key in ("id", "description", "request")} for step in committed[name]["steps"]]
        assert recorded == script["steps"], name
        assert committed[name]["schema"] == fixtures.SCHEMA and committed[name]["consumer"] == "openbinding"


def test_no_fixture_embeds_an_ir() -> None:
    """An IR pins the toolchain that made it; the fixtures must outlive a change of compilerDigest."""
    for name, fixture in fixtures.load_fixtures().items():
        text = fixtures.dump(fixture).decode()
        assert '"eligibility"' not in text and '"taskRequiredFeatures"' not in text, name


@pytest.mark.parametrize("name", sorted(fixtures.scripts()))
def test_the_service_still_answers_each_fixture_as_recorded(execute, name: str) -> None:
    fixture = fixtures.load_fixtures()[name]
    assert fixtures.replay(fixture, execute) == []


def test_replay_notices_a_changed_answer(execute) -> None:
    fixture = fixtures.load_fixtures()["validate-result"]
    changed = {**fixture, "steps": [dict(step) for step in fixture["steps"]]}
    changed["steps"][0]["expect"] = {"status": 200, "body": {"valid": False, "error": None}}
    assert fixtures.replay(changed, execute) == ["valid"]


def steps_of(name: str) -> dict:
    return {step["id"]: step for step in fixtures.load_fixtures()[name]["steps"]}


def test_the_compile_fixture_records_the_identity_of_the_package_and_its_findings() -> None:
    steps = steps_of("compile")
    body = steps["compile"]["expect"]["body"]
    assert steps["compile"]["expect"]["status"] == 200
    assert body["ir"]["semanticDigest"].startswith("sha256-") and body["analysis"]["bindingSpaceCardinality"] == "4"
    assert steps["validate"]["expect"]["body"]["valid"] is True and "ir" not in steps["validate"]["expect"]["body"]
    broken = steps["validate-broken"]["expect"]
    assert broken["status"] == 200 and broken["body"]["valid"] is False
    assert broken["body"]["diagnostics"][0]["code"] == "resource_missing"
    assert (steps["compile-broken"]["expect"]["status"], steps["compile-broken"]["expect"]["body"]["code"]) == (422, "compile_error")
    assert steps["compile-not-a-package"]["expect"]["body"]["code"] == "package_error"


def test_the_compatibility_fixture_says_which_modes_can_run_the_demo() -> None:
    steps = steps_of("compatibility")
    assert steps["random-search"]["expect"]["body"]["compatible"] is True
    assert steps["random-search-options"]["expect"]["body"]["options"] == {"iterations": 50, "seed": 7}
    refused = steps["minizinc"]["expect"]["body"]
    assert refused["compatible"] is False
    assert {item["code"] for item in refused["diagnostics"]} == {"unsupported_capability_value"}
    for step, code in (("unknown-mode", "engine_mode_incompatible"), ("unknown-option", "unknown_option")):
        assert steps[step]["expect"]["status"] == 422 and steps[step]["expect"]["body"]["code"] == code


def test_the_optimization_fixture_normalizes_weights_and_refuses_what_the_mode_cannot_do() -> None:
    steps = steps_of("optimization")

    def weights(step: str) -> dict:
        return {item["criteria"]: item["value"] for item in steps[step]["expect"]["body"]["optimization"]["weights"]}

    assert weights("weighted") == {"latency": 0.5, "cost": 0.5}
    assert weights("weighted-explicit") == {"latency": 0.75, "cost": 0.25}
    assert steps["pareto"]["expect"]["body"]["optimization"] == {"type": "MULTI", "scalarization": "pareto-front", "weights": []}
    assert steps["incompatible"]["expect"]["body"]["code"] == "optimization_type_incompatible"


def test_the_evaluate_fixture_reports_a_bad_binding_per_binding_or_as_an_error() -> None:
    steps = steps_of("evaluate")
    collected = steps["collect"]["expect"]["body"]["results"]
    assert "evaluation" in collected[0] and collected[1]["error"]["code"] == "binding_invalid"
    assert steps["raise"]["expect"]["status"] == 422 and steps["raise"]["expect"]["body"]["code"] == "binding_invalid"
    assert steps["neighborhood"]["expect"]["body"]["coverage"]["complete"] is True


def test_the_agreement_fixture_gets_back_the_numbers_the_engine_gave() -> None:
    steps = steps_of("reevaluate-agreement")
    engine = steps["reevaluate"]["request"]["body"]["result"]
    answer = steps["reevaluate"]["expect"]["body"]
    assert answer["termination"] == engine["termination"] == "FEASIBLE"
    assert answer["solutions"] == engine["solutions"]


def test_the_discrepancy_fixture_replaces_the_numbers_and_lowers_the_termination() -> None:
    steps = steps_of("reevaluate-discrepancy")
    engine = steps["reevaluate"]["request"]["body"]["result"]
    answer = steps["reevaluate"]["expect"]["body"]
    claimed, authoritative = engine["solutions"][0], answer["solutions"][0]
    assert claimed["objectives"]["score"] == 0.0 and authoritative["objectives"]["score"] == 0.55
    assert claimed["decision"] == authoritative["decision"]  # the binding is all that survives
    assert claimed["features"] != authoritative["features"]
    assert engine["termination"] == "OPTIMAL" and answer["termination"] == "UNKNOWN"
    trusted = steps["reevaluate-allowed"]["expect"]["body"]
    assert trusted["termination"] == "OPTIMAL" and trusted["solutions"] == answer["solutions"]


def test_the_validate_result_fixture_has_a_valid_answer_and_four_ways_to_be_invalid() -> None:
    steps = steps_of("validate-result")
    assert steps["valid"]["expect"]["body"] == {"valid": True, "error": None}
    codes = {name: step["expect"]["body"]["error"]["code"] for name, step in steps.items() if name != "valid"}
    assert codes == {
        "missing-field": "solution_decision_invalid",
        "extra-field": "unknown_fields",
        "bad-termination": "invalid_termination",
        "not-an-object": "result_not_object",
    }


def test_the_command_line_check_agrees_with_the_committed_fixtures(capsys) -> None:
    assert fixtures.main(["--check"]) == 0
    assert capsys.readouterr().out == ""


def test_the_toolchain_members_are_informative_only() -> None:
    fixture = fixtures.load_fixtures()["compile"]
    compile_step = fixture["steps"][0]
    assert set(compile_step["toolchain"]) == {"compilerDigest", "irDigest"}
    assert "toolchain" not in compile_step["expect"]["body"] and "irDigest" not in compile_step["expect"]["body"]
    stale = {"toolchain": {"compilerDigest": "sha256-other"}, "x": 1}
    assert fixtures.comparable(stale) == {"x": 1}
