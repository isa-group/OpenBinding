import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../../api/client';
import { classifyAuthError, marker, readApiError } from './errors';

function answer(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

/** What the real client throws for an answer, so the test covers the folding as well as the reading. */
async function refusal(response: Response): Promise<unknown> {
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(response);
  vi.stubGlobal('fetch', fetchMock);
  try {
    await new ApiClient('https://gateway.example').request('/v1/anything');
  } catch (caught) {
    return caught;
  }
  throw new Error('the request did not fail');
}

describe('readApiError', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.unstubAllGlobals());

  it('reads the flat problem document of a 422, diagnostics included', async () => {
    const error = await refusal(
      answer(
        {
          type: 'https://openbinding.dev/problems/c2y_syntax',
          title: 'c2y_syntax',
          status: 422,
          code: 'c2y_syntax',
          detail: 'The document is not valid YAML.',
          diagnostics: [
            {
              code: 'c2y_syntax',
              message: 'Unexpected end of the document.',
              span: { line: 3, column: 1 },
            },
          ],
        },
        422,
        { 'Content-Type': 'application/problem+json' }
      )
    );
    expect(readApiError(error)).toEqual({
      status: 422,
      code: 'c2y_syntax',
      message: 'The document is not valid YAML.',
      diagnostics: [
        {
          code: 'c2y_syntax',
          message: 'Unexpected end of the document.',
          span: { line: 3, column: 1 },
        },
      ],
    });
  });

  it('reads the platform envelope of the other statuses', async () => {
    const error = await refusal(
      answer(
        {
          detail: { code: 'not_found', error: 'Composition not found.' },
          type: 'about:blank',
          title: 'Not Found',
          status: 404,
          code: 'not_found',
        },
        404
      )
    );
    expect(readApiError(error)).toEqual({
      status: 404,
      code: 'not_found',
      message: 'Composition not found.',
      diagnostics: [],
    });
  });

  it('carries the current ETag of a 412, so the screen can re-read and merge', async () => {
    const error = await refusal(
      answer(
        {
          detail: { code: 'precondition_failed', error: 'The resource changed since it was read.' },
          status: 412,
          code: 'precondition_failed',
        },
        412,
        { ETag: '"rev-7"' }
      )
    );
    expect(readApiError(error)).toMatchObject({
      status: 412,
      code: 'precondition_failed',
      etag: '"rev-7"',
    });
  });

  it('carries the Retry-After of a 429, so the checks pause instead of retrying in a loop', async () => {
    const error = await refusal(
      answer(
        {
          detail: { code: 'composition_busy', error: 'Every composition slot is in use.' },
          status: 429,
          code: 'composition_busy',
        },
        429,
        { 'Retry-After': '1' }
      )
    );
    const read = readApiError(error);
    expect(read).toMatchObject({ status: 429, code: 'composition_busy', retryAfter: 1 });
    expect(read).not.toHaveProperty('etag');
  });

  it('reads a request that never got an answer as a network failure', () => {
    expect(readApiError(new TypeError('Failed to fetch'))).toEqual({
      status: 0,
      code: 'network',
      message: 'Failed to fetch',
      diagnostics: [],
    });
    expect(readApiError('nonsense')).toEqual({
      status: 0,
      code: 'unknown',
      message: '',
      diagnostics: [],
    });
  });
});

describe('classifyAuthError and marker', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('name the kind of a refusal and the status and code a person can quote', async () => {
    const failure = classifyAuthError(
      await refusal(
        answer(
          {
            detail: { code: 'last_owner', error: 'An organization keeps one owner.' },
            status: 409,
            code: 'last_owner',
          },
          409
        )
      )
    );
    expect(failure).toMatchObject({
      kind: 'conflict',
      status: 409,
      code: 'last_owner',
      message: 'An organization keeps one owner.',
    });
    expect(marker(failure)).toBe(' (409 · last_owner)');
    expect(marker(classifyAuthError(new TypeError('offline')))).toBe('');
  });
});
