"""B3 #2: billing sponsorship needs the proposed person's explicit acceptance."""

from __future__ import annotations

import uuid
from datetime import timedelta
from types import SimpleNamespace

import pytest
from sqlalchemy import select, update

from _b1_helpers import gate, make_account, make_key, make_org, put_member  # noqa: F401
from openbinding_gateway.collaboration import sponsor_usage
from openbinding_gateway.core.settings import get_settings
from openbinding_gateway.db.models import (
    AuditEvent,
    Notification,
    Organization,
    SponsorProposal,
    SponsorProposalStatus,
    utcnow,
)
from openbinding_gateway import sponsor_proposals


@pytest.fixture
async def world(api_client, registration, db_session, gate):  # noqa: F811
    """Alice owns and sponsors an organization with a child; Bob, Carol, Dave, Erin and an admin around it."""
    people = {}
    for name in ("alice", "bob", "carol", "dave", "erin"):
        people[name] = await make_account(api_client, registration, db_session, gate)
    admin = await make_account(api_client, registration, db_session, gate, admin=True)
    alice, alice_h = people["alice"]
    organization = await make_org(api_client, alice_h)
    child = await api_client.post(
        "/v1/organizations", headers=alice_h,
        json={"slug": f"{organization['slug']}-sub", "name": "Sub", "parent_id": organization["id"]},
    )
    assert child.status_code == 201, child.text
    # Dave is an ADMIN member and Erin a second OWNER; Carol is outside the organization.
    assert (await put_member(api_client, alice_h, organization["slug"], people["dave"][0]["id"], "ADMIN")).status_code == 200
    assert (await put_member(api_client, alice_h, organization["slug"], people["erin"][0]["id"], "OWNER")).status_code == 200
    return SimpleNamespace(
        db=db_session, client=api_client, gate=gate, org=organization, child=child.json(),
        registration=registration,
        alice=alice, alice_h=alice_h,
        bob=people["bob"][0], bob_h=people["bob"][1],
        carol=people["carol"][0], carol_h=people["carol"][1],
        dave=people["dave"][0], dave_h=people["dave"][1],
        erin=people["erin"][0], erin_h=people["erin"][1],
        admin=admin[0], admin_h=admin[1],
    )


async def propose(w, headers, user, **extra):
    return await w.client.patch(
        f"/v1/organizations/{w.org['slug']}", headers=headers,
        json={"billing_sponsor_user_id": user["id"], **extra},
    )


async def sponsor_of(w, slug: str) -> str:
    w.db.expire_all()
    row = (await w.db.execute(select(Organization).where(Organization.slug == slug))).scalars().one()
    return str(row.billing_sponsor_user_id)


async def events(w, action: str) -> list[SimpleNamespace]:
    """Plain copies: a later ``expire_all`` must not invalidate what the test already read."""
    w.db.expire_all()
    rows = (await w.db.scalars(select(AuditEvent).where(AuditEvent.action == action))).all()
    return [
        SimpleNamespace(
            organization_id=row.organization_id, actor_id=row.actor_id, detail=dict(row.detail),
            target_id=row.target_id,
        )
        for row in rows
    ]


async def notifications(w, headers, kind: str) -> list[dict]:
    response = await w.client.get("/v1/notifications", headers=headers)
    return [item for item in response.json() if item["kind"] == kind]


async def pending_proposal(w, proposer_h=None, target=None) -> dict:
    response = await propose(w, proposer_h or w.alice_h, target or w.bob)
    assert response.status_code == 202, response.text
    return response.json()


# --- proposing ------------------------------------------------------------------


