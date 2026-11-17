import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpTransport } from '../../core/api/http';
import { adminApiOf } from './adminApi';

// Moved with the administration operations out of api/client.ts: the If-Match of a subscription change.

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

describe('an account’s subscription is a conditional write (If-Match)', () => {
  const client = adminApiOf(new HttpTransport('https://gateway.example').fetchWithInterceptor);
  const fetchMock = vi.fn<typeof fetch>();
  const view = {
    user: { id: 'u-1', plan: 'BASIC' },
    subscription: { plan: 'BASIC', add_ons: {}, pricing_version: '0.1.0', renews_at: null },
    changed: false,
  };
  const sent = (call: number) => new Headers(fetchMock.mock.calls[call][1]?.headers);

  beforeEach(() => {
    localStorage.clear();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  it('reads the revision of the subscription from the ETag of the answer, and says when there is none', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(view, 200, { ETag: '"c-1"' }));
    await expect(client.adminGetSubscription('u-1')).resolves.toEqual({
      value: view,
      etag: '"c-1"',
    });
    expect(sent(0).has('If-Match')).toBe(false);

    // A SPACE that keeps no contract versions gives the subscription no revision.
    fetchMock.mockResolvedValueOnce(jsonResponse(view));
    await expect(client.adminGetSubscription('u-1')).resolves.toEqual({ value: view, etag: null });
  });

  it('sends the revision a change was decided on as If-Match, as it came, and hands back the new one', async () => {
    const after = {
      ...view,
      subscription: { ...view.subscription, plan: 'ADVANCED' },
      changed: true,
    };
    fetchMock.mockResolvedValueOnce(jsonResponse(after, 200, { ETag: '"c-2"' }));
    await expect(
      client.adminUpdateSubscription(
        'u-1',
        { plan: 'ADVANCED', add_ons: {}, reason: 'new_feature' },
        '"c-1"'
      )
    ).resolves.toEqual({ value: after, etag: '"c-2"' });
    const [url, request] = fetchMock.mock.calls[0];
    expect(url).toBe('https://gateway.example/v1/admin/users/u-1/subscription');
    expect(request?.method).toBe('POST');
    expect(JSON.parse(String(request?.body))).toEqual({
      plan: 'ADVANCED',
      add_ons: {},
      reason: 'new_feature',
    });
    expect(sent(0).get('If-Match')).toBe('"c-1"');
    expect(sent(0).get('Content-Type')).toBe('application/json');

    fetchMock.mockResolvedValueOnce(
      jsonResponse({ id: 'u-1', plan: 'PRO' }, 200, { ETag: '"c-3"' })
    );
    await expect(client.adminChangePlan('u-1', 'PRO', '"c-2"')).resolves.toEqual({
      value: { id: 'u-1', plan: 'PRO' },
      etag: '"c-3"',
    });
    expect(fetchMock.mock.calls[1][0]).toBe('https://gateway.example/v1/admin/users/u-1/plan');
    expect(sent(1).get('If-Match')).toBe('"c-2"');
  });

  it('sends no If-Match when there is no revision to send', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(view));
    await client.adminUpdateSubscription(
      'u-1',
      { plan: 'BASIC', add_ons: {}, reason: 'new_feature' },
      null
    );
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 'u-1', plan: 'BASIC' }));
    await client.adminChangePlan('u-1', 'BASIC', null);
    expect(sent(0).has('If-Match')).toBe(false);
    expect(sent(1).has('If-Match')).toBe(false);
  });

  it('keeps the revision through a renewed session', async () => {
    localStorage.setItem('openbinding-access-token', 'old');
    localStorage.setItem('openbinding-refresh-token', 'refresh');
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ detail: { code: 'not_authenticated', error: 'expired' } }, 401)
      )
      .mockResolvedValueOnce(jsonResponse({ access_token: 'new', refresh_token: 'refresh-2' }))
      .mockResolvedValueOnce(jsonResponse({ id: 'u-1', plan: 'PRO' }, 200, { ETag: '"c-3"' }));
    await expect(client.adminChangePlan('u-1', 'PRO', '"c-2"')).resolves.toEqual({
      value: { id: 'u-1', plan: 'PRO' },
      etag: '"c-3"',
    });
    expect(sent(2).get('If-Match')).toBe('"c-2"');
    expect(sent(2).get('Authorization')).toBe('Bearer new');
  });

  it('throws what the gateway refuses: an outdated revision (412) and a contract that moved during the change (409)', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          type: 'https://openbinding.dev/problems/precondition_failed',
          title: 'precondition_failed',
          status: 412,
          code: 'precondition_failed',
          detail: {
            code: 'precondition_failed',
            error: 'The resource changed since it was read; fetch it again and retry.',
          },
        },
        412,
        { ETag: '"c-9"' }
      )
    );
    await expect(
      client.adminUpdateSubscription(
        'u-1',
        { plan: 'PRO', add_ons: {}, reason: 'new_feature' },
        '"c-1"'
      )
    ).rejects.toMatchObject({ status: 412, code: 'precondition_failed' });

    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          type: 'https://openbinding.dev/problems/contract_changed',
          title: 'contract_changed',
          status: 409,
          code: 'contract_changed',
          detail: {
            code: 'contract_changed',
            error:
              'The subscription changed while this change was being applied, so nothing was changed.',
          },
        },
        409
      )
    );
    await expect(client.adminChangePlan('u-1', 'PRO', null)).rejects.toMatchObject({
      status: 409,
      code: 'contract_changed',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('the administration operations throw what the gateway refuses', () => {
  const fetchMock = vi.fn<typeof fetch>();
  const api = adminApiOf(new HttpTransport('https://gateway.example').fetchWithInterceptor);

  beforeEach(() => {
    localStorage.clear();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  it.each([
    ['adminRevokeApiKey', () => api.adminRevokeApiKey('user', 'key')],
    ['adminUpdateUser', () => api.adminUpdateUser('user', { is_active: false })],
    ['adminPurgeExpired', () => api.adminPurgeExpired('PURGE EXPIRED', 30)],
  ])('%s throws an HttpError with the gateway’s code and diagnostics', async (_name, call) => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          title: 'validation_error',
          status: 422,
          detail: 'refused',
          diagnostics: [{ message: 'where' }],
        },
        422
      )
    );
    await expect(call()).rejects.toMatchObject({
      status: 422,
      code: 'validation_error',
      diagnostics: [{ message: 'where' }],
    });
  });

  it('names its routes and parameters as the gateway does', async () => {
    fetchMock.mockImplementation(async () => jsonResponse({}));
    await api.adminListUsers({ search: 'sam', offset: 50, limit: 50 });
    await api.adminAudit({
      action: 'contract.subscription.changed',
      organizationId: 'o-1',
      offset: 0,
      limit: 100,
    });
    await api.adminListErrors({ status_code: 402, limit: 50, offset: 0 });
    await api.adminMaintenancePreview(30);
    await api.adminRevokeApiKey('u-1', 'k-1');
    expect(
      fetchMock.mock.calls.map(([url, init]) => `${init?.method ?? 'GET'} ${String(url)}`)
    ).toEqual([
      'GET https://gateway.example/v1/admin/users?search=sam&offset=50&limit=50',
      'GET https://gateway.example/v1/admin/audit?action=contract.subscription.changed&organization_id=o-1&limit=100',
      'GET https://gateway.example/v1/admin/errors?status_code=402&limit=50&offset=0',
      'GET https://gateway.example/v1/admin/maintenance/preview?terminal_job_retention_days=30',
      'DELETE https://gateway.example/v1/admin/users/u-1/api-keys/k-1',
    ]);
  });
});
