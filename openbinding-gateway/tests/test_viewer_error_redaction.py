"""A failed job's ``error`` is ``str(exc)``; a VIEWER must not read it.

The text can name the host or address of a private federated endpoint (for
example "engine endpoint cannot be resolved: 10.0.0.5"), which the redacted view
promises not to show. A VIEWER - and any other redacted view, such as the
package export of a read-only key - gets a fixed sentence instead; a MEMBER
still reads the message.
"""

from __future__ import annotations

from sqlalchemy import select

from _b1_helpers import gate  # noqa: F401
from openbinding_gateway.db.models import Job, JobState, StudyCell
from openbinding_gateway.security.redaction import GENERIC_ERROR, redact_error, redact_result
from test_security_hardening import (
    exported_jobs,
    member,
    project_package_with_a_study_job,
    project_with_a_job,
)

PRIVATE_ERROR = "engine request failed: ConnectError connecting to http://10.0.0.5:8080/private-engine"


def test_the_error_of_a_redacted_result_is_a_fixed_sentence():
    result = {"termination": "UNKNOWN", "solutions": [], "error": PRIVATE_ERROR, "provenance": {}}

    redacted = redact_result(result)

    assert redacted["error"] == GENERIC_ERROR
    assert "10.0.0.5" not in str(redacted)
    assert redacted["termination"] == "UNKNOWN"
    assert result["error"] == PRIVATE_ERROR, "the stored result is never edited"


def test_a_category_code_survives_but_the_message_does_not():
    redacted = redact_result({"error": PRIVATE_ERROR, "errorCode": "engine_error"})

    assert "engine_error" in redacted["error"]
    assert "10.0.0.5" not in redacted["error"]
    assert redacted["errorCode"] == "engine_error"


def test_a_code_that_is_not_a_plain_name_is_not_echoed():
    assert redact_error({"errorCode": "failed at http://10.0.0.5"}) == GENERIC_ERROR
    assert redact_error({"errorCode": 500}) == GENERIC_ERROR


def test_a_result_without_an_error_is_unchanged():
    assert redact_result({"termination": "OPTIMAL", "solutions": []}) == {
        "termination": "OPTIMAL",
        "solutions": [],
    }


async def failed(db_session, job):
    job.state = JobState.FAILED
    job.result = {"termination": "UNKNOWN", "solutions": [], "error": PRIVATE_ERROR, "provenance": {}}
    await db_session.flush()


async def test_a_viewer_does_not_read_the_error_a_member_does(
    api_client, registration, db_session, gate  # noqa: F811
):
    slug, owner_h, job = await project_with_a_job(api_client, registration, db_session, gate)
    await failed(db_session, job)
    viewer_h = await member(api_client, registration, db_session, gate, owner_h, slug, "VIEWER")
    member_h = await member(api_client, registration, db_session, gate, owner_h, slug, "MEMBER")
    url = f"/v1/organizations/{slug}/projects/p/jobs"

    seen_by_viewer = await api_client.get(url, headers=viewer_h)
    seen_by_member = await api_client.get(url, headers=member_h)
    seen_by_owner = await api_client.get(url, headers=owner_h)

    assert seen_by_viewer.status_code == 200, seen_by_viewer.text
    [row] = seen_by_viewer.json()
    assert row["status"] == "failed"
    assert row["result"]["error"] == GENERIC_ERROR
    for leaked in ("10.0.0.5", "private-engine", "ConnectError"):
        assert leaked not in seen_by_viewer.text, leaked
    for response in (seen_by_member, seen_by_owner):
        assert response.status_code == 200, response.text
        assert response.json()[0]["result"]["error"] == PRIVATE_ERROR


async def test_the_package_export_gives_a_viewer_the_same_generic_error(
    api_client, registration, db_session, gate, monkeypatch  # noqa: F811
):
    slug, owner_h, url = await project_package_with_a_study_job(
        api_client, registration, db_session, gate, monkeypatch
    )
    job = (await db_session.scalars(
        select(Job).join(StudyCell, StudyCell.job_id == Job.id)
    )).one()
    await failed(db_session, job)
    viewer_h = await member(api_client, registration, db_session, gate, owner_h, slug, "VIEWER")

    full = await api_client.get(url, headers=owner_h)
    redacted = await api_client.get(url, headers=viewer_h)

    assert full.status_code == 200 and redacted.status_code == 200, (full.text, redacted.text)
    assert PRIVATE_ERROR in full.text
    [viewer_job] = exported_jobs(redacted.json())
    assert viewer_job["result"]["error"] == GENERIC_ERROR
    assert "10.0.0.5" not in redacted.text
