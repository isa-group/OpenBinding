"""Deleting an organization, and the slugs an organization may not take (F0b B8).

The organization is the only container. Deleting one takes its whole subtree in one transaction: studies,
run presets, compositions, problems with their revisions and compilations, blob rows, invitations, memberships
and audit events. Runs and study runs are history, so a subtree that holds any is refused with 409 ``historical_references``. Stored files
are not unlinked (D14): they are content addressed and may back another organization's blob.

An organization page is ``/orgs/<slug>``, so the static children of that address (``new``, ``join``) and ``public``,
which would shadow ``GET /v1/organizations/public``, are refused with 422 ``slug_reserved``.
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
    OrganizationInvitationCode,
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


def _a_run(created_by_id: uuid.UUID, refs: dict) -> Job:
    return Job(
        created_by_id=created_by_id, engine_id="random-search", engine_job_id=str(uuid.uuid4()), service_url="http://engine",
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
    refs = await seed_problem_run(db_session, created_by_id=owner_id, organization_id=uuid.UUID(child["id"]))
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
        f"/v1/organizations/{org}/invitations", headers=headers, json={}
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
    assert await _count(db_session, OrganizationInvitationCode, OrganizationInvitationCode.organization_id.in_(ids)) == 0
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


def test_the_reserved_slugs_are_the_static_children_of_the_organization_page_and_public():
    assert RESERVED_ORGANIZATION_SLUGS == {"new", "join", "public"}


@pytest.mark.parametrize("slug", sorted(RESERVED_ORGANIZATION_SLUGS))
async def test_a_reserved_slug_is_refused(api_client, registration, study_gate, slug) -> None:  # noqa: F811
    headers = await _signed_in(api_client, registration, study_gate)

    refused = await api_client.post("/v1/organizations", headers=headers, json={"slug": slug, "name": slug})

    assert refused.status_code == 422, refused.text
    assert _code(refused) == "slug_reserved"
    # Nothing was created: the account holds its personal organization only.
    assert [row["is_personal"] for row in (await api_client.get("/v1/organizations", headers=headers)).json()] == [True]


async def test_the_slug_of_an_organization_cannot_be_changed(api_client, registration, study_gate) -> None:  # noqa: F811
    headers = await _signed_in(api_client, registration, study_gate)
    org = (await api_client.post(
        "/v1/organizations", headers=headers, json={"slug": f"lab-{uuid.uuid4().hex[:8]}", "name": "Lab"}
    )).json()

    refused = await api_client.patch(f"/v1/organizations/{org['slug']}", headers=headers, json={"slug": "admin"})

    assert refused.status_code == 422, refused.text
    assert (await api_client.get(f"/v1/organizations/{org['slug']}", headers=headers)).status_code == 200


async def test_deleting_an_organization_takes_its_composition_environments(
    api_client, db_session, registration, study_gate  # noqa: F811
) -> None:
    """Environment keys, adoptions and environments go before the versions and evaluations they reference."""
    from _environment_rows import operated
    from openbinding_gateway.db.models import (
        CompositionAdoption,
        CompositionEnvironment,
        CompositionEnvironmentKey,
        CompositionVersion,
    )

    headers = await _signed_in(api_client, registration, study_gate)
    created = await api_client.post("/v1/organizations", headers=headers,
                                    json={"slug": f"o-{uuid.uuid4().hex[:8]}", "name": "O"})
    assert created.status_code == 201, created.text
    org = created.json()["slug"]
    composed = await api_client.post(
        f"/v1/organizations/{org}/compositions", headers=headers, json={"slug": "tomato", "name": "Tomato"}
    )
    assert composed.status_code == 201, composed.text
    body = composed.json()
    environment_id = await operated(
        db_session, uuid.UUID(body["organization"]["id"]), uuid.UUID(body["id"]), await _user_id(api_client, headers)
    )

    deleted = await api_client.delete(f"/v1/organizations/{org}", headers=headers)

    assert deleted.status_code == 204, deleted.text
    db_session.expire_all()
    assert await _count(db_session, CompositionEnvironment, CompositionEnvironment.id == environment_id) == 0
    assert await _count(db_session, CompositionAdoption, CompositionAdoption.environment_id == environment_id) == 0
    assert await _count(
        db_session, CompositionEnvironmentKey, CompositionEnvironmentKey.environment_id == environment_id
    ) == 0
    assert await _count(db_session, CompositionVersion, CompositionVersion.composition_id == uuid.UUID(body["id"])) == 0


async def test_deleting_an_organization_takes_its_watches_refs_and_upstream_events(
    api_client, db_session, registration, study_gate  # noqa: F811
) -> None:
    """F6: events, refs and attempts go before the versions they name; the organization's own watches go before its
    snapshots; a shared (public) watch stays for everyone."""
    from _environment_rows import _version
    from _upstream_rows import World, attempt, event, ref, watch
    from openbinding_gateway.db.models import CompositionUpstreamEvent, PricingRefAttempt, PricingWatch, PricingWatchRef

    headers = await _signed_in(api_client, registration, study_gate)
    created = await api_client.post("/v1/organizations", headers=headers,
                                    json={"slug": f"o-{uuid.uuid4().hex[:8]}", "name": "O"})
    org = created.json()["slug"]
    body = (await api_client.post(
        f"/v1/organizations/{org}/compositions", headers=headers, json={"slug": "tomato", "name": "Tomato"}
    )).json()
    organization_id, composition_id = uuid.UUID(body["organization"]["id"]), uuid.UUID(body["id"])
    user_id = await _user_id(api_client, headers)
    version_id, evaluation_id = await _version(db_session, composition_id, user_id, 1, "1.0.0")
    w = World(user_id, organization_id, composition_id, (version_id,), (evaluation_id,), composition_id, version_id,
              evaluation_id)
    shared = await watch(db_session)
    own = await watch(db_session, organization_id=organization_id)
    await ref(db_session, w, shared)
    await ref(db_session, w, own, pinned="c" * 24)
    await ref(db_session, w, None, sphere_ref="nobody/nothing")
    await attempt(db_session, organization_id)
    await event(db_session, w, shared)
    await db_session.commit()

    deleted = await api_client.delete(f"/v1/organizations/{org}", headers=headers)

    assert deleted.status_code == 204, deleted.text
    db_session.expire_all()
    assert await _count(db_session, CompositionUpstreamEvent, CompositionUpstreamEvent.organization_id == organization_id) == 0
    assert await _count(db_session, PricingWatchRef, PricingWatchRef.organization_id == organization_id) == 0
    assert await _count(db_session, PricingRefAttempt, PricingRefAttempt.organization_id == organization_id) == 0
    assert await _count(db_session, PricingWatch, PricingWatch.id == own) == 0
    assert await _count(db_session, PricingWatch, PricingWatch.id == shared) == 1


async def _proposal_world(db_session, organization_id: uuid.UUID, user_id: uuid.UUID):
    """A composition of ``organization_id`` with 1.0.0 in effect in ``production`` through a proposal that answers an
    upstream event, a superseded proposal before it, and both proposals' steps (F6-B rows)."""
    from _environment_rows import World, _version, adoption, environment
    from _proposal_rows import proposal, step
    from _upstream_rows import event, watch
    from openbinding_gateway.db.models import Proposal, utcnow

    composition = Composition(organization_id=organization_id, slug=f"c-{uuid.uuid4().hex[:6]}", name="C",
                              created_by_id=user_id)
    db_session.add(composition)
    await db_session.flush()
    version_id, evaluation_id = await _version(db_session, composition.id, user_id, 1, "1.0.0")
    w = World(user_id, organization_id, composition.id, (version_id,), (evaluation_id,), composition.id, version_id,
              evaluation_id)
    shared = await watch(db_session)
    answered = await event(db_session, w, shared)
    done = await proposal(db_session, w, status="completed", upstream_event_id=answered)
    await step(db_session, done, status="done", result={"ordinal": 1}, finished_at=utcnow())
    old = await proposal(db_session, w, status="superseded", superseded_by_id=done)
    await step(db_session, old)
    environment_id = await environment(db_session, w, adopted_version_id=version_id, adoption_ordinal=1)
    await adoption(db_session, w, environment_id, 1, source="proposal", proposal_id=done)
    await db_session.commit()
    return w, Proposal


