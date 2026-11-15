"""Run provenance is the same record for every reader: no view adds administrator-only fields."""

from __future__ import annotations

import uuid

from _b1_helpers import gate, make_account, make_org, put_member  # noqa: F401
from _problem_helpers import run_refs, run_url, runs_url, seed_problem_run
from openbinding_gateway.db.models import Job, JobState
from openbinding_gateway.models.platform import job_view

PROVENANCE = {"irDigest": "sha256-x"}


async def _job(db_session, owner_id, organization_id) -> Job:
    job = Job(
        owner_id=owner_id, engine_id="random-search", engine_job_id=str(uuid.uuid4()),
        service_url="http://engine", state=JobState.COMPLETED, provenance=dict(PROVENANCE),
        **run_refs(await seed_problem_run(db_session, owner_id=owner_id, organization_id=organization_id)),
    )
    db_session.add(job)
    await db_session.flush()
    return job


async def test_a_run_shows_a_viewer_and_a_platform_admin_member_the_same_provenance(
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
    job = await _job(db_session, uuid.UUID(owner["id"]), uuid.UUID(organization["id"]))

    seen = await api_client.get(run_url(job, org=slug), headers=viewer_h)
    assert seen.status_code == 200, seen.text
    assert seen.json()["provenance"] == PROVENANCE

    privileged = await api_client.get(run_url(job, org=slug), headers=admin_h)
    assert privileged.status_code == 200, privileged.text
    assert privileged.json()["provenance"] == PROVENANCE

    # The stored row is never edited to build a view.
    assert job.provenance == PROVENANCE


async def test_a_platform_admin_outside_the_organization_gets_a_404_and_adds_nothing_to_their_own(
    api_client, registration, db_session, gate  # noqa: F811
):
    owner, owner_h = await make_account(api_client, registration, db_session, gate)
    admin, admin_h = await make_account(api_client, registration, db_session, gate, admin=True)
    theirs = await make_org(api_client, owner_h)
    own_org = await make_org(api_client, admin_h)
    job = await _job(db_session, uuid.UUID(owner["id"]), uuid.UUID(theirs["id"]))
    admin_job = await _job(db_session, uuid.UUID(admin["id"]), uuid.UUID(own_org["id"]))

    mine = await api_client.get(run_url(job), headers=owner_h)
    assert mine.status_code == 200, mine.text
    assert mine.json()["provenance"] == PROVENANCE

    # Runs are the organization's: a platform administrator who is not a member gets 404, not the provenance.
    foreign = await api_client.get(run_url(job), headers=admin_h)
    assert foreign.status_code == 404
    assert PROVENANCE["irDigest"] not in foreign.text

    # An administrator reading a run of their own organization sees the same record as any member.
    own = await api_client.get(run_url(admin_job), headers=admin_h)
    assert own.status_code == 200, own.text
    assert own.json()["provenance"] == PROVENANCE


async def test_the_run_list_leaves_the_provenance_to_the_run_page(
    api_client, registration, db_session, gate  # noqa: F811
):
    owner, owner_h = await make_account(api_client, registration, db_session, gate)
    organization = await make_org(api_client, owner_h)
    job = await _job(db_session, uuid.UUID(owner["id"]), uuid.UUID(organization["id"]))

    assert job_view(job, owner, include_results=False).provenance is None

    listed = await api_client.get(runs_url(organization["slug"]), headers=owner_h)
    assert listed.status_code == 200, listed.text
    assert listed.json()["total"] == 1
    assert listed.json()["runs"][0]["id"] == str(job.id)
    assert listed.json()["runs"][0]["provenance"] is None
