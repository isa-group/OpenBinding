import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PricingUnavailableError, type UsageView, type UserProfile } from '../../api/auth';
import { HttpError } from '../../api/client';
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

const limit = (id: string, value: number, used: number, unit: string, renews: string | null = null) => ({
  limit_id: id, limit: value, used, remaining: Math.max(0, value - used), unit, renews_at: renews,
});

const RENEWS = '2026-11-01T00:00:00Z';

const basicUsage = (): UsageView => ({
  plan: 'BASIC',
  contract_pending: false,
  features: { authoring: true, solve: true, advancedAnalytics: false, institutionalBranding: false },
  capabilities: {
    studyRuns: 3, concurrentJobs: 1, federatedEngines: 1, apiKeys: 1,
    maxTimeoutSeconds: 60, maxIterations: 10_000, maxPayloadBytes: 8_388_608, maxInstanceComplexityLog10: 9, jobHistoryDays: 7,
    organizations: 1, storageBytes: 104_857_600,
  },
  limits: {
    studyRuns: limit('studyRuns', 3, 3, 'run/month', RENEWS),
    concurrentJobs: limit('concurrentJobs', 1, 1, 'job'),
    apiKeys: limit('apiKeys', 1, 1, 'key'),
    maxTimeoutSeconds: limit('maxTimeoutSeconds', 60, 0, 'second'),
    maxPayloadBytes: limit('maxPayloadBytes', 8_388_608, 0, 'byte'),
    maxInstanceComplexityLog10: limit('maxInstanceComplexityLog10', 9, 0, 'log10 combinations'),
    jobHistoryDays: limit('jobHistoryDays', 7, 0, 'day'),
    organizations: limit('organizations', 1, 1, 'organization'),
    storageBytes: limit('storageBytes', 104_857_600, 52_428_800, 'byte'),
  },
});

/** A pricing token the browser could hold: three parts, the middle one a JSON payload. */
const token = (expiresInSeconds: number) =>
  ['header', btoa(JSON.stringify({ sub: 'user-id', exp: Math.floor(Date.now() / 1000) + expiresInSeconds })), 'signature'].join('.');

function renderUsage(user: UserProfile = lucia) {
  render(
    <MemoryRouter>
      <AuthContext.Provider value={{ user, loading: false, signIn: vi.fn(), register: vi.fn(), signOut: vi.fn(), refresh: vi.fn(), isAdmin: false }}>
        <AccountUsage />
      </AuthContext.Provider>
    </MemoryRouter>,
  );
}

