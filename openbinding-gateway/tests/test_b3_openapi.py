"""B3: the OpenAPI document has no billing sponsor anywhere, and the snapshot agrees.

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


def test_no_sponsor_is_in_the_contract(document):
    paths = document["paths"]
    assert not [path for path in paths if "sponsor" in path]
    responses = paths["/v1/organizations/{org}"]["patch"]["responses"]
    assert "202" not in responses and "402" not in responses
    schemas = document["components"]["schemas"]
    for name in ("OrganizationCreate", "OrganizationUpdate", "OrganizationView"):
        assert "billing_sponsor_user_id" not in schemas[name]["properties"], name
    assert "sponsor" not in json.dumps(document).casefold()


def test_the_profile_needs_no_pricing_service(document):
    me = document["paths"]["/v1/users/me"]
    # Only the 503 every signed-in route has (no account database); none for the pricing service.
    for method in ("get", "patch"):
        assert me[method]["responses"]["503"]["description"] == (
            "Account authentication is not configured on this deployment."
        ), method
    assert "institutional_branding" not in document["components"]["schemas"]["UserProfile"]["properties"]
