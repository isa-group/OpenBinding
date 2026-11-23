import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobDetail } from '../api/runsApi';
import { POLL_MS, STREAM_RETRY_MS, useRunLive } from './useRunLive';

const api = vi.hoisted(() => ({ get: vi.fn(), events: vi.fn() }));
vi.mock('../api/runsApi', async actual => ({
  ...(await actual<typeof import('../api/runsApi')>()),
  useRunsApi: () => api,
}));

const detail = (status: string) => ({ id: 'job-1', status }) as unknown as JobDetail;

/** A run's event stream the test writes to; each `events` call opens the next one. */
function streams() {
  const opened: Array<{
    write: (text: string) => void;
    end: () => void;
    signal: AbortSignal;
    cancelled: () => boolean;
  }> = [];
  api.events.mockImplementation(async (_org: string, _job: string, signal: AbortSignal) => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(given) {
        controller = given;
      },
      cancel() {
        cancelled = true;
      },
    });
    const encoder = new TextEncoder();
    opened.push({
      write: text => controller.enqueue(encoder.encode(text)),
      end: () => controller.close(),
      signal,
      cancelled: () => cancelled,
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

  it('reopens a stream that ended after a while without the run finishing, again and again', async () => {
    api.get.mockResolvedValue(detail('running'));
    const opened = streams();
    renderHook(() => useRunLive('isa-demo', 'job-1'));
    await settle();
    for (let n = 1; n <= 3; n += 1) {
      // a quiet quarter of an hour of keep-alives, then the gateway's end
      for (let i = 0; i < 60; i += 1) {
        await act(async () => vi.advanceTimersByTimeAsync(15_000));
        opened[n - 1].write(': keep-alive\n\n');
      }
      opened[n - 1].end();
      await settle();
      expect(opened).toHaveLength(n + 1);
    }
  });

  it('leaves it to the 2 s asking when streams keep ending at once', async () => {
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

  it('says the feed stopped when the session ended, and keeps what it shows', async () => {
    api.get.mockResolvedValue(detail('running'));
    const opened = streams();
    const { result } = renderHook(() => useRunLive('isa-demo', 'job-1'));
    await settle();
    opened[0].write('event: session-ended\ndata: {}\n\n');
    opened[0].end();
    await settle();
    expect(result.current.feed).toBe('paused');
    expect(result.current.detail?.status).toBe('running');
    const before = api.get.mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(STREAM_RETRY_MS * 2));
    expect(api.get.mock.calls.length).toBe(before);
    expect(opened).toHaveLength(1);
  });

  it('falls back to asking every 2 s when the stream fails, and tries the stream again a minute later', async () => {
    api.get.mockResolvedValue(detail('running'));
    api.events.mockResolvedValueOnce(new Response(null, { status: 503 }));
    renderHook(() => useRunLive('isa-demo', 'job-1'));
    await settle();
    const opened = streams();
    await act(async () => vi.advanceTimersByTimeAsync(POLL_MS * 3));
    const asked = api.get.mock.calls.length;
    expect(asked).toBeGreaterThanOrEqual(3);
    await act(async () => vi.advanceTimersByTimeAsync(STREAM_RETRY_MS));
    expect(opened).toHaveLength(1);
    // Back on the stream: the 2 s asking stopped.
    const onStream = api.get.mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(POLL_MS * 5));
    expect(api.get.mock.calls.length).toBe(onStream);
  });

  it('closes a stream it is reading when the page goes away', async () => {
    api.get.mockResolvedValue(detail('running'));
    const opened = streams();
    const { unmount } = renderHook(() => useRunLive('isa-demo', 'job-1'));
    await settle();
    opened[0].write(': keep-alive\n\n');
    await settle();
    expect(opened[0].signal.aborted).toBe(false);
    unmount();
    await settle();
    expect(opened[0].signal.aborted).toBe(true);
    expect(opened[0].cancelled()).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(STREAM_RETRY_MS * 2));
    expect(opened).toHaveLength(1);
  });

  it('closes the stream it is reading on refresh(), so one stream is open at a time', async () => {
    api.get.mockResolvedValue(detail('running'));
    const opened = streams();
    const { result } = renderHook(() => useRunLive('isa-demo', 'job-1'));
    await settle();
    expect(opened).toHaveLength(1);
    act(() => result.current.refresh());
    await settle();
    expect(opened).toHaveLength(2);
    expect(opened[0].signal.aborted).toBe(true);
    expect(opened[0].cancelled()).toBe(true);
    expect(opened[1].signal.aborted).toBe(false);
    const getsBefore = api.get.mock.calls.length;
    opened[1].write('event: job\ndata: {"id":"job-1","status":"running"}\n\n');
    await settle();
    // Only the open stream reads the run again.
    expect(api.get.mock.calls.length).toBe(getsBefore + 1);
  });

  it('treats a stream that does not answer within the silence limit as failed', async () => {
    api.get.mockResolvedValue(detail('running'));
    api.events.mockImplementationOnce(
      (_org: string, _job: string, signal: AbortSignal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        )
    );
    renderHook(() => useRunLive('isa-demo', 'job-1'));
    await settle();
    expect(api.get).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(45_000 + POLL_MS * 2));
    expect(api.get.mock.calls.length).toBeGreaterThanOrEqual(2);
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
