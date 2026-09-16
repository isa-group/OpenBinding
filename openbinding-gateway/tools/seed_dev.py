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
    Blob,
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
from openbinding_gateway.studies import expand_study
from openbinding_gateway.study_jobs import StudyLaunchError, launch_study_cell
from openbinding_gateway.v1.canonical import digest
from openbinding_gateway.v1.package import InstancePackage, load_package
from seed_analysis import prepare_analysis_workspace

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
    """Rebuild the local development database; sealed rows are never unsealed."""
    from alembic import command
    from alembic.config import Config
    from sqlalchemy import text
    bind = session.get_bind()
    if get_settings().app_env == 'prod' or bind.url.host not in {None, 'localhost', '127.0.0.1', 'postgres'}:
        raise RuntimeError('Development reset is restricted to a local OpenBinding database.')
    await session.commit()
    session.expunge_all()
    connection = await session.connection()
    def rebuild(sync_connection):
        db_base.Base.metadata.drop_all(sync_connection)
        sync_connection.execute(text('DROP TABLE IF EXISTS alembic_version'))
        config = Config(str(_gateway_root / 'alembic.ini'))
        config.set_main_option('script_location', str(_gateway_root / 'alembic'))
        config.attributes['connection'] = sync_connection
        command.upgrade(config, 'head')
    await connection.run_sync(rebuild)
    await session.commit()


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


async def ensure_library_composition(session, project, user, package, prefix):
    """Use stable authored names across projects; never infer shared identity from bytes."""
    from openbinding_gateway.artifacts import reference, validate_content, seal_draft, materialize_case
    from openbinding_gateway.db.models import Artifact, ArtifactDraft, ArtifactVersion, ProjectArtifact
    from openbinding_gateway.models.artifacts import DraftContent, ArtifactUse
    from openbinding_gateway.v1.canonical import digest_bytes
    organization = await session.get(Organization, project.organization_id)
    uses = []
    for role, resources in package.instance()['spec']['resources'].items():
        for alias, path in resources.items():
            content = package.json(path) if path.endswith('.json') else package.files[path].decode('utf-8')
            kind = content['kind'] if isinstance(content, dict) else 'BPMN'
            payload = DraftContent(content=content, media_type='application/json' if isinstance(content, dict) else 'application/vnd.omg.bpmn+xml')
            raw, contracts = validate_content(kind, payload)
            name = f'{prefix}-{alias}'
            artifact = await session.scalar(select(Artifact).where(Artifact.organization_id == organization.id, Artifact.name == name))
            if artifact is None:
                artifact = Artifact(organization_id=organization.id, namespace=str(organization.id), name=name,
                    display_name=f'{prefix} · {alias}', kind=kind, created_by_id=user.id)
                session.add(artifact)
                await session.flush()
            candidates = (await session.scalars(select(ArtifactVersion).where(
                ArtifactVersion.artifact_id == artifact.id, ArtifactVersion.content_digest == digest_bytes(raw)))).all()
            version = next((item for item in candidates if item.manifest['contracts'] == contracts), None)
            if version is None:
                draft = ArtifactDraft(artifact_id=artifact.id, payload=payload.model_dump(mode='json'), created_by_id=user.id)
                session.add(draft)
                await session.flush()
                version = await seal_draft(session, artifact, draft, 1, None, user)
            if await session.get(ProjectArtifact, (project.id, artifact.id)) is None:
                session.add(ProjectArtifact(project_id=project.id, artifact_id=artifact.id))
            uses.append(ArtifactUse(role=role, alias=alias, artifact=reference(artifact, version)))
    return await materialize_case(session, user, organization, package.instance(), uses)


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

        from openbinding_gateway.artifacts import case_composition_digest
        from openbinding_gateway.db.models import CaseArtifact
        doc, materialized_id, uses = await ensure_library_composition(session, project, user, package, sample_key)
        snapshot = await session.get(InstanceSnapshot, materialized_id)
        doc_digest = case_composition_digest(doc, snapshot, [use.model_dump(mode='json') for use, _ in uses])

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
                revision=int(await session.scalar(select(func.max(BindingCaseRevision.revision)).where(BindingCaseRevision.binding_case_id == case.id)) or 0) + 1,
                digest=doc_digest,
                document=doc,
                source_snapshot_id=snapshot.id,
                created_by_id=user.id,
            )
            session.add(revision)
            await session.flush()
            for use, version in uses:
                session.add(CaseArtifact(revision_id=revision.id, role=use.role, alias=use.alias, version_id=version.id, bindings=use.bindings))
            logger.info("Created BindingCaseRevision #1 for '%s'", slug)

        case_map[slug] = (case, revision)

    # Collection payload and FK consumers use the same exact revision references.
    if 'simple-seq' in case_map and 'parallel-mesh' in case_map:
        collection = await session.scalar(select(Collection).where(Collection.project_id == project.id, Collection.slug == 'standard-benchmarks'))
        if collection is None:
            collection = Collection(project_id=project.id, slug='standard-benchmarks', name='Standard BIM v1 Benchmark Suite',
                description='Sequential, parallel and multi-objective experiments.', created_by_id=user.id)
            session.add(collection)
            await session.flush()
        editions = [['simple-seq', 'parallel-mesh']]
        if 'multi-objective' in case_map:
            editions.append(['simple-seq', 'multi-objective', 'parallel-mesh'])
        for ordinal, keys in enumerate(editions, 1):
            items = [dict(target_kind='case', target_digest=case_map[key][1].digest,
                target_ref={'caseRevisionId': str(case_map[key][1].id)}) for key in keys]
            content_digest = digest(items)
            revision = await session.scalar(select(CollectionRevision).where(CollectionRevision.collection_id == collection.id,
                CollectionRevision.digest == content_digest))
            if revision is None:
                next_ordinal = int(await session.scalar(select(func.max(CollectionRevision.revision)).where(CollectionRevision.collection_id == collection.id)) or 0) + 1
                revision = CollectionRevision(collection_id=collection.id, revision=next_ordinal, digest=content_digest, created_by_id=user.id)
                session.add(revision)
                await session.flush()
                for position, item in enumerate(items):
                    session.add(CollectionItem(collection_revision_id=revision.id, position=position, added_by_id=user.id, **item))
                await session.flush()

    return case_map


