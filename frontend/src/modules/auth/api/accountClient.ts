// The account's client: registration, sign-in and sign-out, the profile, the password reset and the Universidad de Sevilla
// (CAS) sign-in, cut out of the old `api/client.ts` monolith. It sends through the application's one transport, which keeps
// the token it is given in memory. Sign-in and registration are credentialed: their answer sets the HttpOnly session
// cookie the transport renews the token from.

import { HttpTransport, apiClient } from '../../core/api/http';
import type { AccessGrant, CasSession, PlanChange, UserProfile } from '../../core/api/account';
import { rememberCasFlow } from '../utils/authFlow';
import { identityApiOf, type SignOutScope } from './identityApi';

/** The client over a transport: the application's own, or a test's. */
export function accountClientOf(transport: HttpTransport) {
  const identity = identityApiOf(transport);
  const accountClient = {
    async register(details: {
      username: string;
      email: string;
      password: string;
    }): Promise<UserProfile> {
      return transport.request<UserProfile>(
        '/v1/auth/register',
        {
          method: 'POST',
          credentials: 'include',
          body: JSON.stringify(details),
        },
        undefined,
        false,
        true
      );
    },

    async login(usernameOrEmail: string, password: string): Promise<AccessGrant> {
      const tokens = await transport.request<AccessGrant>(
        '/v1/auth/login',
        {
          method: 'POST',
          credentials: 'include',
          body: JSON.stringify({ username_or_email: usernameOrEmail, password }),
        },
        undefined,
        false,
        true
      );
      transport.setTokens(tokens);
      return tokens;
    },

    /** End this session (or, with `all`, every session of the account) on the server, then locally whatever it said. */
    async logout(scope: SignOutScope = 'this'): Promise<void> {
      await identity.identityLogout(scope);
    },

    async getOwnProfile(): Promise<UserProfile> {
      return transport.request<UserProfile>('/v1/users/me');
    },

    async requestPasswordReset(
      email: string
    ): Promise<{ accepted: boolean; delivery: string; token?: string }> {
      return transport.request(
        '/v1/auth/password-reset/request',
        {
          method: 'POST',
          body: JSON.stringify({ email }),
        },
        undefined,
        false,
        true
      );
    },

    async completePasswordReset(token: string, newPassword: string): Promise<void> {
      await transport.request(
        '/v1/auth/password-reset/complete',
        {
          method: 'POST',
          body: JSON.stringify({ token, new_password: newPassword }),
        },
        undefined,
        false,
        true
      );
    },

    casStartUrl(mode: 'login' | 'link' = 'login'): string {
      return `${transport.baseUrl}/v1/auth/cas/start?mode=${mode}`;
    },

    async createCasLinkIntent(): Promise<string> {
      const response = await transport.request<{ url: string }>('/v1/auth/cas/link-intent', {
        method: 'POST',
      });
      // The caller navigates to this URL next; the callback page needs to know it is a link, not a login.
      rememberCasFlow('link');
      return response.url;
    },

    /**
     * Trade the one-time code of the CAS redirect for a session. Answers the plan change that signing in caused (linking CAS raises
     * FREE to RESEARCH, at no extra cost), or `null` when the plan did not change.
     */
    async exchangeCasCode(code: string): Promise<PlanChange | null> {
      const session = await transport.request<CasSession>(
        '/v1/auth/cas/exchange',
        {
          method: 'POST',
          credentials: 'include',
          body: JSON.stringify({ code }),
        },
        undefined,
        false,
        true
      );
      transport.setTokens(session);
      const change = session.plan_changed;
      return change && typeof change.to === 'string' ? change : null;
    },
  };
  return accountClient;
}

export const accountClient = accountClientOf(apiClient);
