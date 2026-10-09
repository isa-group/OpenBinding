import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEffect, type ReactNode } from 'react';
import { SpaceProvider, useTokenService } from 'space-react-client';
import { PricingUnavailableError, type UserProfile } from '../../api/auth';
import { HttpError } from '../../api/client';
import { AuthContext } from '../../contexts/auth';
import { CURRENT_FIXTURE, catalogFixture } from './pricingFixture';
import { Pricing } from './Pricing';

const api = vi.hoisted(() => ({
  getPricingCatalog: vi.fn(),
  getCurrentPricing: vi.fn(),
  getPricingToken: vi.fn(),
}));

const stored = vi.hoisted(() => ({ token: null as string | null }));

vi.mock('../../api/client', async () => ({
  ...await vi.importActual<typeof import('../../api/client')>('../../api/client'),
  apiClient: api,
  getStoredPricingToken: () => stored.token,
}));

const person = (plan: string): UserProfile => ({
  id: 'alice-id', username: 'alice', email: 'alice@example.test', role: 'user', plan, is_active: true, created_at: '2026-01-01T00:00:00Z',
});

function makeToken(features: Record<string, { eval: boolean }>): string {
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = btoa(JSON.stringify({ sub: 'alice-id', exp: Math.floor(Date.now() / 1000) + 3600 * 24, features }));
  return `${header}.${payload}.mock-signature`;
}

function TokenUpdater({ token }: { token?: string }) {
  const tokenService = useTokenService();
  useEffect(() => {
    if (token) tokenService.update(token);
  }, [token, tokenService]);
  return null;
}

function renderPricing(user: UserProfile | null = null, token?: string) {
  const wrap = (children: ReactNode) => (
    <MemoryRouter>
      <AuthContext.Provider value={{ user, loading: false, signIn: vi.fn(), register: vi.fn(), signOut: vi.fn(), refresh: vi.fn(), isAdmin: false }}>
        <SpaceProvider config={{ url: '', apiKey: '', allowConnectionWithSpace: false }}>
          <TokenUpdater token={token} />
          {children}
        </SpaceProvider>
      </AuthContext.Provider>
    </MemoryRouter>
  );
  return render(wrap(<Pricing />));
}

const heading = () => screen.findByRole('heading', { level: 1, name: 'Plans for every kind of binding work' });

