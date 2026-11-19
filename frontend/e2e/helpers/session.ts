import type { Page } from '@playwright/test';

// The gateway's session in a mocked run. The browser's credential is an HttpOnly cookie the SPA never sees: on load it asks
// `POST /v1/auth/identity/session` for a short token and keeps it in memory. A mocked page is "signed in" when that route
// answers a token; nothing is seeded in Web Storage (it authenticates nobody).

const API = 'http://localhost:8000';

/**
 * The page holds a session: `POST /v1/auth/identity/session` answers `token` until `POST /v1/auth/identity/logout` ends it.
 * Register it after any catch-all route of the API origin (the route registered last answers first).
 */
export async function signedIn(page: Page, token = 'mock-access'): Promise<void> {
  let live = true;
  await page.route(`${API}/v1/auth/identity/session`, route =>
    live
      ? route.fulfill({ json: { access_token: token, token_type: 'bearer', expires_in: 300 } })
      : route.fulfill({
          status: 401,
          json: { code: 'no_session', detail: 'There is no session; sign in.' },
        })
  );
  await page.route(`${API}/v1/auth/identity/logout`, route => {
    live = false;
    return route.fulfill({ status: 204 });
  });
}

/** The page holds no session: the session route answers 401, as the gateway does without a cookie. */
export async function signedOut(page: Page): Promise<void> {
  await page.route(`${API}/v1/auth/identity/session`, route =>
    route.fulfill({
      status: 401,
      json: { code: 'no_session', detail: 'There is no session; sign in.' },
    })
  );
}

/** What `GET /v1/auth/config` answers: the application draws nothing before it knows how the gateway signs people in. */
export function authConfigBody(provider: 'local' | 'scoretech' = 'local') {
  return provider === 'local'
    ? { provider, login_url: null, account_url: null }
    : {
        provider,
        login_url: `${API}/v1/auth/identity/login`,
        account_url: 'https://identity.example.invalid/identity/account/#public-profile',
      };
}

/**
 * Answer `GET /v1/auth/config` (local mode unless told otherwise). Register it after any catch-all route of the API
 * origin (the route registered last answers first).
 */
export async function authConfig(
  page: Page,
  provider: 'local' | 'scoretech' = 'local'
): Promise<void> {
  await page.route(`${API}/v1/auth/config`, route =>
    route.fulfill({ json: authConfigBody(provider) })
  );
}
