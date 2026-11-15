"""The one evaluation path of a composition: a document judged against the problem it links.

Checking, sealing, forking, re-evaluating and evaluating another binding all go through :func:`assess`,
and deriving reuses its steps, so there is one semantics and it is the toolchain's. The document has
already been read by the language (the caller does that, in a language slot); what is left is what an
organization and the toolchain decide:

1. the problem the document links must be one of the organization's (``c2y_problem_foreign`` names a
   problem of another organization without looking it up there), and exist (``c2y_problem_not_found``);
2. the compilation it names must be stored for that revision (``c2y_compilation_not_found``);
3. the binding is evaluated on the **installed** toolchain's compilation of the revision (an IR of another
   release cannot be evaluated), compiled once on a miss without holding a transaction across the compile.
   A package that toolchain refuses is ``c2y_problem_not_recompilable``. When it is not the linked one, the
   two must read the problem alike (equal semantic digests: ``c2y_compilation_superseded``, an info), or
   the document is refused with ``c2y_compilation_semantics_changed`` (derive again);
4. the document is judged against the problem's facts (:func:`~openbinding_gateway.composition.problem.against`):
   a workflow, value or untranslatable candidate finding refuses it without asking the toolchain;
5. the toolchain evaluates the translated binding, in an evaluation slot. Its refusal is
   ``c2y_binding_invalid`` with its message as given, beside the lookup's located explanations
   (``c2y_candidate_not_allowed``, ``c2y_task_local_mismatch``). When it accepts a binding the lookup
   explained, its verdict stands and the gateway logs ``composition_lookup_stricter_than_toolchain``.
   A hard violation is ``c2y_constraint_violated``, a soft one a warning;
6. the values are the toolchain's, as it returned them; a declared value that differs is a warning;
7. a run the evidence names must be the organization's, of the linked revision, and hold the binding.

A document linked to no problem skips all of it: its values are the author's (``declared``).

An assessment writes nothing. It returns the effective document (values replaced, evidence stamped), its
canonical text and digest, every diagnostic (located in the submitted text when the caller passes it) and
the evaluation a seal stores.
"""

from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass, replace
from typing import Any, Iterable, Mapping

from bim_core import BimError, EvaluationError
from bim_core.canonical import digest_bytes
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from ....composition import diagnostics as codes
from ....composition import text
from ....composition.diagnostics import CompositionError, Diagnostic, Path, at
from ....composition.document import Document, Entry, Evidence, ProblemLink, Value
from ....composition.problem import (
    ProblemFacts,
    against,
    computed_values,
    value_findings,
    violation_findings,
)
from ....db.models import BindingCase, BindingCaseRevision, Organization, ProblemCompilation, User
from ....integrations import bim
from ....models.errors import api_error
from ....models.problem import split_detail
from ...execution.application import run_solutions
from ...problems.application import (
    NOT_RECOMPILABLE,
    compilation_by_digest,
    compile_or_get,
    problem_by_ref,
    revision_by_ref,
)
from ..domain.records import EvaluationDraft, Outcome, basis_key, values_json
from .slots import evaluation_slot

logger = logging.getLogger(__name__)

#: What the gateway logs when the toolchain accepts a binding its lookup explained as refused: a bug signal.
STRICTER_THAN_TOOLCHAIN = "composition_lookup_stricter_than_toolchain"

_REF = Path(("problem", "ref"))
_COMPILATION = Path(("problem", "compilation"))
_BINDING = Path(("binding",))
_RUN = Path(("evidence", "run"))
_POINT = Path(("evidence", "point"))


@dataclass(frozen=True, slots=True)
class Resolved:
    """The problem a document links, as the organization holds it.

    ``linked`` is the compilation the document names; ``installed`` the installed toolchain's compilation of
    the same revision, the one evaluated. ``facts`` are read from ``installed``, and are ``None`` when the
    two read the problem differently (the document is not judged further).
    """

    problem: BindingCase
    revision: BindingCaseRevision
    linked: ProblemCompilation
    installed: ProblemCompilation
    facts: ProblemFacts | None


