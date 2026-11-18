"""The facts of a compiled problem, as the screens read them: one projection of its IR.

:func:`facts_view` gives the renderer, the problem pages and the editors one input shape for a
compiled problem, stored or draft: its tasks with the candidates each may take and how a
document writes them, every candidate with its values, units and where the package writes each
value, the features with their direction, the workflow **in the Composition2Yaml shape** (the
``workflow:`` a document derived from the same compilation writes), every candidate's scalar
properties (what a requirement predicate reads), where each value came from when a SPHERE import
wrote it (``sources``, ``provenance``: a revision's value origins, given as plain mappings), the constraints and
objectives as the IR has them, and the size of the binding space.

Everything is read by the readers the language already has: :meth:`ProblemFacts.from_ir` gives
the task kinds, the eligibility, the units and the normalised workflow; :func:`written_candidate`
is the one naming rule; :func:`derive.written` and :func:`text.workflow_json` write the workflow
as a derived document does. The rest is looked up in the published IR keys
(``spec.candidates``, ``spec.application.features``, ``spec.constraints``,
``spec.optimization``) and in the source map. Nothing is evaluated, ranked or computed here.
"""

from __future__ import annotations

from typing import Any, Mapping

from . import derive, text
from .document import DIMENSIONLESS
from .problem import CandidateRef, ProblemFacts, ProblemFactsError, constraint_name, constraint_sources, written_candidate
from .workflow import tasks

#: The IR's words for a feature's direction, as the facts write them.
_DIRECTIONS = {"minimize": "min", "maximize": "max"}


def facts_view(
    ir: Mapping[str, Any],
    source_map: Mapping[str, Any] | None,
    analysis: Mapping[str, Any] | None,
    *,
    ir_digest: str,
    sources: Mapping[tuple[str, str, str], Mapping[str, Any]] | None = None,
    provenance: Mapping[str, Mapping[str, Any]] | None = None,
) -> dict[str, Any]:
    """The facts of the compiled problem ``ir``, JSON-native.

    ``source_map`` is the compilation's (the IR's own ``spec.sourceMap`` when ``None``);
    ``analysis`` is the compilation's analysis summary, whose ``bindingSpace`` is passed through.
    ``sources`` (``{(candidate key, "feature" | "property", name): value source}``) and ``provenance``
    (``{candidate key: upstream plan}``) are a stored revision's value origins, given as plain mappings; a draft
    has none. :class:`ProblemFactsError` when the IR lacks a member every compiled problem has.
    """
    facts = ProblemFacts.from_ir(ir, source_map)
    try:
        spec = ir["spec"]
        located = spec.get("sourceMap", {}) if source_map is None else source_map
        application = spec["application"]
        view = {
            "ir_digest": ir_digest,
            "tasks": _tasks(facts),
            "candidates": _candidates(spec, application, located, sources or {}, provenance or {}),
            "features": _features(application),
            "workflow": text.workflow_json(derive.written(facts.workflow)),
            "constraints": _constraints(spec, located),
            "objectives": _objectives(spec),
            "binding_space": _binding_space(analysis),
        }
    except ProblemFactsError:
        raise
    except (KeyError, TypeError, AttributeError, ValueError) as error:
        raise ProblemFactsError(f"the compiled problem lacks a member this version reads: {error!r}") from error
    return view


def _tasks(facts: ProblemFacts) -> list[dict[str, Any]]:
    """Every task, in the order a depth-first walk of the workflow first meets it."""
    every = facts.service_tasks | facts.local_tasks
    ordered = [task for task in tasks(facts.workflow) if task in every]
    ordered += sorted(every - set(ordered))
    return [
        {
            "id": task,
            "kind": "service" if task in facts.service_tasks else "local",
            "eligible": [
                {"candidate": str(reference), "written": written_candidate(task, reference.as_bim(), facts)}
                for reference in facts.eligibility.get(task, ())
            ],
        }
        for task in ordered
    ]