async def ensure_project_resources(session, project_map, users):
    """Seed two consumers that independently pin versions of shared BIM inputs."""
    from openbinding_gateway.artifacts import case_composition_digest, materialize_case, seal_draft
    from openbinding_gateway.db.models import Artifact, ArtifactVersion, ArtifactDraft, CaseArtifact, ProjectArtifact
    from openbinding_gateway.models.artifacts import DraftContent, PublishVersion
    from openbinding_gateway.routes.library import publish_version
    from openbinding_gateway.v1.canonical import canonical_json
    source = load_package(_find_examples_dir() / 'demo' / '01_simple_seq')
    root = source.instance()
    root['spec']['resources']['constraintSet'] = {'constraints': 'constraints.json'}
    constraints = dict(apiVersion='qos-binding/v1', kind='ConstraintSet', metadata={'name': 'shared-latency-bound'},
        spec={'constraints': {'latency-sla': {'assert': 'metrics.latency <= 1000', 'enforcement': 'hard'}}})
    files = {**source.files, 'instance.json': canonical_json(root), 'constraints.json': canonical_json(constraints)}
    initial = InstancePackage(files)
    first_uses = None
    for index, key in enumerate(('score-ai/qos-placement', 'score-ai/smart-orchestration')):
        project = project_map.get(key)
        if not project:
            continue
        package = initial
        if index:
            catalog = initial.json('candidates.json')
            catalog['spec']['candidates']['c1a']['metrics']['latency'] = 8
            package = InstancePackage({**files, 'candidates.json': canonical_json(catalog)})
        document, snapshot_id, uses = await ensure_library_composition(session, project, users['alice'], package, '01_simple_seq')
        if first_uses is None:
            first_uses = uses
        case = await session.scalar(select(BindingCase).where(BindingCase.project_id == project.id, BindingCase.slug == 'shared-library-experiment'))
        if case is None:
            case = BindingCase(project_id=project.id, slug='shared-library-experiment', name='Shared resources experiment',
                description='This project pins its own catalog version.', created_by_id=users['alice'].id)
            session.add(case)
            await session.flush()
        snapshot = await session.get(InstanceSnapshot, snapshot_id)
        composition = case_composition_digest(document, snapshot, [use.model_dump(mode='json') for use, _ in uses])
        revision = await session.scalar(select(BindingCaseRevision).where(BindingCaseRevision.binding_case_id == case.id, BindingCaseRevision.digest == composition))
        if revision is None:
            ordinal = int(await session.scalar(select(func.max(BindingCaseRevision.revision)).where(BindingCaseRevision.binding_case_id == case.id)) or 0) + 1
            revision = BindingCaseRevision(binding_case_id=case.id, revision=ordinal, document=document,
                digest=composition, source_snapshot_id=snapshot_id, created_by_id=users['alice'].id)
            session.add(revision)
            await session.flush()
            for use, version in uses:
                session.add(CaseArtifact(revision_id=revision.id, alias=use.alias, role=use.role, version_id=version.id, bindings=use.bindings))
    if first_uses:
        for _, version in first_uses:
            await publish_version(version.artifact_id, version.id,
                PublishVersion(citation={'title': 'Shared sequential benchmark inputs'}), users['alice'], session)
        await session.flush()
        # A second organization consumes the public releases, not copies.
        consumer = project_map.get('acme-cloud/stock-trading-pipeline')
        if consumer:
            organization = await session.get(Organization, consumer.organization_id)
            document, snapshot_id, uses = await materialize_case(session, users['elena'], organization, root, [use for use, _ in first_uses])
            case = await session.scalar(select(BindingCase).where(BindingCase.project_id == consumer.id, BindingCase.slug == 'public-library-experiment'))
            if case is None:
                case = BindingCase(project_id=consumer.id, slug='public-library-experiment', name='Public shared resources',
                    description='Consumes exact public versions owned by another organization.', created_by_id=users['elena'].id)
                session.add(case)
                await session.flush()
            snapshot = await session.get(InstanceSnapshot, snapshot_id)
            composition = case_composition_digest(document, snapshot, [use.model_dump(mode='json') for use, _ in uses])
            if await session.scalar(select(BindingCaseRevision.id).where(BindingCaseRevision.binding_case_id == case.id, BindingCaseRevision.digest == composition)) is None:
                ordinal = int(await session.scalar(select(func.max(BindingCaseRevision.revision)).where(BindingCaseRevision.binding_case_id == case.id)) or 0) + 1
                revision = BindingCaseRevision(binding_case_id=case.id, revision=ordinal, document=document,
                    digest=composition, source_snapshot_id=snapshot_id, created_by_id=users['elena'].id)
                session.add(revision)
                await session.flush()
                for use, version in uses:
                    session.add(CaseArtifact(revision_id=revision.id, alias=use.alias, role=use.role, version_id=version.id, bindings=use.bindings))
            for _, version in uses:
                if await session.get(ProjectArtifact, (consumer.id, version.artifact_id)) is None:
                    session.add(ProjectArtifact(project_id=consumer.id, artifact_id=version.artifact_id))
    primary = project_map.get('score-ai/qos-placement')
    if primary:
        config = await session.scalar(select(Artifact).where(Artifact.organization_id == primary.organization_id, Artifact.name == 'shared-seeded-search'))
        if config is None:
            config = Artifact(organization_id=primary.organization_id, namespace=str(primary.organization_id), name='shared-seeded-search',
                display_name='Shared reproducible search settings', kind='ExecutionConfiguration', created_by_id=users['alice'].id)
            session.add(config)
            await session.flush()
        content = {'engine': routes_v1._engine_ref(routes_v1._manifest('random-search')), 'mode': 'seeded',
                   'options': {'iterations': 100, 'seed': 7}}
        if await session.scalar(select(ArtifactVersion.id).where(ArtifactVersion.artifact_id == config.id, ArtifactVersion.content_digest == digest(content))) is None:
            draft = ArtifactDraft(artifact_id=config.id, payload=DraftContent(content=content).model_dump(mode='json'), created_by_id=users['alice'].id)
            session.add(draft)
            await session.flush()
            await seal_draft(session, config, draft, 1, None, users['alice'])
        for key in ('score-ai/qos-placement', 'score-ai/smart-orchestration'):
            consumer = project_map.get(key)
            if consumer and await session.get(ProjectArtifact, (consumer.id, config.id)) is None:
                session.add(ProjectArtifact(project_id=consumer.id, artifact_id=config.id))
    result = {}
    for artifact in await session.scalars(select(Artifact).where(Artifact.name.like('01_simple_seq-%'))):
        result[artifact.name] = (artifact, (await session.scalars(select(ArtifactVersion).where(
            ArtifactVersion.artifact_id == artifact.id).order_by(ArtifactVersion.ordinal))).all())
    await session.commit()
    return result


