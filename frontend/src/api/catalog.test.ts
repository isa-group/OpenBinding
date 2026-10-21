import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClient, HttpError } from './client';

const DIGEST = `sha256-${'a'.repeat(64)}`;

function json(body: unknown, status = 200, contentType = 'application/json'): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': contentType } });
}

describe('public catalog and validation endpoints', () => {
  const client = new ApiClient('https://gateway.example');
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    localStorage.clear();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  it('validates a package at /v1/instances/validate as a .bim.zip and returns the pinned digests', async () => {
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

    const outcome = await client.validatePackage(archive);

    const [url, request] = fetchMock.mock.calls[0];
    expect(url).toBe('https://gateway.example/v1/instances/validate');
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

    const outcome = await client.validatePackage(new Uint8Array([1]));

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
    await expect(client.validatePackage(new Uint8Array([1]))).rejects.toMatchObject({ status: 413, code: 'payload_too_large' });

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ title: 'rate_limited', detail: 'slow down' }), {
      status: 429, headers: { 'Content-Type': 'application/problem+json', 'Retry-After': '7' },
    }));
    const error = await client.validatePackage(new Uint8Array([1])).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({ status: 429, retryAfter: 7 });
  });

  it('lists the published registered resources and fetches one by all four pins', async () => {
    const resource = { namespace: 'isa-demo', name: 'catalog', version: '2.0.0', digest: DIGEST, role: 'candidateCatalog', apiVersion: 'qos-binding/v1', kind: 'CandidateCatalog', dialect: 'qos-binding/v1', mediaType: 'application/json', status: 'published' };
    fetchMock.mockResolvedValueOnce(json({ resources: [resource] }));
    expect(await client.getRegisteredResources()).toEqual([resource]);
    expect(fetchMock.mock.calls[0][0]).toBe('https://gateway.example/v1/resources');

    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    await client.getRegisteredResourceContent(resource as never);
    const url = new URL(String(fetchMock.mock.calls[1][0]));
    expect(url.pathname).toBe('/v1/resources/catalog');
    expect(Object.fromEntries(url.searchParams)).toEqual({ namespace: 'isa-demo', version: '2.0.0', revision: DIGEST });
  });

  it('lists the engines of the account, and says when it had to fall back to the public list', async () => {
    const engine = { id: 'x', name: 'x', namespace: 'bim.builtin', version: '1.0.0', digest: DIGEST, ref: {}, modes: [] };
    fetchMock.mockResolvedValueOnce(json({ engines: [engine] }));
    expect(await client.getCatalogEngines()).toEqual({ engines: [engine], fellBackToPublic: false });
    expect(fetchMock.mock.calls[0][0]).toBe('https://gateway.example/v1/engines');

    fetchMock.mockResolvedValueOnce(json({ detail: 'Not authenticated' }, 401));
    fetchMock.mockResolvedValueOnce(json({ engines: [engine] }));
    expect(await client.getCatalogEngines()).toEqual({ engines: [engine], fellBackToPublic: true });
    expect(fetchMock.mock.calls[2][0]).toBe('https://gateway.example/v1/explore/engines');
  });

  it('does not hide a refusal other than an expired session', async () => {
    fetchMock.mockResolvedValueOnce(json({ detail: 'forbidden' }, 403));
    await expect(client.getCatalogEngines()).rejects.toMatchObject({ status: 403 });
  });
});
