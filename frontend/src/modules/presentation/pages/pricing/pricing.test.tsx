import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEffect, type ReactNode } from 'react';
import { SpaceProvider, useTokenService } from 'space-react-client';
import { PricingUnavailableError, type UserProfile } from '../../../core/api/account';
import { HttpError } from '../../../core/api/http';
import { PLANS_PRICING_FIXTURE, catalogFixture } from '../../../../test/fixtures/plansPricing';
import { AuthContext } from '../../../auth/hooks/useAuth';
import PricingPage from '.';

const api = vi.hoisted(() => ({
  getPlansPricing: vi.fn(),
}));

const stored = vi.hoisted(() => ({ token: null as string | null }));

vi.mock('../../../settings/api/userSettingsApi', () => ({ useUserSettingsApi: () => api }));

vi.mock('../../../core/api/http', async () => ({
  ...(await vi.importActual<typeof import('../../../core/api/http')>('../../../core/api/http')),
  getStoredPricingToken: () => stored.token,
}));

const person = (plan: string): UserProfile => ({
  id: 'alice-id',
  username: 'alice',
  email: 'alice@example.test',
  role: 'user',
  plan,
  is_active: true,
  created_at: '2026-01-01T00:00:00Z',
  cas_verified: false,
  email_verified: false,
  institutional_email: false,
});

function makeToken(
  features: Record<string, { eval: boolean }>,
  claims: Record<string, unknown> = {}
): string {
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = btoa(
    JSON.stringify({
      sub: 'alice-id',
      exp: Math.floor(Date.now() / 1000) + 3600 * 24,
      features,
      ...claims,
    })
  );
  return `${header}.${payload}.mock-signature`;
}

type RendererProps = Record<string, unknown> & {
  pricing?: { plans?: Record<string, unknown> };
  yaml?: string;
  renderPlanCta: (context: { planId: string }) => ReactNode;
  renderSummaryActions: () => ReactNode;
};

const renderer = vi.hoisted(() => ({ props: null as RendererProps | null }));

// In jsdom the element never takes its properties (it stays on PR_SOURCE_MISSING), so its drawing is the e2e
// specs' to check. This stand-in records what the page passes through the bridge and draws the page's parts where the
// element would: one call to action per plan card, then the summary actions.
vi.mock('pricing-renderer/react', async () => {
  const { createElement } = await import('react');
  return {
    PricingRenderer: (props: RendererProps) => {
      renderer.props = props;
      return createElement(
        'div',
        { 'data-testid': 'pricing-renderer' },
        Object.keys(props.pricing?.plans ?? {}).map(planId =>
          createElement(
            'div',
            { key: planId, 'data-plan': planId },
            props.renderPlanCta({ planId })
          )
        ),
        createElement('div', { 'data-testid': 'summary-actions' }, props.renderSummaryActions())
      );
    },
  };
});

/** The actions the drawn document offers, by plan. */
async function documentActions(): Promise<Record<string, HTMLElement>> {
  const drawn = await screen.findByTestId('pricing-renderer');
  return Object.fromEntries(
    [...drawn.querySelectorAll<HTMLElement>('[data-plan]')].map(slot => [slot.dataset.plan!, slot])
  );
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
      <AuthContext.Provider
        value={{
          user,
          loading: false,
          signIn: vi.fn(),
          register: vi.fn(),
          signOut: vi.fn(),
          refresh: vi.fn(),
          isAdmin: false,
          fetchWithInterceptor: vi.fn(),
        }}
      >
        <SpaceProvider config={{ url: '', apiKey: '', allowConnectionWithSpace: false }}>
          <TokenUpdater token={token} />
          {children}
        </SpaceProvider>
      </AuthContext.Provider>
    </MemoryRouter>
  );
  return render(wrap(<PricingPage />));
}

