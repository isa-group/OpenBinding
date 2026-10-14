"""Tests of ``tools/engine_e2e.py``: the honest classification and the end-to-end run against a REAL local engine.

Nothing here is simulated at the HTTP or process level: ``engines/minizinc-csp`` is started with ``node`` and its
solver is ``tests/fake_minizinc.mjs`` (a real child process, with a grandchild, that burns CPU), and the checks of
the cancellation read ``/proc``. What is *not* exercised is the MiniZinc model itself: that needs the real
``minizinc`` and runs in the laboratory (``compose.lab-engines.json``).
"""

from __future__ import annotations

import contextlib
import json
import shutil
from pathlib import Path

import engine_e2e
import pytest

from bim_client import InProcessBim

FAKE = engine_e2e.ENGINE_DIR / "tests" / "fake_minizinc.mjs"
FIXTURE = engine_e2e.ENGINE_DIR / "tests" / "fixtures" / "simple-sequence"
TOKEN_A = "tenant-a-token-0123456789"
TOKEN_B = "tenant-b-token-0123456789"


@pytest.fixture(scope="module")
def minimal():
    bim = InProcessBim()
    ir = engine_e2e.compile_files(bim, engine_e2e.minimal_files())
    optimization = engine_e2e.execution_optimization(ir)
    return bim, ir, optimization, engine_e2e.exhaustive_best(bim, ir, optimization)


@contextlib.contextmanager
def local_engine(env: dict[str, str]):
    assert shutil.which("node"), "node is required to run the engine under test"
    engine = engine_e2e.LocalEngine(engine_e2e.ENGINE_DIR, env)
    engine.start()
    try:
        yield engine
    finally:
        engine.stop()


def fake_env(stdout: Path | None = None, **extra: str) -> dict[str, str]:
    env = {"MINIZINC_COMMAND": json.dumps(["node", str(FAKE)]), **extra}
    if stdout is not None:
        env["FAKE_MINIZINC_STDOUT_FILE"] = str(stdout)
    return env


def steps_of(report: dict, prefix: str) -> list[dict]:
    return [step for step in report["steps"] if step["name"].startswith(prefix)]


def run_json(argv: list[str], capsys) -> tuple[int, dict]:
    code = engine_e2e.main([*argv, "--json"])
    return code, json.loads(capsys.readouterr().out)


def solve_result(tmp_path: Path, text: str) -> Path:
    path = tmp_path / "stdout.txt"
    path.write_text(text, encoding="utf-8")
    return path


# -- The packages ---------------------------------------------------------------------------------------------------


def test_the_minimal_package_is_the_engine_fixture_and_compiles_to_a_normalized_ir(minimal):
    _, ir, optimization, exhaustive = minimal
    assert ir["kind"] == "BindingProblem" and ir["apiVersion"] == "bim/v1"
    assert set(ir["spec"]["eligibility"]) == {"t1", "t2", "t3"}
    assert optimization == {
        "type": "SINGLE", "scalarization": "weighted-sum", "weights": [{"criteria": "latency", "value": 1.0}]
    }
    assert exhaustive is not None and exhaustive.size == 2
    assert exhaustive.binding["t1"]["id"] == "c1a"  # 10 ms beats 20 ms
    for name, content in engine_e2e.minimal_files().items():
        on_disk = json.loads((FIXTURE / name).read_text(encoding="utf-8"))
        if name == "instance.json":
            assert json.loads(content)["spec"] == on_disk["spec"]
        else:
            assert json.loads(content) == on_disk, name


def test_the_hard_package_for_a_real_solver_compiles(minimal):
    bim = minimal[0]
    ir = engine_e2e.compile_files(bim, engine_e2e.hard_files(4, 3))
    assert len(ir["spec"]["eligibility"]) == 4
    assert ir["spec"]["constraints"], "the hard budget constraint reached the IR"
    assert engine_e2e.exhaustive_best(bim, ir, engine_e2e.execution_optimization(ir), limit=10) is None  # too big to enumerate


def test_the_canned_incumbent_indexes_the_candidates_in_the_engine_order(minimal):
    _, ir, _, exhaustive = minimal
    text = engine_e2e.canned_stdout(ir, exhaustive.binding, exhaustive.score)
    incumbent = json.loads(text.split("\n", 1)[0])
    assert incumbent["selected_cand"] == [1, 3, 4]  # c1a, c2a, c3a in catalog order
    assert incumbent["objective_value"] == exhaustive.score
    assert text.endswith("----------\n==========\n")


# -- The classification ---------------------------------------------------------------------------------------------


def reevaluated(minimal, termination: str, binding: dict | None = None, allowed=("OPTIMAL", "FEASIBLE", "INFEASIBLE", "UNKNOWN")):
    bim, ir, optimization, exhaustive = minimal
    raw = {
        "termination": termination,
        "solutions": [] if binding is False else [{"decision": {"kind": "binding", "binding": binding or exhaustive.binding}}],
        "provenance": {},
    }
    return raw, bim.reevaluate(ir, raw, optimization, list(allowed))