def _candidates(
    spec: Mapping[str, Any],
    application: Mapping[str, Any],
    source_map: Mapping[str, Any],
    sources: Mapping[tuple[str, str, str], Mapping[str, Any]],
    provenance: Mapping[str, Mapping[str, Any]],
) -> list[dict[str, Any]]:
    """Every candidate of every catalog, by key: its provider, its values by feature, its scalar properties, where
    each is written and, for a revision a SPHERE import wrote, where each value came from."""
    resource_of_application = application.get("resource")
    found: list[tuple[CandidateRef, dict[str, Any]]] = []
    for resource, catalog in spec["candidates"].items():
        bindings = catalog.get("featureBindings") or {}
        for identifier, candidate in catalog["candidates"].items():
            reference = CandidateRef(str(resource), str(identifier))
            entry = source_map.get(f"/spec/candidates/{_escape(reference.resource)}/{_escape(reference.id)}")
            key = str(reference)
            values: dict[str, Any] = {}
            origins: dict[str, Any] = {}
            for alias, value in (candidate.get("features") or {}).items():
                feature = _feature_of(alias, bindings, resource_of_application)
                values[feature] = _value(value)
                if isinstance(entry, Mapping) and entry.get("path"):
                    origins[feature] = _located(entry, reference, f"/features/{_escape(str(alias))}",
                                                sources.get((key, "feature", feature)))
            properties: dict[str, Any] = {}
            property_origins: dict[str, Any] = {}
            for name, value in (candidate.get("properties") or {}).items():
                if isinstance(value, Mapping) or isinstance(value, list):
                    continue
                properties[str(name)] = value
                if isinstance(entry, Mapping) and entry.get("path"):
                    property_origins[str(name)] = _located(
                        entry, reference, f"/properties/{_escape(str(name))}", sources.get((key, "property", str(name)))
                    )
            provider = candidate.get("provider")
            found.append((reference, {
                "key": key,
                "resource": reference.resource,
                "id": reference.id,
                "provider": str(provider["id"]) if isinstance(provider, Mapping) and "id" in provider else None,
                "values": values,
                "origins": origins,
                "properties": properties,
                "propertyOrigins": property_origins,
                "provenance": dict(provenance[key]) if key in provenance else None,
            }))
    return [item for _, item in sorted(found, key=lambda pair: pair[0])]


def _located(
    entry: Mapping[str, Any], reference: CandidateRef, suffix: str, source: Mapping[str, Any] | None
) -> dict[str, Any]:
    """Where the package writes a value, and where it came from when a SPHERE import wrote it."""
    out: dict[str, Any] = {
        "kind": "package",
        "resource": str(entry.get("resource", reference.resource)),
        "path": str(entry["path"]),
        "pointer": f"{entry.get('pointer', '')}{suffix}",
        "source": dict(source) if source is not None else None,
    }
    return out


def _feature_of(alias: Any, bindings: Mapping[str, Any], application: Any) -> str:
    """The application feature a catalog's value is bound to (``featureBindings``), or its own name."""
    bound = bindings.get(alias)
    if isinstance(bound, Mapping) and "id" in bound and bound.get("resource", application) == application:
        return str(bound["id"])
    return str(alias)


def _value(value: Any) -> Any:
    """A number, or a range ``{min, max}`` whose ends are numbers or ``null`` (no limit), as the IR has it."""
    if isinstance(value, Mapping):
        return {"min": value.get("min"), "max": value.get("max")}
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ProblemFactsError(f"a candidate value this version cannot read: {value!r}")
    return value


def _features(application: Mapping[str, Any]) -> list[dict[str, Any]]:
    required = set(application.get("requiredFeatures", ()))
    return [
        {
            "id": str(name),
            "unit": str(feature.get("unit", DIMENSIONLESS)),
            "direction": _DIRECTIONS.get(feature.get("direction")),
            "required": name in required,
        }
        for name, feature in application["features"].items()
    ]


def _constraints(spec: Mapping[str, Any], source_map: Mapping[str, Any]) -> list[dict[str, Any]]:
    sources = constraint_sources(spec, source_map)
    found = []
    for constraint in spec.get("constraints", ()):
        name = constraint_name(constraint["ref"])
        source = sources.get(name)
        found.append({
            "id": name,
            "enforcement": constraint["enforcement"],
            "expression": constraint["assert"],
            "when": constraint.get("when"),
            "penalty": constraint.get("penalty"),
            "origin": None if source is None else {
                "resource": str(source.get("resource", "")),
                "path": str(source["path"]),
                "pointer": str(source.get("pointer", "/")),
            },
        })
    return found


def _objectives(spec: Mapping[str, Any]) -> dict[str, Any]:
    optimization = spec.get("optimization") or {}
    return {
        "criteria": list(optimization.get("criteria", ())),
        "penalties": list(optimization.get("penalties", ())),
    }


def _binding_space(analysis: Mapping[str, Any] | None) -> str | None:
    value = analysis.get("bindingSpace") if isinstance(analysis, Mapping) else None
    return value if isinstance(value, str) else None


def _escape(segment: str) -> str:
    """A JSON Pointer reference token (RFC 6901)."""
    return segment.replace("~", "~0").replace("/", "~1")
