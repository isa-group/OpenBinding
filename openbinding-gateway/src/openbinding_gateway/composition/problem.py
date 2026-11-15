"""A Composition2Yaml document judged against a compiled BIM problem.

Everything here is a pure function over plain data. The facts of a problem are read from its
**compiled IR** -- the interchange document the toolchain returned and the gateway stored --
by :meth:`ProblemFacts.from_ir`, which only looks values up: task kinds, the workflow and its
routing, the eligibility matrix, the candidate catalogs, the feature units and the features
the evaluator reports. Nothing of the toolchain's semantics is re-implemented, and nothing here
calls it: the caller evaluates the binding with the toolchain and passes the result in.

**Binding validity is the toolchain's verdict.** :func:`against` translates each candidate the
document names into the ``{resource, id}`` reference BIM takes, and places what it finds on
the document's lines. It decides nothing the toolchain decides:

* ``blocking`` findings refuse the document whatever the toolchain would say: the workflow is
  not the problem's, a value names a property the problem does not have or the wrong unit, or a
  candidate cannot be translated at all (no catalog holds it, or two give the task that id), so
  there is no binding to send;
* ``pending`` findings -- a candidate the task is not eligible for, a candidate on a local
  task, ``local: true`` on a service task -- explain a refusal on the right line, and are
  reported only when the toolchain refuses the binding. The translated binding is sent anyway.

The values a document states are the toolchain's floats, never recomputed here:
:func:`computed_values` takes them as the evaluator returned them, :func:`value_findings` says
which declared ones differ or are not computed, and :func:`violation_findings` turns the
evaluator's violations into diagnostics. Units are the problem's strings, compared for
equality: the toolchain has no unit algebra.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterable, Mapping

from . import diagnostics as codes
from .diagnostics import Diagnostic, Path, at
from .document import DIMENSIONLESS, Document, Entry, Value
from .workflow import Node, WorkflowError, first_mismatch, from_ir, normalise, tasks

#: The relative difference below which a declared value is taken to be the computed one. It only
#: keeps representation noise (``51.65`` against ``51.650000000000006``) out of a warning: the
#: value kept is always the computed one.
TOLERANCE = 1e-9

_BINDING = Path(("binding",))
_VALUES = Path(("values",))
_WORKFLOW_HINT = "the workflow is the problem's: derive again or copy it from the problem"


class ProblemFactsError(Exception):
    """The IR lacks a member every compiled problem has, or holds one this version cannot read.

    A bug guard: an IR the gateway compiled always has them, so the caller answers 500.
    """


@dataclass(frozen=True, slots=True, order=True)
class CandidateRef:
    """A candidate as BIM addresses it: the catalog resource and the id within it."""

    resource: str
    id: str

    def __str__(self) -> str:
        return f"{self.resource}/{self.id}"

    def as_bim(self) -> dict[str, str]:
        """The reference as the toolchain takes it in a binding."""
        return {"resource": self.resource, "id": self.id}


@dataclass(frozen=True, slots=True)
class ProblemFacts:
    """What a document is judged against, read from a compiled problem."""

    service_tasks: frozenset[str]
    local_tasks: frozenset[str]
    #: The candidates each service task may take (``spec.eligibility``), in the IR's order.
    eligibility: Mapping[str, tuple[CandidateRef, ...]]
    #: Every candidate of every catalog (``spec.candidates``).
    candidates: frozenset[CandidateRef]
    #: The unit of every feature of the application.
    units: Mapping[str, str]
    #: The features of the application.
    features: frozenset[str]
    #: The features the evaluator reports: the required ones and the placement-derived ones.
    reported: frozenset[str]
    #: The problem's workflow, normalised.
    workflow: Node
    #: ``<resource>/<id>`` of each constraint and placement rule -> where its source defines it.
    constraint_locations: Mapping[str, str]

    @classmethod
    def from_ir(cls, ir: Mapping[str, Any], source_map: Mapping[str, Any] | None = None) -> "ProblemFacts":
        """The facts of a compiled IR. ``source_map`` defaults to the IR's own ``spec.sourceMap``."""
        try:
            spec = ir["spec"]
            application = spec["application"]
            service: set[str] = set()
            local: set[str] = set()
            for task, body in application["tasks"].items():
                kind = body["kind"]
                if kind == "service":
                    service.add(task)
                elif kind == "local":
                    local.add(task)
                else:
                    raise ProblemFactsError(f"task {task!r} has a kind this version cannot read: {kind!r}")
            eligibility = {
                task: tuple(_ref(item) for item in spec["eligibility"][task]) for task in sorted(service)
            }
            candidates = frozenset(
                CandidateRef(str(resource), str(candidate))
                for resource, catalog in spec["candidates"].items()
                for candidate in catalog["candidates"]
            )
            features = application["features"]
            units = {name: str(feature.get("unit", DIMENSIONLESS)) for name, feature in features.items()}
            reported = set(application["requiredFeatures"])
            for model in spec.get("placement", ()):
                if "globalLatency" in model:
                    reported.add(model["globalLatency"]["feature"]["id"])
            workflow = normalise(from_ir(application["workflow"], spec.get("routing", ())))
            located = spec.get("sourceMap", {}) if source_map is None else source_map
            locations = _constraint_locations(spec, located)
        except ProblemFactsError:
            raise
        except WorkflowError as error:
            raise ProblemFactsError(str(error)) from error
        except (KeyError, TypeError, AttributeError, ValueError) as error:
            raise ProblemFactsError(f"the compiled problem lacks a member this version reads: {error!r}") from error
        return cls(
            service_tasks=frozenset(service),
            local_tasks=frozenset(local),
            eligibility=eligibility,
            candidates=candidates,
            units=units,
            features=frozenset(features),
            reported=frozenset(reported),
            workflow=workflow,
            constraint_locations=locations,
        )


