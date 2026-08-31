"""Conformance tests against the compose gateway and all four real engines."""

from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass
import json
import time
import uuid

import httpx
import pytest

from openbinding_gateway.v1.canonical import digest


GATEWAY_URL = "http://127.0.0.1:8000"
TERMINAL_JOB_STATES = {"completed", "failed"}


def _semantic_ir_digest(document: dict) -> str:
    semantic = deepcopy(document)
    semantic.pop("metadata", None)
    for provenance_key in ("instance", "dialects", "sourceMap"):
        semantic["spec"].pop(provenance_key, None)
    return digest(semantic)


@dataclass(frozen=True)
class EngineCase:
    name: str
    mode: str
    example: str
    endpoint: str
    options: dict[str, object]
    algorithm: str
    reported_algorithm: str
    terminations: tuple[str, ...]


ENGINE_CASES = (
    EngineCase(
        name="minizinc-csp",
        mode="exact-weighted",
        example="demo/01_simple_seq",
        endpoint="http://engine-minizinc:3000",
        options={"solver": "gecode", "time_budget_ms": 10_000},
        algorithm="minizinc-csp",
        reported_algorithm="minizinc-csp",
        terminations=("OPTIMAL", "FEASIBLE", "INFEASIBLE", "UNKNOWN"),
    ),
    EngineCase(
        name="random-search",
        mode="seeded",
        example="demo/01_simple_seq",
        endpoint="http://engine-random-search:8080",
        options={"iterations": 16, "seed": 7},
        algorithm="seeded-random-search",
        reported_algorithm="seeded-random-search",
        terminations=("FEASIBLE", "UNKNOWN"),
    ),
    EngineCase(
        name="many-heuristic",
        mode="pareto-sampling",
        example="demo/12_many_obj_pareto",
        endpoint="http://engine-many-heuristic:8080",
        options={"iterations": 16, "archive_size": 8, "seed": 7},
        algorithm="bounded-pareto-sampling",
        reported_algorithm="bounded-pareto-sampling",
        terminations=("FEASIBLE", "UNKNOWN"),
    ),
    EngineCase(
        name="evolutionary-heuristics",
        mode="elitist-genetic",
        example="demo/01_simple_seq",
        endpoint="http://engine-evolutionary-heuristics:8080",
        options={
            "algorithm": "elitist-genetic",
            "population_size": 4,
            "max_evaluations": 8,
            "archive_size": 4,
            "seed": 7,
        },
        algorithm="elitist-genetic-search",
        reported_algorithm="elitist-genetic",
        terminations=("FEASIBLE", "UNKNOWN"),
    ),
)


def _register_and_login(client: httpx.Client) -> dict[str, str]:
    unique = uuid.uuid4().hex
    details = {
        "username": f"integration-{unique}",
        "email": f"integration-{unique}@example.org",
        "password": "correct-horse-battery",
    }
    registered = client.post("/v1/auth/register", json=details)
    assert registered.status_code == 201, registered.text
    logged_in = client.post(
        "/v1/auth/login",
        json={
            "username_or_email": details["username"],
            "password": details["password"],
        },
    )
    assert logged_in.status_code == 200, logged_in.text
    return {"Authorization": f"Bearer {logged_in.json()['access_token']}"}


def _wait_for_job(
    client: httpx.Client,
    job_id: str,
    headers: dict[str, str],
    *,
    timeout_s: float = 45.0,
) -> dict:
    deadline = time.monotonic() + timeout_s
    latest: dict = {}
    while time.monotonic() < deadline:
        response = client.get(f"/v1/jobs/{job_id}", headers=headers)
        assert response.status_code == 200, response.text
        latest = response.json()
        if latest.get("status") in TERMINAL_JOB_STATES:
            return latest
        time.sleep(0.1)
    pytest.fail(f"job {job_id} did not terminate: {json.dumps(latest, sort_keys=True)}")


@pytest.mark.integration
def test_health_and_v1_catalog_are_available() -> None:
    with httpx.Client(base_url=GATEWAY_URL, timeout=10.0) as client:
        health = client.get("/health")
        catalog = client.get("/v1/catalog")
    assert health.status_code == 200
    assert catalog.status_code == 200
    assert catalog.json()["apiVersion"] == "bim/v1"


