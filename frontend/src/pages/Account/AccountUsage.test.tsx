import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PricingUnavailableError, type UsageView, type UserProfile } from '../../api/auth';
import { HttpError } from '../../api/client';
import { config } from '../../config';
import { AuthContext } from '../../contexts/auth';
import { CURRENT_FIXTURE, catalogFixture } from '../Pricing/pricingFixture';
import { AccountUsage } from './AccountUsage';

const api = vi.hoisted(() => ({ getOwnUsage: vi.fn(), getPricingCatalog: vi.fn(), getCurrentPricing: vi.fn() }));
const stored = vi.hoisted(() => ({ token: null as string | null }));

vi.mock('../../api/client', async () => ({
  ...await vi.importActual<typeof import('../../api/client')>('../../api/client'),
  apiClient: api,
  getStoredPricingToken: () => stored.token,
}));

const lucia: UserProfile = {
  id: 'user-id', username: 'lucia', email: 'lucia@example.test', role: 'user', is_active: true, plan: 'BASIC', created_at: '2026-03-02T00:00:00Z',
};

const basicUsage = (): UsageView => ({
  plan: 'BASIC',
  contract_pending: false,
  features: { authoring: true, solve: true, advancedAnalytics: false, institutionalBranding: false },
  capabilities: {
    concurrentJobs: 1, federatedEngines: 1, apiKeys: 1,
    maxTimeoutSeconds: 60, maxIterations: 10_000, maxPayloadBytes: 8_388_608, maxInstanceComplexityLog10: 9, jobHistoryDays: 7,
    organizations: 1, storageBytes: 104_857_600,
  },
});

/** A pricing token the browser could hold: three parts, the middle one a JSON payload. */
const token = (expiresInSeconds: number) =>
  ['header', btoa(JSON.stringify({ sub: 'user-id', exp: Math.floor(Date.now() / 1000) + expiresInSeconds })), 'signature'].join('.');

function renderPlan(user: UserProfile = lucia) {
  render(
    <MemoryRouter>
      <AuthContext.Provider value={{ user, loading: false, signIn: vi.fn(), register: vi.fn(), signOut: vi.fn(), refresh: vi.fn(), isAdmin: false }}>
        <AccountUsage />
      </AuthContext.Provider>
    </MemoryRouter>,
  );
}

