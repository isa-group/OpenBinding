import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PricingUnavailableError, QuotaError } from '../../api/auth';
import { HttpError } from '../../api/client';
import { catalogFixture } from '../Pricing/pricingFixture';
import { iker, lucia, member, org, renderScreen, researchUsage } from './testKit';
import { OrgCreate } from './OrgCreate';

const api = vi.hoisted(() => ({ getOwnUsage: vi.fn(), getPricingCatalog: vi.fn(), adminListUsers: vi.fn() }));
const platform = vi.hoisted(() => ({ createOrganization: vi.fn(), members: vi.fn() }));

vi.mock('../../api/client', async () => ({ ...await vi.importActual<typeof import('../../api/client')>('../../api/client'), apiClient: api }));
vi.mock('../../api/platform', async () => ({ ...await vi.importActual<typeof import('../../api/platform')>('../../api/platform'), platformApi: platform }));

const group = org('isa-demo', { name: 'ISA Demo Group' });
const viewerOnly = org('read-only', { name: 'Read Only Lab', effective_role: 'MEMBER' });
const consultora = org('consultora-demo', { name: 'Consultora Demo', billing_sponsor_user_id: 'user-nora', effective_role: 'ADMIN' });

function renderCreate(user = lucia, organizations = [group, viewerOnly, consultora]) {
  return renderScreen(<OrgCreate />, { path: '/app/organizations/new', url: '/app/organizations/new', organizations, user });
}

const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const next = () => fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

function fillFirstStep(name = 'Distributed Systems Lab') {
  type('Name', name);
  next();
}

