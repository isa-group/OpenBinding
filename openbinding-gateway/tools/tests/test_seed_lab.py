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

from openbinding_gateway.db.models import ApiKey, ProblemCompilation, User, UserRole
from openbinding_gateway.db.platform_models import (
    BindingCase,
    BindingCaseRevision,
    Composition,
    CompositionDerivation,
    CompositionVersion,
    Organization,
    OrganizationMembership,
    OrganizationRole,
)
from openbinding_gateway.security.passwords import verify_password

PASSWORD = "synthetic-lab-password-1"
REPO_ROOT = Path(os.environ.get("OPENBINDING_REPO_ROOT", Path(__file__).resolve().parents[3]))
EXAMPLES = REPO_ROOT / "examples"


async def roles_by_membership(session) -> dict[tuple[str, str], OrganizationRole]:
    """The roles in the lab's shared organizations (the personal ones apart)."""
    rows = (await session.execute(
        select(User.username, Organization.slug, OrganizationMembership.role)
        .join(OrganizationMembership, OrganizationMembership.user_id == User.id)
        .join(Organization, Organization.id == OrganizationMembership.organization_id)
        .where(Organization.personal_owner_id.is_(None))
    )).all()
    return {(username, slug): role for username, slug, role in rows}


async def test_first_run_creates_the_lab_with_the_real_roles(db_session):
    result = await seed_lab.seed(db_session, PASSWORD, EXAMPLES)
    assert result["counts"] == {
        "users": 6, "apiKeys": 6, "organizations": 2, "memberships": 5, "personalOrganizations": 6, "cases": 2,
        "caseRevisions": 2, "compilations": 2, "compositions": 4, "compositionVersions": 5,
    }

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
    # Every seeded user owns its personal organization, named after it, and nobody else is a member of one.
    personal = (await db_session.execute(
        select(Organization.slug, Organization.name, Organization.parent_id, User.username, OrganizationMembership.role)
        .join(OrganizationMembership, OrganizationMembership.organization_id == Organization.id)
        .join(User, User.id == OrganizationMembership.user_id)
        .where(Organization.personal_owner_id.is_not(None))
    )).all()
    assert sorted(personal) == sorted(
        (name, f"{name} PERSONAL", None, name, OrganizationRole.OWNER) for name, _, _ in seed_lab.SYNTHETIC_USERS
    )
    assert sorted(item for item in result["created"] if item.startswith("personal-organization:")) == sorted(
        f"personal-organization:{name}" for name, _, _ in seed_lab.SYNTHETIC_USERS
    )

    # The same example is the problem simple-seq of each organization, one revision and one compilation each.
    problems = (await db_session.execute(
        select(Organization.slug, BindingCase.slug).join(Organization, Organization.id == BindingCase.organization_id)
    )).all()
    assert sorted(problems) == [("lab-main", "simple-seq"), ("lab-other", "simple-seq")]
    revisions = (await db_session.scalars(select(BindingCaseRevision))).all()
    compilations = (await db_session.scalars(select(ProblemCompilation))).all()
    assert sorted(item.revision_id for item in compilations) == sorted(item.id for item in revisions)
    assert str(next(item.id for item in revisions if item.created_by_id == users["lab-owner"].id)) == result["ids"]["caseRevision"]


async def compositions_of(session) -> dict[str, tuple[str, list[tuple[str, str]]]]:
    """``<organization>/<slug>`` -> (visibility, [(label, values status)] by ordinal)."""
    rows = (await session.execute(
        select(Organization.slug, Composition.slug, Composition.visibility, CompositionVersion.label,
               CompositionVersion.values_status, CompositionVersion.ordinal)
        .join(Composition, Composition.organization_id == Organization.id)
        .join(CompositionVersion, CompositionVersion.composition_id == Composition.id)
        .order_by(CompositionVersion.ordinal)
    )).all()
    found: dict[str, tuple[str, list[tuple[str, str]]]] = {}
    for org, slug, visibility, label, status, _ in rows:
        found.setdefault(f"{org}/{slug}", (visibility, []))[1].append((label, getattr(status, "value", status)))
    return found