def _ref(item: Mapping[str, Any]) -> CandidateRef:
    return CandidateRef(str(item["resource"]), str(item["id"]))


def _constraint_locations(spec: Mapping[str, Any], source_map: Mapping[str, Any]) -> dict[str, str]:
    """Where each constraint and placement rule is written, by its ``<resource>/<id>``."""
    return {
        name: f"{entry['path']} at {entry.get('pointer', '/')}"
        for name, entry in constraint_sources(spec, source_map).items()
    }


def constraint_sources(spec: Mapping[str, Any], source_map: Mapping[str, Any]) -> dict[str, Mapping[str, Any]]:
    """The ``sourceMap`` entry of each constraint and placement rule that has one, by its ``<resource>/<id>``.

    An entry is ``{resource, path, pointer}``: the resource of the package that writes the rule, its file,
    and the JSON Pointer within that file.
    """
    found: dict[str, Mapping[str, Any]] = {}

    def note(ref: Any, pointer: str) -> None:
        entry = source_map.get(pointer) if isinstance(source_map, Mapping) else None
        if isinstance(ref, Mapping) and isinstance(entry, Mapping) and entry.get("path"):
            found[constraint_name(ref)] = entry

    for position, constraint in enumerate(spec.get("constraints", ())):
        note(constraint.get("ref"), f"/spec/constraints/{position}")
    for index, model in enumerate(spec.get("placement", ())):
        for member in ("capacityRules", "transitions"):
            for position, rule in enumerate(model.get(member, ())):
                note(rule.get("ref"), f"/spec/placement/{index}/{member}/{position}")
    return found


def constraint_name(ref: Mapping[str, Any]) -> str:
    """A constraint or rule as the facts and the diagnostics name it: ``<resource>/<id>``."""
    return f"{ref.get('resource')}/{ref.get('id')}"


# --------------------------------------------------------------------------- against a problem


@dataclass(frozen=True, slots=True)
class Resolution:
    """A document against a problem: the binding to evaluate, and what was found.

    ``bim_binding`` is ``{task: {resource, id}}`` for every translated entry, leaving out
    ``local: true`` ones, and is ``None`` when a ``blocking`` finding leaves nothing to send.
    ``pending`` findings become errors only when the toolchain refuses the binding.
    """

    bim_binding: dict[str, dict[str, str]] | None
    blocking: tuple[Diagnostic, ...] = ()
    pending: tuple[Diagnostic, ...] = ()


def against(doc: Document, facts: ProblemFacts) -> Resolution:
    """``doc`` judged against ``facts``: its workflow, its binding and the units of its values.

    The document is one the language accepted, so every task of its workflow has exactly one
    binding entry. The lookup translates and locates; whether the binding holds is the
    toolchain's decision.
    """
    blocking: list[Diagnostic] = []
    pending: list[Diagnostic] = []
    blocking += _workflow(doc, facts)
    binding: dict[str, dict[str, str]] = {}
    for task, entry in doc.binding:
        reference = _entry(task, entry, facts, blocking, pending)
        if reference is not None:
            binding[task] = reference.as_bim()
    blocking += _values(doc, facts)
    return Resolution(
        bim_binding=None if blocking else binding,
        blocking=tuple(blocking),
        pending=tuple(pending),
    )


