import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QuotaError } from './auth';
import { ApiClient, HttpError } from './client';
import { problemField } from './problem';
import type { ImmutableResourceRef } from '../modules/core/api/types';
import type { EngineManifest, EngineRegistrationManifest } from './client';

const DIGEST = `sha256-${'a'.repeat(64)}`;
const REF: ImmutableResourceRef = {
  namespace: 'research.team',
  name: 'solver-deployment',
  version: '2.1.0',
  digest: DIGEST,
};

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
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
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          namespace: 'research.team',
          name: 'solver',
          version: '1.0.0',
          digest: DIGEST,
          status: 'private',
        },
        201
      )
    );

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
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          type: 'https://openbinding.dev/problems/invalid_engine',
          title: 'invalid_engine',
          status: 422,
          detail: 'Engine manifest does not satisfy bim/v1',
          diagnostics: [
            {
              code: 'capability_dimension_missing',
              pointer: '/spec/modes/0/capabilities',
              message: "mode must explicitly select capability dimension 'featureValues'",
            },
          ],
        },
        422
      )
    );

    await expect(client.createEngine(manifest)).rejects.toMatchObject({
      status: 422,
      code: 'invalid_engine',
      diagnostics: [expect.objectContaining({ pointer: '/spec/modes/0/capabilities' })],
    });
  });

  it('throws a refused credential (422) and a refused registration (422) the same way', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        {
          title: 'invalid_credential',
          status: 422,
          detail: 'credential payload requires a non-empty secret',
        },
        422
      )
    );
    await expect(client.setEngineRegistrationCredential(REF, '')).rejects.toMatchObject({
      status: 422,
      code: 'invalid_credential',
    });

    fetchMock.mockResolvedValue(
      jsonResponse(
        {
          title: 'secret_in_document',
          status: 422,
          detail: 'credentials must be supplied through the secret store',
        },
        422
      )
    );
    await expect(
      client.createEngineRegistration({
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
      })
    ).rejects.toMatchObject({ status: 422, code: 'secret_in_document' });
  });

  it('refuses to invent a missing immutable pin in a publication response', async () => {
    const manifest: EngineManifest = {
      apiVersion: 'bim/v1',
      kind: 'Engine',
      metadata: { namespace: 'research.team', name: 'solver', version: '1.0.0' },
      spec: { modes: [] },
    };
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          name: 'solver',
          version: '1.0.0',
          digest: DIGEST,
          status: 'published',
        },
        201
      )
    );

    await expect(client.createEngine(manifest)).rejects.toThrow(
      'The gateway response omitted the immutable resource pin namespace.'
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
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ ...REF, status: 'private', active: false }, 201)
    );

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
    [
      'publication request',
      (api: ApiClient) => api.requestEngineRegistrationPublication(REF),
      '/publication-request',
    ],
    [
      'credential',
      (api: ApiClient) => api.setEngineRegistrationCredential(REF, 'secret'),
      '/credential',
    ],
  ])(
    'pins namespace, version, and digest when it performs the %s operation',
    async (_label, operation, suffix) => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ ...REF, status: 'private', active: true }));

      await operation(client);

      const url = new URL(String(fetchMock.mock.calls[0][0]));
      expect(url.pathname).toBe(`/v1/engine-registrations/solver-deployment${suffix}`);
      expect(Object.fromEntries(url.searchParams)).toEqual({
        namespace: REF.namespace,
        version: REF.version,
        digest: REF.digest,
      });
    }
  );

  it('uses the server-side moderation queue instead of listing private registrations', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ registrations: [] }));

    await client.adminListEngineRegistrations();

    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://gateway.example/v1/engine-registrations?review=true'
    );
  });
});

describe('a 422 is an error unless the caller asks for its body', () => {
  const client = new ApiClient('https://gateway.example');
  const fetchMock = vi.fn<typeof fetch>();
  const refusal = () =>
    jsonResponse(
      {
        title: 'validation_error',
        status: 422,
        detail: 'refused',
        diagnostics: [{ message: 'where' }],
      },
      422
    );

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
    ['createCasLinkIntent', (api: ApiClient) => api.createCasLinkIntent()],
    ['activateEngineRegistration', (api: ApiClient) => api.activateEngineRegistration(REF)],
    ['deactivateEngineRegistration', (api: ApiClient) => api.deactivateEngineRegistration(REF)],
    [
      'requestEngineRegistrationPublication',
      (api: ApiClient) => api.requestEngineRegistrationPublication(REF),
    ],
    ['adminApproveEngineRegistration', (api: ApiClient) => api.adminApproveEngineRegistration(REF)],
    ['adminRejectEngineRegistration', (api: ApiClient) => api.adminRejectEngineRegistration(REF)],
  ])('%s throws an HttpError with the gateway’s code and diagnostics', async (_name, call) => {
    fetchMock.mockResolvedValueOnce(refusal());
    await expect(call(client)).rejects.toMatchObject({
      status: 422,
      code: 'validation_error',
      diagnostics: [{ message: 'where' }],
    });
  });

  it('hands the body of a 422 back only where the caller says so', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ detail: 'not a result' }, 422));
    await expect(client.request('/v1/anything', {}, undefined, true, false)).resolves.toEqual({
      detail: 'not a result',
    });
    fetchMock.mockResolvedValueOnce(jsonResponse({ detail: 'not a result' }, 422));
    await expect(client.request('/v1/anything')).rejects.toMatchObject({ status: 422 });
  });
});

