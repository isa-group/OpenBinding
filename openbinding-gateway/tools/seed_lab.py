#!/usr/bin/env python3
"""Idempotent local seed for the demo: synthetic users with the real roles, two
organizations, a small BIM package from ``examples/`` as a problem of each, and the
compositions the walks and the showcase read.

Every synthetic user also gets its personal organization (``<username> PERSONAL``, slug = the username, the user
its OWNER), as every account does (``services.organizations.ensure_personal_organization``); the walks and the
showcase use ``lab-main`` and ``lab-other`` only.

Safe to run on an empty or an already seeded database: every row is looked up by
a stable key (UUIDv5 ids by username/slug, the problem by its slug and package digest,
a composition by its organization and slug, a version by its bytes) and created only
when missing; there is no ``--reset`` and no user, organization, problem, revision or
composition is ever deleted. It also compiles, with the installed bim-toolchain, every
problem revision that has no compilation of it yet (a new row; the older compilations
stay). It launches no jobs, no studies and no solvers, so the compositions are derived
from bindings of the problems, through the platform's own derivation and seal.
Importing this module has no side effects.

The compositions (F2a):

- ``lab-main/sequential-workflow``: derived from ``lab-main/simple-seq@1`` twice, 1.0.0
  with the first eligible candidate of every task, then 1.1.0 with the first task that has
  two candidates moved to its second one. Private.
- ``lab-other``: its own ``simple-seq`` problem, the same package uploaded by
  ``lab-outsider``; ``sequential-workflow`` derived from it and **public** (the slug of
  lab-main's, so forking it into lab-main meets the name taken); ``order-desk``, declared and
  **public**; ``internal-draft``, declared and private.

The public list therefore holds two compositions, both of lab-other.

From SPHERE (F3, F4), when SPHERE is enabled and reachable, through the TomatoMeter composition template
(``examples/templates/tomatometer.json``, the same function as ``POST …/compositions/from-template``):

- ``lab-main/tomatometer-email``: revision 1 is ``examples/tomatometer/tomatometer-email.base.json`` (zipped),
  revision 2 ``email-recipe.json`` and revision 3 ``tomatometer-recipe.json`` previewed and applied on it
  (``sphere/expand`` and ``sphere/apply``: real SPHERE pricing and version ids, the value origins recorded);
- ``lab-main/tomatometer`` 1.0.0: derived from revision 3 with Brevo PROFESSIONAL, Dropbox PLUS and ZenQuotes and
  the offering ``sphere/tomatometer``, read when it is sealed (its bytes are ``examples/tomatometer/composition.yaml``);
  1.1.0: the same with the e-mail provider switched to Resend PRO;
- the environments of ``tomatometer``: ``production`` (operator ``lab-owner``, ADMIN adopts, 1000 expected users,
  1.0.0 adopted by ``lab-owner``, one feed key derived from the demo password, ``feed_key_for``) and ``staging``
  (MEMBER adopts, nothing adopted, no key). With ``LAB_HANDOFF_DIR`` set, ``openbinding.json`` there (mode 0600)
  tells a consumer the feed's address and key (``write_handoff``).

With SPHERE disabled or unreachable these steps log ``sphere: skipped`` and the seed goes on. The ``order-desk``
offering stays a URL on ``pricings.example.org``, which never resolves: its evaluation records the offering as
unreadable.

Environment:
    DEMO_SEED_PASSWORD   required; password of every synthetic user (at least 10 chars).
                         API keys are derived from it (HMAC) and are not printed
                         unless --print-keys is given.
    DATABASE_URL         the gateway's database (read through the gateway settings).
    LAB_HANDOFF_DIR      optional; a directory the seed writes the feed hand-off file to (the lab's
                         ``seed`` service sets it to the ``lab-handoff`` volume, ``/handoff``).
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
import json
import logging
import os
import re
import sys
import uuid
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
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
    ProblemCompilation,
    User,
    UserRole,
)
from openbinding_gateway.db.platform_models import (
    BindingCase,
    BindingCaseRevision,
    Composition,
    CompositionDerivation,
    CompositionEnvironment,
    CompositionEnvironmentKey,
    CompositionKind,
    CompositionVersion,
    Organization,
    OrganizationMembership,
    OrganizationRole,
)
from openbinding_gateway.integrations import packages
from openbinding_gateway.modules.compositions.application import (
    derive_version,
    installed_compilation,
    judge,
    persist,
)
from openbinding_gateway.modules.compositions.application import adoption, environments, feed_keys, templates
from openbinding_gateway.modules.compositions.application.offering import before_seal
from openbinding_gateway.modules.compositions.domain.environments import AdoptRole
from openbinding_gateway.modules.plans.application import PricingError, installed_pricing_source
from openbinding_gateway.modules.problems.application import (
    NOT_RECOMPILABLE,
    add_revision,
    compile_or_get,
    create_problem,
)
from openbinding_gateway.services.organizations import ensure_personal_organization, personal_slug
from openbinding_gateway.space_client import OpenGate
from openbinding_gateway.security.apikeys import ADMIN_PERMISSIONS, ALL_PERMISSIONS, MintedKey, hash_key
from openbinding_gateway.security.passwords import hash_password, password_complaint, verify_password

logger = logging.getLogger("seed_lab")

#: Fixed, arbitrary namespace for the stable UUIDv5 ids of the lab rows.
SEED_NAMESPACE = uuid.UUID("6f1d3a52-8c0e-4b7a-9d21-0f5e7c3a9b10")
EMAIL_DOMAIN = "example.org"
DEMO_PACKAGE = "01_simple_seq"
MAIN_ORG = "lab-main"
OTHER_ORG = "lab-other"
CASE_SLUG = "simple-seq"
#: The composition derived from each organization's problem (lab-main's private, lab-other's public):
#: slug, name and description.
LINKED_COMPOSITION = (
    "sequential-workflow", "Sequential workflow",
    "Three services in sequence, bound from the simple-seq problem; its latency is computed on that problem.",
)
#: lab-other's declared compositions: public, and private.
PUBLIC_DECLARED = (
    "order-desk", "Order desk",
    "Signs customers in, sends a notice and archives the order in parallel, then ships by post or by courier.",
)
PRIVATE_DECLARED = ("internal-draft", "Internal draft", "Not shared outside the organization.")
#: lab-main's problem built from SPHERE pricings (F3) and the composition derived from it, both made by the
#: TomatoMeter composition template (F4); the template's manifest holds the problem, the binding and the offering.
TOMATOMETER_TEMPLATE = "tomatometer"
TOMATOMETER = "tomatometer-email"
TOMATOMETER_SLUG = "tomatometer"
#: 1.1.0 changes only the e-mail provider of 1.0.0: the version the demo adopts.
TOMATOMETER_SWITCH = ("1.1.0", {"dailySummary": "email.resend.pro"})
#: The environments of ``tomatometer``: slug, name, description, operator, who adopts, expected users, the version
#: adopted by the operator (``None``: nothing) and whether it gets a feed key (a consumer reads it).
TOMATOMETER_ENVIRONMENTS = (
    ("production", "Production", "What TomatoMeter reads in production.", "lab-owner", AdoptRole.ADMIN, 1000,
     "1.0.0", True),
    ("staging", "Staging", "Where a member tries a version before production.", None, AdoptRole.MEMBER, None,
     None, False),
)
#: The hand-off file a consumer of the lab's feed reads (the feed consumer, TomatoMeter's server).
HANDOFF_FILE = "openbinding.json"
#: The feed's address inside the lab's compose network, through the lab nginx (``frontend/nginx.lab.conf``).
FEED_URL = (
    "http://web:8080/api/v1/organizations/lab-main/compositions/tomatometer/environments/production/composition"
)
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
#: (slug, name, creator username)
ORGANIZATIONS = (
    ("lab-main", "Lab Main Organization", "lab-owner"),
    ("lab-other", "Lab Other Organization", "lab-outsider"),
)


#: lab-other's public declared composition: it links no problem, so its values are the ones written here.
ORDER_DESK = """\
syntaxVersion: "1.0"
composition: order-desk
version: 1.0.0
kind: application
workflow:
  seq:
    - signIn
    - and: [notify, archive]
    - xor:
        - {probability: 0.7, flow: post}
        - {probability: 0.3, flow: courier}
