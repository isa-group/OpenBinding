"""The sealed versions of a composition, as its routes read them.

A version is named by its id, its label or its ordinal (``domain.refs.version_ref``). Its values and its
current evaluation are those of the installed toolchain when the version has an evaluation by it, else
those of its latest evaluation (a declared version has exactly one).
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Literal

from bim_core import BimError
from fastapi import status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import defer, load_only

from ....db.models import (
    BindingCase,
    BindingCaseRevision,
    Composition,
    CompositionDerivation,
    CompositionEvaluation,
    CompositionVersion,
    EvaluationOutcome,
    ProblemCompilation,
    ValuesStatus,
)
from ....integrations import bim
from ....models.errors import api_error
from ..domain.refs import version_ref


@dataclass(frozen=True)
class Link:
    """The problem a version links: the problem, the revision and the compilation the document names."""

    problem: BindingCase
    revision: BindingCaseRevision
    compilation: ProblemCompilation


@dataclass(frozen=True)
class Derivation:
    """Where a derived version came from: a run's solution or a binding, and the problem revision."""

    source: str
    run_id: uuid.UUID | None
    point: int | None
    revision_id: uuid.UUID
    revision: int


@dataclass(frozen=True)
class Detail:
    """A version with what its view shows: its evaluations (oldest first), the current one, its link and how
    it was derived."""

    version: CompositionVersion
    evaluations: list[CompositionEvaluation]
    current: CompositionEvaluation | None
    link: Link | None
    compilations: dict[uuid.UUID, ProblemCompilation]
    derivation: Derivation | None


@dataclass(frozen=True)
class Summary:
    """The latest version of a composition, how many it has, and whether its current evaluation verified the
    latest one (``verified_among``)."""

    latest: CompositionVersion | None
    count: int
    verified: bool = False


def installed_basis() -> str | None:
    """The basis key of an evaluation by the installed toolchain; ``None`` when it cannot be asked."""
    try:
        return bim.toolchain_digest()
    except BimError:
        return None


def current_of(evaluations: list[CompositionEvaluation], basis: str | None) -> CompositionEvaluation | None:
    """The evaluation by the installed toolchain if there is one, else the latest."""
    for evaluation in evaluations:
        if basis is not None and evaluation.basis_key == basis:
            return evaluation
    return evaluations[-1] if evaluations else None


async def version_by_ref(session: AsyncSession, composition: Composition, ref: str) -> CompositionVersion | None:
    """The version of ``composition`` that ``ref`` names: its id, its label or its ordinal."""
    named = version_ref(ref)
    column = {
        "id": CompositionVersion.id, "label": CompositionVersion.label, "ordinal": CompositionVersion.ordinal,
    }.get(named.kind)
    if column is None:
        return None
    return await session.scalar(
        select(CompositionVersion).where(CompositionVersion.composition_id == composition.id, column == named.value)
    )


async def required_version(session: AsyncSession, composition: Composition, ref: str) -> CompositionVersion:
    """``version_by_ref``, or 404 ``not_found``."""
    found = await version_by_ref(session, composition, ref)
    if found is None:
        raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "Version not found.")
    return found


def _too_few(message: str):
    return api_error(422, "diff_version_missing", message)


async def diff_pair(
    session: AsyncSession, composition: Composition, from_ref: str | None, to_ref: str | None,
) -> tuple[CompositionVersion, CompositionVersion]:
    """The two versions a diff compares: ``to`` (the latest by default) and ``from`` (by default the one
    before ``to``).

    A version a reference does not name is 404 ``not_found``; a default the composition cannot give (no
    version yet, or none before ``to``) is 422 ``diff_version_missing``.
    """
    if to_ref is not None:
        to = await required_version(session, composition, to_ref)
    else:
        latest = await session.scalar(
            select(CompositionVersion).where(CompositionVersion.composition_id == composition.id)
            .order_by(CompositionVersion.ordinal.desc()).limit(1)
        )
        if latest is None:
            raise _too_few("This composition has no version yet: there is nothing to compare.")
        to = latest
    if from_ref is not None:
        return await required_version(session, composition, from_ref), to
    before = await session.scalar(
        select(CompositionVersion).where(
            CompositionVersion.composition_id == composition.id, CompositionVersion.ordinal < to.ordinal,
        ).order_by(CompositionVersion.ordinal.desc()).limit(1)
    )
    if before is None:
        raise _too_few(f"This composition has no version before {to.label}; name the version to compare with (`from`).")
    return before, to


def _utc(instant: datetime) -> datetime:
    """An instant in UTC; one without an offset is read as UTC, as every stored instant is."""
    return instant.replace(tzinfo=timezone.utc) if instant.tzinfo is None else instant.astimezone(timezone.utc)


async def list_versions(
    session: AsyncSession,
    composition: Composition,
    *,
    order: Literal["newest", "oldest"] = "newest",
    created_after: datetime | None = None,
    created_before: datetime | None = None,
    limit: int = 50,
    offset: int = 0,
) -> tuple[list[CompositionVersion], int]:
    """One page of the composition's versions, newest (or oldest) first, and how many match.

    ``created_after`` is inclusive and ``created_before`` exclusive. Their content is not loaded: a view
    does not show it.
    """
    query = select(CompositionVersion).where(CompositionVersion.composition_id == composition.id)
    if created_after is not None:
        query = query.where(CompositionVersion.created_at >= _utc(created_after))
    if created_before is not None:
        query = query.where(CompositionVersion.created_at < _utc(created_before))
    total = int(await session.scalar(select(func.count()).select_from(query.subquery())) or 0)
    ordinal = CompositionVersion.ordinal.desc() if order == "newest" else CompositionVersion.ordinal.asc()
    rows = (await session.scalars(
        query.options(defer(CompositionVersion.content)).order_by(ordinal).offset(offset).limit(limit)
    )).all()
    return list(rows), total


