"""Reduced end-to-end regression against the published ICSOC campaign."""

from __future__ import annotations

import json
import math
from pathlib import Path
import re
import time
import uuid

import httpx
import pytest

from _repo import REPO_ROOT
from bim_core.compiler import compile_instance
from bim_core.package import InstancePackage, load_package
from job_polling import wait_for_job

from experimentation.icsoc.generator.config import load_config
from experimentation.icsoc.generator.generator import generate_dataset


pytestmark = pytest.mark.integration

GATEWAY_URL = "http://127.0.0.1:8000"

LANES = {
    "minizinc-csp": (
        "exact-weighted",
        {"solver": "gecode", "time_budget_ms": 30_000},
    ),
    "random-search": ("seeded", {"iterations": 1_000, "seed": 7}),
    "evolutionary-heuristics": (
        "elitist-genetic",
        {
            "algorithm": "elitist-genetic",
            "population_size": 20,
            "max_evaluations": 1_000,
            "archive_size": 20,
            "seed": 7,
        },
    ),
}
# The package declares criteria only; the historical weights of configs/default.yml
# belong to the request. Without them the gateway fills equal weights and the
# exact optimum changes.
OPTIMIZATION = {
    "type": "SINGLE",
    "scalarization": "weighted-sum",
    "weights": [
        {"criteria": "latency", "value": 0.33},
        {"criteria": "cost", "value": 0.34},
        {"criteria": "security", "value": 0.33},
    ],
}


def _repository_root() -> Path:
    if (REPO_ROOT / "experimentation/icsoc/original_dataset/applications.json").is_file():
        return REPO_ROOT
    pytest.skip(
        "experimentation/icsoc/original_dataset is not present; it lives on the "
        "data/icsoc-original-dataset branch (see experimentation/icsoc/README.md)"
    )


