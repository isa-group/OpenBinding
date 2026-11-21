"""Composition environments: where an application reads the version of a composition in effect.

An environment belongs to one composition and is named by a slug that never changes (it is part of its feed's
address). It records who may adopt in it (``adopt_role``), the member answerable for it (``operator``) and the
number of users its margins assume (``expected_users``); the version in effect changes only through
``adoption.adopt``.

**Who sees what.** Environments are the organization's: every route needs a signed-in caller (401 before any
lookup) and a role in the organization. A caller without one gets the composition's 404 parity: a missing or
private composition is "Composition not found." (``readable_composition``); a public one answers every
environment route with "Environment not found." (``environment_unreadable``), the body a member gets for a
missing environment, so a public composition says nothing of its environments. VIEWER reads, ADMIN creates,
edits and deletes; a member whose role is too weak gets 403 ``organization_forbidden``.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass

from fastapi import HTTPException, status
from sqlalchemy import delete, func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from ....collaboration import ROLE_STRENGTH, effective_role
from ....core.settings import get_settings
from ....db.models import (
    Composition,
    CompositionAdoption,
    CompositionEnvironment,
    CompositionEnvironmentKey,
    CompositionEvaluation,
    CompositionVersion,
    Organization,
    OrganizationRole,
    PricingSnapshot,
    Proposal,
    ProposalStep,
    User,
)
from ....models.errors import api_error
from ...shared.application import audit
from ..domain.environments import ENVIRONMENT_SLUG, AdoptRole
from .compositions import readable_composition, require_repository

#: The audit target type of an environment.
TARGET = "CompositionEnvironment"
#: The revoked keys an ADMIN still sees in an environment's view, newest first.
RECENT_REVOKED_KEYS = 5


# -- Access ----------------------------------------------------------------------------------------------


def environment_unreadable() -> HTTPException:
    """The 404 of a missing environment, and of every environment route of a public composition for a caller
    who is not a member: one body, so neither says what exists."""
    return api_error(status.HTTP_404_NOT_FOUND, "not_found", "Environment not found.")


def forbidden(minimum: OrganizationRole | str) -> HTTPException:
    name = minimum.value if isinstance(minimum, OrganizationRole) else minimum
    return api_error(
        status.HTTP_403_FORBIDDEN, "organization_forbidden", f"This action requires {name} access to the organization.",
    )


def require(role: OrganizationRole, minimum: OrganizationRole) -> None:
    """403 ``organization_forbidden`` unless ``role`` is at least ``minimum``."""
    if ROLE_STRENGTH[role] < ROLE_STRENGTH[minimum]:
        raise forbidden(minimum)


async def operating_composition(
    session: AsyncSession, org: str, composition: str, user: User,
) -> tuple[Organization, Composition, OrganizationRole]:
    """The composition whose environments a signed-in ``user`` addresses, and the user's role in it.

    Its 404s are ``readable_composition``'s; a caller who reads it only because it is public gets
    ``environment_unreadable``.
    """
    organization, found, reader = await readable_composition(session, org, composition, user)
    if reader.public or reader.role is None:
        raise environment_unreadable()
    return organization, found, reader.role


async def environment_by_ref(
    session: AsyncSession, composition: Composition, ref: str,
) -> CompositionEnvironment | None:
    """The composition's environment named by ``ref``: its slug, else its id."""
    found = await session.scalar(select(CompositionEnvironment).where(
        CompositionEnvironment.composition_id == composition.id, CompositionEnvironment.slug == ref,
    ))
    if found is not None:
        return found
    try:
        parsed = uuid.UUID(ref)
    except ValueError:
        return None
    return await session.scalar(select(CompositionEnvironment).where(
        CompositionEnvironment.composition_id == composition.id, CompositionEnvironment.id == parsed,
    ))


async def readable_environment(
    session: AsyncSession, org: str, composition: str, environment: str, user: User,
) -> tuple[Organization, Composition, CompositionEnvironment, OrganizationRole]:
    """The environment ``environment`` of a composition ``user`` is a member of, and the user's role."""
    organization, found, role = await operating_composition(session, org, composition, user)
    row = await environment_by_ref(session, found, environment)
    if row is None:
        raise environment_unreadable()
    return organization, found, row, role


# -- Writing ---------------------------------------------------------------------------------------------