@dataclass(frozen=True, slots=True)
class StoredLink:
    """The problem link a sealed version stores: the revision and the compilation its document names."""

    revision_id: uuid.UUID
    compilation_id: uuid.UUID


@dataclass(frozen=True, slots=True)
class Assessment:
    """What assessing a document found. It writes nothing.

    ``effective`` is the document a seal stores (values replaced or kept, evidence stamped), ``content`` its
    canonical text and ``content_digest`` the digest of those bytes; the three are ``None`` unless the
    assessment is ``valid``. ``diagnostics`` hold every severity, errors first. ``evaluation`` is the
    evaluation a seal stores, ``None`` when the assessment stopped before the toolchain had a say.
    ``evidence_run`` is the run the evidence names, once it is found to hold the binding.
    """

    document: Document
    effective: Document | None
    content: str | None
    content_digest: str | None
    diagnostics: tuple[Diagnostic, ...]
    valid: bool
    problem: Resolved | None = None
    evaluation: EvaluationDraft | None = None
    evidence_run: uuid.UUID | None = None


async def assess(
    session: AsyncSession,
    organization: Organization,
    document: Document,
    *,
    caller: User,
    source: str | None = None,
    language: Iterable[Diagnostic] = (),
    run_evidence: bool = True,
    binding_override: Mapping[str, Entry] | None = None,
    stored: StoredLink | None = None,
    resolved_link: tuple[Resolved | None, tuple[Diagnostic, ...]] | None = None,
) -> Assessment:
    """``document`` judged in ``organization`` against the problem it links, by the toolchain.

    ``source`` is the text the document was read from, if any: new diagnostics are located in it.
    ``language`` are the reading's own findings (warnings and infos: a document with an error is not
    assessed), listed with the rest. ``binding_override`` replaces the binding of the tasks it names before
    anything is judged (another binding of a stored version). ``run_evidence`` false skips the check of the
    run the evidence names. ``stored`` is the link a sealed version stores: the problem is then the one it
    names by id, whatever slugs the document's ref spells (a rename does not break a stored version).
    ``resolved_link`` is what :func:`resolve_link` answered for the document's link, when the caller has
    already resolved it (a derivation reads the problem's facts before it writes the document).

    A document problem is a diagnostic, never an exception. A busy evaluation pool is 429
    ``composition_busy``; a toolchain that cannot answer is its own problem (503 ``bim_unavailable``).
    """
    doc = _overridden(document, binding_override)
    conclude = _Conclusion(document, source, language)
    link = doc.problem
    if link is None:
        evidence = replace(doc.evidence or Evidence(), evaluated_by="declared")
        return conclude(effective=replace(doc, evidence=evidence), evaluation=EvaluationDraft.declared(doc.values))

    if resolved_link is None:
        resolved_link = await resolve_link(session, organization, link, stored=stored)
    resolved, found = resolved_link
    conclude.add(*found)
    if resolved is None:
        return conclude()
    if resolved.facts is None:
        return conclude(problem=resolved, evaluation=_draft(resolved.revision, resolved.installed, "semantics_changed"))
    facts, revision, installed = resolved.facts, resolved.revision, resolved.installed
    resolution = against(doc, facts)
    if resolution.blocking or resolution.bim_binding is None:
        return conclude(*resolution.blocking, problem=resolved)
    binding = resolution.bim_binding

    async with evaluation_slot():
        try:
            result = await bim.abim().evaluate(installed.ir, binding)
        except EvaluationError as error:
            if error.code != "binding_invalid":
                return conclude(
                    at(_BINDING, codes.EVALUATION_FAILED, f"the toolchain could not evaluate the binding: {error.message}"),
                    problem=resolved,
                )
            return conclude(
                at(_BINDING, codes.BINDING_INVALID, error.message or "the toolchain refused the binding"),
                *resolution.pending,
                problem=resolved,
                evaluation=_draft(revision, installed, "binding_invalid", binding=binding),
            )
        except BimError as error:
            raise bim.http_exception_for(error) from error
    if resolution.pending:
        logger.warning(
            "%s: the toolchain accepted a binding the lookup explained as refused (%s)",
            STRICTER_THAN_TOOLCHAIN, ", ".join(sorted({item.code for item in resolution.pending})),
        )

    violations = violation_findings(result.get("violations", ()), facts)
    computed = computed_values(result["features"], facts)
    conclude.add(*violations, *value_findings(doc, computed))
    violated = any(item.severity == "error" for item in violations)

    run = None
    if run_evidence and doc.evidence is not None and doc.evidence.run is not None:
        run, found = await _evidence(session, organization, caller, doc.evidence, binding, revision, installed)
        conclude.add(*found)

    evidence = doc.evidence or Evidence()
    stamped = replace(
        evidence,
        evaluated_by="gateway",
        toolchain=_toolchain(installed.toolchain),
        manual=evidence.manual or evidence.run is None,
    )
    return conclude(
        effective=replace(doc, values=computed, evidence=stamped),
        problem=resolved,
        evaluation=_draft(
            revision, installed, "binding_invalid" if violated else "verified",
            binding=binding, values=computed, result=result,
        ),
        evidence_run=run,
    )


