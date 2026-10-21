import { apiClient, type V1JobStatus } from '../../api/client';

/** First wait between two looks at a job; each wait is {@link POLL_GROWTH} times the one before, up to {@link POLL_MAX_MS}. */
export const POLL_START_MS = 500;
export const POLL_MAX_MS = 5_000;
export const POLL_GROWTH = 1.5;
/** How long the screen waits for one job before it stops looking (the job itself is not cancelled). */
export const POLL_TIMEOUT_MS = 10 * 60 * 1000;

/** The screen stopped waiting; the job may still finish on the server. */
export class JobWaitTimeout extends Error {
  constructor(jobId: string, minutes: number) {
    super(`The job is still not finished after ${minutes} minutes, so this screen stopped waiting. It keeps running on the server: open it from your jobs (${jobId}).`);
    this.name = 'JobWaitTimeout';
  }
}

function abortError(): DOMException {
  return new DOMException('The wait was cancelled', 'AbortError');
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const timer = window.setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      window.clearTimeout(timer);
      reject(abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export interface PollOptions {
  /** Stops the loop (and the request in flight) with an AbortError: the screen closed or a newer run took over. */
  signal: AbortSignal;
  /** Called with every status read, so the screen can show `running`. */
  onStatus?: (job: V1JobStatus) => void;
  timeoutMs?: number;
}

/**
 * Looks at a job until it is `completed` or `failed` and returns that last reading. The wait between looks grows
 * from half a second to five, the loop ends with {@link JobWaitTimeout} after `timeoutMs`, and it stops at once
 * when `signal` aborts. A refused or failed request ends it with that error.
 */
export async function pollV1Job(jobId: string, { signal, onStatus, timeoutMs = POLL_TIMEOUT_MS }: PollOptions): Promise<V1JobStatus> {
  const startedAt = Date.now();
  let wait = POLL_START_MS;
  for (;;) {
    const job = await apiClient.getV1Job(jobId, signal);
    if (signal.aborted) throw abortError();
    onStatus?.(job);
    if (job.status === 'completed' || job.status === 'failed') return job;
    if (Date.now() - startedAt + wait > timeoutMs) throw new JobWaitTimeout(jobId, Math.round(timeoutMs / 60_000));
    await pause(wait, signal);
    wait = Math.min(POLL_MAX_MS, Math.round(wait * POLL_GROWTH));
  }
}

export function isAbort(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError';
}