async def execute_real_studies(
    session: AsyncSession,
    org: Organization,
    project: Project,
    user: User,
    case_map: dict[str, tuple[BindingCase, BindingCaseRevision]],
) -> list[tuple[Study, StudyRun]]:
    """Dispatch bounded studies once; the production worker advances their cells."""
    from openbinding_gateway.v1.compiler import compiler_bundle_digest

    engine_refs = []
    for name in ("minizinc-csp", "random-search"):
        try:
            manifest = routes_v1._manifest(name)
            engine_refs.append({**{key: manifest["metadata"][key] for key in ("namespace", "name", "version")},
                                "digest": digest(manifest)})
        except Exception as exc:
            logger.warning("Live study coverage gap for %s: %s", name, exc)
    if not engine_refs:
        return []

    completed = []
    scenarios = [
        ("simple-seq", "exact-vs-heuristic", "Exact MiniZinc vs Seeded Random Search Benchmark", [42, 101]),
        ("parallel-mesh", "parallel-scaling-study", "Parallel Workflow Scalability Study", [42]),
    ]
    for case_key, slug, name, seeds in scenarios:
        if case_key not in case_map:
            continue
        definition = StudyDefinition(case_revision_ids=[case_map[case_key][1].id], engines=engine_refs,
                                     parameter_sets=[{"time_budget_ms": 5000}], seeds=seeds)
        study = (await session.execute(select(Study).where(Study.project_id == project.id, Study.slug == slug))).scalars().first()
        from openbinding_gateway.studies import seal_study_definition
        version = await seal_study_definition(session, project, user, name, definition,
            current=study.definition_version if study else None)
        if study is None:
            study = Study(project_id=project.id, slug=slug, name=name, definition_version=version,
                          state=StudyState.READY, created_by_id=user.id)
            session.add(study)
        else:
            study.definition_version = version
        await session.flush()
        expanded = expand_study(definition)
        identity = digest({"matrix": expanded, "generator": 3, "evaluator": compiler_bundle_digest()})
        runs = (await session.execute(select(StudyRun).where(StudyRun.study_id == study.id))).scalars().all()
        run = next((r for r in runs if (r.summary or {}).get("seedScenarioDigest") == identity), None)
        if run is None:
            run = StudyRun(study_id=study.id, definition_version_id=study.definition_version_id, run_number=1+max((r.run_number for r in runs), default=0),
                           state=RunState.QUEUED, matrix_digest=digest([item["fingerprint"] for item in expanded]),
                           summary={"cells": len(expanded), "seedScenarioDigest": identity}, created_by_id=user.id)
            session.add(run)
            await session.flush()
            cells = [StudyCell(study_run_id=run.id, ordinal=item["ordinal"],
                               binding_case_revision_id=uuid.UUID(item["caseRevisionId"]), engine_ref=item["engine"],
                               parameters=item["parameters"], seed=item["seed"], fingerprint=item["fingerprint"],
                               state=RunState.QUEUED) for item in expanded]
            session.add_all(cells)
            await session.flush()
            # One coordinator: sync_study_job dispatches later cells. Launching them here too races its worker.
            try:
                await launch_study_cell(session, cells[0], user, org, project.id)
                await session.commit()
            except StudyLaunchError as exc:
                cells[0].state = RunState.FAILED
                cells[0].metrics = {"status": "failed", "code": exc.code, "detail": exc.detail}
                run.state = RunState.PARTIAL
                await session.commit()
                logger.warning("Live study coverage gap for %s: %s", slug, exc)
        else:
            await session.commit()
            logger.info("Reusing study %s run %d", slug, run.run_number)
        deadline = asyncio.get_running_loop().time() + 180
        while run.state in {RunState.QUEUED, RunState.RUNNING} and asyncio.get_running_loop().time() < deadline:
            await session.commit()
            await asyncio.sleep(1)
            await session.refresh(run)
        if run.state is not RunState.COMPLETED:
            logger.warning("Live study coverage gap: %s run %d is %s (worker required)", slug, run.run_number, run.state.value)
        completed.append((study, run))
    return completed