async def test_the_compositions_of_the_walks_and_the_showcase_are_seeded(db_session):
    result = await seed_lab.seed(db_session, PASSWORD, EXAMPLES)

    assert await compositions_of(db_session) == {
        "lab-main/sequential-workflow": ("private", [("1.0.0", "verified"), ("1.1.0", "verified")]),
        "lab-other/sequential-workflow": ("public", [("1.0.0", "verified")]),
        "lab-other/order-desk": ("public", [("1.0.0", "declared")]),
        "lab-other/internal-draft": ("private", [("0.1.0", "declared")]),
    }
    assert set(result["ids"]["compositions"]) == {
        "lab-main/sequential-workflow", "lab-other/sequential-workflow", "lab-other/order-desk", "lab-other/internal-draft",
    }
    # lab-main's two versions are derived from bindings of its own problem: the first eligible candidates, then t1
    # moved to its other candidate (the J1 walk's change, and the pair the visual QA compares).
    main = await db_session.scalar(select(Composition).where(Composition.id == uuid.UUID(result["ids"]["compositions"]["lab-main/sequential-workflow"])))
    versions = (await db_session.scalars(
        select(CompositionVersion).where(CompositionVersion.composition_id == main.id).order_by(CompositionVersion.ordinal)
    )).all()
    assert "candidate: c1a" in versions[0].content and "candidate: c1b" in versions[1].content
    assert all("lab-main/problems/simple-seq@1" in version.content for version in versions)
    derivations = (await db_session.scalars(select(CompositionDerivation))).all()
    assert len(derivations) == 3 and {item.job_id for item in derivations} == {None}
    public = (await db_session.scalars(
        select(CompositionVersion).join(Composition).where(Composition.visibility == "public", Composition.slug == "sequential-workflow")
    )).one()
    assert "lab-other/problems/simple-seq@1" in public.content


async def test_the_compositions_are_seeded_once_and_their_visibility_is_the_seeds(db_session):
    await seed_lab.seed(db_session, PASSWORD, EXAMPLES)
    before = await compositions_of(db_session)
    draft = await db_session.scalar(select(Composition).where(Composition.slug == "internal-draft"))
    draft.visibility = "public"
    await db_session.commit()

    again = await seed_lab.seed(db_session, PASSWORD, EXAMPLES)

    assert again["created"] == [] and await compositions_of(db_session) == before
    assert again["counts"]["compositions"] == 4 and again["counts"]["compositionVersions"] == 5


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
    revision_ids = sorted((await db_session.scalars(select(BindingCaseRevision.id))).all())
    second = await seed_lab.seed(db_session, PASSWORD, EXAMPLES)
    third = await seed_lab.seed(db_session, PASSWORD, EXAMPLES)

    assert first["created"] and second["created"] == [] and third["created"] == []
    assert second["counts"] == first["counts"] == third["counts"]
    assert second["ids"] == first["ids"]
    assert sorted((await db_session.scalars(select(BindingCaseRevision.id))).all()) == revision_ids
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


# -- SPHERE (F3) ---------------------------------------------------------------------------------------------------------


@pytest.fixture
def recorded_sphere(monkeypatch):
    """The recorded SPHERE answers as the pricing source, SPHERE enabled, nothing reaching the network."""
    import sys

    from openbinding_gateway.core import outbound
    from openbinding_gateway.core.settings import get_settings
    from openbinding_gateway.modules.plans.adapters.sphere import SphereHttpSource
    from openbinding_gateway.modules.plans.application import set_pricing_source

    tests = Path(__file__).resolve().parents[2] / "tests"
    monkeypatch.syspath_prepend(str(tests))
    from sphere_recorded import RecordedSphere

    recorded = RecordedSphere()
    monkeypatch.setattr(outbound, "_getaddrinfo", lambda host, port: recorded.getaddrinfo(host, port))
    settings = get_settings()
    monkeypatch.setattr(settings, "sphere_enabled", True)
    set_pricing_source(SphereHttpSource(settings, transport=recorded.transport()))
    yield recorded
    set_pricing_source(None)
    sys.modules.pop("sphere_recorded", None)