@pytest.mark.integration
@pytest.mark.parametrize("case", ENGINE_CASES, ids=lambda case: case.name)
def test_every_builtin_engine_executes_only_canonical_ir_and_returns_a_reevaluated_result(
    case: EngineCase,
) -> None:
    with httpx.Client(base_url=GATEWAY_URL, timeout=20.0) as client:
        headers = _register_and_login(client)

        example = client.get(f"/v1/examples/{case.example}")
        assert example.status_code == 200, example.text
        assert example.headers["content-type"].startswith("application/vnd.bim+zip")
        snapshot = client.post(
            "/v1/instances",
            headers={**headers, "Content-Type": "application/vnd.bim+zip"},
            content=example.content,
        )
        assert snapshot.status_code == 201, snapshot.text
        snapshot_body = snapshot.json()

        analysis = client.post(
            "/v1/analyze",
            headers=headers,
            json={"snapshot": snapshot_body["id"]},
        )
        assert analysis.status_code == 200, analysis.text
        selections = [
            selection
            for selection in analysis.json()["compatibleModes"]
            if selection["engine"]["name"] == case.name
            and selection["mode"] == case.mode
        ]
        assert len(selections) == 1, json.dumps(selections, sort_keys=True)
        selection = selections[0]
        assert selection["compatible"] is True, selection["diagnostics"]
        assert set(selection["engine"]) == {"namespace", "name", "version", "digest"}
        assert set(selection["registration"]) == {
            "namespace",
            "name",
            "version",
            "digest",
        }

        accepted = client.post(
            "/v1/jobs",
            headers={**headers, "Idempotency-Key": f"conformance-{case.name}-{uuid.uuid4()}"},
            json={
                "snapshot": snapshot_body["id"],
                "engine": selection["engine"],
                "registration": selection["registration"],
                "mode": case.mode,
                "options": case.options,
            },
        )
        assert accepted.status_code == 202, accepted.text
        accepted_body = accepted.json()
        assert accepted_body["irDigest"] == snapshot_body["irDigest"]

        job = _wait_for_job(client, accepted_body["id"], headers)
        assert job["status"] == "completed", json.dumps(job, sort_keys=True)
        result = job["result"]
        assert result["termination"] in case.terminations
        assert result["termination"] != "UNKNOWN"
        assert result["solutions"]
        for solution in result["solutions"]:
            # Remote QoS claims are discarded: this complete shape is rebuilt
            # by the gateway's authoritative evaluator from the decision.
            assert set(solution) == {
                "decision",
                "metrics",
                "objectives",
                "penalties",
                "violations",
            }
            assert solution["decision"]["kind"] == "binding"
            assert solution["decision"]["binding"]
            assert solution["metrics"]
            assert solution["objectives"]
            assert isinstance(solution["penalties"], list)
            assert isinstance(solution["violations"], list)

        ir_response = client.get(f"/v1/jobs/{accepted_body['id']}/ir", headers=headers)
        assert ir_response.status_code == 200, ir_response.text
        ir = ir_response.json()
        assert ir["apiVersion"] == "bim/v1"
        assert ir["kind"] == "BindingProblem"
        assert set(ir) == {"apiVersion", "kind", "metadata", "spec"}
        assert _semantic_ir_digest(ir) == accepted_body["irDigest"]

        provenance = job["provenance"]
        assert provenance["engine"] == selection["engine"]
        assert provenance["registration"] == selection["registration"]
        assert provenance["engineDigest"] == selection["engine"]["digest"]
        assert provenance["protocol"] == "bim-engine/v1"
        assert provenance["mode"] == case.mode
        assert provenance["algorithm"] == case.algorithm
        assert provenance["profile"]["id"] == "qos-binding/v1"
        assert provenance["ir"] == {"apiVersion": "bim/v1", "kind": "BindingProblem"}
        assert provenance["irDigest"] == accepted_body["irDigest"]
        assert provenance["instanceDigest"] == snapshot_body["instanceDigest"]
        assert provenance["packageDigest"] == snapshot_body["packageDigest"]
        assert provenance["fileDigests"] == snapshot_body["fileDigests"]
        assert provenance["resourceDigests"] == snapshot_body["resourceDigests"]
        assert provenance["terminationGuarantees"] == list(case.terminations)
        assert provenance["compiler"] == "bim-compiler/v1"
        assert provenance["evaluator"] == "bim-reference-evaluator/v1"
        assert provenance["compilerDigest"] == provenance["evaluatorDigest"]
        assert provenance["dialects"]
        assert all(dialect.get("adapter") for dialect in provenance["dialects"])
        assert provenance["adapters"]
        for option, value in case.options.items():
            assert provenance["options"][option] == value

        result_provenance = result["provenance"]
        assert result_provenance["irDigest"] == provenance["irDigest"]
        assert result_provenance["registration"] == provenance["registration"]
        assert result_provenance["engineReported"]["algorithm"] == case.reported_algorithm

        report_response = client.get(
            f"/v1/jobs/{accepted_body['id']}/report",
            headers=headers,
        )
        assert report_response.status_code == 200, report_response.text
        report = report_response.json()
        assert report["gatewayEvaluation"] == {
            "termination": result["termination"],
            "solutions": result["solutions"],
        }
        assert report["remote"]["algorithm"] == case.reported_algorithm
        assert report["provenance"] == provenance

        instance_response = client.get(
            f"/v1/jobs/{accepted_body['id']}/instance",
            headers=headers,
        )
        assert instance_response.status_code == 200, instance_response.text
        source_instance = instance_response.json()["instance"]
        assert source_instance["kind"] == "Instance"

    # All deployments expose the same strict private protocol.  A source
    # Instance inside an otherwise valid transport envelope must be rejected;
    # only the canonical BindingProblem observed above is executable.
    with httpx.Client(timeout=10.0, trust_env=False) as engine_client:
        rejected = engine_client.post(
            f"{case.endpoint}/internal/v1/binding-problems",
            json={
                "apiVersion": "bim/v1",
                "kind": "BindingProblemRequest",
                "protocol": "bim-engine/v1",
                "problem": source_instance,
                "options": {},
            },
        )
    assert rejected.status_code == 422, rejected.text
    assert rejected.headers["content-type"].startswith("application/problem+json")