describe('the canonical problem document', () => {
  const client = new ApiClient('https://gateway.example');
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    localStorage.clear();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  it('reads the code and the sentence of a 422 from the top of the document, with the diagnostics beside them', async () => {
    const diagnostics = [
      {
        code: 'greater_than',
        message: 'Input should be greater than 0',
        in: 'body',
        pointer: '/tasks',
        loc: ['body', 'tasks'],
      },
    ];
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          type: 'https://openbinding.dev/problems/validation_error',
          title: 'validation_error',
          status: 422,
          code: 'validation_error',
          detail: 'Request validation failed: /tasks: Input should be greater than 0',
          diagnostics,
        },
        422
      )
    );
    const error = await client
      .request('/v1/organizations/score-ai/runs', { method: 'POST' })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      status: 422,
      code: 'validation_error',
      diagnostics,
      message: 'HTTP 422: Request validation failed: /tasks: Input should be greater than 0',
    });
  });

  it('prefers the top-level code of a coded failure and keeps the extras where the platform puts them', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          type: 'https://openbinding.dev/problems/owner_role_requires_owner',
          title: 'owner_role_requires_owner',
          status: 403,
          code: 'owner_role_requires_owner',
          detail: {
            code: 'owner_role_requires_owner',
            error: 'Only an owner can grant the owner role.',
            index: 2,
            user_id: 'u-3',
          },
        },
        403
      )
    );
    const error = await client
      .request('/v1/organizations/acme/members/batch')
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      status: 403,
      code: 'owner_role_requires_owner',
      message: 'HTTP 403: Only an owner can grant the owner role.',
    });
    expect(problemField(error, 'index')).toBe(2);
    expect(problemField(error, 'user_id')).toBe('u-3');
  });

  it('still reads the code of an older body that has only detail.code', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ detail: { code: 'last_owner', error: 'Keep one owner.' } }, 409)
    );
    await expect(client.request('/v1/x')).rejects.toMatchObject({
      status: 409,
      code: 'last_owner',
    });
  });

  describe('a refusal over a limit keeps what the gateway says about it', () => {
    const fail = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      fetchMock.mockResolvedValueOnce(jsonResponse(body, status, headers));
      return client.request('/v1/organizations/score-ai/runs', { method: 'POST' }).then(
        () => {
          throw new Error('resolved');
        },
        (caught: unknown) => caught
      );
    };
    const quota = {
      limit_id: 'MAX_BINDING_SPACE_LOG10',
      state: 'unmeasured',
      unit: 'log10 combinations',
      source: 'technical',
    };

    it('422 binding_space_unmeasured: the limit has no number, and the state and source say why', async () => {
      const caught = await fail(422, {
        type: 't',
        title: 'binding_space_unmeasured',
        status: 422,
        code: 'binding_space_unmeasured',
        detail: 'The size could not be measured.',
        quota,
      });

      expect(caught).toBeInstanceOf(HttpError);
      expect(caught).toMatchObject({ status: 422, code: 'binding_space_unmeasured' });
      expect((caught as HttpError).notice).toEqual({
        limit_id: 'MAX_BINDING_SPACE_LOG10',
        state: 'unmeasured',
        source: 'technical',
        unit: 'log10 combinations',
      });
      expect((caught as HttpError).notice).not.toHaveProperty('limit');
    });

    it('402 on a platform route: the quota inside `detail`', async () => {
      const caught = await fail(402, {
        type: 't',
        title: 'quota_exceeded',
        status: 402,
        code: 'quota_exceeded',
        detail: {
          code: 'quota_exceeded',
          error: 'repository storage is used up',
          quota: {
            limit_id: 'maxRepositoryStorage',
            state: 'exhausted',
            unit: 'MB',
            source: 'plan',
            limit: 500,
            used: 500,
          },
        },
      });

      expect(caught).toBeInstanceOf(QuotaError);
      const error = caught as QuotaError;
      expect(error.quota).toMatchObject({
        limit_id: 'maxRepositoryStorage',
        limit: 500,
        used: 500,
      });
      expect(error.notice).toEqual({
        limit_id: 'maxRepositoryStorage',
        state: 'exhausted',
        source: 'plan',
        unit: 'MB',
        limit: 500,
        used: 500,
      });
      expect(error.bindingSpace).toBeUndefined();
    });

    it('402 usage_limit_exceeded without numbers is still a QuotaError, with the limit only in the notice', async () => {
      const caught = await fail(402, {
        type: 't',
        title: 'usage_limit_exceeded',
        status: 402,
        code: 'usage_limit_exceeded',
        detail: 'spent',
        quota: { limit_id: 'taskStarts', state: 'exhausted', unit: 'task', source: 'space' },
      });

      expect(caught).toBeInstanceOf(QuotaError);
      expect((caught as QuotaError).quota).toBeUndefined();
      expect((caught as QuotaError).notice).toMatchObject({
        limit_id: 'taskStarts',
        source: 'space',
      });
    });

    it('422 over the deployment’s cap: the quota and the size at the top of the problem', async () => {
      const caught = await fail(422, {
        type: 't',
        title: 'binding_space_over_technical_limit',
        status: 422,
        code: 'binding_space_over_technical_limit',
        detail: 'x',
        quota: {
          limit_id: 'MAX_BINDING_SPACE_LOG10',
          state: 'exhausted',
          unit: 'log10 combinations',
          source: 'technical',
          limit: 6,
          used: 9,
        },
        binding_space: { kind: 'estimate', log10: 9, digits: 10, cardinality: '1000000000' },
      });

      expect(caught).toBeInstanceOf(HttpError);
      expect((caught as HttpError).notice).toMatchObject({
        source: 'technical',
        limit: 6,
        used: 9,
        state: 'exhausted',
      });
      expect((caught as HttpError).bindingSpace).toEqual({
        log10: 9,
        digits: 10,
        cardinality: '1000000000',
      });
    });

    it('429 names whose limit it is', async () => {
      const caught = await fail(
        429,
        {
          type: 't',
          title: 'concurrency_limit_exceeded',
          status: 429,
          code: 'concurrency_limit_exceeded',
          detail: 'Concurrency limit exceeded.',
          concurrency: {
            limit_id: 'maxConcurrentRuns',
            limit: 2,
            used: 2,
            active: 2,
            unit: 'job',
            source: 'plan',
          },
        },
        { 'Retry-After': '15' }
      );

      expect(caught).toMatchObject({
        status: 429,
        retryAfter: 15,
        concurrency: {
          limit_id: 'maxConcurrentRuns',
          limit: 2,
          used: 2,
          source: 'plan',
          unit: 'job',
        },
      });
    });

    it('keeps nothing that is not well formed, and reads a state it does not know as unknown rather than exhausted', async () => {
      const odd = await fail(422, {
        type: 't',
        title: 'binding_space_unmeasured',
        status: 422,
        code: 'binding_space_unmeasured',
        detail: 'x',
        quota: {
          limit_id: 'MAX_BINDING_SPACE_LOG10',
          state: 'something-new',
          source: 'elsewhere',
          unit: 7,
          limit: 'many',
          used: null,
          host: 'internal.example',
        },
        binding_space: {
          log10: 'big',
          digits: null,
          cardinality: '1'.repeat(41),
          path: '/srv/secret',
        },
      });
      expect((odd as HttpError).notice).toEqual({
        limit_id: 'MAX_BINDING_SPACE_LOG10',
        state: 'unknown',
      });
      expect((odd as HttpError).bindingSpace).toBeUndefined();

      const garbage = await fail(403, {
        type: 't',
        title: 'x',
        status: 403,
        code: 'x',
        detail: 'x',
        quota: 'text',
        binding_space: [],
      });
      expect((garbage as HttpError).notice).toBeUndefined();
      expect((garbage as HttpError).bindingSpace).toBeUndefined();
    });
  });

  it('keeps Retry-After on a rate-limited public read', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          type: 't',
          title: 'rate_limit_exceeded',
          status: 429,
          code: 'rate_limit_exceeded',
          detail: { code: 'rate_limit_exceeded', error: 'Too many reads.' },
        },
        429,
        { 'Retry-After': '42' }
      )
    );
    await expect(client.request('/v1/organizations/o/runs')).rejects.toMatchObject({
      status: 429,
      code: 'rate_limit_exceeded',
      retryAfter: 42,
    });
  });
});