async def test_deleting_an_organization_takes_its_proposals_and_the_adoptions_made_through_them(
    api_client, db_session, registration, study_gate  # noqa: F811
) -> None:
    """F6-B: adoptions (they name proposals), then proposal steps and proposals (they name events), then events."""
    from openbinding_gateway.db.models import CompositionAdoption, CompositionUpstreamEvent, ProposalStep

    headers = await _signed_in(api_client, registration, study_gate)
    created = await api_client.post("/v1/organizations", headers=headers,
                                    json={"slug": f"o-{uuid.uuid4().hex[:8]}", "name": "O"})
    assert created.status_code == 201, created.text
    org, organization_id = created.json()["slug"], uuid.UUID(created.json()["id"])
    w, Proposal = await _proposal_world(db_session, organization_id, await _user_id(api_client, headers))

    deleted = await api_client.delete(f"/v1/organizations/{org}", headers=headers)

    assert deleted.status_code == 204, deleted.text
    db_session.expire_all()
    assert await _count(db_session, Proposal, Proposal.organization_id == organization_id) == 0
    assert await _count(db_session, ProposalStep) == 0
    assert await _count(db_session, CompositionAdoption, CompositionAdoption.composition_id == w.composition_id) == 0
    assert await _count(db_session, CompositionUpstreamEvent,
                        CompositionUpstreamEvent.organization_id == organization_id) == 0


