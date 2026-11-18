"""A composition over the SPHERE-generated TomatoMeter problem, for the compositions tests (not a test module)."""

from __future__ import annotations

import json

from _problem_helpers import upload_problem
from _repo import REPO_ROOT
from problems._sphere_helpers import base_archive, member

EMAIL = json.loads((REPO_ROOT / "examples" / "tomatometer" / "email-recipe.json").read_text())
YAML = {"content-type": "application/yaml"}
#: A feasible binding of revision 2 (the generated one): a SPHERE plan for the e-mail task, hand-made candidates
#: for the others.
BINDING = {
    "login": "auth.builtin.local",
    "dailySummary": "email.mailgun.foundation",
    "export": "storage.local.disk",
    "quotes": "quotes.zenquotes.free",
}
FOUNDATION_FROM = {"sphere": "danruilop1/mailgun", "version": "6ade36454b2b5b01c587db3d", "plan": "FOUNDATION"}


async def generated_problem(api_client, registration, db_session, gate) -> tuple[dict, str]:
    """A member's organization with ``tomatometer-email`` revision 1 (uploaded) and 2 (generated from SPHERE), and an
    empty composition ``summary``; returns ``(headers, org)``."""
    headers, org, _, _ = await member(api_client, registration, db_session, gate)
    await upload_problem(api_client, headers, org, archive=base_archive(), slug="tomatometer-email")
    url = f"/v1/organizations/{org}/problems/tomatometer-email/sphere"
    preview = await api_client.post(f"{url}/expand", json={"recipe": EMAIL, "base": {"revision": 1}}, headers=headers)
    assert preview.status_code == 200 and preview.json()["valid"], preview.text
    applied = await api_client.post(
        f"{url}/apply",
        json={"recipe": EMAIL, "base": {"revision": 1}, "expect": {"packageDigest": preview.json()["packageDigest"]}},
        headers=headers,
    )
    assert applied.status_code == 201, applied.text
    created = await api_client.post(f"/v1/organizations/{org}/compositions", json={"slug": "summary", "name": "Summary"},
                                    headers=headers)
    assert created.status_code == 201, created.text
    return headers, org


def compositions(org: str) -> str:
    return f"/v1/organizations/{org}/compositions/summary"
