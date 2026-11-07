"""What an administrator can and cannot do to somebody else's account.

Half of these are about the guard rather than the feature. An administration
endpoint that an ordinary account can reach is worse than no endpoint, and the
one that changes plans is the only reason the paid plan works at all - there is
no payment gateway, so an upgrade *is* an administrator performing a novation.
"""

from __future__ import annotations

import re
import uuid
from datetime import datetime, timedelta, timezone

import pytest
import pytest_asyncio

from openbinding_gateway import space_client
from openbinding_gateway.db.models import (
    AuthIdentity,
    Notification,
    User,
    UserRole,
)
from _pricing import caps_for, fake_pricing_gate, largest_plan, pricing_catalog

CATALOG = pricing_catalog()
DEFAULT_PLAN = CATALOG.default_plan
LARGER_PLAN = largest_plan()
INSTITUTIONAL_PLAN = "RESEARCH"


@pytest_asyncio.fixture
async def gate():
    installed = fake_pricing_gate()
    space_client.set_gate(installed)
    yield installed
    space_client.set_gate(None)


async def account(client, registration, db_session=None, *, admin=False) -> tuple[dict, dict]:
    details = registration()
    created = await client.post("/v1/auth/register", json=details)
    assert created.status_code == 201, created.text

    if admin:
        from sqlalchemy import select

        user = (
            await db_session.execute(select(User).where(User.username == details["username"]))
        ).scalars().one()
        user.role = UserRole.ADMIN
        await db_session.flush()

    tokens = await client.post(
        "/v1/auth/login",
        json={"username_or_email": details["username"], "password": details["password"]},
    )
    return created.json(), {"Authorization": f"Bearer {tokens.json()['access_token']}"}


# -- The guard --------------------------------------------------------------


@pytest.mark.parametrize(
    "method,path",
    [
        ("get", "/v1/admin/users"),
        ("patch", "/v1/admin/users/{id}"),
        ("post", "/v1/admin/users/{id}/plan"),
        ("get", "/v1/admin/users/{id}/usage"),
        ("get", "/v1/admin/overview"),
        ("get", "/v1/admin/audit"),
        ("get", "/v1/admin/queues"),
        ("get", "/v1/admin/maintenance/preview"),
    ],
)
async def test_an_ordinary_account_is_refused(api_client, registration, gate, method, path):
    profile, headers = await account(api_client, registration)

    url = path.format(id=profile["id"])
    response = await (
        api_client.get(url, headers=headers)
        if method == "get"
        else getattr(api_client, method)(url, headers=headers, json={})
    )

    assert response.status_code == 403
    assert response.json()["detail"]["code"] == "forbidden"


async def test_a_visitor_is_refused(api_client, gate):
    response = await api_client.get("/v1/admin/users")

    assert response.status_code == 401


# -- Seeing accounts --------------------------------------------------------


async def test_an_administrator_sees_the_accounts(api_client, registration, gate, db_session):
    await account(api_client, registration)
    _, admin = await account(api_client, registration, db_session, admin=True)

    response = await api_client.get("/v1/admin/users", headers=admin)

    assert response.status_code == 200
    assert response.json()["total"] >= 2


async def test_the_listing_never_carries_a_password_hash(
    api_client, registration, gate, db_session
):
    await account(api_client, registration)
    _, admin = await account(api_client, registration, db_session, admin=True)

    response = await api_client.get("/v1/admin/users", headers=admin)

    assert "password" not in response.text.lower()


async def test_accounts_can_be_searched(api_client, registration, gate, db_session):
    wanted, _ = await account(api_client, registration)
    _, admin = await account(api_client, registration, db_session, admin=True)

    response = await api_client.get(
        f"/v1/admin/users?search={wanted['username']}", headers=admin
    )

    assert response.json()["total"] == 1
    assert response.json()["users"][0]["id"] == wanted["id"]


