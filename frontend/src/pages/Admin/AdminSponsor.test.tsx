import { configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QuotaError } from '../../api/auth';
import type { UserProfile } from '../../api/auth';
import { catalogFixture } from '../Pricing/pricingFixture';
import { AdminSponsor } from './AdminSponsor';
import { BAJA, LUCIA, NORA, ORG, SUB_ORG, USERS, subscriptionOf, usageOf, userPage } from './adminFixtures';
import { refusal, renderAdmin } from './adminTestUtils';

const api = vi.hoisted(() => ({
  adminGetSubscription: vi.fn(),
  adminListUsers: vi.fn(),
  adminGetUserUsage: vi.fn(),
  adminTransferSponsor: vi.fn(),
  getPricingCatalog: vi.fn(),
}));

const platform = vi.hoisted(() => ({ organization: vi.fn(), organizations: vi.fn() }));

vi.mock('../../api/client', async () => ({
  ...await vi.importActual<typeof import('../../api/client')>('../../api/client'),
  apiClient: api,
}));

vi.mock('../../api/platform', async () => ({
  ...await vi.importActual<typeof import('../../api/platform')>('../../api/platform'),
  platformApi: platform,
}));

configure({ asyncUtilTimeout: 5000 });

function open(param = 'isa-demo', user?: UserProfile) {
  return renderAdmin(<AdminSponsor />, { entry: `/app/admin/organizations/${param}/sponsor`, path: '/app/admin/organizations/:org/sponsor', user });
}

async function choose(username: string, candidates = [NORA, LUCIA, BAJA]) {
  api.adminListUsers.mockResolvedValue(userPage(candidates));
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search accounts' }), { target: { value: username.slice(0, 4) } });
  const radio = await screen.findByRole('radio', { name: new RegExp(username.replace('.', '\\.')) });
  fireEvent.click(radio);
  return radio;
}

