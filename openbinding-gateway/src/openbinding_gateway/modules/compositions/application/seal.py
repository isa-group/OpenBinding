"""Sealing a composition version: its canonical bytes and its evaluation, stored once and never changed.

To seal is to read the document, judge it and, when it links a problem, have the toolchain check its
binding and compute its values (:func:`~.assess.assess`); then to store the canonical bytes of the effective
document as a new version, with the evaluation that judged it. ``check`` is the same pipeline without
storing: the editor's lint against the problem.

Sealing is two-phase. Everything slow (reading, compiling on a miss, evaluating) has already run when
:func:`persist` starts, with no lock and no write transaction. :func:`persist` is then one short transaction:
lock the composition row, deduplicate by content digest (the same meaning sealed twice is one version),
refuse a label another content holds, number the version, insert it with its evaluation, and let the
composition's ``kind`` follow it. The row lock serialises the seals of one composition and orders them
against deleting it or its organization. A derived version stores, in the same transaction, the edge that
says what it was derived from (:func:`insert_derivation`).

:func:`insert_evaluation` is the only code that inserts evaluation rows, for a new version, for a version
sealed again and for a re-evaluation (:mod:`.evaluate`). The diagnostics it stores are located in the version's own
content, which is what an editor shows of a stored version; the seal and check responses keep the spans of
the text that was submitted, which is what the author is looking at.
"""

from __future__ import annotations

import asyncio
import uuid
from dataclasses import dataclass, replace
from typing import Any, Iterable

from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from . import follows
from ....composition import diagnostics as codes
from ....composition import spans, text
from ....composition.diagnostics import Diagnostic, Path, at
from ....composition.document import Document
from ....core.settings import get_settings
from ....db.models import (
    Composition,
    CompositionDerivation,
    CompositionEvaluation,
    CompositionKind,
    CompositionVersion,
    DerivationSource,
    EvaluationBasis,
    EvaluationOutcome,
    Job,
    Organization,
    ProblemCompilation,
    User,
    ValuesStatus,
)
from ....models.errors import api_error
from ...shared.application import audit
from ..domain.analytics import analytics
from ..domain.records import DerivationDraft, EvaluationDraft
from .assess import Assessment, assess
from .compositions import TARGET
from .language import decode, diagnostic_view
from .slots import language_slot

#: The outcomes a seal stores; the others come from re-evaluating a stored version.
SEALED_OUTCOMES = frozenset({"verified", "declared"})


@dataclass(frozen=True, slots=True)
class Checked:
    """What judging a submitted document found.

    ``assessment`` is ``None`` when the language refused the document before it could be assessed;
    ``diagnostics`` then are the reading's. Otherwise they are the assessment's, every severity, located in
    the submitted text.
    """

    diagnostics: tuple[Diagnostic, ...]
    assessment: Assessment | None = None

    @property
    def valid(self) -> bool:
        return self.assessment is not None and self.assessment.valid


@dataclass(frozen=True, slots=True)
class Sealed:
    """A sealed version and the evaluation stored for it; ``created`` is false when the bytes already were.

    ``derivation`` is the version's derivation edge, when the seal was a derivation.
    """

    version: CompositionVersion
    evaluation: CompositionEvaluation
    created: bool
    derivation: CompositionDerivation | None = None


# --------------------------------------------------------------------------- phase 1: judging


def _read(raw: bytes, entity_slug: str) -> tuple[str | None, text.Reading]:
    decoded = decode(raw)
    if isinstance(decoded, Diagnostic):
        return None, text.Reading(None, (decoded,))
    context = text.Context(registries=get_settings().sphere_registry_aliases, entity_slug=entity_slug)
    return decoded, text.read(decoded, context=context)


async def judge(
    session: AsyncSession, organization: Organization, slug: str, raw: bytes, caller: User,
) -> Checked:
    """``raw`` read as a submission to the composition ``slug`` and assessed in ``organization``.

    Nothing is stored. The reading is the full one (the deployment's registries, the composition's slug)
    and runs in a language slot; the assessment evaluates in an evaluation slot.
    """
    async with language_slot():
        source, reading = await asyncio.to_thread(_read, raw, slug)
    if reading.document is None or source is None:
        return Checked(reading.diagnostics)
    assessment = await assess(
        session, organization, reading.document, caller=caller, source=source, language=reading.diagnostics,
    )
    return Checked(assessment.diagnostics, assessment)


