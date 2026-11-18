"""Derive writes ``from`` for the candidates a SPHERE import generated, and only for them."""

from __future__ import annotations

import pytest
import yaml

from _b1_helpers import gate  # noqa: F401
from compositions._sphere import BINDING, FOUNDATION_FROM, compositions, generated_problem

pytestmark = pytest.mark.asyncio


async def test_derive_writes_from_for_the_generated_candidate_only(api_client, registration, db_session, gate):  # noqa: F811
    headers, org = await generated_problem(api_client, registration, db_session, gate)
    base = compositions(org)
    derived = await api_client.post(
        f"{base}/derive", headers=headers,
        json={"revision": "tomatometer-email@2", "binding": BINDING, "version": "1.0.0"},
    )
    assert derived.status_code == 201, derived.text
    content = (await api_client.get(f"{base}/versions/1/content", headers=headers)).text
    binding = yaml.safe_load(content)["binding"]
    assert binding["dailySummary"]["from"] == FOUNDATION_FROM
    assert all("from" not in entry for task, entry in binding.items() if task != "dailySummary")
    assert not any(item["code"] == "c2y_provenance_missing" for item in derived.json()["diagnostics"])
    assert derived.json()["version"]["analytics"]["upstreamPricings"] == 1

    again = await api_client.post(
        f"{base}/derive", headers=headers,
        json={"revision": "tomatometer-email@2", "binding": BINDING, "version": "1.0.0", "seal": False},
    )
    assert again.status_code == 200 and again.json()["content"] == content


async def test_derive_on_a_package_only_revision_writes_no_from(api_client, registration, db_session, gate):  # noqa: F811
    headers, org = await generated_problem(api_client, registration, db_session, gate)
    base = compositions(org)
    hand = {**BINDING, "dailySummary": "email.selfhosted.postfix"}
    derived = await api_client.post(
        f"{base}/derive", headers=headers, json={"revision": "tomatometer-email@1", "binding": hand, "version": "1.0.0"},
    )
    assert derived.status_code == 201, derived.text
    content = (await api_client.get(f"{base}/versions/1/content", headers=headers)).text
    assert "from:" not in content
    assert derived.json()["version"]["analytics"]["upstreamPricings"] == 0