async def test_without_sphere_the_sphere_steps_are_skipped(db_session):
    result = await seed_lab.seed(db_session, PASSWORD, EXAMPLES)
    assert result["sphere"] == {"status": "skipped", "reason": "SPHERE is not enabled"}
    assert await db_session.scalar(select(BindingCase).where(BindingCase.slug == seed_lab.TOMATOMETER)) is None


async def test_with_sphere_tomatometer_comes_from_its_template(db_session, recorded_sphere):
    from openbinding_gateway.db.models import CompositionEvaluation, ProblemValueOrigin

    result = await seed_lab.seed(db_session, PASSWORD, EXAMPLES)
    assert result["sphere"]["status"] == "seeded", result["sphere"]
    assert result["sphere"]["revision"] == 3
    assert result["sphere"]["versions"] == ["1.0.0", "1.1.0"]
    assert result["sphere"]["environments"] == ["production", "staging"] and result["sphere"]["handoff"] is None
    problem = await db_session.scalar(select(BindingCase).where(BindingCase.slug == seed_lab.TOMATOMETER))
    revisions = (await db_session.scalars(
        select(BindingCaseRevision).where(BindingCaseRevision.binding_case_id == problem.id)
        .order_by(BindingCaseRevision.revision)
    )).all()
    assert [r.origin for r in revisions] == ["upload", "sphere", "sphere"]
    assert revisions[1].provenance["recipe"]["tasks"][0]["from"][0]["sphere"]["version"] == "6ade36454b2b5b01c587db3d"
    assert [task["task"] for task in revisions[2].provenance["recipe"]["tasks"]] == ["dailySummary", "export", "quotes"]
    origins = (await db_session.scalars(select(ProblemValueOrigin).where(ProblemValueOrigin.revision_id == revisions[2].id))).all()
    assert origins and all(o.snapshot_id is not None for o in origins if o.pricing_id)
    composition = await db_session.scalar(select(Composition).where(Composition.slug == "tomatometer"))
    versions = {v.label: v for v in (await db_session.scalars(
        select(CompositionVersion).where(CompositionVersion.composition_id == composition.id))).all()}
    assert set(versions) == {"1.0.0", "1.1.0"}
    first, switched = versions["1.0.0"].content, versions["1.1.0"].content
    assert "tomatometer-email@3" in first and "email.brevo.professional" in first and "storage.dropbox.plus" in first
    assert "quotes.zenquotes.free" in first and "offering:\n  sphere: sphere/tomatometer" in first
    assert "email.resend.pro" in switched and "email.brevo.professional" not in switched
    assert first.replace("email.brevo.professional", "") != switched
    for version in versions.values():
        evaluation = await db_session.scalar(select(CompositionEvaluation).where(CompositionEvaluation.version_id == version.id))
        assert evaluation.offering_status == "read" and evaluation.outcome.value == "verified"
    # The order-desk offering is a URL that never resolves: recorded as unreadable, sealed all the same.
    order = await db_session.scalar(select(Composition).where(Composition.slug == "order-desk"))
    order_version = await db_session.scalar(select(CompositionVersion).where(CompositionVersion.composition_id == order.id))
    order_evaluation = await db_session.scalar(
        select(CompositionEvaluation).where(CompositionEvaluation.version_id == order_version.id)
    )
    assert order_evaluation.offering_status == "unreadable"
    calls = len(recorded_sphere.requests)
    again = await seed_lab.seed(db_session, PASSWORD, EXAMPLES)
    assert again["sphere"]["status"] == "seeded" and again["created"] == []
    assert len(recorded_sphere.requests) == calls


