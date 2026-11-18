"""Deriving a composition version from a binding of a problem: a run's solution, or a binding given with a revision.

A derivation is the inverse of a seal: instead of judging a document someone wrote, it writes the document of a
binding the problem already has, through the same evaluation path, and stores it as a version with an edge that
says what it was derived from. It is byte-idempotent: the same compilation and binding give the same bytes, so
deriving again answers the version that holds them.

1. **Resolve.** From a run, its ``result.solutions[point]`` (a failed run, a point out of range or a solution
   that is not a binding is ``c2y_run_point_invalid`` at ``/point``); the document links the compilation the
   run solved. From a binding, ``<problem>@<revision>`` of the organization and ``{task: candidate}``; the
   document links the installed toolchain's compilation.
2. **Semantic gate.** The binding is evaluated on the installed toolchain's compilation, under the rule a
   seal follows: a run compiled by another release derives while the two read the problem alike (an info),
   and is refused with ``c2y_compilation_semantics_changed`` otherwise (re-run it).
3. **Evaluate.** Through :func:`~.assess.assess`, the one evaluation path, with the problem's own workflow:
   one toolchain call. A binding with a hard violation is not derivable.
4. **Build.** :func:`openbinding_gateway.composition.derive.derived` writes the document from the binding the
   toolchain evaluated and the values it computed, the evidence (``{run, point}`` or ``manual: true``), and
   the offering only when the request gives one. A candidate a SPHERE import generated is written with its
   ``from`` (the revision's value origins), so the version names the upstream plan and version it was chosen
   against.
5. **Guard.** The canonical bytes are read again by the language: a refusal there is a bug (500), so a
   derivation never stores bytes its own language refuses.

A refusal is 422 ``derivation_invalid`` with the ``c2y_*`` findings; those about the request point into it
(``/point``, ``/binding/<task>``, ``/offering/url``), the others into the derived document. Storing is the
caller's (:func:`~.seal.persist` with the :class:`~..domain.records.DerivationDraft`).
"""

from __future__ import annotations

import asyncio
import uuid
from dataclasses import dataclass, replace
from typing import Any, Literal, Mapping

from bim_core.canonical import digest, digest_bytes
from fastapi import HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from ....composition import derive as written
from ....composition import diagnostics as codes
from ....composition import ids, text
from ....composition.diagnostics import CompositionError, Diagnostic, Path, at
from ....composition.document import (
    SYNTAX_VERSION,
    Document,
    Entry,
    Evidence,
    Offering,
    ProblemLink,
    ProblemRef,
)
from ....composition.problem import ProblemFacts, document_binding, from_provenance, written_candidate
from ....composition.workflow import tasks
from ....core.settings import get_settings
from ....db.models import (
    BindingCase,
    BindingCaseRevision,
    Composition,
    Organization,
    ProblemCompilation,
    User,
)
from ....models.errors import api_error
from ...execution.application import RunSolutions, run_solutions
from ...problems.application import problem_by_ref, revision_by_ref
from ..domain.records import DerivationDraft
from .assess import Assessment, StoredLink, assess, installed_compilation, recorded_provenance, resolve_link
from .language import diagnostic_view
from .slots import language_slot

_POINT = Path(("point",))
_BINDING = "binding"


class DerivationBug(RuntimeError):
    """A derived document its own language refuses: a bug, answered 500."""


@dataclass(frozen=True, slots=True)
class Derived:
    """A derived version before it is stored.

    ``assessment`` is the evaluation path's verdict with the derived document as its effective document, its
    canonical text and digest, and every diagnostic (located in that text); ``derivation`` the edge a seal
    stores with the version.
    """

    assessment: Assessment
    derivation: DerivationDraft

    @property
    def document(self) -> Document:
        assert self.assessment.effective is not None
        return self.assessment.effective

    @property
    def content(self) -> str:
        assert self.assessment.content is not None
        return self.assessment.content

    @property
    def diagnostics(self) -> tuple[Diagnostic, ...]:
        return self.assessment.diagnostics


