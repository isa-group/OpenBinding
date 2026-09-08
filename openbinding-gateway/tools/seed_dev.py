#!/usr/bin/env python3
"""Populate the OpenBinding database with rich development data.

Seeds users, hierarchical organizations, projects, BIM v1 cases,
collections, comparative studies with REAL solver jobs executed against
available engines (or gracefully handled), frozen reports, publications,
API keys, notifications, and audit records.

Usage:
    python tools/seed_dev.py [--reset] [--verbose]

Docker Compose:
    docker compose exec -T gateway-dev python tools/seed_dev.py [--reset]
"""

from __future__ import annotations

# ruff: noqa: E402

import argparse
import asyncio
import hashlib
import io
import json
import logging
import os
import sys
import uuid
import zipfile
from pathlib import Path

# Ensure openbinding_gateway is on sys.path
_gateway_root = Path(__file__).resolve().parents[1]
_src_dir = _gateway_root / "src"
if str(_src_dir) not in sys.path:
    sys.path.insert(0, str(_src_dir))

# Only append host virtualenv site-packages if running locally outside Docker
if not Path("/.dockerenv").exists() and str(_gateway_root) != "/app":
    py_ver = f"python{sys.version_info.major}.{sys.version_info.minor}"
    _host_sp = _gateway_root / ".venv" / "lib" / py_ver / "site-packages"
    if _host_sp.is_dir() and str(_host_sp) not in sys.path:
        sys.path.append(str(_host_sp))

# Configure schemas directory fallback if not set
def _find_schemas_dir() -> Path:
    candidates = [
        Path("/app/schemas"),
        Path(__file__).resolve().parents[2] / "schemas",
        Path(__file__).resolve().parents[1] / "schemas",
        Path.cwd() / "schemas",
        Path.cwd().parent / "schemas",
    ]
    for candidate in candidates:
        if candidate.is_dir() and (candidate / "bim" / "v1").is_dir():
            return candidate
    return Path(__file__).resolve().parents[2] / "schemas"

def _find_examples_dir() -> Path:
    candidates = [
        Path("/app/examples"),
        Path(__file__).resolve().parents[2] / "examples",
        Path(__file__).resolve().parents[1] / "examples",
        Path.cwd() / "examples",
        Path.cwd().parent / "examples",
    ]
    for candidate in candidates:
        if candidate.is_dir() and (candidate / "demo" / "01_simple_seq" / "instance.json").exists():
            return candidate
    for candidate in candidates:
        if candidate.is_dir():
            return candidate
    return Path(__file__).resolve().parents[2] / "examples"

schemas_dir = _find_schemas_dir()
if "SCHEMAS_DIR" not in os.environ and schemas_dir.is_dir():
    os.environ["SCHEMAS_DIR"] = str(schemas_dir)

from sqlalchemy import delete, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from openbinding_gateway import space_client
from openbinding_gateway.core.settings import Settings, get_settings
from openbinding_gateway.db import base as db_base
from openbinding_gateway.db.models import (
    ApiKey,
    EngineRegistrationRevision,
    EngineRevision,
    InstanceSnapshot,
    Job,
    JobState,
    User,
    UserRole,
    utcnow,
)
from openbinding_gateway.db.platform_models import (
    Artifact,
    AuditEvent,
    BindingCase,
    BindingCaseRevision,
    Collection,
    CollectionItem,
    CollectionRevision,
    Notification,
    Organization,
    OrganizationMembership,
    OrganizationRole,
    Project,
    ProjectResource,
    ProjectResourceRevision,
    Publication,
    Report,
    ReportState,
    RunState,
    Study,
    StudyCell,
    StudyRun,
    StudyState,
    Visibility,
)
from openbinding_gateway.models.platform import StudyDefinition
from openbinding_gateway.routes import v1 as routes_v1
from openbinding_gateway.security.apikeys import ADMIN_PERMISSIONS, ALL_PERMISSIONS, hash_key
from openbinding_gateway.security.passwords import hash_password
from openbinding_gateway.studies import aggregate_metrics, expand_study
from openbinding_gateway.study_jobs import StudyLaunchError, launch_study_cell
from openbinding_gateway.v1.canonical import digest
from openbinding_gateway.v1.package import InstancePackage, load_package

logger = logging.getLogger("seed_dev")

DEV_PASSWORD = "devpass123"


