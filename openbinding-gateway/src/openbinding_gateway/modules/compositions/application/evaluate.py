"""A sealed version evaluated again: by the installed toolchain, with another binding, and around its binding.

All three start from the version's **stored** bytes, read in the stored mode (they read when they were sealed,
whatever registries the deployment defines today), and from the link ids the version stores, so renaming the
organization or the problem breaks nothing. The binding is evaluated on the installed toolchain's compilation
of the linked revision under the same rule as a seal: a compilation that reads the problem alike is evaluated
instead of the linked one (an info), one that reads it differently is ``c2y_compilation_semantics_changed``.

* :func:`reevaluate` stores the installed toolchain's evaluation of a version, whatever its outcome
  (``verified``, ``binding_invalid``, ``semantics_changed``): one per toolchain release, through
  :func:`~.seal.insert_evaluation`, the one writer of evaluations. It is two-phase like a seal: the
  assessment runs with no lock and no write transaction, then one short transaction locks the composition
  and inserts, so two concurrent re-evaluations store one row. The version never changes.
* :func:`evaluate_binding` evaluates the version's binding with some tasks bound otherwise, the calculator
  behind an editor: nothing is stored, and findings about the tasks the caller rebound point into the
  request (``/binding/<task>``).
* :func:`neighbourhood` has the toolchain evaluate the one-task alternatives of the version's binding
  (``canonical-one-task-counterfactuals``), each move also named as a document names a candidate.

A version linked to no problem has nothing the toolchain could evaluate: re-evaluating answers its declared
evaluation, and the other two are 422 ``composition_not_linked``.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, replace
from typing import Any, Mapping

from bim_core import BimError
from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ....composition import diagnostics as codes
from ....composition import ids, text
from ....composition.diagnostics import Diagnostic, Path, at
from ....composition.document import Document, Entry
from ....composition.problem import against, written_candidate
from ....composition.workflow import tasks
from ....db.models import Composition, CompositionEvaluation, CompositionVersion, Organization, User
from ....integrations import bim
from ....models.errors import api_error
from ...shared.application import audit
from ..domain.records import DECLARED
from .offering import with_offering
from .assess import Assessment, StoredLink, assess, resolve_link
from .compositions import TARGET
from .language import diagnostic_view
from .seal import insert_evaluation
from .slots import evaluation_slot, language_slot
from .versions import installed_basis, required_version

#: The toolchain's own budget for one neighbourhood, in seconds (cooperative, between evaluations).
NEIGHBOURHOOD_SECONDS = 2.0


@dataclass(frozen=True, slots=True)
class Reevaluated:
    """The installed toolchain's evaluation of a version: stored now (``created``) or already."""

    evaluation: CompositionEvaluation
    created: bool


@dataclass(frozen=True, slots=True)
class Evaluated:
    """Another binding of a version, as the toolchain evaluated it; nothing was stored."""

    version: CompositionVersion
    valid: bool
    values: Mapping[str, Mapping[str, Any]]
    violations: list[dict[str, Any]]
    diagnostics: tuple[Diagnostic, ...]


# --------------------------------------------------------------------------- shared steps


async def _stored(version: CompositionVersion) -> Document:
    """The version's document, read from its stored bytes in a language slot."""
    async with language_slot():
        return await asyncio.to_thread(text.read_stored, version.content)


def _link(version: CompositionVersion) -> StoredLink | None:
    if version.revision_id is None or version.linked_compilation_id is None:
        return None
    return StoredLink(version.revision_id, version.linked_compilation_id)


async def _linked_version(
    session: AsyncSession, composition: Composition, ref: str | None,
) -> tuple[CompositionVersion, StoredLink]:
    """The version ``ref`` names (the latest by default) and its stored link.

    409 ``composition_empty`` when there is no version to default to; 422 ``composition_not_linked`` when
    the version links no problem.
    """
    if ref is not None:
        version = await required_version(session, composition, ref)
    else:
        latest = await session.scalar(
            select(CompositionVersion).where(CompositionVersion.composition_id == composition.id)
            .order_by(CompositionVersion.ordinal.desc()).limit(1)
        )
        if latest is None:
            raise api_error(
                status.HTTP_409_CONFLICT, "composition_empty",
                "This composition has no version yet: seal one before evaluating it.",
            )
        version = latest
    link = _link(version)
    if link is None:
        raise api_error(
            422, "composition_not_linked",
            f"Version {version.label} links no problem: its values are declared, and the toolchain has nothing to "
            "evaluate them against.",
        )
    return version, link


