"""Personal organizations (F5-D D1), as SPHERE's: every account owns one, named after its username.

Created with the account (local registration here, a first SCORETech sign-in in
``identity/test_identity_provisioning.py``, the lab seed in ``tools/tests/test_seed_lab.py``) and rolled back with it.
Organizations and usernames share one namespace. A personal organization is not transferred, left by its owner,
moved, given sub-organizations, renamed or deleted on its own (409 ``personal_organization``); members and
invitations work as in any organization.
"""

from __future__ import annotations

import uuid

import pytest_asyncio
from sqlalchemy import select

from _b1_helpers import gate, make_account, make_org, put_member  # noqa: F401
from openbinding_gateway.core.settings import get_settings
from openbinding_gateway.db.models import (
    AuditEvent,
    Organization,
    OrganizationMembership,
    OrganizationRole,
    User,
)
from openbinding_gateway.services import organizations as profiles


def code(response) -> str | None:
    body = response.json()
    detail = body.get("detail")
    return body.get("code") or (detail.get("code") if isinstance(detail, dict) else None)


async def personal_of(api_client, headers) -> dict:
    listed = await api_client.get("/v1/organizations", headers=headers)
    assert listed.status_code == 200, listed.text
    personal = [row for row in listed.json() if row["is_personal"]]
    assert len(personal) == 1, listed.json()
    return personal[0]


async def test_registration_gives_the_account_its_personal_organization(api_client, registration, db_session, gate):  # noqa: F811
    details = registration(username=f"Ana.Lopez_{uuid.uuid4().hex[:6]}")
    created = await api_client.post("/v1/auth/register", json=details)
    assert created.status_code == 201, created.text
    account = created.json()
    login = await api_client.post(
        "/v1/auth/login", json={"username_or_email": details["username"], "password": details["password"]},
    )
    headers = {"Authorization": f"Bearer {login.json()['access_token']}"}

    personal = await personal_of(api_client, headers)
    # SPHERE's name and slug; a slug holds no '.' or '_', so each is a '-'.
    assert personal["name"] == f"{details['username']} PERSONAL"
    assert personal["slug"] == details["username"].lower().replace(".", "-").replace("_", "-")
    assert personal["parent_id"] is None and personal["effective_role"] == "OWNER" and personal["description"] == ""
    row = await db_session.get(Organization, uuid.UUID(personal["id"]))
    assert row.personal_owner_id == uuid.UUID(account["id"]) == row.created_by_id
    members = (await api_client.get(f"/v1/organizations/{personal['slug']}/members", headers=headers)).json()
    assert [(item["user_id"], item["role"]) for item in members] == [(account["id"], "OWNER")]
    audit = (await db_session.scalars(
        select(AuditEvent).where(AuditEvent.organization_id == row.id, AuditEvent.action == "organization.created")
    )).all()
    assert [event.detail for event in audit] == [{"personal": True}]
    # The views say so everywhere a tree or a card is drawn.
    view = (await api_client.get(f"/v1/organizations/{personal['slug']}", headers=headers)).json()
    assert view["is_personal"] is True
    tree = (await api_client.get("/v1/organizations", params={"tree": "true"}, headers=headers)).json()
    assert [node["is_personal"] for node in tree if node["id"] == personal["id"]] == [True]
    hierarchy = (await api_client.get(f"/v1/organizations/{personal['slug']}/hierarchy", headers=headers)).json()
    assert [(node["id"], node["is_personal"]) for node in hierarchy] == [(personal["id"], True)]
    profile = (await api_client.get(f"/v1/organizations/{personal['slug']}/profile", headers=headers)).json()
    assert profile["is_personal"] is True


async def test_an_ordinary_organization_is_not_personal(api_client, registration, db_session, gate):  # noqa: F811
    _, headers = await make_account(api_client, registration, db_session, gate)
    team = await make_org(api_client, headers)
    assert team["is_personal"] is False
    listed = (await api_client.get("/v1/organizations", headers=headers)).json()
    assert sorted(row["is_personal"] for row in listed) == [False, True]


async def test_a_username_that_names_an_organization_is_unavailable(api_client, registration, db_session, gate):  # noqa: F811
    _, headers = await make_account(api_client, registration, db_session, gate)
    team = await make_org(api_client, headers, slug=f"team-{uuid.uuid4().hex[:6]}")
    for username in (team["slug"], team["slug"].upper(), team["slug"].replace("-", "."), "public", "join"):
        refused = await api_client.post("/v1/auth/register", json=registration(username=username))
        assert refused.status_code == 409 and code(refused) == "username_unavailable", (username, refused.text)
        assert await db_session.scalar(select(User.id).where(User.username == username)) is None