async def ensure_standalone_jobs(
    session: AsyncSession,
    org: Organization,
    project: Project,
    user: User,
    snapshots: dict[str, tuple[InstancePackage, InstanceSnapshot] | InstanceSnapshot] | None = None,
    all_states: bool = False,
) -> list[Job]:
    """Execute bounded real jobs; unchanged scenarios reuse their persisted outcomes."""
    from openbinding_gateway.job_dispatch import _execute
    from openbinding_gateway.study_jobs import _job_request, _response_payload
    from openbinding_gateway.v1.compiler import compiler_bundle_digest

    snap = (snapshots or {}).get("01_simple_seq") or next(iter((snapshots or {}).values()), None)
    if isinstance(snap, tuple):
        snap = snap[1]
    if snap is None:
        logger.warning("Live-job coverage gap: no input snapshot; no solver outcome was manufactured")
        return []
    jobs = []
    scenarios = [("minizinc-csp", "exact-weighted", {"time_budget_ms": 10000, "solver": "gecode"}),
                 ("random-search", "seeded", {"iterations": 128, "seed": 42})]
    for engine, mode, options in scenarios:
        try:
            manifest = routes_v1._manifest(engine)
            ref = {"namespace": manifest["metadata"]["namespace"], "name": engine,
                   "version": manifest["metadata"]["version"], "digest": digest(manifest)}
            identity = digest({"generator": 2, "package": snap.package_digest, "evaluator": compiler_bundle_digest(),
                               "engine": ref, "mode": mode, "options": options})
            key = f"development-live-{project.id}-{identity}"
            existing = (await session.execute(select(Job).where(Job.owner_id == user.id, Job.idempotency_key == key))).scalars().first()
            if existing is not None:
                jobs.append(existing)
                logger.info("Reused live scenario %s: %s (%s)", engine, existing.id, existing.state.value)
                continue
            request = _job_request({"snapshot": str(snap.id), "engine": ref, "mode": mode, "options": options})
            request.scope["headers"].append((b"idempotency-key", key.encode()))
            response = _response_payload(await routes_v1.create_job(request, caller=user, session=session))
            job = await session.get(Job, uuid.UUID(str(response["id"])))
            job.organization_id, job.project_id = org.id, project.id
            job.billing_sponsor_user_id = org.billing_sponsor_user_id
            await session.commit()
            await _execute(str(job.id))
            await session.refresh(job)
            jobs.append(job)
            logger.info("Live scenario %s: %s (%s, %s)", engine, job.id, job.state.value, job.termination)
        except Exception as exc:
            logger.warning("Live-job coverage gap for %s: %s", engine, exc)
    return jobs


