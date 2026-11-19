import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  HttpError,
  apiClient,
  PRICING_TOKEN_UPDATED_EVENT,
  SESSION_ENDED_EVENT,
} from '../../core/api/http';
import type { UserProfile } from '../../core/api/account';
import { ErrorState, StateAction } from '../../core/components/error-state';
import { clearSessionEnded, markSessionEnded } from '../utils/authFlow';
import { clearUserDrafts } from '../../core/editor/drafts';
import { AuthContext } from './authContext';
import { accountClient } from '../api/accountClient';
import { jwtSubject, type SignOutScope } from '../api/identityApi';
import { planClient } from '../../settings/api/planClient';

/**
 * Who is signed in, for the whole interface.
 *
 * The browser's credential is the gateway's HttpOnly session cookie, in both modes (local and SCORETech Identity). The
 * interface never sees it: it asks `POST /v1/auth/identity/session` for a short gateway token, keeps that token in memory
 * only (never Web Storage) and renews it before it runs out, when the tab regains focus or becomes visible, and every 30 s
 * (the port of SPHERE's `useAuth` cadence, without its localStorage copy). Reloading the page keeps the session because
 * the cookie does. Other tabs learn of a sign-in or a sign-out through the `openbinding-auth` BroadcastChannel.
 */

/** Only an answer that says the credentials are no good ends the session; a gateway that is down or unreachable says nothing about them. */
function isRejectedSession(error: unknown): boolean {
  return error instanceof HttpError && (error.status === 401 || error.status === 403);
}

/** The session exists but SCORETech Identity could not renew it right now: it is kept, and the person can try again. */
function isSessionUnavailable(error: unknown): boolean {
  return error instanceof HttpError && error.status === 503;
}

/** The cross-tab channel: one tab signing in or out tells the others. */
export const AUTH_CHANNEL = 'openbinding-auth';
type AuthMessage = { type: 'signed-in'; userId: string } | { type: 'signed-out' };

/** How often a signed-in tab checks whether its token needs renewing (it renews only when under a minute is left). */
export const RENEW_INTERVAL_MS = 30_000;

