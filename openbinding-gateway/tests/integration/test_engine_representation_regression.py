"""Every engine must treat the complete BPMN and native JSON twins alike."""

from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass
import hashlib
import json
from pathlib import Path
import time
import uuid

import httpx
import pytest

from openbinding_gateway.v1.canonical import canonical_json
from openbinding_gateway.v1.package import InstancePackage, load_package


GATEWAY_URL = "http://127.0.0.1:8000"


@dataclass(frozen=True)
class RepresentationCase:
    engine: str
    mode: str
    objective_type: str
    term_count: int
    options: dict[str, object]


CASES = (
    RepresentationCase(
        "minizinc-csp",
        "exact-weighted",
        "MONO",
        4,
        {"solver": "gecode", "time_budget_ms": 10_000},
    ),
    RepresentationCase(
        "random-search",
        "seeded",
        "MONO",
        4,
        {"iterations": 256, "seed": 7},
    ),
    RepresentationCase(
        "evolutionary-heuristics",
        "pareto-genetic",
        "MULTI",
        2,
        {
            "algorithm": "pareto-genetic",
            "population_size": 8,
            "max_evaluations": 64,
            "archive_size": 16,
            "seed": 7,
        },
    ),
    RepresentationCase(
        "multi-heuristic",
        "pareto-sampling",
        "MULTI",
        2,
        {"iterations": 256, "archive_size": 32, "seed": 7},
    ),
    RepresentationCase(
        "many-heuristic",
        "pareto-sampling",
        "MANY",
        3,
        {"iterations": 256, "archive_size": 32, "seed": 7},
    ),
)


@pytest.mark.integration
def test_representation_matrix_covers_every_repository_engine() -> None:
    """A newly added engine must join this regression or fail CI explicitly."""

    root = _repository_root()
    documents = [
        json.loads(path.read_text(encoding="utf-8"))
        for path in sorted((root / "schemas/bim/v1/manifests").glob("*.json"))
    ]
    documents.extend(
        json.loads(path.read_text(encoding="utf-8"))
        for path in sorted((root / "examples/federation").glob("*/engine.json"))
    )
    repository_engines = {
        document["metadata"]["name"]
        for document in documents
        if document.get("kind") == "Engine"
    }

    case_names = [case.engine for case in CASES]
    assert len(case_names) == len(set(case_names))
    assert set(case_names) == repository_engines


def _repository_root() -> Path:
    for root in (Path(__file__).parents[2], Path(__file__).parents[3]):
        if (root / "examples/demo/15_bpmn_complete").is_dir():
            return root
    raise AssertionError("repository examples are not mounted in the integration runner")


def _package(example: str, case: RepresentationCase) -> bytes:
    package = load_package(_repository_root() / "examples" / example)
    files = dict(package.files)
    optimization = deepcopy(package.json("optimization.json"))
    if case.objective_type == "MONO":
        assert case.term_count == len(optimization["spec"]["terms"])
    else:
        optimization["spec"]["mode"] = "pareto"
        optimization["spec"]["type"] = case.objective_type
        optimization["spec"]["terms"] = optimization["spec"]["terms"][: case.term_count]
        for term in optimization["spec"]["terms"]:
            term.pop("weight", None)
    files["optimization.json"] = canonical_json(optimization)
    return InstancePackage(files).to_zip()


def _admin_headers(client: httpx.Client) -> dict[str, str]:
    logged = client.post(
        "/v1/auth/login",
        json={"username_or_email": "admin", "password": "4dm1n"},
    )
    assert logged.status_code == 200, logged.text
    return {"Authorization": f"Bearer {logged.json()['access_token']}"}


