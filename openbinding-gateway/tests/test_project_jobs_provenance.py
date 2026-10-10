"""``engineRoutingAdmin`` provenance is shown to platform administrators only."""

from __future__ import annotations

import uuid

from _b1_helpers import gate, make_account, make_org, put_member  # noqa: F401
from openbinding_gateway.db.models import Job, JobState
from openbinding_gateway.models.platform import job_view

ROUTING = {"fallbackEngine": "random-search", "reason": "internal"}


def _job(owner_id, organization_id=None, project_id=None) -> Job:
    return Job(
        owner_id=owner_id, engine_id="random-search", engine_job_id=str(uuid.uuid4()),
        service_url="http://engine", state=JobState.COMPLETED,
        organization_id=organization_id, project_id=project_id,
        provenance={"irDigest": "sha256-x", "engineRoutingAdmin": dict(ROUTING)},
    )


async def test_project_jobs_hide_routing_from_a_viewer_and_show_it_to_a_platform_admin(
    api_client, registration, db_session, gate  # noqa: F811
):
    owner, owner_h = await make_account(api_client, registration, db_session, gate)
    viewer, viewer_h = await make_account(api_client, registration, db_session, gate)
    admin, admin_h = await make_account(api_client, registration, db_session, gate, admin=True)
    organization = await make_org(api_client, owner_h)
    slug = organization["slug"]
    # The administrator is also a member, so the only difference is the role.
    for account in (viewer, admin):
        assert (await put_member(api_client, owner_h, slug, account["id"], "VIEWER")).status_code == 200
    created = await api_client.post(
        f"/v1/organizations/{slug}/projects", headers=owner_h,
        json={"slug": "p", "name": "P", "description": "d", "visibility": "private"},
    )
    assert created.status_code == 201, created.text
    job = _job(uuid.UUID(owner["id"]), uuid.UUID(organization["id"]), uuid.UUID(created.json()["id"]))
    db_session.add(job)
    await db_session.flush()
    url = f"/v1/organizations/{slug}/projects/p/jobs"

    seen = await api_client.get(url, headers=viewer_h)
    assert seen.status_code == 200, seen.text
    assert seen.json()[0]["provenance"] == {"irDigest": "sha256-x"}

    privileged = await api_client.get(url, headers=admin_h)
    assert privileged.status_code == 200, privileged.text
    assert privileged.json()[0]["provenance"]["engineRoutingAdmin"] == ROUTING

    # The stored row is never edited to build a view.
    assert job.provenance["engineRoutingAdmin"] == ROUTING


async def test_get_v1_job_hides_routing_from_its_owner_and_is_not_readable_by_an_admin_who_is_not(
    api_client, registration, db_session, gate  # noqa: F811
):
    owner, owner_h = await make_account(api_client, registration, db_session, gate)
    admin, admin_h = await make_account(api_client, registration, db_session, gate, admin=True)
    job = _job(uuid.UUID(owner["id"]))
    admin_job = _job(uuid.UUID(admin["id"]))
    db_session.add_all([job, admin_job])
    await db_session.flush()

    mine = await api_client.get(f"/v1/jobs/{job.id}", headers=owner_h)
    assert mine.status_code == 200, mine.text
    assert mine.json()["provenance"] == {"irDigest": "sha256-x"}

    # Real behaviour: jobs are readable by their owner only, and a platform
    # administrator who does not own the job gets 404, not its provenance.
    foreign = await api_client.get(f"/v1/jobs/{job.id}", headers=admin_h)
    assert foreign.status_code == 404
    assert "engineRoutingAdmin" not in foreign.text

    # An administrator reading a job of their own does see the routing record.
    own = await api_client.get(f"/v1/jobs/{admin_job.id}", headers=admin_h)
    assert own.status_code == 200, own.text
    assert own.json()["provenance"]["engineRoutingAdmin"] == ROUTING


async def test_job_view_without_results_and_the_jobs_list_for_the_owner(
    api_client, registration, db_session, gate  # noqa: F811
):
    owner, owner_h = await make_account(api_client, registration, db_session, gate)
    job = _job(uuid.UUID(owner["id"]))
    db_session.add(job)
    await db_session.flush()

    assert job_view(job, owner, include_results=False).provenance is None

    listed = await api_client.get("/v1/jobs", headers=owner_h)
    assert listed.status_code == 200, listed.text
    assert listed.json()[0]["provenance"] == {"irDigest": "sha256-x"}