describe('Usage & plan', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stored.token = token(3600);
    api.getOwnUsage.mockResolvedValue(basicUsage());
    api.getPricingCatalog.mockResolvedValue(catalogFixture);
    api.getCurrentPricing.mockResolvedValue(CURRENT_FIXTURE);
  });

  it('shows the plan, what it costs (nothing, or an agreement), the live pricing and when the month renews', async () => {
    renderUsage();

    expect(await screen.findByRole('heading', { level: 1, name: 'Usage & plan' })).toBeInTheDocument();
    const plan = within(await screen.findByRole('region', { name: 'Your plan' }));
    expect(plan.getByText('BASIC')).toBeInTheDocument();
    expect(await plan.findByText('Free')).toBeInTheDocument();
    expect(await plan.findByText(/Live pricing 0\.1\.0 · Monthly allowances renew Nov 1, 2026 · New pricing versions apply when your contract renews/)).toBeInTheDocument();
    expect(plan.getByRole('link', { name: 'See plans' })).toHaveAttribute('href', '/pricing');
    expect(plan.getByRole('link', { name: 'Request a change' })).toHaveAttribute('href', '/pricing');
    expect(screen.getByRole('link', { name: 'Usage & plan' })).toHaveAttribute('aria-current', 'page');
  });

  it('draws the monthly allowances with what is left, and says what a used-up one stops', async () => {
    renderUsage();
    await screen.findByRole('heading', { name: 'This month' });

    expect(screen.getByText(/Renews Nov 1, 2026 \(in \d+ days\)\./)).toBeInTheDocument();
    const runs = screen.getByRole('meter', { name: 'Study runs' });
    expect(runs).toHaveAttribute('aria-valuenow', '3');
    expect(runs).toHaveAttribute('aria-valuemax', '3');

    expect(screen.getAllByText('0 left')).toHaveLength(1);
    expect(screen.getByText('Used up. New study runs can’t start until it renews; a request now gets a 402.')).toBeInTheDocument();
  });

  it('does not invent what was used for an allowance the gateway does not count', async () => {
    const usage = basicUsage();
    delete usage.limits.studyRuns;
    api.getOwnUsage.mockResolvedValue(usage);
    renderUsage();
    await screen.findByRole('heading', { name: 'This month' });

    const card = screen.getByText('Study runs').closest('.usage-card') as HTMLElement;
    expect(within(card).getByText('Used: not reported')).toBeInTheDocument();
    expect(within(card).getByText('3 limit')).toBeInTheDocument();
  });

  it('shows the capacity in use with the way to manage it', async () => {
    renderUsage();
    const section = within((await screen.findByRole('heading', { name: 'Capacity in use' })).closest('section') as HTMLElement);

    expect(section.getByText('API keys')).toBeInTheDocument();
    expect(section.getAllByText('1 / 1')).toHaveLength(2);
    expect(section.getByText('– / 1')).toBeInTheDocument();
    expect(section.getByText(/Engine revisions in use · used not reported/)).toBeInTheDocument();
    expect(section.getByRole('link', { name: 'Manage keys' })).toHaveAttribute('href', '/app/account/keys');
    expect(section.getByRole('link', { name: 'My engines' })).toHaveAttribute('href', '/app/engines/registrations');
  });

  it('lists the per-request ceilings with their exact values, and links to the job history', async () => {
    renderUsage();
    const table = within(await screen.findByRole('region', { name: 'Ceilings table' }));

    expect(within(table.getByRole('row', { name: /Max time per job/ })).getByText('1 min')).toBeInTheDocument();
    expect(within(table.getByRole('row', { name: /Max time per job/ })).getByText('60 s')).toBeInTheDocument();
    expect(within(table.getByRole('row', { name: /Max package size/ })).getByText('8,388,608 bytes')).toBeInTheDocument();
    expect(within(table.getByRole('row', { name: /Max problem size/ })).getByText('10⁹')).toBeInTheDocument();
    expect(screen.getByText(/Finished jobs are kept for 7 days\./)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open job history' })).toHaveAttribute('href', '/app/jobs');
  });

  it('shows the sponsored limits and says sponsoring is not a role', async () => {
    renderUsage();
    const section = within((await screen.findByRole('heading', { name: 'Organizations you sponsor' })).closest('section') as HTMLElement);

    expect(section.getByText(/it doesn’t give you any role in those organizations/)).toBeInTheDocument();
    expect(section.getByRole('meter', { name: 'Storage' })).toHaveAttribute('aria-valuenow', '52428800');
    expect(section.getByText('50 MiB / 100 MiB')).toBeInTheDocument();
  });

  it('reads an unlimited allowance as Unlimited', async () => {
    const usage = basicUsage();
    usage.plan = 'PRO';
    usage.capabilities.studyRuns = null;
    delete usage.limits.studyRuns;
    api.getOwnUsage.mockResolvedValue(usage);
    renderUsage();

    await screen.findByRole('heading', { name: 'This month' });
    const card = screen.getByText('Study runs').closest('.usage-card') as HTMLElement;
    expect(within(card).getByText('Unlimited')).toBeInTheDocument();
  });

  it('keeps every entitlement value reachable', async () => {
    renderUsage();
    fireEvent.click(await screen.findByText('All entitlement values'));
    expect(screen.getByText('storageBytes')).toBeInTheDocument();
  });

  describe('features and the pricing token', () => {
    it('shows each feature as enabled or not in the plan when the token is valid', async () => {
      renderUsage();
      const section = within((await screen.findByRole('heading', { name: 'Features' })).closest('section') as HTMLElement);

      expect(section.getByText('From your usage')).toBeInTheDocument();
      expect(section.getByText('Authoring').closest('li')).toHaveTextContent('Enabled');
      expect(section.getByText('Advanced analytics').closest('li')).toHaveTextContent('Not in plan');
      expect(section.queryByRole('status')).not.toBeInTheDocument();
    });

    it('warns in plain words that an expired token cannot confirm features, and never shows the token', async () => {
      stored.token = token(-60);
      renderUsage();
      const section = within((await screen.findByRole('heading', { name: 'Features' })).closest('section') as HTMLElement);

      expect(section.getByText('Plan check expired · can’t confirm')).toBeInTheDocument();
      expect(section.getByRole('status')).toHaveTextContent('Your plan check has expired, so features can’t be confirmed from it right now');
      expect(section.getByText('Authoring').closest('li')).toHaveTextContent('Can’t confirm');
      expect(document.body.textContent).not.toContain(stored.token);
      expect(document.body.textContent).not.toMatch(/\bsignature\b/);
    });

    it('warns that a missing token cannot confirm features', async () => {
      stored.token = null;
      renderUsage();
      const section = within((await screen.findByRole('heading', { name: 'Features' })).closest('section') as HTMLElement);

      expect(section.getByText('Can’t confirm features')).toBeInTheDocument();
      expect(section.getByRole('status')).toHaveTextContent('No plan check is available yet');
      expect(section.getByText('Solve').closest('li')).toHaveTextContent('Can’t confirm');
    });

    it('says the contract is pending and shows nothing as allowed or blocked', async () => {
      const usage = basicUsage();
      usage.contract_pending = true;
      api.getOwnUsage.mockResolvedValue(usage);
      renderUsage();

      expect(await screen.findByText('Your contract is pending.')).toBeInTheDocument();
      expect(screen.getByText('Contract pending')).toBeInTheDocument();
      expect(screen.getByText('Authoring').closest('li')).toHaveTextContent('Can’t confirm');
      expect(screen.queryByRole('heading', { name: 'This month' })).not.toBeInTheDocument();
    });
  });

  it('says so when the plan declares no limits', async () => {
    api.getOwnUsage.mockResolvedValue({ ...basicUsage(), capabilities: {}, limits: {} });
    renderUsage();
    expect(await screen.findByText('Your plan declares no usage limits, so there’s nothing to track here.')).toBeInTheDocument();
  });

  it('does not show old figures when pricing is unavailable (503), and tries again on request', async () => {
    api.getOwnUsage.mockRejectedValueOnce(new PricingUnavailableError('SPACE is down'));
    renderUsage();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('We can’t read your usage right now (503 · pricing_unavailable).');
    expect(alert).toHaveTextContent('this doesn’t mean you’re out of quota');
    expect(screen.queryByRole('heading', { name: 'This month' })).not.toBeInTheDocument();

    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'This month' })).toBeInTheDocument();
  });

  it('explains a refused read (403)', async () => {
    api.getOwnUsage.mockRejectedValue(new HttpError(403, 'forbidden'));
    renderUsage();
    expect(await screen.findByRole('alert')).toHaveTextContent('account:read');
  });

  it('asks the gateway again when refreshed', async () => {
    renderUsage();
    await screen.findByRole('heading', { name: 'This month' });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh usage' }));

    await waitFor(() => expect(api.getOwnUsage).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole('heading', { name: 'This month' })).toBeInTheDocument();
  });

  it('still works when the pricing catalog cannot be read', async () => {
    api.getPricingCatalog.mockRejectedValue(new HttpError(503, 'down'));
    renderUsage();

    expect(await screen.findByRole('heading', { name: 'This month' })).toBeInTheDocument();
    expect(screen.getByText('Authoring')).toBeInTheDocument();
    expect(screen.queryByText('Free')).not.toBeInTheDocument();
  });
});