async def test_the_listing_is_paged(api_client, registration, gate, db_session):
    # A screen that fetches every account works until it does not.
    for _ in range(3):
        await account(api_client, registration)
    _, admin = await account(api_client, registration, db_session, admin=True)

    response = await api_client.get("/v1/admin/users?limit=2", headers=admin)

    assert len(response.json()["users"]) == 2
    assert response.json()["total"] >= 4


async def test_the_listing_reports_how_many_keys_are_in_use(
    api_client, registration, gate, db_session
):
    profile, headers = await account(api_client, registration)
    await api_client.post(
        "/v1/users/me/api-keys",
        headers=headers,
        json={
            "name": "k",
            "permissions": ["account:read"],
            "engine_access": {"all": False, "engines": []},
        },
    )
    _, admin = await account(api_client, registration, db_session, admin=True)

    listing = await api_client.get(f"/v1/admin/users?search={profile['username']}", headers=admin)

    assert listing.json()["users"][0]["api_key_count"] == 1


# -- Changing accounts ------------------------------------------------------


async def test_an_account_can_be_deactivated(api_client, registration, gate, db_session):
    profile, theirs = await account(api_client, registration)
    _, admin = await account(api_client, registration, db_session, admin=True)

    changed = await api_client.patch(
        f"/v1/admin/users/{profile['id']}", headers=admin, json={"is_active": False}
    )
    after = await api_client.get("/v1/users/me", headers=theirs)

    assert changed.json()["is_active"] is False
    # Their token is still valid and unexpired; the account is not.
    assert after.status_code == 401


async def test_an_account_can_be_promoted(api_client, registration, gate, db_session):
    profile, theirs = await account(api_client, registration)
    _, admin = await account(api_client, registration, db_session, admin=True)

    await api_client.patch(
        f"/v1/admin/users/{profile['id']}", headers=admin, json={"role": "admin"}
    )
    now_allowed = await api_client.get("/v1/admin/users", headers=theirs)

    assert now_allowed.status_code == 200


async def test_an_administrator_cannot_deactivate_themselves(
    api_client, registration, gate, db_session
):
    # Always a mistake, and a gateway whose last administrator locked
    # themselves out needs database access to recover.
    profile, admin = await account(api_client, registration, db_session, admin=True)

    response = await api_client.patch(
        f"/v1/admin/users/{profile['id']}", headers=admin, json={"is_active": False}
    )

    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "cannot_demote_self"


async def test_an_administrator_cannot_demote_themselves(
    api_client, registration, gate, db_session
):
    profile, admin = await account(api_client, registration, db_session, admin=True)

    response = await api_client.patch(
        f"/v1/admin/users/{profile['id']}", headers=admin, json={"role": "user"}
    )

    assert response.status_code == 409


async def test_an_unknown_account_is_not_found(api_client, registration, gate, db_session):
    _, admin = await account(api_client, registration, db_session, admin=True)

    response = await api_client.patch(
        f"/v1/admin/users/{uuid.uuid4()}", headers=admin, json={"is_active": False}
    )

    assert response.status_code == 404


# -- Plans ------------------------------------------------------------------


async def test_an_account_can_be_moved_to_the_paid_plan(
    api_client, registration, gate, db_session
):
    # The whole reason PRO works: there is no payment gateway, so an upgrade
    # is an administrator performing a novation.
    profile, theirs = await account(api_client, registration)
    _, admin = await account(api_client, registration, db_session, admin=True)

    changed = await api_client.post(
        f"/v1/admin/users/{profile['id']}/plan",
        headers=admin,
        json={"plan": LARGER_PLAN},
    )
    usage = await api_client.get("/v1/users/me/usage", headers=theirs)

    assert changed.json()["plan"] == LARGER_PLAN
    assert usage.json()["plan"] == LARGER_PLAN
    assert usage.json()["capabilities"] == caps_for(LARGER_PLAN).http_view()[
        "capabilities"
    ]