def _not_evaluable(found: tuple[Diagnostic, ...] | list[Diagnostic], message: str) -> HTTPException:
    return api_error(
        422, "evaluation_invalid", message, diagnostics=[diagnostic_view(item) for item in found],
    )


# --------------------------------------------------------------------------- re-evaluation


async def _evaluation_of(session: AsyncSession, version: CompositionVersion, key: str) -> CompositionEvaluation | None:
    return await session.scalar(select(CompositionEvaluation).where(
        CompositionEvaluation.version_id == version.id, CompositionEvaluation.basis_key == key,
    ))


async def reevaluate(
    session: AsyncSession,
    organization: Organization,
    composition: Composition,
    version: CompositionVersion,
    *,
    actor: User,
) -> Reevaluated:
    """The installed toolchain's evaluation of ``version``: stored now, or the one it already has; committed.

    A declared version answers its declared evaluation. An outcome other than ``verified`` is stored all
    the same (``binding_invalid``, ``semantics_changed``). Only an assessment that stops before the
    toolchain has a say (its package no longer compiles, the evaluation fails) stores nothing: 422
    ``evaluation_invalid`` with the diagnostics.
    """
    link = _link(version)
    if link is None:
        declared = await _evaluation_of(session, version, DECLARED)
        if declared is None:  # every sealed version has one
            raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "Version not found.")
        return Reevaluated(declared, False)
    basis = installed_basis()
    if basis is not None:
        existing = await _evaluation_of(session, version, basis)
        if existing is not None:
            return Reevaluated(existing, False)

    document = await _stored(version)
    assessment = await assess(
        session, organization, document,
        caller=actor, source=version.content, run_evidence=False, stored=link,
    )
    if assessment.evaluation is None:
        raise _not_evaluable(
            assessment.diagnostics,
            "The installed toolchain could not evaluate this version; `diagnostics` says why.",
        )
    # A new basis: the evaluation row is new, so the offering version read now is recorded with it.
    assessment = await with_offering(session, organization, assessment, actor, source=version.content)
    draft = assessment.evaluation
    assert draft is not None

    # Phase 1 read in a transaction of its own; nothing it holds is kept across this one.
    await session.commit()
    locked = await session.scalar(
        select(Composition).where(Composition.id == composition.id)
        .with_for_update(key_share=True).execution_options(populate_existing=True)
    )
    if locked is None or await session.get(CompositionVersion, version.id, populate_existing=True) is None:
        await session.rollback()
        raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "Version not found.")
    evaluation, created = await insert_evaluation(session, version, draft, actor=actor)
    if created:
        audit(
            session, actor, "composition.version_evaluated", TARGET, composition.id, composition.organization_id,
            version_id=str(version.id), label=version.label, basis_key=draft.basis_key, outcome=draft.outcome,
        )
    await session.commit()
    return Reevaluated(evaluation, created)


# --------------------------------------------------------------------------- another binding


def _rebound(document: Document, binding: Mapping[str, str]) -> dict[str, Entry]:
    """The entries ``binding`` (task -> candidate ref) gives; 422 ``evaluation_invalid`` for a task the
    workflow does not have or a ref that is not one."""
    known = set(tasks(document.workflow))
    found: list[Diagnostic] = []
    entries: dict[str, Entry] = {}
    for task, candidate in binding.items():
        path = Path(("binding", task))
        if task not in known:
            found.append(at(
                path, codes.BINDING_UNKNOWN_TASK,
                f"the version's workflow has no task {task!r}; its tasks are "
                + ", ".join(repr(name) for name in sorted(known)),
            ))
        elif not ids.CANDIDATE.fullmatch(candidate):
            found.append(at(
                path, codes.CANDIDATE_REF_INVALID,
                f"{candidate!r} is not a candidate reference: an id, or <resource>/<id>",
            ))
        else:
            entries[task] = Entry(candidate=candidate)
    if found:
        raise _not_evaluable(found, "The binding names what the version does not have; `diagnostics` says where.")
    return entries


