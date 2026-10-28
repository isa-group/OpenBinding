from __future__ import annotations

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

from _common import ACTIVE_SUITES, EXPECTED_TOTAL, stable_instance_seed
from campaign import _normalized_result, _resume_key
from evaluate_results import main as evaluate_main

OLD_PREFIX = "engine rejected " + "BindingProblem (422)"


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
        "error": OLD_PREFIX}}, 5)
    assert rejected["status"] == "ERROR"
    assert rejected["error"] == OLD_PREFIX
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


def test_job_failures_are_classified_by_code_never_by_message_text() -> None:
    text = OLD_PREFIX + ": MiniZinc does not support X"
    incompatible = _normalized_result({"status": "failed", "result": {"code": "engine_incompatible", "error": text}}, 5)
    assert incompatible["status"] == "INCOMPATIBLE"
    assert incompatible["error"] == text
    assert incompatible["diagnostics"] == [{"code": "engine_incompatible", "message": text}]
    coded = _normalized_result({"status": "failed", "result": {"code": "engine_rejected", "error": text}}, 5)
    assert coded["status"] == "ERROR"
    assert coded["error"] == text
    assert _normalized_result({"status": "failed", "error": text}, 5)["status"] == "ERROR"
    assert _normalized_result({"status": "failed", "result": {"error": text}}, 5)["status"] == "ERROR"


def test_failed_jobs_without_the_incompatible_code_are_errors_even_without_error_text() -> None:
    silent = _normalized_result({"status": "failed", "result": {"code": "engine_rejected", "termination": "UNKNOWN", "solutions": []}}, 5)
    assert silent["status"] == "ERROR"
    assert silent["error"] == "gateway job failed"
    assert _normalized_result({"status": "failed", "result": {"termination": "OPTIMAL", "solutions": []}}, 5)["status"] == "ERROR"
    completed = _normalized_result({"status": "completed", "result": {"code": "engine_incompatible", "error": "x"}}, 5)
    assert completed["status"] != "INCOMPATIBLE"


def _submit(status_code: int, body: dict) -> dict:
    import asyncio

    import httpx
    from _common import ENGINE_MODES
    from campaign import Gateway

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status_code, json=body)

    gateway = Gateway("http://gw", "u", "p", {})
    modes = [{"engine": {"name": "minizinc-csp"}, "mode": ENGINE_MODES["minizinc-csp"], "compatible": True, "registration": "r"}]

    async def run() -> dict:
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            return await gateway.solve(client, "snap", modes, "minizinc-csp", 1000, 1, "key", {})

    return asyncio.run(run())


def problem(status: int, code: str, detail: str, diagnostics: list | None = None) -> dict:
    """An RFC 7807 problem document shaped like the gateway's `problem_body`."""
    body: dict = {"type": f"https://openbinding.example/problems/{code}", "title": code, "status": status, "code": code, "detail": detail}
    if diagnostics is not None:
        body["diagnostics"] = diagnostics
    return body


def test_submission_refusals_are_classified_by_code() -> None:
    diagnostics = [{"code": "unsupported_feature", "message": "MiniZinc does not support X"}, {"code": "other", "message": "y"}]
    refused = _submit(422, problem(422, "engine_mode_incompatible", "engine cannot run this snapshot", diagnostics))
    assert refused["status"] == "INCOMPATIBLE"
    assert refused["diagnostics"] == diagnostics
    no_list = _submit(422, problem(422, "engine_mode_incompatible", "engine cannot run this snapshot"))
    assert no_list["status"] == "INCOMPATIBLE"
    assert no_list["diagnostics"] == [{"code": "engine_mode_incompatible", "message": "engine cannot run this snapshot"}]
    assert _submit(422, problem(422, "validation_error", "bad"))["status"] == "ERROR"
    assert _submit(400, problem(400, "invalid_option", "bad"))["status"] == "ERROR"
    assert _submit(400, problem(400, "engine_mode_incompatible", "x"))["status"] == "ERROR"
    by_text = _submit(422, problem(422, "validation_error", OLD_PREFIX + ": MiniZinc does not support X"))
    assert by_text["status"] == "ERROR"


def test_submission_refusal_tolerates_a_non_list_diagnostics_field() -> None:
    refused = _submit(422, problem(422, "engine_mode_incompatible", "refused", "not a list"))  # type: ignore[arg-type]
    assert refused["status"] == "INCOMPATIBLE"
    assert refused["diagnostics"] == [{"code": "engine_mode_incompatible", "message": "refused"}]
    assert _submit(422, problem(422, "validation_error", "bad", {"code": "x"}))["status"] == "ERROR"  # type: ignore[arg-type]


