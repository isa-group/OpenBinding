import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClient } from './client';

const DIGEST = `sha256-${'a'.repeat(64)}`;

function json(body: unknown, status = 200, contentType = 'application/json'): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': contentType } });
}

describe('public catalog endpoints', () => {
  const client = new ApiClient('https://gateway.example');
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    localStorage.clear();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  it('lists the engines of the account, and says when it had to fall back to the public list', async () => {
    const engine = {
      id: 'x',
      name: 'x',
      namespace: 'bim.builtin',
      version: '1.0.0',
      digest: DIGEST,
      ref: {},
      modes: [],
    };
    fetchMock.mockResolvedValueOnce(json({ engines: [engine] }));
    expect(await client.getCatalogEngines()).toEqual({
      engines: [engine],
      fellBackToPublic: false,
    });
    expect(fetchMock.mock.calls[0][0]).toBe('https://gateway.example/v1/engines');

    fetchMock.mockResolvedValueOnce(json({ detail: 'Not authenticated' }, 401));
    fetchMock.mockResolvedValueOnce(json({ engines: [engine] }));
    expect(await client.getCatalogEngines()).toEqual({ engines: [engine], fellBackToPublic: true });
    expect(fetchMock.mock.calls[2][0]).toBe('https://gateway.example/v1/engines');
  });

  it('does not hide a refusal other than an expired session', async () => {
    fetchMock.mockResolvedValueOnce(json({ detail: 'forbidden' }, 403));
    await expect(client.getCatalogEngines()).rejects.toMatchObject({ status: 403 });
  });
});
