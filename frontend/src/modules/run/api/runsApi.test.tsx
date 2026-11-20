import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { AuthContext } from '../../auth/hooks/useAuth';
import { HttpError } from '../../core/api/http';
import { fakeGateway, type Answer } from '../../../test/moduleKit';
import { runRoute, runsRoute, useRunsApi } from './runsApi';

function hook(routes: Record<string, Answer>) {
  const gateway = fakeGateway(routes);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <AuthContext.Provider
      value={{
        user: null,
        loading: false,
        signIn: vi.fn(),
        register: vi.fn(),
        signOut: vi.fn(),
        refresh: vi.fn(),
        resume: vi.fn(),
        isAdmin: false,
        fetchWithInterceptor: gateway as unknown as (
          path: string,
          init?: RequestInit
        ) => Promise<Response>,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
  const { result } = renderHook(() => useRunsApi(), { wrapper });
  return { api: result.current, gateway };
}

describe('the runs API of the run module', () => {
  it('names the routes of the organization’s runs', () => {
    expect(runsRoute('acme lab')).toBe('/v1/organizations/acme%20lab/runs');
    expect(runRoute('acme', 'r/1')).toBe('/v1/organizations/acme/runs/r%2F1');
  });

  it('lists a page with the gateway’s filters, leaving out the empty ones', async () => {
    const { api, gateway } = hook({
      'GET /v1/organizations/acme/runs': { body: { runs: [], total: 0 } },
    });
    await expect(
      api.list('acme', { state: 'running', problem: '', engine: 'minizinc', limit: 10, offset: 20 })
    ).resolves.toEqual({ runs: [], total: 0 });
    expect(gateway.mock.calls[0][0]).toBe(
      '/v1/organizations/acme/runs?state=running&engine=minizinc&limit=10&offset=20'
    );
  });

  it('sends a launch with its one-time key, and throws a refusal as the typed error', async () => {
    const { api, gateway } = hook({
      'POST /v1/organizations/acme/runs': ({ body }) =>
        (body as { preset?: string }).preset === 'gone'
          ? { status: 422, body: { detail: { code: 'preset_not_found', error: 'No preset.' } } }
          : { status: 202, body: { id: 'job-1', status: 'queued' } },
    });
    await expect(
      api.create('acme', { revision: 'rev-1', preset: 'fast' }, 'key-1')
    ).resolves.toEqual({ id: 'job-1', status: 'queued' });
    const [, init] = gateway.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('Idempotency-Key')).toBe('key-1');

    const refused = await api
      .create('acme', { revision: 'rev-1', preset: 'gone' }, 'key-2')
      .catch((caught: unknown) => caught);
    expect(refused).toBeInstanceOf(HttpError);
    expect(refused).toMatchObject({ status: 422, code: 'preset_not_found' });
  });

  it('cancels and retries with a POST, and lists the filter choices', async () => {
    const { api, gateway } = hook({
      'POST /v1/organizations/acme/runs/r1/cancel': { body: { id: 'r1', status: 'cancelled' } },
      'POST /v1/organizations/acme/runs/r1/retry': { body: { id: 'r2', status: 'queued' } },
      'GET /v1/organizations/acme/problems': {
        body: { problems: [{ slug: 'routing', name: 'Routing' }] },
      },
      'GET /v1/engines': { body: { engines: [{ name: 'b' }, { name: 'a' }, { name: 'b' }] } },
    });
    await expect(api.cancel('acme', 'r1')).resolves.toMatchObject({ status: 'cancelled' });
    await expect(api.retry('acme', 'r1')).resolves.toMatchObject({ id: 'r2' });
    await expect(api.problemOptions('acme')).resolves.toEqual([
      { value: 'routing', label: 'Routing' },
    ]);
    await expect(api.engineOptions()).resolves.toEqual([
      { value: 'a', label: 'a' },
      { value: 'b', label: 'b' },
    ]);
    expect(gateway.mock.calls.map(([path]) => path)).toContain(
      '/v1/organizations/acme/problems?limit=200'
    );
  });

  it('asks for the single swaps of one solution and refuses an answer that is not an evaluation', async () => {
    const { api, gateway } = hook({
      'GET /v1/organizations/acme/runs/r1/neighborhood': { body: { title: 'Busy' } },
    });
    await expect(api.neighborhood('acme', 'r1', 0, '', 128)).rejects.toThrow('Busy');
    expect(gateway.mock.calls[0][0]).toBe(
      '/v1/organizations/acme/runs/r1/neighborhood?solution_index=0&limit=128'
    );
  });
});
