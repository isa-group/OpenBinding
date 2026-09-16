"""Exact decision support over stored evaluations. Never compiles, evaluates or solves a binding."""
from __future__ import annotations

import heapq
import math
from collections import Counter, defaultdict
from dataclasses import dataclass
from functools import lru_cache
from typing import Any, Callable

from ..models.analysis import AnalysisDimension, AnalysisQuery, AnalysisRow, AnalysisSource
from .canonical import canonical_json, digest, digest_bytes

VERSION = "binding-analysis/3"
NEAR_TIE = 1e-10
FORMULAS = {
    "balanced": "Minimize (max(w × normalized loss), sum(w × normalized loss)) lexicographically",
    "weighted": "Minimize sum(w × normalized loss)",
    "ideal": "Minimize sqrt(sum((w × normalized loss)²))",
    "chebyshev": "Minimize max(w × normalized loss)",
    "reference": "Minimize sqrt(sum((w × (normalized loss − reference))²))",
    "topsis": "Minimize distance to ideal / (distance to ideal + distance to archive anti-ideal)",
    "model": "Use the original canonical scalar or lexicographic model score",
}


def finite(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def record(value: Any) -> dict:
    return value if isinstance(value, dict) else {}


def safe(value: Any) -> Any:
    """Malformed evidence remains inspectable, without emitting invalid JSON numbers."""
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if isinstance(value, dict):
        return {str(k): safe(v) for k, v in value.items()}
    if isinstance(value, (tuple, list)):
        return [safe(v) for v in value]
    return value


def metric_key(value: Any) -> str:
    ref = record(value)
    return f"{ref.get('resource', '')}:{ref.get('id', '')}"


@dataclass
class Candidate:
    id: str
    assignment: dict | tuple
    solution: dict
    losses: tuple[float, ...] | None
    values: tuple[float, ...] | None
    feasible: bool | None
    reasons: list[str]
    occurrences: list[dict]
    normalized: tuple[float, ...] | None = None

    @property
    def binding(self):
        if isinstance(self.assignment, tuple):
            return {task: {"resource": resource, "id": cid} for task, resource, cid in self.assignment}
        return self.assignment


@dataclass
class Archive:
    revision: str
    sources: list[AnalysisSource]
    dimensions: list[AnalysisDimension]
    candidates: list[Candidate]
    document: dict
    mode: str
    trajectory: list[dict]


def compact_archive(archive):
    """Intern repeated assignment references; detail evidence is loaded on demand."""
    references = {}
    for candidate in archive.candidates:
        binding = candidate.binding
        if all(isinstance(ref, dict) and isinstance(ref.get("resource"), str) and isinstance(ref.get("id"), str) for ref in binding.values()):
            candidate.assignment = tuple(references.setdefault((task, ref["resource"], ref["id"]), (task, ref["resource"], ref["id"]))
                                         for task, ref in binding.items())
        candidate.solution = {"objectives": {"score": record(candidate.solution.get("objectives")).get("score")}}
    return archive


def build_archive(sources: list[tuple[AnalysisSource, dict, dict]]) -> Archive:
    sources = sorted(sources, key=lambda source: source[0].id)
    document = sources[0][1]
    optimization = record(record(document.get("spec")).get("optimization"))
    terms = optimization.get("terms", [])
    if not isinstance(terms, list):
        raise ValueError("The pinned objective schema is unavailable")
    signatures = {(s.irDigest, s.evaluatorDigest) for s, _, _ in sources}
    if len(sources) > 1 and (len(signatures) != 1 or any(s.legacy for s, _, _ in sources)):
        raise ValueError("Pooling requires identical verified model and evaluator identities")
    if any(record(record(doc.get("spec")).get("optimization")) != optimization for _, doc, _ in sources):
        raise ValueError("The sources have incompatible objective schemas")
    keys = [metric_key(record(t).get("metric")) for t in terms]
    if len(set(keys)) != len(keys):
        # Repeated terms have different semantics and must not collapse into one axis.
        keys = [f"{key}#{i + 1}" for i, key in enumerate(keys)]
    metrics = record(record(record(document.get("spec")).get("application")).get("metrics"))
    dimensions = [AnalysisDimension(key=keys[i], label=metric_key(record(t).get("metric")),
                    unit=record(metrics.get(record(record(t).get("metric")).get("id"))).get("unit"),
                    direction=record(t).get("direction", "minimize"), kind="objective")
                  for i, t in enumerate(terms)]
    dimensions.append(AnalysisDimension(key="penalty", label="Soft penalty", direction="minimize", kind="penalty"))
    candidates: dict[str, Candidate] = {}
    assignment_fragments = {}
    trajectory = []
    for source, _, result in sources:
        solutions = record(result).get("solutions", [])
        if not isinstance(solutions, list):
            solutions = [solutions]
        trace = record(record(result.get("provenance")).get("engineReported")).get("trace", [])
        if isinstance(trace, list):
            trajectory.append({"jobId": source.id, "events": safe(trace), "kind": "recorded"})
        for index, raw in enumerate(solutions):
            solution, reasons = record(raw), []
            decision = record(solution.get("decision"))
            binding = record(decision.get("binding"))
            valid_binding = decision.get("kind") == "binding" and bool(binding) and all(
                isinstance(ref, dict) and isinstance(ref.get("resource"), str) and isinstance(ref.get("id"), str)
                for ref in binding.values())
            valid_shape = valid_binding
            eligibility = record(record(document.get("spec")).get("eligibility"))
            if eligibility and (set(binding) != set(eligibility) or any(binding.get(task) not in refs for task, refs in eligibility.items())):
                valid_binding = False
            if not valid_binding:
                reasons.append("Missing or malformed binding assignment")
            binding = {task: {"resource": ref["resource"], "id": ref["id"]} for task, ref in sorted(binding.items())} if valid_shape else safe(binding)
            if valid_shape:
                fragments = []
                for task in sorted(binding, key=lambda key: key.encode("utf-16-be")):
                    ref = binding[task]
                    key = (task, ref["resource"], ref["id"])
                    if key not in assignment_fragments:
                        assignment_fragments[key] = canonical_json(task) + b":" + canonical_json(ref)
                    fragments.append(assignment_fragments[key])
                candidate_id = digest_bytes(b"{" + b",".join(fragments) + b"}")
            else:
                candidate_id = digest({"job": source.id, "index": index})
            objective = record(solution.get("objectives"))
            components = objective.get("components", [])
            expected = [metric_key(record(term).get("metric")) for term in terms]
            actual = [metric_key(record(c).get("metric")) for c in components] if isinstance(components, list) else []
            if actual != expected or objective.get("mode") != optimization.get("mode"):
                reasons.append("Evaluation does not match the pinned objective schema")
            components = components if isinstance(components, list) else []
            losses = tuple(record(c).get("loss") for c in components) + (objective.get("penalty"),)
            values = tuple(record(c).get("value") for c in components) + (objective.get("penalty"),)
            if len(losses) != len(dimensions) or not all(finite(v) for v in (*losses, *values)):
                reasons.append("Incomplete or non-finite objective evaluation")
            violations = solution.get("violations")
            feasible = None
            if isinstance(violations, list):
                if any(record(v).get("enforcement") == "hard" for v in violations):
                    feasible = False
                elif all(record(v).get("enforcement") == "soft" for v in violations):
                    feasible = True
            if feasible is None:
                reasons.append("Feasibility is unknown")
            elif not feasible:
                reasons.append("Violates a hard model constraint")
            comparable = valid_binding and actual == expected and objective.get("mode") == optimization.get("mode") and len(losses) == len(dimensions) and all(finite(v) for v in (*losses, *values))
            if candidate_id in candidates:
                previous = candidates[candidate_id].solution
                def evaluation_fingerprint(value):
                    return digest(safe({key: value.get(key) for key in ("objectives", "metrics", "violations")}))
                if evaluation_fingerprint(previous) != evaluation_fingerprint(solution):
                    raise ValueError("The same binding has contradictory stored evaluations; analyze its sources separately")
                candidates[candidate_id].occurrences.append({"jobId": source.id, "solutionIndex": index})
                continue
            candidates[candidate_id] = Candidate(candidate_id, binding, solution, losses if comparable else None,
                values if comparable else None, feasible, reasons, [{"jobId": source.id, "solutionIndex": index}])
    rows = sorted(candidates.values(), key=lambda c: c.id)
    feasible_rows = [c for c in rows if c.feasible is True and c.losses is not None]
    for j, dimension in enumerate(dimensions):
        if feasible_rows:
            dimension.minimum = min(c.losses[j] for c in feasible_rows)
            dimension.maximum = max(c.losses[j] for c in feasible_rows)
            dimension.rawMinimum = min(c.values[j] for c in feasible_rows)
            dimension.rawMaximum = max(c.values[j] for c in feasible_rows)
            dimension.constant = dimension.minimum == dimension.maximum
    for c in rows:
        if c.losses is not None and feasible_rows:
            c.normalized = tuple(0.0 if d.constant else (c.losses[j] - d.minimum) / (d.maximum - d.minimum)
                                 for j, d in enumerate(dimensions))
    revision = digest({"version": VERSION, "sources": [s.model_dump() for s, _, _ in sources]})
    return Archive(revision, [s for s, _, _ in sources], dimensions, rows, document, optimization.get("mode", "unknown"), trajectory)


def hypervolume_2d(archive, rows):
    """Exact dominated area against a disclosed, fixed normalized reference."""
    active = [j for j, d in enumerate(archive.dimensions) if not d.constant]
    if len(active) != 2:
        return None
    x, y = active
    ceiling, area = 1.1, 0.0
    for a, b in sorted({(c.normalized[x], c.normalized[y]) for c in rows}):
        if b < ceiling:
            area += (1.1 - a) * (ceiling - b)
            ceiling = b
    return {"value": area, "reference": [1.1, 1.1], "axes": active,
            "meaning": "Exact dominated area in the two varying archive-normalized dimensions; reference (1.1, 1.1)."}


def validate_query(archive: Archive, query: AnalysisQuery) -> None:
    keys = {d.key for d in archive.dimensions}
    used = set(query.weights) | set(query.reference) | set(query.axes) | {r.dimension for r in query.requirements}
    if used - keys:
        raise ValueError("An objective in this query is not present in the archive")
    if any(v < 0 for v in query.weights.values()):
        raise ValueError("Priorities cannot be negative")
    if len(set(query.axes)) != len(query.axes):
        raise ValueError("Choose distinct axes")
    if len({r.dimension for r in query.requirements}) != len(query.requirements):
        raise ValueError("Provide one requirement per objective")
    if query.viewport and (query.viewport[0] >= query.viewport[2] or query.viewport[1] >= query.viewport[3]):
        raise ValueError("The viewport must have positive width and height")
    if query.rule == "model" and archive.mode == "pareto":
        raise ValueError("The Pareto model defines a partial order; choose a preference rule to rank trade-offs")


def priorities(archive: Archive, query: AnalysisQuery) -> list[float]:
    weights = [0.0 if d.constant else query.weights.get(d.key, 1.0) for d in archive.dimensions]
    maximum = max(weights, default=0)
    if maximum:
        weights = [w / maximum for w in weights]
    total = sum(weights)
    if not total:
        weights = [float(not d.constant) for d in archive.dimensions]
        total = sum(weights)
    return [w / total if total else 0.0 for w in weights]


def score(candidate: Candidate, weights: list[float], rule: str, reference: list[float]) -> tuple[float, ...]:
    if rule == "model":
        value = record(candidate.solution.get("objectives")).get("score")
        values = value if isinstance(value, list) else [value]
        if not values or not all(finite(v) for v in values):
            raise ValueError("A candidate has an incomplete canonical model score")
        return tuple(values)
    terms = [w * z for w, z in zip(weights, candidate.normalized, strict=True)]
    if rule == "balanced":
        return (max(terms, default=0.0), sum(terms))
    if rule == "weighted":
        return (sum(terms),)
    if rule == "chebyshev":
        return (max(terms, default=0.0),)
    target = reference if rule == "reference" else [0.0] * len(weights)
    distance = math.hypot(*(w * (z - r) for w, z, r in zip(weights, candidate.normalized, target, strict=True)))
    if rule == "topsis":
        far = math.hypot(*(w * (z - 1) for w, z in zip(weights, candidate.normalized, strict=True)))
        return (distance / (distance + far) if distance + far else 0.5,)
    return (distance,)


def requirement_reasons(archive: Archive, candidate: Candidate, query: AnalysisQuery, ignore: set[str] | None = None) -> list[str]:
    reasons = list(candidate.reasons)
    lookup = {d.key: j for j, d in enumerate(archive.dimensions)}
    for requirement in query.requirements:
        if requirement.dimension in (ignore or set()):
            continue
        j = lookup[requirement.dimension]
        row = candidate.values if requirement.space == "raw" else candidate.normalized
        if row is None:
            reasons.append(f"Cannot check requirement for {requirement.dimension}")
            continue
        maximize = requirement.space == "raw" and archive.dimensions[j].direction == "maximize"
        if (row[j] < requirement.value) if maximize else (row[j] > requirement.value):
            reasons.append(f"Requires {archive.dimensions[j].label} {'≥' if maximize else '≤'} {requirement.value:g}; observed {row[j]:g}")
    return reasons


@dataclass
class Decision:
    weights: list[float]
    reasons: dict[str, list[str]]
    scores: dict[str, tuple[float, ...]]
    ordered: list[Candidate]
    ranks: dict[str, tuple[int, int]]


def decide(archive: Archive, query: AnalysisQuery) -> Decision:
    validate_query(archive, query)
    weights = priorities(archive, query)
    reference = [query.reference.get(d.key, 0.0) for d in archive.dimensions]
    reasons = {c.id: requirement_reasons(archive, c, query) for c in archive.candidates}
    eligible = [c for c in archive.candidates if not reasons[c.id] and c.normalized is not None]
    scores = {c.id: score(c, weights, query.rule, reference) for c in eligible}
    ordered = sorted(eligible, key=lambda c: (scores[c.id], c.id))
    ranks, previous, group, rank = {}, None, 0, 0
    for i, c in enumerate(ordered):
        if scores[c.id] != previous:
            group += 1
            rank = i + 1
        ranks[c.id] = (rank, group)
        previous = scores[c.id]
    return Decision(weights, reasons, scores, ordered, ranks)


def dominates(a: tuple, b: tuple) -> bool:
    return a != b and all(x <= y for x, y in zip(a, b, strict=True))


@lru_cache(maxsize=4)
def first_front(matrix: tuple[tuple[float, ...], ...]) -> frozenset[int]:
    """Exact first front in O(N log N) for 0–3 varying dimensions, including duplicates."""
    if not matrix:
        return frozenset()
    active = [j for j in range(len(matrix[0])) if any(row[j] != matrix[0][j] for row in matrix)]
    if len(active) > 3:
        raise ValueError("The general front requires background analysis")
    grouped: dict[tuple, list[int]] = defaultdict(list)
    for i, row in enumerate(matrix):
        grouped[tuple(row[j] for j in active)].append(i)
    vectors = sorted(grouped)
    result = set()
    if len(active) <= 1:
        return frozenset(grouped[vectors[0]])
    ys = {value: i + 1 for i, value in enumerate(sorted({v[1] for v in vectors}))}
    tree = [math.inf] * (len(ys) + 1)
    best_y = math.inf
    for vector in vectors:
        if len(active) == 2:
            is_front = vector[1] < best_y
            best_y = min(best_y, vector[1])
        else:
            pos, best_z = ys[vector[1]], math.inf
            while pos:
                best_z = min(best_z, tree[pos])
                pos -= pos & -pos
            is_front = vector[2] < best_z
            pos = ys[vector[1]]
            while pos < len(tree):
                tree[pos] = min(tree[pos], vector[2])
                pos += pos & -pos
        if is_front:
            result.update(grouped[vector])
    return frozenset(result)


def exact_layers(matrix: tuple[tuple[float, ...], ...], progress: Callable[[int, int], None] | None = None) -> tuple[int, ...]:
    """Polynomial streaming dominance, no quadratic graph. Progress can raise to cancel."""
    # ponytail: O(N²m) general layers; run large archives in the cancellable analysis queue.
    groups: dict[tuple, list[int]] = defaultdict(list)
    for i, row in enumerate(matrix):
        groups[row].append(i)
    vectors = sorted(groups)
    ranks, output, done = [], [0] * len(matrix), 0
    total = len(vectors) * (len(vectors) - 1) // 2
    for i, row in enumerate(vectors):
        rank = 1
        for k in range(i):
            if dominates(vectors[k], row):
                rank = max(rank, ranks[k] + 1)
            done += 1
            if progress and done % 4096 == 0:
                progress(done, total)
        ranks.append(rank)
        for index in groups[row]:
            output[index] = rank
    if progress:
        progress(total, total)
    return tuple(output)


@lru_cache(maxsize=4)
def small_layers(matrix: tuple[tuple[float, ...], ...]) -> tuple[int, ...]:
    return exact_layers(matrix)


def pareto_rows(archive: Archive, decision: Decision, query: AnalysisQuery) -> list[Candidate]:
    return decision.ordered if query.paretoScope == "eligible" else [c for c in archive.candidates if c.feasible is True and c.losses is not None]


def pareto_summary(archive: Archive, decision: Decision, query: AnalysisQuery) -> tuple[dict, dict[str, int]]:
    rows = pareto_rows(archive, decision, query)
    matrix = tuple(c.losses for c in rows)
    active = sum(not d.constant for d in archive.dimensions)
    ranks = {}
    if active <= 3 and not query.layers:
        ranks = {rows[i].id: 1 for i in first_front(matrix)}
        state = "front-complete"
    elif len(rows) <= 2000:
        ranks = dict(zip((c.id for c in rows), small_layers(matrix), strict=True))
        state = "complete"
    else:
        state = "uncomputed"
    return {"state": state, "scope": query.paretoScope, "count": len(rows),
            "frontCount": sum(r == 1 for r in ranks.values()) if state != "uncomputed" else None,
            "hypervolume": hypervolume_2d(archive, rows),
            "meaning": "Exact comparisons of stored feasible bindings; global binding space remains unknown"}, ranks


def row_view(c: Candidate, decision: Decision, pareto: dict[str, int] | None = None) -> AnalysisRow:
    rank, group = decision.ranks.get(c.id, (None, None))
    return AnalysisRow(id=c.id, feasible=c.feasible, eligible=c.id in decision.scores,
        reasons=decision.reasons[c.id], losses=c.losses, values=c.values, normalized=c.normalized,
        score=decision.scores.get(c.id), modelScore=safe(record(c.solution.get("objectives")).get("score")),
        rank=rank, scoreGroup=group, paretoRank=(pareto or {}).get(c.id), occurrences=len(c.occurrences))


def axes_for(archive: Archive, query: AnalysisQuery) -> list[int]:
    keys = [d.key for d in archive.dimensions]
    axes = [keys.index(key) for key in query.axes]
    for j in [j for j, d in enumerate(archive.dimensions) if not d.constant] + list(range(len(keys))):
        if j not in axes and len(axes) < 2:
            axes.append(j)
    return axes


def plot_data(archive: Archive, decision: Decision, query: AnalysisQuery, ranks: dict[str, int]) -> dict:
    from .archive_geometry import outcome_constraints
    axes = axes_for(archive, query)
    if len(axes) < 2:
        return {"axes": axes, "points": [], "bins": [], "count": 0, "bounds": [0, 0, 1, 1], "aggregated": False}
    x, y = axes[:2]
    rows = [c for c in archive.candidates if c.normalized is not None]
    all_x, all_y = [c.normalized[x] for c in rows], [c.normalized[y] for c in rows]
    bounds = query.viewport or [min(all_x, default=0), min(all_y, default=0), max(all_x, default=1), max(all_y, default=1)]
    bounds = list(bounds)
    for j in (0, 1):
        if bounds[j] == bounds[j + 2]:
            bounds[j] -= 0.5
            bounds[j + 2] += 0.5
    rows = [c for c in rows if bounds[0] <= c.normalized[x] <= bounds[2] and bounds[1] <= c.normalized[y] <= bounds[3]]
    def point(c):
        return {"id": c.id, "x": c.normalized[x], "y": c.normalized[y], "feasible": c.feasible,
                "eligible": c.id in decision.scores, "paretoRank": ranks.get(c.id)}
    if len(rows) <= 1500:
        return {"axes": axes[:2], "points": [point(c) for c in rows], "bins": [], "count": len(rows), "bounds": bounds, "aggregated": False,
                "constraints": outcome_constraints(archive, axes)}
    bins = {}
    for c in rows:
        bx = min(63, int(64 * (c.normalized[x] - bounds[0]) / (bounds[2] - bounds[0])))
        by = min(63, int(64 * (c.normalized[y] - bounds[1]) / (bounds[3] - bounds[1])))
        key = (bx, by)
        if key not in bins:
            bins[key] = {"x": bx, "y": by, "count": 0, "feasible": 0, "infeasible": 0, "unknown": 0}
        bins[key]["count"] += 1
        bins[key]["feasible" if c.feasible is True else "infeasible" if c.feasible is False else "unknown"] += 1
    highlighted = {query.selected, *query.compare, *(c.id for c in decision.ordered[:10])}
    return {"axes": axes[:2], "points": [point(c) for c in rows if c.id in highlighted], "bins": list(bins.values()),
            "count": len(rows), "bounds": bounds, "aggregated": True, "resolution": 64,
            "constraints": outcome_constraints(archive, axes)}


def query_archive(archive: Archive, query: AnalysisQuery) -> dict:
    from .archive_geometry import budget_map, preference_geometry, proximity_geometry
    decision = decide(archive, query)
    pareto, ranks = pareto_summary(archive, decision, query)
    winners = [c for c in decision.ordered if decision.ranks[c.id][1] == 1]
    following = [c for c in decision.ordered if decision.ranks[c.id][1] == 2]
    other = [c for c in archive.candidates if c.id not in decision.scores]
    displayed = decision.ordered + other
    if query.search:
        search = query.search.casefold()
        displayed = [c for c in displayed if search in c.id.casefold() or any(search in str(v).casefold() for v in c.binding.values())]
    if query.status != "all":
        displayed = [c for c in displayed if {
            "eligible": c.id in decision.scores, "excluded": c.id not in decision.scores,
            "feasible": c.feasible is True, "infeasible": c.feasible is False, "unknown": c.feasible is None,
        }[query.status]]
    axes = axes_for(archive, query)
    if query.viewport and len(axes) >= 2:
        x, y = axes[:2]
        lo_x, lo_y, hi_x, hi_y = query.viewport
        displayed = [c for c in displayed if c.normalized and lo_x <= c.normalized[x] <= hi_x and lo_y <= c.normalized[y] <= hi_y]
    warnings = ["Recommendations compare stored evidence only. Unexplored bindings remain unknown."]
    if any(s.legacy for s in archive.sources):
        warnings.append("Legacy source: evaluator identity is incomplete; pooling is unavailable.")
    if any(w == 0 and not d.constant for w, d in zip(decision.weights, archive.dimensions, strict=True)):
        warnings.append("Zero priorities ignore objectives and may produce dominated ties.")
    geometry = None
    if query.geometry in ("power", "sensitivity"):
        geometry = preference_geometry(archive, decision, query)
    elif query.geometry == "voronoi":
        geometry = proximity_geometry(archive, decision, query)
    counts = Counter("feasible" if c.feasible is True else "infeasible" if c.feasible is False else "unknown" for c in archive.candidates)
    counts.update({"stored": sum(len(c.occurrences) for c in archive.candidates), "unique": len(archive.candidates),
                   "eligible": len(decision.ordered), "excluded": len(other)})
    return {"version": VERSION, "revision": archive.revision, "sources": archive.sources, "dimensions": archive.dimensions,
        "counts": dict(counts), "rule": query.rule, "formula": FORMULAS[query.rule],
        "modelOrderingAvailable": archive.mode in ("weighted", "lexicographic"),
        "weights": dict(zip((d.key for d in archive.dimensions), decision.weights, strict=True)), "warnings": warnings,
        "winners": [row_view(c, decision, ranks) for c in winners[:200]], "winnerCount": len(winners),
        "next": [row_view(c, decision, ranks) for c in following[:200]], "nextCount": len(following),
        "rows": [row_view(c, decision, ranks) for c in displayed[query.page * query.pageSize:(query.page + 1) * query.pageSize]],
        "total": len(displayed), "page": query.page, "pageSize": query.pageSize, "pareto": pareto,
        "plot": plot_data(archive, decision, query, ranks), "geometry": geometry,
        "budgets": budget_map(archive, decision, query) if query.view == "budgets" else None,
        "trajectory": archive.trajectory if query.view == "evidence" else []}


def candidate_detail(archive: Archive, query: AnalysisQuery) -> dict:
    decision = decide(archive, query)
    by_id = {c.id: c for c in archive.candidates}
    selected = by_id.get(query.selected)
    if selected is None:
        raise ValueError("Select a binding present in this archive")
    comparison = []
    for candidate_id in query.compare:
        other = by_id.get(candidate_id)
        if other is None or other.id == selected.id:
            continue
        changes = [{"task": task, "selected": selected.binding.get(task), "alternative": other.binding.get(task)}
                   for task in sorted(selected.binding.keys() | other.binding.keys()) if selected.binding.get(task) != other.binding.get(task)]
        comparison.append({"id": other.id, "reasons": decision.reasons[other.id], "score": decision.scores.get(other.id),
            "scoreDelta": [b - a for a, b in zip(decision.scores[selected.id], decision.scores[other.id], strict=True)] if selected.id in decision.scores and other.id in decision.scores else None,
            "changes": changes, "dimensions": [{"key": d.key, "selected": selected.values[j], "alternative": other.values[j],
                "delta": other.values[j] - selected.values[j], "improves": (other.values[j] > selected.values[j]) if d.direction == "maximize" else (other.values[j] < selected.values[j])}
                for j, d in enumerate(archive.dimensions)] if selected.values is not None and other.values is not None else []})
    scope = pareto_rows(archive, decision, query)
    dominators = [c.id for c in scope if selected.losses is not None and dominates(c.losses, selected.losses)]
    def distance(c):
        if query.metric == "hamming":
            return float(sum(c.binding.get(task) != selected.binding.get(task) for task in c.binding.keys() | selected.binding.keys()))
        if c.normalized is None or selected.normalized is None:
            return math.inf
        delta = [abs(a - b) for a, b in zip(c.normalized, selected.normalized, strict=True)]
        if query.metric == "gower":
            tasks = c.binding.keys() | selected.binding.keys()
            active = [j for j, d in enumerate(archive.dimensions) if not d.constant]
            return (sum(delta[j] for j in active) + sum(c.binding.get(t) != selected.binding.get(t) for t in tasks)) / max(1, len(active) + len(tasks))
        return math.sqrt(sum(v * v for v in delta)) if query.metric == "euclidean" else sum(delta)
    nearest = heapq.nsmallest(query.neighbors, ((distance(c), c.id) for c in archive.candidates if c.id != selected.id))
    own_score = decision.scores.get(selected.id)
    next_group = next((decision.scores[c.id] for c in decision.ordered if own_score and decision.scores[c.id] > own_score), None)
    return {"revision": archive.revision, "row": row_view(selected, decision), "binding": selected.binding,
        "violations": safe(selected.solution.get("violations")) if isinstance(selected.solution.get("violations"), list) else [], "evaluation": safe(selected.solution), "metrics": safe(record(selected.solution.get("metrics"))),
        "occurrences": selected.occurrences, "comparison": comparison,
        "dominance": {"scope": query.paretoScope, "computed": selected.losses is not None,
            "eligibleForFront": selected in scope, "dominatorCount": len(dominators), "dominators": dominators[:200]},
        "neighbors": [{"id": cid, "distance": value, "metric": query.metric} for value, cid in nearest if math.isfinite(value)],
        "explanation": {"formula": FORMULAS[query.rule], "rule": query.rule, "score": own_score,
            "summary": "Recommended under the selected rule among stored eligible bindings." if decision.ranks.get(selected.id, (0, 0))[1] == 1 else "Compare this binding's score and trade-offs under the selected rule.",
            "eligibility": decision.reasons[selected.id], "nextScore": next_group,
            "nearTieTolerance": NEAR_TIE, "nearTie": bool(own_score and next_group and all(abs(a-b) <= NEAR_TIE * max(1, abs(a), abs(b)) for a, b in zip(own_score, next_group, strict=True))),
            "normalizationScope": archive.revision, "components": [{"key": d.key, "value": selected.values[j] if selected.values else None,
                "loss": selected.losses[j] if selected.losses else None, "normalized": selected.normalized[j] if selected.normalized else None,
                "weight": decision.weights[j], "weightedLoss": decision.weights[j] * selected.normalized[j] if selected.normalized else None,
                "minimum": d.minimum, "maximum": d.maximum, "direction": d.direction} for j, d in enumerate(archive.dimensions)]}}
