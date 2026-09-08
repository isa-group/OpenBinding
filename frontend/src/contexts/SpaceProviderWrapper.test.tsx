import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Feature, On, Default } from 'space-react-client';
import type { UserProfile } from '../api/auth';
import { PRICING_TOKEN_UPDATED_EVENT } from '../api/client';
import { SpaceProviderWrapper } from './SpaceProviderWrapper';

const auth = vi.hoisted(() => ({
  user: null as UserProfile | null,
}));

const api = vi.hoisted(() => ({
  getPricingToken: vi.fn(),
}));

vi.mock('./auth', () => ({
  useAuth: () => auth,
}));

vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return {
    ...actual,
    apiClient: api,
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
    localStorage.clear();
    auth.user = null;
    api.getPricingToken.mockResolvedValue(null);
  });

  it('hydrates TokenService from localStorage on mount for signed-in user', async () => {
    auth.user = {
      id: 'alice-id',
      username: 'alice',
      email: 'alice@example.test',
      role: 'user',
      plan: 'FREE',
      is_active: true,
      created_at: '2026-01-01T00:00:00Z',
    };

    const token = makeToken({
      'openbinding-authoring': { eval: true },
    });
    localStorage.setItem('pricingToken', token);

    render(
      <SpaceProviderWrapper>
        <Feature id="openbinding-authoring">
          <On><span>Feature Active</span></On>
          <Default><span>Feature Inactive</span></Default>
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
    };

    render(
      <SpaceProviderWrapper>
        <Feature id="openbinding-solve">
          <On><span>Solve Active</span></On>
          <Default><span>Solve Inactive</span></Default>
        </Feature>
      </SpaceProviderWrapper>
    );

    const freshToken = makeToken({
      'openbinding-solve': { eval: true },
    });

    window.dispatchEvent(
      new CustomEvent(PRICING_TOKEN_UPDATED_EVENT, { detail: freshToken })
    );

    await waitFor(() => {
      expect(screen.getByText('Solve Active')).toBeInTheDocument();
    });
  });
});
