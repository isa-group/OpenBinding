import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpTransport, SESSION_ENDED_EVENT } from './http';

const json = (status: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const isSession = (input: unknown) => String(input).endsWith('/v1/auth/identity/session');

/** Every key and value either Web Storage holds, to prove no token is ever written there. */
const storageContents = () =>
  [localStorage, sessionStorage].flatMap(storage =>
    Object.keys(storage).map(key => `${key}=${storage.getItem(key)}`)
  );

describe('the session transport', () => {
  const fetchMock = vi.fn<typeof fetch>();
  let transport: HttpTransport;
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    transport = new HttpTransport('http://gateway');
    transport.setTokens({ access_token: 'old-access', expires_in: 300 });
  });
  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    localStorage.clear();
    sessionStorage.clear();
  });

  it('sends the bearer token to the gateway and answers the raw response', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { ok: true }));
    const response = await transport.fetchWithInterceptor('/v1/things', {
      method: 'POST',
      body: '{}',
    });
    expect(response.status).toBe(200);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://gateway/v1/things');
    const headers = new Headers(init?.headers);
    expect(headers.get('Authorization')).toBe('Bearer old-access');
    expect(headers.get('Content-Type')).toBe('application/json');
    // Data requests carry the bearer only: the session cookie goes to the auth routes.
    expect(init?.credentials).toBeUndefined();
  });

  it('renews once from the session cookie on a 401, shared by concurrent callers, and retries', async () => {
    fetchMock.mockImplementation(async (input, init) => {
      if (isSession(input)) return json(200, { access_token: 'new-access', expires_in: 300 });
      const auth = new Headers(init?.headers).get('Authorization');
      return auth === 'Bearer new-access' ? json(200) : json(401);
    });
    const [a, b] = await Promise.all([
      transport.fetchWithInterceptor('/v1/a'),
      transport.fetchWithInterceptor('/v1/b'),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const renewals = fetchMock.mock.calls.filter(([url]) => isSession(url));
    expect(renewals).toHaveLength(1);
    expect(renewals[0][1]).toMatchObject({
      method: 'POST',
      credentials: 'include',
      cache: 'no-store',
    });
    expect(transport.getAccessToken()).toBe('new-access');
    expect(storageContents()).toEqual([]);
  });

  it('ends the session when the renewal is refused', async () => {
    fetchMock.mockImplementation(async () => json(401, { code: 'session_ended' }));
    const ended = vi.fn();
    window.addEventListener(SESSION_ENDED_EVENT, ended);
    const response = await transport.fetchWithInterceptor('/v1/a');
    window.removeEventListener(SESSION_ENDED_EVENT, ended);
    expect(response.status).toBe(401);
    expect(ended).toHaveBeenCalledTimes(1);
    expect(transport.getAccessToken()).toBeNull();
  });

  it('renews before sending when under a minute is left', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-01T10:00:00Z') });
    transport.setTokens({ access_token: 'old-access', expires_in: 300 });
    fetchMock.mockImplementation(async input =>
      isSession(input) ? json(200, { access_token: 'renewed', expires_in: 300 }) : json(200)
    );
    await transport.fetchWithInterceptor('/v1/a');
    expect(fetchMock.mock.calls.filter(([url]) => isSession(url))).toHaveLength(0);

    vi.setSystemTime(new Date('2026-11-01T10:04:10Z'));
    expect(transport.tokenDueForRenewal()).toBe(true);
    await transport.fetchWithInterceptor('/v1/b');
    expect(fetchMock.mock.calls.filter(([url]) => isSession(url))).toHaveLength(1);
    const last = fetchMock.mock.calls.at(-1)!;
    expect(new Headers(last[1]?.headers).get('Authorization')).toBe('Bearer renewed');
  });

  it('rejects a renewal with the gateway status, keeping the token when Identity is unavailable', async () => {
    fetchMock.mockResolvedValueOnce(json(503, { code: 'identity_unavailable' }));
    await expect(transport.renewSession()).rejects.toMatchObject({
      status: 503,
      code: 'identity_unavailable',
    });
    expect(transport.getAccessToken()).toBe('old-access');
  });

  it('writes no token to Web Storage, and clearing forgets it', () => {
    transport.setTokens({ access_token: 'secret-token', expires_in: 300 });
    expect(storageContents().some(entry => entry.includes('secret-token'))).toBe(false);
    transport.clearTokens();
    expect(transport.getAccessToken()).toBeNull();
  });
});