async def check(
    session: AsyncSession, organization: Organization, composition: Composition, raw: bytes, caller: User,
) -> Checked:
    """``raw`` read as a submission to ``composition`` and assessed in ``organization``; nothing is stored."""
    return await judge(session, organization, composition.slug, raw, caller)


# --------------------------------------------------------------------------- the stored evaluation


def relocated(diagnostics: Iterable[Diagnostic], content: str) -> list[dict[str, Any]]:
    """``diagnostics`` as stored with a version: their spans in ``content``, the version's own text.

    A path that does not resolve exactly in the content (a value the seal dropped, a bare number addressed
    at its ``.value``) gets no span; the path and the pointer always stay.
    """
    found = list(diagnostics)
    paths = {
        position: Path.from_pointer(item.pointer)
        for position, item in enumerate(found) if item.pointer is not None and item.code != codes.MORE
    }
    placed = spans.locate(content, set(paths.values())) if paths else {}
    return [
        diagnostic_view(replace(item, span=placed.get(paths[position]) if position in paths else None))
        for position, item in enumerate(found)
    ]


async def _evaluation_of(session: AsyncSession, version_id: uuid.UUID, key: str) -> CompositionEvaluation | None:
    return await session.scalar(select(CompositionEvaluation).where(
        CompositionEvaluation.version_id == version_id, CompositionEvaluation.basis_key == key,
    ))


async def insert_evaluation(
    session: AsyncSession, version: CompositionVersion, draft: EvaluationDraft, *, actor: User,
) -> tuple[CompositionEvaluation, bool]:
    """The evaluation of ``version`` on ``draft``'s basis: stored now (``True``) or already (``False``).

    The only code that inserts evaluation rows. It runs in its caller's transaction, which holds the
    composition's row lock. A concurrent insert of the same ``(version, basis_key)`` is caught in a
    savepoint (on PostgreSQL an error outside one aborts the whole transaction) and answered with the
    row that won.
    """
    existing = await _evaluation_of(session, version.id, draft.basis_key)
    if existing is not None:
        return existing, False
    row = CompositionEvaluation(
        version_id=version.id,
        basis=EvaluationBasis(draft.basis),
        basis_key=draft.basis_key,
        outcome=EvaluationOutcome(draft.outcome),
        revision_id=draft.revision_id,
        compilation_id=draft.compilation_id,
        compiler_digest=draft.compiler_digest,
        compilation_digest=draft.compilation_digest,
        semantic_digest=draft.semantic_digest,
        ir_digest=draft.ir_digest,
        toolchain=None if draft.toolchain is None else dict(draft.toolchain),
        binding=None if draft.binding is None else {task: dict(ref) for task, ref in draft.binding.items()},
        values={name: dict(value) for name, value in draft.values.items()},
        result=None if draft.result is None else dict(draft.result),
        diagnostics=relocated(draft.diagnostics, version.content),
        offering_snapshot_id=draft.offering_snapshot_id,
        offering_status=draft.offering_status,
        created_by_id=actor.id,
    )
    try:
        async with session.begin_nested():
            session.add(row)
            await session.flush()
    except IntegrityError:
        won = await _evaluation_of(session, version.id, draft.basis_key)
        if won is None:
            raise
        return won, False
    await session.refresh(row, ["created_at"])
    return row, True


async def _derivation_of(session: AsyncSession, version_id: uuid.UUID) -> CompositionDerivation | None:
    return await session.scalar(select(CompositionDerivation).where(CompositionDerivation.version_id == version_id))