# --------------------------------------------------------------------------- the link


async def resolve_link(
    session: AsyncSession,
    organization: Organization,
    link: ProblemLink,
    *,
    stored: StoredLink | None = None,
) -> tuple[Resolved | None, tuple[Diagnostic, ...]]:
    """The problem ``link`` names in ``organization``, and what resolving it found.

    ``None`` when the link does not resolve (the findings say why). A ``Resolved`` whose ``facts`` are
    ``None`` is a compilation the installed toolchain reads differently (the findings hold the error);
    otherwise the findings hold at most the info that the installed toolchain's compilation is evaluated
    instead of the linked one. ``stored`` resolves the link by the ids a sealed version keeps, not by the
    document's ref.
    """
    if stored is None:
        reference = link.ref
        if not _names(organization, reference.organization):
            return None, (at(
                _REF, codes.PROBLEM_FOREIGN,
                f"the problem {str(reference)!r} is of organization {reference.organization!r}: a composition of "
                f"{organization.slug!r} links a problem of its own organization",
            ),)
        problem = await problem_by_ref(session, organization.id, reference.problem)
        revision = None if problem is None else await revision_by_ref(session, problem, reference.revision)
        if problem is None or revision is None:
            missing = "problem" if problem is None else "revision"
            return None, (at(
                _REF, codes.PROBLEM_NOT_FOUND,
                f"organization {organization.slug!r} has no {missing} {str(reference)!r}",
            ),)
        linked = await compilation_by_digest(session, revision.id, link.compilation)
        if linked is None:
            return None, (at(
                _COMPILATION, codes.COMPILATION_NOT_FOUND,
                f"revision {reference.revision} of {reference.problem!r} has no compilation {link.compilation}: "
                "derive the composition again, or copy the compilation digest from the revision",
            ),)
    else:
        revision = await session.get(BindingCaseRevision, stored.revision_id)
        problem = None if revision is None else await session.get(BindingCase, revision.binding_case_id)
        linked = await session.get(ProblemCompilation, stored.compilation_id)
        if problem is None or revision is None or linked is None:
            # The version's foreign keys keep them; only a bug reaches this.
            return None, (at(_REF, codes.PROBLEM_NOT_FOUND, "the problem this version links no longer exists"),)
    installed, refusal = await installed_compilation(session, revision)
    if installed is None:
        return None, ((refusal,) if refusal is not None else ())

    found: tuple[Diagnostic, ...] = ()
    if installed.id != linked.id:
        if installed.semantic_digest != linked.semantic_digest:
            return Resolved(problem, revision, linked, installed, None), (at(
                _COMPILATION, codes.COMPILATION_SEMANTICS_CHANGED,
                "the installed toolchain reads this revision differently from the compilation the document "
                "names: derive the composition again",
            ),)
        found = (at(
            _COMPILATION, codes.COMPILATION_SUPERSEDED,
            f"the compilation {link.compilation} was made by another toolchain release; the binding is evaluated "
            f"on the installed one's compilation {installed.compilation_digest}, which reads the problem alike",
            severity="info",
        ),)
    if not bim.ir_is_installed(installed.ir):
        # ``compile_or_get`` returns the installed toolchain's compilation; kept as the runs routes keep it.
        raise api_error(422, "contract_not_installed", bim.STALE_IR_MESSAGE)
    facts = ProblemFacts.from_ir(installed.ir, installed.source_map or None)
    return Resolved(problem, revision, linked, installed, facts), found


