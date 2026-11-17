import { createContext } from 'react';
import type { UserProfile } from '../../core/api/account';

export interface AuthContextValue {
  user: UserProfile | null;
  /** True until the stored session has been checked, so guards do not flash. */
  loading: boolean;
  signIn: (usernameOrEmail: string, password: string) => Promise<void>;
  register: (details: { username: string; email: string; password: string }) => Promise<void>;
  signOut: () => Promise<void>;
  /** Re-read the profile, after a plan change or a password change. */
  refresh: () => Promise<void>;
  isAdmin: boolean;
  /**
   * SPHERE's transport for module APIs (`use<Domain>Api()`): `fetch` against the gateway with the session's bearer token,
   * one silent refresh on a 401 (shared by every caller, because the gateway rotates refresh tokens), and the session
   * ended when that fails. It answers the raw `Response`; read a refusal with `readApiError`.
   */
  fetchWithInterceptor: (path: string, init?: RequestInit) => Promise<Response>;
}

export const AuthContext = createContext<AuthContextValue | undefined>(undefined);