def _ensure_multi_registration(
    client: httpx.Client,
    headers: dict[str, str],
) -> dict[str, str]:
    root = _repository_root()
    engine = json.loads(
        (root / "examples/federation/multi-heuristic/engine.json").read_text(encoding="utf-8")
    )
    registration = json.loads(
        (root / "examples/federation/multi-heuristic/registration.json").read_text(encoding="utf-8")
    )
    published = client.post("/v1/engines", headers=headers, json=engine)
    assert published.status_code in {200, 201}, published.text
    engine_ref = {
        field: published.json()[field]
        for field in ("namespace", "name", "version", "digest")
    }
    profile = next(
        item
        for item in client.get("/v1/profiles").json()["profiles"]
        if item["id"] == "qos-binding/v1"
    )
    registration["spec"]["engine"] = engine_ref
    registration["spec"]["endpoint"] = "http://engine-multi-heuristic:8080"
    registration["spec"]["protocol"]["digest"] = profile["protocolDigest"]
    # EngineRegistration identities are immutable. Give each materially
    # different integration contract a stable SemVer revision so a persistent
    # developer database can safely rerun this fixture without a 409 collision.
    base_version = registration["metadata"]["version"].split("+", 1)[0]
    contract_fingerprint = hashlib.sha256(canonical_json(registration)).hexdigest()[:12]
    registration["metadata"]["version"] = f"{base_version}+integration.{contract_fingerprint}"
    created = client.post("/v1/engine-registrations", headers=headers, json=registration)
    assert created.status_code in {200, 201}, created.text
    params = {
        "namespace": "admin",
        "version": created.json()["version"],
        "digest": created.json()["digest"],
    }
    state = created.json()
    if state["status"] in {"private", "rejected"}:
        if not state["active"]:
            activated = client.post(
                "/v1/engine-registrations/multi-heuristic-deployment/activate",
                headers=headers,
                params=params,
            )
            assert activated.status_code == 200, activated.text
        requested = client.post(
            "/v1/engine-registrations/multi-heuristic-deployment/publication-request",
            headers=headers,
            params=params,
        )
        assert requested.status_code == 200, requested.text
        state = requested.json()
    if state["status"] == "pending_review":
        approved = client.post(
            "/v1/engine-registrations/multi-heuristic-deployment/approve",
            headers=headers,
            params=params,
        )
        assert approved.status_code == 200, approved.text
        state = approved.json()
    assert state["status"] == "published"
    return {
        field: state[field]
        for field in ("namespace", "name", "version", "digest")
    }


def _wait_for_job(
    client: httpx.Client,
    job_id: str,
    headers: dict[str, str],
) -> dict:
    deadline = time.monotonic() + 60
    latest: dict = {}
    while time.monotonic() < deadline:
        response = client.get(f"/v1/jobs/{job_id}", headers=headers)
        assert response.status_code == 200, response.text
        latest = response.json()
        if latest.get("status") in {"completed", "failed"}:
            return latest
        time.sleep(0.1)
    pytest.fail(f"job {job_id} did not terminate: {json.dumps(latest, sort_keys=True)}")


def _solve(
    client: httpx.Client,
    headers: dict[str, str],
    package: bytes,
    case: RepresentationCase,
    registration_ref: dict[str, str] | None = None,
) -> tuple[str, dict]:
    snapshot = client.post(
        "/v1/instances",
        headers={**headers, "Content-Type": "application/vnd.bim+zip"},
        content=package,
    )
    assert snapshot.status_code == 201, snapshot.text
    analysis = client.post(
        "/v1/analyze", headers=headers, json={"snapshot": snapshot.json()["id"]}
    )
    assert analysis.status_code == 200, analysis.text
    matches = [
        item
        for item in analysis.json()["compatibleModes"]
        if item["compatible"]
        and item["engine"]["name"] == case.engine
        and item["mode"] == case.mode
        and (case.engine != "multi-heuristic" or item["engine"]["namespace"] == "admin")
        and (registration_ref is None or item["registration"] == registration_ref)
    ]
    assert len(matches) == 1, json.dumps(matches, sort_keys=True)
    selection = matches[0]
    accepted = client.post(
        "/v1/jobs",
        headers={**headers, "Idempotency-Key": f"representation-{uuid.uuid4()}"},
        json={
            "snapshot": snapshot.json()["id"],
            "engine": selection["engine"],
            "registration": selection["registration"],
            "mode": case.mode,
            "options": case.options,
        },
    )
    assert accepted.status_code == 202, accepted.text
    job = _wait_for_job(client, accepted.json()["id"], headers)
    assert job["status"] == "completed", json.dumps(job, sort_keys=True)
    return snapshot.json()["irDigest"], job["result"]


def _solutions(result: dict) -> list[str]:
    return sorted(
        json.dumps(solution, sort_keys=True, separators=(",", ":"))
        for solution in result["solutions"]
    )


@pytest.mark.integration
@pytest.mark.parametrize("case", CASES, ids=lambda case: case.engine)
def test_every_engine_returns_the_same_result_for_bpmn_and_native_json(
    case: RepresentationCase,
) -> None:
    with httpx.Client(base_url=GATEWAY_URL, timeout=30.0) as client:
        headers = _admin_headers(client)
        registration_ref = None
        if case.engine == "multi-heuristic":
            registration_ref = _ensure_multi_registration(client, headers)
        bpmn_digest, bpmn_result = _solve(
            client,
            headers,
            _package("demo/15_bpmn_complete", case),
            case,
            registration_ref,
        )
        json_digest, json_result = _solve(
            client,
            headers,
            _package("demo/16_json_complete", case),
            case,
            registration_ref,
        )

    assert bpmn_digest == json_digest
    assert bpmn_result["termination"] == json_result["termination"]
    assert bpmn_result["termination"] != "UNKNOWN"
    assert _solutions(bpmn_result) == _solutions(json_result)
    assert bpmn_result["solutions"]