async def test_deleting_an_account_takes_its_personal_organizations_proposals(api_client, db_session, registration) -> None:
    """F6-B: a personal organization goes with its account, its proposals and their adoption included."""
    from test_account_pseudonymisation import delete as delete_account
    from test_account_pseudonymisation import signed_in

    profile, headers, _ = await signed_in(api_client, registration)
    personal = next(row for row in (await api_client.get("/v1/organizations", headers=headers)).json()
                    if row["is_personal"])
    personal_id = uuid.UUID(personal["id"])
    w, Proposal = await _proposal_world(db_session, personal_id, uuid.UUID(profile["id"]))

    deleted = await delete_account(api_client, profile, headers)

    assert deleted.status_code == 204, deleted.text
    db_session.expire_all()
    assert await _count(db_session, Organization, Organization.id == personal_id) == 0
    assert await _count(db_session, Proposal, Proposal.organization_id == personal_id) == 0


async def test_deleting_an_account_cancels_its_pending_proposals_in_team_organizations(
    api_client, db_session, registration
) -> None:
    """F6-B: the user row stays (pseudonymised), so a team organization keeps the account's proposals; the pending ones
    become ``cancelled`` and say why in the team's audit, the others are history and stay as they were."""
    from _environment_rows import World, _version
    from _proposal_rows import proposal
    from test_account_pseudonymisation import delete as delete_account
    from test_account_pseudonymisation import signed_in

    from openbinding_gateway.db.models import Proposal

    owner, owner_headers, _ = await signed_in(api_client, registration)
    profile, headers, _ = await signed_in(api_client, registration)
    team = await api_client.post("/v1/organizations", headers=owner_headers,
                                 json={"slug": f"t-{uuid.uuid4().hex[:8]}", "name": "Team"})
    assert team.status_code == 201, team.text
    team_id = uuid.UUID(team.json()["id"])
    joined = await api_client.put(f"/v1/organizations/{team.json()['slug']}/members/{profile['id']}",
                                  headers=owner_headers, json={"user_id": profile["id"], "role": "MEMBER"})
    assert joined.status_code == 200, joined.text
    user_id, owner_id = uuid.UUID(profile["id"]), uuid.UUID(owner["id"])
    composition = Composition(organization_id=team_id, slug="shop", name="Shop", created_by_id=owner_id)
    db_session.add(composition)
    await db_session.flush()
    version_id, evaluation_id = await _version(db_session, composition.id, owner_id, 1, "1.0.0")
    w = World(user_id, team_id, composition.id, (version_id,), (evaluation_id,), composition.id, version_id,
              evaluation_id)
    pending = await proposal(db_session, w)
    finished = await proposal(db_session, w, status="failed")
    others = await proposal(db_session, w, user_id=owner_id)
    await db_session.commit()

    deleted = await delete_account(api_client, profile, headers)

    assert deleted.status_code == 204, deleted.text
    db_session.expire_all()
    statuses = {row.id: row.status for row in (await db_session.scalars(
        select(Proposal).where(Proposal.organization_id == team_id))).all()}
    assert statuses == {pending: "cancelled", finished: "failed", others: "pending"}
    audit = await db_session.scalar(select(AuditEvent).where(AuditEvent.action == "composition.proposal_cancelled",
                                                             AuditEvent.target_id == pending))
    assert audit is not None and audit.organization_id == team_id and audit.detail == {"reason": "account_deleted"}