binding:
  signIn: {local: true}
  notify: {candidate: email.brevo.starter, from: {sphere: danruilop1/brevo, version: 6ade2d444b2b5b01c587d80d, plan: STARTER}}
  archive: {candidate: storage.dropbox.plus}
  post: {candidate: shipping.post.standard}
  courier: {candidate: shipping.courier.express}
values:
  availability: 0.995
  cost: {value: 42.5, unit: EUR/month}
  latency: {value: 380, unit: ms}
offering: {url: "https://pricings.example.org/order-desk/pricing.yml"}
"""

#: lab-other's private declared composition: what a visitor must not find.
INTERNAL_DRAFT = """\
syntaxVersion: "1.0"
composition: internal-draft
version: 0.1.0
kind: workflow
workflow:
  seq: [intake, review]
binding:
  intake: {local: true}
  review: {candidate: review.desk.basic}
values:
  latency: {value: 900, unit: ms}
"""


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


def feed_key_for(password: str, organization: str, composition: str, environment: str) -> MintedKey:
    """The lab's deterministic feed key of one environment, derived from the demo password as ``api_key_for``
    derives the personal keys; whoever holds the password (the seed, ``smoke_lab``, the live walks) derives it."""
    message = f"openbinding-lab-seed:feedkey:{organization}/{composition}/{environment}".encode()
    digest = hmac.new(password.encode("utf-8"), message, hashlib.sha256).hexdigest()
    prefix = f"obe_{digest[:8]}"
    full = f"{prefix}_{digest[8:]}"
    return MintedKey(secret=full, prefix=prefix, secret_hash=hash_key(full))


class HandoffError(RuntimeError):
    """The hand-off directory is missing or not writable."""


def write_handoff(directory: str, *, organization: str, composition: str, environment: str, key: str) -> Path:
    """``openbinding.json`` in ``directory`` (mode 0600): the feed's address and key for the lab's consumers."""
    folder = Path(directory)
    if not folder.is_dir():
        raise HandoffError(f"LAB_HANDOFF_DIR {directory} is not a directory")
    target = folder / HANDOFF_FILE
    document = {
        "organization": organization, "composition": composition, "environment": environment,
        "feedUrl": FEED_URL, "feedKey": key,
    }
    temporary = folder / f".{HANDOFF_FILE}.tmp"
    try:
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(document, handle, indent=2, sort_keys=True)
            handle.write("\n")
        os.chmod(temporary, 0o600)
        os.replace(temporary, target)
    except OSError as exc:
        raise HandoffError(f"LAB_HANDOFF_DIR {directory} is not writable: {exc.strerror or exc}") from None
    return target


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
        if await session.scalar(select(Organization.id).where(Organization.personal_owner_id == user.id)) is None:
            await ensure_personal_organization(session, user)
            created.append(f"personal-organization:{personal_slug(username)}")

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
    for slug, name, creator in ORGANIZATIONS:
        organization = await session.scalar(select(Organization).where(Organization.slug == slug))
        if organization is None:
            organization = Organization(
                id=stable_id("organization", slug),
                slug=slug,
                name=name,
                parent_id=None,
                created_by_id=users[creator].id,
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


async def ensure_case(
    session: AsyncSession, organization: Organization, user: User, examples_dir: Path, created: list[str]
) -> BindingCaseRevision:
    """The demo package as the problem ``CASE_SLUG`` of ``organization``; the same package is the same revision."""
    archive = packages.zip_directory(examples_dir / "demo" / DEMO_PACKAGE)
    problem = await session.scalar(
        select(BindingCase).where(BindingCase.organization_id == organization.id, BindingCase.slug == CASE_SLUG)
    )
    if problem is None:
        upload = await create_problem(
            session, organization, archive, user, slug=CASE_SLUG, name="Sequential Service Workflow",
            description="Sequential pipeline with strict latency bounds (synthetic demo).",
            provenance={"producer": "seed_lab"},
        )
        created.append(f"case:{organization.slug}/{CASE_SLUG}")
    else:
        upload = await add_revision(session, problem, archive, user, provenance={"producer": "seed_lab"})
    if upload.created:
        created.append(f"case-revision:{organization.slug}/{CASE_SLUG}:{upload.revision.revision}")
    return upload.revision


@dataclass(frozen=True)
class CompileFailure:
    """A revision the installed toolchain does not accept: ``code`` and the toolchain's ``reason``."""

    revision_id: str
    code: str
    reason: dict[str, Any] | None = None