async def test_proposing_somebody_else_creates_a_pending_proposal_and_changes_nothing(world):
    w = world
    response = await propose(w, w.alice_h, w.bob, name="Renamed by the same request")

    assert response.status_code == 202, response.text
    body = response.json()
    assert body["status"] == "pending"
    assert body["organization_id"] == w.org["id"]
    assert body["organization_slug"] == w.org["slug"]
    assert body["proposed_user_id"] == w.bob["id"]
    assert body["proposed_by_user_id"] == w.alice["id"]
    assert body["decided_at"] is None and body["decided_by_user_id"] is None
    # Not a bare integer id: proposals are not enumerable.
    assert uuid.UUID(body["id"])
    # Sponsor of the organization and of its child are untouched; other fields applied.
    assert await sponsor_of(w, w.org["slug"]) == w.alice["id"]
    assert await sponsor_of(w, w.child["slug"]) == w.alice["id"]
    renamed = await w.client.get(f"/v1/organizations/{w.org['slug']}", headers=w.alice_h)
    assert renamed.json()["name"] == "Renamed by the same request"
    assert renamed.json()["billing_sponsor_user_id"] == w.alice["id"]


async def test_the_expiry_is_fourteen_days_by_default_and_configurable(world, monkeypatch):
    w = world
    default = await pending_proposal(w)
    await w.client.post(f"/v1/sponsor-proposals/{default['id']}/cancel", headers=w.alice_h)
    monkeypatch.setattr(get_settings(), "sponsor_proposal_ttl_days", 3)
    short = await pending_proposal(w)

    from datetime import datetime

    def span(value):
        created = datetime.fromisoformat(value["created_at"].replace("Z", "+00:00"))
        expires = datetime.fromisoformat(value["expires_at"].replace("Z", "+00:00"))
        return (expires - created).total_seconds() / 86400

    assert 13.99 < span(default) < 14.01
    assert 2.99 < span(short) < 3.01


async def test_a_member_below_owner_and_an_outsider_cannot_propose(world):
    w = world
    for headers in (w.dave_h, w.carol_h):
        response = await propose(w, headers, w.bob)
        assert response.status_code == 403
        assert response.json()["detail"]["code"] == "organization_forbidden"
    assert (await w.db.scalars(select(SponsorProposal))).all() == []


async def test_proposing_an_inactive_or_unknown_user_is_refused(world):
    w = world
    assert (await w.client.patch(
        f"/v1/admin/users/{w.bob['id']}", headers=w.admin_h, json={"is_active": False}
    )).status_code == 200
    inactive = await propose(w, w.alice_h, w.bob)
    unknown = await w.client.patch(
        f"/v1/organizations/{w.org['slug']}", headers=w.alice_h,
        json={"billing_sponsor_user_id": str(uuid.uuid4())},
    )

    for response in (inactive, unknown):
        assert response.status_code == 422
        assert response.json()["detail"]["code"] == "invalid_sponsor"
    assert (await w.db.scalars(select(SponsorProposal))).all() == []


async def test_naming_oneself_changes_the_sponsor_at_once_within_the_limits(world):
    w = world
    stale = await pending_proposal(w, target=w.carol)

    # Erin (a second OWNER, on a large plan) takes the sponsorship herself: immediate.
    taken = await propose(w, w.erin_h, w.erin)
    assert taken.status_code == 200, taken.text
    assert taken.json()["billing_sponsor_user_id"] == w.erin["id"]
    assert await sponsor_of(w, w.org["slug"]) == w.erin["id"]
    assert await sponsor_of(w, w.child["slug"]) == w.erin["id"]
    # The pending proposal for somebody else is moot and closed.
    closed = await w.client.get(f"/v1/sponsor-proposals/{stale['id']}", headers=w.alice_h)
    assert closed.json()["status"] == "cancelled"
    assert closed.json()["decision_reason"] == "sponsor_changed"

    # Naming oneself still respects one's own plan.
    w.gate.plans.pop(uuid.UUID(w.alice["id"]))
    refused = await propose(w, w.alice_h, w.alice)
    assert refused.status_code == 402
    assert refused.json()["detail"]["code"] == "sponsor_quota_exceeded"


