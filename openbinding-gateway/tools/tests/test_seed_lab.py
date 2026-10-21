"""seed_lab: idempotent on SQLite with the real roles; optional SPACE contracts only for the dev service."""

from __future__ import annotations

import asyncio
import importlib
import json
import os
import uuid
from pathlib import Path

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import create_async_engine

import _remote_common as common
import seed_lab
from fakes import ENV, FakeRemotes

from openbinding_gateway.db.models import ApiKey, InstanceSnapshot, User, UserRole
from openbinding_gateway.db.platform_models import (
    BindingCase,
    BindingCaseRevision,
    Organization,
    OrganizationMembership,
    OrganizationRole,
    Project,
)
from openbinding_gateway.security.passwords import verify_password

PASSWORD = "synthetic-lab-password-1"
REPO_ROOT = Path(os.environ.get("OPENBINDING_REPO_ROOT", Path(__file__).resolve().parents[3]))
EXAMPLES = REPO_ROOT / "examples"


async def roles_by_membership(session) -> dict[tuple[str, str], OrganizationRole]:
    rows = (await session.execute(
        select(User.username, Organization.slug, OrganizationMembership.role)
        .join(OrganizationMembership, OrganizationMembership.user_id == User.id)
        .join(Organization, Organization.id == OrganizationMembership.organization_id)
    )).all()
    return {(username, slug): role for username, slug, role in rows}


async def test_first_run_creates_the_lab_with_the_real_roles(db_session):
    result = await seed_lab.seed(db_session, PASSWORD, EXAMPLES)
    assert result["counts"] == {
        "users": 6, "apiKeys": 6, "organizations": 2, "memberships": 5, "projects": 1, "cases": 1, "caseRevisions": 1,
        "artifacts": result["counts"]["artifacts"], "snapshots": result["counts"]["snapshots"],
    }
    assert result["counts"]["artifacts"] >= 1 and result["counts"]["snapshots"] >= 1

    users = {user.username: user for user in (await db_session.scalars(select(User))).all()}
    assert users["lab-admin"].role is UserRole.ADMIN
    assert {name: user.role for name, user in users.items() if name != "lab-admin"} == {name: UserRole.USER for name in users if name != "lab-admin"}
    assert await roles_by_membership(db_session) == {
        ("lab-owner", "lab-main"): OrganizationRole.OWNER,
        ("lab-orgadmin", "lab-main"): OrganizationRole.ADMIN,
        ("lab-member", "lab-main"): OrganizationRole.MEMBER,
        ("lab-viewer", "lab-main"): OrganizationRole.VIEWER,
        ("lab-outsider", "lab-other"): OrganizationRole.OWNER,
    }
    assert {role for _, role, _ in seed_lab.SYNTHETIC_USERS} == {UserRole.ADMIN, UserRole.USER}
    assert set((await roles_by_membership(db_session)).values()) == set(OrganizationRole)  # all four roles are exercised
    assert all(user.email.endswith("@example.org") and verify_password(PASSWORD, user.password_hash) for user in users.values())

    project = (await db_session.scalars(select(Project))).one()
    organization = await db_session.get(Organization, project.organization_id)
    assert (organization.slug, project.slug) == seed_lab.PROJECT_REF
    case = (await db_session.scalars(select(BindingCase))).one()
    revision = (await db_session.scalars(select(BindingCaseRevision))).one()
    assert (case.slug, revision.source_snapshot_id is not None) == ("simple-seq", True)
    assert await db_session.get(InstanceSnapshot, revision.source_snapshot_id) is not None


async def test_seed_uses_the_open_gate_and_restores_the_installed_one(db_session):
    from openbinding_gateway import space_client
    from openbinding_gateway.space_client import OpenGate

    sentinel = OpenGate()
    space_client.set_gate(sentinel)
    try:
        await seed_lab.seed(db_session, PASSWORD, EXAMPLES)
        assert space_client.get_gate() is sentinel
    finally:
        space_client.set_gate(None)


async def test_ids_are_stable_uuid5_by_username_and_slug(db_session):
    result = await seed_lab.seed(db_session, PASSWORD, EXAMPLES)
    for username, identifier in result["ids"]["users"].items():
        assert identifier == str(uuid.uuid5(seed_lab.SEED_NAMESPACE, f"user:{username}"))
    assert result["ids"]["organizations"]["lab-main"] == str(uuid.uuid5(seed_lab.SEED_NAMESPACE, "organization:lab-main"))
    assert seed_lab.stable_id("user", "x") == seed_lab.stable_id("user", "x") != seed_lab.stable_id("organization", "x")


