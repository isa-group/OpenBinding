// The sign-in configuration's context and hook, beside SPHERE's provider (`authConfig.tsx`, adapted from SPHERE
// frontend/src/modules/auth/contexts/authConfig.tsx at revision 73779a8a; MIT licence in THIRD_PARTY_NOTICES.md).

import { createContext, useContext } from 'react';
import type { components } from '../../core/api/openapi';

/** How the gateway signs people in: `local` (the form) or `scoretech` (SCORETech Identity, one button). */
export type AuthConfig = components['schemas']['AuthConfigView'];

export const AuthConfigContext = createContext<AuthConfig | null>(null);

/** The gateway's sign-in configuration; the whole application renders inside `AuthConfigProvider`, so it is always known. */
export function useAuthConfig(): AuthConfig {
  const value = useContext(AuthConfigContext);
  if (!value) throw new Error('useAuthConfig must be used inside AuthConfigProvider');
  return value;
}
