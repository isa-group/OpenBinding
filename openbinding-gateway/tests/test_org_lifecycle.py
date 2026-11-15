"""Deleting an organization, and the slugs an organization may not take (F0b B8).

The organization is the only container. Deleting one takes its whole subtree in one transaction: studies,
run presets, compositions, problems with their revisions and compilations, blob rows, invitations, memberships
and audit events. Runs and study runs are history, so a subtree that holds any is refused with 409 ``historical_references``. Stored files
are not unlinked (D14): they are content addressed and may back another organization's blob.

An organization slug is the first segment of ``/app/<slug>``, so the fixed places of the application and the
sections under an organization are refused with 422 ``slug_reserved``.
"""

from __future__ import annotations

import uuid
from pathlib import Path

import pytest
from sqlalchemy import func, select

from _problem_helpers import seed_problem_run, upload_problem
from openbinding_gateway.db.models import (
    AuditEvent,
    BindingCase,
    BindingCaseRevision,
    Blob,
    Composition,
    Job,
    JobState,
    Organization,
    OrganizationInvitation,
    OrganizationMembership,
    ProblemCompilation,
    RunPreset,
    Study,
    User,
)
from openbinding_gateway.models.platform import RESERVED_ORGANIZATION_SLUGS
from test_study_frozen_definition import _signed_in, _study, queued_cells, study_gate  # noqa: F401


async def _count(db, model, *conditions) -> int:
    return int(await db.scalar(select(func.count()).select_from(model).where(*conditions)) or 0)


def _code(response) -> str | None:
    body = response.json()
    detail = body.get("detail")
    return body.get("code") or (detail.get("code") if isinstance(detail, dict) else None)


async def _user_id(client, headers) -> uuid.UUID:
    return uuid.UUID((await client.get("/v1/users/me", headers=headers)).json()["id"])


async def _child(client, headers, parent_id: str) -> dict:
    created = await client.post(
        "/v1/organizations", headers=headers,
        json={"slug": f"child-{uuid.uuid4().hex[:8]}", "name": "Child", "parent_id": parent_id},
    )
    assert created.status_code == 201, created.text
    return created.json()


def _a_run(owner_id: uuid.UUID, refs: dict) -> Job:
    return Job(
        owner_id=owner_id, engine_id="random-search", engine_job_id=str(uuid.uuid4()), service_url="http://engine",
        state=JobState.COMPLETED, original_request={}, options={}, provenance={},
        organization_id=refs["organization_id"], revision_id=refs["revision_id"], compilation_id=refs["compilation_id"],
    )


# -- refused while history exists ---------------------------------------------------------------------------


async def test_an_organization_with_a_run_cannot_be_deleted(api_client, db_session, registration, study_gate) -> None:  # noqa: F811
    headers = await _signed_in(api_client, registration, study_gate)
    uploaded = await upload_problem(api_client, headers)
    org = uploaded["org"]
    organization = await db_session.scalar(select(Organization).where(Organization.slug == org))
    compilation_id = await db_session.scalar(
        select(ProblemCompilation.id).where(ProblemCompilation.revision_id == uuid.UUID(uploaded["revision_id"]))
    )
    db_session.add(_a_run(await _user_id(api_client, headers), {
        "organization_id": organization.id, "revision_id": uuid.UUID(uploaded["revision_id"]),
        "compilation_id": compilation_id,
    }))
    await db_session.flush()

    refused = await api_client.delete(f"/v1/organizations/{org}", headers=headers)

    assert refused.status_code == 409, refused.text
    assert _code(refused) == "historical_references"
    assert (await api_client.get(f"/v1/organizations/{org}/problems/{uploaded['problem']['slug']}", headers=headers)).status_code == 200


async def test_a_run_below_the_organization_keeps_the_whole_subtree(
    api_client, db_session, registration, study_gate  # noqa: F811
) -> None:
    headers = await _signed_in(api_client, registration, study_gate)
    parent = (await api_client.post(
        "/v1/organizations", headers=headers, json={"slug": f"root-{uuid.uuid4().hex[:8]}", "name": "Root"}
    )).json()
    child = await _child(api_client, headers, parent["id"])
    owner_id = await _user_id(api_client, headers)
    refs = await seed_problem_run(db_session, owner_id=owner_id, organization_id=uuid.UUID(child["id"]))
    db_session.add(_a_run(owner_id, refs))
    await db_session.flush()

    refused = await api_client.delete(f"/v1/organizations/{parent['slug']}", headers=headers)

    assert refused.status_code == 409, refused.text
    assert _code(refused) == "historical_references"
    assert (await api_client.get(f"/v1/organizations/{child['slug']}", headers=headers)).status_code == 200


async def test_an_organization_with_a_study_run_cannot_be_deleted(
    api_client, registration, study_gate, queued_cells  # noqa: F811
) -> None:
    headers = await _signed_in(api_client, registration, study_gate)
    uploaded = await upload_problem(api_client, headers)
    org = uploaded["org"]
    await _study(api_client, headers, org, [uploaded["revision_id"]])
    assert (await api_client.post(f"/v1/organizations/{org}/studies/frozen/runs", headers=headers)).status_code == 202

    refused = await api_client.delete(f"/v1/organizations/{org}", headers=headers)

    assert refused.status_code == 409, refused.text
    assert _code(refused) == "historical_references"


# -- otherwise everything of the subtree goes, files stay ---------------------------------------------------