def _workflow(doc: Document, facts: ProblemFacts) -> list[Diagnostic]:
    found = first_mismatch(doc.workflow, doc.paths.nodes, facts.workflow)
    if found is None:
        return []
    written, problem = set(tasks(doc.workflow)), set(tasks(facts.workflow))
    differences = []
    if written - problem:
        differences.append("only in the composition: " + _names(written - problem))
    if problem - written:
        differences.append("only in the problem: " + _names(problem - written))
    message = "; ".join((found.reason, *differences, _WORKFLOW_HINT))
    return [at(found.path, codes.WORKFLOW_MISMATCH, message)]


def _names(names: Iterable[str]) -> str:
    return ", ".join(repr(name) for name in sorted(names))


def _entry(
    task: str,
    entry: Entry,
    facts: ProblemFacts,
    blocking: list[Diagnostic],
    pending: list[Diagnostic],
) -> CandidateRef | None:
    """The reference ``entry`` translates to, if any; its findings appended to the lists."""
    path = _BINDING.child(task)
    if entry.local:
        if task in facts.service_tasks:
            pending.append(at(
                path, codes.TASK_LOCAL_MISMATCH,
                f"task {task!r} is a service task of the problem: bind one of its candidates, not local: true",
            ))
        return None
    if entry.candidate is None:
        return None
    if task in facts.local_tasks:
        pending.append(at(
            path, codes.TASK_LOCAL_MISMATCH,
            f"task {task!r} is done in house in the problem: write {task}: {{local: true}}, not a candidate",
        ))
    elif task not in facts.service_tasks:
        return None  # not a task of the problem: the workflow mismatch says so
    return _candidate(task, entry.candidate, facts, blocking, pending)


def _candidate(
    task: str,
    written: str,
    facts: ProblemFacts,
    blocking: list[Diagnostic],
    pending: list[Diagnostic],
) -> CandidateRef | None:
    path = _BINDING.child(task, "candidate")
    eligible = facts.eligibility.get(task, ())
    if "/" in written:
        resource, _, identifier = written.partition("/")
        reference = CandidateRef(resource, identifier)
        if reference not in facts.candidates:
            blocking.append(at(path, codes.CANDIDATE_UNKNOWN, f"no catalog of the problem holds the candidate {written!r}"))
            return None
        if reference not in eligible and task in facts.service_tasks:
            pending.append(_not_allowed(path, task, written, eligible))
        return reference
    matches = [reference for reference in eligible if reference.id == written]
    if len(matches) == 1:
        return matches[0]
    if not matches:
        matches = sorted(reference for reference in facts.candidates if reference.id == written)
        if len(matches) == 1:
            if task in facts.service_tasks:
                pending.append(_not_allowed(path, task, written, eligible))
            return matches[0]
    if not matches:
        blocking.append(at(path, codes.CANDIDATE_UNKNOWN, f"no catalog of the problem holds a candidate {written!r}"))
        return None
    blocking.append(at(
        path, codes.CANDIDATE_AMBIGUOUS,
        f"more than one catalog holds a candidate {written!r}: write "
        + " or ".join(repr(str(reference)) for reference in matches),
    ))
    return None


def _not_allowed(path: Path, task: str, written: str, eligible: tuple[CandidateRef, ...]) -> Diagnostic:
    allowed = ", ".join(_short(reference, eligible) for reference in eligible) or "none"
    return at(
        path, codes.CANDIDATE_NOT_ALLOWED,
        f"the candidate {written!r} is not eligible for task {task!r}; its candidates are {allowed}",
    )


def _values(doc: Document, facts: ProblemFacts) -> list[Diagnostic]:
    found: list[Diagnostic] = []
    for name, value in doc.values:
        path = _VALUES.child(name)
        if name not in facts.features:
            found.append(at(
                path, codes.PROPERTY_UNKNOWN,
                f"the problem has no property {name!r}; its properties are {_names(facts.features)}",
            ))
            continue
        unit = facts.units[name]
        if value.unit == DIMENSIONLESS and unit != DIMENSIONLESS:
            found.append(at(
                path, codes.UNIT_MISSING,
                f"{name} is measured in {unit!r} in the problem: write {{value: {value.value!r}, unit: {unit}}}",
            ))
        elif value.unit != unit:
            expected = "a bare number (dimensionless)" if unit == DIMENSIONLESS else repr(unit)
            found.append(at(
                path.child("unit"), codes.UNIT_MISMATCH,
                f"the problem measures {name} in {expected}, not {value.unit!r}",
            ))
    return found


