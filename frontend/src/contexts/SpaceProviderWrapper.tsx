import { useEffect, type ReactNode } from 'react';
import { SpaceProvider, useTokenService } from 'space-react-client';
import { useAuth } from './auth';
import { apiClient, getStoredPricingToken, PRICING_TOKEN_UPDATED_EVENT } from '../api/client';

const TOKEN_ONLY_SPACE_CONFIG = {
  url: '',
  apiKey: '',
  allowConnectionWithSpace: false,
};

function SpaceTokenSync({ children }: { children: ReactNode }) {
  const tokenService = useTokenService();
  const { user } = useAuth();

  useEffect(() => {
    if (!user) return;

    // 1. Immediately hydrate from localStorage if available to avoid flicker
    const stored = getStoredPricingToken();
    if (stored) {
      try {
        tokenService.update(stored);
      } catch {
        localStorage.removeItem('pricingToken');
      }
    }

    // 2. Fetch fresh token in background
    let cancelled = false;
    apiClient
      .getPricingToken()
      .then((token) => {
        if (!cancelled && token) {
          try {
            tokenService.update(token);
          } catch (err) {
            console.warn('Failed to parse pricing token from backend', err);
          }
        }
      })
      .catch(() => {
        // Fallback to cached or empty token
      });

    // 3. Listen to token updates across the session
    const handleTokenUpdated = (event: Event) => {
      const customEvent = event as CustomEvent<string>;
      if (customEvent.detail) {
        try {
          tokenService.update(customEvent.detail);
        } catch (err) {
          console.warn('Failed to parse updated pricing token', err);
        }
      }
    };

    window.addEventListener(PRICING_TOKEN_UPDATED_EVENT, handleTokenUpdated);
    return () => {
      cancelled = true;
      window.removeEventListener(PRICING_TOKEN_UPDATED_EVENT, handleTokenUpdated);
    };
  }, [user, tokenService]);

  return <>{children}</>;
}

/**
 * Root wrapper integrating SPACE React client feature gating.
 *
 * In OpenBinding, the browser never speaks directly to SPACE: tokens are minted
 * by the backend gateway. By setting `allowConnectionWithSpace: false`, SpaceProvider
 * runs in lightweight token-only evaluation mode without opening WebSockets.
 *
 * The `key` ensures that when the user logs out or switches accounts, the in-memory
 * TokenService is cleanly destroyed and re-instantiated.
 */
export function SpaceProviderWrapper({ children }: { children: ReactNode }) {
  const { user } = useAuth();

  return (
    <SpaceProvider
      key={user ? user.id : 'anonymous'}
      config={TOKEN_ONLY_SPACE_CONFIG}
    >
      <SpaceTokenSync>{children}</SpaceTokenSync>
    </SpaceProvider>
  );
}