async def installed_compilation(
    session: AsyncSession, revision: BindingCaseRevision,
) -> tuple[ProblemCompilation | None, Diagnostic | None]:
    """The installed toolchain's compilation of ``revision`` (compiled once on a miss, with no transaction held
    across the compile), or ``c2y_problem_not_recompilable`` when that toolchain refuses its stored package."""
    try:
        return await compile_or_get(session, revision, release_transaction=True), None
    except HTTPException as error:
        refusal = _not_recompilable(error)
        if refusal is None:
            raise
        return None, refusal


# --------------------------------------------------------------------------- the steps


def _overridden(doc: Document, override: Mapping[str, Entry] | None) -> Document:
    if not override:
        return doc
    binding = dict(doc.binding)
    binding.update(override)
    return replace(doc, binding=text.canonical_binding(doc.workflow, binding.items()))


def _names(organization: Organization, written: str) -> bool:
    """Whether ``written`` (a slug or an id) names ``organization``."""
    if written == organization.slug:
        return True
    try:
        return uuid.UUID(written) == organization.id
    except ValueError:
        return False


def _not_recompilable(error: HTTPException) -> Diagnostic | None:
    """``c2y_problem_not_recompilable`` for the toolchain's refusal of a stored package, else ``None``."""
    code, message, _, extra = split_detail(error.detail, "")
    if error.status_code != 422 or code != NOT_RECOMPILABLE:
        return None
    reason = extra.get("reason") if isinstance(extra.get("reason"), Mapping) else {}
    why = ": ".join(str(reason[key]) for key in ("code", "message") if reason.get(key))
    return at(_REF, codes.PROBLEM_NOT_RECOMPILABLE, f"{message} ({why})" if why else message)


def _toolchain(toolchain: Mapping[str, Any] | None) -> str | None:
    """``<name> <version>`` of the toolchain that compiled a problem."""
    if not isinstance(toolchain, Mapping):
        return None
    name, version = toolchain.get("name"), toolchain.get("version")
    return f"{name} {version}" if isinstance(name, str) and isinstance(version, str) and name and version else None


def _draft(
    revision: BindingCaseRevision,
    installed: ProblemCompilation,
    outcome: Outcome,
    *,
    binding: Mapping[str, Mapping[str, str]] | None = None,
    values: Iterable[tuple[str, Value]] = (),
    result: Mapping[str, Any] | None = None,
) -> EvaluationDraft:
    return EvaluationDraft(
        basis="bim",
        basis_key=basis_key(installed.compiler_digest),
        outcome=outcome,
        values=values_json(values),
        revision_id=revision.id,
        compilation_id=installed.id,
        compiler_digest=installed.compiler_digest,
        compilation_digest=installed.compilation_digest,
        semantic_digest=installed.semantic_digest,
        ir_digest=installed.ir_digest,
        toolchain=dict(installed.toolchain or {}),
        binding=None if binding is None else {task: dict(reference) for task, reference in binding.items()},
        result=None if result is None else dict(result),
    )