async def ensure_current_toolchain(session: AsyncSession, created: list[str]) -> list[CompileFailure]:
    """Give every problem revision a compilation by the installed toolchain (``compile_or_get``).

    After a release of bim-toolchain that changes the IR, the revisions a seeded lab holds were compiled by
    the previous one. Their packages are stored, so a new compilation row is added for the installed
    toolchain; the older rows, and every revision id, stay. A revision the toolchain refuses is reported and
    left as it is. On a lab that is already current this changes nothing.
    """
    from fastapi import HTTPException

    failures: list[CompileFailure] = []
    for revision in (await session.scalars(select(BindingCaseRevision).order_by(BindingCaseRevision.created_at))).all():
        before = int(await session.scalar(
            select(func.count()).select_from(ProblemCompilation).where(ProblemCompilation.revision_id == revision.id)
        ) or 0)
        try:
            await compile_or_get(session, revision)
        except HTTPException as exc:
            detail = exc.detail if isinstance(exc.detail, dict) else {}
            failures.append(CompileFailure(str(revision.id), str(detail.get("code") or NOT_RECOMPILABLE), detail.get("reason")))
            continue
        after = int(await session.scalar(
            select(func.count()).select_from(ProblemCompilation).where(ProblemCompilation.revision_id == revision.id)
        ) or 0)
        if after > before:
            created.append(f"compiled-revision:{revision.id}")
    return failures


