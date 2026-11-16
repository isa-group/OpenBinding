import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../../api/client';
import {
  createScheduler,
  DEFAULT_PAUSE_SECONDS,
  pausedMessage,
  type SchedulerStatus,
} from './lintScheduler';

/** A check the test answers by hand, recording every call and its signal. */
function manualRun() {
  const calls: Array<{
    input: string;
    signal: AbortSignal;
    resolve: (value: string) => void;
    reject: (error: unknown) => void;
  }> = [];
  const run = vi.fn(
    (input: string, signal: AbortSignal) =>
      new Promise<string>((resolve, reject) => {
        calls.push({ input, signal, resolve, reject });
      })
  );
  return { run, calls };
}

function busy(retryAfter?: number): HttpError {
  const error = new HttpError(429, 'Too Many Requests');
  error.code = 'rate_limited';
  if (retryAfter !== undefined) error.retryAfter = retryAfter;
  return error;
}

/** Lets settled promises run their callbacks. */
const drain = () => vi.advanceTimersByTimeAsync(0);

describe('createScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-15T10:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('checks once, with the latest input, after the delay of stillness', async () => {
    const { run, calls } = manualRun();
    const onResult = vi.fn();
    const scheduler = createScheduler({ delay: 600, run, onResult });

    scheduler.schedule('a');
    await vi.advanceTimersByTimeAsync(400);
    scheduler.schedule('ab');
    await vi.advanceTimersByTimeAsync(400);
    scheduler.schedule('abc');
    await vi.advanceTimersByTimeAsync(599);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(calls[0].input).toBe('abc');

    calls[0].resolve('checked abc');
    await drain();
    expect(onResult).toHaveBeenCalledWith('checked abc', 'abc');
    expect(scheduler.status()).toEqual({ state: 'idle' });
  });

  it('aborts the check in flight when the input moves on, and drops its answer', async () => {
    const { run, calls } = manualRun();
    const onResult = vi.fn();
    const scheduler = createScheduler({ delay: 600, run, onResult });

    scheduler.schedule('a');
    await vi.advanceTimersByTimeAsync(600);
    expect(calls[0].signal.aborted).toBe(false);

    scheduler.schedule('ab');
    expect(calls[0].signal.aborted).toBe(true);
    calls[0].resolve('checked a');
    await drain();
    expect(onResult).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(600);
    calls[1].resolve('checked ab');
    await drain();
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledWith('checked ab', 'ab');
  });

  it('never runs two checks at once: the next waits for the aborted one to settle', async () => {
    const { run, calls } = manualRun();
    const scheduler = createScheduler({ delay: 600, run, onResult: vi.fn() });

    scheduler.schedule('a');
    await vi.advanceTimersByTimeAsync(600);
    scheduler.schedule('ab');
    // The aborted request has not answered yet (a slow server): the delay passes, but nothing new starts.
    await vi.advanceTimersByTimeAsync(5000);
    expect(run).toHaveBeenCalledTimes(1);

    calls[0].reject(new DOMException('aborted', 'AbortError'));
    await drain();
    expect(run).toHaveBeenCalledTimes(2);
    expect(calls[1].input).toBe('ab');
  });

  it('pauses for the Retry-After of a 429, says so, and then checks the latest input once', async () => {
    const { run, calls } = manualRun();
    const statuses: SchedulerStatus[] = [];
    const onError = vi.fn();
    const scheduler = createScheduler({
      delay: 600,
      run,
      onResult: vi.fn(),
      onError,
      onStatus: status => statuses.push(status),
    });

    scheduler.schedule('a');
    await vi.advanceTimersByTimeAsync(600);
    calls[0].reject(busy(3));
    await drain();

    const until = Date.now() + 3000;
    expect(scheduler.status()).toEqual({ state: 'paused', until });
    expect(pausedMessage(until)).toBe('Checks paused, resuming in 3 s');
    expect(onError).not.toHaveBeenCalled();

    // Typing during the pause starts nothing, however long the delay.
    scheduler.schedule('ab');
    scheduler.flush();
    await vi.advanceTimersByTimeAsync(2999);
    expect(run).toHaveBeenCalledTimes(1);
    expect(pausedMessage(until)).toBe('Checks paused, resuming in 1 s');

    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(2);
    expect(calls[1].input).toBe('ab');
    expect(statuses.map(status => status.state)).toEqual([
      'waiting',
      'running',
      'paused',
      'running',
    ]);
  });

  it('checks the same input again after a pause when nothing newer came, and waits the default without Retry-After', async () => {
    const { run, calls } = manualRun();
    const scheduler = createScheduler({ delay: 600, run, onResult: vi.fn() });

    scheduler.schedule('a');
    await vi.advanceTimersByTimeAsync(600);
    calls[0].reject(busy());
    await drain();
    await vi.advanceTimersByTimeAsync(DEFAULT_PAUSE_SECONDS * 1000 - 1);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(2);
    expect(calls[1].input).toBe('a');
  });

  it('reports any other refusal and does not retry it', async () => {
    const { run, calls } = manualRun();
    const onError = vi.fn();
    const scheduler = createScheduler({ delay: 600, run, onResult: vi.fn(), onError });

    scheduler.schedule('a');
    await vi.advanceTimersByTimeAsync(600);
    const refusal = new HttpError(503, 'Service Unavailable');
    calls[0].reject(refusal);
    await drain();
    expect(onError).toHaveBeenCalledWith(refusal, 'a');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run).toHaveBeenCalledTimes(1);
    expect(scheduler.status()).toEqual({ state: 'idle' });
  });

  it('checks at once on flush, and forgets everything on cancel and dispose', async () => {
    const { run, calls } = manualRun();
    const onResult = vi.fn();
    const scheduler = createScheduler({ delay: 600, run, onResult });

    scheduler.schedule('a');
    scheduler.flush();
    expect(run).toHaveBeenCalledTimes(1);

    scheduler.cancel();
    expect(calls[0].signal.aborted).toBe(true);
    scheduler.schedule('ab');
    scheduler.dispose();
    await vi.advanceTimersByTimeAsync(600);
    expect(run).toHaveBeenCalledTimes(1);
    calls[0].resolve('late');
    await drain();
    expect(onResult).not.toHaveBeenCalled();
  });
});