async def test_running_twice_does_not_duplicate_or_fail(db_session):
    first = await seed_lab.seed(db_session, PASSWORD, EXAMPLES)
    hashes = {user.username: user.password_hash for user in (await db_session.scalars(select(User))).all()}
    revision_id = (await db_session.scalars(select(BindingCaseRevision.id))).one()
    second = await seed_lab.seed(db_session, PASSWORD, EXAMPLES)
    third = await seed_lab.seed(db_session, PASSWORD, EXAMPLES)

    assert first["created"] and second["created"] == [] and third["created"] == []
    assert second["counts"] == first["counts"] == third["counts"]
    assert second["ids"] == first["ids"]
    assert (await db_session.scalars(select(BindingCaseRevision.id))).one() == revision_id
    # An unchanged password is not re-hashed (that would differ on every run).
    assert {user.username: user.password_hash for user in (await db_session.scalars(select(User))).all()} == hashes


async def test_a_changed_password_is_applied_without_creating_users(db_session):
    await seed_lab.seed(db_session, PASSWORD, EXAMPLES)
    result = await seed_lab.seed(db_session, PASSWORD + "-changed", EXAMPLES)
    assert [item for item in result["created"] if item.startswith("user:")] == []
    user = await db_session.scalar(select(User).where(User.username == "lab-owner"))
    assert verify_password(PASSWORD + "-changed", user.password_hash) and not verify_password(PASSWORD, user.password_hash)
    # Keys derive from the password, so the new password adds new keys beside the old ones.
    assert len((await db_session.scalars(select(ApiKey))).all()) == 12


async def test_api_keys_are_deterministic_derived_and_hashed(db_session):
    await seed_lab.seed(db_session, PASSWORD, EXAMPLES)
    full, prefix, secret_hash = seed_lab.api_key_for(PASSWORD, "lab-owner")
    assert seed_lab.api_key_for(PASSWORD, "lab-owner") == (full, prefix, secret_hash)
    assert seed_lab.api_key_for(PASSWORD + "x", "lab-owner")[0] != full != seed_lab.api_key_for(PASSWORD, "lab-member")[0]
    assert full.startswith(prefix + "_") and prefix.startswith("obk_")
    owner = await db_session.scalar(select(User).where(User.username == "lab-owner"))
    key = await db_session.scalar(select(ApiKey).where(ApiKey.user_id == owner.id))
    assert (key.prefix, key.secret_hash) == (prefix, secret_hash) and full not in repr(key.__dict__)
    admin = await db_session.scalar(select(User).where(User.username == "lab-admin"))
    admin_key = await db_session.scalar(select(ApiKey).where(ApiKey.user_id == admin.id))
    assert "admin:accounts:write" in admin_key.grants["permissions"] and "admin:accounts:write" not in key.grants["permissions"]


def test_importing_seed_lab_has_no_side_effects():
    from openbinding_gateway.db import base as db_base

    before = dict(os.environ)
    importlib.reload(seed_lab)
    assert dict(os.environ) == before and not db_base.is_configured()


def test_the_password_is_required_and_has_no_default(capsys):
    assert seed_lab.main([], environ={}) == 2
    assert "DEMO_SEED_PASSWORD is required" in capsys.readouterr().err
    assert seed_lab.main([], environ={"DEMO_SEED_PASSWORD": "short"}) == 2
    err = capsys.readouterr().err
    assert "unusable" in err and "DEMO_SEED_PASSWORD=short" not in err
    assert "devpass" not in Path(seed_lab.__file__).read_text()


def test_main_end_to_end_is_idempotent_and_hides_keys_by_default(tmp_path, monkeypatch, capsys):
    from openbinding_gateway.core.settings import get_settings
    from openbinding_gateway.db.base import Base

    url = f"sqlite+aiosqlite:///{tmp_path / 'lab.db'}"

    async def create_schema():
        engine = create_async_engine(url)
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        await engine.dispose()

    asyncio.run(create_schema())
    monkeypatch.setattr(get_settings(), "database_url", url)
    monkeypatch.setattr(get_settings(), "artifact_root", str(tmp_path / "blobs"))
    environ = {"DEMO_SEED_PASSWORD": PASSWORD}

    assert seed_lab.main([], environ=environ) == 0
    first = capsys.readouterr()
    assert PASSWORD not in first.out + first.err and "apiKeys" not in json.loads(first.out)  # "counts" has its own apiKeys number
    assert seed_lab.api_key_for(PASSWORD, "lab-owner")[0] not in first.out
    assert seed_lab.main([], environ=environ) == 0
    second = json.loads(capsys.readouterr().out)
    assert second["created"] == [] and second["counts"]["users"] == 6

    assert seed_lab.main(["--print-keys"], environ=environ) == 0
    keys = json.loads(capsys.readouterr().out)["apiKeys"]
    assert keys["lab-owner"] == seed_lab.api_key_for(PASSWORD, "lab-owner")[0] and len(keys) == 6


# -- SPACE contracts ---------------------------------------------------------------------


