import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { apiClient, SESSION_ENDED_EVENT } from '../api/client';
import type { UserProfile } from '../api/auth';
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

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);

  const loadProfile = useCallback(async () => {
    if (!apiClient.getAccessToken()) {
      setUser(null);
      return;
    }
    try {
      setUser(await apiClient.getOwnProfile());
    } catch {
      // A token that no longer identifies anybody is no session at all.
      apiClient.clearTokens();
      setUser(null);
      return;
    }
    try {
      await apiClient.getPricingToken();
    } catch {
      localStorage.removeItem('pricingToken');
    }
  }, []);

  useEffect(() => {
    void Promise.resolve().then(loadProfile).finally(() => setLoading(false));
  }, [loadProfile]);

  useEffect(() => {
    // The client ends a session when a refresh fails. Listening rather than
    // returning a flag means every tab notices, not only the one that asked.
    const onSessionEnded = () => setUser(null);
    window.addEventListener(SESSION_ENDED_EVENT, onSessionEnded);
    return () => window.removeEventListener(SESSION_ENDED_EVENT, onSessionEnded);
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
    await apiClient.logout();
    setUser(null);
  }, []);

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
      {children}
    </AuthContext.Provider>
  );
}