def lab_bindings(compilation: ProblemCompilation) -> tuple[dict[str, str], dict[str, str]]:
    """Two bindings of a compiled problem: the first eligible candidate of every service task, and the same with
    the first task that has two candidates moved to its second one (in ``01_simple_seq``, ``t1`` from ``c1a`` to
    ``c1b``)."""
    spec = compilation.ir["spec"]
    eligible = {
        task: [candidate["id"] for candidate in spec["eligibility"][task]]
        for task, body in spec["application"]["tasks"].items()
        if body["kind"] == "service"
    }
    first = {task: candidates[0] for task, candidates in eligible.items()}
    moved = next((task for task, candidates in eligible.items() if len(candidates) > 1), None)
    if moved is None:
        raise RuntimeError(f"{DEMO_PACKAGE} has no task with two eligible candidates; the lab's compositions need one")
    return first, {**first, moved: eligible[moved][1]}


async def ensure_composition(
    session: AsyncSession, organization: Organization, user: User, identity: tuple[str, str, str],
    kind: CompositionKind, visibility: str, created: list[str],
) -> Composition:
    """The composition ``identity`` (slug, name, description) of ``organization``, created when missing; its
    visibility is the seed's."""
    slug, name, description = identity
    composition = await session.scalar(
        select(Composition).where(Composition.organization_id == organization.id, Composition.slug == slug)
    )
    if composition is None:
        composition = Composition(
            id=stable_id("composition", f"{organization.slug}/{slug}"), organization_id=organization.id, slug=slug,
            name=name, description=description, kind=kind, visibility=visibility, created_by_id=user.id,
        )
        session.add(composition)
        await session.commit()
        created.append(f"composition:{organization.slug}/{slug}")
    elif composition.visibility != visibility:
        composition.visibility = visibility
        await session.commit()
    return composition


async def labelled(session: AsyncSession, composition: Composition, label: str) -> CompositionVersion | None:
    """The version of ``composition`` labelled ``label``, if it has one."""
    return await session.scalar(
        select(CompositionVersion).where(CompositionVersion.composition_id == composition.id, CompositionVersion.label == label)
    )


async def seal_derived(
    session: AsyncSession, organization: Organization, composition: Composition, user: User,
    revision: BindingCaseRevision, label: str, binding: Mapping[str, str], created: list[str],
) -> CompositionVersion:
    """``binding`` of ``CASE_SLUG@revision`` derived and sealed as ``label``, unless the composition has a version
    by that label already (after a toolchain release the same binding links another compilation, so its bytes
    differ: the seeded version stays as it was sealed)."""
    existing = await labelled(session, composition, label)
    if existing is not None:
        return existing
    derived = await derive_version(
        session, organization, composition, caller=user, label=label,
        revision=f"{CASE_SLUG}@{revision.revision}", binding=dict(binding),
    )
    assessment = await _before_seal(session, organization, derived.assessment, user, derived.content, composition)
    sealed = await persist(session, composition, assessment, actor=user, derivation=derived.derivation)
    if sealed.created:
        created.append(f"composition-version:{organization.slug}/{composition.slug}@{label}")
    return sealed.version