def _deterministic_zip(entries: list[tuple[str, bytes | str]]) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for filename, content in entries:
            info = zipfile.ZipInfo(filename, date_time=(2020, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = 0o644 << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, content)
    return buffer.getvalue()

# Seed users definition
SEED_USERS = [
    {"username": "admin", "email": "admin@example.org", "role": UserRole.ADMIN, "plan": "PRO", "key_suffix": "admin0001"},
    {"username": "alice", "email": "alice@example.org", "role": UserRole.USER, "plan": "RESEARCH", "key_suffix": "alice0001"},
    {"username": "bob", "email": "bob@example.org", "role": UserRole.USER, "plan": "PRO", "key_suffix": "bob000001"},
    {"username": "carol", "email": "carol@example.org", "role": UserRole.USER, "plan": "BASIC", "key_suffix": "carol0001"},
    {"username": "david", "email": "david@example.org", "role": UserRole.USER, "plan": "RESEARCH", "key_suffix": "david0001"},
    {"username": "elena", "email": "elena@example.org", "role": UserRole.USER, "plan": "ADVANCED", "key_suffix": "elena0001"},
    {"username": "frank", "email": "frank@example.org", "role": UserRole.USER, "plan": "BASIC", "key_suffix": "frank0001"},
]

# API key mapping
def dev_api_key(username: str, suffix: str) -> tuple[str, str, str]:
    prefix = f"obk_{suffix[:8]}"
    secret = f"devsecret_{username}_{suffix * 2}"
    full_key = f"{prefix}_{secret}"
    return full_key, prefix, hash_key(full_key)


async def clean_existing_data(session: AsyncSession) -> None:
    """Safely delete previously seeded entities in reverse foreign key order."""
    logger.info("Cleaning up previously seeded development entities...")
    usernames = [u["username"] for u in SEED_USERS]

    # Identify seeded users
    users = (
        await session.execute(select(User).where(User.username.in_(usernames)))
    ).scalars().all()
    user_ids = [u.id for u in users]

    # Identify seeded orgs
    org_slugs = ["score-group", "score-ai", "score-edge", "acme-corp", "acme-cloud"]
    orgs = (
        await session.execute(select(Organization).where(Organization.slug.in_(org_slugs)))
    ).scalars().all()
    org_ids = [o.id for o in orgs]

    # Identify seeded projects
    projects = (
        await session.execute(select(Project).where(Project.organization_id.in_(org_ids)))
    ).scalars().all() if org_ids else []
    project_ids = [p.id for p in projects]

    # Delete dependent publications, reports and artifacts
    if project_ids:
        await session.execute(delete(Artifact).where(Artifact.project_id.in_(project_ids)))
        await session.execute(delete(Publication).where(Publication.project_id.in_(project_ids)))
        await session.execute(delete(Report).where(Report.project_id.in_(project_ids)))

        # Studies, runs, cells
        studies = (
            await session.execute(select(Study).where(Study.project_id.in_(project_ids)))
        ).scalars().all()
        study_ids = [s.id for s in studies]
        if study_ids:
            runs = (
                await session.execute(select(StudyRun).where(StudyRun.study_id.in_(study_ids)))
            ).scalars().all()
            run_ids = [r.id for r in runs]
            if run_ids:
                await session.execute(delete(StudyCell).where(StudyCell.study_run_id.in_(run_ids)))
                await session.execute(delete(StudyRun).where(StudyRun.id.in_(run_ids)))
            await session.execute(delete(Study).where(Study.id.in_(study_ids)))

        # Collections
        collections = (
            await session.execute(select(Collection).where(Collection.project_id.in_(project_ids)))
        ).scalars().all()
        collection_ids = [c.id for c in collections]
        if collection_ids:
            col_revs = (
                await session.execute(select(CollectionRevision).where(CollectionRevision.collection_id.in_(collection_ids)))
            ).scalars().all()
            col_rev_ids = [cr.id for cr in col_revs]
            if col_rev_ids:
                await session.execute(delete(CollectionItem).where(CollectionItem.collection_revision_id.in_(col_rev_ids)))
                await session.execute(delete(CollectionRevision).where(CollectionRevision.id.in_(col_rev_ids)))
            await session.execute(delete(Collection).where(Collection.id.in_(collection_ids)))

        # Cases & Revisions
        cases = (
            await session.execute(select(BindingCase).where(BindingCase.project_id.in_(project_ids)))
        ).scalars().all()
        case_ids = [c.id for c in cases]
        if case_ids:
            await session.execute(delete(BindingCaseRevision).where(BindingCaseRevision.binding_case_id.in_(case_ids)))
            await session.execute(delete(BindingCase).where(BindingCase.id.in_(case_ids)))

        # Project Resources & Revisions
        resources = (
            await session.execute(select(ProjectResource).where(ProjectResource.project_id.in_(project_ids)))
        ).scalars().all()
        res_ids = [r.id for r in resources]
        if res_ids:
            await session.execute(delete(ProjectResourceRevision).where(ProjectResourceRevision.project_resource_id.in_(res_ids)))
            await session.execute(delete(ProjectResource).where(ProjectResource.id.in_(res_ids)))

    # Notifications & Audit
    if user_ids:
        await session.execute(delete(Notification).where(Notification.user_id.in_(user_ids)))
        await session.execute(delete(ApiKey).where(ApiKey.user_id.in_(user_ids)))
    if org_ids or user_ids:
        query = delete(AuditEvent)
        conditions = []
        if org_ids:
            conditions.append(AuditEvent.organization_id.in_(org_ids))
        if user_ids:
            conditions.append(AuditEvent.actor_id.in_(user_ids))
        await session.execute(query.where(or_(*conditions)))

    # Jobs & Snapshots
    if org_ids or user_ids:
        query = delete(Job)
        conds = []
        if org_ids:
            conds.append(Job.organization_id.in_(org_ids))
        if user_ids:
            conds.append(Job.billing_sponsor_user_id.in_(user_ids))
        await session.execute(query.where(or_(*conds)))
    if user_ids:
        await session.execute(delete(InstanceSnapshot).where(InstanceSnapshot.owner_id.in_(user_ids)))

    # Engine Revisions & Registration Revisions
    all_engine_names = [
        "minizinc-csp",
        "random-search",
        "many-heuristic",
        "evolutionary-heuristics",
    ]
    await session.execute(
        delete(EngineRegistrationRevision).where(
            EngineRegistrationRevision.name.in_(all_engine_names)
        )
    )
    await session.execute(
        delete(EngineRevision).where(
            EngineRevision.name.in_(all_engine_names)
        )
    )

    # Projects & Artifacts
    if org_ids:
        await session.execute(delete(Artifact).where(Artifact.organization_id.in_(org_ids)))
        await session.execute(delete(Project).where(Project.organization_id.in_(org_ids)))
        await session.execute(delete(OrganizationMembership).where(OrganizationMembership.organization_id.in_(org_ids)))

        # Delete sub-orgs first (where parent_id is not null)
        await session.execute(delete(Organization).where(Organization.id.in_(org_ids), Organization.parent_id.isnot(None)))
        # Then parent orgs
        await session.execute(delete(Organization).where(Organization.id.in_(org_ids)))

    # Seed non-admin users
    non_admin_usernames = [u["username"] for u in SEED_USERS if u["role"] != UserRole.ADMIN]
    non_admin_users = (
        await session.execute(select(User).where(User.username.in_(non_admin_usernames)))
    ).scalars().all()
    non_admin_ids = [u.id for u in non_admin_users]

    # Try removing SPACE contracts if SPACE is enabled
    try:
        settings = get_settings()
        if settings.space_enabled:
            gate = space_client.get_gate()
            for uid in non_admin_ids:
                try:
                    await gate.remove_contract(uid)
                except Exception:
                    pass
    except Exception:
        pass

    await session.execute(delete(User).where(User.username.in_(non_admin_usernames)))

    await session.commit()
    logger.info("Cleaned previous seed data.")


async def ensure_users(session: AsyncSession) -> dict[str, User]:
    """Create or update seed users with predictable passwords and API keys."""
    user_map: dict[str, User] = {}
    for entry in SEED_USERS:
        username = entry["username"]
        email = entry["email"]
        role = entry["role"]

        user = (
            await session.execute(select(User).where(User.username == username))
        ).scalars().first()

        plan = entry.get("plan", "BASIC")
        if user is None:
            user = User(
                username=username,
                email=email,
                password_hash=hash_password(DEV_PASSWORD),
                password_enabled=True,
                role=role,
                is_active=True,
                plan_cache=plan,
                contract_pending=False,
                preferences={"theme": "dark", "locale": "en"},
            )
            session.add(user)
            await session.flush()
            logger.info("Created user '%s' (%s, plan: %s)", username, role.value, plan)
        else:
            user.password_hash = hash_password(DEV_PASSWORD)
            user.role = role
            user.is_active = True
            user.plan_cache = plan
            user.contract_pending = False
            await session.flush()
            logger.info("Updated existing user '%s' (plan: %s)", username, plan)

        user_map[username] = user

        # Ensure API key
        full_key, prefix, s_hash = dev_api_key(username, entry["key_suffix"])
        key_record = (
            await session.execute(select(ApiKey).where(ApiKey.user_id == user.id, ApiKey.prefix == prefix))
        ).scalars().first()
        if user.is_admin or role == UserRole.ADMIN:
            dev_permissions = list(ALL_PERMISSIONS)
        else:
            dev_permissions = sorted(set(ALL_PERMISSIONS) - ADMIN_PERMISSIONS)
        key_grants = {"permissions": dev_permissions, "allEngines": True, "engines": []}
        if key_record is None:
            session.add(
                ApiKey(
                    user_id=user.id,
                    name=f"Dev Key for {username}",
                    prefix=prefix,
                    secret_hash=s_hash,
                    grants=key_grants,
                )
            )
            await session.flush()
            logger.info("Created API Key '%s' for user '%s'", prefix, username)
        else:
            key_record.grants = key_grants
            await session.flush()

    return user_map


async def resync_user_usage(session: AsyncSession, users: dict[str, User]) -> None:
    """Reconcile in-flight job concurrency with SPACE usage counters."""
    settings = get_settings()
    if not settings.space_enabled:
        return
    gate = space_client.get_gate()
    if not gate:
        return
    for username, user in users.items():
        try:
            in_flight = int(await session.scalar(
                select(func.count()).select_from(Job).where(
                    Job.owner_id == user.id,
                    Job.metered.is_(False),
                    Job.state.in_([JobState.QUEUED, JobState.RUNNING]),
                )
            ) or 0)
            snapshot = await gate.usage(user.id)
            limit_id = "concurrentJobs"
            recorded = snapshot.limits[limit_id].used if limit_id in snapshot.limits else 0.0
            drift = in_flight - recorded
            if drift:
                await gate.adjust_usage(user.id, {"concurrentJobs": drift})
                logger.info("Resynced concurrentJobs for '%s': drift=%s (in_flight=%d, recorded=%s)", username, drift, in_flight, recorded)
        except Exception as sync_err:
            logger.debug("Could not resync usage for '%s': %s", username, sync_err)


async def ensure_space_contracts(session: AsyncSession, users: dict[str, User]) -> None:
    """Ensure every seeded user has an active, valid contract in SPACE."""
    settings = get_settings()
    if not settings.space_enabled:
        logger.debug("SPACE is disabled in settings; skipping external contract provisioning.")
        return

    from openbinding_gateway.pricing_catalog import catalog_for_version
    from openbinding_gateway.access.contracts import live_pricing_version

    async def resolve_catalog(version: str):
        async with db_base.session_factory()() as catalog_session:
            return await catalog_for_version(catalog_session, settings, version)

    try:
        gate = space_client.build_gate(settings, catalog_resolver=resolve_catalog)
        space_client.set_gate(gate)
    except Exception as gate_err:
        logger.warning("Could not initialize pricing gate: %s", gate_err)
        return

    try:
        pricing_ver = await live_pricing_version(session)
    except Exception:
        pricing_ver = "0.1.1"

    for entry in SEED_USERS:
        username = entry["username"]
        user = users.get(username)
        if not user:
            continue
        plan = entry.get("plan", "BASIC")
        try:
            try:
                sub = await gate.subscription(user.id)
                logger.debug("User '%s' already has contract on plan %s", username, sub.plan)
            except Exception:
                # Contract does not exist in SPACE; create it
                await gate.create_contract(user.id, plan, user.email, pricing_ver)
                logger.info("Created SPACE contract for '%s' on plan '%s' (v%s)", username, plan, pricing_ver)
        except Exception as contract_err:
            logger.warning("Could not settle SPACE contract for '%s': %s", username, contract_err)
            user.contract_pending = True
            await session.flush()

    # Reconcile any in-flight concurrentJobs drift from previous runs
    await resync_user_usage(session, users)


async def ensure_engine_revisions(
    session: AsyncSession, admin_user: User
) -> list[EngineRevision]:
    """Seed immutable EngineRevisions and registered EngineRegistrationRevisions in database."""
    engines_seeded: list[EngineRevision] = []
    settings = get_settings()

    engine_configs = [
        ("minizinc-csp", settings.engine_minizinc_url or "http://engine-minizinc:3000"),
        ("random-search", settings.engine_random_search_url or "http://engine-random-search:8080"),
        ("many-heuristic", settings.engine_many_heuristic_url or "http://engine-many-heuristic:8080"),
        ("evolutionary-heuristics", settings.engine_evolutionary_heuristics_url or "http://engine-evolutionary-heuristics:8080"),
    ]

    for engine_name, default_endpoint in engine_configs:
        try:
            m = routes_v1._manifest(engine_name)
        except Exception:
            continue

        ns = m.get("metadata", {}).get("namespace", "bim.builtin")
        ver = m.get("metadata", {}).get("version", "1.0.0")
        manifest_digest = digest(m)

        rev = (
            await session.execute(
                select(EngineRevision).where(
                    EngineRevision.namespace == ns,
                    EngineRevision.name == engine_name,
                    EngineRevision.version == ver,
                )
            )
        ).scalars().first()

        if rev is None:
            rev = EngineRevision(
                owner_id=admin_user.id,
                namespace=ns,
                name=engine_name,
                version=ver,
                digest=manifest_digest,
                document=m,
                state="published",
            )
            session.add(rev)
            await session.flush()
            logger.info("Seeded EngineRevision '%s/%s@%s' (%s)", ns, engine_name, ver, manifest_digest[:18])

        engines_seeded.append(rev)

        reg = (
            await session.execute(
                select(EngineRegistrationRevision).where(
                    EngineRegistrationRevision.namespace == ns,
                    EngineRegistrationRevision.name == engine_name,
                    EngineRegistrationRevision.version == ver,
                )
            )
        ).scalars().first()

        if reg is None:
            reg_doc = {
                "schema": "bim/v1/engine-registration",
                "metadata": {
                    "namespace": ns,
                    "name": engine_name,
                    "version": ver,
                    "title": f"Production Federated {engine_name.title()} Engine",
                },
                "spec": {
                    "engine": {
                        "namespace": ns,
                        "name": engine_name,
                        "version": ver,
                        "digest": manifest_digest,
                    },
                    "transport": "http-json",
                    "endpoint": default_endpoint,
                },
            }
            sample_openapi = {
                "openapi": "3.1.0",
                "info": {"title": f"{engine_name} API", "version": ver},
                "paths": {"/v1/jobs": {"post": {"summary": "Submit solve job"}}},
            }
            reg = EngineRegistrationRevision(
                owner_id=admin_user.id,
                namespace=ns,
                name=engine_name,
                version=ver,
                manifest_digest=digest(reg_doc),
                engine_digest=manifest_digest,
                document=reg_doc,
                endpoint=default_endpoint,
                protocol_digest=routes_v1._protocol_digest(),
                openapi_document=sample_openapi,
                openapi_digest=digest(sample_openapi),
                mappings={"jobs": "/v1/jobs"},
                auth_scheme="none",
                verification_report={
                    "status": "verified",
                    "conformance": "passed",
                    "verifiedAt": utcnow().isoformat(),
                    "checks": {"protocol": "passed", "openapi": "passed", "connectivity": "ok"},
                },
                verified_at=utcnow(),
                published_at=utcnow(),
                publication_status="published",
                is_active=True,
            )
            session.add(reg)
            await session.flush()
            logger.info("Seeded EngineRegistrationRevision for '%s/%s@%s'", ns, engine_name, ver)

    await session.commit()
    return engines_seeded



async def ensure_organizations(session: AsyncSession, users: dict[str, User]) -> dict[str, Organization]:
    """Create root and sub-organizations with rich memberships."""
    org_map: dict[str, Organization] = {}

    alice = users["alice"]
    bob = users["bob"]
    carol = users["carol"]
    david = users["david"]
    elena = users["elena"]
    frank = users["frank"]

    # 1. SCORE Group (root)
    score_group = (
        await session.execute(select(Organization).where(Organization.slug == "score-group"))
    ).scalars().first()
    if score_group is None:
        score_group = Organization(
            slug="score-group",
            name="SCORE Research Group",
            parent_id=None,
            billing_sponsor_user_id=alice.id,
            created_by_id=alice.id,
        )
        session.add(score_group)
        await session.flush()
        logger.info("Created root organization 'score-group'")
    org_map["score-group"] = score_group

    # 2. SCORE AI (sub-org)
    score_ai = (
        await session.execute(select(Organization).where(Organization.slug == "score-ai"))
    ).scalars().first()
    if score_ai is None:
        score_ai = Organization(
            slug="score-ai",
            name="SCORE AI & Optimization Lab",
            parent_id=score_group.id,
            billing_sponsor_user_id=alice.id,
            created_by_id=alice.id,
        )
        session.add(score_ai)
        await session.flush()
        logger.info("Created sub-organization 'score-ai'")
    org_map["score-ai"] = score_ai

    # 3. SCORE Edge (sub-org)
    score_edge = (
        await session.execute(select(Organization).where(Organization.slug == "score-edge"))
    ).scalars().first()
    if score_edge is None:
        score_edge = Organization(
            slug="score-edge",
            name="SCORE Edge & Fog Systems",
            parent_id=score_group.id,
            billing_sponsor_user_id=alice.id,
            created_by_id=alice.id,
        )
        session.add(score_edge)
        await session.flush()
        logger.info("Created sub-organization 'score-edge'")
    org_map["score-edge"] = score_edge

    # 4. Acme Corp (root)
    acme_corp = (
        await session.execute(select(Organization).where(Organization.slug == "acme-corp"))
    ).scalars().first()
    if acme_corp is None:
        acme_corp = Organization(
            slug="acme-corp",
            name="Acme Corporation",
            parent_id=None,
            billing_sponsor_user_id=bob.id,
            created_by_id=bob.id,
        )
        session.add(acme_corp)
        await session.flush()
        logger.info("Created root organization 'acme-corp'")
    org_map["acme-corp"] = acme_corp

    # 5. Acme Cloud (sub-org)
    acme_cloud = (
        await session.execute(select(Organization).where(Organization.slug == "acme-cloud"))
    ).scalars().first()
    if acme_cloud is None:
        acme_cloud = Organization(
            slug="acme-cloud",
            name="Acme Cloud Infrastructure",
            parent_id=acme_corp.id,
            billing_sponsor_user_id=bob.id,
            created_by_id=bob.id,
        )
        session.add(acme_cloud)
        await session.flush()
        logger.info("Created sub-organization 'acme-cloud'")
    org_map["acme-cloud"] = acme_cloud

    # Memberships
    memberships = [
        # score-group
        (score_group.id, alice.id, OrganizationRole.OWNER),
        (score_group.id, bob.id, OrganizationRole.MEMBER),
        (score_group.id, carol.id, OrganizationRole.VIEWER),
        (score_group.id, david.id, OrganizationRole.ADMIN),
        # score-ai
        (score_ai.id, alice.id, OrganizationRole.OWNER),
        (score_ai.id, david.id, OrganizationRole.ADMIN),
        (score_ai.id, bob.id, OrganizationRole.MEMBER),
        (score_ai.id, frank.id, OrganizationRole.MEMBER),
        (score_ai.id, carol.id, OrganizationRole.VIEWER),
        # score-edge
        (score_edge.id, alice.id, OrganizationRole.OWNER),
        (score_edge.id, elena.id, OrganizationRole.ADMIN),
        (score_edge.id, frank.id, OrganizationRole.MEMBER),
        (score_edge.id, carol.id, OrganizationRole.VIEWER),
        # acme-corp
        (acme_corp.id, bob.id, OrganizationRole.OWNER),
        (acme_corp.id, elena.id, OrganizationRole.ADMIN),
        (acme_corp.id, alice.id, OrganizationRole.MEMBER),
        # acme-cloud
        (acme_cloud.id, bob.id, OrganizationRole.OWNER),
        (acme_cloud.id, elena.id, OrganizationRole.ADMIN),
        (acme_cloud.id, alice.id, OrganizationRole.MEMBER),
        (acme_cloud.id, frank.id, OrganizationRole.MEMBER),
    ]

    for org_id, u_id, role in memberships:
        existing = (
            await session.execute(
                select(OrganizationMembership).where(
                    OrganizationMembership.organization_id == org_id,
                    OrganizationMembership.user_id == u_id,
                )
            )
        ).scalars().first()
        if existing is None:
            session.add(OrganizationMembership(organization_id=org_id, user_id=u_id, role=role))
            await session.flush()

    return org_map


async def ensure_projects(
    session: AsyncSession, orgs: dict[str, Organization], users: dict[str, User]
) -> dict[str, Project]:
    """Create public and private projects across organizations."""
    projects_spec = [
        {
            "org": "score-ai",
            "slug": "qos-placement",
            "name": "QoS-Aware Multi-Cloud Placement Benchmark",
            "description": "Cross-engine QoS optimization benchmark suite evaluating exact and evolutionary solvers under diverse network and pricing constraints.",
            "visibility": Visibility.PUBLIC,
            "owner": "alice",
        },
        {
            "org": "score-ai",
            "slug": "smart-orchestration",
            "name": "Intelligent Workflow Orchestration",
            "description": "Predictive placement and dynamic task reallocation for enterprise AI workflows across hybrid cloud and on-premise clusters.",
            "visibility": Visibility.PRIVATE,
            "owner": "david",
        },
        {
            "org": "score-edge",
            "slug": "fog-latency-benchmark",
            "name": "Fog Computing Latency Benchmark",
            "description": "Ultra-low latency execution trade-offs for edge and fog node topologies under volatile bandwidth conditions.",
            "visibility": Visibility.PUBLIC,
            "owner": "elena",
        },
        {
            "org": "acme-cloud",
            "slug": "stock-trading-pipeline",
            "name": "Real-Time Stock Trading Pipeline",
            "description": "High-throughput, jitter-sensitive microservice binding optimization for financial market event processing pipelines.",
            "visibility": Visibility.PUBLIC,
            "owner": "bob",
        },
        {
            "org": "acme-cloud",
            "slug": "resilient-data-mesh",
            "name": "Resilient Enterprise Data Mesh",
            "description": "Data governance and multi-zone replica binding with strict regulatory residency constraints.",
            "visibility": Visibility.PRIVATE,
            "owner": "elena",
        },
    ]

    project_map: dict[str, Project] = {}
    for spec in projects_spec:
        org = orgs[spec["org"]]
        owner = users[spec["owner"]]
        slug = spec["slug"]

        project = (
            await session.execute(
                select(Project).where(Project.organization_id == org.id, Project.slug == slug)
            )
        ).scalars().first()

        if project is None:
            project = Project(
                organization_id=org.id,
                slug=slug,
                name=spec["name"],
                description=spec["description"],
                visibility=spec["visibility"],
                created_by_id=owner.id,
            )
            session.add(project)
            await session.flush()
            logger.info("Created project '%s/%s'", org.slug, slug)
        project_map[f"{spec['org']}/{slug}"] = project

    return project_map


async def load_and_persist_snapshots(
    session: AsyncSession, user: User, examples_dir: Path
) -> dict[str, tuple[InstancePackage, InstanceSnapshot]]:
    """Compile BIM v1 packages from examples and persist executable InstanceSnapshots."""
    results: dict[str, tuple[InstancePackage, InstanceSnapshot]] = {}

    samples = [
        ("01_simple_seq", examples_dir / "demo" / "01_simple_seq"),
        ("02_parallel", examples_dir / "demo" / "02_parallel"),
        ("05_multi_obj", examples_dir / "demo" / "05_multi_obj"),
    ]

    for name, path in samples:
        if not (path / "instance.json").exists():
            logger.warning("Example path '%s' does not exist; skipping snapshot compilation", path)
            continue
        try:
            package = load_package(path)
            problem = await routes_v1._compile_resolved(package, session)
            snapshot_id_str = await routes_v1._persist_snapshot(package, problem, user, session)
            if not snapshot_id_str:
                continue
            snapshot = await session.get(InstanceSnapshot, uuid.UUID(snapshot_id_str))
            if snapshot:
                results[name] = (package, snapshot)
                logger.info("Compiled & persisted snapshot for '%s' (id: %s)", name, snapshot.id)
        except Exception as exc:
            logger.exception("Failed to compile example '%s': %s", name, exc)

    return results


async def ensure_cases_and_collections(
    session: AsyncSession,
    project: Project,
    user: User,
    snapshots: dict[str, tuple[InstancePackage, InstanceSnapshot]],
) -> dict[str, tuple[BindingCase, BindingCaseRevision]]:
    """Create binding cases, revisions, and benchmark collections."""
    case_map: dict[str, tuple[BindingCase, BindingCaseRevision]] = {}

    case_defs = [
        ("simple-seq", "Sequential Service Workflow", "Sequential pipeline with strict latency bounds", "01_simple_seq"),
        ("parallel-mesh", "Parallel Fork-Join Mesh", "Parallel branch orchestration with concurrent synchronization", "02_parallel"),
        ("multi-objective", "Multi-Objective Pareto Case", "Cost vs latency vs availability trade-off problem", "05_multi_obj"),
    ]

    for slug, name, desc, sample_key in case_defs:
        if sample_key not in snapshots:
            continue
        package, snapshot = snapshots[sample_key]

        case = (
            await session.execute(
                select(BindingCase).where(BindingCase.project_id == project.id, BindingCase.slug == slug)
            )
        ).scalars().first()

        if case is None:
            case = BindingCase(
                project_id=project.id,
                slug=slug,
                name=name,
                description=desc,
                created_by_id=user.id,
            )
            session.add(case)
            await session.flush()
            logger.info("Created BindingCase '%s'", slug)

        doc = package.json("instance.json")
        doc_digest = digest(doc)

        revision = (
            await session.execute(
                select(BindingCaseRevision).where(
                    BindingCaseRevision.binding_case_id == case.id,
                    BindingCaseRevision.digest == doc_digest,
                )
            )
        ).scalars().first()

        if revision is None:
            revision = BindingCaseRevision(
                binding_case_id=case.id,
                revision=1,
                digest=doc_digest,
                document=doc,
                source_snapshot_id=snapshot.id,
                created_by_id=user.id,
            )
            session.add(revision)
            await session.flush()
            logger.info("Created BindingCaseRevision #1 for '%s'", slug)

        case_map[slug] = (case, revision)

        if slug == "simple-seq":
            import copy
            doc_v2 = copy.deepcopy(doc)
            if "metadata" not in doc_v2:
                doc_v2["metadata"] = {}
            doc_v2["metadata"]["revision"] = 2
            doc_v2["metadata"]["description"] = "Sequential pipeline with strict latency bounds (r2 with tightened budget)"
            doc_v2_digest = digest(doc_v2)
            rev_2 = (
                await session.execute(
                    select(BindingCaseRevision).where(
                        BindingCaseRevision.binding_case_id == case.id,
                        BindingCaseRevision.revision == 2,
                    )
                )
            ).scalars().first()
            if rev_2 is None:
                rev_2 = BindingCaseRevision(
                    binding_case_id=case.id,
                    revision=2,
                    digest=doc_v2_digest,
                    document=doc_v2,
                    source_snapshot_id=snapshot.id,
                    created_by_id=user.id,
                )
                session.add(rev_2)
                await session.flush()
                logger.info("Created BindingCaseRevision #2 for '%s'", slug)

    # Curated Collections
    if "simple-seq" in case_map and "parallel-mesh" in case_map:
        c_slug = "standard-benchmarks"
        collection = (
            await session.execute(
                select(Collection).where(Collection.project_id == project.id, Collection.slug == c_slug)
            )
        ).scalars().first()
        if collection is None:
            collection = Collection(
                project_id=project.id,
                slug=c_slug,
                name="Standard BIM v1 Benchmark Suite",
                description="Authoritative suite of basic control flow structures: sequential and parallel.",
                created_by_id=user.id,
            )
            session.add(collection)
            await session.flush()

            col_rev = CollectionRevision(
                collection_id=collection.id,
                revision=1,
                digest=digest([case_map["simple-seq"][1].digest, case_map["parallel-mesh"][1].digest]),
                created_by_id=user.id,
            )
            session.add(col_rev)
            await session.flush()

            for pos, (key, (_, rev)) in enumerate([("simple-seq", case_map["simple-seq"]), ("parallel-mesh", case_map["parallel-mesh"])]):
                session.add(
                    CollectionItem(
                        collection_revision_id=col_rev.id,
                        position=pos,
                        target_kind="case",
                        target_digest=rev.digest,
                        target_ref={"slug": key, "revision": rev.revision},
                        added_by_id=user.id,
                    )
                )
            await session.flush()
            logger.info("Created Collection '%s' with 2 items", c_slug)

            # Collection Revision 2
            col_rev_2 = (
                await session.execute(
                    select(CollectionRevision).where(
                        CollectionRevision.collection_id == collection.id,
                        CollectionRevision.revision == 2,
                    )
                )
            ).scalars().first()
            if col_rev_2 is None:
                rev2_target = rev_2 if 'rev_2' in locals() else case_map["simple-seq"][1]
                col_rev_2 = CollectionRevision(
                    collection_id=collection.id,
                    revision=2,
                    digest=digest([case_map["simple-seq"][1].digest, rev2_target.digest, case_map["parallel-mesh"][1].digest]),
                    created_by_id=user.id,
                )
                session.add(col_rev_2)
                await session.flush()
                items_r2 = [
                    (0, "simple-seq", case_map["simple-seq"][1]),
                    (1, "simple-seq", rev2_target),
                    (2, "parallel-mesh", case_map["parallel-mesh"][1]),
                ]
                for pos, key, r in items_r2:
                    session.add(
                        CollectionItem(
                            collection_revision_id=col_rev_2.id,
                            position=pos,
                            target_kind="case",
                            target_digest=r.digest,
                            target_ref={"slug": key, "revision": r.revision},
                            added_by_id=user.id,
                        )
                    )
                await session.flush()
                logger.info("Created CollectionRevision #2 for '%s'", c_slug)

    return case_map


async def ensure_project_resources(
    session: AsyncSession,
    project_map: dict[str, Project],
    users: dict[str, User],
) -> dict[str, tuple[ProjectResource, list[ProjectResourceRevision]]]:
    """Seed reusable project resources (candidate catalogs, constraints, optimization profiles) with immutable revisions."""
    alice = users["alice"]
    bob = users["bob"]
    qos_project = project_map.get("score-ai/qos-placement")
    fog_project = project_map.get("score-edge/fog-latency-benchmark")
    stock_project = project_map.get("acme-cloud/stock-trading-pipeline")

    resource_specs = []

    if qos_project:
        # Resource 1: Candidate Catalog with 2 revisions
        doc_catalog_v1 = {
            "apiVersion": "qos-binding/v1",
            "kind": "CandidateCatalog",
            "metadata": {
                "name": "standard-cloud-candidates-v1",
                "project": "qos-placement",
            },
            "spec": {
                "candidates": {
                    "aws-us-east-1a": {
                        "provides": "service/compute",
                        "provider": "AWS",
                        "region": "us-east-1",
                        "metrics": {"cost_per_hour": 0.096, "latency_ms": 12.0, "availability": 0.9995},
                    },
                    "gcp-us-central1": {
                        "provides": "service/compute",
                        "provider": "GCP",
                        "region": "us-central1",
                        "metrics": {"cost_per_hour": 0.088, "latency_ms": 18.0, "availability": 0.999},
                    },
                    "azure-eastus": {
                        "provides": "service/compute",
                        "provider": "Azure",
                        "region": "eastus",
                        "metrics": {"cost_per_hour": 0.092, "latency_ms": 15.0, "availability": 0.9992},
                    },
                    "aws-rds-postgres": {
                        "provides": "service/database",
                        "provider": "AWS",
                        "region": "us-east-1",
                        "metrics": {"cost_per_hour": 0.25, "latency_ms": 8.0, "availability": 0.9999},
                    },
                },
                "metricBindings": {
                    "cost": {"resource": "application", "id": "cost"},
                    "latency": {"resource": "application", "id": "latency"},
                },
            },
        }
        doc_catalog_v2 = {
            **doc_catalog_v1,
            "metadata": {"name": "standard-cloud-candidates-v2", "project": "qos-placement"},
            "spec": {
                **doc_catalog_v1["spec"],
                "candidates": {
                    **doc_catalog_v1["spec"]["candidates"],
                    "cloudflare-edge-worker": {
                        "provides": "service/edge-compute",
                        "provider": "Cloudflare",
                        "region": "global-anycast",
                        "metrics": {"cost_per_hour": 0.050, "latency_ms": 4.5, "availability": 0.9999},
                    },
                },
            },
        }

        # Resource 2: Latency SLA Constraints
        doc_constraints_v1 = {
            "apiVersion": "qos-binding/v1",
            "kind": "ConstraintSet",
            "metadata": {"name": "sla-latency-constraints-v1", "project": "qos-placement"},
            "spec": {
                "rules": [
                    {"id": "max-total-latency", "type": "upper_bound", "metric": "latency", "threshold": 150.0},
                    {"id": "min-availability", "type": "lower_bound", "metric": "availability", "threshold": 0.999},
                    {"id": "max-hourly-budget", "type": "upper_bound", "metric": "cost", "threshold": 2.50},
                ]
            },
        }

        # Resource 3: Multi-objective Optimization Weights
        doc_opt_v1 = {
            "apiVersion": "qos-binding/v1",
            "kind": "Optimization",
            "metadata": {"name": "balanced-cost-latency-weights-v1", "project": "qos-placement"},
            "spec": {
                "mode": "weighted",
                "terms": [
                    {"metric": {"resource": "application", "id": "cost"}, "weight": 0.6, "normalize": {"min": 0.0, "max": 10.0}},
                    {"metric": {"resource": "application", "id": "latency"}, "weight": 0.4, "normalize": {"min": 0.0, "max": 500.0}},
                ],
            },
        }

        resource_specs.extend([
            (qos_project, "standard-candidate-catalog", "Standard QoS Cloud Candidate Catalog", "Multi-cloud service offerings (AWS, GCP, Azure, Cloudflare) annotated with latency, cost, and availability metrics.", "CandidateCatalog", [doc_catalog_v1, doc_catalog_v2], alice),
            (qos_project, "sla-latency-constraints", "High-Priority SLA Latency Constraint Set", "Enforces upper-bound end-to-end response times, hourly budget ceilings, and 99.9% availability.", "ConstraintSet", [doc_constraints_v1], alice),
            (qos_project, "balanced-cost-latency-weights", "Balanced Cost vs Latency Optimization Profile", "Scalarization parameters and Pareto tradeoff weights (60% cost / 40% latency) for multi-objective solvers.", "Optimization", [doc_opt_v1], alice),
        ])

    if fog_project:
        doc_fog_topology = {
            "apiVersion": "qos-binding/v1",
            "kind": "RoutingOverlay",
            "metadata": {"name": "fog-topology-v1", "project": "fog-latency-benchmark"},
            "spec": {
                "nodes": ["edge-sensor-alpha", "fog-cluster-gateway", "central-cloud-hub"],
                "links": [
                    {"from": "edge-sensor-alpha", "to": "fog-cluster-gateway", "latency_ms": 3.2, "bandwidth_mbps": 1000},
                    {"from": "fog-cluster-gateway", "to": "central-cloud-hub", "latency_ms": 28.5, "bandwidth_mbps": 10000},
                ],
            },
        }
        resource_specs.append(
            (fog_project, "fog-node-topology", "Fog Infrastructure Topology Map", "Hierarchical mesh network graph defining propagation delays and bandwidth capacities between fog gateways and edge sensors.", "RoutingOverlay", [doc_fog_topology], alice)
        )

    if stock_project:
        doc_stock_catalog = {
            "apiVersion": "qos-binding/v1",
            "kind": "CandidateCatalog",
            "metadata": {"name": "financial-order-routing-v1", "project": "stock-trading-pipeline"},
            "spec": {
                "candidates": {
                    "nyse-mah-colo": {
                        "provides": "venue/equities",
                        "provider": "Equinix-NY4",
                        "metrics": {"tick_to_trade_us": 12.5, "jitter_us": 0.8, "cost_tier": "premium"},
                    },
                    "nasdaq-car-colo": {
                        "provides": "venue/equities",
                        "provider": "Equinix-NY11",
                        "metrics": {"tick_to_trade_us": 14.2, "jitter_us": 1.1, "cost_tier": "standard"},
                    },
                },
            },
        }
        resource_specs.append(
            (stock_project, "financial-order-routing-catalog", "Ultra-Low Latency Exchange Candidate Catalog", "Colocated trading venue endpoints (NYSE, NASDAQ) with deterministic sub-millisecond execution constraints.", "CandidateCatalog", [doc_stock_catalog], bob)
        )

    created_map: dict[str, tuple[ProjectResource, list[ProjectResourceRevision]]] = {}

    for proj, slug, name, desc, kind, doc_list, author in resource_specs:
        resource = (
            await session.execute(
                select(ProjectResource).where(
                    ProjectResource.project_id == proj.id,
                    ProjectResource.slug == slug,
                )
            )
        ).scalars().first()

        if resource is None:
            resource = ProjectResource(
                project_id=proj.id,
                slug=slug,
                name=name,
                description=desc,
                kind=kind,
                created_by_id=author.id,
            )
            session.add(resource)
            await session.flush()
            logger.info("Created ProjectResource '%s' (%s) in '%s'", slug, kind, proj.slug)

        revisions: list[ProjectResourceRevision] = []
        for idx, doc in enumerate(doc_list, start=1):
            doc_digest = digest(doc)
            rev = (
                await session.execute(
                    select(ProjectResourceRevision).where(
                        ProjectResourceRevision.project_resource_id == resource.id,
                        ProjectResourceRevision.digest == doc_digest,
                    )
                )
            ).scalars().first()

            if rev is None:
                rev = ProjectResourceRevision(
                    project_resource_id=resource.id,
                    revision=idx,
                    digest=doc_digest,
                    document=doc,
                    created_by_id=author.id,
                )
                session.add(rev)
                await session.flush()
                logger.info("  Attached Revision r%d (%s) to '%s'", idx, doc_digest[:18], slug)
            revisions.append(rev)

        created_map[f"{proj.slug}/{slug}"] = (resource, revisions)

    await session.commit()
    return created_map


async def execute_real_studies(
    session: AsyncSession,
    org: Organization,
    project: Project,
    user: User,
    case_map: dict[str, tuple[BindingCase, BindingCaseRevision]],
) -> list[tuple[Study, StudyRun]]:
    """Create comparative studies, dispatch cells, and execute solve jobs."""
    from openbinding_gateway.job_dispatch import _execute

    # Resolve engine manifests
    engine_refs = []
    for engine_name in ["minizinc-csp", "random-search"]:
        try:
            m = routes_v1._manifest(engine_name)
            ref = {
                "namespace": m.get("metadata", {}).get("namespace", "bim.builtin"),
                "name": engine_name,
                "version": m.get("metadata", {}).get("version", "1.0.0"),
                "digest": digest(m),
            }
            engine_refs.append(ref)
        except Exception as exc:
            logger.warning("Engine '%s' manifest could not be resolved: %s", engine_name, exc)

    if not engine_refs:
        logger.error("No valid engines found for study execution!")
        return []

    executed_studies: list[tuple[Study, StudyRun]] = []

    # STUDY 1: Exact vs Heuristic
    if "simple-seq" in case_map:
        study_slug = "exact-vs-heuristic"
        study = (
            await session.execute(
                select(Study).where(Study.project_id == project.id, Study.slug == study_slug)
            )
        ).scalars().first()

        _, rev = case_map["simple-seq"]
        study_def = StudyDefinition(
            case_revision_ids=[rev.id],
            engines=engine_refs,
            parameter_sets=[{"time_budget_ms": 5000}],
            seeds=[42, 101],
        )

        if study is None:
            study = Study(
                project_id=project.id,
                slug=study_slug,
                name="Exact MiniZinc vs Seeded Random Search Benchmark",
                description="Comparative study quantifying optimality, runtime and convergence between exact CP and heuristic random search.",
                definition=study_def.model_dump(mode="json"),
                state=StudyState.READY,
                created_by_id=user.id,
            )
            session.add(study)
            await session.flush()
            logger.info("Created Study '%s'", study_slug)
        else:
            study.definition = study_def.model_dump(mode="json")
            await session.flush()

        # Run 1: Launch and execute cells
        existing_run = (
            await session.execute(
                select(StudyRun).where(StudyRun.study_id == study.id, StudyRun.run_number == 1)
            )
        ).scalars().first()

        if existing_run is None:
            expanded = expand_study(study_def)
            matrix_digest = digest([cell["fingerprint"] for cell in expanded])
            run = StudyRun(
                study_id=study.id,
                run_number=1,
                state=RunState.QUEUED,
                matrix_digest=matrix_digest,
                summary={"cells": len(expanded)},
                created_by_id=user.id,
            )
            session.add(run)
            await session.flush()

            cells: list[StudyCell] = []
            for item in expanded:
                cell = StudyCell(
                    study_run_id=run.id,
                    ordinal=item["ordinal"],
                    binding_case_revision_id=uuid.UUID(item["caseRevisionId"]),
                    engine_ref=item["engine"],
                    parameters=item["parameters"],
                    seed=item["seed"],
                    fingerprint=item["fingerprint"],
                    state=RunState.QUEUED,
                )
                session.add(cell)
                cells.append(cell)
            await session.flush()

            logger.info("Launching %d study cells for '%s'...", len(cells), study_slug)
            for cell in cells:
                try:
                    job = await launch_study_cell(session, cell, user, org, project.id)
                    await session.commit()

                    # Execute the persisted job
                    logger.info("Executing job %s for cell ordinal %d...", job.id, cell.ordinal)
                    try:
                        await _execute(str(job.id))
                        await session.refresh(cell)
                        logger.info("Job %s executed: state=%s", job.id, cell.state.value)
                    except Exception as exec_err:
                        logger.warning("Real execution for job %s encountered: %s", job.id, exec_err)

                    # Refresh to obtain genuine solver results propagated from job sync
                    await session.refresh(cell)
                    logger.info("Job %s result for cell %d: state=%s, metrics=%s", job.id, cell.ordinal, cell.state.value, cell.metrics)
                except StudyLaunchError as exc:
                    logger.warning("Study cell launch error: %s", exc)
                    cell.state = RunState.FAILED
                    cell.metrics = {"status": "failed", "code": exc.code, "detail": exc.detail}
                    await session.commit()

            # Refresh and aggregate run summary
            refreshed_cells = (
                await session.execute(
                    select(StudyCell).where(StudyCell.study_run_id == run.id).order_by(StudyCell.ordinal)
                )
            ).scalars().all()

            cell_metrics = [c.metrics for c in refreshed_cells if c.metrics]
            if cell_metrics:
                run.summary = aggregate_metrics(cell_metrics)
                terminal = {RunState.COMPLETED, RunState.FAILED, RunState.CANCELLED}
                if all(c.state in terminal for c in refreshed_cells):
                    run.state = (
                        RunState.COMPLETED
                        if all(c.state is RunState.COMPLETED for c in refreshed_cells)
                        else RunState.PARTIAL
                    )
                    run.finished_at = utcnow()
                await session.commit()
                logger.info("StudyRun #1 finished with state: %s", run.state.value)

            executed_studies.append((study, run))
        else:
            executed_studies.append((study, existing_run))

        # Run 2: In-progress / Queued run
        existing_run_2 = (
            await session.execute(
                select(StudyRun).where(StudyRun.study_id == study.id, StudyRun.run_number == 2)
            )
        ).scalars().first()
        if existing_run_2 is None:
            expanded = expand_study(study_def)
            run2 = StudyRun(
                study_id=study.id,
                run_number=2,
                state=RunState.RUNNING,
                matrix_digest=digest([c["fingerprint"] for c in expanded]),
                summary={"cells": len(expanded), "completed": 1, "running": 1, "queued": len(expanded) - 2},
                created_by_id=user.id,
            )
            session.add(run2)
            await session.flush()
            for idx, item in enumerate(expanded):
                st = RunState.COMPLETED if idx == 0 else (RunState.RUNNING if idx == 1 else RunState.QUEUED)
                m = {"status": "completed", "feasible": True, "runtimeSeconds": 0.42} if idx == 0 else {}
                session.add(
                    StudyCell(
                        study_run_id=run2.id,
                        ordinal=item["ordinal"],
                        binding_case_revision_id=uuid.UUID(item["caseRevisionId"]),
                        engine_ref=item["engine"],
                        parameters=item["parameters"],
                        seed=item["seed"],
                        fingerprint=item["fingerprint"] + "-run2",
                        state=st,
                        metrics=m,
                    )
                )
            await session.commit()
            logger.info("Created in-progress StudyRun #2 for '%s'", study_slug)

        # Run 3: Run with a retryable failed cell
        existing_run_3 = (
            await session.execute(
                select(StudyRun).where(StudyRun.study_id == study.id, StudyRun.run_number == 3)
            )
        ).scalars().first()
        if existing_run_3 is None:
            expanded = expand_study(study_def)
            run3 = StudyRun(
                study_id=study.id,
                run_number=3,
                state=RunState.PARTIAL,
                matrix_digest=digest([c["fingerprint"] + "-run3" for c in expanded]),
                summary={"cells": len(expanded), "completed": len(expanded) - 1, "failed": 1},
                created_by_id=user.id,
            )
            session.add(run3)
            await session.flush()
            for idx, item in enumerate(expanded):
                if idx == 0:
                    st = RunState.FAILED
                    m = {
                        "status": "failed",
                        "code": "timeout_or_solver_memory_limit",
                        "detail": "Transient solver memory limit exceeded during search phase. Cell is eligible for retry.",
                        "feasible": False,
                    }
                else:
                    st = RunState.COMPLETED
                    m = {
                        "status": "completed",
                        "feasible": True,
                        "termination": "OPTIMAL",
                        "objectives": {"cost": 41.2 + idx * 3, "latency": 105.0 - idx * 5},
                        "runtimeSeconds": 0.45 + idx * 0.1,
                    }
                session.add(
                    StudyCell(
                        study_run_id=run3.id,
                        ordinal=item["ordinal"],
                        binding_case_revision_id=uuid.UUID(item["caseRevisionId"]),
                        engine_ref=item["engine"],
                        parameters=item["parameters"],
                        seed=item["seed"],
                        fingerprint=item["fingerprint"] + "-run3",
                        state=st,
                        metrics=m,
                    )
                )
            await session.commit()
            logger.info("Created StudyRun #3 (with retryable failed cell) for '%s'", study_slug)

    # STUDY 2: Parallel Scalability Study
    if "parallel-mesh" in case_map:
        study2_slug = "parallel-scaling-study"
        _, rev = case_map["parallel-mesh"]
        study2_def = StudyDefinition(
            case_revision_ids=[rev.id],
            engines=engine_refs[:1],
            parameter_sets=[{"time_budget_ms": 3000}, {"time_budget_ms": 8000}],
            seeds=[7, 99],
        )
        study2 = (
            await session.execute(
                select(Study).where(Study.project_id == project.id, Study.slug == study2_slug)
            )
        ).scalars().first()
        if study2 is None:
            study2 = Study(
                project_id=project.id,
                slug=study2_slug,
                name="Parallel Workflow Scalability Study",
                description="Exploration of synchronization and aggregated QoS costs in parallel mesh topologies.",
                definition=study2_def.model_dump(mode="json"),
                state=StudyState.READY,
                created_by_id=user.id,
            )
            session.add(study2)
            await session.flush()

            # Execute run 1
            expanded = expand_study(study2_def)
            run_p = StudyRun(
                study_id=study2.id,
                run_number=1,
                state=RunState.QUEUED,
                matrix_digest=digest([c["fingerprint"] for c in expanded]),
                summary={"cells": len(expanded)},
                created_by_id=user.id,
            )
            session.add(run_p)
            await session.flush()
            for item in expanded:
                c = StudyCell(
                    study_run_id=run_p.id,
                    ordinal=item["ordinal"],
                    binding_case_revision_id=uuid.UUID(item["caseRevisionId"]),
                    engine_ref=item["engine"],
                    parameters=item["parameters"],
                    seed=item["seed"],
                    fingerprint=item["fingerprint"],
                    state=RunState.QUEUED,
                )
                session.add(c)
                await session.flush()
                try:
                    j = await launch_study_cell(session, c, user, org, project.id)
                    await session.commit()
                    try:
                        await _execute(str(j.id))
                    except Exception:
                        pass
                except Exception:
                    pass
            # Refresh and aggregate Study 2 summary
            refreshed_c2 = (
                await session.execute(
                    select(StudyCell).where(StudyCell.study_run_id == run_p.id).order_by(StudyCell.ordinal)
                )
            ).scalars().all()
            c2_metrics = [c.metrics for c in refreshed_c2 if c.metrics]
            if c2_metrics:
                run_p.summary = aggregate_metrics(c2_metrics)
                terminal = {RunState.COMPLETED, RunState.FAILED, RunState.CANCELLED}
                if all(c.state in terminal for c in refreshed_c2):
                    run_p.state = (
                        RunState.COMPLETED
                        if all(c.state is RunState.COMPLETED for c in refreshed_c2)
                        else RunState.PARTIAL
                    )
                    run_p.finished_at = utcnow()
                await session.commit()
            executed_studies.append((study2, run_p))
            logger.info("Executed Parallel Scalability Study run (state=%s)", run_p.state.value)
        else:
            study2.definition = study2_def.model_dump(mode="json")
            await session.flush()
            existing_run_p = (
                await session.execute(
                    select(StudyRun).where(StudyRun.study_id == study2.id, StudyRun.run_number == 1)
                )
            ).scalars().first()
            if existing_run_p:
                executed_studies.append((study2, existing_run_p))

    return executed_studies


async def ensure_standalone_jobs(
    session: AsyncSession,
    org: Organization,
    project: Project,
    user: User,
    snapshots: dict[str, InstanceSnapshot] | None = None,
    all_states: bool = False,
) -> list[Job]:
    """Create standalone solve jobs in the jobs table for testing workbench and admin listings."""
    from openbinding_gateway.job_dispatch import _execute
    from openbinding_gateway.study_jobs import _job_request, _response_payload

    jobs: list[Job] = []
    existing = (await session.execute(select(Job).where(Job.project_id == project.id, Job.state == JobState.COMPLETED))).scalars().first()
    if existing is not None:
        return [existing]

    snap = None
    if snapshots:
        snap = snapshots.get("01_simple_seq") or snapshots.get("simple-seq")
        if not snap and len(snapshots) > 0:
            snap = next(iter(snapshots.values()))

    if snap is not None:
        # 1. Execute genuine MiniZinc solve job against the live engine container
        try:
            m_mzn = routes_v1._manifest("minizinc-csp")
            payload1 = {
                "snapshot": snap.id,
                "engine": {
                    "namespace": m_mzn.get("metadata", {}).get("namespace", "bim.builtin"),
                    "name": "minizinc-csp",
                    "version": m_mzn.get("metadata", {}).get("version", "1.0.0"),
                    "digest": digest(m_mzn),
                },
                "mode": "exact-weighted",
                "options": {"time_budget_ms": 10000, "solver": "gecode"},
            }
            resp1 = _response_payload(await routes_v1.create_job(_job_request(payload1), caller=user, session=session))
            job1 = await session.get(Job, uuid.UUID(str(resp1["id"])))
            if job1:
                job1.organization_id = org.id
                job1.project_id = project.id
                job1.billing_sponsor_user_id = org.billing_sponsor_user_id
                await session.commit()
                await _execute(str(job1.id))
                await session.refresh(job1)
                jobs.append(job1)
                logger.info("Executed genuine MiniZinc job %s: state=%s, termination=%s", job1.id, job1.state.value, job1.termination)
        except Exception as exc:
            logger.warning("Could not execute live MiniZinc job: %s", exc)

        # 2. Running job (Random Search)
        try:
            m_rs = routes_v1._manifest("random-search")
            payload2 = {
                "snapshot": snap.id,
                "engine": {
                    "namespace": m_rs.get("metadata", {}).get("namespace", "bim.builtin"),
                    "name": "random-search",
                    "version": m_rs.get("metadata", {}).get("version", "1.0.0"),
                    "digest": digest(m_rs),
                },
                "mode": "seeded",
                "options": {"iterations": 10000, "seed": 42},
            }
            resp2 = _response_payload(await routes_v1.create_job(_job_request(payload2), caller=user, session=session))
            job2 = await session.get(Job, uuid.UUID(str(resp2["id"])))
            if job2:
                job2.organization_id = org.id
                job2.project_id = project.id
                job2.billing_sponsor_user_id = org.billing_sponsor_user_id
                job2.state = JobState.RUNNING
                job2.result = {
                    "logs": "[INFO] Random Search solver active on engine-random-search:8080. Iteration 450/10000...",
                }
                await session.commit()
                jobs.append(job2)
        except Exception as exc:
            logger.warning("Could not create running Random Search job: %s", exc)

        if all_states:
            # 3. Queued job
            try:
                m_mzn = routes_v1._manifest("minizinc-csp")
                payload3 = {
                    "snapshot": snap.id,
                    "engine": {
                        "namespace": m_mzn.get("metadata", {}).get("namespace", "bim.builtin"),
                        "name": "minizinc-csp",
                        "version": m_mzn.get("metadata", {}).get("version", "1.0.0"),
                        "digest": digest(m_mzn),
                    },
                    "mode": "exact-weighted",
                    "options": {"time_budget_ms": 15000, "solver": "gecode"},
                }
                resp3 = _response_payload(await routes_v1.create_job(_job_request(payload3), caller=user, session=session))
                job3 = await session.get(Job, uuid.UUID(str(resp3["id"])))
                if job3:
                    job3.organization_id = org.id
                    job3.project_id = project.id
                    job3.billing_sponsor_user_id = org.billing_sponsor_user_id
                    job3.state = JobState.QUEUED
                    job3.result = {"logs": "[INFO] Job enqueued in durable scheduler waiting for worker allocation..."}
                    await session.commit()
                    jobs.append(job3)
            except Exception as exc:
                logger.warning("Could not create queued job: %s", exc)

            # 4. Failed job
            try:
                m_rs = routes_v1._manifest("random-search")
                payload4 = {
                    "snapshot": snap.id,
                    "engine": {
                        "namespace": m_rs.get("metadata", {}).get("namespace", "bim.builtin"),
                        "name": "random-search",
                        "version": m_rs.get("metadata", {}).get("version", "1.0.0"),
                        "digest": digest(m_rs),
                    },
                    "mode": "seeded",
                    "options": {"iterations": 50000, "seed": 999, "time_budget_ms": 1},
                }
                resp4 = _response_payload(await routes_v1.create_job(_job_request(payload4), caller=user, session=session))
                job4 = await session.get(Job, uuid.UUID(str(resp4["id"])))
                if job4:
                    job4.organization_id = org.id
                    job4.project_id = project.id
                    job4.billing_sponsor_user_id = org.billing_sponsor_user_id
                    job4.state = JobState.FAILED
                    job4.termination = "UNKNOWN"
                    job4.result = {
                        "status": "failed",
                        "code": "timeout_or_solver_memory_limit",
                        "error": "Time budget of 1ms expired during search phase.",
                        "logs": "[INFO] Started Random Search...\n[ERROR] Execution aborted: time budget exceeded.",
                    }
                    job4.finished_at = utcnow()
                    await session.commit()
                    jobs.append(job4)
            except Exception as exc:
                logger.warning("Could not create failed job: %s", exc)

    if not jobs:
        # Fallback for headless unit tests when no snapshot is provided
        job1 = Job(
            organization_id=org.id,
            project_id=project.id,
            billing_sponsor_user_id=org.billing_sponsor_user_id,
            owner_id=user.id,
            engine_id="minizinc-csp",
            engine_job_id=f"engine-job-{uuid.uuid4().hex[:12]}",
            service_url="http://engine-minizinc:3000",
            state=JobState.COMPLETED,
            termination="OPTIMAL",
            options={"time_budget_ms": 10000, "solver": "gecode"},
            result={
                "termination": "OPTIMAL",
                "solutions": [{
                    "decision": {
                        "kind": "binding",
                        "binding": {
                            "t1": {"resource": "catalog", "id": "c1a"},
                            "t2": {"resource": "catalog", "id": "c2a"},
                        }
                    },
                    "objectives": {"cost": 42.5, "latency": 110.0}
                }],
                "provenance": {"solver": "gecode", "engine": "minizinc-csp@1.0.0"},
                "logs": "[2026-09-07T10:00:00Z] Initializing Gecode solver backend...\n[2026-09-07T10:00:00Z] Flattening MiniZinc model subset: bim-subset/v1\n[2026-09-07T10:00:00Z] Constraints propagation: 14 variables, 28 constraints\n[2026-09-07T10:00:01Z] Solution #1: cost=48.0 latency=125.0\n[2026-09-07T10:00:01Z] Solution #2 (OPTIMAL): cost=42.5 latency=110.0\n[2026-09-07T10:00:01Z] Search complete. Optimal solution proven.",
            },
            created_at=utcnow(),
            finished_at=utcnow(),
            metered=True,
            concurrency_released=True,
        )
        session.add(job1)

        job2 = Job(
            organization_id=org.id,
            project_id=project.id,
            billing_sponsor_user_id=org.billing_sponsor_user_id,
            owner_id=user.id,
            engine_id="random-search",
            engine_job_id=f"engine-job-{uuid.uuid4().hex[:12]}",
            service_url="http://engine-random-search:8080",
            state=JobState.RUNNING,
            options={"iterations": 10000, "seed": 42},
            result={
                "logs": "[2026-09-07T10:05:00Z] Started Random Search engine v1.0.0...\n[2026-09-07T10:05:01Z] Generating candidate bindings in batch 100...\n[2026-09-07T10:05:02Z] Current incumbent: cost=49.1 latency=125.0\n[2026-09-07T10:05:03Z] Executing iteration batch 450/10000...",
            },
            created_at=utcnow(),
            metered=True,
            concurrency_released=True,
        )
        session.add(job2)
        jobs.extend([job1, job2])

        if all_states:
            job3 = Job(
                organization_id=org.id,
                project_id=project.id,
                billing_sponsor_user_id=org.billing_sponsor_user_id,
                owner_id=user.id,
                engine_id="minizinc-csp",
                engine_job_id=f"engine-job-{uuid.uuid4().hex[:12]}",
                service_url="http://engine-minizinc:3000",
                state=JobState.QUEUED,
                options={"time_budget_ms": 15000, "solver": "chuffed"},
                result={"logs": "[2026-09-07T10:10:00Z] Enqueued in scheduler waiting for worker allocation..."},
                created_at=utcnow(),
                metered=True,
                concurrency_released=True,
            )
            session.add(job3)

            job4 = Job(
                organization_id=org.id,
                project_id=project.id,
                billing_sponsor_user_id=org.billing_sponsor_user_id,
                owner_id=user.id,
                engine_id="random-search",
                engine_job_id=f"engine-job-{uuid.uuid4().hex[:12]}",
                service_url="http://engine-random-search:8080",
                state=JobState.FAILED,
                termination="UNKNOWN",
                options={"iterations": 50000, "seed": 999},
                result={
                    "status": "failed",
                    "code": "resource_exhausted",
                    "error": "Solver container exceeded allocated memory limit during multi-threaded exploration.",
                    "logs": "[2026-09-07T09:30:00Z] Starting parallel random exploration with 8 workers...\n[2026-09-07T09:30:05Z] Worker pool memory allocation reached 512MB threshold.\n[2026-09-07T09:30:06Z] FATAL: Out of memory in worker #3. Job failed with exit status 137.\n[2026-09-07T09:30:06Z] Eligible for retry with reduced iteration count or increased budget.",
                },
                created_at=utcnow(),
                finished_at=utcnow(),
                metered=True,
                concurrency_released=True,
            )
            session.add(job4)
            jobs.extend([job3, job4])

        await session.flush()
    logger.info("Created %d standalone jobs for project '%s'", len(jobs), project.slug)
    return jobs


async def ensure_reports_and_publications(
    session: AsyncSession,
    project: Project,
    user: User,
    executed_studies: list[tuple[Study, StudyRun]],
) -> None:
    """Create frozen reports, public citations, and draft working documents."""
    study_run_id = executed_studies[0][1].id if executed_studies else None

    # Report 1: Frozen Report linked to StudyRun 1
    report_slug = "qos-placement-2026-report"
    rep1 = (
        await session.execute(
            select(Report).where(Report.project_id == project.id, Report.slug == report_slug)
        )
    ).scalars().first()

    report_doc = {
        "schema": "bim/v1/report",
        "metadata": {
            "title": "Reproducible QoS-Aware Service Binding: Empirical Benchmark Report",
            "date": "2026-09-01T12:00:00Z",
            "author": user.username,
            "project": project.slug,
        },
        "study": {
            "slug": "exact-vs-heuristic",
            "run_number": 1,
            "comparison": "Exact MiniZinc CP vs Seeded Random Search",
        },
        "summary": {
            "total_cells": 4,
            "optimal_solutions": 2,
            "mean_exact_runtime_ms": 101.0,
            "mean_heuristic_runtime_ms": 407.5,
            "conclusion": "Exact CP achieves optimal Pareto placement in <= 104ms, while Random Search provides scalable approximations.",
        },
        "provenance": {
            "study": {
                "runId": str(study_run_id) if study_run_id else "00000000-0000-0000-0000-000000000000",
                "matrixDigest": executed_studies[0][1].matrix_digest if executed_studies else "sha256-" + "0" * 64,
            },
            "datasets": [{"reference": "simple-seq", "digest": "sha256-" + "a" * 64}],
            "software": [{"name": "gecode", "version": "6.3.0", "digest": "sha256-" + "b" * 64}],
            "bimVersion": "bim/v1",
            "engineRevisions": [{"name": "minizinc-csp", "version": "1.0.0", "digest": "sha256-" + "c" * 64}],
            "parameters": {"time_budget_ms": 5000},
        },
    }

    if rep1 is None:
        rep1 = Report(
            project_id=project.id,
            study_run_id=study_run_id,
            slug=report_slug,
            title="Reproducible QoS-Aware Service Binding: Empirical Benchmark Report",
            document=report_doc,
            digest=digest(report_doc),
            state=ReportState.FROZEN,
            created_by_id=user.id,
        )
        session.add(rep1)
        await session.flush()
        logger.info("Created Frozen Report '%s'", report_slug)

        # Publication on Explore
        pub_slug = "qos-placement-paper"
        pub = (
            await session.execute(
                select(Publication).where(Publication.project_id == project.id, Publication.slug == pub_slug)
            )
        ).scalars().first()
        if pub is None:
            citation = {
                "title": "Reproducible QoS-Aware Service Binding and Placement: An Empirical Benchmark",
                "authors": ["Alice Researcher", "Bob Engineer", "David Scientist"],
                "venue": "IEEE Transactions on Services Computing (Preprint)",
                "year": 2026,
                "doi": "10.1109/TSC.2026.9942001",
                "artifacts_url": f"https://openbinding.score.us.es/explore/{project.slug}/{pub_slug}",
            }
            pub = Publication(
                project_id=project.id,
                report_id=rep1.id,
                slug=pub_slug,
                citation=citation,
                published_by_id=user.id,
            )
            session.add(pub)
            await session.flush()
            logger.info("Created Public Publication '%s'", pub_slug)

    # Report 2: Draft report
    draft_slug = "parallel-scaling-notes"
    draft_rep = (
        await session.execute(
            select(Report).where(Report.project_id == project.id, Report.slug == draft_slug)
        )
    ).scalars().first()
    if draft_rep is None:
        draft_doc = {
            "title": "Parallel Scaling Working Notes (Draft)",
            "summary": "Preliminary observations on synchronization bottlenecks in parallel branch topologies.",
            "sections": [
                {
                    "heading": "Introduction & Hypothesis",
                    "content": "When expanding from 4 to 16 concurrent tasks in fork-join meshes, synchronization latency grows super-linearly.",
                },
                {
                    "heading": "Preliminary Observations",
                    "content": "MiniZinc solver proves Pareto optimality in under 350ms, while stochastic search requires at least 4,000 iterations to approach within 8% of the Pareto frontier.",
                },
                {
                    "heading": "Next Steps",
                    "content": "Evaluate evolutionary NSGA-II heuristic with hypervolume indicators across seeds 1 to 20.",
                },
            ],
            "status": "draft",
        }
        session.add(
            Report(
                project_id=project.id,
                study_run_id=executed_studies[1][1].id if len(executed_studies) > 1 else None,
                slug=draft_slug,
                title="Parallel Scaling Working Notes (Draft)",
                document=draft_doc,
                digest=digest(draft_doc),
                state=ReportState.DRAFT,
                created_by_id=user.id,
            )
        )
        await session.flush()
        logger.info("Created Draft Report '%s'", draft_slug)


def _artifact_path(settings: Settings, digest_value: str) -> Path:
    hexadecimal = digest_value.removeprefix("sha256-")
    root = Path(settings.artifact_root)
    try:
        root.mkdir(parents=True, exist_ok=True)
    except OSError:
        root = Path.cwd() / ".artifacts"
        root.mkdir(parents=True, exist_ok=True)
    return root / hexadecimal[:2] / hexadecimal[2:4] / hexadecimal


async def ensure_artifacts(
    session: AsyncSession,
    org_map: dict[str, Organization],
    project_map: dict[str, Project],
    users: dict[str, User],
) -> list[Artifact]:
    """Seed content-addressed artifacts on disk and in database."""
    settings = get_settings()
    alice = users["alice"]
    qos_proj = project_map.get("score-ai/qos-placement")
    fog_proj = project_map.get("score-edge/fog-latency-benchmark")
    stock_proj = project_map.get("acme-cloud/stock-trading-pipeline")

    if not qos_proj:
        return []

    # 1. JSON Benchmark dataset
    bench_data = json.dumps(
        {
            "benchmark_suite": "BIM v1 QoS Optimization Benchmark",
            "version": "2026.1",
            "date": "2026-09-01T10:00:00Z",
            "engines": [
                {"id": "minizinc-csp", "version": "1.0.0", "solver": "gecode"},
                {"id": "random-search", "version": "1.0.0", "iterations": 5000},
            ],
            "cases": [
                {"slug": "simple-seq", "tasks": 3, "resources": 6, "optimal_cost": 42.5},
                {"slug": "parallel-mesh", "tasks": 8, "resources": 16, "optimal_cost": 118.2},
                {"slug": "multi-objective", "tasks": 12, "resources": 24, "optimal_cost": 210.8},
            ],
            "aggregate_results": {
                "minizinc_mean_solve_ms": 112.4,
                "random_search_mean_solve_ms": 418.0,
                "heuristic_optimality_gap_percent": 6.2,
            },
        },
        indent=2,
    ).encode("utf-8")

    # 2. CSV execution traces
    csv_rows = [
        "run_id,cell_ordinal,case_slug,engine,seed,cost,latency,status,solve_duration_ms",
        "1,0,simple-seq,minizinc-csp,42,42.5,110.0,OPTIMAL,98",
        "1,1,simple-seq,minizinc-csp,101,42.5,110.0,OPTIMAL,104",
        "1,2,simple-seq,random-search,42,46.8,122.5,FEASIBLE,420",
        "1,3,simple-seq,random-search,101,45.2,118.0,FEASIBLE,395",
        "2,0,parallel-mesh,minizinc-csp,7,118.2,340.0,OPTIMAL,310",
        "2,1,parallel-mesh,minizinc-csp,99,118.2,340.0,OPTIMAL,325",
    ]
    csv_data = "\n".join(csv_rows).encode("utf-8")

    # 3. Reproducibility ZIP package
    zip_data = _deterministic_zip(
        [
            (
                "README.md",
                "# OpenBinding Reproducibility Package\n\n"
                "This package contains the environment specification, solver seeds, and empirical test matrices "
                "used to produce the 2026 IEEE TSC QoS Placement paper figures.\n\n"
                "## Contents\n- `dataset.json`: raw benchmark records\n- `metrics.csv`: execution metrics per seed\n",
            ),
            ("dataset.json", bench_data),
            ("metrics.csv", csv_data),
            (
                "manifest.json",
                json.dumps(
                    {"project": "qos-placement", "organization": "score-ai", "author": "Alice Researcher", "created": "2026-09-01"},
                    indent=2,
                ),
            ),
        ]
    )

    # 4. Fog latency trace CSV
    fog_csv_data = (
        "node_id,gateway_hop,rtt_ms,packet_loss,jitter_ms\n"
        "fog-edge-01,gw-us-east,14.2,0.001,1.2\n"
        "fog-edge-02,gw-eu-central,28.7,0.002,2.4\n"
        "fog-edge-03,gw-ap-southeast,52.1,0.005,4.1\n"
    ).encode("utf-8")

    # 5. Stock trading SLAs JSON
    stock_sla_data = json.dumps(
        {
            "service": "stock-trading-pipeline",
            "target_sla": "sub-10ms",
            "p50_latency_ms": 1.82,
            "p90_latency_ms": 3.41,
            "p99_latency_ms": 7.95,
            "p999_latency_ms": 9.88,
            "compliance": True,
        },
        indent=2,
    ).encode("utf-8")

    artifact_specs = [
        (qos_proj, bench_data, "application/json", True, "qos-benchmark-suite-v1.json"),
        (qos_proj, csv_data, "text/csv", False, "qos-execution-traces.csv"),
        (qos_proj, zip_data, "application/zip", True, "reproducibility-package.zip"),
    ]
    if fog_proj:
        artifact_specs.append((fog_proj, fog_csv_data, "text/csv", True, "fog-latency-traces.csv"))
        fog_zip_data = _deterministic_zip(
            [
                ("README.md", "# Fog Latency Traces\n\nEmpirical latency and hop distribution traces.\n"),
                ("fog-latency-traces.csv", fog_csv_data),
            ]
        )
        artifact_specs.append((fog_proj, fog_zip_data, "application/zip", True, "fog-reproducibility.zip"))
    if stock_proj:
        artifact_specs.append((stock_proj, stock_sla_data, "application/json", True, "trading-pipeline-slas.json"))
        # Seed shared benchmark data in stock_proj with identical content to test multi-project resolution & pagination
        artifact_specs.append((stock_proj, bench_data, "application/json", True, "replicated-benchmark-suite.json"))
        stock_zip_data = _deterministic_zip(
            [
                ("README.md", "# Stock Trading Pipeline SLAs\n\nTarget benchmarks and SLA profiles.\n"),
                ("slas.json", stock_sla_data),
                ("benchmark.json", bench_data),
            ]
        )
        artifact_specs.append((stock_proj, stock_zip_data, "application/zip", True, "stock-trading-reproducibility.zip"))

    created_artifacts: list[Artifact] = []

    for proj, raw_bytes, media_type, is_public, display_name in artifact_specs:
        digest_hex = hashlib.sha256(raw_bytes).hexdigest()
        digest_value = f"sha256-{digest_hex}"

        # Ensure file on disk
        target_path = _artifact_path(settings, digest_value)
        try:
            target_path.parent.mkdir(parents=True, exist_ok=True)
            if not target_path.exists():
                target_path.write_bytes(raw_bytes)
                logger.debug("Wrote artifact file %s (%d bytes)", target_path, len(raw_bytes))
        except OSError as file_err:
            logger.warning("Could not write physical artifact file to %s: %s", target_path, file_err)

        existing = (
            await session.execute(
                select(Artifact).where(Artifact.project_id == proj.id, Artifact.digest == digest_value)
            )
        ).scalars().first()

        if existing is None:
            artifact = Artifact(
                organization_id=proj.organization_id,
                project_id=proj.id,
                digest=digest_value,
                media_type=media_type,
                size_bytes=len(raw_bytes),
                storage_uri=str(target_path),
                public=is_public,
                created_by_id=alice.id,
            )
            session.add(artifact)
            await session.flush()
            session.add(
                AuditEvent(
                    organization_id=proj.organization_id,
                    actor_id=alice.id,
                    action="artifact.uploaded",
                    target_type="Artifact",
                    target_id=artifact.id,
                    detail={"digest": digest_value, "media_type": media_type, "size_bytes": len(raw_bytes), "name": display_name},
                )
            )
            created_artifacts.append(artifact)
            logger.info("Created Artifact '%s' (%s, %d bytes) in '%s'", display_name, digest_value[:20] + "...", len(raw_bytes), proj.slug)
        else:
            created_artifacts.append(existing)

    await session.commit()
    return created_artifacts


async def ensure_notifications_and_audit(
    session: AsyncSession,
    orgs: dict[str, Organization],
    projects: dict[str, Project],
    users: dict[str, User],
) -> None:
    """Create sample notifications and realistic audit records."""
    alice = users["alice"]
    bob = users["bob"]
    david = users["david"]
    score_ai = orgs["score-ai"]

    notifs = [
        (alice.id, "study_completed", "Study 'exact-vs-heuristic' run #1 finished", "All 4 cells executed and metrics are ready for inspection.", True),
        (alice.id, "member_joined", "Bob joined SCORE AI & Optimization Lab", "Bob accepted the invitation and was granted MEMBER role.", False),
        (bob.id, "role_updated", "Promoted to OWNER in Acme Cloud Infrastructure", "Your organization role has been updated.", False),
        (david.id, "run_dispatched", "StudyRun #1 dispatched in smart-orchestration", "Solver jobs have been queued in Dramatiq.", False),
    ]

    for u_id, kind, subj, body, read in notifs:
        session.add(
            Notification(
                user_id=u_id,
                kind=kind,
                subject=subj,
                body=body,
                payload={"link": "/platform"},
                read_at=utcnow() if read else None,
            )
        )

    # Audit records
    audit_specs = [
        (score_ai.id, alice.id, "organization.created", "Organization", score_ai.id, {"slug": score_ai.slug}),
        (score_ai.id, alice.id, "member.added", "User", bob.id, {"role": "MEMBER", "username": "bob"}),
        (score_ai.id, alice.id, "project.created", "Project", projects["score-ai/qos-placement"].id, {"name": "QoS Placement"}),
        (score_ai.id, alice.id, "study.run.dispatched", "StudyRun", None, {"study": "exact-vs-heuristic", "cells": 4}),
        (score_ai.id, alice.id, "report.frozen", "Report", None, {"title": "Empirical QoS Placement Optimization Report 2026"}),
        (score_ai.id, alice.id, "publication.published", "Publication", None, {"slug": "qos-placement-paper"}),
    ]

    for org_id, actor_id, act, t_type, t_id, det in audit_specs:
        session.add(
            AuditEvent(
                organization_id=org_id,
                actor_id=actor_id,
                action=act,
                target_type=t_type,
                target_id=t_id,
                detail=det,
            )
        )

    await session.commit()
    logger.info("Seeded notifications and audit events.")


def print_summary_banner(users: dict[str, User]) -> None:
    banner = "=" * 78
    print("\n" + banner)
    print("  OPENBINDING DEVELOPMENT DATA SEEDED SUCCESSFULLY")
    print(banner)
    print("\n  [Users & Credentials] (All test users use password: " + DEV_PASSWORD + ")")
    for u_spec in SEED_USERS:
        uname = u_spec["username"]
        role = u_spec["role"].value
        plan = u_spec.get("plan", "BASIC")
        full_key, prefix, _ = dev_api_key(uname, u_spec["key_suffix"])
        print(f"    - {uname:<8} ({role:<5}, plan: {plan:<8}) | API Key: {full_key}")

    print("\n  [Organizations Hierarchy]")
    print("    - score-group (Root - SCORE Research Group)")
    print("        ├── score-ai   (Sub-org: AI & Optimization Lab)")
    print("        └── score-edge (Sub-org: Edge & Fog Systems)")
    print("    - acme-corp (Root - Acme Corporation)")
    print("        └── acme-cloud (Sub-org: Cloud Infrastructure)")

    print("\n  [Projects & Studies]")
    print("    - score-ai/qos-placement (Public)")
    print("        ├── Cases: simple-seq, parallel-mesh, multi-objective")
    print("        ├── Resources: standard-candidate-catalog (2 revs), sla-latency-constraints, balanced-cost-latency-weights")
    print("        ├── Collection: standard-benchmarks")
    print("        ├── Studies: exact-vs-heuristic (Real Runs & Jobs), parallel-scaling-study")
    print("        ├── Artifacts: benchmark datasets, execution traces, reproducibility package")
    print("        ├── Report: qos-placement-2026-report (Frozen)")
    print("        └── Publication: qos-placement-paper (Visible in /explore)")
    print("    - score-ai/smart-orchestration (Private)")
    print("    - score-edge/fog-latency-benchmark (Public)")
    print("        └── Resources: fog-node-topology")
    print("    - acme-cloud/stock-trading-pipeline (Public)")
    print("        └── Resources: financial-order-routing-catalog")
    print("    - acme-cloud/resilient-data-mesh (Private)")

    print("\n  [Example API Requests]")
    alice_key, _, _ = dev_api_key("alice", "alice0001")
    print(f"    curl -H 'x-api-key: {alice_key}' http://localhost:8000/v1/users/me")
    print(f"    curl -H 'x-api-key: {alice_key}' http://localhost:8000/v1/users/me/pricing-token")
    print(f"    curl -H 'x-api-key: {alice_key}' http://localhost:8000/v1/organizations/score-ai/projects/qos-placement/resources")
    print(f"    curl -H 'x-api-key: {alice_key}' http://localhost:8000/v1/organizations/score-ai/projects/qos-placement/studies")
    print(f"    curl -H 'x-api-key: {alice_key}' http://localhost:8000/v1/organizations/score-ai/projects/qos-placement/artifacts")
    print("    curl http://localhost:8000/v1/explore/projects")
    print("\n  [Universal Cryptographic Resolver & Verifier]")
    print("    GET /v1/resolve/artifact/{digest}            (Metadata, locations, and provenance)")
    print("    GET /v1/resolve/artifact/{digest}/content    (Raw payload with immutable/private cache headers)")
    print("    GET /v1/resolve/case-revision/{digest}       (Binding case revision)")
    print("    GET /v1/resolve/report/{digest}              (Empirical study reports)")
    print(banner + "\n")


async def main() -> int:
    parser = argparse.ArgumentParser(description="Seed OpenBinding database with development data.")
    parser.add_argument("--reset", action="store_true", help="Clean up existing dev data before seeding.")
    parser.add_argument("--verbose", action="store_true", help="Enable debug logging.")
    parser.add_argument("--force-prod", action="store_true", help="Bypass production environment safety guard.")
    args = parser.parse_args()

    log_level = logging.DEBUG if args.verbose else logging.INFO
    logging.basicConfig(level=log_level, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")

    settings = get_settings()
    app_env = getattr(settings, "app_env", os.getenv("APP_ENV", "dev")).lower()
    if app_env == "prod" and not args.force_prod:
        logger.error("Refusing to run seed_dev.py in production environment (APP_ENV=%s)! Use --force-prod if intended.", app_env)
        return 1

    database_url = settings.database_url or os.getenv("DATABASE_URL")
    if not database_url:
        logger.error("No DATABASE_URL configured. Ensure PostgreSQL is running and configured in .env.")
        return 1

    examples_dir = _find_examples_dir()
    logger.info("Using examples directory: %s", examples_dir)

    db_base.init_engine(database_url)

    async def resolve_catalog(version: str):
        from openbinding_gateway.pricing_catalog import catalog_for_version
        async with db_base.session_factory()() as catalog_session:
            return await catalog_for_version(catalog_session, settings, version)

    space_client.set_gate(space_client.build_gate(settings, catalog_resolver=resolve_catalog))

    try:
        async with db_base.session_factory()() as session:
            if args.reset:
                await clean_existing_data(session)

            # 1. Users & API keys
            user_map = await ensure_users(session)

            # 1.1 SPACE contracts
            await ensure_space_contracts(session, user_map)

            # 1.2 Seed immutable EngineRevisions and registered EngineRegistrationRevisions
            await ensure_engine_revisions(session, user_map["admin"])

            # 2. Hierarchical Organizations & Memberships
            org_map = await ensure_organizations(session, user_map)

            # 3. Projects
            project_map = await ensure_projects(session, org_map, user_map)

            # 4. Snapshots from real BIM packages
            snapshots = await load_and_persist_snapshots(session, user_map["alice"], examples_dir)

            # 5. Cases, Revisions & Collections
            qos_project = project_map["score-ai/qos-placement"]
            case_map = await ensure_cases_and_collections(session, qos_project, user_map["alice"], snapshots)

            # 5.1 Reusable Project Resources & Revisions
            await ensure_project_resources(session, project_map, user_map)

            # 6. Standalone solve jobs
            await ensure_standalone_jobs(session, org_map["score-ai"], qos_project, user_map["alice"], snapshots=snapshots, all_states=True)

            # 7. Studies & Real Job Executions
            executed_studies = await execute_real_studies(session, org_map["score-ai"], qos_project, user_map["alice"], case_map)

            # 8. Reports & Publications
            await ensure_reports_and_publications(session, qos_project, user_map["alice"], executed_studies)

            # 9. Content-addressed Artifacts
            await ensure_artifacts(session, org_map, project_map, user_map)

            # 10. Notifications & Audit
            await ensure_notifications_and_audit(session, org_map, project_map, user_map)

            # 11. Reconcile usage
            await resync_user_usage(session, user_map)

            await session.commit()

        print_summary_banner(user_map)
        return 0

    except Exception as exc:
        logger.exception("Seeding failed: %s", exc)
        return 1
    finally:
        await db_base.dispose_engine()


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