/** The published document has no add-ons; two synthetic ones show how the screen lists them. */
const withAddOns = {
  ...catalogFixture,
  addOns: {
    STORAGE_PACK: {
      description: 'Adds 5 GB of repository storage.',
      availableFor: ['LAB'],
      unit: 'pack/month',
      subscriptionConstraints: { minQuantity: 1, maxQuantity: 20 },
      usageLimitsExtensions: { maxRepositoryStorage: { value: 5000 } },
    },
    CAMPAIGN_ARCHIVE: {
      description: 'Keeps the archive of every campaign.',
      availableFor: ['RESEARCH', 'LAB'],
      unit: 'archive/account',
      subscriptionConstraints: { minQuantity: 1, maxQuantity: 1 },
    },
  },
};

/** The published pricing without its YAML: in jsdom the renderer stand-in draws the parsed document's plans. */
const PRICING = { ...PLANS_PRICING_FIXTURE, yaml: '' };

const heading = () =>
  screen.findByRole('heading', { level: 1, name: 'Plans for every kind of binding work' });

describe('PricingPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stored.token = null;
    renderer.props = null;
    api.getPlansPricing.mockResolvedValue(PRICING);
  });

  it('reads the published pricing once', async () => {
    renderPricing();
    await heading();
    expect(await screen.findByText('Compare all')).toBeInTheDocument();

    expect(api.getPlansPricing).toHaveBeenCalledTimes(1);
  });

  it('hands the renderer the published YAML when it can read it', async () => {
    api.getPlansPricing.mockResolvedValue(PLANS_PRICING_FIXTURE);
    renderPricing();
    await heading();
    await screen.findByTestId('pricing-renderer');

    expect(renderer.props?.yaml).toBe(PLANS_PRICING_FIXTURE.yaml);
    expect(renderer.props).not.toHaveProperty('pricing');
  });

  it('labels the release: version, date, currency and the development copy', async () => {
    renderPricing();
    await heading();

    expect(await screen.findByText(/Pricing version/)).toHaveTextContent('Pricing version 0.2.0');
    expect(screen.getByText('Published Oct 22, 2026')).toBeInTheDocument();
    expect(screen.getByText('EUR · monthly periods')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/sha256-|\b[0-9a-f]{12}/);
    expect(screen.getByText('Development pricing.')).toBeInTheDocument();
    expect(
      screen.getByText(/0\.2\.0 development copy and aren’t verified against the live pricing/)
    ).toBeInTheDocument();
  });

  it('offers no price and no checkout: paid plans say Contact us, free ones Free', async () => {
    renderPricing();
    await heading();
    const plans = within(await screen.findByRole('list', { name: 'Plans' }));

    expect(plans.getAllByText('Contact us')).toHaveLength(1 + 1);
    expect(plans.getAllByText('institutional agreement')).toHaveLength(1);
    expect(plans.getAllByText('Free')).toHaveLength(2);
    expect(plans.getByText('with verified CAS')).toBeInTheDocument();
    expect(screen.getByText(/there’s no checkout/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/[€$]\s?\d/);
    expect(screen.queryByRole('link', { name: /checkout|buy|subscribe/i })).not.toBeInTheDocument();
  });

  it('sends a visitor to sign up or to log in with CAS', async () => {
    renderPricing();
    await heading();

    // The comparison and the drawn document offer the same actions.
    const signUp = await screen.findAllByRole('link', { name: 'Sign up' });
    expect(signUp).toHaveLength(2);
    for (const link of signUp)
      expect(link).toHaveAttribute('href', '/authentication?view=register');
    expect(
      screen
        .getAllByRole('link', { name: 'Log in with CAS' })
        .every(link => link.getAttribute('href') === '/authentication')
    ).toBe(true);
    expect(screen.queryByText('Available to your account')).not.toBeInTheDocument();
    expect(screen.queryByText('Your current plan')).not.toBeInTheDocument();
  });

  it('shows the monthly limits open, with the rounded figure and the exact one under it', async () => {
    renderPricing();
    await heading();
    const monthly = within(await screen.findByRole('table', { name: 'Monthly: Renew each month' }));

    const solverHours = within(monthly.getByRole('row', { name: /Solver hours/ }));
    expect(solverHours.getAllByText('10,000 h')).toHaveLength(2);
    expect(solverHours.getByText('Applies to')).toBeInTheDocument();
    expect(solverHours.getByText('Studies')).toBeInTheDocument();
    const generated = within(monthly.getByRole('row', { name: /Generated instances/ }));
    expect(generated.getByText('1,000')).toBeInTheDocument();
    expect(generated.getByText('1,000,000')).toBeInTheDocument();
  });

  it('opens and closes the groups of rows', async () => {
    renderPricing();
    await heading();
    const perRequest = await screen.findByRole('button', { name: /Per request/ });
    expect(perRequest).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('table', { name: /Per request/ })).not.toBeInTheDocument();

    fireEvent.click(perRequest);
    const table = within(screen.getByRole('table', { name: 'Per request: Ceilings for each run' }));
    const timeout = within(table.getByRole('row', { name: /Max time per run/ }));
    expect(timeout.getByText('24 h')).toBeInTheDocument();
    expect(timeout.getByText('1,440 min')).toBeInTheDocument();
    expect(table.getByText('500,000')).toBeInTheDocument();
    expect(table.getAllByText('Unlimited')).toHaveLength(2);

    fireEvent.click(screen.getByRole('button', { name: /Monthly/ }));
    expect(screen.queryByRole('table', { name: /Monthly/ })).not.toBeInTheDocument();
  });

  it('highlights one plan, or compares them all', async () => {
    renderPricing();
    await heading();
    const lab = await screen.findByRole('button', { name: 'LAB' });
    expect(screen.getByRole('button', { name: 'Compare all' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );

    fireEvent.click(lab);

    expect(lab).toHaveAttribute('aria-pressed', 'true');
    expect(document.querySelectorAll('td[data-picked]').length).toBeGreaterThan(0);
    expect(document.querySelectorAll('[data-part="plan-tile"][data-picked]')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Compare all' }));
    expect(document.querySelectorAll('td[data-picked]')).toHaveLength(0);
  });

  it('explains what has to have room before a run, a study run and a generation', async () => {
    renderPricing();
    await heading();

    expect(
      await screen.findByRole('heading', { name: 'What has to have room before you start' })
    ).toBeInTheDocument();
    expect(screen.getByText(/Three features also check your limits/)).toBeInTheDocument();
    const run = screen.getByText('Start a run').closest('li') as HTMLElement;
    expect(within(run).getByText('Solver hours left this month')).toBeInTheDocument();
    expect(
      within(screen.getByText('Start a study run').closest('li') as HTMLElement).getByText(
        'Solver hours left this month'
      )
    ).toBeInTheDocument();
    expect(
      within(screen.getByText('Start a generation').closest('li') as HTMLElement).getByText(
        'Generated instances left this month'
      )
    ).toBeInTheDocument();
  });

  it('explains the three outcomes of reaching a limit', async () => {
    renderPricing();
    await heading();
    const section = within(
      (await screen.findByRole('heading', { name: 'What happens when you reach a limit' })).closest(
        'section'
      ) as HTMLElement
    );

    expect(section.getByText('Reduced')).toBeInTheDocument();
    expect(section.getByText('Wait')).toBeInTheDocument();
    expect(section.getByText('Rejected')).toBeInTheDocument();
    expect(section.getByText(/OPTION_CLAMPED/)).toBeInTheDocument();
    expect(section.getByText(/402/)).toBeInTheDocument();
    expect(section.getByText(/429/)).toBeInTheDocument();
  });

  it('lists no add-ons for a pricing without them', async () => {
    renderPricing();
    await heading();

    await screen.findByRole('heading', { name: 'What happens when you reach a limit' });
    expect(screen.queryByRole('heading', { name: 'Add-ons' })).not.toBeInTheDocument();
  });

  it('lists the add-ons as arranged under an agreement', async () => {
    api.getPlansPricing.mockResolvedValue({ ...PRICING, document: withAddOns });
    renderPricing(person('FREE'));
    await heading();

    expect(await screen.findByText('STORAGE_PACK')).toBeInTheDocument();
    expect(screen.getByText(/FREE has no add-ons\./)).toBeInTheDocument();
    expect(screen.getAllByText('Contact us').length).toBeGreaterThanOrEqual(4);
    expect(screen.getByText('For LAB · 1–20 packs · per month')).toBeInTheDocument();
    expect(screen.getByText('For RESEARCH, LAB · 1 per archive · per account')).toBeInTheDocument();
    // A free plan has none of them, and each card says so.
    expect(screen.getAllByText('Not available on your plan')).toHaveLength(2);
  });

  it('opens a contact dialog that sends nothing, and gives focus back when it closes', async () => {
    renderPricing();
    await heading();
    const contact = (await screen.findAllByRole('button', { name: 'Contact us' }))[0];
    contact.focus();

    fireEvent.click(contact);
    const dialog = screen.getByRole('dialog', { name: 'Ask about LAB' });
    expect(within(dialog).getByText(/This page doesn’t send anything/)).toBeInTheDocument();
    expect(within(dialog).queryByRole('textbox')).not.toBeInTheDocument();

    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(contact).toHaveFocus();
  });

  it('hides the catalog when pricing is unavailable (503) and retries on request', async () => {
    api.getPlansPricing.mockRejectedValueOnce(new PricingUnavailableError('SPHERE is down'));
    renderPricing();
    await heading();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('503 · pricing_unavailable');
    expect(alert).toHaveTextContent('hidden rather than showing figures we can’t verify');
    expect(screen.queryByRole('list', { name: 'Plans' })).not.toBeInTheDocument();

    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('list', { name: 'Plans' })).toBeInTheDocument();
    expect(api.getPlansPricing).toHaveBeenCalledTimes(2);
  });

  it('refuses a document whose digest does not match (502)', async () => {
    const mismatch = new HttpError(502, 'SPHERE content no longer matches');
    mismatch.code = 'pricing_digest_mismatch';
    api.getPlansPricing.mockRejectedValue(mismatch);
    renderPricing();
    await heading();

    expect(await screen.findByRole('alert')).toHaveTextContent('502 · pricing_digest_mismatch');
    expect(screen.queryByRole('list', { name: 'Plans' })).not.toBeInTheDocument();
  });

  it('marks the current plan of a signed-in account and offers CAS linking to the others', async () => {
    renderPricing(person('FREE'));
    await heading();

    expect(await screen.findByText('Your current plan')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Sign up' })).not.toBeInTheDocument();
    for (const link of screen.getAllByRole('link', { name: 'Link CAS identity' }))
      expect(link).toHaveAttribute('href', '/me/settings?section=integrations');
    expect(screen.getByRole('link', { name: 'Manage identities' })).toHaveAttribute(
      'href',
      '/me/settings?section=integrations'
    );
  });

  it('offers no CAS link to an account that is on RESEARCH already', async () => {
    renderPricing(person('RESEARCH'));
    await heading();

    expect(await screen.findByText('Your current plan')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Link CAS identity' })).not.toBeInTheDocument();
  });

  it('evaluates the signed features as Enabled or Not enabled from the SPACE token', async () => {
    const token = makeToken({
      'openbinding-runs': { eval: true },
      'openbinding-studies': { eval: false },
    });
    stored.token = token;
    renderPricing(person('LAB'), token);

    expect(await screen.findByText('Available to your account')).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByText('Enabled').length).toBeGreaterThanOrEqual(1));
    await waitFor(() =>
      expect(screen.getAllByText('Not enabled').length).toBeGreaterThanOrEqual(1)
    );
    expect(
      screen.getByText('Read from your signed pricing token for the LAB plan.')
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(token);
  });

  it('says it cannot confirm the features when there is no token, instead of guessing', async () => {
    renderPricing(person('FREE'));

    expect(await screen.findByText('Available to your account')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getAllByText('Can’t confirm').length).toBeGreaterThanOrEqual(1)
    );
    expect(
      screen.getByText(
        /We can’t confirm your features right now, so none is shown as enabled or disabled/
      )
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'See your plan' })).toHaveAttribute(
      'href',
      '/me/settings?section=plan'
    );
  });

  it('draws the document with pricing-renderer through the bridge, in its commercial preset', async () => {
    renderPricing();
    await heading();

    expect(await screen.findByTestId('pricing-renderer')).toBeInTheDocument();
    expect(renderer.props).toMatchObject({
      mode: 'commercial',
      visibility: 'public-only',
      diagnostics: 'auto',
      theme: 'light',
    });
    expect(renderer.props?.style).toMatchObject({
      '--pr-color-accent': 'var(--color-tp-accent)',
      '--pr-sticky-top': '6rem',
    });
    expect(screen.getByRole('link', { name: 'SPHERE' })).toHaveAttribute(
      'href',
      PLANS_PRICING_FIXTURE.permanentUrl
    );
  });

  it('draws no document while the pricing cannot be read', async () => {
    api.getPlansPricing.mockRejectedValue(new PricingUnavailableError('SPHERE is down'));
    renderPricing();
    await heading();

    await screen.findByRole('alert');
    expect(screen.queryByTestId('pricing-renderer')).not.toBeInTheDocument();
  });

  it('offers in the drawn document the actions of the comparison, under the page’s own title', async () => {
    renderPricing();
    await heading();
    const actions = await documentActions();

    expect(
      Object.fromEntries(Object.entries(actions).map(([plan, slot]) => [plan, slot.textContent]))
    ).toEqual({
      FREE: 'Sign up',
      RESEARCH: 'Log in with CAS',
      LAB: 'Contact us',
    });
    expect(within(actions.FREE).getByRole('link', { name: 'Sign up' })).toHaveAttribute(
      'href',
      '/authentication?view=register'
    );
    expect(screen.getByTestId('summary-actions')).toBeEmptyDOMElement();
    expect(renderer.props).toMatchObject({
      hideSections: ['hero', 'summary'],
      theme: 'light',
      currentSelection: undefined,
    });
    expect(renderer.props).not.toHaveProperty('pricingPath');

    fireEvent.click(within(actions.LAB).getByRole('button', { name: 'Contact us' }));
    expect(await screen.findByRole('dialog', { name: 'Ask about LAB' })).toBeInTheDocument();
  });

  it('marks in the drawn document the plan and add-ons of the account, and offers nothing on its own plan', async () => {
    const token = makeToken(
      {},
      {
        subscription: {
          contractedServices: { openbinding: '0.2.0' },
          subscriptionPlans: { openbinding: 'LAB' },
          subscriptionAddOns: { openbinding: { STORAGE_PACK: 2 } },
          contractVersion: '4',
        },
      }
    );
    stored.token = token;
    api.getPlansPricing.mockResolvedValue({ ...PRICING, document: withAddOns });
    renderPricing(person('LAB'), token);
    await heading();
    const actions = await documentActions();

    const mine = { planId: 'LAB', addOns: { STORAGE_PACK: { selected: true, quantity: 2 } } };
    await waitFor(() => expect(renderer.props?.currentSelection).toEqual(mine));
    expect(renderer.props?.defaultSelection).toEqual(mine);
    expect(actions.LAB).toBeEmptyDOMElement();
    expect(
      within(actions.RESEARCH).getByRole('link', { name: 'Link CAS identity' })
    ).toHaveAttribute('href', '/me/settings?section=integrations');
    expect(actions.FREE).toBeEmptyDOMElement();
  });

  it('draws no link to SPHERE when the address from the gateway is not a web address', async () => {
    api.getPlansPricing.mockResolvedValue({ ...PRICING, permanentUrl: 'javascript:alert(1)' });
    renderPricing();
    await heading();

    await screen.findByTestId('pricing-renderer');
    expect(screen.queryByRole('link', { name: 'SPHERE' })).not.toBeInTheDocument();
    expect(document.querySelector('a[href^="javascript:"]')).toBeNull();
  });
});