async def seal_declared(
    session: AsyncSession, organization: Organization, composition: Composition, user: User, label: str,
    document: str, created: list[str],
) -> CompositionVersion:
    """``document`` (its ``version:`` is ``label``) judged and sealed as written, its values declared, unless the
    composition has a version by that label already."""
    existing = await labelled(session, composition, label)
    if existing is not None:
        return existing
    checked = await judge(session, organization, composition.slug, document.encode("utf-8"), user)
    if checked.assessment is None or not checked.valid:
        raise RuntimeError(
            f"the seed's composition {organization.slug}/{composition.slug} is refused: "
            + "; ".join(map(str, checked.diagnostics))
        )
    assessment = await _before_seal(session, organization, checked.assessment, user, document, composition)
    sealed = await persist(session, composition, assessment, actor=user)
    if sealed.created:
        created.append(f"composition-version:{organization.slug}/{composition.slug}@{label}")
    return sealed.version


async def _before_seal(session: AsyncSession, organization: Organization, assessment: Any, user: User, source: str,
                       composition: Composition) -> Any:
    """The seal pre-phase of the routes (the offering read, the ``from`` snapshots) when a pricing source is
    installed; the assessment as it is otherwise."""
    if installed_pricing_source() is None:
        return assessment
    return await before_seal(session, organization, assessment, user, source=source, composition_id=composition.id)


def _sphere_skipped(reason: str) -> dict[str, Any]:
    logger.warning("sphere: skipped (%s)", reason)
    return {"status": "skipped", "reason": reason}


async def ensure_sphere(
    session: AsyncSession, organizations: Mapping[str, Organization], users: Mapping[str, User], password: str,
    created: list[str], *, handoff_dir: str | None = None,
) -> dict[str, Any]:
    """``lab-main/tomatometer`` from its composition template, 1.1.0, its environments and feed key, and the
    hand-off file (module docstring), or why they were skipped. Rows that exist are left as they are."""
    from fastapi import HTTPException

    if installed_pricing_source() is None or not templates.sphere_available():
        return _sphere_skipped("SPHERE is not enabled")
    organization, user = organizations[MAIN_ORG], users["lab-owner"]
    try:
        composition = await session.scalar(select(Composition).where(
            Composition.organization_id == organization.id, Composition.slug == TOMATOMETER_SLUG,
        ))
        if composition is None:
            made = await templates.instantiate(session, organization, user, TOMATOMETER_TEMPLATE, slug=TOMATOMETER_SLUG)
            composition = made.composition
            created.append(f"case:{organization.slug}/{made.problem_slug}")
            created.append(f"composition:{organization.slug}/{composition.slug}")
            created.append(f"composition-version:{organization.slug}/{composition.slug}@{made.sealed.version.label}")
        first = await labelled(session, composition, templates.template(TOMATOMETER_TEMPLATE).composition["label"])
        if first is None:
            return _sphere_skipped("tomatometer has no version 1.0.0")
        derivation = await session.scalar(select(CompositionDerivation).where(CompositionDerivation.version_id == first.id))
        revision = await session.get(BindingCaseRevision, derivation.revision_id)
        label, change = TOMATOMETER_SWITCH
        if await labelled(session, composition, label) is None:
            spec = templates.template(TOMATOMETER_TEMPLATE).composition
            derived = await derive_version(
                session, organization, composition, caller=user, label=label, offering=spec["offering"],
                revision=f"{TOMATOMETER}@{revision.revision}", binding={**spec["binding"], **change},
            )
            assessment = await before_seal(session, organization, derived.assessment, user, source=derived.content,
                                           composition_id=composition.id)
            sealed = await persist(session, composition, assessment, actor=user, derivation=derived.derivation)
            if sealed.created:
                created.append(f"composition-version:{organization.slug}/{composition.slug}@{label}")
        keyed = await ensure_environments(session, organization, composition, users, password, created)
    except (PricingError, HTTPException) as exc:
        await session.rollback()
        detail = getattr(exc, "detail", None)
        return _sphere_skipped(str(detail.get("code") if isinstance(detail, dict) else exc)[:200])
    handoff = None
    if handoff_dir:
        environment, key = keyed
        handoff = str(write_handoff(handoff_dir, organization=organization.slug, composition=composition.slug,
                                    environment=environment, key=key))
    return {"status": "seeded", "problem": TOMATOMETER, "revision": revision.revision,
            "composition": str(composition.id), "versions": ["1.0.0", label],
            "environments": [item[0] for item in TOMATOMETER_ENVIRONMENTS], "handoff": handoff}