@dataclass(frozen=True, slots=True)
class _Source:
    """Where a derivation starts: a problem revision, the compilation the document links, and the binding."""

    kind: Literal["run", "binding"]
    problem: BindingCase
    revision: BindingCaseRevision
    linked: ProblemCompilation
    run: RunSolutions | None = None
    point: int | None = None
    #: The run's solution, as the toolchain takes it.
    run_binding: Mapping[str, Mapping[str, str]] | None = None
    #: The request's ``{task: candidate}``.
    request_binding: Mapping[str, str] | None = None


def _refused(found: tuple[Diagnostic, ...] | list[Diagnostic], message: str | None = None) -> HTTPException:
    return api_error(
        422, "derivation_invalid", message or "The binding cannot be derived; `diagnostics` says why.",
        diagnostics=[diagnostic_view(item) for item in CompositionError(found).diagnostics],
    )


def _context(slug: str) -> text.Context:
    return text.Context(registries=get_settings().sphere_registry_aliases, entity_slug=slug)


# --------------------------------------------------------------------------- the offering


def _offering(raw: Mapping[str, Any], slug: str, label: str, kind: str) -> Offering:
    """The request's offering, read by the language's own offering rules; 422 at ``/offering/...``."""
    probe = {
        "syntaxVersion": SYNTAX_VERSION, "composition": slug, "version": label, "kind": kind,
        "workflow": None, "binding": {}, "values": {}, "offering": dict(raw),
    }
    reading = text.compose(probe, context=_context(slug))
    if reading.document is None or reading.document.offering is None:
        raise _refused(reading.errors or reading.diagnostics, "The offering is not one; `diagnostics` says why.")
    return reading.document.offering


# --------------------------------------------------------------------------- the sources


async def _from_run(
    session: AsyncSession, organization: Organization, caller: User, run_id: uuid.UUID, point: int,
) -> _Source:
    run = await run_solutions(session, organization.id, run_id, caller)
    if run is None:
        raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "Run not found.")
    if not run.completed:
        raise _refused([at(_POINT, codes.RUN_POINT_INVALID, f"the run has no solution to derive: it is {run.state.value}")])
    if point >= len(run.bindings):
        raise _refused([at(
            _POINT, codes.RUN_POINT_INVALID,
            "the run has no solution" if not run.bindings
            else f"the run has {len(run.bindings)} solutions: a point is one of 0 to {len(run.bindings) - 1}",
        )])
    chosen = run.bindings[point]
    if chosen is None:
        raise _refused([at(_POINT, codes.RUN_POINT_INVALID, f"solution {point} of the run is not a binding")])
    revision = await session.get(BindingCaseRevision, run.revision_id)
    problem = None if revision is None else await session.get(BindingCase, revision.binding_case_id)
    linked = await session.get(ProblemCompilation, run.compilation_id)
    if revision is None or problem is None or linked is None:  # the run's foreign keys keep them
        raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "Run not found.")
    return _Source("run", problem, revision, linked, run=run, point=point, run_binding=chosen)


async def _from_binding(
    session: AsyncSession, organization: Organization, reference: str, binding: Mapping[str, str],
) -> _Source:
    problem_ref, _, revision_ref = reference.rpartition("@")
    problem = await problem_by_ref(session, organization.id, problem_ref) if problem_ref and revision_ref else None
    revision = None if problem is None else await revision_by_ref(session, problem, revision_ref)
    if problem is None or revision is None:
        raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "Problem revision not found.")
    installed, refusal = await installed_compilation(session, revision)
    if installed is None:
        raise _refused([refusal] if refusal is not None else [])
    return _Source("binding", problem, revision, installed, request_binding=dict(binding))


