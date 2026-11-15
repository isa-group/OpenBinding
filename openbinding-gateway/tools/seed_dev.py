#!/usr/bin/env python3
"""Populate the OpenBinding database with rich development data.

Seeds users, hierarchical organizations, projects, BIM problems of an
organization (uploaded from examples/demo), comparative studies with REAL
solver jobs executed against available engines (or gracefully handled),
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
import logging
import os
import sys
import uuid
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

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from openbinding_gateway import space_client
from openbinding_gateway.core.settings import get_settings
from openbinding_gateway.db import base as db_base
from openbinding_gateway.db.models import (
    ApiKey,
    EngineRegistrationRevision,
    EngineRevision,
    Job,
    User,
    UserRole,
    utcnow,
)
from openbinding_gateway.db.platform_models import (
    AuditEvent,
    BindingCase,
    BindingCaseRevision,
    Notification,
    Organization,
    OrganizationMembership,
    OrganizationRole,
    Project,
    RunState,
    Study,
    StudyCell,
    StudyRun,
    StudyState,
    Visibility,
)
from openbinding_gateway.models.platform import StudyDefinition
from openbinding_gateway.integrations import bim, packages
from openbinding_gateway.security.apikeys import ADMIN_PERMISSIONS, ALL_PERMISSIONS, hash_key
from openbinding_gateway.security.passwords import hash_password
from openbinding_gateway.services.engines import manifest as engine_manifest, protocol_digest
from openbinding_gateway.modules.problems.application import add_revision, create_problem
from openbinding_gateway.studies import expand_study
from openbinding_gateway.study_jobs import StudyLaunchError, launch_study_cell
from bim_core.canonical import digest

logger = logging.getLogger("seed_dev")

DEV_PASSWORD = "devpass123"

# Seed users definition
SEED_USERS = [
    {"username": "admin", "email": "admin@example.org", "role": UserRole.ADMIN, "plan": "LAB", "key_suffix": "admin0001"},
    {"username": "alice", "email": "alice@example.org", "role": UserRole.USER, "plan": "RESEARCH", "key_suffix": "alice0001"},
    {"username": "bob", "email": "bob@example.org", "role": UserRole.USER, "plan": "LAB", "key_suffix": "bob000001"},
    {"username": "carol", "email": "carol@example.org", "role": UserRole.USER, "plan": "FREE", "key_suffix": "carol0001"},
    {"username": "david", "email": "david@example.org", "role": UserRole.USER, "plan": "RESEARCH", "key_suffix": "david0001"},
    {"username": "elena", "email": "elena@example.org", "role": UserRole.USER, "plan": "RESEARCH", "key_suffix": "elena0001"},
    {"username": "frank", "email": "frank@example.org", "role": UserRole.USER, "plan": "FREE", "key_suffix": "frank0001"},
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
        # Everything goes, not just the tables the models know: an older baseline leaves orphan
        # tables (and, on PostgreSQL, trigger functions) that metadata.drop_all cannot see.
        if sync_connection.dialect.name == 'postgresql':
            sync_connection.execute(text('DROP SCHEMA public CASCADE'))
            sync_connection.execute(text('CREATE SCHEMA public'))
        else:
            # SQLite enforces no foreign keys here, so the order does not matter; triggers and
            # indexes go with their tables.
            names = sync_connection.execute(text(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
            )).scalars().all()
            for name in names:
                sync_connection.execute(text(f'DROP TABLE IF EXISTS "{name}"'))
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

        plan = entry.get("plan", "FREE")
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


async def ensure_space_contracts(session: AsyncSession, users: dict[str, User]) -> None:
    """Ensure every seeded user has an active, valid contract in SPACE."""
    settings = get_settings()
    if not settings.space_enabled:
        logger.debug("SPACE is disabled in settings; skipping external contract provisioning.")
        return

    from openbinding_gateway.access.contracts import live_pricing_version

    try:
        gate = space_client.build_gate(settings)
        space_client.set_gate(gate)
    except Exception as gate_err:
        logger.warning("Could not initialize pricing gate: %s", gate_err)
        return

    # Contracts are created through SPACE's official client; the version is
    # SPACE_PRICING_VERSION and SPACE validates the plan against it.
    pricing_ver = live_pricing_version(settings)
    if not pricing_ver:
        logger.warning("SPACE_PRICING_VERSION is not set; skipping external contract provisioning.")
        return

    for entry in SEED_USERS:
        username = entry["username"]
        user = users.get(username)
        if not user:
            continue
        plan = entry.get("plan", "FREE")
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
            m = engine_manifest(engine_name)
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
                protocol_digest=protocol_digest(),
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


#: The problems of the seed: slug, name, description and the example package each one is uploaded from.
PROBLEMS = [
    ("simple-seq", "Sequential Service Workflow", "Sequential pipeline with strict latency bounds", "01_simple_seq"),
    ("parallel-mesh", "Parallel Fork-Join Mesh", "Parallel branch orchestration with concurrent synchronization", "02_parallel"),
    ("multi-objective", "Multi-Objective Pareto Case", "Cost vs latency vs availability trade-off problem", "05_multi_obj"),
]


async def ensure_cases(
    session: AsyncSession,
    organization: Organization,
    user: User,
    examples_dir: Path,
) -> dict[str, tuple[BindingCase, BindingCaseRevision]]:
    """Upload the demo packages as problems of ``organization``; an existing one gets the same revision back."""
    problems: dict[str, tuple[BindingCase, BindingCaseRevision]] = {}
    for slug, name, description, sample in PROBLEMS:
        path = examples_dir / "demo" / sample
        if not (path / "instance.json").exists():
            logger.warning("Example path '%s' does not exist; skipping problem '%s'", path, slug)
            continue
        archive = packages.zip_directory(path)
        try:
            existing = await session.scalar(
                select(BindingCase).where(BindingCase.organization_id == organization.id, BindingCase.slug == slug)
            )
            if existing is None:
                upload = await create_problem(
                    session, organization, archive, user, slug=slug, name=name, description=description,
                    provenance={"producer": "seed_dev"},
                )
                logger.info("Created problem '%s/%s'", organization.slug, slug)
            else:
                upload = await add_revision(session, existing, archive, user, provenance={"producer": "seed_dev"})
            problems[slug] = (upload.problem, upload.revision)
        except Exception as exc:
            logger.exception("Failed to upload example '%s': %s", sample, exc)
    return problems


async def execute_real_studies(
    session: AsyncSession,
    org: Organization,
    project: Project,
    user: User,
    case_map: dict[str, tuple[BindingCase, BindingCaseRevision]],
) -> list[tuple[Study, StudyRun]]:
    """Dispatch bounded studies once; the production worker advances their cells."""
    engine_refs = []
    # Study engines pin an exact revision plus an explicit mode and execution optimization.
    for name, mode in (("minizinc-csp", "exact-weighted"), ("random-search", "seeded")):
        try:
            manifest = engine_manifest(name)
            engine_refs.append({**{key: manifest["metadata"][key] for key in ("namespace", "name", "version")},
                                "digest": digest(manifest), "mode": mode,
                                "optimization": {"type": "SINGLE", "scalarization": "weighted-sum"}})
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
        identity = digest({"matrix": expanded, "generator": 3, "evaluator": bim.toolchain_digest()})
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
                await launch_study_cell(session, cells[0], user, org)
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
    user: User,
    problems: dict[str, tuple[BindingCase, BindingCaseRevision]] | None = None,
    all_states: bool = False,
) -> list[Job]:
    """Execute bounded real runs of a problem revision of ``org``; unchanged scenarios reuse their persisted outcomes."""
    from openbinding_gateway.job_dispatch import _execute
    from openbinding_gateway.modules.execution.application import RunRequest
    from openbinding_gateway.services.job_submission import JobSubmission

    chosen = (problems or {}).get("simple-seq") or next(iter((problems or {}).values()), None)
    if chosen is None:
        logger.warning("Live-job coverage gap: no problem revision; no solver outcome was manufactured")
        return []
    revision = chosen[1]
    jobs = []
    scenarios = [("minizinc-csp", "exact-weighted", {"time_budget_ms": 10000, "solver": "gecode"}),
                 ("random-search", "seeded", {"iterations": 128, "seed": 42})]
    for engine, mode, options in scenarios:
        try:
            manifest = engine_manifest(engine)
            ref = {"namespace": manifest["metadata"]["namespace"], "name": engine,
                   "version": manifest["metadata"]["version"], "digest": digest(manifest)}
            optimization = {"type": "SINGLE", "scalarization": "weighted-sum"}
            identity = digest({"generator": 4, "package": revision.package_digest, "evaluator": bim.toolchain_digest(),
                               "engine": ref, "mode": mode, "optimization": optimization, "options": options})
            key = f"development-live-{org.id}-{identity}"
            existing = (await session.execute(select(Job).where(Job.owner_id == user.id, Job.idempotency_key == key))).scalars().first()
            if existing is not None:
                jobs.append(existing)
                logger.info("Reused live scenario %s: %s (%s)", engine, existing.id, existing.state.value)
                continue
            request = RunRequest(organization_id=org.id, revision_id=str(revision.id), engine=ref, mode=mode,
                                 optimization=optimization, options=options, idempotency_key=key)
            result = await JobSubmission(session, user).submit(request)
            if result.kind == "problem":
                raise RuntimeError(f"{result.body.get('code')}: {result.body.get('detail')}")
            job = await session.get(Job, uuid.UUID(str(result.body["id"])))
            await session.commit()
            await _execute(str(job.id))
            await session.refresh(job)
            jobs.append(job)
            logger.info("Live scenario %s: %s (%s, %s)", engine, job.id, job.state.value, job.termination)
        except Exception as exc:
            logger.warning("Live-job coverage gap for %s: %s", engine, exc)
    return jobs


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
        plan = u_spec.get("plan", "FREE")
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
    print("        ├── Studies: exact-vs-heuristic (Real Runs & Jobs), parallel-scaling-study")
    print("        └── Artifacts: benchmark datasets, execution traces, reproducibility package")
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
    print(banner + "\n")


async def main() -> int:
    parser = argparse.ArgumentParser(description="Seed OpenBinding database with development data.")
    parser.add_argument("--reset", action="store_true", help="Rebuild all local OpenBinding development tables before seeding (never SPHERE or SPACE).")
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

    space_client.set_gate(space_client.build_gate(settings))

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

            # 4. Problems of an organization, uploaded from the demo packages
            qos_project = project_map["score-ai/qos-placement"]
            case_map = await ensure_cases(session, org_map["score-ai"], user_map["alice"], examples_dir)

            # 5. Standalone solve jobs
            await ensure_standalone_jobs(session, org_map["score-ai"], user_map["alice"], problems=case_map, all_states=True)

            # 6. Studies & Real Job Executions
            await execute_real_studies(session, org_map["score-ai"], qos_project, user_map["alice"], case_map)

            # 7. Notifications & Audit
            await ensure_notifications_and_audit(session, org_map, project_map, user_map)

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
