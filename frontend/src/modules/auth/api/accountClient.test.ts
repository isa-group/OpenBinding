import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpTransport } from '../../core/api/http';
import { accountClientOf } from './accountClient';
import { planClientOf } from '../../settings/api/planClient';
import { HttpError } from '../../core/api/http';
import { forgetCasFlow, readCasFlow } from '../utils/authFlow';

/** The transport at a test gateway, with the client's operations on it (as the old ApiClient bundled them). */
function clientAt(base: string) {
  const transport = new HttpTransport(base);
  return Object.assign(
    Object.create(transport) as HttpTransport,
    accountClientOf(transport),
    planClientOf(transport)
  );
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

/** The one 422 document of docs/ERRORS.md. */
function problem(code: string, detail: string, diagnostics: Array<Record<string, unknown>>) {
  return {
    type: `https://openbinding.dev/problems/${code}`,
    title: code,
    status: 422,
    code,
    detail,
    diagnostics,
  };
}

describe('authentication requests', () => {
  const client = clientAt('https://gateway.example');
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    localStorage.clear();
    forgetCasFlow();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  it('throws a 422 from login instead of storing tokens that are not there', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        problem('validation_error', 'Request validation failed: /password: Field required', [
          {
            code: 'missing',
            message: 'Field required',
            in: 'body',
            pointer: '/password',
            loc: ['body', 'password'],
          },
        ]),
        422
      )
    );

    await expect(client.login('alice', '')).rejects.toMatchObject({
      status: 422,
      code: 'validation_error',
    });
    expect(localStorage.getItem('openbinding-access-token')).toBeNull();
  });

  it('keeps the field-level answer of a 422 on the error', async () => {
    const body = problem('validation_error', 'Request validation failed: /email: bad email', [
      {
        code: 'value_error',
        message: 'bad email',
        in: 'body',
        pointer: '/email',
        loc: ['body', 'email'],
      },
    ]);
    fetchMock.mockResolvedValueOnce(jsonResponse(body, 422));

    const error = await client
      .register({ username: 'alice', email: 'x', password: 'long-enough-password' })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).problem).toEqual(body);
    expect((error as HttpError).diagnostics).toEqual(body.diagnostics);
    expect((error as HttpError).message).toBe(
      'HTTP 422: Request validation failed: /email: bad email'
    );
  });

  it('reads the code and the sentence of a refusal from the top of the problem (weak password)', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        problem('weak_password', 'Too common.', [
          { code: 'weak_password', message: 'Too common.' },
        ]),
        422
      )
    );

    const error = await client
      .register({ username: 'alice', email: 'a@example.org', password: 'password1234' })
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      status: 422,
      code: 'weak_password',
      message: 'HTTP 422: Too common.',
    });
    expect((error as HttpError).message).toContain('Too common.');
  });

  it('reads the title of a problem+json refusal as the code', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          type: 'about:blank',
          title: 'reset_token_invalid',
          status: 401,
          detail: 'Reset token is invalid or expired.',
        },
        401
      )
    );

    await expect(
      client.completePasswordReset('obr_a_b', 'long-enough-password')
    ).rejects.toMatchObject({ status: 401, code: 'reset_token_invalid' });
  });

  it('does not try to renew a session while logging in with a stale token lying around', async () => {
    localStorage.setItem('openbinding-access-token', 'stale');
    localStorage.setItem('openbinding-refresh-token', 'stale-refresh');
    const ended = vi.fn();
    window.addEventListener('openbinding:session-ended', ended);
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ detail: { code: 'invalid_credentials', error: 'no' } }, 401)
    );

    await expect(client.login('alice', 'wrong')).rejects.toMatchObject({
      status: 401,
      code: 'invalid_credentials',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(ended).not.toHaveBeenCalled();
    window.removeEventListener('openbinding:session-ended', ended);
  });

  it('stores the tokens a CAS exchange returns, and throws what it refuses', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ access_token: 'a', refresh_token: 'r', token_type: 'bearer', expires_in: 60 })
    );
    await expect(client.exchangeCasCode('x'.repeat(32))).resolves.toBeNull();
    expect(localStorage.getItem('openbinding-access-token')).toBe('a');
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ code: 'x'.repeat(32) });

    fetchMock.mockResolvedValueOnce(
      jsonResponse({ detail: { code: 'cas_code_invalid', error: 'used' } }, 401)
    );
    await expect(client.exchangeCasCode('y'.repeat(32))).rejects.toMatchObject({
      status: 401,
      code: 'cas_code_invalid',
    });
  });

  it('hands back the plan change a CAS exchange caused, and null when the plan did not change', async () => {
    const session = { access_token: 'a', refresh_token: 'r', token_type: 'bearer', expires_in: 60 };
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        ...session,
        plan_changed: { from: 'BASIC', to: 'RESEARCH', extra_cost: false },
      })
    );
    await expect(client.exchangeCasCode('x'.repeat(32))).resolves.toEqual({
      from: 'BASIC',
      to: 'RESEARCH',
      extra_cost: false,
    });

    fetchMock.mockResolvedValueOnce(jsonResponse({ ...session, plan_changed: null }));
    await expect(client.exchangeCasCode('y'.repeat(32))).resolves.toBeNull();
  });

  it('remembers that a CAS link leaves the app, and builds the start URL for either mode', async () => {
    expect(client.casStartUrl()).toBe('https://gateway.example/v1/auth/cas/start?mode=login');
    expect(client.casStartUrl('link')).toBe('https://gateway.example/v1/auth/cas/start?mode=link');
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ url: '/api/v1/auth/cas/start?mode=link&intent=abc' })
    );

    await client.createCasLinkIntent();

    expect(readCasFlow()?.mode).toBe('link');
  });
});