async def test_one_pending_proposal_per_organization_and_explicit_replacement(world):
    w = world
    first = await pending_proposal(w)

    again = await propose(w, w.alice_h, w.carol)
    assert again.status_code == 409
    assert again.json()["detail"]["code"] == "sponsor_proposal_pending"
    assert again.json()["detail"]["proposal_id"] == first["id"]
    # Another OWNER cannot replace somebody else's proposal, even asking to.
    other = await propose(w, w.erin_h, w.carol, replace_pending_proposal=True)
    assert other.status_code == 409
    assert other.json()["detail"]["code"] == "sponsor_proposal_pending"
    # The administrator endpoint answers the same way.
    admin = await w.client.post(
        f"/v1/admin/organizations/{w.org['id']}/sponsor", headers=w.admin_h,
        json={"billing_sponsor_user_id": w.carol["id"]},
    )
    assert admin.status_code == 409 and admin.json()["detail"]["code"] == "sponsor_proposal_pending"

    replaced = await propose(w, w.alice_h, w.carol, replace_pending_proposal=True)
    assert replaced.status_code == 202, replaced.text
    assert replaced.json()["proposed_user_id"] == w.carol["id"]
    old = await w.client.get(f"/v1/sponsor-proposals/{first['id']}", headers=w.alice_h)
    assert old.json()["status"] == "cancelled" and old.json()["decision_reason"] == "replaced"
    pending = await w.db.scalars(
        select(SponsorProposal).where(SponsorProposal.status == SponsorProposalStatus.PENDING)
    )
    assert len(pending.all()) == 1


async def test_the_database_allows_a_single_pending_proposal_per_organization(world):
    w = world
    await pending_proposal(w)
    from sqlalchemy.exc import IntegrityError

    duplicate = SponsorProposal(
        organization_id=uuid.UUID(w.org["id"]), proposed_user_id=uuid.UUID(w.carol["id"]),
        proposed_by_user_id=uuid.UUID(w.alice["id"]), expires_at=utcnow() + timedelta(days=1),
    )
    with pytest.raises(IntegrityError):
        async with w.db.begin_nested():
            w.db.add(duplicate)
            await w.db.flush()


async def test_the_administrator_endpoint_proposes_too(world):
    w = world
    proposed = await w.client.post(
        f"/v1/admin/organizations/{w.org['id']}/sponsor", headers=w.admin_h,
        json={"billing_sponsor_user_id": w.bob["id"]},
    )
    assert proposed.status_code == 202, proposed.text
    assert proposed.json()["proposed_by_user_id"] == w.admin["id"]
    assert await sponsor_of(w, w.org["slug"]) == w.alice["id"]
    same = await w.client.post(
        f"/v1/admin/organizations/{w.org['id']}/sponsor", headers=w.admin_h,
        json={"billing_sponsor_user_id": w.alice["id"]},
    )
    assert same.status_code == 409 and same.json()["detail"]["code"] == "already_sponsor"


# --- answering ------------------------------------------------------------------