def space_world(service: str = "lab-dev-service") -> FakeRemotes:
    fake = FakeRemotes()
    fake.add_space("openbinding", ["1.0.0"])
    if service:
        fake.add_space(service, ["0.1.0"])
    return fake


async def run_contracts(fake: FakeRemotes, users, service="lab-dev-service"):
    space = common.SpaceRemote(common.load_env(ENV, sphere=False), transport=fake.transport())
    try:
        return await seed_lab.ensure_space_contracts(users, space, service_name=service, plan="BASIC", version="0.1.0")
    finally:
        await space.aclose()


async def test_space_contracts_are_created_once_for_example_org_users_only(db_session):
    users = (await seed_lab.seed(db_session, PASSWORD, EXAMPLES))["users"]
    outsider = User(id=uuid.uuid4(), username="real-person", email="person@corp.example.com", password_hash="x",
                    role=UserRole.USER, plan_cache="BASIC")
    fake = space_world()
    results = await run_contracts(fake, {**users, "real-person": outsider})
    assert {item["user"]: item["result"] for item in results} == {**{name: "created" for name in users}, "real-person": "skipped"}
    assert set(fake.contracts) == {str(user.id) for user in users.values()}
    stored = fake.contracts[str(users["lab-owner"].id)]
    assert stored["contractedServices"] == {"lab-dev-service": "0.1.0"} and stored["subscriptionPlans"] == {"lab-dev-service": "BASIC"}

    posts_before = len(fake.posts())
    again = await run_contracts(fake, users)
    assert {item["result"] for item in again} == {"exists"} and len(fake.posts()) == posts_before


async def test_space_contracts_never_delete_adjust_or_modify(db_session):
    users = (await seed_lab.seed(db_session, PASSWORD, EXAMPLES))["users"]
    fake = space_world()
    existing = {"id": "ctr-x", "userContact": {"userId": str(users["lab-viewer"].id)}, "contractedServices": {"openbinding": "1.0.0"},
                "subscriptionPlans": {"openbinding": "PRO"}, "subscriptionAddOns": {}, "usageLevels": {}, "history": []}
    fake.contracts[str(users["lab-viewer"].id)] = dict(existing)
    results = await run_contracts(fake, users)
    await run_contracts(fake, users)
    assert {item["user"]: item["result"] for item in results}["lab-viewer"] == "skipped"
    assert fake.contracts[str(users["lab-viewer"].id)] == existing
    assert fake.methods() <= {"GET", "POST"}
    assert not any("usageLevels" in item.path for item in fake.requests)
    assert all(item.path in ("/api/v1/contracts", ) or item.path.startswith(("/api/v1/contracts/", "/api/v1/services")) for item in fake.requests)


async def test_space_contracts_abort_when_the_dev_service_does_not_exist(db_session):
    users = (await seed_lab.seed(db_session, PASSWORD, EXAMPLES))["users"]
    fake = space_world(service="")
    results = await run_contracts(fake, users)
    assert [item["result"] for item in results] == ["aborted"] and fake.contracts == {} and fake.posts() == []


@pytest.mark.parametrize("name", ["openbinding", "OpenBinding", "", "x", "has space"])
def test_dev_service_guard_refuses_production_and_invalid_names(name):
    assert seed_lab.dev_service_guard(name, {}) is not None


def test_dev_service_guard_honours_the_configured_production_name():
    assert seed_lab.dev_service_guard("lab-dev-service", {}) is None
    assert "production" in seed_lab.dev_service_guard("real-prod-svc", {"SPACE_PROD_SERVICE_NAME": "Real-Prod-Svc"})


async def test_space_contracts_option_is_skipped_unless_everything_is_defined():
    users = {}
    dev = "lab-dev-service"
    assert "both be set" in (await seed_lab._space_contracts(users, ENV, "", "", dev))["skipped"]
    assert "both be set" in (await seed_lab._space_contracts(users, ENV, dev, "", dev))["skipped"]
    assert "production" in (await seed_lab._space_contracts(users, ENV, "openbinding", "BASIC", "openbinding"))["skipped"]
    assert "SPACE configuration" in (await seed_lab._space_contracts(users, {}, dev, "BASIC", dev))["skipped"]


async def test_space_contracts_require_the_gateway_service_to_match_the_dev_service():
    users = {}
    for gateway_service in ("openbinding", "other-dev-service"):
        skipped = (await seed_lab._space_contracts(users, ENV, "lab-dev-service", "BASIC", gateway_service))["skipped"]
        assert "must equal SPACE_SERVICE_NAME" in skipped
    # A match passes the name checks and reaches the SPACE configuration (absent here).
    matched = await seed_lab._space_contracts(users, {}, "lab-dev-service", "BASIC", "lab-dev-service")
    assert "SPACE configuration" in matched["skipped"]
