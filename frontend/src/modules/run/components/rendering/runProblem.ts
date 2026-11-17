import type { ProblemFacts } from '../../../core/api/types';
import type { RunProblem } from './runResultModel';

/**
 * What the result of a run needs to know of its compiled problem, read from the facts of the run's compilation: each task with the
 * candidates it can take (their id, the name the problem writes for them, provider and values), the features with their units
 * and the criteria with their directions. Nothing is computed: the facts are only placed into the run models' shapes.
 */
export function runProblemOf(facts: ProblemFacts): RunProblem {
  const byKey = new Map(facts.candidates.map(candidate => [candidate.key, candidate]));
  return {
    tasks: facts.tasks.map(task => ({
      id: task.id,
      name: task.id,
      candidates: task.eligible.flatMap(eligible => {
        const candidate = byKey.get(eligible.candidate);
        return candidate
          ? [
              {
                id: candidate.id,
                name: eligible.written,
                provider: candidate.provider,
                features: candidate.values,
              },
            ]
          : [];
      }),
    })),
    features: Object.fromEntries(
      facts.features.map(feature => [feature.id, { unit: feature.unit }])
    ),
    criteria: facts.objectives.criteria.flatMap(criterion =>
      typeof criterion.id === 'string'
        ? [
            {
              id: criterion.id,
              direction:
                criterion.direction === 'minimize' || criterion.direction === 'maximize'
                  ? criterion.direction
                  : null,
            },
          ]
        : []
    ),
  };
}