async def test_accepting_moves_the_whole_subtree_audits_and_notifies(world):
    w = world
    proposal = await pending_proposal(w)
    before = await sponsor_usage(w.db, uuid.UUID(w.bob["id"]))

    accepted = await w.client.post(f"/v1/sponsor-proposals/{proposal['id']}/accept", headers=w.bob_h)

    assert accepted.status_code == 200, accepted.text
    assert accepted.json()["status"] == "accepted"
    assert accepted.json()["decided_by_user_id"] == w.bob["id"]
    assert accepted.json()["decided_at"] is not None
    assert await sponsor_of(w, w.org["slug"]) == w.bob["id"]
    assert await sponsor_of(w, w.child["slug"]) == w.bob["id"]
    after = await sponsor_usage(w.db, uuid.UUID(w.bob["id"]))
    assert after["organizations"] == before["organizations"] + 2
    assert (await sponsor_usage(w.db, uuid.UUID(w.alice["id"])))["organizations"] == 0

    [proposed] = await events(w, "organization.sponsor.proposed")
    [done] = await events(w, "organization.sponsor.accepted")
    assert str(proposed.organization_id) == w.org["id"] and str(proposed.actor_id) == w.alice["id"]
    assert str(done.organization_id) == w.org["id"] and str(done.actor_id) == w.bob["id"]
    assert done.detail["previous_sponsor_user_id"] == w.alice["id"]
    assert done.detail["new_sponsor_user_id"] == w.bob["id"]
    assert done.detail["proposal_id"] == proposal["id"]
    # The platform audit shows them (B2).
    listing = await w.client.get(
        "/v1/admin/audit?action=organization.sponsor.accepted", headers=w.admin_h
    )
    assert listing.json()["total"] == 1
    assert listing.json()["events"][0]["organizationSlug"] == w.org["slug"]
    # Notifications: Bob when asked; the proposer and the other OWNER when it resolves.
    assert len(await notifications(w, w.bob_h, "organization.sponsor.proposed")) == 1
    assert len(await notifications(w, w.alice_h, "organization.sponsor.accepted")) == 1  # the proposer
    assert len(await notifications(w, w.erin_h, "organization.sponsor.accepted")) == 1  # another OWNER
    assert len(await notifications(w, w.bob_h, "organization.sponsor.accepted")) == 0  # whoever decided
    assert len(await notifications(w, w.carol_h, "organization.sponsor.accepted")) == 0


async def test_only_the_proposed_person_can_accept_or_decline(world):
    w = world
    proposal = await pending_proposal(w)
    url = f"/v1/sponsor-proposals/{proposal['id']}"

    for action in ("accept", "decline"):
        # People who may see it but are not the proposed person: 403, not even the admin.
        for headers in (w.alice_h, w.erin_h, w.dave_h, w.admin_h):
            refused = await w.client.post(f"{url}/{action}", headers=headers)
            assert refused.status_code == 403, (action, refused.text)
            assert refused.json()["detail"]["code"] == "sponsor_proposal_forbidden"
        # Everybody else cannot even tell it exists.
        hidden = await w.client.post(f"{url}/{action}", headers=w.carol_h)
        missing = await w.client.post(f"/v1/sponsor-proposals/{uuid.uuid4()}/{action}", headers=w.carol_h)
        assert hidden.status_code == missing.status_code == 404
        assert hidden.json() == missing.json()
        assert (await w.client.post(f"{url}/{action}")).status_code == 401
    assert await sponsor_of(w, w.org["slug"]) == w.alice["id"]
    assert (await w.client.get(url, headers=w.bob_h)).json()["status"] == "pending"


async def test_declining_is_terminal(world):
    w = world
    proposal = await pending_proposal(w)
    declined = await w.client.post(f"/v1/sponsor-proposals/{proposal['id']}/decline", headers=w.bob_h)

    assert declined.status_code == 200 and declined.json()["status"] == "declined"
    assert await sponsor_of(w, w.org["slug"]) == w.alice["id"]
    for action, headers in (("accept", w.bob_h), ("decline", w.bob_h), ("cancel", w.alice_h)):
        again = await w.client.post(f"/v1/sponsor-proposals/{proposal['id']}/{action}", headers=headers)
        assert again.status_code == 409, (action, again.text)
        assert again.json()["detail"]["code"] == "sponsor_proposal_not_pending"
        assert again.json()["detail"]["status"] == "declined"
    assert len(await events(w, "organization.sponsor.declined")) == 1
    assert len(await notifications(w, w.erin_h, "organization.sponsor.declined")) == 1
    # A fresh proposal is possible again.
    assert (await propose(w, w.alice_h, w.bob)).status_code == 202