def _entries(
    source: _Source, facts: ProblemFacts, provenance: Mapping[str, Mapping[str, Any]],
) -> tuple[tuple[str, Entry], ...]:
    """The document's binding: the run's solution as a document writes it, or the request's binding with
    every local task bound ``local: true``; 422 for what does not fit the problem's workflow. A candidate a SPHERE
    import generated carries its ``from`` (``provenance``)."""
    if source.run_binding is not None:
        try:
            return document_binding(source.run_binding, facts, provenance)
        except ValueError as error:
            raise _refused([at(_POINT, codes.RUN_POINT_INVALID, f"solution {source.point} of the run: {error}")]) from None
    given = source.request_binding or {}
    known = tasks(facts.workflow)  # each once, in workflow order
    found: list[Diagnostic] = []
    for task, candidate in given.items():
        path = Path((_BINDING, task))
        if task not in known:
            found.append(at(
                path, codes.BINDING_UNKNOWN_TASK,
                f"the problem's workflow has no task {task!r}; its tasks are " + ", ".join(map(repr, sorted(known))),
            ))
        elif not ids.CANDIDATE.fullmatch(candidate):
            found.append(at(
                path, codes.CANDIDATE_REF_INVALID, f"{candidate!r} is not a candidate reference: an id, or <resource>/<id>",
            ))
    entries: list[tuple[str, Entry]] = []
    for task in known:
        if task in given:
            entries.append((task, Entry(candidate=given[task], source=_from_of(task, given[task], facts, provenance))))
        elif task in facts.local_tasks:
            entries.append((task, Entry(local=True)))
        else:
            found.append(at(
                Path((_BINDING, task)), codes.TASK_UNBOUND,
                f"task {task!r} of the problem has no candidate: bind one of its eligible candidates",
            ))
    if found:
        raise _refused(found)
    return tuple(entries)


def _in_request(found: tuple[Diagnostic, ...], source: _Source) -> tuple[Diagnostic, ...]:
    """Findings about a task the request binds, pointed at that task in the request (``/binding/<task>``)."""
    given = source.request_binding
    if given is None:
        return found
    pointed: list[Diagnostic] = []
    for item in found:
        segments = Path.from_pointer(item.pointer) if item.pointer else Path()
        if len(segments) >= 2 and segments[0] == _BINDING and segments[1] in given:
            where = Path((_BINDING, segments[1]))
            item = replace(item, path=where.dotted, pointer=where.pointer, span=None)
        pointed.append(item)
    return tuple(pointed)


def _gate(found: tuple[Diagnostic, ...], source: _Source) -> tuple[Diagnostic, ...]:
    """The link's findings; a run's compilation read differently is to be re-run, not derived again."""
    if source.kind != "run":
        return found
    return tuple(
        replace(item, message=(
            "the installed toolchain reads this revision differently from the compilation the run solved: "
            "run the problem again and derive from the new run"
        )) if item.code == codes.COMPILATION_SEMANTICS_CHANGED else item
        for item in found
    )


def _from_of(task: str, candidate: str, facts: ProblemFacts, provenance: Mapping[str, Mapping[str, Any]]):
    """The ``from`` of a candidate the request names for ``task``, when a SPHERE import generated it."""
    matches = [
        reference for reference in facts.eligibility.get(task, ())
        if written_candidate(task, reference.as_bim(), facts) == candidate or str(reference) == candidate
    ]
    return from_provenance(provenance.get(str(matches[0]))) if len(matches) == 1 else None


def _provenance(installed: ProblemCompilation, run: RunSolutions | None) -> dict[str, Any]:
    ran = None
    if run is not None:
        ran = {key: run.provenance.get(key) for key in ("engine", "engineDigest", "mode", "evaluatorDigest")}
    return {
        "toolchain": dict(installed.toolchain or {}),
        "irDigest": installed.ir_digest,
        "semanticDigest": installed.semantic_digest,
        "evaluatedCompilationId": str(installed.id),
        "run": ran,
    }


def _guard(content: str, slug: str) -> text.Reading:
    return text.read(content, context=_context(slug))


# --------------------------------------------------------------------------- the derivation