def test_submission_refusal_keeps_the_legacy_detail_dict_shape() -> None:
    refused = _submit(422, {"detail": {"code": "engine_mode_incompatible", "message": "not supported"}})
    assert refused["status"] == "INCOMPATIBLE"
    assert refused["diagnostics"] == [{"code": "engine_mode_incompatible", "message": "not supported"}]
    assert _submit(422, {"detail": {"code": "validation_error", "message": "bad"}})["status"] == "ERROR"


def test_reasons_are_classified() -> None:
    from campaign import termination_reason

    assert termination_reason("minizinc-csp", "OPTIMAL", {}, 5000) == "proof"
    assert termination_reason("minizinc-csp", "FEASIBLE", {}, 5000) == "time_budget"
    assert termination_reason("random-search", "FEASIBLE", {"options": {"iterations": 1000}, "engineReported": {"evaluations": 1000, "elapsed_ms": 50}}, 5000) == "evaluation_budget"
    assert termination_reason("evolutionary-heuristics", "FEASIBLE", {"options": {"max_evaluations": 10000}, "engineReported": {"evaluations": 4200, "elapsed_ms": 4990}}, 5000) == "time_budget"


def test_evaluation_reconciles_exact_labels_against_validated_bindings(tmp_path, monkeypatch) -> None:
    import json

    datasets = tmp_path / "datasets/07_qfbs"
    datasets.mkdir(parents=True)
    (datasets / "manifest.jsonl").write_text(
        json.dumps({"package_path": "non_guaranteed/cell_00/case", "group": "non_guaranteed"}) + "\n")
    binding = {"task": {"resource": "catalog", "id": "candidate"}}
    results = tmp_path / "results.jsonl"
    results.write_text("".join(json.dumps(record) + "\n" for record in [
        {"suite": "07_qfbs", "instance_id": "non_guaranteed/cell_00/case", "engine": "minizinc-csp", "status": "UNSAT", "runtime_ms": 1},
        {"suite": "07_qfbs", "instance_id": "non_guaranteed/cell_00/case", "engine": "random-search", "status": "FEASIBLE", "binding": binding, "quality": 0.5, "runtime_ms": 1},
    ]))
    output = tmp_path / "evaluation"
    monkeypatch.setattr(sys, "argv", ["evaluate_results.py", str(results), "--datasets-root", str(tmp_path / "datasets"), "--out-dir", str(output)])
    assert evaluate_main() == 2
    acceptance = json.loads((output / "acceptance.json").read_text())
    assert acceptance["unsat_with_validated_binding"] == 1
    assert acceptance["ok"] is False


def test_recovery_catalogue_provenance_matches_the_paper_bibliography() -> None:
    import json

    root = HERE.parents[1]
    catalogue = json.loads((root / "datasets/recovery_catalogue.json").read_text(encoding="utf-8"))
    sources = {item["suite_id"]: item["source"] for item in catalogue["admitted_suites"]}
    # DOIs of the works cited for each suite in the BenchSOC paper (sample-ceur.bib).
    expected = {
        "01_icws": "10.1109/ICWS72778.2026.00110",
        "03_hsc_llm": "10.1007/978-981-96-0808-9_17",
        "04_rprsr15": "10.1016/j.eswa.2016.10.047",
        "05_iots": "10.1016/j.heliyon.2024.e28087",
        "06_bws_scp": "10.1016/j.cie.2025.111603",
    }
    for suite, doi in expected.items():
        assert sources[suite]["doi"] == doi, suite
    assert sources["02_quantum"]["url"].endswith("zenodo.21442195")
    # Author list of quantum2026 in the paper bibliography (order included).
    assert sources["02_quantum"]["authors"] == [
        "Adrián Romero-Flores", "Alfonso E. Márquez-Chamorro", "José Antonio Parejo", "Antonio Ruiz-Cortés",
    ]
    assert sources["04_rprsr15"]["instance_generator"]["doi"] == "10.1016/j.eswa.2013.12.036"
    assert "Mahroo" in sources["06_bws_scp"]["authors"][0]
    assert sources["03_hsc_llm"]["authors"][0] == "Xiao Wang"
    # Repository named in the abstract of the HSC paper (and the origin of datasets/sources/hsc/*.json).
    assert sources["03_hsc_llm"]["repository"] == "https://github.com/wangxiaohit/HSC"
    readme = (root / "datasets/sources/hsc/README.md").read_text(encoding="utf-8")
    assert "https://github.com/wangxiaohit/HSC" in readme
    transformer = (root / "datasets/scripts/transform_hsc.py").read_text(encoding="utf-8")
    assert "https://github.com/wangxiaohit/HSC" in transformer
