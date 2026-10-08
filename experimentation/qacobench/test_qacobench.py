from __future__ import annotations

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

from _common import ACTIVE_SUITES, EXPECTED_TOTAL, stable_instance_seed
from campaign import _normalized_result, _resume_key
from evaluate_results import main as evaluate_main


def test_release_registry_and_seed_are_stable() -> None:
    assert ACTIVE_SUITES == ("01_icws", "02_quantum", "03_hsc_llm", "04_rprsr15", "05_iots", "06_bws_scp", "07_qfbs")
    assert EXPECTED_TOTAL == 15_450
    first = stable_instance_seed(20260927, "07_qfbs", "guaranteed/case", "random-search")
    assert first == stable_instance_seed(20260927, "07_qfbs", "guaranteed/case", "random-search")
    assert first != stable_instance_seed(20260927, "07_qfbs", "guaranteed/case", "evolutionary-heuristics")


def test_gateway_result_and_resume_key_follow_public_contract() -> None:
    data = {"status": "completed", "result": {"termination": "FEASIBLE", "solutions": [{"decision": {"binding": {"t": {"resource": "catalog", "id": "c"}}}, "objectives": {"score": 4.0}}], "provenance": {"engineReported": {"elapsed_ms": 3, "trace": [{"eval_index": 1, "elapsed_ms": 1, "best_objective": 4.0}]}}}}
    parsed = _normalized_result(data, 5)
    assert parsed["binding"]["t"]["id"] == "c"
    assert parsed["quality"] == 4.0
    assert parsed["trace"][0]["eval_index"] == 1
    rejected = _normalized_result({"status": "failed", "result": {
        "termination": "UNKNOWN", "solutions": [],
        "error": "engine rejected BindingProblem (422)"}}, 5)
    assert rejected["status"] == "INCOMPATIBLE"
    assert rejected["error"] == "engine rejected BindingProblem (422)"
    record = {"suite": "07_qfbs", "instance_id": "guaranteed/case", "engine": "random-search", "timeout_ms": 5000, "seed": 7, "package_digest": "sha256-a"}
    assert _resume_key(record) == ("07_qfbs", "guaranteed/case", "random-search", 5000, 7, "sha256-a")


def test_light_evaluation_counts_returned_bindings(tmp_path, monkeypatch) -> None:
    import csv
    import json

    datasets = tmp_path / "datasets/07_qfbs"
    datasets.mkdir(parents=True)
    (datasets / "manifest.jsonl").write_text(json.dumps({
        "package_path": "guaranteed/cell_00/case", "group": "guaranteed"
    }) + "\n")
    results = tmp_path / "results.jsonl"
    results.write_text(json.dumps({
        "suite": "07_qfbs", "instance_id": "guaranteed/cell_00/case",
        "engine": "random-search", "status": "FEASIBLE",
        "binding": {"task": {"resource": "catalog", "id": "candidate"}},
        "runtime_ms": 12,
    }) + "\n")
    output = tmp_path / "evaluation"
    monkeypatch.setattr(sys, "argv", [
        "evaluate_results.py", str(results), "--datasets-root", str(tmp_path / "datasets"),
        "--out-dir", str(output),
    ])
    assert evaluate_main() == 0
    with (output / "outcomes_by_suite_engine.csv").open() as stream:
        row = next(csv.DictReader(stream))
    assert row["suite"] == "07_qfbs"
    assert row["binding_returned"] == "1"


def test_qfbs_design_and_requests_match_the_two_groups() -> None:
    import collections
    import itertools
    from generate_qfbs import DESIGN, cases, request_for

    generated = list(cases())
    assert len(generated) == 5200
    assert collections.Counter(item[0] for item in generated) == {"guaranteed": 2600, "non_guaranteed": 2600}
    assert len({(item[0], item[1], item[2]) for item in generated}) == 5200
    rows = [item["levels"] for item in DESIGN["configurations"][:24]]
    levels = (8, 3, 3, 2, 3, 3, 2, 3, 3)
    for i, j in itertools.combinations(range(len(levels)), 2):
        assert {(row[i], row[j]) for row in rows} == set(itertools.product(range(levels[i]), range(levels[j])))
    for left, right in zip(generated[:2600], generated[2600:]):
        assert left[1:] == right[1:]
        requests = [request_for(row, seed, "pilot", group=group) for group, cell, trial, row, seed in (left, right)]
        assert "tension" in requests[0] and "tension" not in requests[1]
        assert "constraint_optimality_percent" not in requests[0].get("distributions", {})
        assert "constraint_optimality_percent" in requests[1]["distributions"]
        assert all("dialects" not in request for request in requests)
