import { useEffect, useState } from 'react';
import { jobsApi } from '../../api/jobs';
import type { RunProblem } from '../../components/rendering/runResultModel';
import { readBindingProblem } from '../Cases/bindingModel';

interface RunProblemState {
  /** undefined while loading; null when the compiled problem is not available. */
  problem: RunProblem | null | undefined;
  constraints: unknown[];
}

const LOADING: RunProblemState = { problem: undefined, constraints: [] };
const UNAVAILABLE: RunProblemState = { problem: null, constraints: [] };

/** The compiled problem of a run, read once when `enabled`: what RunResult needs to name tasks and candidates and to show bounds. */
// [impl->req~frontend-rendering-job-run-result~1]
export function useRunProblem(jobId: string | undefined, enabled: boolean): RunProblemState {
  const [state, setState] = useState<{ jobId: string | undefined; value: RunProblemState }>({ jobId, value: LOADING });

  useEffect(() => {
    if (!enabled || !jobId) return undefined;
    let cancelled = false;
    jobsApi.ir(jobId).then(
      (document) => {
        if (cancelled) return;
        const spec = (document as { spec?: { constraints?: unknown } } | null)?.spec;
        const constraints = Array.isArray(spec?.constraints) ? spec.constraints : [];
        setState({ jobId, value: { problem: readBindingProblem(document), constraints } });
      },
      () => {
        if (!cancelled) setState({ jobId, value: UNAVAILABLE });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [jobId, enabled]);

  return state.jobId === jobId ? state.value : LOADING;
}
