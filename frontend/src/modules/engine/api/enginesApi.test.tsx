import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { fakeGateway, ME } from '../../../test/moduleKit';
import { AuthContext } from '../../auth/hooks/useAuth';
import { HttpError } from '../../core/api/http';
import { useEnginesApi } from './enginesApi';

const REF = {
  namespace: 'alex.rivera',
  name: 'edge-solver',
  version: '0.3.1',
  digest: `sha256-${'e5'.repeat(32)}`,
};
const PINS = 'namespace=alex.rivera&version=0.3.1&digest=sha256-' + 'e5'.repeat(32);

function apiOver(gateway: ReturnType<typeof fakeGateway>) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <AuthContext.Provider
      value={{
        user: ME,
        loading: false,
        signIn: async () => undefined,
        register: async () => undefined,
        signOut: async () => undefined,
        refresh: async () => undefined,
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
  return renderHook(() => useEnginesApi(), { wrapper }).result.current;
}

describe('useEnginesApi', () => {
  it('reads the catalog, and falls back to the public one when the session is refused (401), saying so', async () => {
    let calls = 0;
    const gateway = fakeGateway({
      'GET /v1/engines': () =>
        ++calls === 1
          ? { status: 401, body: { code: 'unauthorized' } }
          : { body: { engines: [{ ...REF, id: 'x', ref: REF, modes: [] }] } },
    });
    const api = apiOver(gateway);
    const answer = await api.getCatalogEngines();
    expect(answer.fellBackToPublic).toBe(true);
    expect(answer.engines).toHaveLength(1);
  });

  it('names a registration by its name in the path and its other pins in the query', async () => {
    const gateway = fakeGateway({
      [`POST /v1/engine-registrations/edge-solver/activate?${PINS}`]: {
        body: { ...REF, status: 'private', active: true },
      },
      [`PUT /v1/engine-registrations/edge-solver/credential?${PINS}`]: ({ body }) => ({
        body: { ...REF, status: 'private', active: false, echoed: body },
      }),
      [`DELETE /v1/engine-registrations/edge-solver?${PINS}`]: { status: 204 },
      'GET /v1/engine-registrations?review=true': { body: { registrations: [] } },
    });
    const api = apiOver(gateway);
    expect((await api.activateEngineRegistration(REF)).active).toBe(true);
    const replaced = (await api.setEngineRegistrationCredential(REF, 'token')) as unknown as {
      echoed: unknown;
    };
    expect(replaced.echoed).toEqual({ secret: 'token' });
    await expect(api.deleteEngineRegistration(REF)).resolves.toBeUndefined();
    await expect(api.listEngineRegistrations({ review: true })).resolves.toEqual([]);
  });

  it('refuses an identity the gateway answered without one of its four pins', async () => {
    const gateway = fakeGateway({
      'GET /v1/engine-registrations': {
        body: { registrations: [{ ...REF, digest: '', status: 'private', active: true }] },
      },
    });
    await expect(apiOver(gateway).listEngineRegistrations()).rejects.toThrow(
      'The gateway response omitted the immutable resource pin digest.'
    );
  });

  it('throws the typed refusal with its code and diagnostics', async () => {
    const gateway = fakeGateway({
      'POST /v1/engines': {
        status: 422,
        body: { code: 'invalid_engine', diagnostics: [{ pointer: '/spec', message: 'bad' }] },
      },
    });
    const refused = await apiOver(gateway)
      .createEngine({} as never)
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(HttpError);
    expect((refused as HttpError).code).toBe('invalid_engine');
    expect((refused as HttpError).diagnostics).toHaveLength(1);
  });

  it('reads the pins of the BIM v1 binding profile, and refuses a profile without them', async () => {
    const profile = {
      id: 'qos-binding/v1',
      output: { apiVersion: 'bim/v1', kind: 'BindingProblem', schemaDigest: 'sha256-a' },
      protocol: 'bim-engine/v1',
      protocolDigest: 'sha256-b',
      digest: 'sha256-c',
    };
    const complete = fakeGateway({ 'GET /v1/engines/protocol': { body: { profiles: [profile] } } });
    expect((await apiOver(complete).getBimProfile()).protocolDigest).toBe('sha256-b');
    const partial = fakeGateway({
      'GET /v1/engines/protocol': { body: { profiles: [{ ...profile, digest: undefined }] } },
    });
    await expect(apiOver(partial).getBimProfile()).rejects.toThrow(
      'The gateway did not publish complete immutable BIM profile pins.'
    );
  });
});