def worse_binding(minimal) -> dict:
    exhaustive = minimal[3]
    other = next(ref for ref in minimal[1]["spec"]["eligibility"]["t1"] if ref != exhaustive.binding["t1"])
    return {**exhaustive.binding, "t1": other}


def test_an_optimal_result_is_optimal_only_when_it_is_demonstrated(minimal):
    raw, verified = reevaluated(minimal, "OPTIMAL")
    outcome = engine_e2e.classify(raw, verified, minimal[3], real_solver=False)
    assert (outcome["classification"], outcome["proof"]) == ("optimal", "exhaustive-enumeration")

    unproven = engine_e2e.classify(raw, verified, None, real_solver=False)
    assert unproven["classification"] == "feasible" and unproven["proof"] == "none"  # a fake solver proves nothing
    assert "cannot be demonstrated" in " ".join(unproven["notes"])
    trusted = engine_e2e.classify(raw, verified, None, real_solver=True)
    assert (trusted["classification"], trusted["proof"]) == ("optimal", "solver-claim-allowed-by-mode")


def test_an_engine_that_claims_optimal_with_a_worse_binding_is_inconsistent(minimal):
    raw, verified = reevaluated(minimal, "OPTIMAL", worse_binding(minimal))
    outcome = engine_e2e.classify(raw, verified, minimal[3], real_solver=True)
    assert outcome["classification"] == "inconsistent"
    assert "exists" in " ".join(outcome["notes"])


def test_a_mode_that_does_not_guarantee_optimal_gets_the_claim_lowered_to_feasible(minimal):
    raw, verified = reevaluated(minimal, "OPTIMAL", allowed=engine_e2e.CONSERVATIVE_TERMINATIONS)
    outcome = engine_e2e.classify(raw, verified, minimal[3], real_solver=True)
    assert raw["termination"] == "OPTIMAL" and verified["termination"] == "UNKNOWN"
    assert outcome["classification"] == "feasible"  # a valid decision, but nothing is promised about its quality
    assert "re-evaluation changed the termination OPTIMAL -> UNKNOWN" in " ".join(outcome["notes"])


def test_feasible_infeasible_and_unknown_are_never_labelled_optimal(minimal):
    raw, verified = reevaluated(minimal, "FEASIBLE")
    feasible = engine_e2e.classify(raw, verified, minimal[3], real_solver=True)
    assert feasible["classification"] == "feasible"
    assert "did not prove" in " ".join(feasible["notes"])

    raw, verified = reevaluated(minimal, "INFEASIBLE", binding=False)
    assert engine_e2e.classify(raw, verified, minimal[3], real_solver=True)["classification"] == "infeasible"

    raw, verified = reevaluated(minimal, "UNKNOWN", binding=False)
    assert engine_e2e.classify(raw, verified, minimal[3], real_solver=True)["classification"] == "unknown"


def test_a_decision_the_reevaluation_rejects_is_not_feasible(minimal):
    ineligible = {**minimal[3].binding, "t1": {"resource": "catalog", "id": "c3a"}}
    raw, verified = reevaluated(minimal, "FEASIBLE", ineligible)
    assert engine_e2e.classify(raw, verified, minimal[3], real_solver=True)["classification"] == "unknown"


# -- A real engine, a real solver process ---------------------------------------------------------------------------


def test_everything_against_a_local_engine_with_the_fake_solver(capsys):
    code, report = run_json(["--fake-minizinc", "--scenario", "all", "--expect", "optimal"], capsys)

    failed = [step for step in report["steps"] if step["status"] != "passed"]
    assert code == 0 and report["ok"] and failed == [], failed
    names = {step["name"] for step in report["steps"]}
    for expected in (
        "registration: the OpenAPI conforms to the installed bim-engine/v1",
        "registration: the gateway reads cancellation (idScope attempt) as supported",
        "registration: an OpenAPI that does not describe DELETE turns the capability off",
        "solve: result re-evaluated by bim_core and classified optimal",
        "cancel: before the DELETE the solver group burns CPU",
        "cancel: the solver process group is gone and reaped (no live member, no zombie child of the engine)",
        "cancel: the CPU is free (nothing of the group runs and the engine is idle)",
        "cancel: DELETE is idempotent (repeating it answers the same 200 cancelled)",
        "cancel: another tenant gets the same 404 as for an unknown id, for GET and DELETE",
        "shutdown: SIGTERM to the engine stops the solver it still had running",
    ):
        assert expected in names, expected
    solved = steps_of(report, "solve: result re-evaluated")[0]["data"]
    assert (solved["classification"], solved["proof"]) == ("optimal", "exhaustive-enumeration")
    assert solved["engine_termination"] == "OPTIMAL" and solved["verified_termination"] == "OPTIMAL"


