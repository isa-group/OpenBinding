"""Adopting a sealed version in a composition environment: the one write that changes what an application runs.

``adopt`` is the only way the version in effect changes: every caller goes through it with the ``If-Match`` it read,
and there is no second adopt path. Its callers are the adopt route (``source='direct'``, as the lab seed) and the
proposal executor's ``adopt`` step (``source='proposal'`` with the proposal's id); the upstream watcher never calls it.
Its rules, in order:

1. ``If-Match`` with an entity-tag is required (428 ``precondition_required`` when absent or ``*``).
2. The caller's read phase is committed; then the composition is locked ``FOR KEY SHARE`` (it conflicts with a
   composition delete) and the environment ``FOR UPDATE``, refreshed (``populate_existing``), so every later
   check reads the locked row, never the read phase's copy.
3. The tags must name the locked row's ETag (412 with the current one).
4. The caller's role must reach the environment's ``adopt_role`` (403 ``organization_forbidden``).
5. An archived composition adopts nothing (409 ``composition_archived``); its feeds keep serving.
6. The version (id, label or ordinal) must be one of the composition's (404).
7. The version in effect is not adopted again (409 ``already_in_effect``): every adoption moves the feed.
8. A linked version needs an evaluation by the installed toolchain (409 ``evaluation_stale``) whose outcome is
   ``verified`` (``binding_invalid`` and ``semantics_changed`` are 409s of their own); a declared version adopts
   on its declared evaluation. An unreadable offering never blocks.
9. The environment is claimed with a conditional, monotonic ``UPDATE`` on the revision read under the lock (no
   row: 412), and the adoption row is inserted with the next ordinal, the previous version, the pinned
   evaluation, whose margins the environment shows until the next adoption, and how it was made (``source``).
10. Audit ``composition.adopted``; ``CompositionAdopted`` to the operator and the composition's followers who
    still hold a role, never to the actor; commit.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Literal

from fastapi import status
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from ....collaboration import ROLE_STRENGTH, effective_role
from ....core import revision as etags
from ....db.models import (
    Composition,
    CompositionAdoption,
    CompositionEnvironment,
    CompositionEvaluation,
    CompositionFollow,
    CompositionVersion,
    EvaluationOutcome,
    Organization,
    OrganizationRole,
    PricingSnapshot,
    Proposal,
    User,
    ValuesStatus,
)
from ....models.errors import api_error
from ...shared.application import COMPOSITION_ADOPTED, audit, notify
from . import versions
from .environments import TARGET, environment_unreadable, forbidden


@dataclass(frozen=True)
class Adopted:
    environment: CompositionEnvironment
    adoption: CompositionAdoption


def _conflict(code: str, message: str, **extra):
    return api_error(status.HTTP_409_CONFLICT, code, message, **extra)


def adoptable_evaluation(version: CompositionVersion, evaluations: list[CompositionEvaluation]) -> CompositionEvaluation:
    """The evaluation an adoption of ``version`` pins, or the 409 that refuses it (rule 8)."""
    if version.values_status == ValuesStatus.VERIFIED:
        basis = versions.installed_basis()
        evaluation = next((row for row in evaluations if basis is not None and row.basis_key == basis), None)
        if evaluation is None:
            raise _conflict(
                "evaluation_stale",
                "This version has no evaluation by the installed toolchain: re-evaluate it first.",
            )
    else:
        evaluation = versions.current_of(evaluations, None)
        if evaluation is None:
            raise _conflict("evaluation_stale", "This version has no evaluation: re-evaluate it first.")
    if evaluation.outcome == EvaluationOutcome.BINDING_INVALID:
        raise _conflict(
            "binding_invalid", "This version's binding is not valid on the installed toolchain; it cannot be adopted.",
            diagnostics=evaluation.diagnostics,
        )
    if evaluation.outcome == EvaluationOutcome.SEMANTICS_CHANGED:
        raise _conflict(
            "evaluation_semantics_changed",
            "The installed toolchain reads this version's problem differently: derive it again and adopt the new "
            "version.",
        )
    return evaluation


async def adopt(
    session: AsyncSession,
    *,
    organization: Organization,
    composition: Composition,
    environment: CompositionEnvironment,
    role: OrganizationRole,
    version_ref: str,
    actor: User,
    if_match: str | None,
    note: str = "",
    source: Literal["direct", "proposal"],
    proposal_id: uuid.UUID | None,
) -> Adopted:
    """Adopt the version ``version_ref`` in ``environment``, committed (see the module docstring). ``source`` is
    ``direct`` (no ``proposal_id``) or ``proposal`` (the confirmed proposal's id)."""
    if (source == "proposal") != (proposal_id is not None):
        raise ValueError("an adoption names its proposal exactly when a proposal made it")
    tags = etags.require_if_match(if_match)
    # The read phase (who the caller is, which environment) ends here; nothing it holds is trusted below.
    await session.commit()

    locked_composition = await session.scalar(
        select(Composition).where(Composition.id == composition.id)
        .with_for_update(key_share=True).execution_options(populate_existing=True)
    )
    if locked_composition is None:
        raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "Composition not found.")
    locked = await session.scalar(
        select(CompositionEnvironment).where(CompositionEnvironment.id == environment.id)
        .with_for_update().execution_options(populate_existing=True)
    )
    if locked is None:
        raise environment_unreadable()
    etags.check(tags, etags.etag_for(locked))
    if ROLE_STRENGTH[role] < ROLE_STRENGTH[OrganizationRole(locked.adopt_role)]:
        raise forbidden(locked.adopt_role)
    if locked_composition.archived:
        raise _conflict("composition_archived", "An archived composition adopts nothing; restore it first.")
    version = await versions.required_version(session, locked_composition, version_ref)
    if version.id == locked.adopted_version_id:
        raise _conflict("already_in_effect", f"Version {version.label} is already in effect in this environment.")
    evaluations = list((await session.scalars(
        select(CompositionEvaluation).where(CompositionEvaluation.version_id == version.id)
        .order_by(CompositionEvaluation.created_at, CompositionEvaluation.id)
    )).all())
    evaluation = adoptable_evaluation(version, evaluations)

    read_updated_at = locked.updated_at
    read_ordinal = locked.adoption_ordinal
    previous_version_id = locked.adopted_version_id
    bumped = max(datetime.now(timezone.utc), etags.normalise(read_updated_at) + timedelta(microseconds=1))
    claimed = await session.execute(
        update(CompositionEnvironment)
        .where(CompositionEnvironment.id == locked.id, CompositionEnvironment.updated_at == read_updated_at)
        .values(adopted_version_id=version.id, adoption_ordinal=read_ordinal + 1, updated_at=bumped)
        .execution_options(synchronize_session=False)
    )
    if claimed.rowcount != 1:
        current = await session.scalar(
            select(CompositionEnvironment.updated_at).where(CompositionEnvironment.id == locked.id)
        )
        if current is None:
            raise environment_unreadable()
        raise etags.precondition_failed(etags.opaque_etag(
            CompositionEnvironment.__tablename__, locked.id,
            etags.normalise(current).isoformat(timespec="microseconds"),
        ))
    adoption = CompositionAdoption(
        environment_id=locked.id, ordinal=read_ordinal + 1, composition_id=locked_composition.id,
        version_id=version.id, previous_version_id=previous_version_id, evaluation_id=evaluation.id,
        content_digest=version.content_digest, actor_id=actor.id, note=note, source=source, proposal_id=proposal_id,
    )
    session.add(adoption)
    await session.flush()
    await session.refresh(locked)
    await session.refresh(adoption, ["created_at"])

    previous_label = None
    if previous_version_id is not None:
        previous_label = await session.scalar(
            select(CompositionVersion.label).where(CompositionVersion.id == previous_version_id)
        )
    audit(
        session, actor, "composition.adopted", TARGET, locked.id, organization.id,
        composition=locked_composition.slug, environment=locked.slug, version=version.label,
        previous=previous_label, ordinal=adoption.ordinal, source=source,
        proposal=None if proposal_id is None else str(proposal_id),
    )
    await _tell(session, organization, locked_composition, locked, version, previous_label, actor)
    await session.commit()
    return Adopted(locked, adoption)