describe('Plan & permissions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stored.token = token(3600);
    api.getOwnUsage.mockResolvedValue(basicUsage());
    api.getPricingCatalog.mockResolvedValue(catalogFixture);
    api.getCurrentPricing.mockResolvedValue(CURRENT_FIXTURE);
  });

  it('shows the plan, what it costs (nothing, or an agreement) and the published pricing version', async () => {
    renderPlan();

    expect(await screen.findByRole('heading', { level: 1, name: 'Plan & permissions' })).toBeInTheDocument();
    const plan = within(await screen.findByRole('region', { name: 'Your plan' }));
    expect(plan.getByText('BASIC')).toBeInTheDocument();
    expect(await plan.findByText('Free')).toBeInTheDocument();
    expect(await plan.findByText(/Published pricing 0\.1\.0 · A new pricing version applies when your contract is renewed in SPACE/)).toBeInTheDocument();
    expect(plan.getByRole('link', { name: 'See plans' })).toHaveAttribute('href', '/pricing');
    expect(screen.getByRole('link', { name: 'Plan & permissions' })).toHaveAttribute('aria-current', 'page');
  });

  it('links to the native SPACE and SPHERE consoles and manages no price, version or contract itself', async () => {
    renderPlan();
    const section = within((await screen.findByRole('heading', { name: 'Plans, prices and contracts' })).closest('section') as HTMLElement);

    const space = section.getByRole('link', { name: 'Open SPACE console' });
    const sphere = section.getByRole('link', { name: 'Open SPHERE console' });
    expect(space).toHaveAttribute('href', config.spaceFrontendUrl);
    expect(sphere).toHaveAttribute('href', config.sphereUrl);
    for (const link of [space, sphere]) {
      expect(link).toHaveAttribute('target', '_blank');
      expect(link.getAttribute('rel')).toContain('noopener');
    }
    expect(screen.queryByRole('button', { name: /request a change|change plan|publish|upgrade/i })).not.toBeInTheDocument();
  });

  it('says what the account may do: the platform role and where the organization roles are', async () => {
    renderPlan();
    const section = within((await screen.findByRole('heading', { name: 'Your permissions' })).closest('section') as HTMLElement);

    expect(section.getByText('user')).toBeInTheDocument();
    expect(section.getByRole('link', { name: 'Your organizations and roles' })).toHaveAttribute('href', '/app');
    expect(section.getByRole('link', { name: 'Your API keys' })).toHaveAttribute('href', '/app/account/keys');
  });

  it('draws no meter and no monthly or consumed figure: nothing is counted per account', async () => {
    renderPlan();
    await screen.findByRole('heading', { name: 'What your plan allows' });

    expect(screen.queryByRole('meter')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'This month' })).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\bused\b|\bleft\b|renews \w+ \d|credits?|compute units?/i);
  });

  it('shows what the plan allows at a time, with the way to manage it', async () => {
    renderPlan();
    const section = within((await screen.findByRole('heading', { name: 'What your plan allows' })).closest('section') as HTMLElement);

    const keys = section.getByText('API keys').closest('.usage-card') as HTMLElement;
    expect(within(keys).getByText('1')).toBeInTheDocument();
    expect(within(keys).getByRole('link', { name: 'Manage keys' })).toHaveAttribute('href', '/app/account/keys');
    expect(section.getByRole('link', { name: 'My engines' })).toHaveAttribute('href', '/app/engines/registrations');
    expect(section.getByText('Jobs that may run at once')).toBeInTheDocument();
  });

  it('lists the per-request ceilings with their exact values, and links to the job history', async () => {
    renderPlan();
    const table = within(await screen.findByRole('region', { name: 'Ceilings table' }));

    expect(within(table.getByRole('row', { name: /Max time per job/ })).getByText('1 min')).toBeInTheDocument();
    expect(within(table.getByRole('row', { name: /Max time per job/ })).getByText('60 s')).toBeInTheDocument();
    expect(within(table.getByRole('row', { name: /Max package size/ })).getByText('8,388,608 bytes')).toBeInTheDocument();
    expect(within(table.getByRole('row', { name: /Max problem size/ })).getByText('10⁹')).toBeInTheDocument();
    expect(screen.getByText(/Finished jobs are kept for 7 days\./)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open job history' })).toHaveAttribute('href', '/app/jobs');
  });

  it('shows the limits across the sponsored organizations and says sponsoring is not a role', async () => {
    renderPlan();
    const section = within((await screen.findByRole('heading', { name: 'Organizations you sponsor' })).closest('section') as HTMLElement);

    expect(section.getByText(/it doesn’t give you any role in those organizations/)).toBeInTheDocument();
    expect(section.getByText('Storage')).toBeInTheDocument();
    expect(section.getByText('Up to 100 MiB')).toBeInTheDocument();
  });

  it('reads an unlimited allowance as Unlimited', async () => {
    const usage = basicUsage();
    usage.plan = 'PRO';
    usage.capabilities.apiKeys = null;
    api.getOwnUsage.mockResolvedValue(usage);
    renderPlan();

    const section = within((await screen.findByRole('heading', { name: 'What your plan allows' })).closest('section') as HTMLElement);
    const card = section.getByText('API keys').closest('.usage-card') as HTMLElement;
    expect(within(card).getByText('Unlimited')).toBeInTheDocument();
  });

  it('keeps every entitlement value reachable', async () => {
    renderPlan();
    fireEvent.click(await screen.findByText('All entitlement values'));
    expect(screen.getByText('storageBytes')).toBeInTheDocument();
  });

  describe('features and the pricing token', () => {
    it('shows each feature as enabled or not in the plan when the token is valid', async () => {
      renderPlan();
      const section = within((await screen.findByRole('heading', { name: 'Features' })).closest('section') as HTMLElement);

      expect(section.getByText('Confirmed by your plan check')).toBeInTheDocument();
      expect(section.getByText('Authoring').closest('li')).toHaveTextContent('Enabled');
      expect(section.getByText('Advanced analytics').closest('li')).toHaveTextContent('Not in plan');
      expect(section.queryByRole('status')).not.toBeInTheDocument();
    });

    it('warns in plain words that an expired token cannot confirm features, and never shows the token', async () => {
      stored.token = token(-60);
      renderPlan();
      const section = within((await screen.findByRole('heading', { name: 'Features' })).closest('section') as HTMLElement);

      expect(section.getByText('Plan check expired · can’t confirm')).toBeInTheDocument();
      expect(section.getByRole('status')).toHaveTextContent('Your plan check has expired, so features can’t be confirmed from it right now');
      expect(section.getByText('Authoring').closest('li')).toHaveTextContent('Can’t confirm');
      expect(document.body.textContent).not.toContain(stored.token);
      expect(document.body.textContent).not.toMatch(/\bsignature\b/);
    });

    it('warns that a missing token cannot confirm features', async () => {
      stored.token = null;
      renderPlan();
      const section = within((await screen.findByRole('heading', { name: 'Features' })).closest('section') as HTMLElement);

      expect(section.getByText('Can’t confirm features')).toBeInTheDocument();
      expect(section.getByRole('status')).toHaveTextContent('No plan check is available yet');
      expect(section.getByText('Solve').closest('li')).toHaveTextContent('Can’t confirm');
    });

    it('says the contract is pending and shows nothing as allowed or blocked', async () => {
      const usage = basicUsage();
      usage.contract_pending = true;
      api.getOwnUsage.mockResolvedValue(usage);
      renderPlan();

      expect(await screen.findByText('Your contract is pending.')).toBeInTheDocument();
      expect(screen.getByText('Contract pending')).toBeInTheDocument();
      expect(screen.getByText('Authoring').closest('li')).toHaveTextContent('Can’t confirm');
      expect(screen.queryByRole('heading', { name: 'What your plan allows' })).not.toBeInTheDocument();
    });
  });

  it('says so when the plan declares no limits', async () => {
    api.getOwnUsage.mockResolvedValue({ ...basicUsage(), capabilities: {} });
    renderPlan();
    expect(await screen.findByText('Your plan declares no limits.')).toBeInTheDocument();
  });

  it('reads an answer that carries no limits at all, as the gateway sends it when there are none', async () => {
    api.getOwnUsage.mockResolvedValue({ plan: 'BASIC', contract_pending: false, features: {} });
    renderPlan();
    expect(await screen.findByText('Your plan declares no limits.')).toBeInTheDocument();
  });

  it('does not show old figures when pricing is unavailable (503), keeps the console links, and tries again on request', async () => {
    api.getOwnUsage.mockRejectedValueOnce(new PricingUnavailableError('SPACE is down'));
    renderPlan();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('We can’t read your plan right now (503 · pricing_unavailable).');
    expect(alert).toHaveTextContent('this doesn’t mean your plan has changed');
    expect(screen.queryByRole('heading', { name: 'What your plan allows' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open SPACE console' })).toHaveAttribute('href', config.spaceFrontendUrl);

    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'What your plan allows' })).toBeInTheDocument();
  });

  it('explains a refused read (403)', async () => {
    api.getOwnUsage.mockRejectedValue(new HttpError(403, 'forbidden'));
    renderPlan();
    expect(await screen.findByRole('alert')).toHaveTextContent('account:read');
  });

  it('asks the gateway again when refreshed', async () => {
    renderPlan();
    await screen.findByRole('heading', { name: 'What your plan allows' });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh plan' }));

    await waitFor(() => expect(api.getOwnUsage).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole('heading', { name: 'What your plan allows' })).toBeInTheDocument();
  });

  it('still works when the pricing catalog cannot be read', async () => {
    api.getPricingCatalog.mockRejectedValue(new HttpError(503, 'down'));
    renderPlan();

    expect(await screen.findByRole('heading', { name: 'What your plan allows' })).toBeInTheDocument();
    expect(screen.getByText('Authoring')).toBeInTheDocument();
    expect(screen.queryByText('Free')).not.toBeInTheDocument();
  });
});