async def insert_derivation(
    session: AsyncSession, version: CompositionVersion, draft: DerivationDraft, *, actor: User,
) -> tuple[CompositionDerivation, bool]:
    """The derivation edge of ``version``: stored now (``True``), or the one it already has (``False``).

    A version has at most one: the same bytes derived again keep the edge they were first derived with. It
    runs in its caller's transaction, which holds the composition's row lock; a concurrent insert is caught
    in a savepoint and answered with the row that won.
    """
    existing = await _derivation_of(session, version.id)
    if existing is not None:
        return existing, False
    row = CompositionDerivation(
        version_id=version.id,
        source=DerivationSource(draft.source),
        revision_id=draft.revision_id,
        compilation_id=draft.compilation_id,
        job_id=draft.job_id,
        point=draft.point,
        binding={task: dict(ref) for task, ref in draft.binding.items()},
        binding_digest=draft.binding_digest,
        provenance=dict(draft.provenance),
        created_by_id=actor.id,
    )
    try:
        async with session.begin_nested():
            session.add(row)
            await session.flush()
    except IntegrityError:
        won = await _derivation_of(session, version.id)
        if won is None:
            raise
        return won, False
    await session.refresh(row, ["created_at"])
    return row, True


# --------------------------------------------------------------------------- phase 2: storing


def _offering(document: Document) -> dict[str, str] | None:
    """The offering's source as a version keeps it: ``{sphere, registry?}`` or ``{url}``."""
    offering = document.offering
    if offering is None:
        return None
    if offering.url is not None:
        return {"url": offering.url}
    source = {"sphere": offering.sphere} if offering.sphere is not None else {}
    if offering.registry is not None:
        source["registry"] = offering.registry
    return source or None


def _label_taken(version: CompositionVersion) -> HTTPException:
    return api_error(
        status.HTTP_409_CONFLICT,
        "version_label_taken",
        f"Version {version.label} of this composition holds another content; give this one another `version:`.",
        version={"id": str(version.id), "ordinal": version.ordinal, "label": version.label},
    )


def _refused(*found: Diagnostic) -> HTTPException:
    return api_error(
        422, "composition_invalid", "The document has errors; `diagnostics` says where.",
        diagnostics=[diagnostic_view(item) for item in found],
    )


async def _version_where(session: AsyncSession, composition_id: uuid.UUID, *condition) -> CompositionVersion | None:
    return await session.scalar(
        select(CompositionVersion).where(CompositionVersion.composition_id == composition_id, *condition)
    )


def _sealable(assessment: Assessment) -> None:
    effective, content, digest, draft = (
        assessment.effective, assessment.content, assessment.content_digest, assessment.evaluation,
    )
    if not assessment.valid or effective is None or content is None or digest is None or draft is None:
        raise ValueError("only a valid assessment is sealed")
    if draft.outcome not in SEALED_OUTCOMES:
        raise ValueError(f"a seal stores no {draft.outcome!r} evaluation")


async def persist(
    session: AsyncSession,
    composition: Composition,
    assessment: Assessment,
    *,
    actor: User,
    based_on: dict[str, Any] | None = None,
    derivation: DerivationDraft | None = None,
) -> Sealed:
    """Store the valid ``assessment`` as a version of ``composition``: one short transaction, committed.

    The same canonical bytes again answer the version that holds them (``created`` false), with an
    evaluation added when this toolchain had none. A label another content holds is 409
    ``version_label_taken``. A problem deleted meanwhile is 422 ``c2y_problem_not_found``. ``derivation``
    is stored with the version, or added to the existing one when it has no derivation yet.
    """
    _sealable(assessment)
    # Phase 1 read in a transaction of its own; nothing it holds is kept across this one.
    await session.commit()

    locked = await session.scalar(
        select(Composition).where(Composition.id == composition.id)
        .with_for_update(key_share=True).execution_options(populate_existing=True)
    )
    if locked is None:
        raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "Composition not found.")
    sealed = await seal_into(session, locked, assessment, actor=actor, based_on=based_on, derivation=derivation)
    await session.commit()
    return sealed