describe('New organization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getOwnUsage.mockResolvedValue(researchUsage());
    api.getPricingCatalog.mockResolvedValue(catalogFixture);
    api.adminListUsers.mockResolvedValue({ users: [] });
    platform.members.mockResolvedValue([member('nora', 'OWNER')]);
    platform.createOrganization.mockResolvedValue(org('distributed-systems-lab', { name: 'Distributed Systems Lab' }));
  });

  it('suggests the address from the name and holds the way on until both are valid', async () => {
    renderCreate();

    expect(screen.getByRole('heading', { level: 1, name: 'New organization' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
    expect(screen.getByRole('list', { name: 'Steps' }).querySelectorAll('button')).toHaveLength(4);
    expect(screen.getByRole('button', { name: /^2/ })).toBeDisabled();

    type('Name', 'Distributed Systems Lab');
    expect(screen.getByLabelText('Address')).toHaveValue('distributed-systems-lab');
    expect(screen.getByText('Available to try · can’t be changed later.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled();

    // Once the address is typed by hand it stops following the name.
    type('Address', 'Bad Address');
    expect(screen.getByLabelText('Address')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText(/Use lowercase letters, numbers and hyphens/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
    type('Address', 'isa-demo');
    expect(screen.getByText('Already used by another organization.')).toBeInTheDocument();
    type('Name', 'Another name');
    expect(screen.getByLabelText('Address')).toHaveValue('isa-demo');
  });

  it('offers as parents only the organizations where the account is ADMIN or above', async () => {
    renderCreate();
    fillFirstStep();

    const parents = within(screen.getByRole('group', { name: 'Parent organization' }));
    expect(parents.getByRole('radio', { name: /None · top-level organization/ })).toBeChecked();
    expect(parents.getByRole('radio', { name: /ISA Demo Group/ })).toBeEnabled();
    expect(parents.getByRole('radio', { name: /Consultora Demo/ })).toBeEnabled();
    const blocked = parents.getByRole('radio', { name: /Read Only Lab/ });
    expect(blocked).toBeDisabled();
    expect(screen.getByText('Needs ADMIN here; your role is MEMBER')).toBeInTheDocument();
  });

  it('previews the tree and the sponsor’s room, with what the new organization adds', async () => {
    renderCreate();
    fillFirstStep();
    fireEvent.click(screen.getByRole('radio', { name: /ISA Demo Group/ }));

    const preview = screen.getByRole('list', { name: 'Organization tree preview' });
    expect(within(preview).getAllByRole('listitem').map((item) => item.textContent)).toEqual(['IDISA Demo Group', 'DSDistributed Systems LabNEW']);
    expect(screen.getByText(/Everyone with a role in ISA Demo Group gets at least the same role/)).toBeInTheDocument();

    // The gateway counts nothing per account, so the preview states the plan's limits and draws no meter.
    expect(await screen.findByText('Up to 5')).toBeInTheDocument();
    expect(screen.getByText('Up to 15')).toBeInTheDocument();
    expect(screen.queryByRole('meter')).not.toBeInTheDocument();
  });

  it('creates the organization under the chosen parent and sponsor, then offers to open it', async () => {
    const { reload } = renderCreate();
    fillFirstStep();
    fireEvent.click(screen.getByRole('radio', { name: /Consultora Demo/ }));
    next();

    const sponsors = within(screen.getByRole('group', { name: 'Sponsor' }));
    expect(sponsors.getByRole('radio', { name: /You \(lucia\.vega\)/ })).toBeChecked();
    fireEvent.click(await sponsors.findByRole('radio', { name: /nora · sponsor of Consultora Demo/ }));
    next();

    expect(screen.getByRole('heading', { name: 'Review' })).toBeInTheDocument();
    expect(screen.getByText('/app/distributed-systems-lab')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Create organization' }));

    await waitFor(() => expect(platform.createOrganization).toHaveBeenCalledWith({
      name: 'Distributed Systems Lab', slug: 'distributed-systems-lab', parent_id: consultora.id, billing_sponsor_user_id: 'user-nora',
    }));
    expect(await screen.findByText('Distributed Systems Lab is ready')).toBeInTheDocument();
    expect(reload).toHaveBeenCalledOnce();
    expect(screen.getByText(/It sits inside Consultora Demo, so members there keep their roles here\. Sponsored by nora\./)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open organization' })).toHaveAttribute('href', '/app/distributed-systems-lab');
    expect(screen.getByRole('link', { name: 'Create the first project' })).toHaveAttribute('href', '/app/distributed-systems-lab/new-project');
  });

  describe('when the gateway refuses', () => {
    async function toReview() {
      renderCreate();
      fillFirstStep();
      next();
      next();
      expect(screen.getByRole('heading', { name: 'Review' })).toBeInTheDocument();
    }

    it('409: the address is taken, and the way back to change it', async () => {
      platform.createOrganization.mockRejectedValue(Object.assign(new HttpError(409, 'slug in use'), { code: 'slug_conflict' }));
      await toReview();
      fireEvent.click(screen.getByRole('button', { name: 'Create organization' }));

      expect(await screen.findByRole('alert')).toHaveTextContent('That address is taken (409 · slug_conflict). Another organization already uses /app/distributed-systems-lab.');
      fireEvent.click(screen.getByRole('button', { name: 'Change the address' }));
      expect(screen.getByRole('heading', { name: 'Name and address' })).toBeInTheDocument();
      expect(screen.getByLabelText('Address')).toHaveValue('distributed-systems-lab');
    });

    it('402: the sponsor has no organizations left, with the ways out', async () => {
      platform.createOrganization.mockRejectedValue(new QuotaError('sponsor_quota_exceeded', 'full', { limit_id: 'organizations', limit: 5, used: 5 }));
      await toReview();
      fireEvent.click(screen.getByRole('button', { name: 'Create organization' }));

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('The sponsor has no organizations left (402 · sponsor_quota_exceeded). You already sponsor 5 of 5 organizations.');
      expect(within(alert).getByRole('link', { name: 'See your plan' })).toHaveAttribute('href', '/app/account/usage');
      expect(within(alert).getByRole('link', { name: 'Compare plans' })).toHaveAttribute('href', '/pricing');
      fireEvent.click(within(alert).getByRole('button', { name: 'Choose another sponsor' }));
      expect(screen.getByRole('heading', { name: 'Who sponsors it' })).toBeInTheDocument();
    });

    it('503: the sponsor’s limits cannot be checked, and nothing was created until it is tried again', async () => {
      platform.createOrganization.mockRejectedValueOnce(new PricingUnavailableError('pricing is down'));
      await toReview();
      fireEvent.click(screen.getByRole('button', { name: 'Create organization' }));

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('The sponsor’s limits can’t be checked right now (503 · pricing_unavailable), so nothing was created.');
      fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
      expect(await screen.findByText('Distributed Systems Lab is ready')).toBeInTheDocument();
      expect(platform.createOrganization).toHaveBeenCalledTimes(2);
    });

    it('403: no ADMIN in the parent', async () => {
      platform.createOrganization.mockRejectedValue(Object.assign(new HttpError(403, 'no'), { code: 'organization_forbidden' }));
      renderCreate();
      fillFirstStep();
      fireEvent.click(screen.getByRole('radio', { name: /Consultora Demo/ }));
      next();
      next();
      fireEvent.click(screen.getByRole('button', { name: 'Create organization' }));

      expect(await screen.findByText('You need ADMIN in Consultora Demo to add an organization inside it (403 · organization_forbidden). Ask one of its admins, or create it top-level.')).toBeInTheDocument();
    });
  });

  it('lets a platform administrator sponsor with any account and shows that plan’s ceilings', async () => {
    api.adminListUsers.mockResolvedValue({
      users: [
        { ...iker, contract_pending: false, api_key_count: 0 },
        { ...lucia, id: 'user-pablo', username: 'pablo', email: 'pablo@example.test', plan: 'PRO', contract_pending: false, api_key_count: 0 },
      ],
    });
    renderCreate(iker, [org('isa-demo', { name: 'ISA Demo Group', billing_sponsor_user_id: iker.id })]);
    fillFirstStep();
    next();

    expect(screen.getByText('As a platform administrator you may choose any account as sponsor.')).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('radio', { name: /pablo \(pablo@example\.test\)/ }));
    expect(screen.getByText('Administrator choice · their PRO plan')).toBeInTheDocument();
    // Their usage is theirs to see: only the ceilings of the PRO plan are known here.
    expect(await screen.findByText('Up to 10')).toBeInTheDocument();
    expect(screen.getByText(/Plan ceilings only; this account’s usage isn’t visible to you/)).toBeInTheDocument();
    next();
    fireEvent.click(screen.getByRole('button', { name: 'Create organization' }));

    await waitFor(() => expect(platform.createOrganization).toHaveBeenCalledWith(expect.objectContaining({ billing_sponsor_user_id: 'user-pablo', parent_id: null })));
  });
});