async def ensure_environments(
    session: AsyncSession, organization: Organization, composition: Composition, users: Mapping[str, User],
    password: str, created: list[str],
) -> tuple[str, str]:
    """The environments of ``TOMATOMETER_ENVIRONMENTS``, their first adoption and feed key, made when missing;
    answers the environment a consumer reads and its derived feed key."""
    from openbinding_gateway.core import revision as etags

    owner = users["lab-owner"]
    keyed: tuple[str, str] | None = None
    for slug, name, description, operator, adopt_role, expected, adopt, with_key in TOMATOMETER_ENVIRONMENTS:
        row = await session.scalar(select(CompositionEnvironment).where(
            CompositionEnvironment.composition_id == composition.id, CompositionEnvironment.slug == slug,
        ))
        if row is None:
            row = await environments.create_environment(
                session, organization, composition, owner, slug=slug, name=name, description=description,
                operator=operator, adopt_role=adopt_role, expected_users=expected,
            )
            await session.commit()
            created.append(f"environment:{organization.slug}/{composition.slug}/{slug}")
            if adopt is not None:
                adopted = await adoption.adopt(
                    session, organization=organization, composition=composition, environment=row,
                    role=OrganizationRole.OWNER, version_ref=adopt, actor=owner, if_match=etags.etag_for(row),
                    note="Seeded by the lab", source="direct", proposal_id=None,
                )
                row = adopted.environment
                created.append(f"adoption:{organization.slug}/{composition.slug}/{slug}@{adopt}")
        if with_key:
            minted = feed_key_for(password, organization.slug, composition.slug, slug)
            exists = await session.scalar(select(CompositionEnvironmentKey.id).where(
                CompositionEnvironmentKey.prefix == minted.prefix,
            ))
            if exists is None:
                await feed_keys.mint_key(session, composition, row, owner, "Lab feed consumer", minted=minted)
                await session.commit()
                created.append(f"feed-key:{organization.slug}/{composition.slug}/{slug}")
            keyed = keyed or (slug, minted.secret)
    assert keyed is not None
    return keyed


async def ensure_compositions(
    session: AsyncSession, organizations: Mapping[str, Organization], users: Mapping[str, User],
    revisions: Mapping[str, BindingCaseRevision], created: list[str],
) -> dict[str, str]:
    """The compositions of the module docstring; their ids by ``<organization>/<slug>``."""
    ids: dict[str, str] = {}
    for org_slug, author, visibility, labels in (
        (MAIN_ORG, "lab-owner", "private", ("1.0.0", "1.1.0")),
        (OTHER_ORG, "lab-outsider", "public", ("1.0.0",)),
    ):
        organization, user, revision = organizations[org_slug], users[author], revisions[org_slug]
        installed, refusal = await installed_compilation(session, revision)
        if installed is None:
            raise RuntimeError(f"{org_slug}/{CASE_SLUG}@{revision.revision} does not compile: {refusal}")
        bindings = lab_bindings(installed)
        composition = await ensure_composition(
            session, organization, user, LINKED_COMPOSITION, CompositionKind.WORKFLOW, visibility, created,
        )
        for label, binding in zip(labels, bindings[: len(labels)], strict=True):
            await seal_derived(session, organization, composition, user, revision, label, binding, created)
        ids[f"{org_slug}/{composition.slug}"] = str(composition.id)

    other, outsider = organizations[OTHER_ORG], users["lab-outsider"]
    for identity, kind, visibility, label, document in (
        (PUBLIC_DECLARED, CompositionKind.APPLICATION, "public", "1.0.0", ORDER_DESK),
        (PRIVATE_DECLARED, CompositionKind.WORKFLOW, "private", "0.1.0", INTERNAL_DRAFT),
    ):
        composition = await ensure_composition(session, other, outsider, identity, kind, visibility, created)
        await seal_declared(session, other, composition, outsider, label, document, created)
        ids[f"{OTHER_ORG}/{composition.slug}"] = str(composition.id)
    return ids


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
        "personalOrganizations": await count(Organization, Organization.personal_owner_id.in_(user_ids)),
        "cases": await count(BindingCase, BindingCase.organization_id.in_(org_ids)),
        "caseRevisions": await count(BindingCaseRevision, BindingCaseRevision.created_by_id.in_(user_ids)),
        "compilations": await count(
            ProblemCompilation,
            ProblemCompilation.revision_id.in_(
                select(BindingCaseRevision.id).where(BindingCaseRevision.created_by_id.in_(user_ids))
            ),
        ),
        "compositions": await count(Composition, Composition.organization_id.in_(org_ids)),
        "compositionVersions": await count(
            CompositionVersion,
            CompositionVersion.composition_id.in_(select(Composition.id).where(Composition.organization_id.in_(org_ids))),
        ),
    }


