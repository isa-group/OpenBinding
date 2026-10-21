"""IR 0.2.0 conformance and remote cancellation of the JVM engines, against the real ``bim_core``.

Run from ``openbinding-gateway`` (see ``java_engines_ir02.py``).  The tests that need a Java runtime, the
classes ``mvn test`` compiles and the Gson jar of the local Maven repository are skipped with the reason when
one is missing: a skipped test is NOT RUN, never a pass.  The tests of the harness itself (package, brute force,
claim comparison, CPU readings) always run.
"""

from __future__ import annotations

import math
import subprocess
import sys
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

import java_engines_ir02 as e2e  # noqa: E402

SPECS = {spec.name: spec for spec in e2e.ENGINE_SPECS}


@pytest.fixture(scope="module")
def port() -> e2e.BimPort:
    return e2e.BimPort()


@pytest.fixture(scope="module")
def small_ir(port):
    return port.compile(e2e.build_package(tasks=5, candidates=3, seed=e2e.SEED))


@pytest.fixture(scope="module")
def collected():
    """Every engine x case x mode, and every cancellation, run once; shared by the tests below."""
    if not any(e2e.prerequisites(spec)[0] for spec in e2e.ENGINE_SPECS):
        reasons = {spec.name: e2e.prerequisites(spec)[1] for spec in e2e.ENGINE_SPECS}
        pytest.skip(f"NOT RUN: no JVM engine can be launched here: {reasons}")
    return e2e.collect(None, cancellation=True)


def _of(collected, name):
    for item in collected["notRun"]:
        if item["engine"] == name:
            pytest.skip(f"NOT RUN: {name}: {item['reason']}")
    return (
        [case for case in collected["cases"] if case["engine"] == name],
        [item for item in collected["cancellation"] if item["engine"] == name],
    )


# ---------------------------------------------------------------------------------------------------
# The harness itself (always runs)


def test_the_package_compiles_to_the_canonical_ir_of_bim_core_0_2_0(port, small_ir):
    assert port.core_version == "0.2.0"
    assert small_ir["apiVersion"] == "bim/v1" and small_ir["kind"] == "BindingProblem"
    spec = small_ir["spec"]
    assert [item["id"] for item in spec["optimization"]["criteria"]] == ["cost", "latency", "availability"]
    assert sorted(spec["eligibility"]) == ["t1", "t2", "t3", "t4", "t5"]
    assert all(len(refs) == 3 for refs in spec["eligibility"].values())
    assert set(spec["optimization"]) == {"resource", "criteria", "penalties"}
    assert "terms" not in spec["optimization"] and "mode" not in spec["optimization"]


def test_the_package_is_deterministic():
    assert e2e.build_package(tasks=5, candidates=3, seed=1) == e2e.build_package(tasks=5, candidates=3, seed=1)
    assert e2e.build_package(tasks=5, candidates=3, seed=1) != e2e.build_package(tasks=5, candidates=3, seed=2)


def test_the_whole_binding_space_is_enumerated_and_its_optimum_is_the_minimum(port, small_ir):
    execution = e2e.weighted_execution(small_ir)
    truth = e2e.enumerate_space(port, small_ir, execution)
    assert truth.count == 3 ** 5
    scores = [
        item["objectives"]["score"]
        for item in port.evaluate_many(small_ir, list(e2e.bindings(small_ir)), execution)
    ]
    assert truth.best_score == min(scores) and math.isfinite(truth.best_score)
    front = e2e.enumerate_space(port, small_ir, e2e.pareto_execution("MANY")(small_ir)).front
    assert front and not any(e2e.dominates(a, b) for a in front for b in front)