async def seal_into(
    session: AsyncSession,
    composition: Composition,
    assessment: Assessment,
    *,
    actor: User,
    based_on: dict[str, Any] | None = None,
    forked_from: dict[str, Any] | None = None,
    derivation: DerivationDraft | None = None,
) -> Sealed:
    """Store the valid ``assessment`` as a version of ``composition``, in the caller's transaction.

    The caller holds the composition's row lock (``persist``), or created the composition in this very
    transaction (a fork), and commits. The same canonical bytes answer the version that holds them, a label
    another content holds is 409 ``version_label_taken``, and a new version takes the next ordinal.
    """
    _sealable(assessment)
    effective, content, digest, draft = (
        assessment.effective, assessment.content, assessment.content_digest, assessment.evaluation,
    )
    assert effective is not None and content is not None and digest is not None and draft is not None
    resolved = assessment.problem
    existing = await _version_where(session, composition.id, CompositionVersion.content_digest == digest)
    if existing is not None:
        evaluation, _ = await insert_evaluation(session, existing, draft, actor=actor)
        edge = await _derived(session, composition, existing, derivation, actor=actor)
        return Sealed(existing, evaluation, False, edge)
    taken = await _version_where(session, composition.id, CompositionVersion.label == effective.version)
    if taken is not None:
        raise _label_taken(taken)

    ordinal = int(await session.scalar(
        select(func.coalesce(func.max(CompositionVersion.ordinal), 0))
        .where(CompositionVersion.composition_id == composition.id)
    ) or 0) + 1
    version = CompositionVersion(
        composition_id=composition.id,
        ordinal=ordinal,
        label=effective.version,
        syntax_version=effective.syntax_version,
        kind=CompositionKind(effective.kind),
        values_status=ValuesStatus.DECLARED if resolved is None else ValuesStatus.VERIFIED,
        content=content,
        content_digest=digest,
        size_bytes=len(content.encode("utf-8")),
        revision_id=None if resolved is None else resolved.revision.id,
        linked_compilation_id=None if resolved is None else resolved.linked.id,
        evidence_job_id=assessment.evidence_run,
        offering=_offering(effective),
        based_on=based_on,
        forked_from=forked_from,
        analytics=analytics(effective),
        created_by_id=actor.id,
    )
    try:
        async with session.begin_nested():
            session.add(version)
            await session.flush()
    except IntegrityError as error:
        refusal = await _lost_race(session, version)
        if refusal is None:
            raise
        raise refusal from error
    await session.refresh(version, ["created_at"])
    evaluation, _ = await insert_evaluation(session, version, draft, actor=actor)
    edge = await _derived(session, composition, version, derivation, actor=actor)

    if composition.kind != version.kind:
        composition.kind = version.kind
    await session.flush()
    audit(
        session, actor, "composition.version_sealed", TARGET, composition.id, composition.organization_id,
        version_id=str(version.id), ordinal=version.ordinal, label=version.label,
        values_status=version.values_status.value,
    )
    await follows.notify_followers(session, composition, version, actor)
    return Sealed(version, evaluation, True, edge)


async def _derived(
    session: AsyncSession,
    composition: Composition,
    version: CompositionVersion,
    derivation: DerivationDraft | None,
    *,
    actor: User,
) -> CompositionDerivation | None:
    """The derivation edge of ``version``, stored now when ``derivation`` is given and it has none."""
    if derivation is None:
        return None
    edge, created = await insert_derivation(session, version, derivation, actor=actor)
    if created:
        audit(
            session, actor, "composition.derived", TARGET, composition.id, composition.organization_id,
            version_id=str(version.id), label=version.label, source=derivation.source,
            job_id=None if derivation.job_id is None else str(derivation.job_id), point=derivation.point,
        )
    return edge


async def _lost_race(session: AsyncSession, version: CompositionVersion) -> HTTPException | None:
    """What a refused version insert means: a problem or a run deleted meanwhile, said as a diagnostic."""
    if version.linked_compilation_id is not None and await session.get(
        ProblemCompilation, version.linked_compilation_id, populate_existing=True,
    ) is None:
        return _refused(at(
            ("problem", "ref"), codes.PROBLEM_NOT_FOUND,
            "the problem the document links was deleted while the version was being sealed",
        ))
    if version.evidence_job_id is not None and await session.get(
        Job, version.evidence_job_id, populate_existing=True,
    ) is None:
        return _refused(at(
            ("evidence", "run"), codes.RUN_NOT_FOUND,
            "the run the evidence names was deleted while the version was being sealed",
        ))
    return None


__all__ = [
    "SEALED_OUTCOMES",
    "Checked",
    "Sealed",
    "check",
    "insert_derivation",
    "insert_evaluation",
    "judge",
    "persist",
    "relocated",
    "seal_into",
]
