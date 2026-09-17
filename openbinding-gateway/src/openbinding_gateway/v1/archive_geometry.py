"""Bounded geometric views with explicit evidence and preference semantics."""
from __future__ import annotations

import bisect
import math

from .archive import axes_for, finite, metric_key, record, requirement_reasons, score

WORK_LIMIT = 2_000_000


def clip(polygon: list, a: float, b: float, c: float) -> list:
    output = []
    for i, p in enumerate(polygon):
        q = polygon[(i + 1) % len(polygon)]
        dp, dq = a * p[0] + b * p[1] - c, a * q[0] + b * q[1] - c
        if dp <= 0:
            output.append(p)
        if (dp <= 0) != (dq <= 0):
            t = dp / (dp - dq)
            output.append([p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])])
    return output


def area(polygon: list) -> float:
    return abs(sum(p[0] * polygon[(i + 1) % len(polygon)][1] - polygon[(i + 1) % len(polygon)][0] * p[1]
                   for i, p in enumerate(polygon))) / 2


def affine(node: dict, metric_axes: dict[str, int], depth=0) -> tuple | None:
    if depth > 32:
        return None
    node = record(node)
    if node.get("kind") == "literal" and finite(node.get("value")):
        return (0.0, 0.0, float(node["value"]))
    if node.get("kind") == "path":
        segments = node.get("segments", [])
        if len(segments) == 2 and segments[0] == "features" and segments[1] in metric_axes:
            axis = metric_axes[segments[1]]
            return (float(axis == 0), float(axis == 1), 0.0)
    if node.get("kind") == "negate":
        value = affine(node.get("value"), metric_axes, depth + 1)
        return tuple(-v for v in value) if value else None
    if node.get("kind") != "arithmetic":
        return None
    left, right = affine(node.get("left"), metric_axes, depth + 1), affine(node.get("right"), metric_axes, depth + 1)
    if left is None or right is None:
        return None
    op = node.get("op")
    if op in ("add", "sub"):
        return tuple(a + (b if op == "add" else -b) for a, b in zip(left, right, strict=True))
    if op == "mul":
        if left[:2] == (0, 0):
            return tuple(left[2] * v for v in right)
        if right[:2] == (0, 0):
            return tuple(right[2] * v for v in left)
    if op == "div" and right[:2] == (0, 0) and right[2] != 0:
        return tuple(v / right[2] for v in left)
    return None


def raw_constraint_planes(archive, axes):
    if len(axes) < 2:
        return [], []
    labels = [archive.dimensions[j].label.split(":")[-1] for j in axes[:2]]
    if labels[0] == labels[1]:
        return [], ["Two distinct features are required"]
    mapping, planes, skipped = dict(zip(labels, (0, 1), strict=True)), [], []
    for constraint in record(archive.document.get("spec")).get("constraints", []):
        label = metric_key(constraint.get("ref"))
        assertion = record(constraint.get("assert"))
        if constraint.get("when") != {"kind": "literal", "value": True} or assertion.get("kind") != "compare":
            skipped.append(f"{label}: conditional or unsupported predicate")
            continue
        left, right = affine(assertion.get("left"), mapping), affine(assertion.get("right"), mapping)
        op = assertion.get("op")
        if left is None or right is None or op not in ("lt", "lte", "gt", "gte", "eq"):
            skipped.append(f"{label}: hidden feature or nonlinear predicate")
            continue
        delta = [a - b for a, b in zip(left, right, strict=True)]
        for sign in ((1, -1) if op == "eq" else (-1,) if op in ("gt", "gte") else (1,)):
            planes.append({"a": sign * delta[0], "b": sign * delta[1], "c": -sign * delta[2],
                           "label": label, "hard": constraint.get("enforcement") == "hard", "strict": op in ("lt", "gt")})
    return planes, skipped


def outcome_constraints(archive, axes):
    """Map supported raw predicates to the fixed loss axes, without inverting clamped tails."""
    planes, skipped = raw_constraint_planes(archive, axes)
    if len(axes) < 2 or any(archive.dimensions[j].constant for j in axes[:2]):
        return {"planes": [], "skipped": skipped + ["Constraint projection needs two varying objectives"]}
    terms = archive.document["spec"]["optimization"]["terms"]
    transforms = []
    for j in axes[:2]:
        if j >= len(terms):
            return {"planes": [], "skipped": skipped + ["Aggregate penalties are not raw feature coordinates"]}
        d, term = archive.dimensions[j], terms[j]
        norm, sign = record(term.get("normalize")), -1 if d.direction == "maximize" else 1
        span = norm["max"] - norm["min"] if "min" in norm and "max" in norm else 1
        origin = norm.get("min", 0) if sign == 1 else norm.get("max", 0)
        transforms.append((origin + sign * span * d.minimum, sign * span * (d.maximum-d.minimum), norm))
    mapped = []
    for plane in planes:
        coefficients = [plane["a"], plane["b"]]
        invalid = False
        for i, (_, _, norm) in enumerate(transforms):
            if not coefficients[i] or not norm.get("clamp"):
                continue
            threshold = plane["c"] / coefficients[i]
            if coefficients[1-i] or not norm["min"] < threshold < norm["max"]:
                invalid = True
        if invalid:
            skipped.append(f"{plane['label']}: non-invertible clamping")
            continue
        mapped.append({**plane, "a": plane["a"] * transforms[0][1], "b": plane["b"] * transforms[1][1],
                       "c": plane["c"] - plane["a"] * transforms[0][0] - plane["b"] * transforms[1][0]})
    return {"planes": mapped, "skipped": skipped,
            "meaning": "Displayed constraints give necessary conditions only. Unshaded locations need not correspond to a realizable binding."}


