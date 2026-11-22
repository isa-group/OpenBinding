"""Compositions of an organization: create, look up, list, edit and delete them.

A composition is the entity its versions will belong to (slug unique within the organization, name,
description, ``kind``, ``archived``). An empty one, with no version yet, is a valid state: the editor's
starting point and a derivation's target.

Who may read it follows SPHERE's private read rule: a composition the caller cannot read answers exactly as
a missing one does, 404 and never 403, so that a non-member learns nothing of the organization or of what it
holds. A member whose role is too weak for a write gets 403, since that member can read it
(``organization_for``).

A ``public`` composition is read by anybody, signed in or not, through the same routes
(``readable_composition``): a caller with no role in its organization is a public reader, who gets the
views redacted to what the published documents say. Every other route stays for members. Changing a
composition's visibility needs ADMIN, since publishing exposes every version's document.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass

from fastapi import HTTPException, status
from sqlalchemy import delete, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from ....collaboration import ROLE_STRENGTH, effective_role, organization_by_ref
from ....core.like import LIKE_ESCAPE, like_contains
from ....db.models import (
    BindingCaseRevision,
    Composition,
    CompositionDerivation,
    CompositionEnvironment,
    CompositionEvaluation,
    CompositionFollow,
    CompositionKind,
    CompositionUpstreamEvent,
    CompositionVersion,
    Organization,
    OrganizationMembership,
    OrganizationRole,
    PricingWatchRef,
    Proposal,
    ProposalStep,
    User,
)
from ....models.errors import api_error
from ....services.entitlements import entitlement_service
from ...plans.application import entitlement_map as ids
from ...problems.application import problem_by_ref
from ...shared.application import audit

#: The audit target type of a composition.
TARGET = "Composition"
#: The visibility anybody reads; the other one, ``private``, is for the organization's members.
PUBLIC = "public"


# -- Access ----------------------------------------------------------------------------------------------


def _not_found() -> HTTPException:
    return api_error(status.HTTP_404_NOT_FOUND, "not_found", "Organization not found.")


async def organization_for(session: AsyncSession, org: str, user: User, minimum: OrganizationRole) -> Organization:
    """The organization named by ``org``, for a caller who needs ``minimum`` there.

    404 ``not_found`` when there is no such organization **or the caller cannot read it** (no role in it or
    above it): an unreadable composition answers as a missing one. 403 ``organization_forbidden`` when the
    caller reads it but ``minimum`` is a stronger role than the caller's.
    """
    organization = await organization_by_ref(session, org)
    if organization is None:
        raise _not_found()
    role = await effective_role(session, organization.id, user)
    if role is None:
        raise _not_found()
    if ROLE_STRENGTH[role] < ROLE_STRENGTH[minimum]:
        raise api_error(
            status.HTTP_403_FORBIDDEN,
            "organization_forbidden",
            f"This action requires {minimum.value} access to the organization.",
        )
    return organization


@dataclass(frozen=True)
class Reader:
    """Who reads a composition: a member with ``role``, or a public reader (``public``, no role)."""

    role: OrganizationRole | None
    public: bool

    @classmethod
    def member(cls, role: OrganizationRole) -> "Reader":
        return cls(role, False)

    @classmethod
    def anybody(cls) -> "Reader":
        return cls(None, True)


def unreadable() -> HTTPException:
    """The one 404 a caller who is not a member gets: the same body for a missing organization, a missing
    composition and a private one, so it says nothing of what exists."""
    return api_error(status.HTTP_404_NOT_FOUND, "not_found", "Composition not found.")


async def readable_composition(
    session: AsyncSession, org: str, ref: str, user: User | None,
) -> tuple[Organization, Composition, Reader]:
    """The composition ``ref`` of the organization ``org``, for a caller who reads it, and how they read it.

    A caller with a role in the organization (or above it) is a member: a missing composition is 404
    ``not_found`` as before. Anybody else, signed in or not, reads a ``public`` composition as a public
    reader; a missing organization, a missing composition and a private one all give the same 404.
    """
    organization = await organization_by_ref(session, org)
    if organization is None:
        raise unreadable()
    role = await effective_role(session, organization.id, user) if user is not None else None
    if role is not None:
        return organization, await required_composition(session, organization, ref), Reader.member(role)
    found = await composition_by_ref(session, organization.id, ref)
    if found is None or found.visibility != PUBLIC:
        raise unreadable()
    return organization, found, Reader.anybody()


async def public_among(session: AsyncSession, ids: set[uuid.UUID]) -> set[uuid.UUID]:
    """Which of the compositions ``ids`` are public now: one query, whatever their number."""
    if not ids:
        return set()
    return set((await session.scalars(
        select(Composition.id).where(Composition.id.in_(ids), Composition.visibility == PUBLIC)
    )).all())


async def composition_by_ref(session: AsyncSession, organization_id: uuid.UUID, ref: str) -> Composition | None:
    """The organization's composition named by ``ref``: its slug, else its id."""
    found = await session.scalar(
        select(Composition).where(Composition.organization_id == organization_id, Composition.slug == ref)
    )
    if found is not None:
        return found
    try:
        parsed = uuid.UUID(ref)
    except ValueError:
        return None
    return await session.scalar(
        select(Composition).where(Composition.organization_id == organization_id, Composition.id == parsed)
    )


