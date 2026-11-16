import { readApiError } from '../../modules/core/api/errors';

// Every live check of the editors (validate, versions/check, evaluate, the BIM validate) runs through one of these. A
// scheduler is one kind of check: it waits until the text has been still for `delay`, drops the answer of a check the text
// has moved past (aborting its request), never has two requests of its kind open at once, and when the gateway answers 429
// it pauses for the `Retry-After` the gateway named before checking the latest text once more. It never retries in a loop:
// a refusal other than 429 is reported and the next check waits for the next change.

/** What a scheduler is doing. `until` is when a pause ends, in epoch milliseconds. */
export type SchedulerStatus =
  | { state: 'idle' }
  | { state: 'waiting' }
  | { state: 'running' }
  | { state: 'paused'; until: number };

export interface SchedulerOptions<Input, Output> {
  /** Milliseconds of stillness before a check starts (A-7: 600 ms for validate, 1500 ms for check, …). */
  delay: number;
  /** The check itself. It must hand `signal` to the request, so a stale check is aborted on the wire. */
  run: (input: Input, signal: AbortSignal) => Promise<Output>;
  /** The answer of a check the input has not moved past. */
  onResult: (output: Output, input: Input) => void;
  /** A refusal other than 429, of a check the input has not moved past. */
  onError?: (error: unknown, input: Input) => void;
  onStatus?: (status: SchedulerStatus) => void;
}

export interface Scheduler<Input> {
  /** A new input: the check starts once nothing new has come for `delay`. */
  schedule(input: Input): void;
  /** Checks the latest input now, without waiting for the delay (still never during a pause or beside another check). */
  flush(): void;
  /** Forgets the waiting input and aborts the check in flight. */
  cancel(): void;
  /** `cancel`, and nothing more is reported. */
  dispose(): void;
  status(): SchedulerStatus;
}

/** Seconds to pause when a 429 names no `Retry-After`. */
export const DEFAULT_PAUSE_SECONDS = 5;

/** The notice of a pause: "Checks paused, resuming in 3 s". */
export function pausedMessage(until: number, now: number = Date.now()): string {
  return `Checks paused, resuming in ${Math.max(1, Math.ceil((until - now) / 1000))} s`;
}

export function createScheduler<Input, Output>(
  options: SchedulerOptions<Input, Output>
): Scheduler<Input> {
  const { delay, run, onResult, onError, onStatus } = options;
  const EMPTY = Symbol('empty');
  let pending: Input | typeof EMPTY = EMPTY;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pauseTimer: ReturnType<typeof setTimeout> | null = null;
  let pausedUntil: number | null = null;
  let inFlight: AbortController | null = null;
  /** The delay has passed while a stale check was still settling: start as soon as it has. */
  let due = false;
  let disposed = false;
  let current: SchedulerStatus = { state: 'idle' };

  const report = (next: SchedulerStatus) => {
    const same =
      next.state === current.state &&
      (next.state !== 'paused' || (current.state === 'paused' && next.until === current.until));
    if (same) return;
    current = next;
    if (!disposed) onStatus?.(next);
  };

  const settle = () => {
    if (pausedUntil !== null) return;
    if (inFlight) return report({ state: 'running' });
    if (timer) return report({ state: 'waiting' });
    report({ state: 'idle' });
  };

  const start = () => {
    if (disposed || pending === EMPTY || pausedUntil !== null) return;
    if (inFlight) {
      due = true;
      return;
    }
    const input = pending;
    pending = EMPTY;
    due = false;
    const controller = new AbortController();
    inFlight = controller;
    report({ state: 'running' });
    run(input, controller.signal)
      .then(
        output => {
          if (!controller.signal.aborted && !disposed) onResult(output, input);
        },
        (error: unknown) => {
          if (controller.signal.aborted || disposed) return;
          const refusal = readApiError(error);
          if (refusal.status === 429) {
            // The same text is checked again after the pause, unless a newer one is already waiting.
            if (pending === EMPTY) pending = input;
            pause(refusal.retryAfter);
            return;
          }
          onError?.(error, input);
        }
      )
      .finally(() => {
        if (inFlight === controller) inFlight = null;
        if (due) start();
        settle();
      });
  };

  const pause = (seconds: number | undefined) => {
    const wait = Math.max(1, seconds ?? DEFAULT_PAUSE_SECONDS) * 1000;
    pausedUntil = Date.now() + wait;
    if (pauseTimer) clearTimeout(pauseTimer);
    pauseTimer = setTimeout(() => {
      pauseTimer = null;
      pausedUntil = null;
      if (timer === null) start();
      settle();
    }, wait);
    report({ state: 'paused', until: pausedUntil });
  };

  const abortInFlight = () => {
    inFlight?.abort();
  };

  const cancel = () => {
    pending = EMPTY;
    due = false;
    if (timer) clearTimeout(timer);
    timer = null;
    abortInFlight();
    settle();
  };

  return {
    schedule(input) {
      if (disposed) return;
      pending = input;
      abortInFlight();
      if (timer) clearTimeout(timer);
      if (pausedUntil !== null) {
        timer = null;
        return;
      }
      timer = setTimeout(() => {
        timer = null;
        start();
        settle();
      }, delay);
      report({ state: 'waiting' });
    },
    flush() {
      if (disposed || pending === EMPTY) return;
      if (timer) clearTimeout(timer);
      timer = null;
      start();
      settle();
    },
    cancel,
    dispose() {
      cancel();
      if (pauseTimer) clearTimeout(pauseTimer);
      pauseTimer = null;
      pausedUntil = null;
      disposed = true;
      current = { state: 'idle' };
    },
    status: () => current,
  };
}
