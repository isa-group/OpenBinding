"""Keeping what the engine said, and saying where it disagrees.

``canonicalization`` re-derives every metric a solution carries with the
reference evaluator, which is what stops four engines from having four
implementations of the same arithmetic. It also mutates the result in place, so
an engine's own account of its answer was not merely overridden - it was gone.

This preserves it on request, and does the comparison nobody was doing: an
engine that reports a solution feasible which the reference evaluator rejects
has a bug in its semantics, and that is worth stating rather than leaving to
whoever notices two numbers differ.

Everything here is read-only with respect to the canonical result. The official
answer does not change because somebody asked to see the engine's.
"""

from __future__ import annotations

import copy
import json
from typing import Any, Dict, List, Optional

from ..models.api import EngineDivergence, EngineReport

#: How much untransformed engine body is worth returning. `/solve` accepts up to
#: 512 MB, and a result can be proportionate; past this the report stops being
#: something a client wants in a response and becomes something it has to cope
#: with.
MAX_RAW_BYTES = 1024 * 1024

#: Below this, two objective values are the same number and the difference is
#: floating-point noise rather than a disagreement.
OBJECTIVE_TOLERANCE = 1e-9


def snapshot(result_data: Any) -> Any:
    """A deep copy taken before canonicalization.

    Deep, because canonicalization rewrites the solutions in place: a shallow
    copy would hand back the canonical values and quietly report perfect
    agreement every time.
    """
    return copy.deepcopy(result_data)


def _fits(payload: Any) -> bool:
    try:
        return len(json.dumps(payload, separators=(",", ":")).encode("utf-8")) <= MAX_RAW_BYTES
    except (TypeError, ValueError):
        # Not serialisable, so not returnable either.
        return False


def _compare(before: List[Dict[str, Any]], after: List[Dict[str, Any]]) -> EngineDivergence:
    """Where the engine's solutions and the canonical ones differ."""
    notes: List[str] = []
    mismatches = 0
    max_delta: Optional[float] = None

    for index, (engine, canonical) in enumerate(zip(before, after, strict=False)):
        if not isinstance(engine, dict) or not isinstance(canonical, dict):
            continue

        engine_feasible = engine.get("feasible")
        canonical_feasible = canonical.get("feasible")
        if engine_feasible is not None and engine_feasible != canonical_feasible:
            mismatches += 1
            notes.append(
                f"solution {index}: the engine reported feasible={engine_feasible}, "
                f"the reference evaluator says {canonical_feasible}"
            )

        engine_objective = engine.get("objective_value")
        # Canonicalization moves the engine's figure aside when it replaces it,
        # so the canonical one is whichever of these is now authoritative.
        canonical_objective = canonical.get("objective_value")
        if isinstance(engine_objective, (int, float)) and isinstance(
            canonical_objective, (int, float)
        ):
            delta = abs(float(engine_objective) - float(canonical_objective))
            if delta > OBJECTIVE_TOLERANCE:
                max_delta = delta if max_delta is None else max(max_delta, delta)
                notes.append(
                    f"solution {index}: objective differs by {delta:g} "
                    f"(engine {engine_objective:g}, reference {canonical_objective:g})"
                )

        engine_features = engine.get("aggregated_features")
        canonical_features = canonical.get("aggregated_features")
        if isinstance(engine_features, dict) and isinstance(canonical_features, dict):
            differing = sorted(
                name
                for name, value in engine_features.items()
                if name in canonical_features
                and isinstance(value, (int, float))
                and isinstance(canonical_features[name], (int, float))
                and abs(float(value) - float(canonical_features[name])) > OBJECTIVE_TOLERANCE
            )
            if differing:
                notes.append(
                    f"solution {index}: aggregated features differ: {', '.join(differing)}"
                )

    return EngineDivergence(
        solutions_compared=min(len(before), len(after)),
        feasibility_mismatches=mismatches,
        max_objective_delta=max_delta,
        notes=notes,
    )


def build(
    before: Any,
    after: Any,
    raw: Optional[Dict[str, Any]] = None,
) -> EngineReport:
    """The report, from the snapshot and the canonical result.

    ``before`` is what ``snapshot`` returned; ``after`` is the canonicalized
    result; ``raw`` is the engine's untransformed body, which is the part that
    matters for an engine using its own field names.
    """
    engine_solutions = []
    if isinstance(before, dict):
        candidate = before.get("solutions")
        if isinstance(candidate, list):
            engine_solutions = [s for s in candidate if isinstance(s, dict)]

    canonical_solutions = []
    if isinstance(after, dict):
        candidate = after.get("solutions")
        if isinstance(candidate, list):
            canonical_solutions = [s for s in candidate if isinstance(s, dict)]

    provenance = before.get("provenance") if isinstance(before, dict) else None

    raw_fits = raw is not None and _fits(raw)
    return EngineReport(
        solutions=engine_solutions,
        provenance=provenance if isinstance(provenance, dict) else None,
        raw=raw if raw_fits else None,
        raw_truncated=raw is not None and not raw_fits,
        divergence=_compare(engine_solutions, canonical_solutions),
    )
