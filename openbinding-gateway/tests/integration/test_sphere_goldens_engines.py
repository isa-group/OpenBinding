"""The SPHERE-generated TomatoMeter packages solve on every built-in single-objective engine alike.

The ``tomatometer-email`` golden (``tests/golden/sphere``, revision 2) is the first corpus-adjacent use of compile-time
``requires.predicate`` and candidate properties, with a ``selectedCandidate`` subscription and a ``product``
availability. Through the compose stack, MiniZinc (exact), random search and the elitist genetic search must return
the same optimum, and the e-mail candidate they bind must be one the facts call eligible. The ``tomatometer-r3``
golden (revision 3: Dropbox for ``export`` and the built-in quotes beside ZenQuotes) must agree the same way.
"""

from __future__ import annotations

import json
import uuid

import httpx
import pytest

from _paths import TESTS_DIR
from bim_core.canonical import canonical_json
from bim_core.package import InstancePackage
from job_polling import wait_for_job
from problem_upload import compatible_modes, upload_problem

GATEWAY_URL = "http://127.0.0.1:8000"
GOLDENS = TESTS_DIR / "golden" / "sphere"
#: Equal weights: the genetic search requires them, and every engine optimises the same scalar.
OPTIMIZATION = {
    "type": "SINGLE",
    "scalarization": "weighted-sum",
    "weights": [
        {"criteria": "subscription", "value": 1 / 3},
        {"criteria": "availability", "value": 1 / 3},
        {"criteria": "latency", "value": 1 / 3},
    ],
}
ENGINES = (
    ("minizinc-csp", "exact-weighted", {"solver": "gecode", "time_budget_ms": 10_000}),
    ("random-search", "seeded", {"iterations": 512, "seed": 7}),
    ("evolutionary-heuristics", "elitist-genetic",
     {"algorithm": "elitist-genetic", "population_size": 16, "max_evaluations": 512, "seed": 7}),
)


def _package(case: str) -> bytes:
    golden = GOLDENS / f"{case}.files.json"
    files = {path: canonical_json(document) for path, document in json.loads(golden.read_text()).items()}
    return InstancePackage(files).to_zip()


def _admin_headers(client: httpx.Client, credentials: tuple[str, str]) -> dict[str, str]:
    username, password = credentials
    logged = client.post("/v1/auth/login", json={"username_or_email": username, "password": password})
    assert logged.status_code == 200, logged.text
    return {"Authorization": f"Bearer {logged.json()['access_token']}"}


def _binding(result: dict) -> dict[str, str]:
    decision = result["solutions"][0]["decision"]
    assert decision["kind"] == "binding"
    return {task: f"{ref['resource']}/{ref['id']}" for task, ref in decision["binding"].items()}


@pytest.mark.integration
@pytest.mark.parametrize("case", ["tomatometer-email", "tomatometer-r3"])
def test_the_generated_tomatometer_problem_solves_alike_on_three_engines(
    case: str, bootstrap_admin_credentials: tuple[str, str],
) -> None:
    with httpx.Client(base_url=GATEWAY_URL, timeout=30.0) as client:
        headers = _admin_headers(client, bootstrap_admin_credentials)
        upload = upload_problem(client, headers, _package(case))
        modes = compatible_modes(client, headers, upload)
        facts = client.get(
            f"{upload['revision_path']}/compilations/{upload['compilation']['id']}/facts", headers=headers,
        ).json()
        by_task = {task["id"]: {item["candidate"] for item in task["eligible"]} for task in facts["tasks"]}
        eligible = by_task["dailySummary"]
        if case == "tomatometer-r3":
            assert "sphere-storage/storage.dropbox.plus" in by_task["export"]
            assert by_task["quotes"] == {"sphere-quotes/quotes.builtin.static", "catalog/quotes.zenquotes.free"}
        assert "sphere-email/email.mailgun.foundation" in eligible and "sphere-email/email.mailgun.free" not in eligible
        found = {}
        for engine, mode, options in ENGINES:
            matches = [
                item for item in modes
                if item["compatible"] and item["engine"]["name"] == engine and item["mode"] == mode
            ]
            assert matches, f"{engine}/{mode} is not compatible: {json.dumps(modes, sort_keys=True)[:800]}"
            selection = matches[0]
            accepted = client.post(
                f"/v1/organizations/{upload['org']}/runs",
                headers={**headers, "Idempotency-Key": f"sphere-engines-{uuid.uuid4()}"},
                json={
                    "revision": upload["revision"]["id"], "engine": selection["engine"],
                    "registration": selection["registration"], "mode": mode, "options": options,
                    "optimization": OPTIMIZATION,
                },
            )
            assert accepted.status_code == 202, accepted.text
            job = wait_for_job(client, upload["org"], accepted.json()["id"], headers, timeout_s=90)
            assert job["status"] == "completed", json.dumps(job, sort_keys=True)[:2000]
            assert job["result"]["termination"] in {"OPTIMAL", "FEASIBLE"}
            found[engine] = _binding(job["result"])
    bindings = list(found.values())
    assert all(binding == bindings[0] for binding in bindings), found
    assert bindings[0]["dailySummary"] in eligible