async def test_the_novation_happens_before_the_cache_is_updated(
    api_client, registration, gate, db_session
):
    # If the contract cannot be changed, nothing should claim it was.
    profile, _ = await account(api_client, registration)
    _, admin = await account(api_client, registration, db_session, admin=True)
    gate.unavailable = True

    response = await api_client.post(
        f"/v1/admin/users/{profile['id']}/plan",
        headers=admin,
        json={"plan": LARGER_PLAN},
    )
    gate.unavailable = False
    listing = await api_client.get(f"/v1/admin/users?search={profile['username']}", headers=admin)

    assert response.status_code == 503
    assert listing.json()["users"][0]["plan"] == DEFAULT_PLAN


async def test_an_account_can_be_moved_back(api_client, registration, gate, db_session):
    profile, _ = await account(api_client, registration)
    _, admin = await account(api_client, registration, db_session, admin=True)

    await api_client.post(
        f"/v1/admin/users/{profile['id']}/plan",
        headers=admin,
        json={"plan": LARGER_PLAN},
    )
    back = await api_client.post(
        f"/v1/admin/users/{profile['id']}/plan",
        headers=admin,
        json={"plan": DEFAULT_PLAN},
    )

    assert back.json()["plan"] == DEFAULT_PLAN


async def test_subscription_changes_plan_add_ons_and_notifies_only_on_a_real_change(
    api_client, registration, gate, db_session
):
    from sqlalchemy import func, select

    profile, _ = await account(api_client, registration)
    _, admin = await account(api_client, registration, db_session, admin=True)
    target_plan = next(
        plan
        for plan in CATALOG.plans
        if sum(plan in add_on.available_for for add_on in CATALOG.add_ons.values()) >= 2
    )
    target_add_ons = {
        name: add_on.minimum
        for name, add_on in CATALOG.add_ons.items()
        if target_plan in add_on.available_for
    }
    target_add_ons = dict(list(target_add_ons.items())[:2])
    response = await api_client.post(
        f"/v1/admin/users/{profile['id']}/subscription",
        headers=admin,
        json={
            "plan": target_plan,
            "add_ons": target_add_ons,
            "reason": "institutional_agreement",
            "detail": "Research infrastructure agreement",
        },
    )
    repeated = await api_client.post(
        f"/v1/admin/users/{profile['id']}/subscription",
        headers=admin,
        json={
            "plan": target_plan,
            "add_ons": target_add_ons,
            "reason": "institutional_agreement",
        },
    )
    read_back = await api_client.get(
        f"/v1/admin/users/{profile['id']}/subscription", headers=admin
    )
    notification_count = await db_session.scalar(
        select(func.count(Notification.id)).where(Notification.user_id == uuid.UUID(profile["id"]))
    )

    assert response.status_code == 200, response.text
    assert response.json()["changed"] is True
    assert response.json()["subscription"]["add_ons"] == target_add_ons
    assert repeated.json()["changed"] is False
    assert read_back.json()["subscription"]["plan"] == target_plan
    assert notification_count == 1


