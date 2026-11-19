// Adapted from SPHERE frontend/src/modules/auth/api/identityApi.ts (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: the single-flight `POST /v1/auth/identity/session` lives in the application's transport
// (`core/api/http.ts`, `renewSession`), which keeps the token in memory for every module's client; this module names it
// for the auth screens and adds sign-out, and the first sign-in's pending sign-up and its chosen username (the pending and
// complete calls follow SPACE's `sphereAuthApi`, SCORELabUS/space@3d35281). OpenBinding's routes are under `/v1/auth/identity`, its JSON is snake_case
// (`access_token`, `expires_in`) and both modes (local and SCORETech Identity) share the cookie session.

import { apiClient, type AccessGrant, type HttpTransport } from '../../core/api/http';
import type { components } from '../../core/api/openapi';

/** A first SCORETech sign-in waiting for its username (`GET /v1/auth/identity/pending`). */
export type PendingSignUp = components['schemas']['PendingSignUp'];
/** What completing it answers: where to go next. */
export type CompletedSignUp = components['schemas']['CompletedSignUp'];

/** Whose sessions a sign-out ends: this browser's, or every OpenBinding session of the account. */
export type SignOutScope = 'this' | 'all';

export function identityApiOf(transport: HttpTransport) {
  return {
    /** A fresh gateway token from the session cookie, once however many callers ask (rejects with the gateway's error). */
    identitySession(): Promise<AccessGrant> {
      return transport.renewSession();
    },

    /** The first sign-in waiting for its username, read with the pending cookie (404 `no_pending_signup` otherwise). */
    identityPending(): Promise<PendingSignUp> {
      return transport.request<PendingSignUp>(
        '/v1/auth/identity/pending',
        { credentials: 'include', cache: 'no-store' },
        undefined,
        false
      );
    },

    /** Create the account of the pending sign-up with the chosen username; the answer sets the session cookie. */
    identityComplete(username: string): Promise<CompletedSignUp> {
      return transport.request<CompletedSignUp>(
        '/v1/auth/identity/complete',
        {
          method: 'POST',
          credentials: 'include',
          cache: 'no-store',
          body: JSON.stringify({ username }),
        },
        undefined,
        false
      );
    },

    /**
     * End the session (and, with `all`, every session of the account) and, in SCORETech mode, the SCORE SSO session behind
     * it. Always ends the token kept here, whatever the gateway answers.
     */
    async identityLogout(scope: SignOutScope = 'this'): Promise<void> {
      try {
        await fetch(`${transport.baseUrl}/v1/auth/identity/logout`, {
          method: 'POST',
          credentials: 'include',
          cache: 'no-store',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scope }),
        });
      } finally {
        transport.clearTokens();
      }
    },
  };
}

export const identityApi = identityApiOf(apiClient);

/** When a JWT expires, or `null` when the token is not a readable JWT. Copied from SPHERE's `jwtExpiration`. */
export const jwtExpiration = (token: string): Date | null => {
  try {
    const value = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).exp;
    return typeof value === 'number' ? new Date(value * 1000) : null;
  } catch {
    return null;
  }
};

/** The account a gateway token names (`sub`), or `null` when the token is not a readable JWT. */
export const jwtSubject = (token: string): string | null => {
  try {
    const value = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).sub;
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
};
