import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bimApi } from './bim';
import { HttpError } from './client';

const DIGEST = `sha256-${'a'.repeat(64)}`;

function json(body: unknown, status = 200, contentType = 'application/json'): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': contentType } });
}

describe('the stateless BIM services', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    localStorage.clear();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  it('checks a package at /v1/bim/validate as a .bim.zip and returns the pinned digests', async () => {
    fetchMock.mockResolvedValueOnce(json({
      valid: true,
      instanceDigest: DIGEST,
      packageDigest: DIGEST,
      fileDigests: { 'candidates.json': DIGEST },
      resourceDigests: {},
      irDigest: DIGEST,
      diagnostics: [],
    }));
    const archive = new Uint8Array([80, 75, 3, 4]);

    const outcome = await bimApi.check(archive);

    const [url, request] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/v1\/bim\/validate$/);
    expect(request?.method).toBe('POST');
    expect(new Headers(request?.headers).get('Content-Type')).toBe('application/vnd.bim+zip');
    expect(request?.body).toBe(archive);
    expect(outcome).toEqual({
      valid: true,
      result: {
        valid: true, instanceDigest: DIGEST, packageDigest: DIGEST, fileDigests: { 'candidates.json': DIGEST }, resourceDigests: {}, irDigest: DIGEST, diagnostics: [],
      },
    });
  });

  it('reads a 422 as a result: the package was understood and found invalid', async () => {
    fetchMock.mockResolvedValueOnce(json({
      type: 'https://openbinding.dev/problems/invalid_request',
      title: 'invalid_request',
      status: 422,
      detail: 'candidates.json: candidate 2 has no latency',
      diagnostics: [{ resource: 'candidateCatalog', pointer: '/spec/candidates/1', message: 'No latency.' }, 'not an object'],
    }, 422, 'application/problem+json'));

    const outcome = await bimApi.check(new Uint8Array([1]));

    expect(outcome).toEqual({
      valid: false,
      refusal: {
        status: 422,
        code: 'invalid_request',
        message: 'candidates.json: candidate 2 has no latency',
        diagnostics: [{ resource: 'candidateCatalog', pointer: '/spec/candidates/1', message: 'No latency.' }],
      },
    });
  });

  it('keeps the size limit, the media type and the rate limit as errors', async () => {
    fetchMock.mockResolvedValueOnce(json({ title: 'payload_too_large', detail: 'request body exceeds 16777216 bytes' }, 413, 'application/problem+json'));
    await expect(bimApi.check(new Uint8Array([1]))).rejects.toMatchObject({ status: 413, code: 'payload_too_large' });

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ title: 'rate_limited', detail: 'slow down' }), {
      status: 429, headers: { 'Content-Type': 'application/problem+json', 'Retry-After': '7' },
    }));
    const error = await bimApi.check(new Uint8Array([1])).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({ status: 429, retryAfter: 7 });
  });

  it('validates and throws on a refusal, and asks for the IR only when told to', async () => {
    fetchMock.mockResolvedValueOnce(json({ valid: true, irDigest: DIGEST, ir: { kind: 'BindingProblem' }, sourceMap: {} }));
    const answer = await bimApi.validate(new Uint8Array([1]), { include: 'ir' });
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/v1\/bim\/validate\?include=ir$/);
    expect(answer.ir).toEqual({ kind: 'BindingProblem' });

    fetchMock.mockResolvedValueOnce(json({ code: 'invalid_instance', status: 422, detail: 'No', diagnostics: [{ code: 'x', message: 'y' }] }, 422, 'application/problem+json'));
    await expect(bimApi.validate(new Uint8Array([1]))).rejects.toMatchObject({ status: 422 });
    expect(String(fetchMock.mock.calls[1][0])).toMatch(/\/v1\/bim\/validate$/);
  });

  it('lists the templates and serves one as bytes', async () => {
    fetchMock.mockResolvedValueOnce(json({ templates: ['demo/01_simple_seq'] }));
    expect(await bimApi.templates()).toEqual(['demo/01_simple_seq']);
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/v1\/bim\/templates$/);

    fetchMock.mockResolvedValueOnce(new Response(new Uint8Array([80, 75]), { status: 200, headers: { 'Content-Type': 'application/vnd.bim+zip' } }));
    const bytes = await bimApi.template('demo/01 simple');
    expect(String(fetchMock.mock.calls[1][0])).toMatch(/\/v1\/bim\/templates\/demo\/01%20simple$/);
    expect(new Uint8Array(bytes)).toEqual(new Uint8Array([80, 75]));
  });
});