describe('admin-sponsor · transfer the billing sponsor of an organization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    platform.organization.mockResolvedValue(ORG);
    platform.organizations.mockResolvedValue([ORG, SUB_ORG]);
    api.adminGetSubscription.mockImplementation(async (id: string) => subscriptionOf(USERS.find((account) => account.id === id) ?? LUCIA));
    api.adminGetUserUsage.mockImplementation(async () => usageOf('ADVANCED'));
    api.getPricingCatalog.mockResolvedValue(catalogFixture);
    api.adminTransferSponsor.mockResolvedValue({ ...ORG, billing_sponsor_user_id: NORA.id });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows the organization, its current sponsor and what moves with it', async () => {
    open();
    expect(screen.getByRole('heading', { level: 1, name: 'Transfer sponsorship' })).toBeInTheDocument();
    expect(await screen.findByText('ISA Demo Group', { selector: 'strong' })).toBeInTheDocument();
    expect(await screen.findByText('lucia.vega', { selector: 'strong' })).toBeInTheDocument();
    expect(platform.organization).toHaveBeenCalledWith('isa-demo');
    expect(api.adminGetSubscription).toHaveBeenCalledWith(LUCIA.id);
    const tree = await screen.findByText('Moves together');
    expect(within(tree.parentElement!).getByText(/ISA Demo Group/)).toBeInTheDocument();
    expect(within(tree.parentElement!).getByText(/QoS Lab \(sub-organization\)/)).toBeInTheDocument();
  });

  it('searches for the new sponsor and shows the limits its plan would carry', async () => {
    open();
    await screen.findByText('lucia.vega', { selector: 'strong' });
    await choose('nora.campos');
    const table = await screen.findByRole('table');
    expect(within(table).getByText('Organizations')).toBeInTheDocument();
    expect(within(within(table).getByText('Storage').closest('tr')!).getByText('5 GiB')).toBeInTheDocument();
    expect(within(within(table).getByText('Members').closest('tr')!).getByText('15')).toBeInTheDocument();
    expect(api.adminListUsers).toHaveBeenCalledWith({ search: 'nora', limit: 20 });
    expect(api.adminGetUserUsage).toHaveBeenCalledWith(NORA.id);
    expect(screen.getByText('Can sponsor')).toBeInTheDocument();
    expect(screen.getByText(/The gateway has no dry run/)).toBeInTheDocument();
  });

  it('does not offer the current sponsor as the new one', async () => {
    open();
    await screen.findByText('lucia.vega', { selector: 'strong' });
    await choose('nora.campos');
    expect(screen.getByRole('radio', { name: /lucia\.vega/ })).toBeDisabled();
    expect(screen.getByRole('radio', { name: /lucia\.vega.*current sponsor/ })).toBeInTheDocument();
  });

  it('moves the sponsorship only after a confirmation', async () => {
    open();
    await screen.findByText('lucia.vega', { selector: 'strong' });
    await choose('nora.campos');
    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('button', { name: 'Transfer sponsorship' }));
    const dialog = screen.getByRole('dialog', { name: 'Transfer sponsorship of ISA Demo Group?' });
    expect(api.adminTransferSponsor).not.toHaveBeenCalled();
    expect(within(dialog).getByText(/2 organizations will count against ADVANCED limits/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Transfer' }));
    expect(await screen.findByText(/Sponsorship of ISA Demo Group moved to nora\.campos/)).toBeInTheDocument();
    expect(api.adminTransferSponsor).toHaveBeenCalledWith(ORG.id, NORA.id);
    await waitFor(() => expect(platform.organization).toHaveBeenCalledTimes(2));
  });

  it('will not offer to move it to an inactive account, and says why', async () => {
    open();
    await screen.findByText('lucia.vega', { selector: 'strong' });
    await choose('baja.demo');
    expect(await screen.findByText('Can’t sponsor')).toBeInTheDocument();
    expect(screen.getByText('That account can’t be a sponsor (422 · invalid_sponsor)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Transfer sponsorship' })).toBeDisabled();
  });

  it('names the limit the new sponsor would pass when the gateway refuses with 402', async () => {
    api.adminTransferSponsor.mockRejectedValue(new QuotaError('sponsor_quota_exceeded', 'The sponsor contract allows 15 members', { limit_id: 'members', limit: 15, used: 18 }));
    open();
    await screen.findByText('lucia.vega', { selector: 'strong' });
    await choose('nora.campos');
    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('button', { name: 'Transfer sponsorship' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Transfer' }));
    expect(await screen.findByText('Over the new sponsor’s limits (402 · sponsor_quota_exceeded)')).toBeInTheDocument();
    expect(screen.getByText(/allows 15 members; with this organization they would use 18/)).toBeInTheDocument();
    expect(screen.queryByText(/moved to/)).not.toBeInTheDocument();
  });

  it('reports an account the gateway turns down (422) and a sponsor it cannot check (503)', async () => {
    api.adminTransferSponsor.mockRejectedValueOnce(refusal(422, 'invalid_sponsor', 'Sponsor must be active.'));
    open();
    await screen.findByText('lucia.vega', { selector: 'strong' });
    await choose('nora.campos');
    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('button', { name: 'Transfer sponsorship' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Transfer' }));
    expect(await screen.findByText('That account can’t be a sponsor (422 · invalid_sponsor)')).toBeInTheDocument();

    api.adminTransferSponsor.mockRejectedValueOnce(refusal(503, 'pricing_unavailable', 'SPACE is down'));
    fireEvent.click(screen.getByRole('button', { name: 'Transfer sponsorship' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Transfer' }));
    expect(await screen.findByText('A service isn’t available right now (503 · pricing_unavailable)')).toBeInTheDocument();
  });

  it('asks for the id when the organization cannot be read by name, because administrators who are not members cannot', async () => {
    platform.organization.mockRejectedValue(refusal(403, 'organization_forbidden'));
    open('secret-lab');
    expect(await screen.findByText('This organization can’t be read by name')).toBeInTheDocument();
    const open_ = screen.getByRole('button', { name: 'Open' });
    expect(open_).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Organization id'), { target: { value: ORG.id } });
    expect(open_).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Transfer sponsorship' })).not.toBeInTheDocument();
  });

  it('still moves an organization known only by its id', async () => {
    platform.organization.mockRejectedValue(refusal(403, 'organization_forbidden'));
    open(ORG.id);
    expect(await screen.findByText('Only the id is known')).toBeInTheDocument();
    await choose('nora.campos');
    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('button', { name: 'Transfer sponsorship' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Transfer' }));
    await waitFor(() => expect(api.adminTransferSponsor).toHaveBeenCalledWith(ORG.id, NORA.id));
  });

  it('reads a failure to find the organization apart from not being allowed to', async () => {
    platform.organization.mockRejectedValue(refusal(503, 'accounts_unavailable'));
    open();
    expect(await screen.findByText('A service isn’t available right now (503 · accounts_unavailable)')).toBeInTheDocument();
  });

  it('says that owners can do the same from the organization’s own settings', async () => {
    open();
    expect(await screen.findByText(/organization owners can set any active account as their organization’s sponsor/)).toBeInTheDocument();
  });

  it('shows a person who is not an administrator nothing, and asks the gateway nothing', async () => {
    open('isa-demo', LUCIA);
    expect(await screen.findByText('Not available (403)')).toBeInTheDocument();
    expect(platform.organization).not.toHaveBeenCalled();
    expect(api.adminListUsers).not.toHaveBeenCalled();
  });
});
