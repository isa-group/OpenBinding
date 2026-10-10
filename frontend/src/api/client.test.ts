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

  it('executes an exact library configuration without inline settings', async () => {
    const configuration = { namespace: 'lab', name: 'search', version: '2', versionDigest: DIGEST };
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 'job', status: 'queued', irDigest: DIGEST }, 202));
    await client.createConfiguredBimJob('snapshot', configuration);
    const [url, request] = fetchMock.mock.calls[0];
    expect(url).toBe('https://gateway.example/v1/jobs');
    expect(JSON.parse(String(request?.body))).toEqual({ snapshot: 'snapshot', configuration });
    expect(new Headers(request?.headers).get('Idempotency-Key')).toBeTruthy();
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

  it('throws a refused Engine (422) with the gateway’s code and the places it points at, not a missing-pin message', async () => {
    const manifest: EngineManifest = {
      apiVersion: 'bim/v1',
      kind: 'Engine',
      metadata: { namespace: 'research.team', name: 'solver', version: '1.0.0' },
      spec: { modes: [] },
    };
    fetchMock.mockResolvedValueOnce(jsonResponse({
      type: 'https://openbinding.dev/problems/invalid_engine',
      title: 'invalid_engine',
      status: 422,
      detail: 'Engine manifest does not satisfy bim/v1',
      diagnostics: [{ code: 'capability_dimension_missing', pointer: '/spec/modes/0/capabilities', message: 'mode must explicitly select capability dimension \'featureValues\'' }],
    }, 422));

    await expect(client.createEngine(manifest)).rejects.toMatchObject({
      status: 422,
      code: 'invalid_engine',
      diagnostics: [expect.objectContaining({ pointer: '/spec/modes/0/capabilities' })],
    });
  });

  it('throws a refused credential (422) and a refused registration (422) the same way', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ title: 'invalid_credential', status: 422, detail: 'credential payload requires a non-empty secret' }, 422));
    await expect(client.setEngineRegistrationCredential(REF, '')).rejects.toMatchObject({ status: 422, code: 'invalid_credential' });

    fetchMock.mockResolvedValue(jsonResponse({ title: 'secret_in_document', status: 422, detail: 'credentials must be supplied through the secret store' }, 422));
    await expect(client.createEngineRegistration({
      apiVersion: 'bim/v1',
      kind: 'EngineRegistration',
      metadata: { namespace: 'research.team', name: 'solver-deployment', version: '2.1.0' },
      spec: {
        engine: REF,
        endpoint: 'https://solver.example',
        protocol: { id: 'bim-engine/v1', mediaType: 'application/json', digest: DIGEST },
        mappings: { request: '/solve', health: '/health', openapi: '/openapi.json' },
        auth: { scheme: 'none' },
        openapi: {},
      },
    })).rejects.toMatchObject({ status: 422, code: 'secret_in_document' });
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
  it('propagates caller cancellation to the actual fetch', async () => {
    const caller = new AbortController();
    fetchMock.mockImplementation((_url, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }));
    const pending = client.getBindingNeighborhood('job', 0, '', 64, caller.signal);
    caller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it('does not mistake a validation problem for neighborhood evidence', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ detail: 'Selected task is invalid' }, 422));
    await expect(client.getBindingNeighborhood('job', 0, 'unknown', 64)).rejects.toThrow('Selected task is invalid');
  });
});

describe('a 422 is an error unless the caller asks for its body', () => {
  const client = new ApiClient('https://gateway.example');
  const fetchMock = vi.fn<typeof fetch>();
  const refusal = () => jsonResponse({ title: 'validation_error', status: 422, detail: 'refused', diagnostics: [{ message: 'where' }] }, 422);

  beforeEach(() => {
    localStorage.clear();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  it.each([
    ['deleteEngineRegistration', (api: ApiClient) => api.deleteEngineRegistration(REF)],
    ['unlinkOwnIdentity', (api: ApiClient) => api.unlinkOwnIdentity('identity')],
    ['revokeApiKey', (api: ApiClient) => api.revokeApiKey('key')],
    ['rotateApiKey', (api: ApiClient) => api.rotateApiKey('key')],
    ['createBimJob', (api: ApiClient) => api.createBimJob('snapshot', REF, REF, 'mode')],
    ['createConfiguredBimJob', (api: ApiClient) => api.createConfiguredBimJob('snapshot', { namespace: 'lab', name: 'search', version: '2', versionDigest: DIGEST })],
    ['createAutoRouterBimJob', (api: ApiClient) => api.createAutoRouterBimJob('snapshot')],
    ['createCasLinkIntent', (api: ApiClient) => api.createCasLinkIntent()],
    ['adminRevokeApiKey', (api: ApiClient) => api.adminRevokeApiKey('user', 'key')],
    ['adminResyncUsage', (api: ApiClient) => api.adminResyncUsage('user')],
    ['adminRecalibrateEngineRouting', (api: ApiClient) => api.adminRecalibrateEngineRouting()],
    ['activateEngineRegistration', (api: ApiClient) => api.activateEngineRegistration(REF)],
    ['deactivateEngineRegistration', (api: ApiClient) => api.deactivateEngineRegistration(REF)],
    ['requestEngineRegistrationPublication', (api: ApiClient) => api.requestEngineRegistrationPublication(REF)],
    ['adminApproveEngineRegistration', (api: ApiClient) => api.adminApproveEngineRegistration(REF)],
    ['adminRejectEngineRegistration', (api: ApiClient) => api.adminRejectEngineRegistration(REF)],
  ])('%s throws an HttpError with the gateway’s code and diagnostics', async (_name, call) => {
    fetchMock.mockResolvedValueOnce(refusal());
    await expect(call(client)).rejects.toMatchObject({ status: 422, code: 'validation_error', diagnostics: [{ message: 'where' }] });
  });

  it('hands the body of a 422 back only where the caller says so', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ detail: 'not a result' }, 422));
    await expect(client.request('/v1/anything', {}, undefined, true, false)).resolves.toEqual({ detail: 'not a result' });
    fetchMock.mockResolvedValueOnce(jsonResponse({ detail: 'not a result' }, 422));
    await expect(client.request('/v1/anything')).rejects.toMatchObject({ status: 422 });
  });

  it('keeps a refused package as a result of validatePackage', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ title: 'invalid_package', status: 422, diagnostics: [{ message: 'bad file' }] }, 422));
    await expect(client.validatePackage(new Uint8Array([1]))).resolves.toMatchObject({ valid: false, refusal: { code: 'invalid_package' } });
  });
});