def budget_map(archive, decision, query):
    axes = axes_for(archive, query)[:2]
    if len(axes) < 2:
        return {"available": False, "reason": "Choose two objectives"}
    keys = {archive.dimensions[j].key for j in axes}
    signs = [-1 if archive.dimensions[j].direction == "maximize" else 1 for j in axes]
    rows = [c for c in archive.candidates if not requirement_reasons(archive, c, query, keys)]
    points = sorted((signs[0] * c.values[axes[0]], signs[1] * c.values[axes[1]], c.id) for c in rows)
    corners, best_y = [], math.inf
    for x, y, candidate_id in points:
        if y < best_y:
            corners.append({"x": x, "y": y, "id": candidate_id})
            best_y = y
    all_values = [(signs[0] * c.values[axes[0]], signs[1] * c.values[axes[1]]) for c in archive.candidates if c.values is not None]
    bounds = [min((p[0] for p in all_values), default=0), min((p[1] for p in all_values), default=0),
              max((p[0] for p in all_values), default=1), max((p[1] for p in all_values), default=1)]
    for k in (0, 1):
        span = bounds[k + 2] - bounds[k] or 1
        bounds[k] -= span * .1
        bounds[k + 2] += span * .1
    selected = []
    by_key = {r.dimension: r for r in query.requirements}
    for k, j in enumerate(axes):
        requirement = by_key.get(archive.dimensions[j].key)
        selected.append(signs[k] * requirement.value if requirement and requirement.space == "raw" else None)
        if selected[-1] is not None:
            bounds[k] = min(bounds[k], selected[-1])
            bounds[k + 2] = max(bounds[k + 2], selected[-1])
    # Outcome half-planes a*f <= c imply exclusions for budgets only when a <= 0
    # after direction conversion: tightening these budgets preserves the violation.
    planes, skipped = raw_constraint_planes(archive, axes)
    excluded = []
    for plane in planes:
        a, b = plane["a"] * signs[0], plane["b"] * signs[1]
        if plane["hard"] and a <= 0 and b <= 0 and (a < 0 or b < 0):
            excluded.append({**plane, "a": a, "b": b})
    aggregate = len(corners) > 1500
    tiles = []
    if aggregate:
        xs = [p["x"] for p in corners]
        for x in range(64):
            for y in range(64):
                lo_x = bounds[0] + x / 64 * (bounds[2] - bounds[0])
                lo_y = bounds[1] + y / 64 * (bounds[3] - bounds[1])
                index = bisect.bisect_right(xs, lo_x) - 1
                if index >= 0 and corners[index]["y"] <= lo_y:
                    tiles.append({"x": x, "y": y, "witness": corners[index]["id"]})
    return {"available": True, "axes": axes, "signs": signs, "bounds": bounds, "selected": selected,
        "corners": [] if aggregate else corners, "tiles": tiles, "resolution": 64, "aggregated": aggregate,
        "cornerCount": len(corners), "witnessCount": len(rows), "excluded": excluded, "skipped": skipped,
        "meaning": "A stored feasible binding meets all these budgets. Uncovered space is unknown.",
        "detail": "Conservative whole-tile achievement; boundary tiles need an exact budget query." if aggregate else "Exact archive attainment staircase; hidden requirements use the same witness."}


