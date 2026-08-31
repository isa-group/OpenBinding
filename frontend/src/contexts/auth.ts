import { createContext, useContext } from 'react';
import type { UserProfile } from '../api/auth';

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
}

export const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