# --------------------------------------------------------------------------- values and violations


def computed_values(features: Mapping[str, float], facts: ProblemFacts) -> tuple[tuple[str, Value], ...]:
    """The values the evaluator computed, as it returned them, each with the problem's unit, by name."""
    found: list[tuple[str, Value]] = []
    for name in sorted(features):
        if name not in facts.units:
            raise ProblemFactsError(f"the evaluator reports a feature the problem does not have: {name!r}")
        found.append((name, Value(value=features[name], unit=facts.units[name])))
    return tuple(found)


def value_findings(doc: Document, computed: Iterable[tuple[str, Value]]) -> tuple[Diagnostic, ...]:
    """Warnings about the values ``doc`` declares, against those the evaluator computed.

    A declared value that differs from the computed one (beyond representation noise) is
    replaced by it; a declared property the evaluator does not compute is dropped. Properties
    the problem does not have are :func:`against`'s, which refuses them before any evaluation.
    """
    values = dict(computed)
    found: list[Diagnostic] = []
    for name, declared in doc.values:
        path = _VALUES.child(name)
        value = values.get(name)
        if value is None:
            found.append(at(
                path, codes.VALUE_NOT_COMPUTED,
                f"the toolchain does not compute {name} for this problem: the value is dropped",
                severity="warning",
            ))
        elif abs(declared.value - value.value) > TOLERANCE * max(1.0, abs(value.value)):
            found.append(at(
                path.child("value"), codes.VALUE_DIFFERS,
                f"replaced by the value the toolchain computes: {value.value!r}",
                severity="warning",
            ))
    return tuple(found)


def violation_findings(violations: Iterable[Mapping[str, Any]], facts: ProblemFacts) -> tuple[Diagnostic, ...]:
    """The evaluator's violations: a hard one is an error, a soft one a warning with its penalty."""
    found: list[Diagnostic] = []
    for violation in violations:
        reference = violation.get("constraint")
        name = (
            f"{reference.get('resource')}/{reference.get('id')}" if isinstance(reference, Mapping) else str(reference)
        )
        where = facts.constraint_locations.get(name)
        defined = f" (defined in {where})" if where else ""
        own = violation.get("message")
        if violation.get("enforcement") == "hard":
            message = f"constraint {name}: {own}" if own else f"constraint {name} is violated{defined}"
            found.append(at(_BINDING, codes.CONSTRAINT_VIOLATED, message))
        else:
            penalty = violation.get("penalty", 0.0)
            message = f"soft constraint {name} is not met{defined}, with penalty {penalty!r}"
            if own:
                message += f": {own}"
            found.append(at(_BINDING, codes.CONSTRAINT_SOFT, message, severity="warning"))
    return tuple(found)


# --------------------------------------------------------------------------- the inverse


def document_binding(bim_binding: Mapping[str, Mapping[str, Any]], facts: ProblemFacts) -> tuple[tuple[str, Entry], ...]:
    """A BIM binding as a document writes it, in the order a depth-first walk of the workflow
    first meets each task: a candidate by its id, by ``<resource>/<id>`` only when two catalogs
    give the task that id, and ``local: true`` for a task done in house."""
    found: list[tuple[str, Entry]] = []
    for task in tasks(facts.workflow):
        if task in facts.local_tasks:
            found.append((task, Entry(local=True)))
            continue
        item = bim_binding.get(task)
        if item is None:
            raise ValueError(f"the binding leaves out the service task {task!r}")
        found.append((task, Entry(candidate=_short(_ref(item), facts.eligibility.get(task, ())))))
    return tuple(found)


def written_candidate(task: str, reference: Mapping[str, Any], facts: ProblemFacts) -> str:
    """How a document names the BIM ``reference`` (``{resource, id}``) bound to ``task``: its id, or
    ``<resource>/<id>`` when two catalogs give the task that id."""
    return _short(_ref(reference), facts.eligibility.get(task, ()))


def _short(reference: CandidateRef, eligible: tuple[CandidateRef, ...]) -> str:
    """How a document names ``reference`` for a task: its id, unless the id is ambiguous there."""
    if sum(1 for other in eligible if other.id == reference.id) > 1:
        return str(reference)
    return reference.id
