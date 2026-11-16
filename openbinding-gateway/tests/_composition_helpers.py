"""Compositions for the tests: a linked problem, the document of one of its bindings, a finished run of it.

Not a test module (no ``test_`` prefix).

* ``linked_problem`` uploads a package as a problem of a new organization (its OWNER the user given), without
  HTTP, and ``document_for`` writes the canonical Composition2Yaml document of a binding of it, linked to its
  stored compilation;
* ``finished_run`` writes a completed run of that revision whose solutions are real bindings on the real
  compilation (``seed_problem_run``'s minimal IR cannot be evaluated);
* ``OtherToolchain`` (a release that reads every problem alike) and ``SemanticChange`` (a release that reads
  them differently) stand in for the installed toolchain; ``CountingPort`` counts what the port is asked;
  ``Lenient`` accepts every binding the toolchain refuses.
"""

from __future__ import annotations

import copy
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping

from bim_core import EvaluationError
from bim_core.canonical import digest
from test_bim_port_cost import CountingPort
from test_problem_compilations import OTHER_COMPILER, OtherToolchain

from _problem_helpers import EXAMPLE, problem_for
from openbinding_gateway.composition import derive, text
from openbinding_gateway.composition.document import (
    SYNTAX_VERSION,
    Document,
    Entry,
    Evidence,
    Offering,
    ProblemLink,
    ProblemRef,
    Provenance,
    Value,
)
from openbinding_gateway.composition.problem import ProblemFacts

__all__ = [
    "CountingPort",
    "EXAMPLE",
    "Lenient",
    "Linked",
    "OTHER_COMPILER",
    "OtherToolchain",
    "SEMANTIC_COMPILER",
    "SemanticChange",
    "a_user",
    "bim_binding",
    "document_for",
    "finished_run",
    "first_binding",
    "linked_problem",
]

#: The ``compilerDigest`` ``SemanticChange`` reports.
SEMANTIC_COMPILER = "sha256-" + "5" * 64


async def a_user(db):
    """A user with no organization."""
    from openbinding_gateway.db.models import User

    user = User(
        username=f"u{uuid.uuid4().hex[:8]}", email=f"{uuid.uuid4().hex[:8]}@example.org",
        password_hash="x", plan_cache="FREE",
    )
    db.add(user)
    await db.commit()
    return user


@dataclass(frozen=True)
class Linked:
    """A problem of an organization, with its revision and stored compilation (``upload``)."""

    organization: Any
    upload: Any

    @property
    def compilation(self) -> Any:
        return self.upload.compilation

    @property
    def ref(self) -> ProblemRef:
        """``<organization>/problems/<problem>@<revision>``, as a document links it."""
        return ProblemRef(self.organization.slug, self.upload.problem.slug, str(self.upload.revision.revision))

    @property
    def facts(self) -> ProblemFacts:
        return ProblemFacts.from_ir(self.compilation.ir)


async def linked_problem(db, user, path: Path = EXAMPLE, *, organization=None) -> Linked:
    """``path`` uploaded as a problem of ``organization`` (a new one, ``user`` its OWNER, by default)."""
    from openbinding_gateway.db.models import Organization

    upload = await problem_for(db, user, organization=organization, path=path)
    return Linked(await db.get(Organization, upload.problem.organization_id), upload)


def first_binding(ir: Mapping[str, Any]) -> dict[str, str]:
    """The first eligible candidate of every service task, by id; ``local`` for a task done in house."""
    spec = ir["spec"]
    return {
        task: spec["eligibility"][task][0]["id"] if body["kind"] == "service" else "local"
        for task, body in spec["application"]["tasks"].items()
    }


