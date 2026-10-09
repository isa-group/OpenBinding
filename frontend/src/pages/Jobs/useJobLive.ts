import { useEffect, useState } from 'react';
import { HttpError } from '../../api/client';
import { jobsApi, type JobDetail } from '../../api/jobs';
import { isActive, normalizeStatus } from './jobsModel';

/** How often a run that has not finished is asked about again. The stream of events carries status snapshots only, so this is the same news. */
export const POLL_MS = 2000;
const GIVE_UP_AFTER = 3;

interface LiveState {
  jobId: string;
  phase: 'ready' | 'error';
  detail?: JobDetail;
  error?: unknown;
  /** Updates stopped coming (the gateway stopped answering) while the run was still going. */
  lost: boolean;
}

type Publish = (update: (current: LiveState | null) => LiveState | null) => void;

/**
 * Ask about one job until it ends, handing every answer to `publish`. Returns the function that stops asking.
 * The first reading failing is an answer (a 404 is the same for a missing run and one that is not yours); later readings failing are
 * retried, and after a few the feed is reported as lost rather than pretending to be live.
 */
function follow(jobId: string, first: boolean, publish: Publish): () => void {
  let active = true;
  let timer: number | undefined;
  let failures = 0;
  const read = (initial: boolean) => {
    jobsApi.detail(jobId).then(
      (detail) => {
        if (!active) return;
        failures = 0;
        publish(() => ({ jobId, phase: 'ready', detail, lost: false }));
        if (isActive(normalizeStatus(detail.status))) timer = window.setTimeout(() => read(false), POLL_MS);
      },
      (error: unknown) => {
        if (!active) return;
        failures += 1;
        const answered = error instanceof HttpError && (error.status === 404 || error.status === 403 || error.status === 401);
        if (initial || answered) {
          publish(() => ({ jobId, phase: 'error', error, lost: false }));
          return;
        }
        if (failures >= GIVE_UP_AFTER) {
          publish((current) => (current ? { ...current, lost: true } : { jobId, phase: 'error', error, lost: false }));
          return;
        }
        timer = window.setTimeout(() => read(false), POLL_MS * 2);
      },
    );
  };
  read(first);
  return () => {
    active = false;
    window.clearTimeout(timer);
  };
}

export interface JobLive {
  phase: 'loading' | 'ready' | 'error';
  detail: JobDetail | undefined;
  error: unknown;
  /** `live` while asking, `finished` once the run ended, `paused` when the updates stopped arriving. */
  feed: 'live' | 'finished' | 'paused';
  /** Take a reading now (after a cancel or a retry) and, if the run is still moving, go on asking. */
  refresh: () => void;
  /** Use a state that came back from an action (cancel) without waiting for the next reading. */
  adopt: (status: string) => void;
}

/** One job as its launcher sees it, kept up to date while it is queued or running. */
export function useJobLive(jobId: string): JobLive {
  const [state, setState] = useState<LiveState | null>(null);
  const [nonce, setNonce] = useState(0);

  // A reading asked for again (after cancelling or retrying) is not the first: the run was already shown.
  useEffect(() => follow(jobId, nonce === 0, setState), [jobId, nonce]);

  const mine = state?.jobId === jobId ? state : null;
  const detail = mine?.detail;
  const finished = detail ? !isActive(normalizeStatus(detail.status)) : false;
  return {
    phase: mine ? mine.phase : 'loading',
    detail,
    error: mine?.error,
    feed: mine?.lost ? 'paused' : finished ? 'finished' : 'live',
    refresh: () => setNonce((value) => value + 1),
    adopt: (status) => setState((current) => (current && current.detail ? { ...current, detail: { ...current.detail, status } } : current)),
  };
}