async def test_research_requires_verified_us_cas_and_never_accepts_add_ons(
    api_client, registration, gate, db_session
):
    profile, _ = await account(api_client, registration)
    _, admin = await account(api_client, registration, db_session, admin=True)
    endpoint = f"/v1/admin/users/{profile['id']}/subscription"
    missing_identity = await api_client.post(
        endpoint,
        headers=admin,
        json={
            "plan": INSTITUTIONAL_PLAN,
            "add_ons": {},
            "reason": "institutional_agreement",
        },
    )
    db_session.add(AuthIdentity(
        user_id=uuid.UUID(profile["id"]), provider="us-cas", subject="verified-uvus",
        attributes={},
    ))
    await db_session.flush()
    unavailable_add_on = next(
        name
        for name, add_on in CATALOG.add_ons.items()
        if INSTITUTIONAL_PLAN not in add_on.available_for
    )
    invalid_add_on = await api_client.post(
        endpoint,
        headers=admin,
        json={
            "plan": INSTITUTIONAL_PLAN,
            "add_ons": {unavailable_add_on: 1},
            "reason": "institutional_agreement",
        },
    )
    accepted = await api_client.post(
        endpoint,
        headers=admin,
        json={
            "plan": INSTITUTIONAL_PLAN,
            "add_ons": {},
            "reason": "institutional_agreement",
        },
    )

    assert missing_identity.status_code == 409
    assert missing_identity.json()["detail"]["code"] == "research_requires_us_cas"
    assert invalid_add_on.status_code == 422
    assert accepted.status_code == 200
    assert accepted.json()["subscription"]["plan"] == INSTITUTIONAL_PLAN


async def test_an_expired_contract_is_left_to_space_to_renew(
    api_client, registration, gate, db_session
):
    """Renewal and version migration are SPACE's own lifecycle, not a request side effect."""
    profile, headers = await account(api_client, registration)
    user_id = uuid.UUID(profile["id"])
    gate.versions[user_id] = "previous-version"
    expired = datetime.now(timezone.utc) - timedelta(seconds=1)
    gate.renews_at[user_id] = expired

    response = await api_client.get("/v1/users/me", headers=headers)

    assert response.status_code == 200
    assert gate.versions[user_id] == "previous-version"
    assert gate.renews_at[user_id] == expired


async def test_an_administrator_change_pins_the_configured_pricing_version(
    api_client, registration, gate, db_session
):
    profile, _ = await account(api_client, registration)
    _, admin = await account(api_client, registration, db_session, admin=True)
    user_id = uuid.UUID(profile["id"])
    gate.versions[user_id] = CATALOG.version

    response = await api_client.post(
        f"/v1/admin/users/{profile['id']}/subscription",
        headers=admin,
        json={"plan": LARGER_PLAN, "add_ons": {}, "reason": "administrative_decision"},
    )

    assert response.status_code == 200, response.text
    assert response.json()["subscription"]["pricing_version"] == "0.1.0"
    assert gate.versions[user_id] == "0.1.0"


# -- Concurrent changes -----------------------------------------------------
#
# The subscription is a conditional write like the others of docs/ERRORS.md: its
# ETag is the contract's revision, If-Match takes it, and a stale one is 412. The
# fake gate keeps contract versions the way SPACE does: every change moves the
# version, and a change that names another version is refused. ``touch`` is a
# change made by somebody else - a renewal, another administrator.


def subscription_change(plan: str) -> dict:
    return {"plan": plan, "add_ons": {}, "reason": "administrative_decision"}


def conditional(headers: dict, tag: str) -> dict:
    return {**headers, "If-Match": tag}


async def contract_changes_recorded(db_session, user_id: uuid.UUID) -> tuple[int, int]:
    from sqlalchemy import func, select

    from openbinding_gateway.db.models import AuditEvent

    audited = await db_session.scalar(
        select(func.count(AuditEvent.id)).where(
            AuditEvent.action == "contract.subscription.changed", AuditEvent.target_id == user_id
        )
    )
    notified = await db_session.scalar(
        select(func.count(Notification.id)).where(Notification.user_id == user_id)
    )
    return audited, notified