async def _tell(
    session: AsyncSession,
    organization: Organization,
    composition: Composition,
    environment: CompositionEnvironment,
    version: CompositionVersion,
    previous: str | None,
    actor: User,
) -> int:
    """``CompositionAdopted`` to the operator and to the followers who hold a role; never to the actor."""
    followers = (await session.scalars(
        select(CompositionFollow.user_id).where(CompositionFollow.composition_id == composition.id)
        .order_by(CompositionFollow.created_at)
    )).all()
    recipients = list(dict.fromkeys(
        ([environment.operator_id] if environment.operator_id else []) + list(followers)
    ))
    told = 0
    for user_id in recipients:
        if user_id == actor.id:
            continue
        user = await session.get(User, user_id)
        if user is None or not user.is_active or await effective_role(session, organization.id, user) is None:
            continue
        stored = await notify(
            session, user_id, COMPOSITION_ADOPTED,
            f"{composition.name} {version.label} adopted in {environment.name}",
            f"@{actor.username} adopted version {version.label} of \"{composition.name}\" in {environment.name}"
            + (f" (it was {previous})." if previous else "."),
            organization=organization.slug, organization_id=str(organization.id),
            composition=composition.slug, composition_id=str(composition.id),
            environment=environment.slug, version=version.label, previousVersion=previous, actor=actor.username,
        )
        told += stored is not None
    return told


# -- History ---------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class HistoryRow:
    adoption: CompositionAdoption
    version: CompositionVersion
    previous: CompositionVersion | None
    actor: User | None
    evaluation: CompositionEvaluation | None
    offering: PricingSnapshot | None
    proposal: Proposal | None = None


async def adoptions(
    session: AsyncSession, environment: CompositionEnvironment, *, limit: int = 20, before: int | None = None,
) -> list[HistoryRow]:
    """The environment's adoptions, newest first: at most ``limit``, numbered below ``before`` when given."""
    query = select(CompositionAdoption).where(CompositionAdoption.environment_id == environment.id)
    if before is not None:
        query = query.where(CompositionAdoption.ordinal < before)
    rows = (await session.scalars(query.order_by(CompositionAdoption.ordinal.desc()).limit(limit))).all()
    wanted = {row.version_id for row in rows} | {row.previous_version_id for row in rows if row.previous_version_id}
    found_versions: dict[uuid.UUID, CompositionVersion] = {}
    if wanted:
        found_versions = {
            row.id: row for row in (await session.scalars(
                select(CompositionVersion).where(CompositionVersion.id.in_(wanted))
            )).all()
        }
    result = []
    for row in rows:
        evaluation = await session.get(CompositionEvaluation, row.evaluation_id)
        snapshot = (
            await session.get(PricingSnapshot, evaluation.offering_snapshot_id)
            if evaluation is not None and evaluation.offering_snapshot_id else None
        )
        result.append(HistoryRow(
            adoption=row, version=found_versions[row.version_id],
            previous=found_versions.get(row.previous_version_id) if row.previous_version_id else None,
            actor=await session.get(User, row.actor_id), evaluation=evaluation, offering=snapshot,
            proposal=None if row.proposal_id is None else await session.get(Proposal, row.proposal_id),
        ))
    return result
