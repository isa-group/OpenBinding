"""Runs belong to their organization (F0b B6, decision D10).

Any member reads the organization's runs, redacted below MEMBER; MEMBER and above create, cancel and
retry them; a non-member learns nothing (404). A run names a revision of the organization in its address:
a revision of another organization is a 409. API keys: ``jobs:read`` reads runs, ``engines:execute``
creates them, and the ``organizations:*`` permissions do neither. A study cell launches as a run of the
study's organization, and finishing one cell launches the next.
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import func, select

from _b1_helpers import gate, make_key, put_member  # noqa: F401
from _problem_helpers import run_url, runs_url, upload_problem
from openbinding_gateway import study_jobs
from openbinding_gateway.core.settings import get_settings
from openbinding_gateway.db.models import Job, JobState
from test_security_hardening import HARMLESS, SENSITIVE_OPTIONS
from test_study_cell_launch import BASE, _cells, _study, study_gate  # noqa: F401
from test_viewer_read_only import code_of, job_body, lab, no_dispatch  # noqa: F401
from test_viewer_error_redaction import PRIVATE_ERROR
from openbinding_gateway.security.redaction import GENERIC_ERROR


async def job_count(db_session) -> int:
    return int(await db_session.scalar(select(func.count()).select_from(Job)))


# -- Reading -------------------------------------------------------------------


async def test_a_viewer_reads_a_teammates_run_redacted(api_client, lab):  # noqa: F811
    viewer = lab.people["VIEWER"].headers
    teammate_run = lab.failed["MEMBER"]

    listed = await api_client.get(lab.runs, headers=viewer)
    one = await api_client.get(lab.run(teammate_run), headers=viewer)

    assert listed.status_code == one.status_code == 200, one.text
    assert str(teammate_run) in {row["id"] for row in listed.json()["runs"]}
    assert listed.json()["total"] == len(listed.json()["runs"]) == 2 * 4
    body = one.json()
    assert body["options"] == HARMLESS
    assert body["error"] == body["result"]["error"] == GENERIC_ERROR
    assert body["created_by"]["id"] == str(lab.people["MEMBER"].id)
    assert "tok-SECRET" not in one.text and PRIVATE_ERROR not in one.text


async def test_a_member_reads_a_teammates_run_whole(api_client, lab):  # noqa: F811
    one = await api_client.get(lab.run(lab.failed["ADMIN"]), headers=lab.people["MEMBER"].headers)

    assert one.status_code == 200, one.text
    assert one.json()["options"] == SENSITIVE_OPTIONS
    assert one.json()["error"] == PRIVATE_ERROR


async def test_the_list_filters_by_state_engine_and_pages(api_client, lab):  # noqa: F811
    headers = lab.people["VIEWER"].headers

    failed = await api_client.get(lab.runs, params={"state": "failed"}, headers=headers)
    page = await api_client.get(lab.runs, params={"limit": 3, "offset": 6}, headers=headers)
    other_engine = await api_client.get(lab.runs, params={"engine": "minizinc-csp"}, headers=headers)
    by_revision = await api_client.get(lab.runs, params={"revision": lab.snapshot}, headers=headers)
    by_problem = await api_client.get(lab.runs, params={"problem": "c"}, headers=headers)

    assert {row["status"] for row in failed.json()["runs"]} == {"failed"} and failed.json()["total"] == 4
    assert len(page.json()["runs"]) == 2 and page.json()["total"] == 8
    assert other_engine.json() == {"runs": [], "total": 0}
    assert by_revision.json()["total"] == by_problem.json()["total"] == 8
    # A list carries summaries: results load with the run.
    assert all(row["result"] is None and row["provenance"] is None for row in failed.json()["runs"])


async def test_a_non_member_gets_a_404_for_the_runs_and_for_one_run(api_client, lab):  # noqa: F811
    headers = lab.outsider.headers
    run = lab.failed["MEMBER"]

    responses = [
        await api_client.get(lab.runs, headers=headers),
        await api_client.get(lab.run(run), headers=headers),
        await api_client.get(lab.run(run, "/events"), headers=headers),
        await api_client.post(lab.run(run, "/retry"), headers=headers),
        await api_client.post(lab.run(lab.queued["MEMBER"], "/cancel"), headers=headers),
        await api_client.post(lab.runs, headers=headers, json=job_body(lab.snapshot)),
    ]

    assert [response.status_code for response in responses] == [404] * len(responses)
    assert len({response.text for response in responses}) == 1
    assert all(response.headers["content-type"].startswith("application/json") for response in responses)


async def test_a_run_of_another_organization_reads_as_missing_through_this_one(api_client, lab):  # noqa: F811
    # The outsider's own organization, where the lab's members are not: its address does not reach the lab's run.
    response = await api_client.get(run_url(lab.failed["MEMBER"], org=lab.outsider_org), headers=lab.outsider.headers)

    assert response.status_code == 404
    assert code_of(response) == "not_found"


# -- Working -------------------------------------------------------------------


async def test_a_viewer_cannot_create_cancel_or_retry(api_client, db_session, lab):  # noqa: F811
    viewer = lab.people["VIEWER"].headers
    before = await job_count(db_session)

    created = await api_client.post(lab.runs, headers=viewer, json=job_body(lab.snapshot))
    cancelled = await api_client.post(lab.run(lab.queued["MEMBER"], "/cancel"), headers=viewer)
    retried = await api_client.post(lab.run(lab.failed["MEMBER"], "/retry"), headers=viewer)
    reevaluated = await api_client.post(lab.run(lab.failed["MEMBER"], "/reevaluate"), headers=viewer)

    for response in (created, cancelled, retried, reevaluated):
        assert response.status_code == 403, response.text
        assert code_of(response) == "insufficient_role"
    assert await job_count(db_session) == before


async def test_a_member_cancels_and_retries_a_teammates_run_as_their_own(api_client, db_session, lab):  # noqa: F811
    member = lab.people["MEMBER"]
    for role in ("VIEWER", "MEMBER", "ADMIN", "OWNER"):
        # Free the account slots the seeded queued runs hold.
        (await db_session.get(Job, lab.queued[role])).state = JobState.CANCELLED
    queued = lab.queued["ADMIN"]
    (await db_session.get(Job, queued)).state = JobState.QUEUED
    await db_session.flush()

    cancelled = await api_client.post(lab.run(queued, "/cancel"), headers=member.headers)
    retried = await api_client.post(lab.run(lab.failed["OWNER"], "/retry"), headers=member.headers)
    again = await api_client.post(lab.run(lab.failed["OWNER"], "/retry"), headers=lab.people["ADMIN"].headers)

    assert cancelled.status_code == 200 and cancelled.json()["status"] == "cancelled", cancelled.text
    assert retried.status_code == again.status_code == 202, retried.text
    # One retry for the organization, whoever asks; the new run is the caller's.
    assert again.json()["id"] == retried.json()["id"]
    replacement = await db_session.get(Job, uuid.UUID(retried.json()["id"]))
    assert replacement.created_by_id == member.id
    assert replacement.organization_id == lab.org_id
    assert replacement.retry_of_id == lab.failed["OWNER"]


async def test_a_revision_of_another_organization_is_a_409(api_client, db_session, lab):  # noqa: F811
    member = lab.people["MEMBER"]
    (await db_session.get(Job, lab.queued["MEMBER"])).state = JobState.CANCELLED
    await db_session.flush()
    elsewhere = await upload_problem(api_client, member.headers)
    before = await job_count(db_session)

    wrong = await api_client.post(lab.runs, headers=member.headers, json=job_body(elsewhere["revision_id"]))
    right = await api_client.post(runs_url(elsewhere["org"]), headers=member.headers, json=job_body(elsewhere["revision_id"]))

    assert wrong.status_code == 409, wrong.text
    assert code_of(wrong) == "revision_not_in_organization"
    assert wrong.json()["detail"]["code"] == "revision_not_in_organization"
    assert right.status_code == 202, right.text
    job = await db_session.get(Job, uuid.UUID(right.json()["id"]))
    assert str(job.organization_id) == elsewhere["problem"]["organization_id"]
    assert await job_count(db_session) == before + 1


# -- API keys ------------------------------------------------------------------


async def test_a_jobs_read_key_lists_runs_and_cannot_create_one(api_client, db_session, lab):  # noqa: F811
    key = await make_key(api_client, lab.people["MEMBER"].headers, ["jobs:read"])

    listed = await api_client.get(lab.runs, headers=key)
    created = await api_client.post(lab.runs, headers=key, json=job_body(lab.snapshot))

    assert listed.status_code == 200, listed.text
    assert listed.json()["total"] == 8
    # Without engines:execute the key is a read-only credential: a MEMBER's reads are redacted.
    assert all(row["options"] == HARMLESS for row in listed.json()["runs"])
    assert created.status_code == 403
    assert code_of(created) == "insufficient_api_key_permission"


async def test_an_engines_execute_key_creates_a_run(api_client, db_session, lab):  # noqa: F811
    (await db_session.get(Job, lab.queued["MEMBER"])).state = JobState.CANCELLED
    await db_session.flush()
    key = await make_key(api_client, lab.people["MEMBER"].headers, ["engines:execute"])

    created = await api_client.post(lab.runs, headers=key, json=job_body(lab.snapshot))

    assert created.status_code == 202, created.text


@pytest.mark.parametrize("permissions", [["organizations:read"], ["organizations:write"], ["organizations:read", "organizations:write"]])
async def test_an_organizations_key_neither_reads_nor_creates_runs(api_client, lab, permissions):  # noqa: F811
    key = await make_key(api_client, lab.people["OWNER"].headers, permissions)

    listed = await api_client.get(lab.runs, headers=key)
    created = await api_client.post(lab.runs, headers=key, json=job_body(lab.snapshot))

    assert listed.status_code == created.status_code == 403
    assert code_of(listed) == code_of(created) == "insufficient_api_key_permission"


# -- Study cells ---------------------------------------------------------------


async def test_finishing_a_cell_launches_the_next_one_as_a_run_of_the_studys_organization(
    api_client, db_session, registration, study_gate, monkeypatch  # noqa: F811
):
    async def queued(*args, **kwargs):
        return None

    monkeypatch.setattr(study_jobs, "dispatch_persisted_job", queued)
    # One run at a time: the second cell waits for the first one's slot.
    monkeypatch.setattr(get_settings(), "max_concurrent_jobs_per_user", 1)
    headers = await _study(api_client, registration, [1, 2])
    run = await api_client.post(BASE, headers=headers)
    assert run.status_code == 202, run.text
    first, second = await _cells(db_session, run.json()["id"])
    assert first.job_id is not None and second.job_id is None
    job = await db_session.get(Job, first.job_id)
    organization_id = job.organization_id
    job.state = JobState.COMPLETED
    job.result = {"termination": "FEASIBLE", "solutions": []}
    await db_session.flush()

    await study_jobs.sync_study_job(str(job.id), db_session)

    await db_session.refresh(second)
    assert second.job_id is not None, "the _sync guard launches the next queued cell"
    launched = await db_session.get(Job, second.job_id)
    assert launched.organization_id == organization_id
    assert launched.study_cell_id == second.id