async def test_the_subscription_carries_its_revision_as_an_etag_and_each_change_moves_it(
    api_client, registration, gate, db_session
):
    profile, _ = await account(api_client, registration)
    _, admin = await account(api_client, registration, db_session, admin=True)
    endpoint = f"/v1/admin/users/{profile['id']}/subscription"

    seen = await api_client.get(endpoint, headers=admin)
    changed = await api_client.post(
        endpoint, headers=conditional(admin, seen.headers["ETag"]), json=subscription_change(LARGER_PLAN)
    )
    read_again = await api_client.get(endpoint, headers=admin)
    moved_back = await api_client.post(
        f"/v1/admin/users/{profile['id']}/plan",
        headers=conditional(admin, changed.headers["ETag"]),
        json={"plan": DEFAULT_PLAN},
    )

    assert re.fullmatch(r'"[0-9a-f]{32}"', seen.headers["ETag"])
    assert changed.status_code == 200, changed.text
    assert moved_back.status_code == 200, moved_back.text
    assert seen.headers["ETag"] != changed.headers["ETag"] != moved_back.headers["ETag"]
    assert read_again.headers["ETag"] == changed.headers["ETag"]
    # The revision travels in the header only.
    assert set(changed.json()["subscription"]) == {"plan", "add_ons", "pricing_version", "renews_at"}
    assert seen.headers["ETag"].strip('"') not in seen.text


async def test_a_change_decided_on_a_view_another_administrator_outdated_is_412(
    api_client, registration, gate, db_session
):
    profile, _ = await account(api_client, registration)
    _, first = await account(api_client, registration, db_session, admin=True)
    _, second = await account(api_client, registration, db_session, admin=True)
    user_id = uuid.UUID(profile["id"])
    endpoint = f"/v1/admin/users/{profile['id']}/subscription"
    stale = (await api_client.get(endpoint, headers=first)).headers["ETag"]

    moved = await api_client.post(endpoint, headers=second, json=subscription_change(LARGER_PLAN))
    current = (await api_client.get(endpoint, headers=second)).headers["ETag"]
    by_subscription = await api_client.post(
        endpoint, headers=conditional(first, stale), json=subscription_change(DEFAULT_PLAN)
    )
    by_plan = await api_client.post(
        f"/v1/admin/users/{profile['id']}/plan", headers=conditional(first, stale), json={"plan": DEFAULT_PLAN}
    )

    assert moved.status_code == 200, moved.text
    for response in (by_subscription, by_plan):
        assert response.status_code == 412, response.text
        assert response.json()["code"] == "precondition_failed"
        assert response.headers["ETag"] == current
    # The second administrator's change stands, and only it was recorded.
    assert gate.plan_of(user_id) == LARGER_PLAN
    assert await contract_changes_recorded(db_session, user_id) == (1, 1)


async def test_a_change_landing_while_the_gateway_applies_one_is_not_overwritten(
    api_client, registration, gate, db_session, monkeypatch
):
    """``409 contract_changed`` without a tag; the ``412`` of a stale tag when one named the revision."""
    profile, _ = await account(api_client, registration)
    _, admin = await account(api_client, registration, db_session, admin=True)
    user_id = uuid.UUID(profile["id"])
    endpoint = f"/v1/admin/users/{profile['id']}/subscription"
    applying = gate.change_subscription

    async def renewed_meanwhile(*args, **kwargs):
        gate.touch(user_id)  # between the gateway's read and its write
        return await applying(*args, **kwargs)

    monkeypatch.setattr(gate, "change_subscription", renewed_meanwhile)
    by_plan = await api_client.post(
        f"/v1/admin/users/{profile['id']}/plan", headers=admin, json={"plan": LARGER_PLAN}
    )
    by_subscription = await api_client.post(endpoint, headers=admin, json=subscription_change(LARGER_PLAN))
    wildcard = await api_client.post(
        endpoint, headers=conditional(admin, "*"), json=subscription_change(LARGER_PLAN)
    )
    tag = (await api_client.get(endpoint, headers=admin)).headers["ETag"]
    named = await api_client.post(endpoint, headers=conditional(admin, tag), json=subscription_change(LARGER_PLAN))
    now = (await api_client.get(endpoint, headers=admin)).headers["ETag"]

    for response in (by_plan, by_subscription, wildcard):
        assert response.status_code == 409, response.text
        assert response.json()["detail"]["code"] == "contract_changed"
    assert named.status_code == 412, named.text
    assert named.json()["code"] == "precondition_failed"
    assert named.headers["ETag"] == now != tag
    assert gate.plan_of(user_id) == DEFAULT_PLAN
    assert await contract_changes_recorded(db_session, user_id) == (0, 0)


