import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PricingUnavailableError, QuotaError } from './auth';
import { ApiClient, HttpError } from './client';
import { platformApi } from './platform';
import { forgetCasFlow, readCasFlow } from '../utils/authFlow';

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

/** The one 422 document of docs/ERRORS.md. */
function problem(code: string, detail: string, diagnostics: Array<Record<string, unknown>>) {
  return { type: `https://openbinding.dev/problems/${code}`, title: code, status: 422, code, detail, diagnostics };
}

describe('authentication requests', () => {
  const client = new ApiClient('https://gateway.example');
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    localStorage.clear();
    forgetCasFlow();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  it('throws a 422 from login instead of storing tokens that are not there', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(problem('validation_error', 'Request validation failed: /password: Field required', [
      { code: 'missing', message: 'Field required', in: 'body', pointer: '/password', loc: ['body', 'password'] },
    ]), 422));

    await expect(client.login('alice', '')).rejects.toMatchObject({ status: 422, code: 'validation_error' });
    expect(localStorage.getItem('openbinding-access-token')).toBeNull();
  });

  it('keeps the field-level answer of a 422 on the error', async () => {
    const body = problem('validation_error', 'Request validation failed: /email: bad email', [
      { code: 'value_error', message: 'bad email', in: 'body', pointer: '/email', loc: ['body', 'email'] },
    ]);
    fetchMock.mockResolvedValueOnce(jsonResponse(body, 422));

    const error = await client.register({ username: 'alice', email: 'x', password: 'long-enough-password' }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).problem).toEqual(body);
    expect((error as HttpError).diagnostics).toEqual(body.diagnostics);
    expect((error as HttpError).message).toBe('HTTP 422: Request validation failed: /email: bad email');
  });

  it('reads the code and the sentence of a refusal from the top of the problem (weak password)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(problem('weak_password', 'Too common.', [{ code: 'weak_password', message: 'Too common.' }]), 422));

    const error = await client.register({ username: 'alice', email: 'a@example.org', password: 'password1234' }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ status: 422, code: 'weak_password', message: 'HTTP 422: Too common.' });
    expect((error as HttpError).message).toContain('Too common.');
  });

  it('reads the title of a problem+json refusal as the code', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ type: 'about:blank', title: 'reset_token_invalid', status: 401, detail: 'Reset token is invalid or expired.' }, 401));

    await expect(client.completePasswordReset('obr_a_b', 'long-enough-password')).rejects.toMatchObject({ status: 401, code: 'reset_token_invalid' });
  });

  it('does not try to renew a session while logging in with a stale token lying around', async () => {
    localStorage.setItem('openbinding-access-token', 'stale');
    localStorage.setItem('openbinding-refresh-token', 'stale-refresh');
    const ended = vi.fn();
    window.addEventListener('openbinding:session-ended', ended);
    fetchMock.mockResolvedValueOnce(jsonResponse({ detail: { code: 'invalid_credentials', error: 'no' } }, 401));

    await expect(client.login('alice', 'wrong')).rejects.toMatchObject({ status: 401, code: 'invalid_credentials' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(ended).not.toHaveBeenCalled();
    window.removeEventListener('openbinding:session-ended', ended);
  });

  it('stores the tokens a CAS exchange returns, and throws what it refuses', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ access_token: 'a', refresh_token: 'r', token_type: 'bearer', expires_in: 60 }));
    await expect(client.exchangeCasCode('x'.repeat(32))).resolves.toBeNull();
    expect(localStorage.getItem('openbinding-access-token')).toBe('a');
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ code: 'x'.repeat(32) });

    fetchMock.mockResolvedValueOnce(jsonResponse({ detail: { code: 'cas_code_invalid', error: 'used' } }, 401));
    await expect(client.exchangeCasCode('y'.repeat(32))).rejects.toMatchObject({ status: 401, code: 'cas_code_invalid' });
  });

  it('hands back the plan change a CAS exchange caused, and null when the plan did not change', async () => {
    const session = { access_token: 'a', refresh_token: 'r', token_type: 'bearer', expires_in: 60 };
    fetchMock.mockResolvedValueOnce(jsonResponse({ ...session, plan_changed: { from: 'BASIC', to: 'RESEARCH', extra_cost: false } }));
    await expect(client.exchangeCasCode('x'.repeat(32))).resolves.toEqual({ from: 'BASIC', to: 'RESEARCH', extra_cost: false });

    fetchMock.mockResolvedValueOnce(jsonResponse({ ...session, plan_changed: null }));
    await expect(client.exchangeCasCode('y'.repeat(32))).resolves.toBeNull();
  });

  it('names a sponsor with the replace flag only when asked to replace, and reads the requests of the account', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 'prop-1', status: 'pending' }, 202));
    await client.adminTransferSponsor('org-1', 'user-1');
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ billing_sponsor_user_id: 'user-1' });

    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 'prop-2', status: 'pending' }, 202));
    await client.adminTransferSponsor('org-1', 'user-1', true);
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({ billing_sponsor_user_id: 'user-1', replace_pending_proposal: true });

    fetchMock.mockResolvedValueOnce(jsonResponse([]));
    await client.listMySponsorProposals('pending');
    expect(fetchMock.mock.calls[2][0]).toBe('https://gateway.example/v1/users/me/sponsor-proposals?status=pending');

    fetchMock.mockResolvedValueOnce(jsonResponse([]));
    await client.listOrganizationSponsorProposals('isa-demo');
    expect(fetchMock.mock.calls[3][0]).toBe('https://gateway.example/v1/organizations/isa-demo/sponsor-proposals');

    for (const [index, answer] of (['accept', 'decline', 'cancel'] as const).entries()) {
      fetchMock.mockResolvedValueOnce(jsonResponse({ id: 'prop-1', status: 'accepted' }));
      await client[`${answer}SponsorProposal` as const]('prop-1');
      expect(fetchMock.mock.calls[4 + index][0]).toBe(`https://gateway.example/v1/sponsor-proposals/prop-1/${answer}`);
      expect(fetchMock.mock.calls[4 + index][1]?.method).toBe('POST');
    }
  });

  it('remembers that a CAS link leaves the app, and builds the start URL for either mode', async () => {
    expect(client.casStartUrl()).toBe('https://gateway.example/v1/auth/cas/start?mode=login');
    expect(client.casStartUrl('link')).toBe('https://gateway.example/v1/auth/cas/start?mode=link');
    fetchMock.mockResolvedValueOnce(jsonResponse({ url: '/api/v1/auth/cas/start?mode=link&intent=abc' }));

    await client.createCasLinkIntent();

    expect(readCasFlow()?.mode).toBe('link');
  });
});