def test_a_truthful_result_agrees_and_a_lie_is_caught_and_never_trusted(port, small_ir):
    execution = e2e.weighted_execution(small_ir)
    binding = next(iter(e2e.bindings(small_ir)))
    evaluation = port.evaluate(small_ir, binding, execution)
    truthful = {
        "termination": "FEASIBLE",
        "solutions": [{
            "decision": {"kind": "binding", "binding": binding},
            "features": evaluation["features"],
            "objectives": evaluation["objectives"],
            "penalties": [],
            "violations": [],
        }],
    }
    assert port.validate_result(truthful)["valid"]
    authoritative = port.reevaluate(small_ir, truthful, execution, ["FEASIBLE", "UNKNOWN"])
    assert e2e.claim_discrepancies(truthful, authoritative) == []

    lie = {
        "termination": "OPTIMAL",
        "solutions": [{
            **truthful["solutions"][0],
            "features": {**evaluation["features"], "cost": 0.0},
            "objectives": {**evaluation["objectives"], "score": -1.0},
        }],
    }
    corrected = port.reevaluate(small_ir, lie, execution, ["FEASIBLE", "UNKNOWN"])
    assert corrected["termination"] != "OPTIMAL", "an exactness the mode does not declare is lowered"
    assert corrected["solutions"][0]["features"] == evaluation["features"], "the claimed QoS is replaced"
    assert corrected["solutions"][0]["objectives"]["score"] == evaluation["objectives"]["score"]
    assert e2e.claim_discrepancies(lie, corrected), "the comparison reports what the engine got wrong"


def test_cpu_readings_from_proc_see_a_busy_thread_and_an_idle_one():
    import os

    before = e2e.process_ticks(os.getpid())
    deadline = time.monotonic() + 0.4
    while time.monotonic() < deadline:
        sum(range(1000))
    busy = e2e.process_ticks(os.getpid()) - before
    assert busy >= 0.15 * e2e.CLOCK_TICKS
    idle_start = e2e.process_ticks(os.getpid())
    time.sleep(0.5)
    assert e2e.process_ticks(os.getpid()) - idle_start <= 0.1 * e2e.CLOCK_TICKS


def test_the_declared_guarantees_of_every_engine_are_heuristic():
    for spec in e2e.ENGINE_SPECS:
        for case in spec.cases:
            guarantees = e2e.declared_guarantees(spec, case.mode_id)
            assert guarantees["exact"] is False, f"{spec.name}/{case.mode_id}"
            assert "OPTIMAL" not in guarantees["termination"] and "INFEASIBLE" not in guarantees["termination"]


# ---------------------------------------------------------------------------------------------------
# The real Java processes


@pytest.mark.parametrize("name", sorted(SPECS))
def test_the_engine_answers_the_ir_in_both_modes_and_bim_core_confirms_every_claim(collected, name):
    cases, _ = _of(collected, name)
    expected = {(case.label, mode) for case in SPECS[name].cases for mode in ("sync", "async")}
    assert {(case["case"], case["mode"]) for case in cases} == expected
    for case in cases:
        where = f"{name}/{case['case']}/{case['mode']}"
        assert case["protocolValid"], (where, case["protocolError"])
        assert case["discrepancies"] == [], where
        assert case["claimedTermination"] in case["declared"]["termination"], where
        assert case["claimedTermination"] != "OPTIMAL" and not case["declared"]["exact"], where
        assert case["reevaluatedTermination"] == case["claimedTermination"], where
        assert case["solutions"] >= 1, where
        assert case["spaceSize"] == 3 ** 5
        if case["bestScore"] is not None:
            # No answer can beat the best binding of the whole space.
            assert case["bestScore"] >= case["spaceBestScore"] - 1e-9, where
        assert case["sameAnswerInBothModes"], f"{where}: the job gave another answer than the synchronous POST"


@pytest.mark.parametrize("name", sorted(SPECS))
def test_cancelling_a_real_job_stops_the_solver_thread_and_its_cpu(collected, name):
    _, runs = _of(collected, name)
    assert len(runs) == len(SPECS[name].cases)
    for run in runs:
        where = f"{name}/{run['case']}"
        assert run["deleteStatus"] == 200, (where, run["deleteBody"])
        assert run["deleteBody"]["status"] == "cancelled" and set(run["deleteBody"]) == {"id", "status"}, where
        assert run["deleteSeconds"] < 10, where
        assert run["processAlive"], where
        # The solver was really working, and after the confirmed cancel it is not.
        assert run["runningCpuSecondsPerSecond"] >= 0.3, (where, run["runningCpuSecondsPerSecond"])
        assert run["afterCancelProcessCpuSeconds"] <= 0.35, (where, run["afterCancelProcessCpuSeconds"])
        if "afterCancelJobThreadCpuSeconds" in run:
            assert run["afterCancelJobThreadCpuSeconds"] <= 0.05, (where, run["afterCancelJobThreadCpuSeconds"])
            assert run["jobThreadRunningCpuSeconds"] >= 0.3, where
        job = run["jobAfterCancel"]
        assert job["status"] == "failed" and job["error"].startswith("cancelled:"), (where, job)
        assert "result" not in job
        assert run["secondDelete"][0] == 200 and run["secondDelete"][1]["status"] == "cancelled", where
        assert run["unknownIdStatus"] == 404, where
        assert run["followUpStatus"] == "completed", f"{where}: the slot was not freed"
        assert run["syncDeleteStatus"] in (404, 405), f"{where}: a synchronous engine must not expose DELETE"
        assert run["syncPostStatus"] == 200, where