def _in_request(found: tuple[Diagnostic, ...], rebound: Mapping[str, Entry]) -> tuple[Diagnostic, ...]:
    """Findings about a task the caller rebound, pointed at that task in the request (``/binding/<task>``)."""
    pointed: list[Diagnostic] = []
    for item in found:
        segments = Path.from_pointer(item.pointer) if item.pointer else Path()
        if len(segments) >= 2 and segments[0] == "binding" and segments[1] in rebound:
            where = Path(("binding", segments[1]))
            item = replace(item, path=where.dotted, pointer=where.pointer, span=None)
        pointed.append(item)
    return tuple(pointed)


async def evaluate_binding(
    session: AsyncSession,
    organization: Organization,
    composition: Composition,
    *,
    version_ref: str | None,
    binding: Mapping[str, str] | None,
    caller: User,
) -> Evaluated:
    """The version ``version_ref`` names (the latest by default), with the tasks ``binding`` names bound to
    those candidates, evaluated by the installed toolchain. Nothing is stored.

    A binding the toolchain evaluated answers, valid or not (a hard violation). One it could not (an
    unknown candidate, the toolchain's refusal, a problem read differently) is 422 ``evaluation_invalid``.
    """
    version, link = await _linked_version(session, composition, version_ref)
    document = await _stored(version)
    rebound = _rebound(document, binding or {})
    if rebound:
        # The version's values are its own binding's: compared with another binding's, every one would differ.
        document = replace(document, values=())
    assessment: Assessment = await assess(
        session, organization, document,
        caller=caller, run_evidence=False, binding_override=rebound or None, stored=link,
    )
    found = _in_request(assessment.diagnostics, rebound)
    draft = assessment.evaluation
    if draft is None or draft.result is None:
        raise _not_evaluable(found, "The toolchain could not evaluate this binding; `diagnostics` says why.")
    return Evaluated(
        version=version,
        valid=assessment.valid,
        values=draft.values,
        violations=[dict(item) for item in draft.result.get("violations") or ()],
        diagnostics=found,
    )


# --------------------------------------------------------------------------- the neighbourhood


async def neighbourhood(
    session: AsyncSession,
    organization: Organization,
    composition: Composition,
    *,
    version_ref: str | None,
    task: str | None,
    limit: int,
) -> tuple[CompositionVersion, dict[str, Any]]:
    """The toolchain's one-task alternatives of the binding of the version ``version_ref`` names (the
    latest by default), on the installed toolchain's compilation; at most ``limit`` evaluations.

    Each move's ``to`` is also given as ``candidate``, the way a document names it. A compilation the
    installed toolchain reads differently is 422 with its diagnostic's code; a binding or a task the
    toolchain cannot analyse is 422 ``analysis_invalid``.
    """
    version, link = await _linked_version(session, composition, version_ref)
    document = await _stored(version)
    assert document.problem is not None  # a linked version's document links its problem
    resolved, found = await resolve_link(session, organization, document.problem, stored=link)
    if resolved is None or resolved.facts is None:
        errors = [item for item in found if item.severity == "error"]
        raise api_error(
            422, errors[0].code if errors else "analysis_invalid",
            "The installed toolchain cannot analyse this version; `diagnostics` says why.",
            diagnostics=[diagnostic_view(item) for item in found],
        )
    facts = resolved.facts
    resolution = against(document, facts)
    if resolution.bim_binding is None:
        raise api_error(
            422, "analysis_invalid", "The version's binding cannot be sent to the toolchain; `diagnostics` says why.",
            diagnostics=[diagnostic_view(item) for item in resolution.blocking],
        )
    async with evaluation_slot():
        try:
            result = await bim.abim().neighborhood(
                resolved.installed.ir, resolution.bim_binding,
                task=task, limit=limit, seconds=NEIGHBOURHOOD_SECONDS,
            )
        except (ValueError, ArithmeticError) as error:
            raise api_error(422, "analysis_invalid", str(error)[:300]) from error
        except BimError as error:
            raise bim.http_exception_for(error) from error
    moves = []
    for move in result.get("moves") or ():
        moved = dict(move)
        moved["candidate"] = written_candidate(str(move["task"]), move["to"], facts)
        moves.append(moved)
    return version, {**result, "moves": moves}


__all__ = [
    "NEIGHBOURHOOD_SECONDS",
    "Evaluated",
    "Reevaluated",
    "evaluate_binding",
    "neighbourhood",
    "reevaluate",
]
