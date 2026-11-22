import { useEffect, useState } from 'react';
import { HttpError } from '../../core/api/http';
import { readEventStream } from '../../core/utils/sse/readEventStream';
import { useRunsApi, type JobDetail, type RunsApi } from '../api/runsApi';
import { isActive, normalizeStatus } from '../utils/runsModel';

// A run followed over the gateway's event stream (`GET …/runs/{run}/events`, F6). The stream's `job` events carry only the
// run's status, its cancellation and when it finished, while the page shows a whole `JobDetail`: each `job` event is a
// trigger to read the run again (one reading at a time; a trigger that arrives meanwhile asks once more after it), never
// data. The gateway writes a line only when the run changes and a keep-alive comment every 15 s while it is quiet, so the
// reader's 45 s silence limit holds for a quiet run. The stream ends by itself with the run, after `session-ended`, or after
// about 15 minutes: an end without a finished run reopens it once, then falls back to asking every 2 s, as a stream that
// fails, falls silent or cannot be opened does at once.

/** How often a run is asked about again when its stream cannot be followed: the fallback only. */
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
 * The first reading failing is an answer (a 404 is the same for a missing run and one of another organization); later readings failing are
 * retried, and after a few the feed is reported as lost rather than pretending to be live.
 */
function poll(
  get: RunsApi['get'],
  org: string,
  jobId: string,
  first: boolean,
  publish: Publish
): () => void {
  let active = true;
  let timer: number | undefined;
  let failures = 0;
  const read = (initial: boolean) => {
    get(org, jobId).then(
      detail => {
        if (!active) return;
        failures = 0;
        publish(() => ({ jobId, phase: 'ready', detail, lost: false }));
        if (isActive(normalizeStatus(detail.status)))
          timer = window.setTimeout(() => read(false), POLL_MS);
      },
      (error: unknown) => {
        if (!active) return;
        failures += 1;
        const answered =
          error instanceof HttpError &&
          (error.status === 404 || error.status === 403 || error.status === 401);
        if (initial || answered) {
          publish(() => ({ jobId, phase: 'error', error, lost: false }));
          return;
        }
        if (failures >= GIVE_UP_AFTER) {
          publish(current =>
            current ? { ...current, lost: true } : { jobId, phase: 'error', error, lost: false }
          );
          return;
        }
        timer = window.setTimeout(() => read(false), POLL_MS * 2);
      }
    );
  };
  read(first);
  return () => {
    active = false;
    window.clearTimeout(timer);
  };
}

/**
 * Follow one job over its event stream: read it once, then read it again at each `job` event until it ends; the 2 s
 * reading is the fallback (no stream, a failed or silent stream, or a second end before the run finished). Returns the
 * function that stops following.
 */
function follow(
  api: Pick<RunsApi, 'get' | 'events'>,
  org: string,
  jobId: string,
  first: boolean,
  publish: Publish
): () => void {
  const events = api.events;
  if (!events) return poll(api.get, org, jobId, first, publish);
  let active = true;
  let stopPolling: (() => void) | null = null;
  const controller = new AbortController();
  const fallBack = () => {
    if (active && !stopPolling) stopPolling = poll(api.get, org, jobId, false, publish);
  };
  const show = (detail: JobDetail) => {
    if (active) publish(() => ({ jobId, phase: 'ready', detail, lost: false }));
  };

  // One reading at a time: a trigger that arrives while one is on its way asks once more after it.
  let reading = false;
  let again = false;
  const reread = async () => {
    if (reading) {
      again = true;
      return;
    }
    reading = true;
    try {
      do {
        again = false;
        show(await api.get(org, jobId, controller.signal));
      } while (again && active);
    } catch {
      // A reading that failed: the next event, or the stream's end, asks again.
    } finally {
      reading = false;
    }
  };

  void (async () => {
    let detail: JobDetail;
    try {
      detail = await api.get(org, jobId, controller.signal);
    } catch {
      // The first reading's refusal is the polling's to say (a 404 or 403 is an answer, anything else is retried).
      if (active) stopPolling = poll(api.get, org, jobId, first, publish);
      return;
    }
    show(detail);
    let reopened = false;
    while (active && isActive(normalizeStatus(detail.status))) {
      let sessionEnded = false;
      try {
        const response = await events(org, jobId, controller.signal);
        if (!response.ok) throw new HttpError(response.status, response.statusText);
        await readEventStream(
          response,
          event => {
            if (event.event === 'job') void reread();
            else if (event.event === 'session-ended') sessionEnded = true;
          },
          { signal: controller.signal }
        );
      } catch {
        fallBack();
        return;
      }
      if (!active) return;
      try {
        detail = await api.get(org, jobId, controller.signal);
        show(detail);
      } catch {
        fallBack();
        return;
      }
      // Signed out: nothing more to follow. Finished: done.
      if (sessionEnded || !isActive(normalizeStatus(detail.status))) return;
      if (reopened) {
        fallBack();
        return;
      }
      reopened = true;
    }
  })();

  return () => {
    active = false;
    controller.abort();
    stopPolling?.();
  };
}

export interface RunLive {
  phase: 'loading' | 'ready' | 'error';
  detail: JobDetail | undefined;
  error: unknown;
  /** `live` while following, `finished` once the run ended, `paused` when the updates stopped arriving. */
  feed: 'live' | 'finished' | 'paused';
  /** Take a reading now (after a cancel or a retry) and, if the run is still moving, go on following it. */
  refresh: () => void;
  /** Use a state that came back from an action (cancel) without waiting for the next reading. */
  adopt: (status: string) => void;
}

/** One run of an organization as a member sees it, kept up to date while it is queued or running. */
export function useRunLive(org: string, jobId: string): RunLive {
  const [state, setState] = useState<LiveState | null>(null);
  const [nonce, setNonce] = useState(0);
  const api = useRunsApi();
  const { get, events } = api;

  // A reading asked for again (after cancelling or retrying) is not the first: the run was already shown.
  useEffect(
    () => follow({ get, events }, org, jobId, nonce === 0, setState),
    [get, events, org, jobId, nonce]
  );

  const mine = state?.jobId === jobId ? state : null;
  const detail = mine?.detail;
  const finished = detail ? !isActive(normalizeStatus(detail.status)) : false;
  return {
    phase: mine ? mine.phase : 'loading',
    detail,
    error: mine?.error,
    feed: mine?.lost ? 'paused' : finished ? 'finished' : 'live',
    refresh: () => setNonce(value => value + 1),
    adopt: status =>
      setState(current =>
        current && current.detail ? { ...current, detail: { ...current.detail, status } } : current
      ),
  };
}