describe('Pricing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stored.token = null;
    api.getPricingCatalog.mockResolvedValue(catalogFixture);
    api.getCurrentPricing.mockResolvedValue(CURRENT_FIXTURE);
  });

  it('reads the live catalog and release, not the deprecated pricing document', async () => {
    renderPricing();
    await heading();
    expect(await screen.findByText('Compare all')).toBeInTheDocument();

    expect(api.getPricingCatalog).toHaveBeenCalledTimes(1);
    expect(api.getCurrentPricing).toHaveBeenCalledTimes(1);
    expect(api.getPricingToken).not.toHaveBeenCalled();
  });

  it('labels the release: version, date, currency, fingerprint and the development copy', async () => {
    renderPricing();
    await heading();

    expect(await screen.findByText(/Pricing version/)).toHaveTextContent('Pricing version 0.1.0');
    expect(screen.getByText('Published Sep 1, 2026')).toBeInTheDocument();
    expect(screen.getByText('EUR · monthly periods')).toBeInTheDocument();
    expect(screen.getByText('Fingerprint a1b2…c3d4')).toBeInTheDocument();
    expect(screen.getByText('Development pricing.')).toBeInTheDocument();
    expect(screen.getByText(/0\.1\.0 development copy and aren’t verified against the live pricing/)).toBeInTheDocument();
  });

  it('offers no price and no checkout: paid plans say Contact us, free ones Free', async () => {
    renderPricing();
    await heading();
    const plans = within(await screen.findByRole('list', { name: 'Plans' }));

    expect(plans.getAllByText('Contact us')).toHaveLength(2 + 2);
    expect(plans.getAllByText('institutional agreement')).toHaveLength(2);
    expect(plans.getAllByText('Free')).toHaveLength(2);
    expect(plans.getByText('with verified CAS')).toBeInTheDocument();
    expect(screen.getByText(/there’s no checkout/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/[€$]\s?\d/);
    expect(screen.queryByRole('link', { name: /checkout|buy|subscribe/i })).not.toBeInTheDocument();
  });

  it('sends a visitor to sign up or to log in with CAS', async () => {
    renderPricing();
    await heading();

    expect(await screen.findByRole('link', { name: 'Sign up' })).toHaveAttribute('href', '/register');
    expect(screen.getAllByRole('link', { name: 'Log in with CAS' }).every((link) => link.getAttribute('href') === '/login')).toBe(true);
    expect(screen.queryByText('Available to your account')).not.toBeInTheDocument();
    expect(screen.queryByText('Your current plan')).not.toBeInTheDocument();
  });

  it('shows the monthly limits open, with the rounded figure and the exact one under it', async () => {
    renderPricing();
    await heading();
    const monthly = within(await screen.findByRole('table', { name: 'Monthly: Renew each month' }));

    const solverTime = within(monthly.getByRole('row', { name: /Solver time/ }));
    expect(solverTime.getByText('15 min')).toBeInTheDocument();
    expect(solverTime.getByText('900 s')).toBeInTheDocument();
    expect(solverTime.getByText('50 h')).toBeInTheDocument();
    expect(within(monthly.getByRole('row', { name: /^Solves/ })).getByText('Unlimited')).toBeInTheDocument();
    const capacityUnits = monthly.getByRole('row', { name: /Capacity units/ });
    expect(within(capacityUnits).getByText('To confirm')).toBeInTheDocument();
    expect(within(capacityUnits).getByText('Applies to')).toBeInTheDocument();
  });

  it('opens and closes the groups of rows', async () => {
    renderPricing();
    await heading();
    const perRequest = await screen.findByRole('button', { name: /Per request/ });
    expect(perRequest).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('table', { name: /Per request/ })).not.toBeInTheDocument();

    fireEvent.click(perRequest);
    const table = within(screen.getByRole('table', { name: 'Per request: Ceilings for each job' }));
    expect(table.getByText('8 MiB')).toBeInTheDocument();
    expect(table.getByText('8,388,608 bytes')).toBeInTheDocument();
    expect(table.getAllByText('Unlimited')).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: /Monthly/ }));
    expect(screen.queryByRole('table', { name: /Monthly/ })).not.toBeInTheDocument();
  });

  it('highlights one plan, or compares them all', async () => {
    renderPricing();
    await heading();
    const pro = await screen.findByRole('button', { name: 'PRO' });
    expect(screen.getByRole('button', { name: 'Compare all' })).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(pro);

    expect(pro).toHaveAttribute('aria-pressed', 'true');
    expect(document.querySelectorAll('td.is-picked').length).toBeGreaterThan(0);
    expect(document.querySelectorAll('.pricing-plan-tile.is-picked')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Compare all' }));
    expect(document.querySelectorAll('td.is-picked')).toHaveLength(0);
  });

  it('explains what has to have room before a solve, a federated solve and a study run', async () => {
    renderPricing();
    await heading();

    expect(await screen.findByRole('heading', { name: 'What has to have room before you start' })).toBeInTheDocument();
    expect(screen.getByText(/Three features also check your limits/)).toBeInTheDocument();
    const solve = screen.getByText('Start a solve').closest('.pricing-gate') as HTMLElement;
    expect(within(solve).getByText('Solves left this month')).toBeInTheDocument();
    expect(within(solve).getByText('A free job slot')).toBeInTheDocument();
    expect(within(screen.getByText('Start a study run').closest('.pricing-gate') as HTMLElement).getByText('Study runs left this month')).toBeInTheDocument();
  });

  it('explains the three outcomes of reaching a limit', async () => {
    renderPricing();
    await heading();
    const section = within((await screen.findByRole('heading', { name: 'What happens when you reach a limit' })).closest('section') as HTMLElement);

    expect(section.getByText('Reduced')).toBeInTheDocument();
    expect(section.getByText('Wait')).toBeInTheDocument();
    expect(section.getByText('Rejected')).toBeInTheDocument();
    expect(section.getByText(/OPTION_CLAMPED/)).toBeInTheDocument();
    expect(section.getByText(/402/)).toBeInTheDocument();
    expect(section.getByText(/429/)).toBeInTheDocument();
  });

  it('lists the add-ons as arranged under an agreement', async () => {
    renderPricing();
    await heading();

    expect(await screen.findByText('COMPUTE_PACK')).toBeInTheDocument();
    expect(screen.getByText(/BASIC and RESEARCH have no add-ons\./)).toBeInTheDocument();
    expect(screen.getAllByText('Contact us').length).toBeGreaterThanOrEqual(6);
    // Compute and collaboration packs are both 1–10 a month; storage goes to 20.
    expect(screen.getAllByText('For ADVANCED, PRO · 1–10 packs · per month')).toHaveLength(2);
    expect(screen.getByText('For ADVANCED, PRO · 1–20 packs · per month')).toBeInTheDocument();
    expect(screen.getByText('For ADVANCED · 1 per account · per account')).toBeInTheDocument();
  });

  it('opens a contact dialog that sends nothing, and gives focus back when it closes', async () => {
    renderPricing();
    await heading();
    const contact = (await screen.findAllByRole('button', { name: 'Contact us' }))[0];
    contact.focus();

    fireEvent.click(contact);
    const dialog = screen.getByRole('dialog', { name: 'Ask about ADVANCED' });
    expect(within(dialog).getByText(/This page doesn’t send anything/)).toBeInTheDocument();
    expect(within(dialog).queryByRole('textbox')).not.toBeInTheDocument();

    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(contact).toHaveFocus();
  });

  it('says there is no live release (404) instead of showing a catalog', async () => {
    api.getCurrentPricing.mockRejectedValue(new HttpError(404, 'No public pricing release is live.'));
    renderPricing();
    await heading();

    expect(await screen.findByText('No public pricing release is live')).toBeInTheDocument();
    expect(screen.getByText(/Accounts keep the plan they already have/)).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Plans' })).not.toBeInTheDocument();
  });

  it('hides the catalog when pricing is unavailable (503) and retries on request', async () => {
    api.getPricingCatalog.mockRejectedValueOnce(new PricingUnavailableError('SPHERE is down'));
    renderPricing();
    await heading();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('503 · pricing_unavailable');
    expect(alert).toHaveTextContent('hidden rather than showing figures we can’t verify');
    expect(screen.queryByRole('list', { name: 'Plans' })).not.toBeInTheDocument();

    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('list', { name: 'Plans' })).toBeInTheDocument();
    expect(api.getPricingCatalog).toHaveBeenCalledTimes(2);
  });

  it('refuses a document whose digest does not match (502)', async () => {
    const mismatch = new HttpError(502, 'SPHERE content no longer matches');
    mismatch.code = 'pricing_digest_mismatch';
    api.getPricingCatalog.mockRejectedValue(mismatch);
    renderPricing();
    await heading();

    expect(await screen.findByRole('alert')).toHaveTextContent('502 · pricing_digest_mismatch');
    expect(screen.queryByRole('list', { name: 'Plans' })).not.toBeInTheDocument();
  });

  it('marks the current plan of a signed-in account and offers CAS linking to the others', async () => {
    renderPricing(person('BASIC'));
    await heading();

    expect(await screen.findByText('Your current plan')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Sign up' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Link CAS identity' })).toHaveAttribute('href', '/app/account/identities');
    expect(screen.getByRole('link', { name: 'Manage identities' })).toHaveAttribute('href', '/app/account/identities');
    // A free plan has none of the add-ons, and each card says so.
    expect(screen.getAllByText('Not available on your plan')).toHaveLength(6);
  });

  it('offers no CAS link to an account that is on RESEARCH already', async () => {
    renderPricing(person('RESEARCH'));
    await heading();

    expect(await screen.findByText('Your current plan')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Link CAS identity' })).not.toBeInTheDocument();
  });

  it('evaluates the signed features as Enabled or Not enabled from the SPACE token', async () => {
    const token = makeToken({ 'openbinding-authoring': { eval: true }, 'openbinding-solve': { eval: false } });
    stored.token = token;
    renderPricing(person('ADVANCED'), token);

    expect(await screen.findByText('Available to your account')).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByText('Enabled').length).toBeGreaterThanOrEqual(1));
    await waitFor(() => expect(screen.getAllByText('Not enabled').length).toBeGreaterThanOrEqual(1));
    expect(screen.getByText('Read from your signed pricing token for the ADVANCED plan.')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(token);
  });

  it('says it cannot confirm the features when there is no token, instead of guessing', async () => {
    renderPricing(person('BASIC'));

    expect(await screen.findByText('Available to your account')).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByText('Can’t confirm').length).toBeGreaterThanOrEqual(1));
    expect(screen.getByText(/We can’t confirm your features right now, so none is shown as enabled or disabled/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'See my usage' })).toHaveAttribute('href', '/app/account/usage');
  });

  it('draws the long form of the document with pricing-renderer when asked', async () => {
    renderPricing();
    await heading();
    const toggle = await screen.findByRole('button', { name: 'Show the full pricing document' });
    expect(document.querySelector('.pricing-renderer-shell')).toBeNull();

    fireEvent.click(toggle);

    expect(await screen.findByRole('button', { name: 'Hide the full pricing document' })).toHaveAttribute('aria-expanded', 'true');
    await waitFor(() => expect(document.querySelector('.pricing-renderer-shell')).not.toBeNull());
    expect(screen.getByRole('link', { name: 'SPHERE' })).toHaveAttribute('href', CURRENT_FIXTURE.url);
  });
});