async def test_a_stale_tag_is_refused_even_when_nothing_would_change(
    api_client, registration, gate, db_session
):
    profile, _ = await account(api_client, registration)
    _, admin = await account(api_client, registration, db_session, admin=True)
    endpoint = f"/v1/admin/users/{profile['id']}/subscription"
    stale = (await api_client.get(endpoint, headers=admin)).headers["ETag"]
    gate.touch(uuid.UUID(profile["id"]))

    refused = await api_client.post(
        endpoint, headers=conditional(admin, stale), json=subscription_change(DEFAULT_PLAN)
    )
    unconditional = await api_client.post(endpoint, headers=admin, json=subscription_change(DEFAULT_PLAN))

    assert refused.status_code == 412, refused.text
    assert unconditional.status_code == 200, unconditional.text
    assert unconditional.json()["changed"] is False


async def test_if_match_on_a_plan_change_follows_the_conditional_write_rules(
    api_client, registration, gate, db_session
):
    profile, _ = await account(api_client, registration)
    _, admin = await account(api_client, registration, db_session, admin=True)
    plan = f"/v1/admin/users/{profile['id']}/plan"
    tag = (await api_client.get(f"/v1/admin/users/{profile['id']}/subscription", headers=admin)).headers["ETag"]

    malformed = await api_client.post(plan, headers=conditional(admin, tag.strip('"')), json={"plan": LARGER_PLAN})
    weak = await api_client.post(plan, headers=conditional(admin, f"W/{tag}"), json={"plan": LARGER_PLAN})
    listed = await api_client.post(plan, headers=conditional(admin, f'"0000", {tag}'), json={"plan": LARGER_PLAN})
    wildcard = await api_client.post(plan, headers=conditional(admin, "*"), json={"plan": DEFAULT_PLAN})

    assert malformed.status_code == 400, malformed.text
    assert malformed.json()["code"] == "invalid_if_match"
    assert weak.status_code == 412, weak.text
    assert listed.status_code == 200, listed.text
    assert wildcard.status_code == 200, wildcard.text
    assert gate.plan_of(uuid.UUID(profile["id"])) == DEFAULT_PLAN


async def test_a_contract_without_revisions_has_no_etag_and_matches_only_the_wildcard(
    api_client, registration, gate, db_session, monkeypatch
):
    """A SPACE that keeps no contract versions: nothing to send back, and no tag can name one."""
    profile, _ = await account(api_client, registration)
    _, admin = await account(api_client, registration, db_session, admin=True)
    monkeypatch.setattr(gate, "contract_version_of", lambda _user_id: None)
    endpoint = f"/v1/admin/users/{profile['id']}/subscription"

    seen = await api_client.get(endpoint, headers=admin)
    named = await api_client.post(endpoint, headers=conditional(admin, '"abc"'), json=subscription_change(LARGER_PLAN))
    wildcard = await api_client.post(endpoint, headers=conditional(admin, "*"), json=subscription_change(LARGER_PLAN))

    assert seen.status_code == 200 and "ETag" not in seen.headers
    assert named.status_code == 412 and "ETag" not in named.headers
    assert wildcard.status_code == 200 and "ETag" not in wildcard.headers


