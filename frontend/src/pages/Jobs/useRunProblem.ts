import { useEffect, useState } from 'react';
import { problemsApi } from '../../api/problems';
import type { RunProblem } from '../../components/rendering/runResultModel';
import { readBindingProblem } from '../Cases/bindingModel';
import type { Origin } from './JobResult';

interface RunProblemState {
  /** undefined while loading; null when the compiled problem is not available. */
  problem: RunProblem | null | undefined;
  constraints: unknown[];
}

const LOADING: RunProblemState = { problem: undefined, constraints: [] };
const UNAVAILABLE: RunProblemState = { problem: null, constraints: [] };

/**
 * The compiled problem of a run (the IR of the compilation it names), read once when `enabled`: what RunResult needs to name tasks and
 * candidates and to show bounds.
 */
export function useRunProblem(origin: Origin | null, enabled: boolean): RunProblemState {
  const key = origin?.compilationId ? `${origin.org}/${origin.caseSlug}/${origin.revision}/${origin.compilationId}` : undefined;
  const [state, setState] = useState<{ key: string | undefined; value: RunProblemState }>({ key, value: LOADING });

  useEffect(() => {
    if (!enabled || !key || !origin?.compilationId) return undefined;
    let cancelled = false;
    problemsApi.ir(origin.org, origin.caseSlug, origin.revision, origin.compilationId).then(
      ({ ir: document }) => {
        if (cancelled) return;
        const spec = (document as { spec?: { constraints?: unknown } } | null)?.spec;
        const constraints = Array.isArray(spec?.constraints) ? spec.constraints : [];
        setState({ key, value: { problem: readBindingProblem(document), constraints } });
      },
      () => {
        if (!cancelled) setState({ key, value: UNAVAILABLE });
      },
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