async def required_composition(session: AsyncSession, organization: Organization, ref: str) -> Composition:
    """``composition_by_ref``, or 404 ``not_found``."""
    found = await composition_by_ref(session, organization.id, ref)
    if found is None:
        raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "Composition not found.")
    return found


# -- Listing ---------------------------------------------------------------------------------------------


def published():
    """What makes a composition one anybody reads in a list: public, not archived, with a version."""
    return (
        Composition.visibility == PUBLIC,
        Composition.archived.is_(False),
        select(CompositionVersion.id).where(CompositionVersion.composition_id == Composition.id).exists(),
    )


async def readable_organization_ids(session: AsyncSession, user: User) -> list[uuid.UUID]:
    """Every organization ``user`` holds a role in, directly or through an ancestor, in one recursive query."""
    direct = select(OrganizationMembership.organization_id).where(OrganizationMembership.user_id == user.id)
    below = select(Organization.id.label("id")).where(Organization.id.in_(direct)).cte(
        name="readable_organizations", recursive=True,
    )
    below = below.union_all(select(Organization.id).join(below, Organization.parent_id == below.c.id))
    return list(dict.fromkeys((await session.scalars(select(below.c.id))).all()))


async def matching(
    session: AsyncSession,
    *,
    organization_ids: list[uuid.UUID] | None = None,
    public_only: bool = False,
    kinds: set[CompositionKind] | None = None,
    q: str | None = None,
    archived: bool | None = None,
    problem_id: uuid.UUID | None = None,
    organization_slug: str | None = None,
) -> list[tuple[Composition, Organization]]:
    """Every composition, with its organization, that the filters keep, unpaged and unordered: of
    ``organization_ids`` (any when ``None``), only the ``published`` ones when ``public_only``, of one of
    ``kinds``, with a text in name or slug, archived or not, with a version linking a revision of the problem
    ``problem_id``, and of the organization ``organization_slug``. Sorting, bounds, paging and facets are
    ``listing``'s."""
    query = select(Composition, Organization).join(Organization, Organization.id == Composition.organization_id)
    if organization_ids is not None:
        query = query.where(Composition.organization_id.in_(organization_ids))
    if public_only:
        query = query.where(*published())
    if problem_id is not None:
        query = query.where(Composition.id.in_(
            select(CompositionVersion.composition_id)
            .join(BindingCaseRevision, BindingCaseRevision.id == CompositionVersion.revision_id)
            .where(BindingCaseRevision.binding_case_id == problem_id)
        ))
    if kinds:
        query = query.where(Composition.kind.in_(list(kinds)))
    if archived is not None:
        query = query.where(Composition.archived.is_(archived))
    if organization_slug:
        query = query.where(Organization.slug == organization_slug)
    if q:
        pattern = like_contains(q)
        query = query.where(or_(
            Composition.name.ilike(pattern, escape=LIKE_ESCAPE),
            Composition.slug.ilike(pattern, escape=LIKE_ESCAPE),
        ))
    return [(composition, owner) for composition, owner in (await session.execute(query)).all()]


