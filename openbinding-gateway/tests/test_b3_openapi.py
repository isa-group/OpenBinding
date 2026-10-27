"""B3: the OpenAPI document has no sponsor proposals (removed in M9.6), and the snapshot agrees.

``tools/dump_openapi.py --check`` only says "out of date". The semantic comparison
below names the first differing paths, which is what a reviewer needs.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from _repo import REPO_ROOT
from openbinding_gateway.main import app

SNAPSHOT = REPO_ROOT / "docs" / "openapi.json"


@pytest.fixture(scope="module")
def document() -> dict:
    return app.openapi()


def differences(expected, actual, path: str = "", found: list[str] | None = None, limit: int = 12) -> list[str]:
    found = [] if found is None else found
    if len(found) >= limit:
        return found
    if isinstance(expected, dict) and isinstance(actual, dict):
        for key in sorted(set(expected) | set(actual)):
            if key not in actual:
                found.append(f"- only in snapshot: {path}/{key}")
            elif key not in expected:
                found.append(f"+ only in code: {path}/{key}")
            else:
                differences(expected[key], actual[key], f"{path}/{key}", found, limit)
            if len(found) >= limit:
                break
    elif expected != actual:
        found.append(f"~ {path}: snapshot={json.dumps(expected)[:70]} code={json.dumps(actual)[:70]}")
    return found


def test_the_snapshot_is_semantically_current(document):
    snapshot = json.loads(Path(SNAPSHOT).read_text(encoding="utf-8"))
    found = differences(snapshot, document)
    assert not found, "snapshot differs from the code:\n" + "\n".join(found)


def test_sponsor_proposals_are_not_in_the_contract(document):
    paths = document["paths"]
    for path in (
        "/v1/sponsor-proposals/{proposal_id}",
        "/v1/sponsor-proposals/{proposal_id}/accept",
        "/v1/sponsor-proposals/{proposal_id}/decline",
        "/v1/sponsor-proposals/{proposal_id}/cancel",
        "/v1/users/me/sponsor-proposals",
        "/v1/organizations/{org}/sponsor-proposals",
        "/v1/admin/organizations/{organization_id}/sponsor",
    ):
        assert path not in paths, path
    responses = paths["/v1/organizations/{org}"]["patch"]["responses"]
    assert "202" not in responses and "409" not in responses
    assert "402" in responses and "sponsor_must_be_caller" in responses["422"]["description"]
    assert "SponsorProposalView" not in document["components"]["schemas"]
    body = document["components"]["schemas"]["OrganizationUpdate"]["properties"]
    assert "replace_pending_proposal" not in body
