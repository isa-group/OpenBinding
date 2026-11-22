import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobDetail } from '../api/runsApi';
import { POLL_MS, useRunLive } from './useRunLive';

const api = vi.hoisted(() => ({ get: vi.fn(), events: vi.fn() }));
vi.mock('../api/runsApi', async actual => ({
  ...(await actual<typeof import('../api/runsApi')>()),
  useRunsApi: () => api,
}));

const detail = (status: string) => ({ id: 'job-1', status }) as unknown as JobDetail;

/** A run's event stream the test writes to; each `events` call opens the next one. */
function streams() {
  const opened: Array<{ write: (text: string) => void; end: () => void }> = [];
  api.events.mockImplementation(async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(given) {
        controller = given;
      },
    });
    const encoder = new TextEncoder();
    opened.push({
      write: text => controller.enqueue(encoder.encode(text)),
      end: () => controller.close(),
    });
    return new Response(body, { status: 200 });
  });
  return opened;
}

const settle = () => act(async () => vi.advanceTimersByTimeAsync(0));

describe('following a run over its event stream', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });
  afterEach(() => vi.useRealTimers());

  it('stays on a quiet stream that sends only keep-alive comments, and asks nothing every 2 s', async () => {
    api.get.mockResolvedValue(detail('running'));
    const opened = streams();
    const { result } = renderHook(() => useRunLive('isa-demo', 'job-1'));
    await settle();
    expect(result.current.detail?.status).toBe('running');
    expect(opened).toHaveLength(1);
    for (let i = 0; i < 4; i += 1) {
      await act(async () => vi.advanceTimersByTimeAsync(15_000));
      opened[0].write(': keep-alive\n\n');
    }
    await settle();
    // 60 s on the stream: one reading only, the first, and no polling.
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(result.current.feed).toBe('live');
  });

  it('reads the run again once for each job event, and stops when it finishes', async () => {
    api.get.mockResolvedValueOnce(detail('queued'));
    const opened = streams();
    const { result } = renderHook(() => useRunLive('isa-demo', 'job-1'));
    await settle();
    api.get.mockResolvedValue(detail('running'));
    opened[0].write('event: job\ndata: {"id":"job-1","status":"running"}\n\n');
    await settle();
    expect(api.get).toHaveBeenCalledTimes(2);
    expect(result.current.detail?.status).toBe('running');
    api.get.mockResolvedValue(detail('completed'));
    opened[0].write('event: job\ndata: {"id":"job-1","status":"completed"}\n\n');
    opened[0].end();
    await settle();
    expect(result.current.feed).toBe('finished');
    await act(async () => vi.advanceTimersByTimeAsync(POLL_MS * 5));
    expect(opened).toHaveLength(1);
  });

  it('reopens a stream that ended before the run did, once, then asks every 2 s', async () => {
    api.get.mockResolvedValue(detail('running'));
    const opened = streams();
    renderHook(() => useRunLive('isa-demo', 'job-1'));
    await settle();
    opened[0].end();
    await settle();
    expect(opened).toHaveLength(2);
    opened[1].end();
    await settle();
    expect(opened).toHaveLength(2);
    const before = api.get.mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(POLL_MS * 3));
    expect(api.get.mock.calls.length).toBeGreaterThan(before + 1);
  });

  it('asks every 2 s when the stream cannot be opened', async () => {
    api.get.mockResolvedValue(detail('running'));
    api.events.mockResolvedValue(new Response(null, { status: 503 }));
    renderHook(() => useRunLive('isa-demo', 'job-1'));
    await settle();
    const before = api.get.mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(POLL_MS * 2 + 10));
    expect(api.get.mock.calls.length).toBeGreaterThanOrEqual(before + 2);
  });
});