async def ensure_reports_and_publications(
    session: AsyncSession,
    project: Project,
    user: User,
    executed_studies: list[tuple[Study, StudyRun]],
) -> None:
    """Create frozen reports, public citations, and draft working documents."""
    from openbinding_gateway.db.models import ArtifactVersion
    study_run_id = executed_studies[0][1].id if executed_studies else None

    # Report 1: Frozen Report linked to StudyRun 1
    report_slug = "qos-placement-2026-report"
    rep1 = (
        await session.execute(
            select(Report).where(Report.project_id == project.id, Report.slug == report_slug)
        )
    ).scalars().first()

    report_doc = {'title': 'Benchmark report draft', 'status': 'awaiting-execution',
                  'summary': 'Execute the benchmark study before sealing this report.'}
    if study_run_id:
        from openbinding_gateway.studies import definition_from_version
        run = executed_studies[0][1]
        definition = definition_from_version(await session.get(ArtifactVersion, run.definition_version_id))
        source_cases = (await session.scalars(select(BindingCaseRevision).where(
            BindingCaseRevision.id.in_([uuid.UUID(identity) for identity in definition['case_revision_ids']])))).all()
        source_snapshots = [await session.get(InstanceSnapshot, case.source_snapshot_id) for case in source_cases]
        report_doc = {'schema': 'bim/v1/report', 'metadata': {'title': 'Executed binding benchmark', 'author': user.username},
            'summary': dict(run.summary), 'provenance': {
                'study': {'runId': str(run.id), 'matrixDigest': run.matrix_digest},
                'datasets': [{'reference': str(case.id), 'digest': case.digest} for case in source_cases],
                'software': [{'name': 'binding-compilation', 'version': 'bim/v1', 'digest': snapshot.compilation_digest}
                             for snapshot in source_snapshots if snapshot],
                'bimVersion': 'bim/v1', 'engineRevisions': definition['engines'],
                'parameters': {'sets': definition['parameter_sets'], 'seeds': definition['seeds']},
            }}

    from openbinding_gateway.reports import create_report_context, seal_report, new_report_draft
    if rep1 is None:
        rep1 = await create_report_context(session, project, user, slug=report_slug,
            title="Reproducible QoS-Aware Service Binding: Empirical Benchmark Report",
            document=report_doc, study_run_id=study_run_id)
    if study_run_id and rep1.state is ReportState.DRAFT:
        # A prior seed without engines leaves a draft which a later live seed can finish.
        rep1.study_run_id = study_run_id
        rep1.draft.payload = {**rep1.draft.payload, 'content': report_doc}
        rep1.draft.revision += 1
        await seal_report(session, rep1, user)

    if study_run_id and rep1.state is ReportState.FROZEN:
        from openbinding_gateway.routes.library import publish_version
        from openbinding_gateway.routes.studies import publish_report, delete_publication
        from openbinding_gateway.models.artifacts import PublishVersion
        from openbinding_gateway.models.platform import PublicationCreate
        from openbinding_gateway.db.models import CaseArtifact
        organization = await session.get(Organization, project.organization_id)
        definition_version = await session.get(ArtifactVersion, executed_studies[0][1].definition_version_id)
        for case in source_cases:
            for resource_id in await session.scalars(select(CaseArtifact.version_id).where(CaseArtifact.revision_id == case.id)):
                resource = await session.get(ArtifactVersion, resource_id)
                await publish_version(resource.artifact_id, resource.id,
                    PublishVersion(citation={'title': 'Benchmark input'}), user, session)
        await publish_version(definition_version.artifact_id, definition_version.id,
            PublishVersion(citation={'title': 'Executed benchmark definition'}), user, session)
        versions = (await session.scalars(select(ArtifactVersion)
            .where(ArtifactVersion.artifact_id == rep1.artifact_id).order_by(ArtifactVersion.ordinal))).all()
        first = versions[0]
        pub_slug = "qos-placement-paper"
        pub = await session.scalar(select(Publication).where(
            Publication.project_id == project.id, Publication.slug == pub_slug))
        if pub is None:
            await publish_report(organization.slug, project.slug,
                PublicationCreate(report_id=rep1.id, version_id=first.id, slug=pub_slug,
                    citation={'title': 'Executed binding benchmark', 'authors': [user.username],
                              'venue': 'OpenBinding development scenario', 'year': 2026}), user, session)
            pub = await session.scalar(select(Publication).where(
                Publication.project_id == project.id, Publication.slug == pub_slug))
        if len(versions) == 1:
            draft = await new_report_draft(session, rep1, user)
            draft.payload = {**draft.payload, 'content': {**rep1.document,
                'editorialNote': 'Second edition: evidence and measured results are unchanged.'}}
            draft.revision += 1
            await seal_report(session, rep1, user)
        second_slug = pub_slug + '-v2'
        if await session.scalar(select(Publication.id).where(
                Publication.project_id == project.id, Publication.slug == second_slug)) is None:
            await publish_report(organization.slug, project.slug,
                PublicationCreate(report_id=rep1.id, version_id=rep1.version_id, slug=second_slug,
                    citation={'title': 'Executed binding benchmark — second edition',
                              'authors': [user.username], 'year': 2026}), user, session)
        if not pub.withdrawn:
            await delete_publication(organization.slug, project.slug, pub_slug, user, session)

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
        from openbinding_gateway.reports import create_report_context
        await create_report_context(session, project, user, slug=draft_slug,
            title="Parallel Scaling Working Notes (Draft)", document=draft_doc,
            study_run_id=executed_studies[1][1].id if len(executed_studies) > 1 else None)

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
) -> list[Blob]:
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

    created_artifacts: list[Blob] = []

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
                select(Blob).where(Blob.project_id == proj.id, Blob.digest == digest_value)
            )
        ).scalars().first()

        if existing is None:
            artifact = Blob(
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
                    target_type="Blob",
                    target_id=artifact.id,
                    detail={"digest": digest_value, "media_type": media_type, "size_bytes": len(raw_bytes), "name": display_name},
                )
            )
            created_artifacts.append(artifact)
            logger.info("Created Blob '%s' (%s, %d bytes) in '%s'", display_name, digest_value[:20] + "...", len(raw_bytes), proj.slug)
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
    print("        ├── Analysis: binding-analysis-gallery (canonical diagnostic archives and draft decisions; not solver benchmarks)")
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
    print(f"    curl -H 'x-api-key: {alice_key}' http://localhost:8000/v1/organizations/score-ai/projects/qos-placement/blobs")
    print("    curl http://localhost:8000/v1/explore/projects")
    print("\n  [Universal Cryptographic Resolver & Verifier]")
    print("    GET /v1/resolve/artifact/{digest}            (Metadata, locations, and provenance)")
    print("    GET /v1/resolve/artifact/{digest}/content    (Raw payload with immutable/private cache headers)")
    print("    GET /v1/resolve/case-revision/{digest}       (Binding case revision)")
    print("    GET /v1/resolve/report/{digest}              (Empirical study reports)")
    print(banner + "\n")


