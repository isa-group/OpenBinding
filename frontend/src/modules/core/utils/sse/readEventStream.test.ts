import { describe, expect, it, vi } from 'vitest';
import { readEventStream, StreamSilenceError, type StreamEvent } from './readEventStream';

/** A response whose body is a stream the test writes to. */
function stream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(given) {
      controller = given;
    },
  });
  const encoder = new TextEncoder();
  return {
    response: new Response(body),
    write: (text: string) => controller.enqueue(encoder.encode(text)),
    end: () => controller.close(),
  };
}

describe('reading a server-sent event stream', () => {
  it('hands over each event with its name, across chunks and CRLF lines, and skips comments', async () => {
    const { response, write, end } = stream();
    const seen: StreamEvent[] = [];
    const done = readEventStream(response, event => seen.push(event));
    write('event: job\ndata: {"status":"run');
    write('ning"}\n\n: keep-alive\n\n');
    write('event: session-ended\r\ndata: {}\r\n\r\ndata: one\ndata: two\n\n');
    end();
    await done;
    expect(seen).toEqual([
      { event: 'job', data: '{"status":"running"}' },
      { event: 'session-ended', data: '{}' },
      { event: 'message', data: 'one\ntwo' },
    ]);
  });

  it('takes a stream silent past its limit for lost, while comments keep it alive', async () => {
    vi.useFakeTimers();
    try {
      const { response, write } = stream();
      const seen: StreamEvent[] = [];
      const done = readEventStream(response, event => seen.push(event), { silenceMs: 45_000 });
      const failed = done.catch((error: unknown) => error);
      for (let i = 0; i < 4; i += 1) {
        await vi.advanceTimersByTimeAsync(15_000);
        write(': keep-alive\n\n');
      }
      expect(seen).toEqual([]);
      await vi.advanceTimersByTimeAsync(46_000);
      expect(await failed).toBeInstanceOf(StreamSilenceError);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ends quietly when aborted', async () => {
    const { response, write } = stream();
    const controller = new AbortController();
    const seen: StreamEvent[] = [];
    const done = readEventStream(response, event => seen.push(event), {
      signal: controller.signal,
    });
    write('event: job\ndata: 1\n\n');
    await new Promise(resolve => setTimeout(resolve, 0));
    controller.abort();
    await expect(done).resolves.toBeUndefined();
    expect(seen).toEqual([{ event: 'job', data: '1' }]);
  });
});