def test_openapi_documents_the_subscription_as_a_conditional_write():
    from openbinding_gateway.main import app

    paths = app.openapi()["paths"]
    for path, operation in (
        ("/v1/admin/users/{user_id}/plan", "adminChangePlan"),
        ("/v1/admin/users/{user_id}/subscription", "adminChangeSubscription"),
    ):
        edit = paths[path]["post"]
        assert edit["operationId"] == operation
        header = [p for p in edit["parameters"] if p["name"] == "If-Match"]
        assert len(header) == 1 and header[0]["in"] == "header" and header[0]["required"] is False
        assert {"400", "404", "409", "412", "503"} <= set(edit["responses"])
        assert "ETag" in edit["responses"]["200"]["headers"]
        assert "ETag" in edit["responses"]["412"]["headers"]
    read = paths["/v1/admin/users/{user_id}/subscription"]["get"]["responses"]["200"]
    assert "ETag" in read["headers"] and "content" in read


# -- Usage ------------------------------------------------------------------


async def test_an_administrator_sees_the_same_plan_view_the_holder_does(
    api_client, registration, gate, db_session
):
    profile, theirs = await account(api_client, registration)
    _, admin = await account(api_client, registration, db_session, admin=True)

    mine = await api_client.get("/v1/users/me/usage", headers=theirs)
    seen = await api_client.get(f"/v1/admin/users/{profile['id']}/usage", headers=admin)

    assert mine.json() == seen.json()
    assert set(mine.json()) == {"plan", "contract_pending", "features", "capabilities"}


async def test_the_usage_view_carries_no_consumption(api_client, registration, gate):
    _, theirs = await account(api_client, registration)

    view = (await api_client.get("/v1/users/me/usage", headers=theirs)).json()

    assert "limits" not in view and "used" not in str(view)


async def test_a_key_can_be_taken_back(api_client, registration, gate, db_session):
    # For when one has leaked and its owner is unreachable.
    profile, theirs = await account(api_client, registration)
    key = await api_client.post(
        "/v1/users/me/api-keys",
        headers=theirs,
        json={
            "name": "k",
            "permissions": ["account:read"],
            "engine_access": {"all": False, "engines": []},
        },
    )
    _, admin = await account(api_client, registration, db_session, admin=True)

    revoked = await api_client.delete(
        f"/v1/admin/users/{profile['id']}/api-keys/{key.json()['id']}", headers=admin
    )
    still_works = await api_client.get(
        "/v1/users/me", headers={"X-API-Key": key.json()["secret"]}
    )

    assert revoked.status_code == 204
    assert still_works.status_code == 401


def test_there_is_no_endpoint_that_corrects_a_usage_count():
    from openbinding_gateway.main import app

    paths = app.openapi()["paths"]

    assert not [path for path in paths if path.endswith("/resync")]


async def test_platform_operations_are_visible_without_direct_database_access(
    api_client, registration, gate, db_session
):
    await account(api_client, registration)
    _, admin = await account(api_client, registration, db_session, admin=True)

    overview = await api_client.get("/v1/admin/overview", headers=admin)
    queues = await api_client.get("/v1/admin/queues", headers=admin)
    audit = await api_client.get("/v1/admin/audit", headers=admin)
    maintenance = await api_client.get("/v1/admin/maintenance/preview", headers=admin)

    assert overview.status_code == 200
    assert overview.json()["counts"]["users"] == 2
    assert set(queues.json()["counts"]) == {
        "queued", "running", "completed", "failed", "cancelled"
    }
    assert audit.json()["total"] >= 0
    assert maintenance.json()["expiredArtifacts"] == 0


async def test_maintenance_purge_requires_the_exact_typed_confirmation(
    api_client, registration, gate, db_session
):
    _, admin = await account(api_client, registration, db_session, admin=True)

    refused = await api_client.post(
        "/v1/admin/maintenance/purge",
        headers=admin,
        json={"confirmation": "yes"},
    )
    accepted = await api_client.post(
        "/v1/admin/maintenance/purge",
        headers=admin,
        json={"confirmation": "PURGE EXPIRED"},
    )

    assert refused.status_code == 422
    assert accepted.status_code == 200
    assert accepted.json() == {"artifacts": 0, "artifactFiles": 0, "apiKeys": 0, "jobs": 0}