def _slug_conflict() -> HTTPException:
    return api_error(status.HTTP_409_CONFLICT, "slug_conflict", "That environment slug is in use in this composition.")


async def _operator(session: AsyncSession, organization: Organization, username: str | None) -> User | None:
    """The member named ``username``; 422 ``operator_not_member`` when nobody by that name holds a role."""
    if username is None:
        return None
    user = await session.scalar(select(User).where(User.username == username))
    if user is None or not user.is_active or await effective_role(session, organization.id, user) is None:
        raise api_error(
            422, "operator_not_member",
            "The operator must be a member of the organization.", operator=username,
        )
    return user


async def create_environment(
    session: AsyncSession,
    organization: Organization,
    composition: Composition,
    actor: User,
    *,
    slug: str,
    name: str,
    description: str = "",
    operator: str | None = None,
    adopt_role: AdoptRole = AdoptRole.ADMIN,
    expected_users: int | None = None,
) -> CompositionEnvironment:
    """A new environment of ``composition``, with nothing adopted yet.

    Needs the ``repository`` feature (403 ``feature_not_entitled``); 409 ``slug_conflict`` for a slug in use and
    ``environment_limit`` beyond ``COMPOSITION_ENVIRONMENTS_MAX`` (pricing 0.3.0's ``maxEnvironments`` replaces
    it). The composition row is locked first, so concurrent creates count one another and a concurrent delete of
    the composition either sees this environment or makes this create a 404.
    """
    if not ENVIRONMENT_SLUG.fullmatch(slug):
        raise api_error(422, "invalid_slug", "That is not an environment slug.")
    await require_repository(actor)
    locked = await session.scalar(select(Composition.id).where(Composition.id == composition.id).with_for_update())
    if locked is None:
        raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "Composition not found.")
    operator_user = await _operator(session, organization, operator)
    if await session.scalar(select(CompositionEnvironment.id).where(
        CompositionEnvironment.composition_id == composition.id, CompositionEnvironment.slug == slug,
    )) is not None:
        raise _slug_conflict()
    limit = get_settings().composition_environments_max
    count = int(await session.scalar(
        select(func.count()).select_from(CompositionEnvironment)
        .where(CompositionEnvironment.composition_id == composition.id)
    ) or 0)
    if count >= limit:
        raise api_error(
            status.HTTP_409_CONFLICT, "environment_limit",
            f"A composition has at most {limit} environments; delete one first.", limit=limit,
        )
    row = CompositionEnvironment(
        organization_id=organization.id, composition_id=composition.id, slug=slug, name=name,
        description=description, operator_id=operator_user.id if operator_user else None,
        adopt_role=adopt_role.value, expected_users=expected_users, created_by_id=actor.id,
    )
    try:
        async with session.begin_nested():
            session.add(row)
            await session.flush()
    except IntegrityError as exc:
        raise _slug_conflict() from exc
    await session.refresh(row, ["created_at", "updated_at"])
    audit(
        session, actor, "composition.environment_created", TARGET, row.id, organization.id,
        composition=composition.slug, environment=slug,
    )
    return row


async def update_environment(
    session: AsyncSession,
    organization: Organization,
    composition: Composition,
    environment: CompositionEnvironment,
    actor: User,
    changes: dict,
) -> CompositionEnvironment:
    """Apply ``changes`` (``name``, ``description``, ``operator``, ``adoptRole``, ``expectedUsers``; the caller
    has guarded the row's revision) and audit the names of the fields that changed."""
    changed: list[str] = []
    if "name" in changes and changes["name"] != environment.name:
        environment.name = changes["name"]
        changed.append("name")
    if "description" in changes and changes["description"] != environment.description:
        environment.description = changes["description"]
        changed.append("description")
    if "operator" in changes:
        operator_user = await _operator(session, organization, changes["operator"])
        operator_id = operator_user.id if operator_user else None
        if operator_id != environment.operator_id:
            environment.operator_id = operator_id
            changed.append("operator")
    if "adoptRole" in changes and changes["adoptRole"] is not None:
        role = AdoptRole(changes["adoptRole"]).value
        if role != environment.adopt_role:
            environment.adopt_role = role
            changed.append("adoptRole")
    if "expectedUsers" in changes and changes["expectedUsers"] != environment.expected_users:
        environment.expected_users = changes["expectedUsers"]
        changed.append("expectedUsers")
    await session.flush()
    await session.refresh(environment, ["updated_at"])
    if changed:
        audit(
            session, actor, "composition.environment_updated", TARGET, environment.id, organization.id,
            composition=composition.slug, environment=environment.slug, fields=changed,
        )
    return environment


