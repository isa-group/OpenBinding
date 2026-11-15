import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runPath, runsApi, runsPath } from './runs';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('the runs of an organization', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    localStorage.clear();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  it('lives under the organization', () => {
    expect(runsPath('acme lab')).toBe('/v1/organizations/acme%20lab/runs');
    expect(runPath('acme', 'r/1')).toBe('/v1/organizations/acme/runs/r%2F1');
    expect(runsApi.events('acme', 'r1')).toBe('/v1/organizations/acme/runs/r1/events');
  });

  it('lists with the filters it is given and leaves the empty ones out', async () => {
    fetchMock.mockResolvedValueOnce(json({ runs: [], total: 0 }));

    await runsApi.list('acme', { revision: 'rev-1', engine: '', limit: 5 });

    const url = new URL(String(fetchMock.mock.calls[0][0]), 'https://gateway.example');
    expect(url.pathname).toMatch(/\/v1\/organizations\/acme\/runs$/);
    expect(Object.fromEntries(url.searchParams)).toEqual({ revision: 'rev-1', limit: '5' });
  });

  it('creates a run with its one-time key, and cancels, retries and re-evaluates one of the organization', async () => {
    fetchMock.mockImplementation(async () => json({ id: 'r1', status: 'queued' }, 202));
    const request = { revision: 'rev-1', engine: { namespace: 'n', name: 'e', version: '1', digest: 'd' }, mode: 'seeded', options: {} };

    await runsApi.create('acme', request, 'key-1');
    await runsApi.cancel('acme', 'r1');
    await runsApi.retry('acme', 'r1');
    await runsApi.reevaluate('acme', 'r1');

    const calls = fetchMock.mock.calls.map(([url, init]) => [new URL(String(url), 'https://gateway.example').pathname, init?.method]);
    expect(calls.map(([path]) => String(path).replace(/^.*\/v1\//, '/v1/'))).toEqual([
      '/v1/organizations/acme/runs',
      '/v1/organizations/acme/runs/r1/cancel',
      '/v1/organizations/acme/runs/r1/retry',
      '/v1/organizations/acme/runs/r1/reevaluate',
    ]);
    expect(calls.every(([, method]) => method === 'POST')).toBe(true);
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get('Idempotency-Key')).toBe('key-1');
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual(request);
  });

  it('propagates caller cancellation of a neighbourhood to the actual fetch', async () => {
    const caller = new AbortController();
    fetchMock.mockImplementation((_url, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }));
    const pending = runsApi.neighborhood('acme', 'job', 0, '', 64, caller.signal);
    caller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/v1\/organizations\/acme\/runs\/job\/neighborhood\?solution_index=0&limit=64$/);
  });

  it('does not mistake a validation problem for neighbourhood evidence', async () => {
    fetchMock.mockResolvedValueOnce(json({ detail: 'Selected task is invalid' }, 422));
    await expect(runsApi.neighborhood('acme', 'job', 0, 'unknown', 64)).rejects.toThrow('Selected task is invalid');
  });
});