describe('invitation acceptance', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    localStorage.clear();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  it('posts the token in the body, never in the URL', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 'm', organization_id: 'o', user_id: 'u', role: 'MEMBER', created_at: '2026-10-09T00:00:00Z' }));

    const member = await platformApi.acceptInvitation('obi_secret_value');

    const [url, request] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/v1\/invitations\/accept$/);
    expect(String(url)).not.toContain('obi_secret_value');
    expect(request?.method).toBe('POST');
    expect(JSON.parse(String(request?.body))).toEqual({ token: 'obi_secret_value' });
    expect(member.role).toBe('MEMBER');
  });

  it('turns the sponsor’s full quota into a QuotaError with its limit', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      detail: { code: 'sponsor_quota_exceeded', error: 'The sponsor contract allows 15 members.', quota: { limit_id: 'members', limit: 15, used: 16 } },
    }, 402));

    const error = await platformApi.acceptInvitation('obi_secret_value').catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(QuotaError);
    expect(error).toMatchObject({ code: 'sponsor_quota_exceeded', quota: { limit: 15, used: 16 } });
  });

  it('throws the 404 the gateway gives every unusable token, and the 422 of a short one', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ detail: { code: 'not_found', error: 'Invitation is invalid or expired.' } }, 404));
    await expect(platformApi.acceptInvitation('obi_secret_value')).rejects.toMatchObject({ status: 404 });

    fetchMock.mockResolvedValueOnce(jsonResponse(problem('validation_error', 'Request validation failed: /token: too short', [{ code: 'string_too_short', message: 'too short', pointer: '/token' }]), 422));
    await expect(platformApi.acceptInvitation('short')).rejects.toMatchObject({ status: 422 });
  });

  it('keeps a pricing outage apart from a refusal', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ detail: { code: 'pricing_unavailable', error: 'down' } }, 503));

    await expect(platformApi.acceptInvitation('obi_secret_value')).rejects.toBeInstanceOf(PricingUnavailableError);
  });
});
