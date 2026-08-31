import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClient } from './client';
import type {
  BimResourceRef,
  EngineManifest,
  EngineRegistrationManifest,
} from './client';

const DIGEST = `sha256-${'a'.repeat(64)}`;
const REF: BimResourceRef = {
  namespace: 'research.team',
  name: 'solver-deployment',
  version: '2.1.0',
  digest: DIGEST,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('BIM v1 Engine API client', () => {
  const client = new ApiClient('https://gateway.example');
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    localStorage.clear();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  it('publishes the Engine resource itself, without a compatibility wrapper', async () => {
    const manifest: EngineManifest = {
      apiVersion: 'bim/v1',
      kind: 'Engine',
      metadata: { namespace: 'research.team', name: 'solver', version: '1.0.0' },
      spec: { modes: [] },
    };
    fetchMock.mockResolvedValueOnce(jsonResponse({
      namespace: 'research.team',
      name: 'solver',
      version: '1.0.0',
      digest: DIGEST,
      status: 'private',
    }, 201));

    await client.createEngine(manifest);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, request] = fetchMock.mock.calls[0];
    expect(url).toBe('https://gateway.example/v1/engines');
    expect(request?.method).toBe('POST');
    expect(JSON.parse(String(request?.body))).toEqual(manifest);
  });

  it('refuses to invent a missing immutable pin in a publication response', async () => {
    const manifest: EngineManifest = {
      apiVersion: 'bim/v1',
      kind: 'Engine',
      metadata: { namespace: 'research.team', name: 'solver', version: '1.0.0' },
      spec: { modes: [] },
    };
    fetchMock.mockResolvedValueOnce(jsonResponse({
      name: 'solver',
      version: '1.0.0',
      digest: DIGEST,
      status: 'published',
    }, 201));

    await expect(client.createEngine(manifest)).rejects.toThrow(
      'The gateway response omitted the immutable resource pin namespace.',
    );
  });

  it('creates a real EngineRegistration pinned to an immutable Engine revision', async () => {
    const manifest: EngineRegistrationManifest = {
      apiVersion: 'bim/v1',
      kind: 'EngineRegistration',
      metadata: { namespace: 'research.team', name: 'solver-deployment', version: '2.1.0' },
      spec: {
        engine: REF,
        endpoint: 'https://solver.example',
        protocol: { id: 'bim-engine/v1', mediaType: 'application/json', digest: DIGEST },
        mappings: { request: '/solve', health: '/health', openapi: '/openapi.json' },
        auth: { scheme: 'none' },
        openapi: {
          openapi: '3.1.0',
          'x-bim-protocol': 'bim-engine/v1',
          'x-bim-protocol-digest': DIGEST,
          paths: {},
        },
      },
    };
    fetchMock.mockResolvedValueOnce(jsonResponse({ ...REF, status: 'private', active: false }, 201));

    await client.createEngineRegistration(manifest);

    const [url, request] = fetchMock.mock.calls[0];
    expect(url).toBe('https://gateway.example/v1/engine-registrations');
    expect(JSON.parse(String(request?.body))).toEqual(manifest);
  });

  it.each([
    ['read', (api: ApiClient) => api.getEngineRegistration(REF), ''],
    ['report', (api: ApiClient) => api.getEngineRegistrationReport(REF), '/report'],
    ['approve', (api: ApiClient) => api.adminApproveEngineRegistration(REF), '/approve'],
    ['reject', (api: ApiClient) => api.adminRejectEngineRegistration(REF), '/reject'],
    ['activate', (api: ApiClient) => api.activateEngineRegistration(REF), '/activate'],
    ['deactivate', (api: ApiClient) => api.deactivateEngineRegistration(REF), '/deactivate'],
    ['publication request', (api: ApiClient) => api.requestEngineRegistrationPublication(REF), '/publication-request'],
    ['credential', (api: ApiClient) => api.setEngineRegistrationCredential(REF, 'secret'), '/credential'],
  ])('pins namespace, version, and digest when it performs the %s operation', async (_label, operation, suffix) => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ...REF, status: 'private', active: true }));

    await operation(client);

    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.pathname).toBe(`/v1/engine-registrations/solver-deployment${suffix}`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      namespace: REF.namespace,
      version: REF.version,
      digest: REF.digest,
    });
  });

  it('uses the server-side moderation queue instead of listing private registrations', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ registrations: [] }));

    await client.adminListEngineRegistrations();

    expect(fetchMock.mock.calls[0][0]).toBe('https://gateway.example/v1/engine-registrations?review=true');
  });

  it('addresses each BIM schema by its actual public kind', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ $id: 'instance' }))
      .mockResolvedValueOnce(jsonResponse({ $id: 'registration' }));

    await client.getBimSchema('Instance');
    await client.getBimSchema('EngineRegistration');

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://gateway.example/v1/schemas/Instance',
      'https://gateway.example/v1/schemas/EngineRegistration',
    ]);
  });
});