async def test_an_organization_cannot_take_a_username(api_client, registration, db_session, gate):  # noqa: F811
    first, _ = await make_account(api_client, registration, db_session, gate)
    _, headers = await make_account(api_client, registration, db_session, gate)
    taken = await api_client.post("/v1/organizations", headers=headers, json={"slug": first["username"], "name": "Squat"})
    assert taken.status_code == 409 and code(taken) == "slug_conflict"
    # A derived slug steps around it as around any taken slug.
    derived = await api_client.post("/v1/organizations", headers=headers, json={"name": first["username"]})
    assert derived.status_code == 201 and derived.json()["slug"] != first["username"]


@pytest_asyncio.fixture
async def per_request(tmp_path):
    """The gateway on a file database whose every request commits or rolls back its own session, as in production
    (``api_client`` shares one session and never rolls back). Yields ``(factory, client)``."""
    from httpx import ASGITransport, AsyncClient
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from openbinding_gateway.access.dependencies import optional_session, session_dependency
    from openbinding_gateway.db.base import Base
    from openbinding_gateway.main import app

    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'personal.db'}", connect_args={"timeout": 30})
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)

    async def session():
        async with factory() as opened:
            try:
                yield opened
                await opened.commit()
            except Exception:
                await opened.rollback()
                raise

    app.dependency_overrides[session_dependency] = session
    app.dependency_overrides[optional_session] = session
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://testserver") as client:
        yield factory, client
    app.dependency_overrides.clear()
    await engine.dispose()


async def test_the_account_is_rolled_back_with_its_personal_organization(per_request, registration, monkeypatch):
    factory, client = per_request
    async with factory() as db:
        founder = User(username=f"f{uuid.uuid4().hex[:8]}", email=f"{uuid.uuid4().hex[:8]}@example.org", password_hash="x", plan_cache="FREE")
        db.add(founder)
        await db.flush()
        slug = f"race-{uuid.uuid4().hex[:6]}"
        db.add(Organization(slug=slug, name="Race", created_by_id=founder.id))
        await db.commit()

    async def free(session, username):
        return True  # as if the organization were created between the check and the insert

    monkeypatch.setattr(profiles, "personal_slug_free", free)
    refused = await client.post("/v1/auth/register", json=registration(username=slug))
    assert refused.status_code == 409 and code(refused) == "username_unavailable"
    async with factory() as db:
        assert await db.scalar(select(User.id).where(User.username == slug)) is None
        assert await db.scalar(select(Organization.id).where(Organization.personal_owner_id.is_not(None))) is None


async def test_a_personal_organization_is_not_transferred_left_moved_renamed_or_deleted(
    api_client, registration, db_session, gate,  # noqa: F811
):
    owner_account, owner = await make_account(api_client, registration, db_session, gate)
    friend_account, friend = await make_account(api_client, registration, db_session, gate)
    _, admin = await make_account(api_client, registration, db_session, gate, admin=True)
    personal = await personal_of(api_client, owner)
    slug = personal["slug"]
    team = await make_org(api_client, owner)
    assert (await put_member(api_client, owner, slug, friend_account["id"], "ADMIN")).status_code == 200

    refusals = {
        "transfer": await api_client.put(f"/v1/organizations/{slug}/owner", headers=owner, json={"user_id": friend_account["id"]}),
        "leave": await api_client.delete(f"/v1/organizations/{slug}/members/{owner_account['id']}", headers=owner),
        "rename": await api_client.patch(f"/v1/organizations/{slug}", headers=owner, json={"name": "Renamed"}),
        "move": await api_client.patch(f"/v1/organizations/{slug}", headers=owner, json={"parent_id": team["id"]}),
        "child": await api_client.post("/v1/organizations", headers=owner, json={"name": "Child", "parent_id": personal["id"]}),
        "adopt": await api_client.patch(f"/v1/organizations/{team['slug']}", headers=owner, json={"parent_id": personal["id"]}),
        "delete": await api_client.delete(f"/v1/organizations/{slug}", headers=owner),
        "delete by an administrator": await api_client.delete(f"/v1/organizations/{slug}", headers=admin),
        "delete by its admin": await api_client.delete(f"/v1/organizations/{slug}", headers=friend),
    }
    assert {name: (response.status_code, code(response)) for name, response in refusals.items()} == {
        name: (409, "personal_organization") for name in refusals
    }
    # Nothing moved: still a root, still owned, still named after the account.
    row = await db_session.get(Organization, uuid.UUID(personal["id"]))
    await db_session.refresh(row)
    assert (row.name, row.parent_id) == (personal["name"], None)
    assert (await db_session.get(Organization, uuid.UUID(team["id"]))).parent_id is None
    owner_row = await db_session.scalar(select(OrganizationMembership).where(
        OrganizationMembership.organization_id == row.id, OrganizationMembership.user_id == uuid.UUID(owner_account["id"]),
    ))
    assert owner_row.role is OrganizationRole.OWNER

    # What stays open: the description, the same name, moving it to the root it already is, its avatar colours.
    edited = await api_client.patch(
        f"/v1/organizations/{slug}", headers=owner, json={"name": personal["name"], "description": "Mine", "move_to_root": True},
    )
    assert edited.status_code == 200 and edited.json()["description"] == "Mine"
    painted = await api_client.put(f"/v1/organizations/{slug}/avatar-colors", headers=owner, json={"bg_color": "#123456"})
    assert painted.status_code == 200