async def derive_version(
    session: AsyncSession,
    organization: Organization,
    composition: Composition,
    *,
    caller: User,
    label: str,
    kind: str | None = None,
    offering: Mapping[str, Any] | None = None,
    run: uuid.UUID | None = None,
    point: int = 0,
    revision: str | None = None,
    binding: Mapping[str, str] | None = None,
) -> Derived:
    """The version of ``composition`` labelled ``label`` that a binding derives to, evaluated; nothing stored.

    Exactly one source: ``run`` (and ``point``, a solution index), or ``revision`` (``<problem>@<revision>``)
    and ``binding`` (``{task: candidate}``). ``kind`` defaults to the composition's; ``offering`` is written
    only when given. A run or revision the organization does not have is 404; anything else that cannot be
    derived is 422 ``derivation_invalid``.
    """
    kind = kind or composition.kind.value
    chosen = None if offering is None else _offering(offering, composition.slug, label, kind)
    if run is not None:
        source = await _from_run(session, organization, caller, run, point)
    elif revision is not None and binding is not None:
        source = await _from_binding(session, organization, revision, binding)
    else:
        raise ValueError("a derivation has exactly one source: a run, or a revision and a binding")

    revision_row, linked = source.revision, source.linked
    link = ProblemLink(
        ref=ProblemRef(organization.slug, source.problem.slug, str(revision_row.revision)),
        compilation=linked.compilation_digest,
    )
    resolved, found = await resolve_link(
        session, organization, link, stored=StoredLink(revision_row.id, linked.id),
    )
    found = _gate(found, source)
    if resolved is None or resolved.facts is None:
        raise _refused(found)
    facts = resolved.facts
    provenance = await recorded_provenance(session, revision_row.id)

    workflow = written.written(facts.workflow)
    evidence = Evidence(run=str(source.run.run_id), point=source.point) if source.run is not None else Evidence(manual=True)
    probe = Document(
        syntax_version=SYNTAX_VERSION,
        composition=composition.slug,
        version=label,
        kind=kind,
        problem=link,
        workflow=workflow,
        binding=text.canonical_binding(workflow, _entries(source, facts, provenance)),
        values=(),
        evidence=evidence,
    )
    assessment = await assess(
        session, organization, probe,
        caller=caller, run_evidence=source.run is not None, resolved_link=(resolved, found),
    )
    draft = assessment.evaluation
    if (
        not assessment.valid or assessment.effective is None or draft is None
        or draft.binding is None or draft.result is None
    ):
        raise _refused(_in_request(assessment.diagnostics, source))

    document = written.derived(
        slug=composition.slug,
        label=label,
        kind=kind,
        problem_ref=link.ref,
        compilation_digest=link.compilation,
        facts=facts,
        bim_binding=draft.binding,
        features=draft.result["features"],
        evidence=assessment.effective.evidence or evidence,
        offering=chosen,
        provenance=provenance,
    )
    try:
        content = text.serialise(document)
    except CompositionError as error:
        raise _refused(error.diagnostics) from None
    async with language_slot():
        reading = await asyncio.to_thread(_guard, content, composition.slug)
    if reading.document is None or reading.document != document:
        raise DerivationBug(
            "a derived document does not read back as itself: "
            + "; ".join(f"{item.code} at {item.path}" for item in reading.errors)
        )

    found_all = CompositionError(
        text.located((*assessment.diagnostics, *reading.diagnostics), content),
    ).diagnostics
    binding_json = {task: dict(reference) for task, reference in draft.binding.items()}
    return Derived(
        assessment=replace(
            assessment,
            effective=document,
            content=content,
            content_digest=digest_bytes(content.encode("utf-8")),
            diagnostics=found_all,
            evaluation=replace(draft, diagnostics=found_all),
        ),
        derivation=DerivationDraft(
            source=source.kind,
            revision_id=revision_row.id,
            compilation_id=linked.id,
            binding=binding_json,
            binding_digest=digest(binding_json),
            provenance=_provenance(resolved.installed, source.run),
            job_id=None if source.run is None else source.run.run_id,
            point=source.point,
        ),
    )


__all__ = ["DerivationBug", "Derived", "derive_version"]
