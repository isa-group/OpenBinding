// Adapted from SPHERE frontend/src/modules/auth/contexts/authConfig.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: OpenBinding's `GET /v1/auth/config` (snake_case, the generated `AuthConfigView`; no `identityAvailable`, since
// an unreachable Identity is reported by the login route as `identity_error=unavailable`); the 404 "older API" fallback is
// not copied (the gateway always serves the route); the loading and error states are OpenBinding's `ErrorState`; the context
// and `useAuthConfig` live in `authConfigContext.ts`, so this file exports components only (fast refresh).

import { useEffect, useState, type ReactNode } from 'react';
import { config as appConfig } from '../../../config';
import { ErrorState, StateAction } from '../../core/components/error-state';
import LoadingView from '../../core/pages/loading';
import { AuthConfigContext as Context, type AuthConfig } from './authConfigContext';

/** Whether a value is a configuration this frontend can act on (an unknown provider is an error, never a guess). */
function isAuthConfig(value: unknown): value is AuthConfig {
  if (typeof value !== 'object' || value === null) return false;
  const provider = (value as { provider?: unknown }).provider;
  if (provider === 'local') return true;
  return (
    provider === 'scoretech' && typeof (value as { login_url?: unknown }).login_url === 'string'
  );
}

/** A configuration given rather than fetched: for tests and for screens drawn outside the application. */
export function StaticAuthConfig({ value, children }: { value: AuthConfig; children: ReactNode }) {
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

/** Draws nothing of the application until the gateway has said how it signs people in. */
export function AuthConfigProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<AuthConfig>();
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    fetch(`${appConfig.apiBaseUrl}/v1/auth/config`, { cache: 'no-store' })
      .then(async response => {
        if (!response.ok) throw Error('Authentication configuration unavailable');
        const value: unknown = await response.json();
        if (!isAuthConfig(value)) throw Error('Invalid authentication configuration');
        return value;
      })
      .then(value => {
        if (active) setConfig(value);
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
    };
  }, [retry]);
  if (!config)
    return error ? (
      <ErrorState
        layout="page"
        status="Unavailable"
        title="We couldn’t load the sign-in settings"
        actions={
          <StateAction
            tone="primary"
            onClick={() => {
              setError(false);
              setRetry(retry + 1);
            }}
          >
            Try again
          </StateAction>
        }
      >
        OpenBinding didn’t answer how it signs people in. Try again in a moment.
      </ErrorState>
    ) : (
      <LoadingView />
    );
  return <Context.Provider value={config}>{children}</Context.Provider>;
}