async def test_members_and_invitations_work_as_in_any_organization(api_client, registration, db_session, gate):  # noqa: F811
    owner_account, owner = await make_account(api_client, registration, db_session, gate)
    member_account, member = await make_account(api_client, registration, db_session, gate)
    slug = (await personal_of(api_client, owner))["slug"]

    invitation = await api_client.post(f"/v1/organizations/{slug}/invitations", headers=owner, json={})
    assert invitation.status_code == 201, invitation.text
    joined = await api_client.post(f"/v1/invitations/{invitation.json()['code']}/join", headers=member)
    assert joined.status_code == 200 and joined.json()["is_personal"] is True and joined.json()["effective_role"] == "MEMBER"
    # The member's own list holds the friend's personal organization beside its own; only its own is its personal one.
    mine = (await api_client.get("/v1/organizations", headers=member)).json()
    assert sorted((row["is_personal"], row["effective_role"]) for row in mine) == [(True, "MEMBER"), (True, "OWNER")]
    left = await api_client.delete(f"/v1/organizations/{slug}/members/{member_account['id']}", headers=member)
    assert left.status_code == 204
    assert (await put_member(api_client, owner, slug, member_account["id"], "VIEWER")).status_code == 200
    removed = await api_client.delete(f"/v1/organizations/{slug}/members/{member_account['id']}", headers=owner)
    assert removed.status_code == 204
    # The owner's seat stays the owner's seat.
    seat = await put_member(api_client, owner, slug, owner_account["id"], "ADMIN")
    assert seat.status_code == 409 and code(seat) == "owner_transfer_required"


async def test_ensure_is_idempotent_and_refuses_a_taken_slug(db_session):
    user = User(username=f"seeded{uuid.uuid4().hex[:6]}", email=f"{uuid.uuid4().hex[:8]}@example.org", password_hash="x", plan_cache="FREE")
    db_session.add(user)
    await db_session.flush()
    first = await profiles.ensure_personal_organization(db_session, user)
    assert await profiles.ensure_personal_organization(db_session, user) is first
    squatter = User(username=f"squat{uuid.uuid4().hex[:6]}", email=f"{uuid.uuid4().hex[:8]}@example.org", password_hash="x", plan_cache="FREE")
    db_session.add(squatter)
    db_session.add(Organization(slug=squatter.username, name="Squat", created_by_id=user.id))
    await db_session.flush()
    try:
        await profiles.ensure_personal_organization(db_session, squatter)
    except profiles.PersonalSlugTaken as taken:
        assert str(taken) == squatter.username
    else:
        raise AssertionError("a taken slug must refuse the personal organization")
    assert profiles.personal_slug("Ana.Lopez_") == "ana-lopez"
    assert profiles.personal_slug("Bob-1") == "bob-1"


async def test_the_bootstrap_administrator_gets_its_personal_organization(db_session):
    from openbinding_gateway.main import _give_administrators_personal_organizations

    name = f"boot{uuid.uuid4().hex[:6]}"
    admin = User(username=name, email=f"{name}@example.org", password_hash="x", plan_cache="")
    db_session.add(admin)
    await db_session.flush()
    settings = get_settings().model_copy(update={"bootstrap_admin_username": name})
    await _give_administrators_personal_organizations(db_session, settings)
    await _give_administrators_personal_organizations(db_session, settings)
    owned = (await db_session.scalars(select(Organization).where(Organization.personal_owner_id == admin.id))).all()
    assert [(row.slug, row.name) for row in owned] == [(name, f"{name} PERSONAL")]