def preference_geometry(archive, decision, query):
    rows = decision.ordered
    axes = axes_for(archive, query)
    active = [j for j, d in enumerate(archive.dimensions) if not d.constant]
    if not rows:
        return {"kind": "preferences", "state": "empty", "cells": []}
    if query.geometry == "sensitivity":
        axis = axes[0]
        if len(rows) * len(archive.dimensions) * 21 > 20_000_000:
            return {"kind": "sensitivity", "state": "unavailable", "reason": "Scenario work limit reached; individual rankings remain exact"}
        reference = [query.reference.get(d.key, 0) for d in archive.dimensions]
        scenarios = []
        for step in range(21):
            t = step / 20
            weights = [(1-t)*w + (t if j == axis else 0) for j, w in enumerate(decision.weights)]
            evaluated = [(score(c, weights, query.rule, reference), c.id) for c in rows]
            best = min(s for s, _ in evaluated)
            winners = [cid for s, cid in evaluated if s == best]
            scenarios.append({"t": t, "winners": winners[:200], "winnerCount": len(winners), "score": best})
        return {"kind": "sensitivity", "state": "complete", "axis": axis, "scenarios": scenarios,
                "meaning": "21 declared priority scenarios, each compared against every eligible binding. Counts are not probabilities or continuous winner intervals."}
    if query.rule != "weighted":
        return {"kind": "power", "state": "unavailable", "reason": "Select weighted sum to inspect its exact preference regions"}
    chosen = [j for j in axes if j in active]
    chosen += [j for j in active if j not in chosen][:3-len(chosen)]
    chosen = chosen[:3]
    if len(chosen) < 2:
        return {"kind": "power", "state": "unavailable", "reason": "At least two varying objectives are required"}
    mass = sum(decision.weights[j] for j in chosen)
    if mass <= 0:
        return {"kind": "power", "state": "unavailable", "reason": "Give the displayed objectives positive priority"}
    groups = {}
    for c in rows:
        fixed = sum(w * c.normalized[j] for j, w in enumerate(decision.weights) if j not in chosen)
        z = [c.normalized[j] for j in chosen]
        coefficients = (mass * (z[0] - z[-1]), mass * (z[1] - z[-1]) if len(z) == 3 else 0, fixed + mass * z[-1])
        groups.setdefault(coefficients, []).append(c.id)
    selected_only = len(groups) > 300
    sites = [(coef, ids) for coef, ids in groups.items() if not selected_only or query.selected in ids]
    if not sites:
        return {"kind": "power", "state": "unavailable", "reason": "Select an eligible binding to compute its cell against the full archive"}
    cells, work = [], 0
    for (a, b, c), ids in sites:
        polygon = [[0, 0], [1, 0], [0, 1]] if len(chosen) == 3 else [[0, 0], [1, 0], [1, 1], [0, 1]]
        for (oa, ob, oc) in groups:
            work += len(polygon)
            if work > WORK_LIMIT:
                return {"kind": "power", "state": "unavailable", "reason": "Exact geometry exceeded its work budget; ranking still compares all bindings"}
            polygon = clip(polygon, a-oa, b-ob, oc-c)
            if not polygon:
                break
        cells.append({"ids": ([query.selected] + [cid for cid in ids if cid != query.selected])[:200] if query.selected in ids else ids[:200], "count": len(ids), "polygon": polygon, "area": area(polygon),
                      "coefficients": [a, b, c], "site": [-a/2, -b/2], "powerWeight": (a*a+b*b)/4-c})
    return {"kind": "power", "state": "complete", "axes": chosen, "mass": mass, "cells": cells,
            "selectedOnly": selected_only, "competitors": len(rows), "functions": len(groups),
            "meaning": "Exact weighted-sum winner regions in this priority slice. Area is coverage of priorities, not quality or probability."}


def proximity_geometry(archive, decision, query):
    axes = axes_for(archive, query)[:2]
    if len(axes) < 2:
        return {"kind": "voronoi", "state": "unavailable", "reason": "Two objective axes are required"}
    groups = {}
    for c in decision.ordered:
        groups.setdefault(tuple(c.normalized[j] for j in axes), []).append(c.id)
    if len(groups) > 300:
        return {"kind": "voronoi", "state": "unavailable", "reason": "Voronoi requires at most 300 distinct eligible sites; use density and exact neighbors for larger archives"}
    constraints = outcome_constraints(archive, axes)
    cells, work = [], 0
    for (x, y), ids in groups.items():
        polygon = [[0, 0], [1, 0], [1, 1], [0, 1]]
        for ox, oy in groups:
            work += len(polygon)
            if work > WORK_LIMIT:
                return {"kind": "voronoi", "state": "unavailable", "reason": "Geometry work limit reached"}
            polygon = clip(polygon, ox-x, oy-y, ((ox-x)*(ox+x)+(oy-y)*(oy+y))/2)
        restricted = polygon
        for plane in constraints["planes"]:
            if plane["hard"]:
                restricted = clip(restricted, plane["a"], plane["b"], plane["c"])
        cells.append({"ids": ([query.selected] + [cid for cid in ids if cid != query.selected])[:200] if query.selected in ids else ids[:200], "count": len(ids), "polygon": polygon, "area": area(polygon), "site": [x, y],
                      "restrictedPolygon": restricted, "restrictedArea": area(restricted)})
    return {"kind": "voronoi", "state": "complete", "axes": axes, "cells": cells,
            "constraints": constraints,
            "meaning": "Nearest eligible objective site under Euclidean distance on fixed normalized axes. Cell area does not measure binding quality or feasibility."}
