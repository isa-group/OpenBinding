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

  const VALID = {
    valid: true,
    instanceDigest: DIGEST,
    packageDigest: DIGEST,
    fileDigests: { 'candidates.json': DIGEST },
    resourceDigests: {},
    irDigest: DIGEST,
    diagnostics: [],
    analysis: { tasks: 1, candidates: 2, constraints: 0, placement: false, bindingSpace: '2' },
    compatibleModes: [],
  };

  it('checks a package at /v1/bim/validate as a .bim.zip and returns the pinned digests', async () => {
    fetchMock.mockResolvedValueOnce(json(VALID));
    const archive = new Uint8Array([80, 75, 3, 4]);

    const answer = await bimApi.validate(archive);

    const [url, request] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/v1\/bim\/validate$/);
    expect(request?.method).toBe('POST');
    expect(new Headers(request?.headers).get('Content-Type')).toBe('application/vnd.bim+zip');
    expect(request?.body).toBe(archive);
    expect(answer).toEqual(VALID);
  });

  it('asks for the IR and the facts only when told to, once each', async () => {
    fetchMock.mockResolvedValueOnce(json({ ...VALID, ir: { kind: 'BindingProblem' }, sourceMap: {} }));
    const answer = await bimApi.validate(new Uint8Array([1]), { include: ['ir'] });
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/v1\/bim\/validate\?include=ir$/);
    expect(answer.ir).toEqual({ kind: 'BindingProblem' });

    fetchMock.mockResolvedValueOnce(json(VALID));
    await bimApi.validate(new Uint8Array([1]), { include: ['ir', 'facts', 'ir'] });
    expect(String(fetchMock.mock.calls[1][0])).toMatch(/\/v1\/bim\/validate\?include=ir,facts$/);
  });

  it('throws a refusal unless told to accept it', async () => {
    fetchMock.mockResolvedValueOnce(json({ code: 'invalid_instance', status: 422, detail: 'No', diagnostics: [{ code: 'x', message: 'y' }] }, 422, 'application/problem+json'));
    await expect(bimApi.validate(new Uint8Array([1]))).rejects.toMatchObject({ status: 422, code: 'invalid_instance' });
  });

  it('with acceptRefusal, reads a 422 as a result: the package was understood and found invalid', async () => {
    fetchMock.mockResolvedValueOnce(json({
      type: 'https://openbinding.dev/problems/invalid_instance',
      title: 'invalid_instance',
      code: 'invalid_instance',
      status: 422,
      detail: 'candidates.json: candidate 2 has no latency',
      diagnostics: [{ code: 'missing_metric', resource: 'candidateCatalog', pointer: '/spec/candidates/1', message: 'No latency.' }, 'not an object'],
    }, 422, 'application/problem+json'));

    const outcome = await bimApi.validate(new Uint8Array([1]), { include: ['facts'], acceptRefusal: true });

    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/v1\/bim\/validate\?include=facts$/);
    expect(outcome).toEqual({
      valid: false,
      status: 422,
      code: 'invalid_instance',
      message: 'candidates.json: candidate 2 has no latency',
      diagnostics: [{ code: 'missing_metric', resource: 'candidateCatalog', pointer: '/spec/candidates/1', message: 'No latency.' }],
    });
  });

  it('with acceptRefusal, keeps the size limit, the media type and the rate limit as errors', async () => {
    fetchMock.mockResolvedValueOnce(json({ title: 'payload_too_large', detail: 'request body exceeds 16777216 bytes' }, 413, 'application/problem+json'));
    await expect(bimApi.validate(new Uint8Array([1]), { acceptRefusal: true })).rejects.toMatchObject({ status: 413, code: 'payload_too_large' });

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ title: 'rate_limited', detail: 'slow down' }), {
      status: 429, headers: { 'Content-Type': 'application/problem+json', 'Retry-After': '7' },
    }));
    const error = await bimApi.validate(new Uint8Array([1]), { acceptRefusal: true }).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({ status: 429, retryAfter: 7 });
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
