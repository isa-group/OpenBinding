import { useEffect, useState } from 'react';
import { runProblemOf } from '../../components/rendering/runProblem';
import type { RunProblem } from '../../components/rendering/runResultModel';
import { problemFactsApi } from '../../entities/problem/facts';
import type { ProblemFacts } from '../../shared/api/types';
import type { Origin } from './RunOutcome';

interface RunProblemState {
  /** undefined while loading; null when the compiled problem is not available. */
  problem: RunProblem | null | undefined;
  /** The constraints of the facts, which the bounds of a solution are read against. */
  constraints: ProblemFacts['constraints'];
}

const LOADING: RunProblemState = { problem: undefined, constraints: [] };
const UNAVAILABLE: RunProblemState = { problem: null, constraints: [] };

/**
 * The compiled problem of a run (the facts of the compilation it names), read once when `enabled`: what RunResult needs to name
 * tasks and candidates and to show bounds.
 */
export function useRunProblem(origin: Origin | null, enabled: boolean): RunProblemState {
  const key = origin?.compilationId
    ? `${origin.org}/${origin.caseSlug}/${origin.revision}/${origin.compilationId}`
    : undefined;
  const [state, setState] = useState<{ key: string | undefined; value: RunProblemState }>({
    key,
    value: LOADING,
  });

  useEffect(() => {
    if (!enabled || !key || !origin?.compilationId) return undefined;
    let cancelled = false;
    problemFactsApi.get(origin.org, origin.caseSlug, origin.revision, origin.compilationId).then(
      facts => {
        if (!cancelled)
          setState({
            key,
            value: { problem: runProblemOf(facts), constraints: facts.constraints },
          });
      },
      () => {
        if (!cancelled) setState({ key, value: UNAVAILABLE });
      }
    );
    return () => {
      cancelled = true;
    };
    // The key names the compilation; the origin object itself changes identity on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled]);

  if (enabled && !key) return UNAVAILABLE;
  return state.key === key ? state.value : LOADING;
}