@pytest.mark.parametrize("name", sorted(SPECS))
def test_the_async_deployment_advertises_the_cancellation_capability(collected, name):
    _, runs = _of(collected, name)
    for run in runs:
        assert run["openapiStatus"] == 200
        assert run["openapiCancellation"] == {"supported": True, "idScope": "attempt"}


@pytest.mark.parametrize("name", sorted(SPECS))
def test_tenants_and_malformed_configuration_on_a_real_process(collected, name):
    _of(collected, name)  # skips when this engine cannot run here
    spec = SPECS[name]
    case = spec.cases[0]
    token_a, token_b = "alpha-token-0123456789", "beta-token-0123456789x"
    tokens = f"alpha={token_a},beta={token_b}"

    # An engine started with a half-written token list does not start at all.
    for variable, value in (("ENGINE_AUTH_TOKENS", "alpha=short"), ("PORT", "not-a-port"),
                            ("ENGINE_JOB_MODE", "maybe"), ("ENGINE_JOB_MAX_QUEUED", "-3")):
        engine = e2e.JavaEngine(spec, asynchronous=True, extra_env={variable: value})
        try:
            assert engine.process.wait(timeout=30) != 0, variable
            assert variable in engine.output(), (variable, engine.output()[-500:])
        finally:
            engine.stop()

    port = e2e.BimPort()
    ir = port.compile(e2e.build_package(tasks=5, candidates=3, seed=e2e.SEED))
    payload = e2e.request_payload(ir, case.execution(ir), case.options)
    with e2e.JavaEngine(spec, asynchronous=True, extra_env={"ENGINE_AUTH_TOKENS": tokens}) as engine:
        assert engine.post(payload).status == 401
        assert engine.post(payload, "wrong-token-wrong-token").status == 401
        accepted = engine.post(payload, token_a)
        assert accepted.status == 202
        job_id = accepted.json()["id"]
        assert engine.job(job_id).status == 401
        assert engine.job(job_id, token_b).status == 404
        assert engine.delete(job_id, token_b).status == 404
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            reply = engine.job(job_id, token_a)
            if reply.json()["status"] == "completed":
                break
            time.sleep(0.05)
        assert reply.json()["status"] == "completed"
        assert engine.delete(job_id, token_a).json()["status"] == "completed"
        assert engine.job(job_id, token_b).status == 404


def test_the_multi_heuristic_openapi_is_untouched_in_the_default_mode(collected):
    _of(collected, "multi-heuristic")
    spec = SPECS["multi-heuristic"]
    pinned = (e2e.ENGINES_DIR / "multi-heuristic" / "src" / "main" / "resources" / "openapi.json").read_bytes()
    with e2e.JavaEngine(spec, asynchronous=False) as engine:
        reply = e2e.http("GET", engine.url + "/openapi.json")
        assert reply.status == 200
        assert reply.body == pinned, "the synchronous deployment serves the pinned document byte for byte"
    with e2e.JavaEngine(spec, asynchronous=True) as engine:
        extended = e2e.http("GET", engine.url + "/openapi.json").json()
        assert extended["extensions"]["cancellation"] == {"supported": True, "idScope": "attempt"}
        assert "delete" in extended["paths"]["/internal/v1/jobs/{id}"]


def test_the_matrices(collected, capsys):
    """Prints the matrices (bypassing the capture) so that the real figures end up in the run output."""
    with capsys.disabled():
        print()
        print(f"bim_core {collected['bimCore']} via {collected['port']}; IR {collected['irApiVersion']} "
              f"{collected['irKind']}; binding space {collected['spaceSize']} bindings")
        print(e2e.render_matrix(collected["cases"]))
        print()
        print(e2e.render_cancellation(collected["cancellation"]))
        for item in collected["notRun"]:
            print(f"NOT RUN {item['engine']}: {item['reason']}")
    assert collected["cases"] and collected["cancellation"]