async def publishes(session: AsyncSession, organization_id: uuid.UUID) -> bool:
    """Whether the organization has a composition anybody reads in a list (``published``)."""
    return await session.scalar(
        select(Composition.id).where(Composition.organization_id == organization_id, *published()).limit(1)
    ) is not None


async def problem_id_of(session: AsyncSession, organization_id: uuid.UUID, problem: str) -> uuid.UUID | None:
    """The id of the organization's problem ``problem`` (slug or id), ``None`` when there is none."""
    found = await problem_by_ref(session, organization_id, problem)
    return found.id if found is not None else None


# -- Writing ---------------------------------------------------------------------------------------------


def _slug_conflict() -> HTTPException:
    return api_error(status.HTTP_409_CONFLICT, "slug_conflict", "That composition slug is in use in this organization.")


async def require_repository(actor: User) -> None:
    """403 ``feature_not_entitled`` unless the actor's plan has the ``repository`` feature.

    Pricing 0.2.0 has no composition feature or limit of its own, so creating a composition (or forking one)
    needs ``repository``.
    """
    caps = await entitlement_service.caps_or_503(actor.id)
    entitlement_service.require_feature(caps, ids.REPOSITORY)


async def slug_holder(session: AsyncSession, organization_id: uuid.UUID, slug: str) -> Composition | None:
    """The organization's composition that holds ``slug``, if any."""
    return await session.scalar(select(Composition).where(
        Composition.organization_id == organization_id, Composition.slug == slug,
    ).limit(1))


async def insert_composition(
    session: AsyncSession,
    organization: Organization,
    actor: User,
    *,
    slug: str,
    name: str,
    description: str = "",
    kind: CompositionKind = CompositionKind.APPLICATION,
) -> Composition:
    """Insert a composition of ``organization`` and audit it; 409 ``slug_conflict`` when the slug is taken.

    The caller has checked the actor's entitlement.
    """
    if await slug_holder(session, organization.id, slug) is not None:
        raise _slug_conflict()
    composition = Composition(
        organization_id=organization.id, slug=slug, name=name, description=description, kind=kind,
        created_by_id=actor.id,
    )
    try:
        async with session.begin_nested():
            session.add(composition)
            await session.flush()
    except IntegrityError as exc:
        # A concurrent create took the slug between the check and the insert.
        raise _slug_conflict() from exc
    await session.refresh(composition, ["created_at", "updated_at"])
    audit(session, actor, "composition.created", TARGET, composition.id, organization.id, slug=slug, kind=kind.value)
    return composition


async def create_composition(
    session: AsyncSession,
    organization: Organization,
    actor: User,
    *,
    slug: str,
    name: str,
    description: str = "",
    kind: CompositionKind = CompositionKind.APPLICATION,
) -> Composition:
    """A new, empty composition of ``organization``.

    Needs the ``repository`` feature of the actor's plan (403 ``feature_not_entitled``). 409
    ``slug_conflict`` when the slug is taken.
    """
    await require_repository(actor)
    return await insert_composition(
        session, organization, actor, slug=slug, name=name, description=description, kind=kind,
    )


async def require_visibility_role(
    session: AsyncSession, organization: Organization, actor: User,
) -> None:
    """403 ``organization_forbidden`` unless ``actor`` is an ADMIN (or OWNER) of ``organization``.

    Publishing a composition exposes every version's document, so it is the organization's decision, as
    deleting one is.
    """
    role = await effective_role(session, organization.id, actor)
    if role is None or ROLE_STRENGTH[role] < ROLE_STRENGTH[OrganizationRole.ADMIN]:
        raise api_error(
            status.HTTP_403_FORBIDDEN,
            "organization_forbidden",
            "Changing visibility requires ADMIN access to the organization.",
        )