function openChannel(): BroadcastChannel | null {
  return typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(AUTH_CHANNEL);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  /** The session could not be checked (a 503, no network at all while signed in): it is kept, and the person can try again. */
  const [unavailable, setUnavailable] = useState(false);
  const [retrying, setRetrying] = useState(false);
  /** Bumped by every sign-in and sign-out, so a renewal that started before one does not overwrite what it decided. */
  const generation = useRef(0);
  const channel = useRef<BroadcastChannel | null>(null);

  const announce = useCallback((message: AuthMessage) => {
    channel.current?.postMessage(message);
  }, []);

  const loadProfile = useCallback(async () => {
    if (!apiClient.getAccessToken()) {
      setUser(null);
      setUnavailable(false);
      return;
    }
    try {
      setUser(await accountClient.getOwnProfile());
      setUnavailable(false);
      clearSessionEnded();
    } catch (caught) {
      if (isRejectedSession(caught)) {
        // A token that no longer identifies anybody is no session at all.
        apiClient.clearTokens();
        setUser(null);
        setUnavailable(false);
      } else {
        setUnavailable(true);
      }
      return;
    }
    try {
      await planClient.getPricingToken();
    } catch {
      // No token could be issued: forget the old one, and tell whoever shows its state.
      localStorage.removeItem('pricingToken');
      window.dispatchEvent(new CustomEvent(PRICING_TOKEN_UPDATED_EVENT));
    }
  }, []);

  /** Ask the gateway whether the cookie names a session, then who it is. */
  const resume = useCallback(async () => {
    const started = generation.current;
    try {
      await apiClient.renewSession();
    } catch (caught) {
      if (started !== generation.current) return;
      if (isSessionUnavailable(caught)) {
        setUnavailable(true);
        return;
      }
      // No session (401), or no gateway to ask: the visitor browses signed out; a protected screen sends them to sign in.
      apiClient.clearTokens();
      setUser(null);
      setUnavailable(false);
      return;
    }
    if (started !== generation.current) return;
    await loadProfile();
  }, [loadProfile]);

  useEffect(() => {
    void Promise.resolve()
      .then(resume)
      .finally(() => setLoading(false));
  }, [resume]);

  useEffect(() => {
    // The client ends a session when a renewal is refused. The event only reaches the
    // tab that made the request; the other tabs follow through the channel below.
    const onSessionEnded = () => {
      // The sign-in page tells the person why they are back there.
      markSessionEnded();
      generation.current += 1;
      setUser(null);
      setUnavailable(false);
    };
    window.addEventListener(SESSION_ENDED_EVENT, onSessionEnded);
    return () => window.removeEventListener(SESSION_ENDED_EVENT, onSessionEnded);
  }, []);

  // Another tab signed out: this one follows. Another tab signing in (as anybody else) gives this one that session too.
  const onMessage = useEffectEvent((message: AuthMessage) => {
    if (message.type === 'signed-out') {
      generation.current += 1;
      apiClient.clearTokens();
      setUser(null);
      setUnavailable(false);
    } else if (message.userId !== user?.id) {
      generation.current += 1;
      void resume();
    }
  });
  useEffect(() => {
    const opened = openChannel();
    channel.current = opened;
    if (!opened) return;
    opened.onmessage = (event: MessageEvent<AuthMessage>) => onMessage(event.data);
    return () => {
      opened.close();
      channel.current = null;
    };
  }, []);

  // Renewal cadence while signed in: under a minute left, on focus, when the page is shown again and every 30 s.
  const renewIfDue = useEffectEvent(async () => {
    if (!user || !apiClient.tokenDueForRenewal()) return;
    const started = generation.current;
    try {
      const grant = await apiClient.renewSession();
      if (started !== generation.current) return;
      // The cookie now names somebody else (another tab signed in as another account): follow it.
      const subject = jwtSubject(grant.access_token);
      if (subject && subject !== user.id) await loadProfile();
    } catch (caught) {
      if (started !== generation.current) return;
      if (isRejectedSession(caught)) {
        apiClient.clearTokens();
        window.dispatchEvent(new CustomEvent(SESSION_ENDED_EVENT));
      }
    }
  });
  const signedIn = Boolean(user);
  useEffect(() => {
    if (!signedIn) return;
    const check = () => {
      if (document.visibilityState === 'visible') void renewIfDue();
    };
    const interval = window.setInterval(check, RENEW_INTERVAL_MS);
    window.addEventListener('focus', check);
    window.addEventListener('pageshow', check);
    document.addEventListener('visibilitychange', check);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', check);
      window.removeEventListener('pageshow', check);
      document.removeEventListener('visibilitychange', check);
    };
  }, [signedIn]);

  const signIn = useCallback(
    async (usernameOrEmail: string, password: string) => {
      generation.current += 1;
      await accountClient.login(usernameOrEmail, password);
      await loadProfile();
      const id = jwtSubject(apiClient.getAccessToken() ?? '');
      if (id) announce({ type: 'signed-in', userId: id });
    },
    [loadProfile, announce]
  );

  const register = useCallback(
    async (details: { username: string; email: string; password: string }) => {
      generation.current += 1;
      // Registering opens the session (its answer sets the cookie), so nobody types the same password twice.
      const created = await accountClient.register(details);
      await apiClient.renewSession();
      await loadProfile();
      announce({ type: 'signed-in', userId: created.id });
    },
    [loadProfile, announce]
  );

  const userId = user?.id;
  const signOut = useCallback(
    async (scope: SignOutScope = 'this') => {
      generation.current += 1;
      try {
        await accountClient.logout(scope);
      } finally {
        // The person's editor drafts stay in this browser; they must not outlive their session.
        if (userId) await clearUserDrafts(userId).catch(() => undefined);
      }
      setUser(null);
      setUnavailable(false);
      announce({ type: 'signed-out' });
    },
    [userId, announce]
  );

  const retry = async () => {
    setRetrying(true);
    try {
      await (apiClient.getAccessToken() ? loadProfile() : resume());
    } finally {
      setRetrying(false);
    }
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        signIn,
        register,
        signOut,
        refresh: loadProfile,
        isAdmin: user?.role === 'admin',
        fetchWithInterceptor: apiClient.fetchWithInterceptor,
      }}
    >
      {unavailable && !user && !loading ? (
        <ErrorState
          layout="page"
          status="Unavailable"
          title="We couldn’t check your session"
          checking={retrying}
          actions={
            <StateAction tone="primary" onClick={() => void retry()} disabled={retrying}>
              Try again
            </StateAction>
          }
        >
          You’re still signed in. OpenBinding didn’t answer, so nothing was changed. Try again in a
          moment.
        </ErrorState>
      ) : (
        children
      )}
    </AuthContext.Provider>
  );
}