async def seed(
    session: AsyncSession, password: str, examples_dir: Path, *, plan: str = "FREE", handoff_dir: str | None = None,
) -> dict[str, Any]:
    """Create what is missing; return what was created (empty on a repeated run) and the row counts."""
    created: list[str] = []
    # Uploading a problem consults the pricing gate for the uploader's allowances. The lab data is local
    # and synthetic and the synthetic users have no SPACE contract, so the seed uses the open gate (no plan,
    # no counters) whatever SPACE_ENABLED says, and restores what was installed.
    try:
        previous = space_client.get_gate()
    except RuntimeError:
        previous = None
    space_client.set_gate(OpenGate())
    try:
        users = await ensure_users(session, password, plan, created)
        organizations = await ensure_organizations(session, users, created)
        revisions = {
            org_slug: await ensure_case(session, organizations[org_slug], users[author], examples_dir, created)
            for org_slug, author in ((MAIN_ORG, "lab-owner"), (OTHER_ORG, "lab-outsider"))
        }
        recompile = await ensure_current_toolchain(session, created)
        await session.commit()
        # SPHERE first: its snapshots (set-B Brevo among them) are what order-desk's from pins, so its seal resolves
        # that from with no request.
        sphere = await ensure_sphere(session, organizations, users, password, created, handoff_dir=handoff_dir)
        compositions = await ensure_compositions(session, organizations, users, revisions, created)
    finally:
        space_client.set_gate(previous)
    return {
        "created": created,
        "recompileFailed": [
            {"revisionId": item.revision_id, "code": item.code, **({"reason": item.reason} if item.reason else {})}
            for item in recompile
        ],
        "sphere": sphere,
        "counts": await count_rows(session, users, organizations),
        "ids": {
            "users": {name: str(user.id) for name, user in users.items()},
            "organizations": {slug: str(item.id) for slug, item in organizations.items()},
            "caseRevision": str(revisions[MAIN_ORG].id),
            "compositions": compositions,
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
    if installed_pricing_source() is None and settings.sphere_enabled:
        from openbinding_gateway.modules.plans.adapters.sphere import SphereHttpSource
        from openbinding_gateway.modules.plans.application import set_pricing_source

        set_pricing_source(SphereHttpSource(settings))
    db_base.init_engine(database_url)
    try:
        async with db_base.session_factory()() as session:
            try:
                result = await seed(session, password, examples_dir, plan=dev_plan or "FREE",
                                    handoff_dir=environ.get("LAB_HANDOFF_DIR") or None)
            except HandoffError as exc:
                print(f"seed_lab: {exc}", file=sys.stderr)
                return 1
        users = result.pop("users")
        report: dict[str, Any] = {"tool": "seed_lab", **result}
        for failure in result["recompileFailed"]:
            print(
                f"problem revision {failure['revisionId']} cannot be compiled by the installed toolchain "
                f"({failure['code']}); upload a corrected package as a new revision",
                file=sys.stderr,
            )
        if args.print_keys:
            report["apiKeys"] = {name: api_key_for(password, name)[0] for name in users}
        if args.space_contracts:
            report["spaceContracts"] = await _space_contracts(
                users, environ, dev_service, dev_plan, settings.space_service_name
            )
    finally:
        await db_base.dispose_engine()
    secrets = [password] + ([] if args.print_keys else [api_key_for(password, name)[0] for name, *_ in SYNTHETIC_USERS])
    # The lab's feed keys are never printed: a consumer reads them from the hand-off file or derives them.
    secrets += [
        feed_key_for(password, MAIN_ORG, TOMATOMETER_SLUG, slug).secret
        for slug, *_rest in TOMATOMETER_ENVIRONMENTS
    ]
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