async def update_composition(
    session: AsyncSession,
    composition: Composition,
    actor: User,
    *,
    name: str | None = None,
    description: str | None = None,
    archived: bool | None = None,
    visibility: str | None = None,
) -> Composition:
    """Change the given fields of ``composition``.

    The caller has already checked its ``If-Match`` and, for a change of ``visibility``, that the actor is
    an ADMIN (``require_visibility_role``).
    """
    changed = {}
    previous = composition.visibility
    if visibility is not None and visibility != previous:
        composition.visibility = visibility
    else:
        visibility = None
    if name is not None:
        composition.name = name
        changed["name"] = name
    if description is not None:
        composition.description = description
        changed["description"] = True
    if archived is not None:
        composition.archived = archived
        changed["archived"] = archived
    await session.flush()
    await session.refresh(composition, ["updated_at"])
    if changed:
        audit(session, actor, "composition.updated", TARGET, composition.id, composition.organization_id, **changed)
    if visibility is not None:
        audit(
            session, actor, "composition.visibility_changed", TARGET, composition.id, composition.organization_id,
            **{"from": previous, "to": visibility},
        )
    return composition


async def delete_composition(session: AsyncSession, composition: Composition, actor: User) -> None:
    """Delete ``composition`` with its versions, their evaluations and derivations, in one transaction.

    The composition's row is locked first, as a seal locks it, so a seal in flight either commits before
    the delete sees the versions or waits for it and finds the composition gone. A composition with
    environments is refused (``409 composition_in_operation``, naming them): an application may be reading
    one, so its environments are deleted first, by a person. An adopt holds the composition ``FOR KEY SHARE``,
    so it either commits first (and the delete sees its environment) or finds the composition gone.
    """
    await session.execute(select(Composition.id).where(Composition.id == composition.id).with_for_update())
    environments = list(
        (await session.scalars(
            select(CompositionEnvironment.slug)
            .where(CompositionEnvironment.composition_id == composition.id)
            .order_by(CompositionEnvironment.slug)
        )).all()
    )
    if environments:
        raise api_error(
            status.HTTP_409_CONFLICT, "composition_in_operation",
            "This composition has environments; delete them before deleting the composition.",
            environments=environments,
        )
    versions = select(CompositionVersion.id).where(CompositionVersion.composition_id == composition.id)
    # F6-B: its proposals and their steps first (no adoption is left to name one: its environments are gone). The
    # proposals are locked before their steps, as the executor writes an outcome (proposal, then step).
    await session.execute(select(Proposal.id).where(Proposal.composition_id == composition.id)
                          .order_by(Proposal.id).with_for_update())
    proposals = select(Proposal.id).where(Proposal.composition_id == composition.id)
    await session.execute(delete(ProposalStep).where(ProposalStep.proposal_id.in_(proposals)))
    await session.execute(delete(Proposal).where(Proposal.composition_id == composition.id))
    # F6: its upstream events and watch references go first (they name its versions); the watches stay.
    await session.execute(delete(CompositionUpstreamEvent).where(CompositionUpstreamEvent.composition_id == composition.id))
    await session.execute(delete(PricingWatchRef).where(PricingWatchRef.composition_id == composition.id))
    await session.execute(delete(CompositionFollow).where(CompositionFollow.composition_id == composition.id))
    await session.execute(delete(CompositionDerivation).where(CompositionDerivation.version_id.in_(versions)))
    await session.execute(delete(CompositionEvaluation).where(CompositionEvaluation.version_id.in_(versions)))
    await session.execute(delete(CompositionVersion).where(CompositionVersion.composition_id == composition.id))
    audit(session, actor, "composition.deleted", TARGET, composition.id, composition.organization_id,
          slug=composition.slug)
    await session.delete(composition)
    await session.flush()
