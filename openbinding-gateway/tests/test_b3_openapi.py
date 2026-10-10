"""B3: the OpenAPI document describes proposals and public reads, and the snapshot agrees.

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


def test_sponsor_proposals_are_in_the_contract(document):
    paths = document["paths"]
    expected = {
        ("/v1/sponsor-proposals/{proposal_id}", "get"),
        ("/v1/sponsor-proposals/{proposal_id}/accept", "post"),
        ("/v1/sponsor-proposals/{proposal_id}/decline", "post"),
        ("/v1/sponsor-proposals/{proposal_id}/cancel", "post"),
        ("/v1/users/me/sponsor-proposals", "get"),
        ("/v1/organizations/{org}/sponsor-proposals", "get"),
    }
    for path, method in expected:
        operation = paths[path][method]
        assert operation["operationId"] and operation["security"]
        assert operation["x-required-api-key-permissions"]
    patch = paths["/v1/organizations/{org}"]["patch"]["responses"]
    admin = paths["/v1/admin/organizations/{organization_id}/sponsor"]["post"]["responses"]
    for responses in (patch, admin):
        assert "202" in responses and "409" in responses
        assert responses["202"]["content"]["application/json"]["schema"] == {
            "$ref": "#/components/schemas/SponsorProposalView"
        }
    view = document["components"]["schemas"]["SponsorProposalView"]["properties"]
    assert set(view["status"]["enum"]) == {"pending", "accepted", "declined", "cancelled", "expired"}
    assert {"expires_at", "decided_at", "decided_by_user_id", "proposed_by_user_id"} <= set(view)
    body = document["components"]["schemas"]["OrganizationUpdate"]["properties"]
    assert body["replace_pending_proposal"]["default"] is False