async def main() -> int:
    parser = argparse.ArgumentParser(description="Seed OpenBinding database with development data.")
    parser.add_argument("--reset", action="store_true", help="Rebuild all local OpenBinding development tables before seeding (never SPHERE or SPACE).")
    parser.add_argument("--analysis-only", action="store_true", help="Add the analysis gallery to existing development users/projects without running engines or reseeding other data.")
    parser.add_argument("--analysis-full", action="store_true", help="Opt in to live jobs and 1,000/10,000/100,000 unique-binding analysis archives.")
    parser.add_argument("--analysis-manifest", type=Path, default=Path("tools/analysis-manifest.json"), help="Write source, report, task and verification coverage links.")
    parser.add_argument("--verbose", action="store_true", help="Enable debug logging.")
    parser.add_argument("--force-prod", action="store_true", help="Bypass production environment safety guard.")
    args = parser.parse_args()
    if args.analysis_only and args.analysis_full:
        parser.error("--analysis-only and --analysis-full are mutually exclusive")
    if args.analysis_only and args.reset:
        parser.error("--analysis-only cannot be combined with --reset")

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
            if args.analysis_only:
                user = (await session.execute(select(User).where(User.username == "alice"))).scalars().first()
                org = (await session.execute(select(Organization).where(Organization.slug == "score-ai"))).scalars().first()
                project = None if org is None else (await session.execute(select(Project).where(Project.organization_id == org.id, Project.slug == "qos-placement"))).scalars().first()
                if user is None or org is None or project is None:
                    raise ValueError("Run the normal development seeder once before --analysis-only")
                await prepare_analysis_workspace(session, org, project, user, examples_dir, manifest_path=args.analysis_manifest)
                await session.commit()
                logger.info("Analysis gallery ready: /app/score-ai/qos-placement/analytics (sign in as alice)")
                return 0
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
            live_jobs = await ensure_standalone_jobs(session, org_map["score-ai"], qos_project, user_map["alice"], snapshots=snapshots, all_states=True)

            # 7. Studies & Real Job Executions
            executed_studies = await execute_real_studies(session, org_map["score-ai"], qos_project, user_map["alice"], case_map)

            await prepare_analysis_workspace(session, org_map["score-ai"], qos_project, user_map["alice"], examples_dir, full=args.analysis_full, manifest_path=args.analysis_manifest, live_jobs=live_jobs, study_runs=executed_studies)

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