async def _evidence(
    session: AsyncSession,
    organization: Organization,
    caller: User,
    evidence: Evidence,
    binding: Mapping[str, Mapping[str, str]],
    revision: BindingCaseRevision,
    installed: ProblemCompilation,
) -> tuple[uuid.UUID | None, tuple[Diagnostic, ...]]:
    """The run the evidence names, once it holds the binding; or what is wrong with it."""
    try:
        run_id = uuid.UUID(str(evidence.run))
    except ValueError:
        run = None
    else:
        run = await run_solutions(session, organization.id, run_id, caller)
    if run is None:
        return None, (at(_RUN, codes.RUN_NOT_FOUND, f"organization {organization.slug!r} has no run {evidence.run}"),)
    if run.revision_id != revision.id:
        return None, (at(_RUN, codes.RUN_FOREIGN_REVISION, "the run solved another revision than the one the document links"),)
    if run.compilation_id != installed.id:
        compiled = await session.get(ProblemCompilation, run.compilation_id)
        if compiled is None or compiled.semantic_digest != installed.semantic_digest:
            return None, (at(
                _RUN, codes.RUN_FOREIGN_REVISION,
                "the run solved a compilation that reads the revision differently from the installed toolchain",
            ),)
    where = _POINT if evidence.point is not None else _RUN
    if not run.completed or not any(item is not None for item in run.bindings):
        return None, (at(where, codes.RUN_POINT_INVALID, f"the run has no binding to cite: it is {run.state.value}"),)
    wanted = {task: dict(reference) for task, reference in binding.items()}
    if evidence.point is not None:
        if evidence.point >= len(run.bindings):
            return None, (at(
                _POINT, codes.RUN_POINT_INVALID,
                f"the run has {len(run.bindings)} solutions: a point is one of 0 to {len(run.bindings) - 1}",
            ),)
        chosen = run.bindings[evidence.point]
        if chosen is None:
            return None, (at(_POINT, codes.RUN_POINT_INVALID, f"solution {evidence.point} of the run is not a binding"),)
        if chosen != wanted:
            return None, (at(
                _BINDING, codes.RUN_BINDING_MISMATCH,
                f"the binding is not solution {evidence.point} of the run; they differ on {_differing(wanted, chosen)}",
            ),)
        return run.run_id, ()
    solutions = [item for item in run.bindings if item is not None]
    if wanted in solutions:
        return run.run_id, ()
    closest = min(solutions, key=lambda item: len(_tasks_differing(wanted, item)))
    return None, (at(
        _BINDING, codes.RUN_BINDING_MISMATCH,
        f"the binding is none of the run's solutions; the closest differs on {_differing(wanted, closest)}",
    ),)


def _tasks_differing(one: Mapping[str, Any], other: Mapping[str, Any]) -> list[str]:
    return sorted(task for task in set(one) | set(other) if one.get(task) != other.get(task))


def _differing(one: Mapping[str, Any], other: Mapping[str, Any]) -> str:
    return ", ".join(repr(task) for task in _tasks_differing(one, other))


class _Conclusion:
    """Collects an assessment's findings and closes it: located, ordered, and its text written when valid."""

    def __init__(self, document: Document, source: str | None, language: Iterable[Diagnostic]) -> None:
        self._document = document
        self._source = source
        self._found: list[Diagnostic] = list(language)

    def add(self, *found: Diagnostic) -> None:
        self._found.extend(found)

    def __call__(
        self,
        *found: Diagnostic,
        effective: Document | None = None,
        problem: Resolved | None = None,
        evaluation: EvaluationDraft | None = None,
        evidence_run: uuid.UUID | None = None,
    ) -> Assessment:
        self._found.extend(found)
        diagnostics = self._found
        if self._source is not None:
            diagnostics = list(text.located(diagnostics, self._source))
        valid = not any(item.severity == "error" for item in diagnostics)
        content = digest = None
        if valid and effective is not None:
            try:
                content = text.serialise(effective)
            except CompositionError as error:
                diagnostics += error.diagnostics
                valid = False
            else:
                digest = digest_bytes(content.encode("utf-8"))
        ordered = CompositionError(diagnostics).diagnostics
        if evaluation is not None:
            evaluation = replace(evaluation, diagnostics=ordered)
        return Assessment(
            document=self._document,
            effective=effective if valid else None,
            content=content if valid else None,
            content_digest=digest if valid else None,
            diagnostics=ordered,
            valid=valid,
            problem=problem,
            evaluation=evaluation,
            evidence_run=evidence_run if valid else None,
        )


__all__ = [
    "STRICTER_THAN_TOOLCHAIN",
    "Assessment",
    "Resolved",
    "StoredLink",
    "assess",
    "installed_compilation",
    "resolve_link",
]
