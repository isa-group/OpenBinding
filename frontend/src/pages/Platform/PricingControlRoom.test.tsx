import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { platformApi } from '../../api/platform';
import { PricingControlRoomPage } from './PricingControlRoom';
import { config } from '../../config';

vi.mock('../../api/platform', () => ({
  platformApi: {
    pricingControlRoom: vi.fn(),
    previewPricing: vi.fn(),
    validatePricing: vi.fn(),
    syncPricing: vi.fn(),
    createPricingDraft: vi.fn(),
    publishPricing: vi.fn(),
    forkPricing: vi.fn(),
    deletePricingDraft: vi.fn(),
    pricingAction: vi.fn(),
    archivePricing: vi.fn(),
  },
}));

vi.mock('../../contexts/theme', () => ({
  useTheme: () => ({ theme: 'light', toggleTheme: vi.fn() }),
}));

describe('PricingControlRoomPage external SPACE integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(platformApi.pricingControlRoom).mockResolvedValue({
      live: '0.1.0',
      sphere: { reachable: true, enabled: true },
      space: { reachable: true, enabled: true },
      divergence: { onlyInSphere: [], onlyLocal: [] },
      releases: [
        {
          id: 'rel-1',
          version: '0.1.0',
          digest: 'sha256-abc',
          sphere_state: 'PUBLIC_RELEASE',
          space_state: 'ACTIVE',
          is_live: true,
          created_at: '2026-09-01T00:00:00Z',
        } as unknown as import('../../api/platform').PricingRelease,
      ],
    } as unknown as import('../../api/platform').PricingControlRoom);
    vi.mocked(platformApi.previewPricing).mockResolvedValue('name: openbinding\nversion: 0.1.0\n');
  });

  it('renders Open SPACE Console header button with external link and target blank', async () => {
    render(
      <MemoryRouter>
        <PricingControlRoomPage />
      </MemoryRouter>,
    );

    const consoleBtn = await screen.findByRole('link', { name: /Open SPACE Console/i });
    expect(consoleBtn).toBeInTheDocument();
    expect(consoleBtn).toHaveAttribute('href', config.spaceFrontendUrl);
    expect(consoleBtn).toHaveAttribute('target', '_blank');
    expect(consoleBtn).toHaveAttribute('rel', 'noreferrer');
  });

  it('renders Manage in SPACE link within the SPACE 1.5 health card', async () => {
    render(
      <MemoryRouter>
        <PricingControlRoomPage />
      </MemoryRouter>,
    );

    const cardLink = await screen.findByRole('link', { name: /Manage in SPACE/i });
    expect(cardLink).toBeInTheDocument();
    expect(cardLink).toHaveAttribute('href', config.spaceFrontendUrl);
    expect(cardLink).toHaveAttribute('target', '_blank');
    expect(cardLink).toHaveAttribute('rel', 'noreferrer');
  });
});
