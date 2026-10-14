#!/usr/bin/env python3
"""Idempotent local seed for the demo: synthetic users with the real roles, two
organizations, one project with a small BIM package from ``examples/`` as a case.

Safe to run on an empty or an already seeded database: every row is looked up by
a stable key (UUIDv5 ids by username/slug) and created only when missing; there is
no ``--reset`` and no user, organization, project, case or revision is ever deleted. It
also compiles again, with the installed bim-toolchain, the package of every snapshot a
case revision pins that another release compiled, and replaces the IR stored for it
(docs/qa/IR_CUTOVER.md); every id is kept. It launches no jobs, no studies and no solvers.
Importing this module has no side effects.

Environment:
    DEMO_SEED_PASSWORD   required; password of every synthetic user (at least 10 chars).
                         API keys are derived from it (HMAC) and are not printed
                         unless --print-keys is given.
    DATABASE_URL         the gateway's database (read through the gateway settings).
    With --space-contracts additionally: SPACE_URL, SPACE_API_KEY, SPACE_ORGANIZATION_ID,
    SPACE_DEV_SERVICE_NAME, SPACE_DEV_PLAN (and optionally SPACE_DEV_PRICING_VERSION,
    default 0.1.0, and SPACE_PROD_SERVICE_NAME). SPACE_DEV_SERVICE_NAME must equal the
    gateway's SPACE_SERVICE_NAME, so the seeded contracts are the ones the gateway reads;
    ``openbinding`` is never a seeding target.

Usage:
    python tools/seed_lab.py [--print-keys] [--space-contracts] [--verbose]
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import hmac
import logging
import os
import re
import sys
import uuid
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

# Importing this first makes ``openbinding_gateway`` importable when run as a script.
from _remote_common import (  # isort: skip
    EXIT_GUARD,
    ConfigError,
    Redactor,
    SpaceRemote,
    emit_json,
    load_env,
    normalize_space_services,
)

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from openbinding_gateway import space_client
from openbinding_gateway.db.models import (
    ApiKey,
    Artifact,
    ArtifactDraft,
    ArtifactVersion,
    CaseArtifact,
    InstanceSnapshot,
    ProjectArtifact,
    User,
    UserRole,
)
from openbinding_gateway.db.platform_models import (
    BindingCase,
    BindingCaseRevision,
    Organization,
    OrganizationMembership,
    OrganizationRole,
    Project,
    Visibility,
)
from openbinding_gateway.services.snapshots import RecompileReport, recompile_stale_snapshots
from openbinding_gateway.space_client import OpenGate
from openbinding_gateway.security.apikeys import ADMIN_PERMISSIONS, ALL_PERMISSIONS, hash_key
from openbinding_gateway.security.passwords import hash_password, password_complaint, verify_password
from bim_core.package import load_package

logger = logging.getLogger("seed_lab")

#: Fixed, arbitrary namespace for the stable UUIDv5 ids of the lab rows.
SEED_NAMESPACE = uuid.UUID("6f1d3a52-8c0e-4b7a-9d21-0f5e7c3a9b10")
EMAIL_DOMAIN = "example.org"
DEMO_PACKAGE = "01_simple_seq"
PROJECT_REF = ("lab-main", "bim-demo")
CASE_SLUG = "simple-seq"
KNOWN_PRODUCTION_SERVICES = ("openbinding",)

#: (username, platform role, {organization slug: organization role})
SYNTHETIC_USERS: tuple[tuple[str, UserRole, Mapping[str, OrganizationRole]], ...] = (
    ("lab-admin", UserRole.ADMIN, {}),
    ("lab-owner", UserRole.USER, {"lab-main": OrganizationRole.OWNER}),
    ("lab-orgadmin", UserRole.USER, {"lab-main": OrganizationRole.ADMIN}),
    ("lab-member", UserRole.USER, {"lab-main": OrganizationRole.MEMBER}),
    ("lab-viewer", UserRole.USER, {"lab-main": OrganizationRole.VIEWER}),
    ("lab-outsider", UserRole.USER, {"lab-other": OrganizationRole.OWNER}),
)
#: (slug, name, sponsor/creator username)
ORGANIZATIONS = (
    ("lab-main", "Lab Main Organization", "lab-owner"),
    ("lab-other", "Lab Other Organization", "lab-outsider"),
)


def stable_id(kind: str, key: str) -> uuid.UUID:
    return uuid.uuid5(SEED_NAMESPACE, f"{kind}:{key}")


def email_of(username: str) -> str:
    return f"{username}@{EMAIL_DOMAIN}"


def api_key_for(password: str, username: str) -> tuple[str, str, str]:
    """Deterministic (full key, prefix, hash) derived from the demo password; nothing is stored in code."""
    digest = hmac.new(password.encode("utf-8"), f"openbinding-lab-seed:apikey:{username}".encode(), hashlib.sha256).hexdigest()
    prefix = f"obk_{digest[:8]}"
    full = f"{prefix}_{digest[8:]}"
    return full, prefix, hash_key(full)


def find_examples_dir(explicit: Path | None = None) -> Path:
    here = Path(__file__).resolve()
    candidates = [explicit] if explicit else []
    candidates += [Path("/app/examples"), here.parents[2] / "examples", here.parents[1] / "examples", Path.cwd() / "examples"]
    for candidate in candidates:
        if candidate and (candidate / "demo" / DEMO_PACKAGE / "instance.json").exists():
            return candidate
    raise FileNotFoundError(f"examples/demo/{DEMO_PACKAGE}/instance.json was not found")


async def ensure_users(session: AsyncSession, password: str, plan: str, created: list[str]) -> dict[str, User]:
    users: dict[str, User] = {}
    for username, role, _ in SYNTHETIC_USERS:
        user = await session.scalar(select(User).where(User.username == username))
        if user is None:
            user = User(
                id=stable_id("user", username),
                username=username,
                email=email_of(username),
                password_hash=hash_password(password),
                password_enabled=True,
                role=role,
                is_active=True,
                plan_cache=plan,
                contract_pending=False,
                preferences={"locale": "en"},
            )
            session.add(user)
            await session.flush()
            created.append(f"user:{username}")
        elif not verify_password(password, user.password_hash):
            # Only when the demo password changed; an unchanged one is left alone (a re-hash would differ every run).
            user.password_hash = hash_password(password)
            await session.flush()
        users[username] = user

        full, prefix, secret_hash = api_key_for(password, username)
        permissions = list(ALL_PERMISSIONS) if role is UserRole.ADMIN else sorted(set(ALL_PERMISSIONS) - ADMIN_PERMISSIONS)
        grants = {"permissions": permissions, "allEngines": True, "engines": []}
        key = await session.scalar(select(ApiKey).where(ApiKey.user_id == user.id, ApiKey.prefix == prefix))
        if key is None:
            session.add(ApiKey(user_id=user.id, name=f"Lab key for {username}", prefix=prefix, secret_hash=secret_hash, grants=grants))
            await session.flush()
            created.append(f"api-key:{username}")
    return users


async def ensure_organizations(session: AsyncSession, users: dict[str, User], created: list[str]) -> dict[str, Organization]:
    organizations: dict[str, Organization] = {}
    for slug, name, sponsor in ORGANIZATIONS:
        organization = await session.scalar(select(Organization).where(Organization.slug == slug))
        if organization is None:
            organization = Organization(
                id=stable_id("organization", slug),
                slug=slug,
                name=name,
                parent_id=None,
                billing_sponsor_user_id=users[sponsor].id,
                created_by_id=users[sponsor].id,
            )
            session.add(organization)
            await session.flush()
            created.append(f"organization:{slug}")
        organizations[slug] = organization
    for username, _, memberships in SYNTHETIC_USERS:
        for slug, role in memberships.items():
            existing = await session.scalar(
                select(OrganizationMembership).where(
                    OrganizationMembership.organization_id == organizations[slug].id,
                    OrganizationMembership.user_id == users[username].id,
                )
            )
            if existing is None:
                session.add(OrganizationMembership(organization_id=organizations[slug].id, user_id=users[username].id, role=role))
                await session.flush()
                created.append(f"membership:{slug}:{username}:{role.value}")
    return organizations


async def ensure_project(session: AsyncSession, organizations: dict[str, Organization], users: dict[str, User], created: list[str]) -> Project:
    org_slug, slug = PROJECT_REF
    organization = organizations[org_slug]
    project = await session.scalar(select(Project).where(Project.organization_id == organization.id, Project.slug == slug))
    if project is None:
        project = Project(
            id=stable_id("project", f"{org_slug}/{slug}"),
            organization_id=organization.id,
            slug=slug,
            name="BIM demo",
            description="Synthetic lab project with one small BIM package.",
            visibility=Visibility.PRIVATE,
            created_by_id=users["lab-owner"].id,
        )
        session.add(project)
        await session.flush()
        created.append(f"project:{org_slug}/{slug}")
    return project


async def ensure_library_composition(session: AsyncSession, project: Project, user: User, package: Any, prefix: str):
    """Authored, named library resources for the package, never copies shared by byte equality.

    Extracted from tools/seed_dev.py (which has import-time effects and cannot be imported).
    """
    from openbinding_gateway.artifacts import materialize_case, reference, seal_draft, validate_content
    from openbinding_gateway.models.artifacts import ArtifactUse, DraftContent
    from bim_core.canonical import digest_bytes

    organization = await session.get(Organization, project.organization_id)
    uses = []
    for role, resources in package.instance()["spec"]["resources"].items():
        for alias, path in resources.items():
            content = package.json(path) if path.endswith(".json") else package.files[path].decode("utf-8")
            kind = content["kind"] if isinstance(content, dict) else "BPMN"
            payload = DraftContent(
                content=content,
                media_type="application/json" if isinstance(content, dict) else "application/vnd.omg.bpmn+xml",
            )
            raw, contracts = validate_content(kind, payload)
            name = f"{prefix}-{alias}"
            artifact = await session.scalar(select(Artifact).where(Artifact.organization_id == organization.id, Artifact.name == name))
            if artifact is None:
                artifact = Artifact(
                    organization_id=organization.id,
                    namespace=str(organization.id),
                    name=name,
                    display_name=f"{prefix} · {alias}",
                    kind=kind,
                    created_by_id=user.id,
                )
                session.add(artifact)
                await session.flush()
            candidates = (
                await session.scalars(
                    select(ArtifactVersion).where(
                        ArtifactVersion.artifact_id == artifact.id, ArtifactVersion.content_digest == digest_bytes(raw)
                    )
                )
            ).all()
            version = next((item for item in candidates if item.manifest["contracts"] == contracts), None)
            if version is None:
                draft = ArtifactDraft(artifact_id=artifact.id, payload=payload.model_dump(mode="json"), created_by_id=user.id)
                session.add(draft)
                await session.flush()
                version = await seal_draft(session, artifact, draft, 1, None, user)
            if await session.get(ProjectArtifact, (project.id, artifact.id)) is None:
                session.add(ProjectArtifact(project_id=project.id, artifact_id=artifact.id))
            uses.append(ArtifactUse(role=role, alias=alias, artifact=reference(artifact, version)))
    return await materialize_case(session, user, organization, package.instance(), uses)


async def ensure_case(session: AsyncSession, project: Project, user: User, examples_dir: Path, created: list[str]) -> BindingCaseRevision:
    from openbinding_gateway.artifacts import case_composition_digest

    package = load_package(examples_dir / "demo" / DEMO_PACKAGE)
    case = await session.scalar(select(BindingCase).where(BindingCase.project_id == project.id, BindingCase.slug == CASE_SLUG))
    if case is None:
        case = BindingCase(
            id=stable_id("case", f"{PROJECT_REF[0]}/{PROJECT_REF[1]}/{CASE_SLUG}"),
            project_id=project.id,
            slug=CASE_SLUG,
            name="Sequential Service Workflow",
            description="Sequential pipeline with strict latency bounds (synthetic demo).",
            created_by_id=user.id,
        )
        session.add(case)
        await session.flush()
        created.append(f"case:{CASE_SLUG}")
    document, snapshot_id, uses = await ensure_library_composition(session, project, user, package, DEMO_PACKAGE)
    snapshot = await session.get(InstanceSnapshot, snapshot_id)
    composition = case_composition_digest(document, snapshot, [use.model_dump(mode="json") for use, _ in uses])
    revision = await session.scalar(
        select(BindingCaseRevision).where(BindingCaseRevision.binding_case_id == case.id, BindingCaseRevision.digest == composition)
    )
    if revision is None:
        ordinal = int(await session.scalar(select(func.max(BindingCaseRevision.revision)).where(BindingCaseRevision.binding_case_id == case.id)) or 0) + 1
        revision = BindingCaseRevision(
            binding_case_id=case.id,
            revision=ordinal,
            digest=composition,
            document=document,
            source_snapshot_id=snapshot.id,
            created_by_id=user.id,
        )
        session.add(revision)
        await session.flush()
        for use, version in uses:
            session.add(CaseArtifact(revision_id=revision.id, role=use.role, alias=use.alias, version_id=version.id, bindings=use.bindings))
        await session.flush()
        created.append(f"case-revision:{CASE_SLUG}:{ordinal}")
    return revision


async def ensure_current_toolchain(session: AsyncSession, created: list[str]) -> RecompileReport:
    """Make every snapshot a case revision pins one that the installed toolchain compiled.

    After a release of bim-toolchain that changes the IR, the snapshots a seeded lab holds were compiled
    by the previous one and the gateway refuses them (``422 contract_not_installed``). Their packages are
    stored, so their IR is compiled again in place (``docs/qa/IR_CUTOVER.md``); case revisions are sealed
    and keep their ids, as do the snapshots. On a lab that is already current this changes nothing.
    """
    report = await recompile_stale_snapshots(session)
    for _, revisions in report.recompiled:
        created.extend(f"recompiled-case-revision:{revision}" for revision in revisions)
    return report


async def count_rows(session: AsyncSession, users: dict[str, User], organizations: dict[str, Organization]) -> dict[str, int]:
    user_ids = [user.id for user in users.values()]
    org_ids = [organization.id for organization in organizations.values()]

    async def count(model: Any, *conditions: Any) -> int:
        return int(await session.scalar(select(func.count()).select_from(model).where(*conditions)) or 0)

    return {
        "users": await count(User, User.id.in_(user_ids)),
        "apiKeys": await count(ApiKey, ApiKey.user_id.in_(user_ids)),
        "organizations": await count(Organization, Organization.id.in_(org_ids)),
        "memberships": await count(OrganizationMembership, OrganizationMembership.organization_id.in_(org_ids)),
        "projects": await count(Project, Project.organization_id.in_(org_ids)),
        "cases": await count(BindingCase, BindingCase.slug == CASE_SLUG),
        "caseRevisions": await count(BindingCaseRevision, BindingCaseRevision.created_by_id.in_(user_ids)),
        "artifacts": await count(Artifact, Artifact.organization_id.in_(org_ids)),
        "snapshots": await count(InstanceSnapshot, InstanceSnapshot.owner_id.in_(user_ids)),
    }


async def seed(session: AsyncSession, password: str, examples_dir: Path, *, plan: str = "BASIC") -> dict[str, Any]:
    """Create what is missing; return what was created (empty on a repeated run) and the row counts."""
    created: list[str] = []
    # Storing library content consults the pricing gate for the sponsor's storage allowance. The lab
    # data is local and synthetic and the synthetic users have no SPACE contract, so the seed uses the
    # open gate (no plan, no counters) whatever SPACE_ENABLED says, and restores what was installed.
    try:
        previous = space_client.get_gate()
    except RuntimeError:
        previous = None
    space_client.set_gate(OpenGate())
    try:
        # First, so that the compilation of the case below finds the regenerated snapshot instead of
        # making a second one of the same package that would have to be removed.
        recompile = await ensure_current_toolchain(session, created)
        users = await ensure_users(session, password, plan, created)
        organizations = await ensure_organizations(session, users, created)
        project = await ensure_project(session, organizations, users, created)
        revision = await ensure_case(session, project, users["lab-owner"], examples_dir, created)
        await session.commit()
    finally:
        space_client.set_gate(previous)
    return {
        "created": created,
        "recompileFailed": [{"snapshotId": snapshot_id, "code": code} for snapshot_id, code in recompile.failed],
        "counts": await count_rows(session, users, organizations),
        "ids": {
            "users": {name: str(user.id) for name, user in users.items()},
            "organizations": {slug: str(item.id) for slug, item in organizations.items()},
            "project": str(project.id),
            "caseRevision": str(revision.id),
        },
        "roles": {
            username: {"platform": role.value, "organizations": {slug: item.value for slug, item in memberships.items()}}
            for username, role, memberships in SYNTHETIC_USERS
        },
        "users": users,
    }


# --------------------------------------------------------------------------
# Optional SPACE contracts for the synthetic users (official client only)
# --------------------------------------------------------------------------


def dev_service_guard(service_name: str, environ: Mapping[str, str]) -> str | None:
    """Why this SPACE service name may not receive synthetic contracts, or ``None`` if it may."""
    if not re.fullmatch(r"[a-z0-9][a-z0-9_-]{1,62}", service_name):
        return "SPACE_DEV_SERVICE_NAME is not a valid development service name"
    protected = {name.casefold() for name in KNOWN_PRODUCTION_SERVICES}
    if environ.get("SPACE_PROD_SERVICE_NAME"):
        protected.add(environ["SPACE_PROD_SERVICE_NAME"].casefold())
    if service_name.casefold() in protected:
        return "SPACE_DEV_SERVICE_NAME names a production service"
    return None


async def ensure_space_contracts(
    users: Mapping[str, User], space: SpaceRemote, *, service_name: str, plan: str, version: str
) -> list[dict[str, Any]]:
    """One contract per synthetic ``*@example.org`` user on the development service.

    Never removes a contract, never adjusts usage, never changes an existing contract.
    """
    from space_client.types.models import BillingPeriodToCreate, ContractToCreate, UserContact

    results: list[dict[str, Any]] = []
    lookup = await space.service(service_name)
    services, _ = normalize_space_services(lookup.data) if lookup.ok else ([], [])
    if not any(item["name"] == service_name for item in services):
        return [{"user": None, "result": "aborted", "reason": f"SPACE service {service_name!r} was not found (status {lookup.status})"}]
    for username, user in users.items():
        if not user.email.casefold().endswith(f"@{EMAIL_DOMAIN}"):
            results.append({"user": username, "result": "skipped", "reason": f"email is not @{EMAIL_DOMAIN}"})
            continue
        user_id = str(user.id)
        status, contract, error = await space.get_contract(user_id)
        if status == "error":
            results.append({"user": username, "result": "error", "reason": error})
        elif status == "found":
            services_of = getattr(contract, "contracted_services", None) or {}
            results.append(
                {"user": username, "result": "exists" if service_name in services_of else "skipped",
                 "reason": None if service_name in services_of else "an existing contract without the development service is left unchanged"}
            )
        else:
            accepted, _, error = await space.add_contract(
                ContractToCreate(
                    user_contact=UserContact(user_id=user_id, username=user_id, email=user.email, phone=""),
                    billing_period=BillingPeriodToCreate(auto_renew=True, renewal_days=30),
                    contracted_services={service_name: version},
                    subscription_plans={service_name: plan},
                    subscription_add_ons={},
                )
            )
            status, contract, _ = await space.get_contract(user_id)
            confirmed = (
                status == "found"
                and (getattr(contract, "contracted_services", {}) or {}).get(service_name) == version
                and (getattr(contract, "subscription_plans", {}) or {}).get(service_name) == plan
            )
            results.append(
                {"user": username, "result": "created" if accepted and confirmed else "unconfirmed", "reason": error}
            )
    return results


# --------------------------------------------------------------------------
# Command line
# --------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Idempotent local lab seed (synthetic data only).")
    parser.add_argument("--print-keys", action="store_true", help="Also print the derived API keys of the synthetic users.")
    parser.add_argument("--space-contracts", action="store_true", help="Create SPACE contracts for the synthetic @example.org users (dev service only).")
    parser.add_argument("--examples-dir", type=Path, default=None)
    parser.add_argument("--verbose", action="store_true")
    return parser


async def _run(args: argparse.Namespace, environ: Mapping[str, str], password: str) -> int:
    from openbinding_gateway.core.settings import get_settings
    from openbinding_gateway.db import base as db_base

    settings = get_settings()
    if str(getattr(settings, "app_env", "dev")).lower() == "prod":
        print("refusing to seed a production environment (APP_ENV=prod)", file=sys.stderr)
        return 1
    database_url = settings.database_url or environ.get("DATABASE_URL")
    if not database_url:
        print("no DATABASE_URL configured", file=sys.stderr)
        return 1
    dev_service = environ.get("SPACE_DEV_SERVICE_NAME", "")
    dev_plan = environ.get("SPACE_DEV_PLAN", "")
    examples_dir = find_examples_dir(args.examples_dir)
    db_base.init_engine(database_url)
    try:
        async with db_base.session_factory()() as session:
            result = await seed(session, password, examples_dir, plan=dev_plan or "BASIC")
        users = result.pop("users")
        report: dict[str, Any] = {"tool": "seed_lab", **result}
        for failure in result["recompileFailed"]:
            print(f"snapshot {failure['snapshotId']} could not be compiled again ({failure['code']})", file=sys.stderr)
        if args.print_keys:
            report["apiKeys"] = {name: api_key_for(password, name)[0] for name in users}
        if args.space_contracts:
            report["spaceContracts"] = await _space_contracts(
                users, environ, dev_service, dev_plan, settings.space_service_name
            )
    finally:
        await db_base.dispose_engine()
    secrets = [password] + ([] if args.print_keys else [api_key_for(password, name)[0] for name, *_ in SYNTHETIC_USERS])
    emit_json(report, Redactor(secrets))
    return 0


async def _space_contracts(
    users: Mapping[str, User], environ: Mapping[str, str], service_name: str, plan: str, gateway_service: str
) -> Any:
    """``gateway_service`` is ``settings.space_service_name``: the service the gateway reads contracts from."""
    if not service_name or not plan:
        return {"skipped": "SPACE_DEV_SERVICE_NAME and SPACE_DEV_PLAN must both be set"}
    reason = dev_service_guard(service_name, environ)
    if reason:
        return {"skipped": reason}
    if service_name != gateway_service:
        return {
            "skipped": "SPACE_DEV_SERVICE_NAME must equal SPACE_SERVICE_NAME (the service the gateway reads), "
            "or the seeded contracts would not be the ones the gateway uses"
        }
    try:
        env = load_env(environ, sphere=False)
    except ConfigError as exc:
        return {"skipped": f"SPACE configuration: {exc}"}
    space = SpaceRemote(env)
    try:
        return await ensure_space_contracts(
            users, space, service_name=service_name, plan=plan, version=environ.get("SPACE_DEV_PRICING_VERSION", "0.1.0")
        )
    finally:
        await space.aclose()


def main(argv: Sequence[str] | None = None, environ: Mapping[str, str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    source = os.environ if environ is None else environ
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.WARNING, format="%(levelname)s %(name)s: %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)
    password = source.get("DEMO_SEED_PASSWORD", "")
    if not password:
        print("DEMO_SEED_PASSWORD is required (there is no default)", file=sys.stderr)
        return EXIT_GUARD
    complaint = password_complaint(password)
    if complaint:
        print(f"DEMO_SEED_PASSWORD is unusable: {complaint}", file=sys.stderr)
        return EXIT_GUARD
    if "SCHEMAS_DIR" not in os.environ:
        for candidate in (Path("/app/schemas"), Path(__file__).resolve().parents[2] / "schemas"):
            if (candidate / "bim" / "v1").is_dir():
                os.environ["SCHEMAS_DIR"] = str(candidate)
                break
    try:
        return asyncio.run(_run(args, source, password))
    except Exception as exc:  # noqa: BLE001 - one redacted line, no traceback that could echo a credential
        print(Redactor([password]).error(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
