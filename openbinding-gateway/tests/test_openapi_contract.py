"""The OpenAPI document, treated as the contract it is.

The document is generated, so it cannot be stale - which is exactly the problem
it used to have: a change to the contract was invisible in review, buried in a
change to a Pydantic model. These pin the properties a consumer would rely on,
and `test_the_committed_snapshot_is_current` puts the rest in the diff.

The audience matters. A third party implementing an engine, or generating a
client, reads this and nothing else.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

from openbinding_gateway.main import app

GATEWAY_ROOT = Path(__file__).resolve().parents[1]
SNAPSHOT = GATEWAY_ROOT.parent / "docs" / "openapi.json"


@pytest.fixture(scope="module")
def document() -> dict:
    return app.openapi()


def operations(document: dict):
    for path, methods in document["paths"].items():
        for method, operation in methods.items():
            yield path, method, operation


# -- What a consumer needs to exist -----------------------------------------


def test_the_document_names_and_versions_itself(document):
    info = document["info"]
    assert info["title"] == "OpenBinding Gateway"
    assert info["version"]
    assert info["description"]


def test_every_operation_has_a_stable_identifier(document):
    # Generated clients name their methods after these, and a federated engine
    # manifest refers to operations by id - so an operation without one is a
    # method called `solve_v1_solve_post` today and something else tomorrow.
    missing = [f"{m.upper()} {p}" for p, m, op in operations(document) if not op.get("operationId")]
    assert missing == []


def test_operation_identifiers_are_unique(document):
    ids = [op["operationId"] for _, _, op in operations(document)]
    duplicates = {i for i in ids if ids.count(i) > 1}
    assert duplicates == set()


def test_every_operation_is_tagged(document):
    # Untagged operations land in a "default" bucket, which is where an API
    # stops being navigable.
    untagged = [f"{m.upper()} {p}" for p, m, op in operations(document) if not op.get("tags")]
    assert untagged == []


def test_every_operation_has_a_summary(document):
    missing = [f"{m.upper()} {p}" for p, m, op in operations(document) if not op.get("summary")]
    assert missing == []


# -- Errors -----------------------------------------------------------------


def test_the_error_shape_is_described(document):
    # Every failure used to be documented as a bare string, whatever the body
    # actually contained.
    schemas = document["components"]["schemas"]
    assert "ErrorResponse" in schemas
    assert "ViolationsErrorResponse" in schemas
    assert "QuotaErrorResponse" in schemas


def test_an_error_carries_a_machine_readable_code(document):
    body = document["components"]["schemas"]["ErrorBody"]
    assert "code" in body["properties"]
    assert "error" in body["properties"]
    assert set(body["required"]) == {"code", "error"}


def test_a_quota_refusal_says_which_limit_and_where_it_stands(document):
    quota = document["components"]["schemas"]["QuotaBody"]["properties"]
    for field in ("limit_id", "limit", "used", "renews_at"):
        assert field in quota, f"a client cannot act on a refusal without {field}"


@pytest.mark.parametrize(
    "path,method,statuses",
    [
        ("/v1/solve", "post", {"401", "402", "413", "422", "503"}),
        ("/v1/jobs/{job_id}", "get", {"401", "404", "503"}),
        ("/v1/analyze/binding-space", "post", {"422"}),
        ("/v1/auth/login", "post", {"401", "503"}),
        ("/v1/auth/register", "post", {"409", "503"}),
        ("/v1/users/me", "get", {"401", "503"}),
        ("/v1/admin/users", "get", {"401", "403"}),
    ],
)
def test_the_failures_an_endpoint_can_produce_are_declared(document, path, method, statuses):
    declared = set(document["paths"][path][method]["responses"])
    assert statuses <= declared, f"{method.upper()} {path} is missing {statuses - declared}"


def test_solving_declares_a_quota_refusal_rather_than_a_forbidden(document):
    # The distinction is the point: 402 is an allowance spent, which is worth
    # retrying once it renews; 403 would say the account may never do this.
    responses = document["paths"]["/v1/solve"]["post"]["responses"]
    assert "402" in responses
    assert "403" not in responses


# -- The instance and the solution ------------------------------------------


def test_the_instance_structure_is_in_the_document(document):
    # Not `object`. Somebody has to be able to build a request from this alone,
    # and the general schema is injected for exactly that reason.
    instance = document["components"]["schemas"]["SolveRequest"]["properties"]["instance"]
    assert "properties" in instance, "the instance is opaque; the contract is useless"
    for part in ("composition", "candidates", "features"):
        assert part in instance["properties"], f"the instance schema omits {part}"


def test_a_solution_requires_only_its_binding(document):
    # The minimum an engine has to produce. Everything else about a solution is
    # recomputed by the reference evaluator, which is what makes a third-party
    # engine possible at all.
    solution = document["components"]["schemas"]["Solution"]
    assert solution["required"] == ["binding"]


def test_a_solution_keeps_the_engine_objective_apart_from_the_canonical_one(document):
    properties = document["components"]["schemas"]["Solution"]["properties"]
    assert "objective_value" in properties
    assert "engine_objective_value" in properties


# -- The snapshot -----------------------------------------------------------


def test_the_committed_snapshot_is_current():
    # What puts a contract change in the diff. If this fails, run
    # `python tools/dump_openapi.py` and commit the result.
    result = subprocess.run(
        [sys.executable, str(GATEWAY_ROOT / "tools" / "dump_openapi.py"), "--check"],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr or result.stdout


def test_the_snapshot_parses_as_json():
    assert isinstance(json.loads(SNAPSHOT.read_text(encoding="utf-8")), dict)
