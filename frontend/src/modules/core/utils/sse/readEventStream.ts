// Adapted from SPHERE frontend/src/modules/orbit/api/orbitApi.ts `readEventStream` (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: a core utility any module reads a server-sent event stream with (a run's events now, F7's confirmation stream
// later), over a `fetch` response, so the request carries the session's `Authorization` header (an `EventSource` cannot):
// each event keeps its name (`event:`) beside its data, lines may end in CRLF, comment lines (`: keep-alive`) are read but
// handed to nobody, the silence limit is a parameter (45 s by default, SPHERE's), an abort signal ends the read quietly, and
// a malformed event is still handed over as text (the caller decides; SPHERE skipped what was not JSON).

/** One server-sent event: its name (`message` when the stream names none) and its data, lines joined by `\n`. */
export interface StreamEvent {
  event: string;
  data: string;
}

/** How long a stream may stay silent (not a byte, comments included) before it is taken for lost: SPHERE's 45 s. */
export const STREAM_SILENCE_LIMIT_MS = 45_000;

/** The stream said nothing for longer than its silence limit. */
export class StreamSilenceError extends Error {
  constructor() {
    super('The stream stopped answering.');
    this.name = 'StreamSilenceError';
  }
}

/** One block of lines (what lies between two blank lines) as an event, or null for a block of comments only. */
function parseBlock(block: string): StreamEvent | null {
  let event = 'message';
  const data: string[] = [];
  for (const line of block.split('\n')) {
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  return data.length > 0 ? { event, data: data.join('\n') } : null;
}

/**
 * Reads the server-sent events of `response` until the stream ends, handing each to `onEvent` in order. Rejects with
 * `StreamSilenceError` when nothing arrives for `silenceMs`; returns quietly when `signal` aborts.
 */
export async function readEventStream(
  response: Response,
  onEvent: (event: StreamEvent) => void,
  { silenceMs = STREAM_SILENCE_LIMIT_MS, signal }: { silenceMs?: number; signal?: AbortSignal } = {}
): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buffer = '';
  const stop = () => void reader.cancel().catch(() => undefined);
  if (signal?.aborted) {
    stop();
    return;
  }
  signal?.addEventListener('abort', stop, { once: true });
  try {
    for (;;) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const silence = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new StreamSilenceError()), silenceMs);
      });
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await Promise.race([reader.read(), silence]);
      } catch (error) {
        stop();
        if (signal?.aborted) return;
        throw error;
      } finally {
        clearTimeout(timer);
      }
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true }).replace(/\r\n?/g, '\n');
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const parsed = parseBlock(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
        if (parsed) onEvent(parsed);
        boundary = buffer.indexOf('\n\n');
      }
    }
  } finally {
    signal?.removeEventListener('abort', stop);
  }
}