async def delete_environment(
    session: AsyncSession, composition: Composition, environment: CompositionEnvironment, actor: User,
) -> None:
    """Delete ``environment`` with its feed keys and its adoption history, in one transaction.

    Its composition is share-locked first (:func:`lock_composition`), then the row, as an adopt locks them, so an adopt
    in flight either commits before the delete counts the history or waits and finds the environment gone.
    """
    await lock_composition(session, composition)
    locked = await session.scalar(
        select(CompositionEnvironment).where(CompositionEnvironment.id == environment.id)
        .with_for_update().execution_options(populate_existing=True)
    )
    if locked is None:
        raise environment_unreadable()
    in_effect = None
    if locked.adopted_version_id is not None:
        in_effect = await session.scalar(
            select(CompositionVersion.label).where(CompositionVersion.id == locked.adopted_version_id)
        )
    adoptions = int(await session.scalar(
        select(func.count()).select_from(CompositionAdoption).where(CompositionAdoption.environment_id == locked.id)
    ) or 0)
    await session.execute(delete(CompositionEnvironmentKey).where(CompositionEnvironmentKey.environment_id == locked.id))
    await session.execute(delete(CompositionAdoption).where(CompositionAdoption.environment_id == locked.id))
    staled = await stale_proposals_adopting_in(session, composition, locked, actor)
    audit(
        session, actor, "composition.environment_deleted", TARGET, locked.id, locked.organization_id,
        composition=composition.slug, environment=locked.slug, version=in_effect, adoptions=adoptions,
        staleProposals=staled,
    )
    await session.delete(locked)
    await session.flush()


async def lock_composition(session: AsyncSession, composition: Composition) -> None:
    """``FOR KEY SHARE`` on the composition, before an environment's row is touched: deleting the organization locks
    its compositions first and its environments last, so an environment write that waited on the organization (its
    audit row) or on a proposal while holding the environment would close a lock cycle; this way it waits at the
    composition, holding nothing the organization delete needs."""
    await session.execute(select(Composition.id).where(Composition.id == composition.id)
                          .with_for_update(read=True, key_share=True))


async def stale_proposals_adopting_in(
    session: AsyncSession, composition: Composition, environment: CompositionEnvironment, actor: User,
) -> int:
    """F6-B: every pending proposal of ``composition`` with an ``adopt`` step in ``environment`` becomes ``stale`` (in
    the caller's transaction), so it cannot run once the environment is deleted; how many.

    The environment is already locked here, and deleting its organization locks proposals before environments, so a
    proposal another transaction holds is skipped rather than waited for (``SKIP LOCKED``): one an organization delete
    holds goes with it, and any other still finds its environment missing at confirm (stale then)."""
    candidates = (await session.execute(
        select(Proposal.id, ProposalStep.params).join(ProposalStep, ProposalStep.proposal_id == Proposal.id).where(
            Proposal.composition_id == composition.id, Proposal.status == "pending", ProposalStep.kind == "adopt",
        ).with_for_update(skip_locked=True, of=Proposal)
    )).all()
    ids = sorted({row.id for row in candidates if str((row.params or {}).get("environment")) == str(environment.id)})
    staled = 0
    for proposal_id in ids:
        changed = await session.execute(
            update(Proposal).where(Proposal.id == proposal_id, Proposal.status == "pending")
            .values(status="stale").execution_options(synchronize_session=False)
        )
        if changed.rowcount == 1:
            staled += 1
            audit(session, actor, "composition.proposal_stale", "Proposal", proposal_id, composition.organization_id,
                  reasons=["environment_missing"], environment=environment.slug)
    return staled


# -- Reading ---------------------------------------------------------------------------------------------


async def list_environments(session: AsyncSession, composition: Composition) -> list[CompositionEnvironment]:
    """The composition's environments, by slug."""
    return list((await session.scalars(
        select(CompositionEnvironment).where(CompositionEnvironment.composition_id == composition.id)
        .order_by(CompositionEnvironment.slug)
    )).all())


@dataclass(frozen=True)
class Person:
    username: str
    display_name: str
    member: bool