async def test_who_can_cancel(world):
    w = world
    for canceller in ("alice_h", "erin_h", "admin_h"):  # proposer, another OWNER, platform admin
        proposal = await pending_proposal(w)
        for denied in ("bob_h", "dave_h"):  # the proposed person must decline; an ADMIN member cannot cancel
            refused = await w.client.post(
                f"/v1/sponsor-proposals/{proposal['id']}/cancel", headers=getattr(w, denied)
            )
            assert refused.status_code == 403
            assert refused.json()["detail"]["code"] == "sponsor_proposal_forbidden"
        assert (await w.client.post(
            f"/v1/sponsor-proposals/{proposal['id']}/cancel", headers=w.carol_h
        )).status_code == 404
        cancelled = await w.client.post(
            f"/v1/sponsor-proposals/{proposal['id']}/cancel", headers=getattr(w, canceller)
        )
        assert cancelled.status_code == 200, (canceller, cancelled.text)
        assert cancelled.json()["status"] == "cancelled"
        late = await w.client.post(f"/v1/sponsor-proposals/{proposal['id']}/accept", headers=w.bob_h)
        assert late.status_code == 409
        assert late.json()["detail"]["code"] == "sponsor_proposal_not_pending"
        assert late.json()["detail"]["status"] == "cancelled"
    assert len(await events(w, "organization.sponsor.cancelled")) == 3


async def test_a_refused_acceptance_leaves_the_proposal_pending_until_the_plan_fits(world):
    w = world
    proposal = await pending_proposal(w)
    w.gate.plans.pop(uuid.UUID(w.bob["id"]))  # Bob's plan cannot take a two-organization subtree

    refused = await w.client.post(f"/v1/sponsor-proposals/{proposal['id']}/accept", headers=w.bob_h)

    assert refused.status_code == 402
    assert refused.json()["detail"]["code"] == "sponsor_quota_exceeded"
    assert await sponsor_of(w, w.org["slug"]) == w.alice["id"]
    assert (await w.client.get(f"/v1/sponsor-proposals/{proposal['id']}", headers=w.bob_h)).json()["status"] == "pending"
    assert await events(w, "organization.sponsor.accepted") == []

    from _pricing import largest_plan
    w.gate.plans[uuid.UUID(w.bob["id"])] = largest_plan()
    accepted = await w.client.post(f"/v1/sponsor-proposals/{proposal['id']}/accept", headers=w.bob_h)
    assert accepted.status_code == 200
    assert await sponsor_of(w, w.child["slug"]) == w.bob["id"]


async def test_acceptance_is_refused_when_pricing_is_unavailable(world):
    w = world
    proposal = await pending_proposal(w)
    w.gate.unavailable = True
    refused = await w.client.post(f"/v1/sponsor-proposals/{proposal['id']}/accept", headers=w.bob_h)
    w.gate.unavailable = False

    assert refused.status_code == 503
    assert await sponsor_of(w, w.org["slug"]) == w.alice["id"]
    assert (await w.client.get(f"/v1/sponsor-proposals/{proposal['id']}", headers=w.bob_h)).json()["status"] == "pending"


async def make_due(w, proposal_id: str) -> None:
    await w.db.execute(
        update(SponsorProposal).where(SponsorProposal.id == uuid.UUID(proposal_id))
        .values(expires_at=utcnow() - timedelta(minutes=1))
    )
    await w.db.flush()


async def test_an_expired_proposal_cannot_be_accepted_and_the_expiry_is_recorded(world):
    w = world
    proposal = await pending_proposal(w)
    await make_due(w, proposal["id"])

    late = await w.client.post(f"/v1/sponsor-proposals/{proposal['id']}/accept", headers=w.bob_h)

    assert late.status_code == 409
    assert late.json()["detail"]["code"] == "sponsor_proposal_expired"
    assert await sponsor_of(w, w.org["slug"]) == w.alice["id"]
    # The lazy expiry survived the error response: state, audit and notification.
    seen = await w.client.get(f"/v1/sponsor-proposals/{proposal['id']}", headers=w.alice_h)
    assert seen.json()["status"] == "expired" and seen.json()["decision_reason"] == "expired"
    [event] = await events(w, "organization.sponsor.expired")
    assert event.actor_id is None and str(event.organization_id) == w.org["id"]
    assert len(await notifications(w, w.alice_h, "organization.sponsor.expired")) == 1
    for action, headers in (("accept", w.bob_h), ("decline", w.bob_h), ("cancel", w.alice_h)):
        again = await w.client.post(f"/v1/sponsor-proposals/{proposal['id']}/{action}", headers=headers)
        assert again.status_code == 409
        assert again.json()["detail"]["code"] == "sponsor_proposal_expired"