def document_for(
    linked: Linked,
    binding: Mapping[str, str],
    *,
    values: Mapping[str, Value] | None = None,
    evidence: Evidence | None = None,
    offering: Offering | None = None,
    compilation: str | None = None,
    ref: ProblemRef | None = None,
    sources: Mapping[str, Provenance] | None = None,
) -> str:
    """The canonical document of ``binding`` (task -> candidate, or ``local``), linked to the problem.

    The workflow is the problem's. ``compilation`` and ``ref`` replace the link's compilation digest and ref;
    ``sources`` gives tasks their ``from``.
    """
    sources = sources or {}
    workflow = derive.written(linked.facts.workflow)
    entries = [
        (task, Entry(local=True) if candidate == "local" else Entry(candidate=candidate, source=sources.get(task)))
        for task, candidate in binding.items()
    ]
    document = Document(
        syntax_version=SYNTAX_VERSION,
        composition="shop",
        version="1.0.0",
        kind="application",
        problem=ProblemLink(ref=ref or linked.ref, compilation=compilation or linked.compilation.compilation_digest),
        workflow=workflow,
        binding=text.canonical_binding(workflow, entries),
        values=tuple(sorted((values or {}).items())),
        offering=offering,
        evidence=evidence,
    )
    return text.serialise(document)


def bim_binding(linked: Linked, binding: Mapping[str, str]) -> dict[str, dict[str, str]]:
    """``binding`` as the toolchain takes it: each service task's eligible ``{resource, id}``."""
    facts = linked.facts
    found: dict[str, dict[str, str]] = {}
    for task, candidate in binding.items():
        if task not in facts.service_tasks:
            continue
        (reference,) = [item for item in facts.eligibility[task] if item.id == candidate]
        found[task] = reference.as_bim()
    return found


async def finished_run(
    db,
    linked: Linked,
    bindings: list[Mapping[str, Mapping[str, str]] | None],
    *,
    termination: str = "FEASIBLE",
    state=None,
    compilation_id: uuid.UUID | None = None,
    revision_id: uuid.UUID | None = None,
):
    """A completed run of the linked revision whose solutions are ``bindings`` (``None``: not a binding)."""
    from openbinding_gateway.db.models import Job, JobState

    solutions = [
        {"decision": {"kind": "binding", "binding": dict(binding)}, "features": {}}
        if binding is not None
        else {"decision": {"kind": "assignment", "assignment": {}}, "features": {}}
        for binding in bindings
    ]
    job = Job(
        created_by_id=linked.upload.problem.created_by_id,
        engine_id="random-search",
        engine_job_id=f"e-{uuid.uuid4().hex[:8]}",
        service_url="http://engine",
        state=state or JobState.COMPLETED,
        termination=termination,
        result={"solutions": solutions},
        organization_id=linked.organization.id,
        revision_id=revision_id or linked.upload.revision.id,
        compilation_id=compilation_id or linked.compilation.id,
        provenance={},
    )
    db.add(job)
    await db.commit()
    return job


class SemanticChange:
    """The installed toolchain as another release that reads every problem differently.

    It reports another ``compilerDigest``, and its compile results carry an IR whose first candidate feature
    value is one more, with a fresh compilation digest: the same revision then has another semantic digest.
    """

    def __init__(self, inner) -> None:
        self._inner = inner

    def __getattr__(self, name):
        return getattr(self._inner, name)

    def capabilities(self):
        return {**self._inner.capabilities(), "compilerDigest": SEMANTIC_COMPILER}

    def compile(self, archive, registered=()):
        result = copy.deepcopy(dict(self._inner.compile(archive, registered)))
        ir = result["ir"]
        for catalog in ir["spec"]["candidates"].values():
            for candidate in catalog["candidates"].values():
                features = candidate.get("features") or {}
                for name, value in features.items():
                    if isinstance(value, (int, float)) and not isinstance(value, bool):
                        features[name] = value + 1
                        break
                else:
                    continue
                break
            else:
                continue
            break
        result["toolchain"] = {**dict(result.get("toolchain") or {}), "compilerDigest": SEMANTIC_COMPILER}
        result["compilationDigest"] = "sha256-" + "f" * 64
        result["irDigest"] = digest(ir)
        return result


class Lenient:
    """The installed toolchain, except that a binding it refuses is evaluated as ``instead``."""

    def __init__(self, inner, instead: Mapping[str, Mapping[str, str]]) -> None:
        self._inner = inner
        self._instead = instead
        self.refused = 0

    def __getattr__(self, name):
        return getattr(self._inner, name)

    def evaluate(self, ir, binding, execution=None):
        try:
            return self._inner.evaluate(ir, binding, execution)
        except EvaluationError as error:
            if error.code != "binding_invalid":
                raise
            self.refused += 1
            return self._inner.evaluate(ir, self._instead, execution)
