import { useCallback, useEffect, useEffectEvent, useState } from 'react';
import type { ReactNode } from 'react';
import { ACCESS_TOKEN_KEY, HttpError, apiClient, PRICING_TOKEN_UPDATED_EVENT, SESSION_ENDED_EVENT } from '../api/client';
import type { UserProfile } from '../api/auth';
import { ErrorState } from '../components/ui/ErrorState';
import { clearSessionEnded, markSessionEnded } from '../utils/authFlow';
import { clearUserDrafts } from '../utils/workspaceDraft';
import { AuthContext } from './auth';

/**
 * Who is signed in, for the whole interface.
 *
 * The session is a bearer token in localStorage rather than a cookie. That is
 * a deliberate choice and worth stating, because cookies would be the usual
 * answer: the gateway's CORS default is a wildcard origin, and a wildcard
 * origin makes browsers refuse credentialed requests outright - so a
 * cookie-based session would work in production and silently fail in
 * development, where the interface, the gateway and nginx are three different
 * origins. The API channel is header-based anyway, so one mechanism serves
 * both. The exposure that buys is mitigated by short-lived access tokens and
 * refresh rotation.
 */

/** Only an answer that says the credentials are no good ends the session; a gateway that is down or unreachable says nothing about them. */
function isRejectedSession(error: unknown): boolean {
  return error instanceof HttpError && (error.status === 401 || error.status === 403);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  /** The stored session could not be checked (no network, a 5xx): it is kept, and the person can try again. */
  const [unavailable, setUnavailable] = useState(false);
  const [retrying, setRetrying] = useState(false);

  const loadProfile = useCallback(async () => {
    if (!apiClient.getAccessToken()) {
      setUser(null);
      setUnavailable(false);
      return;
    }
    try {
      setUser(await apiClient.getOwnProfile());
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
      await apiClient.getPricingToken();
    } catch {
      // No token could be issued: forget the old one, and tell whoever shows its state.
      localStorage.removeItem('pricingToken');
      window.dispatchEvent(new CustomEvent(PRICING_TOKEN_UPDATED_EVENT));
    }
  }, []);

  useEffect(() => {
    void Promise.resolve().then(loadProfile).finally(() => setLoading(false));
  }, [loadProfile]);

  useEffect(() => {
    // The client ends a session when a refresh fails. The event only reaches the
    // tab that made the request; the other tabs follow through the storage event below.
    const onSessionEnded = () => {
      // The sign-in page tells the person why they are back there.
      markSessionEnded();
      setUser(null);
      setUnavailable(false);
    };
    window.addEventListener(SESSION_ENDED_EVENT, onSessionEnded);
    return () => window.removeEventListener(SESSION_ENDED_EVENT, onSessionEnded);
  }, []);

  // Another tab signed out (or cleared the session): this one follows. Another tab signing in gives this one the session too.
  const onStorage = useEffectEvent((event: StorageEvent) => {
    if (event.storageArea !== window.localStorage) return;
    if (event.key !== null && event.key !== ACCESS_TOKEN_KEY) return;
    if (event.newValue === null) {
      setUser(null);
      setUnavailable(false);
    } else if (!user) {
      void loadProfile();
    }
  });
  useEffect(() => {
    const listener = (event: StorageEvent) => onStorage(event);
    window.addEventListener('storage', listener);
    return () => window.removeEventListener('storage', listener);
  }, []);

  const signIn = useCallback(
    async (usernameOrEmail: string, password: string) => {
      await apiClient.login(usernameOrEmail, password);
      await loadProfile();
    },
    [loadProfile]
  );

  const register = useCallback(
    async (details: { username: string; email: string; password: string }) => {
      await apiClient.register(details);
      // Registering does not sign anybody in, so this does it - nobody wants
      // to type the same password twice in a row to get started.
      await apiClient.login(details.username, details.password);
      await loadProfile();
    },
    [loadProfile]
  );

  const signOut = useCallback(async () => {
    try {
      await apiClient.logout();
    } finally {
      // The person's workbench drafts stay in this browser; they must not outlive their session.
      await clearUserDrafts().catch(() => undefined);
    }
    setUser(null);
    setUnavailable(false);
  }, []);

  const retry = async () => {
    setRetrying(true);
    try {
      await loadProfile();
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
      }}
    >
      {unavailable && !user && !loading ? (
        <ErrorState
          layout="page"
          status="Unavailable"
          title="We couldn’t check your session"
          checking={retrying}
          actions={<button type="button" className="ui-state-action is-primary" onClick={() => void retry()} disabled={retrying}>Try again</button>}
        >
          You’re still signed in. OpenBinding didn’t answer, so nothing was changed. Try again in a moment.
        </ErrorState>
      ) : children}
    </AuthContext.Provider>
  );
}