async def test_reading_expires_lazily_and_a_new_proposal_replaces_an_expired_one(world):
    w = world
    stale = await pending_proposal(w)
    await make_due(w, stale["id"])

    listed = await w.client.get("/v1/users/me/sponsor-proposals?status=pending", headers=w.bob_h)
    assert listed.json() == []
    expired = await w.client.get("/v1/users/me/sponsor-proposals?status=expired", headers=w.bob_h)
    assert [item["id"] for item in expired.json()] == [stale["id"]]

    fresh = await pending_proposal(w, target=w.carol)  # not blocked by the expired one
    assert fresh["status"] == "pending"

    # Expiry also happens when somebody proposes and nobody has looked.
    await make_due(w, fresh["id"])
    again = await propose(w, w.alice_h, w.bob)
    assert again.status_code == 202, again.text
    assert len(await events(w, "organization.sponsor.expired")) == 2


async def test_the_periodic_sweep_expires_what_nobody_touched(world):
    w = world
    proposal = await pending_proposal(w)
    await make_due(w, proposal["id"])

    assert await sponsor_proposals.sweep_expired(w.db) == 1
    assert await sponsor_proposals.sweep_expired(w.db) == 0
    w.db.expire_all()
    row = await w.db.get(SponsorProposal, uuid.UUID(proposal["id"]))
    assert row.status is SponsorProposalStatus.EXPIRED
    assert len(await events(w, "organization.sponsor.expired")) == 1


async def test_deactivating_or_deleting_a_user_invalidates_their_pending_proposals(world):
    w = world
    first = await pending_proposal(w)
    deactivated = await w.client.patch(
        f"/v1/admin/users/{w.bob['id']}", headers=w.admin_h, json={"is_active": False}
    )
    assert deactivated.status_code == 200
    closed = await w.client.get(f"/v1/sponsor-proposals/{first['id']}", headers=w.alice_h)
    assert closed.json()["status"] == "cancelled"
    assert closed.json()["decision_reason"] == "user_deactivated"
    assert (await w.client.post(f"/v1/sponsor-proposals/{first['id']}/accept", headers=w.bob_h)).status_code == 401

    # A proposal the deleted person *made* is closed as well.
    second = await propose(w, w.erin_h, w.carol)
    assert second.status_code == 202
    username = (await w.client.get("/v1/users/me", headers=w.erin_h)).json()["username"]
    deleted = await w.client.request(
        "DELETE", "/v1/users/me", headers=w.erin_h,
        json={"confirmation": username, "current_password": "correct-horse-battery"},
    )
    assert deleted.status_code == 204, deleted.text
    after = await w.client.get(f"/v1/sponsor-proposals/{second.json()['id']}", headers=w.alice_h)
    assert after.json()["status"] == "cancelled" and after.json()["decision_reason"] == "user_deleted"
    assert (await w.client.post(f"/v1/sponsor-proposals/{second.json()['id']}/accept", headers=w.carol_h)).status_code == 409


# --- seeing proposals ----------------------------------------------------------


