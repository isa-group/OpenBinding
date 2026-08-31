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

from openbinding_gateway.v1.compiler import compile_instance
from openbinding_gateway.v1.package import InstancePackage, load_package

from experimentation.icsoc.generator.config import load_config
from experimentation.icsoc.generator.generator import generate_dataset


pytestmark = pytest.mark.integration

GATEWAY_URL = "http://127.0.0.1:8000"


def _repository_root() -> Path:
    for root in (Path(__file__).parents[2], Path(__file__).parents[3]):
        if (root / "experimentation/icsoc/original_dataset/applications.json").is_file():
            return root
    raise AssertionError("the ICSOC dataset is not mounted in the integration runner")


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
        "metrics": len(application["spec"]["metrics"]),
        "constraints": len(constraints["spec"]["constraints"]),
        "demands": len(placement["spec"]["demands"]),
        "capacityRules": len(placement["spec"]["capacityRules"]),
        "transitions": len(placement["spec"]["transitions"]),
        "globalLatencyRules": len(placement["spec"]["globalLatency"]),
    }
    normalization = {
        term["metric"]["id"]: {
            "min": term["normalize"]["min"],
            "max": term["normalize"]["max"],
        }
        for term in optimization["spec"]["terms"]
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
        "globalConstraints": sum(value.startswith("metrics.") for value in assertions),
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


def _admin_headers(client: httpx.Client) -> dict[str, str]:
    response = client.post(
        "/v1/auth/login",
        json={"username_or_email": "admin", "password": "4dm1n"},
    )
    assert response.status_code == 200, response.text
    return {"Authorization": f"Bearer {response.json()['access_token']}"}


def _wait(client: httpx.Client, job_id: str, headers: dict[str, str]) -> dict:
    deadline = time.monotonic() + 120
    latest: dict = {}
    while time.monotonic() < deadline:
        response = client.get(f"/v1/jobs/{job_id}", headers=headers)
        assert response.status_code == 200, response.text
        latest = response.json()
        if latest.get("status") in {"completed", "failed"}:
            return latest
        time.sleep(0.1)
    pytest.fail(f"ICSOC job {job_id} timed out: {json.dumps(latest, sort_keys=True)}")


def _solve(
    client: httpx.Client,
    headers: dict[str, str],
    snapshot: dict,
    engine: str,
    mode: str,
    options: dict,
) -> dict:
    analysis = client.post(
        "/v1/analyze", headers=headers, json={"snapshot": snapshot["id"]}
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
        },
    )
    assert accepted.status_code == 202, accepted.text
    job = _wait(client, accepted.json()["id"], headers)
    assert job["status"] == "completed", json.dumps(job, sort_keys=True)
    result = job["result"]
    assert result["solutions"], json.dumps(result, sort_keys=True)
    return result


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
) -> None:
    lanes = {
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
    with httpx.Client(base_url=GATEWAY_URL, timeout=45.0) as client:
        headers = _admin_headers(client)
        response = client.post(
            "/v1/instances",
            headers={**headers, "Content-Type": "application/vnd.bim+zip"},
            content=reduced_package.to_zip(),
        )
        assert response.status_code == 201, response.text
        snapshot = response.json()
        results = {
            engine: _solve(client, headers, snapshot, engine, mode, options)
            for engine, (mode, options) in lanes.items()
        }

    exact_baseline = baseline["legacyExact"]
    exact = _best_solution(results["minizinc-csp"])
    _assert_feasible(exact)
    assert results["minizinc-csp"]["termination"] == "OPTIMAL"
    assert float(exact["objectives"]["score"]) == pytest.approx(
        exact_baseline["score"], abs=1e-9
    )
    for metric, expected in exact_baseline["metrics"].items():
        assert float(exact["metrics"][metric]) == pytest.approx(expected, abs=1e-6)
    assert float(exact["objectives"]["score"]) == pytest.approx(
        baseline["currentExact"]["score"], abs=1e-9
    )
    for metric, expected in baseline["currentExact"]["metrics"].items():
        assert float(exact["metrics"][metric]) == pytest.approx(expected, abs=1e-6)

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
        for metric, expected in observed["metrics"].items():
            assert float(solution["metrics"][metric]) == pytest.approx(expected, abs=1e-6)
        assert classifications[engine] == observed["classification"]

    assert classifications == {
        "minizinc-csp": "coincide",
        "random-search": baseline["currentObserved"]["random-search"]["classification"],
        "evolutionary-heuristics": baseline["currentObserved"]["evolutionary-heuristics"]["classification"],
    }