@dataclass(frozen=True)
class InEffect:
    adoption: CompositionAdoption
    version: CompositionVersion
    actor: Person
    evaluation: CompositionEvaluation
    offering: PricingSnapshot | None


@dataclass(frozen=True)
class KeyRow:
    key: CompositionEnvironmentKey
    created_by: Person


@dataclass(frozen=True)
class Detail:
    """What an environment's view shows: the row, its operator, what is in effect and (ADMIN) its keys."""

    environment: CompositionEnvironment
    composition: Composition
    organization: Organization
    operator: Person | None
    in_effect: InEffect | None
    keys: list[KeyRow] | None
    key_count: int


def person(user: User | None, member: bool) -> Person | None:
    """A user as the views name one: username and display name (the username until Identity, F5)."""
    if user is None:
        return None
    return Person(username=user.username, display_name=user.username, member=member)


async def _people(session: AsyncSession, organization: Organization, ids: set[uuid.UUID]) -> dict[uuid.UUID, Person]:
    people: dict[uuid.UUID, Person] = {}
    for user_id in ids:
        user = await session.get(User, user_id)
        if user is not None:
            member = user.is_active and await effective_role(session, organization.id, user) is not None
            people[user_id] = person(user, member)  # type: ignore[assignment]
    return people


async def details(
    session: AsyncSession,
    organization: Organization,
    composition: Composition,
    environments: list[CompositionEnvironment],
    role: OrganizationRole,
) -> list[Detail]:
    """The views of ``environments`` for a member with ``role``: keys are listed for ADMIN only."""
    admin = ROLE_STRENGTH[role] >= ROLE_STRENGTH[OrganizationRole.ADMIN]
    ids = [row.id for row in environments]
    adoptions: dict[uuid.UUID, CompositionAdoption] = {}
    for row in environments:
        if row.adoption_ordinal:
            found = await session.scalar(select(CompositionAdoption).where(
                CompositionAdoption.environment_id == row.id, CompositionAdoption.ordinal == row.adoption_ordinal,
            ))
            if found is not None:
                adoptions[row.id] = found
    keys: dict[uuid.UUID, list[CompositionEnvironmentKey]] = {row_id: [] for row_id in ids}
    if ids:
        for key in (await session.scalars(
            select(CompositionEnvironmentKey).where(CompositionEnvironmentKey.environment_id.in_(ids))
            .order_by(CompositionEnvironmentKey.created_at.desc(), CompositionEnvironmentKey.prefix)
        )).all():
            keys[key.environment_id].append(key)
    wanted: set[uuid.UUID] = {row.operator_id for row in environments if row.operator_id}
    wanted |= {adoption.actor_id for adoption in adoptions.values()}
    if admin:
        wanted |= {key.created_by_id for rows in keys.values() for key in rows}
    people = await _people(session, organization, wanted)
    result = []
    for row in environments:
        in_effect = None
        adoption = adoptions.get(row.id)
        if adoption is not None:
            version = await session.get(CompositionVersion, adoption.version_id)
            evaluation = await session.get(CompositionEvaluation, adoption.evaluation_id)
            snapshot = (
                await session.get(PricingSnapshot, evaluation.offering_snapshot_id)
                if evaluation is not None and evaluation.offering_snapshot_id else None
            )
            in_effect = InEffect(adoption, version, people.get(adoption.actor_id), evaluation, snapshot)  # type: ignore[arg-type]
        live = [key for key in keys[row.id] if key.revoked_at is None]
        listed = None
        if admin:
            revoked = [key for key in keys[row.id] if key.revoked_at is not None]
            revoked.sort(key=lambda key: key.revoked_at, reverse=True)
            listed = [KeyRow(key, people.get(key.created_by_id)) for key in live + revoked[:RECENT_REVOKED_KEYS]]  # type: ignore[arg-type]
        result.append(Detail(
            environment=row, composition=composition, organization=organization,
            operator=people.get(row.operator_id) if row.operator_id else None,
            in_effect=in_effect, keys=listed, key_count=len(live),
        ))
    return result


def feed_path(organization: Organization, composition: Composition, environment: CompositionEnvironment) -> str:
    """The environment's feed address: it never changes (the three slugs are fixed)."""
    return (
        f"/v1/organizations/{organization.slug}/compositions/{composition.slug}"
        f"/environments/{environment.slug}/composition"
    )
