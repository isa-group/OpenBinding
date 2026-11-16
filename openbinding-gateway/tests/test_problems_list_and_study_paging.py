"""The problems list embeds each problem's latest revision and its revision count, and the studies list pages
(F2c G6), so a list page needs no request per row."""

from __future__ import annotations

from _problem_helpers import make_org, upload_problem
from test_study_frozen_definition import _signed_in, _study, study_gate  # noqa: F401


async def test_a_problems_list_row_carries_its_latest_revision_and_count(api_client, registration, study_gate):  # noqa: F811
    headers = await _signed_in(api_client, registration, study_gate)
    org = await make_org(api_client, headers)
    await upload_problem(api_client, headers, org=org, slug="checkout")

    listed = await api_client.get(f"/v1/organizations/{org}/problems", headers=headers)

    assert listed.status_code == 200, listed.text
    (row,) = listed.json()["problems"]
    assert row["revision_count"] == 1
    assert row["latest_revision"]["revision"] == 1


async def test_the_studies_list_pages_with_a_total(api_client, registration, study_gate):  # noqa: F811
    headers = await _signed_in(api_client, registration, study_gate)
    org = await make_org(api_client, headers)
    revision_id = (await upload_problem(api_client, headers, org=org, slug="checkout"))["revision_id"]
    for slug in ("alpha", "beta", "gamma"):
        await _study(api_client, headers, org, [revision_id], slug=slug)

    page = await api_client.get(f"/v1/organizations/{org}/studies", headers=headers, params={"limit": 2, "offset": 1})
    whole = await api_client.get(f"/v1/organizations/{org}/studies", headers=headers)

    assert [row["slug"] for row in page.json()] == ["beta", "gamma"]
    assert page.headers["x-total-count"] == "3" and len(whole.json()) == 3
