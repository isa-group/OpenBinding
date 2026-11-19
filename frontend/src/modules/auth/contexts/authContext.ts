import { createContext } from 'react';
import type { UserProfile } from '../../core/api/account';
import type { SignOutScope } from '../api/identityApi';

export interface AuthContextValue {
  user: UserProfile | null;
  /** True until the stored session has been checked, so guards do not flash. */
  loading: boolean;
  signIn: (usernameOrEmail: string, password: string) => Promise<void>;
  register: (details: { username: string; email: string; password: string }) => Promise<void>;
  /** End this session, or every OpenBinding session of the account (`all`), and the SCORE SSO session behind it. */
  signOut: (scope?: SignOutScope) => Promise<void>;
  /** Ask the gateway again whether the session cookie names a session, then who it is (after a first SCORETech sign-in). */
  resume: () => Promise<void>;
  /** Re-read the profile, after a plan change or a password change. */
  refresh: () => Promise<void>;
  isAdmin: boolean;
  /**
   * SPHERE's transport for module APIs (`use<Domain>Api()`): `fetch` against the gateway with the session's bearer token,
   * renewed from the session cookie before it runs out and once on a 401 (shared by every caller), and the session ended
   * when that fails. It answers the raw `Response`; read a refusal with `readApiError`.
   */
  fetchWithInterceptor: (path: string, init?: RequestInit) => Promise<Response>;
}

export const AuthContext = createContext<AuthContextValue | undefined>(undefined);
