import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEffect, type ReactNode } from 'react';
import { SpaceProvider, useTokenService } from 'space-react-client';
import type { UserProfile } from '../../api/auth';
import { Pricing } from './Pricing';
import sourcePricingYaml from '../../../../space/pricing/openbinding.yml?raw';

const api = vi.hoisted(() => ({
  getPricingDocument: vi.fn(),
  getPricingToken: vi.fn(),
}));

const auth = vi.hoisted(() => ({
  user: null as UserProfile | null,
}));

vi.mock('../../api/client', () => ({
  apiClient: api,
  getStoredPricingToken: () => null,
  PRICING_TOKEN_UPDATED_EVENT: 'openbinding:pricing-token-updated',
}));

vi.mock('../../contexts/auth', () => ({
  useAuth: () => auth,
}));

vi.mock('../../contexts/theme', () => ({
  useTheme: () => ({ theme: 'light', toggleTheme: vi.fn() }),
}));

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

function TestSpaceHarness({
  token,
  children,
}: {
  token?: string;
  children: ReactNode;
}) {
  return (
    <SpaceProvider config={{ url: '', apiKey: '', allowConnectionWithSpace: false }}>
      <TokenUpdater token={token} />
      <>{children}</>
    </SpaceProvider>
  );
}

function TokenUpdater({ token }: { token?: string }) {
  const tokenService = useTokenService();
  useEffect(() => {
    if (token) {
      tokenService.update(token);
    }
  }, [token, tokenService]);
  return null;
}

describe('Pricing page with space-react-client feature gating', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.user = null;
    api.getPricingDocument.mockResolvedValue(sourcePricingYaml);
  });

  it('renders pricing hero and catalog for anonymous visitors without feature access section', async () => {
    render(
      <MemoryRouter>
        <TestSpaceHarness>
          <Pricing />
        </TestSpaceHarness>
      </MemoryRouter>
    );

    expect(await screen.findByText('Solve as much as you need to')).toBeInTheDocument();
    expect(screen.getByText(/Create an account/i)).toBeInTheDocument();
    expect(screen.queryByText('Available to your account')).not.toBeInTheDocument();
  });

  it('evaluates signed features as Enabled when true in SPACE token', async () => {
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
      'openbinding-solve': { eval: false },
    });

    render(
      <MemoryRouter>
        <TestSpaceHarness token={token}>
          <Pricing />
        </TestSpaceHarness>
      </MemoryRouter>
    );

    expect(await screen.findByText('Available to your account')).toBeInTheDocument();

    await waitFor(() => {
      const enabledBadges = screen.getAllByText('Enabled');
      expect(enabledBadges.length).toBeGreaterThanOrEqual(1);
    });

    await waitFor(() => {
      const disabledBadges = screen.getAllByText('Not enabled');
      expect(disabledBadges.length).toBeGreaterThanOrEqual(1);
    });
  });

  it('shows error fallback (Unavailable) when token is not provided or invalid', async () => {
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
      <MemoryRouter>
        <TestSpaceHarness>
          <Pricing />
        </TestSpaceHarness>
      </MemoryRouter>
    );

    expect(await screen.findByText('Available to your account')).toBeInTheDocument();

    await waitFor(() => {
      const unavailableBadges = screen.getAllByText('Unavailable');
      expect(unavailableBadges.length).toBeGreaterThanOrEqual(1);
    });
  });
});