async def test_deleting_an_organization_takes_its_subtree_and_leaves_the_files(
    api_client, db_session, registration, study_gate, artifact_root  # noqa: F811
) -> None:
    headers = await _signed_in(api_client, registration, study_gate)
    uploaded = await upload_problem(api_client, headers)
    org = uploaded["org"]
    organization = await db_session.scalar(select(Organization).where(Organization.slug == org))
    await _study(api_client, headers, org, [uploaded["revision_id"]])
    invited = await api_client.post(
        f"/v1/organizations/{org}/invitations", headers=headers, json={"email": "someone@example.org"}
    )
    assert invited.status_code == 201, invited.text
    child = await _child(api_client, headers, str(organization.id))
    in_child = await upload_problem(api_client, headers, child["slug"])
    for where in (org, child["slug"]):
        composed = await api_client.post(
            f"/v1/organizations/{where}/compositions", headers=headers, json={"slug": "checkout", "name": "Checkout"}
        )
        assert composed.status_code == 201, composed.text
        preset = await api_client.post(
            f"/v1/organizations/{where}/presets", headers=headers,
            json={"slug": "quick", "name": "Quick", "engine": "random-search"},
        )
        assert preset.status_code == 201, preset.text
    blob = await db_session.scalar(
        select(Blob).join(BindingCaseRevision, BindingCaseRevision.package_blob_id == Blob.id)
        .where(BindingCaseRevision.id == uuid.UUID(uploaded["revision_id"]))
    )
    stored = Path(blob.storage_uri.removeprefix("file://"))
    assert stored.is_file()
    ids = [organization.id, uuid.UUID(child["id"])]
    revisions = [uuid.UUID(uploaded["revision_id"]), uuid.UUID(in_child["revision_id"])]

    deleted = await api_client.delete(f"/v1/organizations/{org}", headers=headers)

    assert deleted.status_code == 204, deleted.text
    db_session.expire_all()
    assert await _count(db_session, Organization, Organization.id.in_(ids)) == 0
    assert await _count(db_session, BindingCase, BindingCase.organization_id.in_(ids)) == 0
    assert await _count(db_session, BindingCaseRevision, BindingCaseRevision.id.in_(revisions)) == 0
    assert await _count(db_session, ProblemCompilation, ProblemCompilation.revision_id.in_(revisions)) == 0
    assert await _count(db_session, Study, Study.organization_id.in_(ids)) == 0
    assert await _count(db_session, Composition, Composition.organization_id.in_(ids)) == 0
    assert await _count(db_session, RunPreset, RunPreset.organization_id.in_(ids)) == 0
    assert await _count(db_session, Blob, Blob.organization_id.in_(ids)) == 0
    assert await _count(db_session, OrganizationMembership, OrganizationMembership.organization_id.in_(ids)) == 0
    assert await _count(db_session, OrganizationInvitation, OrganizationInvitation.organization_id.in_(ids)) == 0
    assert await _count(db_session, AuditEvent, AuditEvent.organization_id.in_(ids)) == 0
    # The account that owned it stays, and the package file is still on disk.
    assert await db_session.get(User, await _user_id(api_client, headers)) is not None
    assert stored.is_file()
    assert (await api_client.get(f"/v1/organizations/{child['slug']}", headers=headers)).status_code == 404


async def test_only_an_admin_or_owner_deletes(api_client, db_session, registration, study_gate) -> None:  # noqa: F811
    owner = await _signed_in(api_client, registration, study_gate)
    member = await _signed_in(api_client, registration, study_gate)
    org = (await upload_problem(api_client, owner))["org"]
    member_id = str(await _user_id(api_client, member))
    added = await api_client.put(
        f"/v1/organizations/{org}/members/{member_id}", headers=owner, json={"user_id": member_id, "role": "MEMBER"}
    )
    assert added.status_code == 200, added.text

    refused = await api_client.delete(f"/v1/organizations/{org}", headers=member)

    assert refused.status_code == 403, refused.text
    assert _code(refused) == "organization_forbidden"
    assert (await api_client.get(f"/v1/organizations/{org}", headers=owner)).status_code == 200


# -- reserved slugs -----------------------------------------------------------------------------------------


def test_the_reserved_slugs_are_the_fixed_places_and_the_organization_sections():
    assert RESERVED_ORGANIZATION_SLUGS == {
        "admin", "account", "engines", "organizations", "invitations",
        "runs", "problems", "studies", "settings", "workbench", "new",
    }


@pytest.mark.parametrize("slug", sorted(RESERVED_ORGANIZATION_SLUGS))
async def test_a_reserved_slug_is_refused(api_client, registration, study_gate, slug) -> None:  # noqa: F811
    headers = await _signed_in(api_client, registration, study_gate)

    refused = await api_client.post("/v1/organizations", headers=headers, json={"slug": slug, "name": slug})

    assert refused.status_code == 422, refused.text
    assert _code(refused) == "slug_reserved"
    assert (await api_client.get("/v1/organizations", headers=headers)).json() == []


async def test_the_slug_of_an_organization_cannot_be_changed(api_client, registration, study_gate) -> None:  # noqa: F811
    headers = await _signed_in(api_client, registration, study_gate)
    org = (await api_client.post(
        "/v1/organizations", headers=headers, json={"slug": f"lab-{uuid.uuid4().hex[:8]}", "name": "Lab"}
    )).json()

    refused = await api_client.patch(f"/v1/organizations/{org['slug']}", headers=headers, json={"slug": "admin"})

    assert refused.status_code == 422, refused.text
    assert (await api_client.get(f"/v1/organizations/{org['slug']}", headers=headers)).status_code == 200