def test_a_worse_binding_claimed_optimal_fails_the_run(tmp_path, minimal, capsys):
    bim, ir, optimization, _ = minimal
    worse = worse_binding(minimal)
    score = float(bim.evaluate(ir, worse, optimization)["objectives"]["score"])
    result = solve_result(tmp_path, engine_e2e.canned_stdout(ir, worse, score))
    with local_engine(fake_env(result)) as engine:
        code, report = run_json(["--url", engine.url, "--scenario", "solve"], capsys)

    assert code == 1 and not report["ok"]
    step = steps_of(report, "solve: result re-evaluated")[0]
    assert step["status"] == "failed" and step["data"]["classification"] == "inconsistent"
    assert step["data"]["engine_termination"] == "OPTIMAL"


def test_a_result_without_proof_is_feasible_even_if_it_is_the_optimum(tmp_path, minimal, capsys):
    _, ir, _, exhaustive = minimal
    text = engine_e2e.canned_stdout(ir, exhaustive.binding, exhaustive.score).replace("==========\n", "")
    with local_engine(fake_env(solve_result(tmp_path, text))) as engine:
        code, report = run_json(["--url", engine.url, "--scenario", "solve"], capsys)
        expecting_optimal, _ = run_json(["--url", engine.url, "--scenario", "solve", "--expect", "optimal"], capsys)

    assert code == 0
    data = steps_of(report, "solve: result re-evaluated")[0]["data"]
    assert (data["engine_termination"], data["classification"]) == ("FEASIBLE", "feasible")
    assert expecting_optimal == 1


@pytest.mark.parametrize(
    ("text", "label", "termination"),
    [("=====UNKNOWN=====\n", "unknown", "UNKNOWN"), ("=====UNSATISFIABLE=====\n", "infeasible", "INFEASIBLE")],
)
def test_no_solution_and_proven_infeasible_are_reported_as_such(tmp_path, capsys, text, label, termination):
    with local_engine(fake_env(solve_result(tmp_path, text))) as engine:
        code, report = run_json(["--url", engine.url, "--scenario", "solve"], capsys)

    data = steps_of(report, "solve: result re-evaluated")[0]["data"]
    assert code == 0 and (data["engine_termination"], data["classification"]) == (termination, label)


def test_a_url_target_lists_the_process_checks_as_not_executed_and_rejects_nothing_else(capsys):
    env = fake_env(FAKE_MINIZINC_MODE="hang", ENGINE_AUTH_TOKENS=f"tenant-a={TOKEN_A},tenant-b={TOKEN_B}")
    with local_engine(env) as engine:
        code, report = run_json(
            ["--url", engine.url, "--scenario", "cancel", "--token", TOKEN_A, "--token-b", TOKEN_B,
             "--tasks", "3", "--candidates", "2"],
            capsys,
        )

    statuses = {step["name"]: step["status"] for step in report["steps"]}
    assert statuses["cancel: process checks (CPU, group, zombies)"] == "not-executed"
    assert [name for name, status in statuses.items() if status not in ("passed", "not-executed")] == []
    assert statuses["cancel: DELETE answers 200 cancelled (202 cancelling only while the solver is not confirmed gone)"] == "passed"
    assert code == 0


class Reply:
    def __init__(self, status: int, body: dict) -> None:
        self.status_code, self._body, self.text = status, body, json.dumps(body)

    def json(self) -> dict:
        return self._body


class FinishedEngine:
    """An engine whose job is already over when the harness looks: there is nothing long to cancel."""

    def submit(self, ir, optimization, options):
        return Reply(202, {"id": "job-1", "status": "queued"})

    def job(self, job_id):
        return Reply(200, {"id": job_id, "status": "completed", "created_at": 1, "result": {}})

    def cancel(self, job_id):
        raise AssertionError("a job that is not running is not cancelled")


def test_a_job_that_finishes_before_the_delete_is_inconclusive_not_passed(minimal):
    report = engine_e2e.Report("stub")

    engine_e2e.scenario_cancel(report, FinishedEngine(), None, minimal[1], minimal[2], engine_pid=None, timeout=2.0)

    assert not report.ok
    assert [step.status for step in report.steps if step.name.startswith("cancel: the job is running")] == ["inconclusive"]
    assert all(step.status != "passed" for step in report.steps if "DELETE" in step.name)


def test_an_unreachable_engine_is_reported_as_unavailable_not_as_a_pass(capsys):
    code = engine_e2e.main(["--fake-minizinc", "--engine-dir", "/nonexistent-engine-dir", "--scenario", "registration"])
    assert code == 2
    assert "cannot run" in capsys.readouterr().err