async def test_the_environments_of_tomatometer_and_the_derived_feed_key(db_session, recorded_sphere):
    from openbinding_gateway.db.models import (
        CompositionAdoption,
        CompositionEnvironment,
        CompositionEnvironmentKey,
    )
    from openbinding_gateway.security.apikeys import hash_key

    await seed_lab.seed(db_session, PASSWORD, EXAMPLES)
    users = {user.id: user.username for user in (await db_session.scalars(select(User))).all()}
    rows = {row.slug: row for row in (await db_session.scalars(select(CompositionEnvironment))).all()}
    assert set(rows) == {"production", "staging"}
    production, staging = rows["production"], rows["staging"]
    assert users[production.operator_id] == "lab-owner"
    assert (production.adopt_role, production.expected_users, production.adoption_ordinal) == ("ADMIN", 1000, 1)
    assert (staging.adopt_role, staging.expected_users, staging.adoption_ordinal) == ("MEMBER", None, 0)
    assert staging.adopted_version_id is None and staging.operator_id is None
    (adopted,) = (await db_session.scalars(select(CompositionAdoption))).all()
    first = await db_session.get(CompositionVersion, adopted.version_id)
    assert first.label == "1.0.0" and users[adopted.actor_id] == "lab-owner"
    assert adopted.content_digest == first.content_digest
    (key,) = (await db_session.scalars(select(CompositionEnvironmentKey))).all()
    assert key.environment_id == production.id and key.revoked_at is None
    minted = seed_lab.feed_key_for(PASSWORD, "lab-main", "tomatometer", "production")
    # The fixed vector the live walks' TypeScript twin is held to (frontend/e2e/live/support.ts, F4-C).
    assert minted.secret == "obe_d99385bd_03249980caea333a4ea61ff76c91fd581521f8015d72f89341f8c067"
    assert (key.prefix, key.secret_hash) == (minted.prefix, hash_key(minted.secret))
    assert seed_lab.feed_key_for("another-password-1", "lab-main", "tomatometer", "production").secret != minted.secret


async def test_the_handoff_file(db_session, recorded_sphere, tmp_path):
    result = await seed_lab.seed(db_session, PASSWORD, EXAMPLES, handoff_dir=str(tmp_path))
    path = tmp_path / "openbinding.json"
    assert result["sphere"]["handoff"] == str(path)
    assert path.stat().st_mode & 0o777 == 0o600
    assert json.loads(path.read_text()) == {
        "organization": "lab-main", "composition": "tomatometer", "environment": "production",
        "feedUrl": "http://web:8080/api/v1/organizations/lab-main/compositions/tomatometer/environments/production/composition",
        "feedKey": seed_lab.feed_key_for(PASSWORD, "lab-main", "tomatometer", "production").secret,
    }
    assert not list(tmp_path.glob(".*.tmp"))
    # A second run rewrites the same file (a consumer may pick up a re-seed).
    path.write_text("{}")
    await seed_lab.seed(db_session, PASSWORD, EXAMPLES, handoff_dir=str(tmp_path))
    assert json.loads(path.read_text())["feedKey"].startswith("obe_d99385bd_")


async def test_a_missing_or_unwritable_handoff_directory_is_said_plainly(db_session, recorded_sphere, tmp_path):
    with pytest.raises(seed_lab.HandoffError, match="is not a directory"):
        await seed_lab.seed(db_session, PASSWORD, EXAMPLES, handoff_dir=str(tmp_path / "missing"))
    locked = tmp_path / "locked"
    locked.mkdir()
    locked.chmod(0o500)
    try:
        if os.access(locked, os.W_OK):
            pytest.skip("running as a user who writes anywhere")
        with pytest.raises(seed_lab.HandoffError, match="is not writable"):
            seed_lab.write_handoff(str(locked), organization="o", composition="c", environment="e", key="k")
    finally:
        locked.chmod(0o700)


def test_main_reports_a_missing_handoff_directory_without_a_traceback(tmp_path, monkeypatch, capsys):
    async def refuse(*_args, **_kwargs):
        raise seed_lab.HandoffError(f"LAB_HANDOFF_DIR {tmp_path / 'missing'} is not a directory")

    monkeypatch.setattr(seed_lab, "seed", refuse)
    environ = {"DEMO_SEED_PASSWORD": PASSWORD, "DATABASE_URL": f"sqlite+aiosqlite:///{tmp_path / 'db.sqlite'}",
               "LAB_HANDOFF_DIR": str(tmp_path / "missing")}
    code = seed_lab.main([], environ)
    err = capsys.readouterr().err
    assert code == 1 and "is not a directory" in err and "Traceback" not in err