@pytest.fixture(scope="module")
def baseline() -> dict:
    path = (
        _repository_root()
        / "experimentation/icsoc/regression/mediaOrch_146588263_50.json"
    )
    return json.loads(path.read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def reduced_package(tmp_path_factory: pytest.TempPathFactory) -> InstancePackage:
    root = _repository_root()
    output = tmp_path_factory.mktemp("icsoc-regression")
    reports = generate_dataset(
        dataset=root / "experimentation/icsoc/original_dataset",
        pricing_dir=root / "pricings",
        config=load_config(root / "experimentation/icsoc/generator/configs/default.yml"),
        seed=12345,
        out=output,
        applications={"mediaOrch"},
        dataset_seeds={"146588263"},
        sizes={"50"},
    )
    assert len(reports.candidate_rows) == 5
    assert len(reports.pricing_rows) == 540
    return load_package(
        output / "instances/mediaOrch/146588263/infrastructure_50"
    )


def _document(package: InstancePackage, filename: str) -> dict:
    return json.loads(package.files[filename])


def test_reduced_dataset_reproduces_the_historical_case(
    reduced_package: InstancePackage,
    baseline: dict,
) -> None:
    application = _document(reduced_package, "application.json")
    candidates = _document(reduced_package, "candidates.json")
    constraints = _document(reduced_package, "constraints.json")
    placement = _document(reduced_package, "placement.json")
    optimization = _document(reduced_package, "optimization.json")

    observed = {
        "tasks": len(application["spec"]["tasks"]),
        "candidates": len(candidates["spec"]["candidates"]),
        "pools": len(placement["spec"]["pools"]),
        "features": len(application["spec"]["features"]),
        "constraints": len(constraints["spec"]["constraints"]),
        "demands": len(placement["spec"]["demands"]),
        "capacityRules": len(placement["spec"]["capacityRules"]),
        "transitions": len(placement["spec"]["transitions"]),
        "globalLatencyRules": len(placement["spec"]["globalLatency"]),
    }
    normalization = {
        criterion["feature"]["id"]: {
            "min": criterion["normalize"]["min"],
            "max": criterion["normalize"]["max"],
        }
        for criterion in optimization["spec"]["criteria"]
    }

    assert observed == baseline["structure"]
    assert normalization == baseline["normalization"]
    assert reduced_package.package_digest == baseline["digests"]["package"]
    problem = compile_instance(reduced_package)
    assert problem.digest == baseline["digests"]["ir"]

    constraint_entries = constraints["spec"]["constraints"]
    assertions = [entry["assert"] for entry in constraint_entries.values()]
    global_budget_assertion = constraint_entries["budget_global_mediaOrch"]["assert"]
    capacity_resources = {
        resource
        for rule in placement["spec"]["capacityRules"]
        for resource in rule["resources"]
    }
    historical_shape = {
        "localConstraints": sum(value.startswith("tasks.") for value in assertions),
        "globalConstraints": sum(value.startswith("features.") for value in assertions),
        "dependencyConstraints": sum(
            len(set(re.findall(r"tasks\.([A-Za-z0-9_.-]+)", value))) > 1
            for value in assertions
        ),
        # The published corpus counted the infrastructure capacity group and
        # the FaaS concurrency group, before BIM v1 normalized both into one
        # rule with four resource dimensions.
        "resourceCapacityConstraints": (
            int(bool(capacity_resources - {"concurrency"}))
            + int("concurrency" in capacity_resources)
        ),
        "budgetConstraints": sum(
            name.startswith("budget_") for name in constraint_entries
        ),
        "log10BindingSpace": round(sum(
            math.log10(len(domain))
            for domain in problem.document["spec"]["eligibility"].values()
        ), 3),
        "globalBudget": float(global_budget_assertion.split("<=", 1)[1]),
    }
    assert historical_shape == baseline["legacyCorpusRow"]
    assert baseline["heuristicMethod"]["sampleCount"] == 10
    assert baseline["heuristicMethod"]["cutoffEvaluations"] == 1_000
    for history in baseline["heuristic1000Evaluations"].values():
        assert (
            history["historicalMin"]
            <= history["historicalQ1"]
            <= history["historicalMedian"]
            <= history["historicalQ3"]
            <= history["historicalMax"]
        )
        expected_fence = history["historicalQ3"] + 3 * (
            history["historicalQ3"] - history["historicalQ1"]
        )
        assert history["robustUpperFence"] == pytest.approx(expected_fence, abs=1e-15)


def _admin_headers(client: httpx.Client, credentials: tuple[str, str]) -> dict[str, str]:
    username, password = credentials
    response = client.post(
        "/v1/auth/login",
        json={"username_or_email": username, "password": password},
    )
    assert response.status_code == 200, response.text
    return {"Authorization": f"Bearer {response.json()['access_token']}"}


def _wait(client: httpx.Client, job_id: str, headers: dict[str, str]) -> dict:
    return wait_for_job(client, job_id, headers, timeout_s=120, label="ICSOC job")


def _solve(
    client: httpx.Client,
    headers: dict[str, str],
    snapshot: dict,
    engine: str,
    mode: str,
    options: dict,
) -> dict:
    analysis = client.post(
        "/v1/validate", headers=headers, json={"snapshot": snapshot["id"]}
    )
    assert analysis.status_code == 200, analysis.text
    matches = [
        item
        for item in analysis.json()["compatibleModes"]
        if item["compatible"]
        and item["engine"]["name"] == engine
        and item["mode"] == mode
    ]
    assert len(matches) == 1, json.dumps(matches, sort_keys=True)
    selection = matches[0]
    accepted = client.post(
        "/v1/jobs",
        headers={**headers, "Idempotency-Key": f"icsoc-regression-{uuid.uuid4()}"},
        json={
            "snapshot": snapshot["id"],
            "engine": selection["engine"],
            "registration": selection["registration"],
            "mode": mode,
            "options": options,
            "optimization": OPTIMIZATION,
        },
    )
    assert accepted.status_code == 202, accepted.text
    job = _wait(client, accepted.json()["id"], headers)
    assert job["status"] == "completed", json.dumps(job, sort_keys=True)
    result = job["result"]
    assert result["solutions"], json.dumps(result, sort_keys=True)
    return result


def _engine_reported(result: dict) -> dict:
    provenance = result.get("provenance") or {}
    reported = provenance.get("engineReported")
    return reported if isinstance(reported, dict) else {}


def _lane_summary(engine: str, result: dict, wall_s: float) -> str:
    """One line per lane: wall time seen by the test and the engine's own split.

    ``elapsed_ms`` covers flattening and search together for minizinc-csp (the
    time budget applies to the sum); ``flatten_ms`` is the flattening share, so
    ``search_ms`` is what remained for fzn-gecode.
    """
    reported = _engine_reported(result)
    elapsed = reported.get("elapsed_ms")
    flatten = reported.get("flatten_ms")
    search = (
        elapsed - flatten
        if isinstance(elapsed, (int, float)) and isinstance(flatten, (int, float))
        else None
    )
    return (
        f"lane={engine} termination={result.get('termination')!r} "
        f"test_wall_s={wall_s:.3f} engine_elapsed_ms={elapsed} "
        f"engine_flatten_ms={flatten} engine_search_ms={search} "
        f"time_budget_ms={reported.get('time_budget_ms')} "
        f"gecode_statistics={json.dumps(reported.get('gecode_statistics'), sort_keys=True)}"
    )


def _lane_diagnostics(
    summaries: dict[str, str], results: dict[str, dict], engine: str
) -> str:
    """Complete, untruncated evidence for one lane, for assertion messages."""
    return (
        "\n".join(summaries.values())
        + f"\n{engine} provenance.engineReported (complete):\n"
        + json.dumps(_engine_reported(results[engine]), sort_keys=True, indent=2)
        + f"\n{engine} provenance (complete):\n"
        + json.dumps(results[engine].get("provenance"), sort_keys=True, indent=2)
    )


def _best_solution(result: dict) -> dict:
    return min(
        result["solutions"],
        key=lambda solution: float(solution["objectives"]["score"]),
    )


def _assert_feasible(solution: dict) -> None:
    hard = [
        violation
        for violation in solution.get("violations", [])
        if violation.get("enforcement") == "hard"
    ]
    assert not hard, json.dumps(hard, sort_keys=True)


def _classification(score: float, exact: float, history: dict) -> str:
    if math.isclose(score, exact, rel_tol=0.0, abs_tol=1e-9):
        return "coincide"
    if history["historicalMin"] <= score <= history["historicalMax"]:
        return "similar"
    if exact <= score <= history["robustUpperFence"]:
        return "sensible"
    return "regression"


def test_reduced_campaign_matches_or_remains_statistically_sensible(
    reduced_package: InstancePackage,
    baseline: dict,
    bootstrap_admin_credentials: tuple[str, str],
) -> None:
    lanes = LANES
    with httpx.Client(base_url=GATEWAY_URL, timeout=45.0) as client:
        headers = _admin_headers(client, bootstrap_admin_credentials)
        response = client.post(
            "/v1/instances",
            headers={**headers, "Content-Type": "application/vnd.bim+zip"},
            content=reduced_package.to_zip(),
        )
        assert response.status_code == 201, response.text
        snapshot = response.json()
        results: dict[str, dict] = {}
        summaries: dict[str, str] = {}
        for engine, (mode, options) in lanes.items():
            started = time.monotonic()
            results[engine] = _solve(client, headers, snapshot, engine, mode, options)
            summaries[engine] = _lane_summary(
                engine, results[engine], time.monotonic() - started
            )
            # Printed as soon as the lane ends, so pytest shows it in the captured
            # stdout of a failing run (and live with -s) whatever fails afterwards.
            print(summaries[engine], flush=True)
        print(
            "minizinc-csp provenance.engineReported:\n"
            + json.dumps(_engine_reported(results["minizinc-csp"]), sort_keys=True, indent=2),
            flush=True,
        )

    exact_baseline = baseline["legacyExact"]
    exact = _best_solution(results["minizinc-csp"])
    _assert_feasible(exact)
    assert results["minizinc-csp"]["termination"] == "OPTIMAL", (
        f"termination={results['minizinc-csp'].get('termination')!r} "
        f"(expected OPTIMAL; the legacy baseline proved it in "
        f"{baseline['legacyExact']['elapsedSeconds']} s)\n"
        + _lane_diagnostics(summaries, results, "minizinc-csp")
    )
    assert float(exact["objectives"]["score"]) == pytest.approx(
        exact_baseline["score"], abs=1e-9
    )
    for feature, expected in exact_baseline["features"].items():
        assert float(exact["features"][feature]) == pytest.approx(expected, abs=1e-6)
    assert float(exact["objectives"]["score"]) == pytest.approx(
        baseline["currentExact"]["score"], abs=1e-9
    )
    for feature, expected in baseline["currentExact"]["features"].items():
        assert float(exact["features"][feature]) == pytest.approx(expected, abs=1e-6)

    exact_score = float(exact["objectives"]["score"])
    classifications: dict[str, str] = {"minizinc-csp": "coincide"}
    for engine in ("random-search", "evolutionary-heuristics"):
        assert results[engine]["termination"] == "FEASIBLE"
        solution = _best_solution(results[engine])
        _assert_feasible(solution)
        score = float(solution["objectives"]["score"])
        assert score + 1e-9 >= exact_score
        classifications[engine] = _classification(
            score,
            exact_score,
            baseline["heuristic1000Evaluations"][engine],
        )

        observed = baseline["currentObserved"][engine]
        options = lanes[engine][1]
        expected_evaluations = options.get("iterations", options.get("max_evaluations"))
        assert observed["seed"] == options["seed"]
        assert observed["evaluations"] == expected_evaluations
        assert score == pytest.approx(observed["score"], abs=1e-12)
        for feature, expected in observed["features"].items():
            assert float(solution["features"][feature]) == pytest.approx(expected, abs=1e-6)
        assert classifications[engine] == observed["classification"]

    assert classifications == {
        "minizinc-csp": "coincide",
        "random-search": baseline["currentObserved"]["random-search"]["classification"],
        "evolutionary-heuristics": baseline["currentObserved"]["evolutionary-heuristics"]["classification"],
    }
