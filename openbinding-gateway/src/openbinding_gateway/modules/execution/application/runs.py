"""What a finished run found, for the modules that cite a run as evidence.

A composition's ``evidence.run`` names a run of its organization; assessing the composition checks that the
run solved the linked revision and that the composition's binding is one of the run's solutions. This is
the one door to that data: it reads the run the caller may see (an API key sees only the runs of the Engine
revisions it may use, as every runs route does) and its stored result, and nothing else. The engine evidence
kept while a run is in flight is never read: it is deleted on success and never served.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Any, Mapping

from sqlalchemy.ext.asyncio import AsyncSession

from ....db.models import JobState, User
from ....services.engines import run_in_org


@dataclass(frozen=True, slots=True)
class RunSolutions:
    """A run of an organization and the solutions its result holds, in the order the result lists them.

    ``bindings[i]`` is the binding of solution ``i`` (``{task: {resource, id}}``), or ``None`` when that
    solution's decision is not a binding; ``features[i]`` is what the result reports for it.
    """

    run_id: uuid.UUID
    organization_id: uuid.UUID
    revision_id: uuid.UUID
    compilation_id: uuid.UUID
    state: JobState
    termination: str | None
    bindings: tuple[dict[str, dict[str, str]] | None, ...]
    features: tuple[dict[str, Any], ...]
    provenance: Mapping[str, Any]

    @property
    def completed(self) -> bool:
        """Whether the run finished and its result was kept."""
        return self.state is JobState.COMPLETED


def _binding(solution: Any) -> dict[str, dict[str, str]] | None:
    decision = solution.get("decision") if isinstance(solution, Mapping) else None
    if not isinstance(decision, Mapping) or decision.get("kind") != "binding":
        return None
    binding = decision.get("binding")
    if not isinstance(binding, Mapping):
        return None
    found: dict[str, dict[str, str]] = {}
    for task, reference in binding.items():
        if not isinstance(reference, Mapping):
            return None
        found[str(task)] = {"resource": str(reference.get("resource")), "id": str(reference.get("id"))}
    return found


def _features(solution: Any) -> dict[str, Any]:
    features = solution.get("features") if isinstance(solution, Mapping) else None
    return dict(features) if isinstance(features, Mapping) else {}


async def run_solutions(
    session: AsyncSession, organization_id: uuid.UUID, run_id: uuid.UUID, caller: User
) -> RunSolutions | None:
    """The run ``run_id`` of the organization and its solutions, or ``None`` when the caller cannot see it.

    Membership is the caller's to check. A run of another organization, a missing one and one of an Engine an
    API key may not use all read as ``None``.
    """
    job = await run_in_org(session, organization_id, run_id, caller)
    if job is None:
        return None
    result = job.result if isinstance(job.result, Mapping) else {}
    solutions = result.get("solutions")
    if not isinstance(solutions, list):
        solutions = []
    return RunSolutions(
        run_id=job.id,
        organization_id=job.organization_id,
        revision_id=job.revision_id,
        compilation_id=job.compilation_id,
        state=job.state,
        termination=job.termination,
        bindings=tuple(_binding(solution) for solution in solutions),
        features=tuple(_features(solution) for solution in solutions),
        provenance=dict(job.provenance) if isinstance(job.provenance, Mapping) else {},
    )


__all__ = ["RunSolutions", "run_solutions"]