async def test_listings_show_only_what_the_caller_may_see(world):
    w = world
    proposal = await pending_proposal(w)

    mine = await w.client.get("/v1/users/me/sponsor-proposals", headers=w.bob_h)
    assert [item["id"] for item in mine.json()] == [proposal["id"]]
    for headers in (w.alice_h, w.carol_h, w.erin_h):  # even the proposer: these are *addressed to me*
        assert (await w.client.get("/v1/users/me/sponsor-proposals", headers=headers)).json() == []
    assert (await w.client.get("/v1/users/me/sponsor-proposals")).status_code == 401

    url = f"/v1/organizations/{w.org['slug']}/sponsor-proposals"
    for headers in (w.alice_h, w.erin_h, w.dave_h, w.admin_h):  # OWNER, OWNER, ADMIN, platform admin
        listed = await w.client.get(url, headers=headers)
        assert listed.status_code == 200, listed.text
        assert [item["id"] for item in listed.json()] == [proposal["id"]]
    # Bob is asked, but is no member: the organization's list does not acknowledge him.
    assert (await w.client.get(url, headers=w.bob_h)).status_code == 404
    assert (await w.client.get(url, headers=w.carol_h)).status_code == 404
    missing = await w.client.get("/v1/organizations/no-such-org/sponsor-proposals", headers=w.carol_h)
    assert missing.status_code == 404
    assert (await w.client.get(url)).status_code == 401

    # A member below ADMIN is refused, as everywhere else in the organization.
    viewer, viewer_h = await make_account(w.client, w.registration, w.db, w.gate)
    assert (await put_member(w.client, w.alice_h, w.org["slug"], viewer["id"], "MEMBER")).status_code == 200
    refused = await w.client.get(url, headers=viewer_h)
    assert refused.status_code == 403 and refused.json()["detail"]["code"] == "organization_forbidden"


async def test_single_proposals_are_visible_only_to_the_involved_and_staff(world):
    w = world
    proposal = await pending_proposal(w)
    url = f"/v1/sponsor-proposals/{proposal['id']}"

    for headers in (w.alice_h, w.bob_h, w.erin_h, w.dave_h, w.admin_h):
        assert (await w.client.get(url, headers=headers)).status_code == 200
    unknown = await w.client.get(f"/v1/sponsor-proposals/{uuid.uuid4()}", headers=w.carol_h)
    foreign = await w.client.get(url, headers=w.carol_h)
    assert foreign.status_code == unknown.status_code == 404 and foreign.json() == unknown.json()
    assert (await w.client.get(url)).status_code == 401
    # Identifiers are UUIDs: a sequential guess is not even a valid id.
    assert (await w.client.get("/v1/sponsor-proposals/1", headers=w.alice_h)).status_code == 422


async def test_the_status_filter_and_its_validation(world):
    w = world
    first = await pending_proposal(w)
    await w.client.post(f"/v1/sponsor-proposals/{first['id']}/decline", headers=w.bob_h)
    second = await pending_proposal(w)

    base = "/v1/users/me/sponsor-proposals"
    everything = await w.client.get(base, headers=w.bob_h)
    declined = await w.client.get(f"{base}?status=declined", headers=w.bob_h)
    pending = await w.client.get(f"{base}?status=pending", headers=w.bob_h)
    accepted = await w.client.get(f"{base}?status=accepted", headers=w.bob_h)

    assert {item["id"] for item in everything.json()} == {first["id"], second["id"]}
    assert [item["id"] for item in declined.json()] == [first["id"]]
    assert [item["id"] for item in pending.json()] == [second["id"]]
    assert accepted.json() == []
    assert (await w.client.get(f"{base}?status=bogus", headers=w.bob_h)).status_code == 422


async def test_an_api_key_needs_organization_permissions_to_answer(world):
    w = world
    proposal = await pending_proposal(w)
    read_only = await make_key(w.client, w.bob_h, ["organizations:read"])
    writer = await make_key(w.client, w.bob_h, ["organizations:read", "organizations:write"])

    listed = await w.client.get("/v1/users/me/sponsor-proposals", headers=read_only)
    refused = await w.client.post(f"/v1/sponsor-proposals/{proposal['id']}/accept", headers=read_only)
    allowed = await w.client.post(f"/v1/sponsor-proposals/{proposal['id']}/decline", headers=writer)

    assert listed.status_code == 403  # account:read is also required to list "my" proposals
    assert refused.status_code == 403
    assert refused.json()["detail"]["code"] == "insufficient_api_key_permission"
    assert allowed.status_code == 200 and allowed.json()["status"] == "declined"
