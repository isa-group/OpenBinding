import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Feature, On, Default } from 'space-react-client';
import type { UserProfile } from '../../core/api/account';
import { PRICING_TOKEN_UPDATED_EVENT, setPricingToken } from '../../core/api/http';
import { SpaceProviderWrapper } from './SpaceProviderWrapper';

const auth = vi.hoisted(() => ({
  user: null as UserProfile | null,
}));

const api = vi.hoisted(() => ({
  getPricingToken: vi.fn(),
}));

vi.mock('../../auth/hooks/useAuth', () => ({
  useAuth: () => auth,
}));

vi.mock('../api/planClient', async importOriginal => {
  const actual = await importOriginal<typeof import('../api/planClient')>();
  return {
    ...actual,
    planClient: api,
  };
});

function makeToken(features: Record<string, { eval: boolean }>): string {
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = btoa(
    JSON.stringify({
      sub: 'alice-id',
      exp: Math.floor(Date.now() / 1000) + 3600 * 24,
      features,
    })
  );
  return `${header}.${payload}.mock-signature`;
}

describe('SpaceProviderWrapper', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setPricingToken(null);
    auth.user = null;
    api.getPricingToken.mockResolvedValue(null);
  });

  it('hydrates TokenService from the token the page holds in memory, for a signed-in user', async () => {
    auth.user = {
      id: 'alice-id',
      username: 'alice',
      email: 'alice@example.test',
      role: 'user',
      plan: 'FREE',
      is_active: true,
      created_at: '2026-01-01T00:00:00Z',
      cas_verified: false,
      email_verified: false,
      institutional_email: false,
    };

    const token = makeToken({
      'openbinding-authoring': { eval: true },
    });
    setPricingToken(token);

    render(
      <SpaceProviderWrapper>
        <Feature id="openbinding-authoring">
          <On>
            <span>Feature Active</span>
          </On>
          <Default>
            <span>Feature Inactive</span>
          </Default>
        </Feature>
      </SpaceProviderWrapper>
    );

    expect(await screen.findByText('Feature Active')).toBeInTheDocument();
  });

  it('updates TokenService when PRICING_TOKEN_UPDATED_EVENT fires', async () => {
    auth.user = {
      id: 'alice-id',
      username: 'alice',
      email: 'alice@example.test',
      role: 'user',
      plan: 'FREE',
      is_active: true,
      created_at: '2026-01-01T00:00:00Z',
      cas_verified: false,
      email_verified: false,
      institutional_email: false,
    };

    render(
      <SpaceProviderWrapper>
        <Feature id="openbinding-solve">
          <On>
            <span>Solve Active</span>
          </On>
          <Default>
            <span>Solve Inactive</span>
          </Default>
        </Feature>
      </SpaceProviderWrapper>
    );

    const freshToken = makeToken({
      'openbinding-solve': { eval: true },
    });

    window.dispatchEvent(new CustomEvent(PRICING_TOKEN_UPDATED_EVENT, { detail: freshToken }));

    await waitFor(() => {
      expect(screen.getByText('Solve Active')).toBeInTheDocument();
    });
  });
});
