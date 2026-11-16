import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ACCESS_TOKEN_KEY, HttpTransport, REFRESH_TOKEN_KEY, SESSION_ENDED_EVENT } from './http';

const json = (status: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('fetchWithInterceptor', () => {
  const fetchMock = vi.fn<typeof fetch>();
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    localStorage.setItem(ACCESS_TOKEN_KEY, 'old-access');
    localStorage.setItem(REFRESH_TOKEN_KEY, 'old-refresh');
  });
  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('sends the bearer token to the gateway and answers the raw response', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { ok: true }));
    const transport = new HttpTransport('http://gateway');
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
  });

  it('refreshes once on a 401, shared by concurrent callers, and retries with the new token', async () => {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/v1/auth/refresh'))
        return json(200, { access_token: 'new-access', refresh_token: 'new-refresh' });
      const auth = new Headers(init?.headers).get('Authorization');
      return auth === 'Bearer new-access' ? json(200) : json(401);
    });
    const transport = new HttpTransport('http://gateway');
    const [a, b] = await Promise.all([
      transport.fetchWithInterceptor('/v1/a'),
      transport.fetchWithInterceptor('/v1/b'),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/v1/auth/refresh'))
    ).toHaveLength(1);
    expect(localStorage.getItem(ACCESS_TOKEN_KEY)).toBe('new-access');
  });

  it('ends the session when the refresh is refused', async () => {
    fetchMock.mockImplementation(async input =>
      String(input).endsWith('/v1/auth/refresh') ? json(401) : json(401)
    );
    const ended = vi.fn();
    window.addEventListener(SESSION_ENDED_EVENT, ended);
    const response = await new HttpTransport('http://gateway').fetchWithInterceptor('/v1/a');
    window.removeEventListener(SESSION_ENDED_EVENT, ended);
    expect(response.status).toBe(401);
    expect(ended).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(ACCESS_TOKEN_KEY)).toBeNull();
  });
});