async def details(session: AsyncSession, versions: list[CompositionVersion], *, light: bool = False) -> list[Detail]:
    """What the views of ``versions`` show, in a fixed number of queries whatever their number.

    ``light`` leaves out what only a whole evaluation shows (its result and diagnostics), for views that
    name the current evaluation only.
    """
    if not versions:
        return []
    ids = [version.id for version in versions]
    evaluations: dict[uuid.UUID, list[CompositionEvaluation]] = {identifier: [] for identifier in ids}
    query = select(CompositionEvaluation).where(CompositionEvaluation.version_id.in_(ids))
    if light:
        query = query.options(defer(CompositionEvaluation.result), defer(CompositionEvaluation.diagnostics))
    for evaluation in (await session.scalars(
        query.order_by(CompositionEvaluation.created_at, CompositionEvaluation.id)
    )).all():
        evaluations[evaluation.version_id].append(evaluation)

    compilation_ids = {version.linked_compilation_id for version in versions if version.linked_compilation_id}
    compilation_ids |= {
        evaluation.compilation_id for found in evaluations.values() for evaluation in found if evaluation.compilation_id
    }
    compilations = {
        row.id: row for row in (await session.scalars(
            select(ProblemCompilation).where(ProblemCompilation.id.in_(compilation_ids))
        )).all()
    } if compilation_ids else {}
    revision_ids = {version.revision_id for version in versions if version.revision_id}
    links: dict[uuid.UUID, tuple[BindingCase, BindingCaseRevision]] = {}
    if revision_ids:
        for revision, problem in (await session.execute(
            select(BindingCaseRevision, BindingCase)
            .join(BindingCase, BindingCase.id == BindingCaseRevision.binding_case_id)
            .where(BindingCaseRevision.id.in_(revision_ids))
        )).all():
            links[revision.id] = (problem, revision)
    derivations = {
        version_id: Derivation(source.value, job_id, point, revision_id, revision)
        for version_id, source, job_id, point, revision_id, revision in (await session.execute(
            select(
                CompositionDerivation.version_id, CompositionDerivation.source, CompositionDerivation.job_id,
                CompositionDerivation.point, CompositionDerivation.revision_id, BindingCaseRevision.revision,
            )
            .join(BindingCaseRevision, BindingCaseRevision.id == CompositionDerivation.revision_id)
            .where(CompositionDerivation.version_id.in_(ids))
        )).all()
    }

    basis = installed_basis()
    found: list[Detail] = []
    for version in versions:
        link = None
        if version.revision_id in links and version.linked_compilation_id in compilations:
            problem, revision = links[version.revision_id]
            link = Link(problem, revision, compilations[version.linked_compilation_id])
        own = evaluations[version.id]
        found.append(Detail(
            version, own, current_of(own, basis), link, compilations, derivations.get(version.id),
        ))
    return found


async def summaries(session: AsyncSession, composition_ids: list[uuid.UUID]) -> dict[uuid.UUID, Summary]:
    """The latest version of each composition, its version count and whether the latest one is verified, in at most
    three queries whatever the number of compositions."""
    if not composition_ids:
        return {}
    counted = (await session.execute(
        select(
            CompositionVersion.composition_id,
            func.count(CompositionVersion.id),
            func.max(CompositionVersion.ordinal),
        ).where(CompositionVersion.composition_id.in_(composition_ids)).group_by(CompositionVersion.composition_id)
    )).all()
    latest_keys = {(composition_id, ordinal) for composition_id, _, ordinal in counted}
    latest: dict[uuid.UUID, CompositionVersion] = {}
    if latest_keys:
        for version in (await session.scalars(
            select(CompositionVersion).options(defer(CompositionVersion.content)).where(
                CompositionVersion.composition_id.in_([key[0] for key in latest_keys]),
                CompositionVersion.ordinal.in_({key[1] for key in latest_keys}),
            )
        )).all():
            if (version.composition_id, version.ordinal) in latest_keys:
                latest[version.composition_id] = version
    counts = {composition_id: int(count) for composition_id, count, _ in counted}
    verified = await verified_among(session, list(latest.values()))
    return {
        identifier: Summary(
            latest.get(identifier), counts.get(identifier, 0),
            identifier in latest and latest[identifier].id in verified,
        )
        for identifier in composition_ids
    }


async def verified_among(session: AsyncSession, versions: list[CompositionVersion]) -> set[uuid.UUID]:
    """Which of ``versions`` their current evaluation verified (a version view's ``verified``), in one query."""
    linked = [version.id for version in versions if version.values_status == ValuesStatus.VERIFIED]
    if not linked:
        return set()
    evaluations: dict[uuid.UUID, list[CompositionEvaluation]] = {identifier: [] for identifier in linked}
    for evaluation in (await session.scalars(
        select(CompositionEvaluation).options(
            load_only(CompositionEvaluation.version_id, CompositionEvaluation.basis_key, CompositionEvaluation.outcome)
        ).where(CompositionEvaluation.version_id.in_(linked))
        .order_by(CompositionEvaluation.created_at, CompositionEvaluation.id)
    )).all():
        evaluations[evaluation.version_id].append(evaluation)
    basis = installed_basis()
    return {
        identifier for identifier, own in evaluations.items()
        if (current := current_of(own, basis)) is not None and current.outcome == EvaluationOutcome.VERIFIED
    }


__all__ = [
    "Derivation",
    "Detail",
    "Link",
    "Summary",
    "current_of",
    "details",
    "diff_pair",
    "installed_basis",
    "list_versions",
    "required_version",
    "summaries",
    "verified_among",
    "version_by_ref",
]
