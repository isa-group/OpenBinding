import { useEffect, useState } from 'react';
import { HttpError } from '../../core/api/http';
import { readEventStream } from '../../core/utils/sse/readEventStream';
import { useRunsApi, type JobDetail, type RunsApi } from '../api/runsApi';
import { isActive, normalizeStatus } from '../utils/runsModel';

// A run followed over the gateway's event stream (`GET …/runs/{run}/events`, F6). The stream's `job` events carry only the
// run's status, its cancellation and when it finished, while the page shows a whole `JobDetail`: each `job` event is a
// trigger to read the run again (one reading at a time; a trigger that arrives meanwhile asks once more after it), never
// data. The gateway writes a line only when the run changes and a keep-alive comment every 15 s while it is quiet, so the
// reader's 45 s silence limit holds for a quiet run. The stream ends by itself with the run, after `session-ended` (the
// feed is then paused: the session is gone), or after about 15 minutes, when it is opened again for as long as the run
// goes on. A stream that fails, falls silent or does not answer within the silence limit hands over to asking every 2 s,
// and is tried again a minute later; streams that keep ending within seconds leave it to the asking for good.

/** How often a run is asked about again when its stream cannot be followed: the fallback only. */
export const POLL_MS = 2000;
const GIVE_UP_AFTER = 3;
/** How long the 2 s asking stands in for a stream that failed before the stream is tried again. */
export const STREAM_RETRY_MS = 60_000;
/** A stream that ends sooner than this without the run finishing ended too soon; two in a row leave it to the asking. */
const SHORT_STREAM_MS = 10_000;
/** How long a stream may take to answer: the reader's own silence limit. */
const OPEN_LIMIT_MS = 45_000;

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

/** Wait `ms`, or less if `signal` aborts first. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const timer = window.setTimeout(done, ms);
    function done() {
      window.clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done);
  });
}

/**
 * Follow one job over its event stream: read it once, then read it again at each `job` event until it ends; the 2 s
 * reading stands in while there is no stream (none offered, a failed or silent one until it is tried again, or streams
 * that keep ending too soon). Returns the function that stops following.
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
  const standDown = () => {
    stopPolling?.();
    stopPolling = null;
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

  /** Open the stream within the silence limit (a proxy holding its headers counts as a failure). */
  const open = async () => {
    const attempt = new AbortController();
    const stop = () => attempt.abort();
    controller.signal.addEventListener('abort', stop);
    const timer = window.setTimeout(stop, OPEN_LIMIT_MS);
    try {
      const response = await events(org, jobId, attempt.signal);
      if (!response.ok) throw new HttpError(response.status, response.statusText);
      return { response, signal: attempt.signal };
    } finally {
      window.clearTimeout(timer);
      controller.signal.removeEventListener('abort', stop);
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
    let short = 0;
    while (active && isActive(normalizeStatus(detail.status))) {
      let sessionEnded = false;
      let failed = false;
      const opened = Date.now();
      try {
        const { response, signal } = await open();
        await readEventStream(
          response,
          event => {
            if (event.event === 'job') void reread();
            else if (event.event === 'session-ended') sessionEnded = true;
          },
          { signal }
        );
      } catch {
        failed = true;
      }
      if (!active) return;
      if (sessionEnded) {
        // Signed out elsewhere: what is shown stays, and the feed says it stopped.
        publish(current => (current ? { ...current, lost: true } : current));
        return;
      }
      if (failed) {
        // The 2 s asking stands in, then the stream is tried again (the asking stops when the run ends).
        fallBack();
        await pause(STREAM_RETRY_MS, controller.signal);
        if (!active) return;
        standDown();
      } else if (Date.now() - opened < SHORT_STREAM_MS) {
        short += 1;
        if (short >= 2) {
          fallBack();
          return;
        }
      } else short = 0;
      try {
        detail = await api.get(org, jobId, controller.signal);
        show(detail);
      } catch {
        fallBack();
        return;
      }
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
