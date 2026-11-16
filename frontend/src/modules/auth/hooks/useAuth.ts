import { useContext } from 'react';
import { AuthContext, type AuthContextValue } from '../contexts/authContext';

export { AuthContext };
export type { AuthContextValue };

/** Who is signed in, and SPHERE's `fetchWithInterceptor` for the module APIs. */
export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
