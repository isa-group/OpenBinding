import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../api/client';
import { JobWaitTimeout, POLL_MAX_MS, POLL_START_MS, isAbort, pollV1Job } from './pollJob';

const client = vi.hoisted(() => ({ getV1Job: vi.fn() }));
vi.mock('../../api/client', async () => ({ ...await vi.importActual<typeof import('../../api/client')>('../../api/client'), apiClient: client }));

describe('pollV1Job', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    client.getV1Job.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the first finished reading and reports each one on the way', async () => {
    client.getV1Job
      .mockResolvedValueOnce({ id: 'j', status: 'queued' })
      .mockResolvedValueOnce({ id: 'j', status: 'running' })
      .mockResolvedValue({ id: 'j', status: 'completed' });
    const seen: string[] = [];
    const pending = pollV1Job('j', { signal: new AbortController().signal, onStatus: (job) => seen.push(job.status) });

    await vi.advanceTimersByTimeAsync(10_000);
    await expect(pending).resolves.toMatchObject({ status: 'completed' });
    expect(seen).toEqual(['queued', 'running', 'completed']);
  });

  it('waits longer between looks, up to a ceiling', async () => {
    client.getV1Job.mockResolvedValue({ id: 'j', status: 'running' });
    const controller = new AbortController();
    const pending = pollV1Job('j', { signal: controller.signal }).catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(0);
    expect(client.getV1Job).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(POLL_START_MS - 1);
    expect(client.getV1Job).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(client.getV1Job).toHaveBeenCalledTimes(2);
    // The second wait is 750 ms.
    await vi.advanceTimersByTimeAsync(749);
    expect(client.getV1Job).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(client.getV1Job).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(60_000);
    const before = client.getV1Job.mock.calls.length;
    await vi.advanceTimersByTimeAsync(POLL_MAX_MS);
    expect(client.getV1Job.mock.calls.length - before).toBeLessThanOrEqual(2);

    controller.abort();
    expect(isAbort(await pending)).toBe(true);
  });

  it('stops at once when the signal aborts, mid-wait', async () => {
    client.getV1Job.mockResolvedValue({ id: 'j', status: 'running' });
    const controller = new AbortController();
    const pending = pollV1Job('j', { signal: controller.signal }).catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(100);
    controller.abort();
    expect(isAbort(await pending)).toBe(true);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(client.getV1Job).toHaveBeenCalledTimes(1);
  });

  it('gives up with a useful message after the time limit', async () => {
    client.getV1Job.mockResolvedValue({ id: 'job-9', status: 'running' });
    const pending = pollV1Job('job-9', { signal: new AbortController().signal, timeoutMs: 20_000 }).catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(60_000);
    const error = await pending;
    expect(error).toBeInstanceOf(JobWaitTimeout);
    expect((error as Error).message).toContain('still not finished');
    expect((error as Error).message).toContain('job-9');
    const calls = client.getV1Job.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(client.getV1Job).toHaveBeenCalledTimes(calls);
  });

  it('ends with the error of a request that fails', async () => {
    client.getV1Job.mockRejectedValue(new HttpError(503, 'down'));
    await expect(pollV1Job('j', { signal: new AbortController().signal })).rejects.toMatchObject({ status: 503 });
  });
});
