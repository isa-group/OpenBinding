import { configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QuotaError } from '../../api/auth';
import type { SponsorProposal, UserProfile } from '../../api/auth';
import { catalogFixture } from '../Pricing/pricingFixture';
import { AdminSponsor } from './AdminSponsor';
import { ALEX, DANA, MARIA, ORG, PRIYA, SUB_ORG, USERS, subscriptionOf, usageOf, userPage } from '../../test/fixtures/admin';
import { refusal, renderAdmin } from './adminTestUtils';

const api = vi.hoisted(() => ({
  adminGetSubscription: vi.fn(),
  adminListUsers: vi.fn(),
  adminGetUserUsage: vi.fn(),
  adminTransferSponsor: vi.fn(),
  getPricingCatalog: vi.fn(),
  listOrganizationSponsorProposals: vi.fn(),
  cancelSponsorProposal: vi.fn(),
}));

/** The pending request the gateway answers (202) when somebody else is named. */
function request(over: Partial<SponsorProposal> = {}): SponsorProposal {
  return {
    id: 'prop-1', organization_id: ORG.id, organization_slug: ORG.slug, organization_name: ORG.name,
    proposed_user_id: PRIYA.id, proposed_username: PRIYA.username, proposed_by_user_id: ALEX.id, proposed_by_username: ALEX.username,
    status: 'pending', created_at: '2026-10-10T09:00:00Z', expires_at: '2099-12-31T09:00:00Z',
    decided_at: null, decided_by_user_id: null, decision_reason: null,
    ...over,
  };
}

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

async function choose(username: string, candidates = [PRIYA, MARIA, DANA]) {
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
    api.adminGetSubscription.mockImplementation(async (id: string) => subscriptionOf(USERS.find((account) => account.id === id) ?? MARIA));
    api.adminGetUserUsage.mockImplementation(async () => usageOf('ADVANCED'));
    api.getPricingCatalog.mockResolvedValue(catalogFixture);
    api.adminTransferSponsor.mockResolvedValue(request());
    api.listOrganizationSponsorProposals.mockResolvedValue([]);
    api.cancelSponsorProposal.mockResolvedValue(request({ status: 'cancelled' }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows the organization, its current sponsor and what moves with it', async () => {
    open();
    expect(screen.getByRole('heading', { level: 1, name: 'Transfer sponsorship' })).toBeInTheDocument();
    expect(await screen.findByText('ISA Demo Group', { selector: 'strong' })).toBeInTheDocument();
    expect(await screen.findByText('maria.santos', { selector: 'strong' })).toBeInTheDocument();
    expect(platform.organization).toHaveBeenCalledWith('isa-demo');
    expect(api.adminGetSubscription).toHaveBeenCalledWith(MARIA.id);
    const tree = await screen.findByText('Moves together');
    expect(within(tree.parentElement!).getByText(/ISA Demo Group/)).toBeInTheDocument();
    expect(within(tree.parentElement!).getByText(/QoS Lab \(sub-organization\)/)).toBeInTheDocument();
  });

  it('searches for the new sponsor and shows the limits its plan would carry', async () => {
    open();
    await screen.findByText('maria.santos', { selector: 'strong' });
    await choose('priya.nair');
    const table = await screen.findByRole('table');
    expect(within(table).getByText('Organizations')).toBeInTheDocument();
    expect(within(within(table).getByText('Storage').closest('tr')!).getByText('5 GiB')).toBeInTheDocument();
    expect(within(within(table).getByText('Members').closest('tr')!).getByText('15')).toBeInTheDocument();
    expect(api.adminListUsers).toHaveBeenCalledWith({ search: 'priy', limit: 20 });
    expect(api.adminGetUserUsage).toHaveBeenCalledWith(PRIYA.id);
    expect(screen.getByText('Can sponsor')).toBeInTheDocument();
    expect(screen.getByText(/This sends priya\.nair a request; nothing moves until they accept/)).toBeInTheDocument();
  });

  it('does not offer the current sponsor as the new one', async () => {
    open();
    await screen.findByText('maria.santos', { selector: 'strong' });
    await choose('priya.nair');
    expect(screen.getByRole('radio', { name: /maria\.santos/ })).toBeDisabled();
    expect(screen.getByRole('radio', { name: /maria\.santos.*current sponsor/ })).toBeInTheDocument();
  });

  it('sends a request, not a transfer, when somebody else is named, and only after a confirmation', async () => {
    open();
    await screen.findByText('maria.santos', { selector: 'strong' });
    await choose('priya.nair');
    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('button', { name: 'Send sponsor request' }));
    const dialog = screen.getByRole('dialog', { name: 'Ask priya.nair to sponsor ISA Demo Group?' });
    expect(api.adminTransferSponsor).not.toHaveBeenCalled();
    expect(within(dialog).getByText(/Nothing changes until they accept/)).toBeInTheDocument();
    expect(within(dialog).getByText(/2 organizations will count against their ADVANCED limits/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send request' }));

    expect(await screen.findByText(/Sponsor request sent to priya\.nair\. Nothing changes until they accept/)).toBeInTheDocument();
    expect(api.adminTransferSponsor).toHaveBeenCalledWith(ORG.id, PRIYA.id);
    expect(screen.queryByText(/moved to/)).not.toBeInTheDocument();
    const card = await screen.findByRole('region', { name: 'Sponsor request sent' });
    expect(within(card).getByText('Pending')).toBeInTheDocument();
    expect(within(card).getByLabelText('Sponsor request')).toHaveTextContent('priya.nair');
    expect(within(card).getByLabelText('Sponsor request')).toHaveTextContent('Dec 31, 2099');
  });

  it('cancels the request that was sent', async () => {
    api.listOrganizationSponsorProposals.mockResolvedValue([request()]);
    open();

    const card = await screen.findByRole('region', { name: 'Sponsor request sent' });
    api.listOrganizationSponsorProposals.mockResolvedValue([request({ status: 'cancelled' })]);
    fireEvent.click(within(card).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(api.cancelSponsorProposal).toHaveBeenCalledWith('prop-1'));
    expect(await screen.findByText('Sponsor request cancelled. The sponsor stays as it was.')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Sponsor request sent' })).not.toBeInTheDocument());
  });

  it('moves the sponsorship at once only when the administrator names themselves', async () => {
    api.adminTransferSponsor.mockResolvedValue({ ...ORG, billing_sponsor_user_id: ALEX.id });
    open();
    await screen.findByText('maria.santos', { selector: 'strong' });
    await choose('alex.rivera', [ALEX, PRIYA]);
    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('button', { name: 'Transfer sponsorship' }));
    const dialog = screen.getByRole('dialog', { name: 'Transfer sponsorship of ISA Demo Group?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Transfer' }));

    expect(await screen.findByText(/Sponsorship of ISA Demo Group moved to alex\.rivera/)).toBeInTheDocument();
    expect(api.adminTransferSponsor).toHaveBeenCalledWith(ORG.id, ALEX.id);
    expect(screen.queryByRole('region', { name: 'Sponsor request sent' })).not.toBeInTheDocument();
    await waitFor(() => expect(platform.organization).toHaveBeenCalledTimes(2));
  });

  it('will not offer to move it to an inactive account, and says why', async () => {
    open();
    await screen.findByText('maria.santos', { selector: 'strong' });
    await choose('dana.kim');
    expect(await screen.findByText('Can’t sponsor')).toBeInTheDocument();
    expect(screen.getByText('That account can’t be a sponsor (422 · invalid_sponsor)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send sponsor request' })).toBeDisabled();
  });

  it('names the limit the new sponsor would pass when naming oneself is refused with 402', async () => {
    api.adminTransferSponsor.mockRejectedValue(new QuotaError('sponsor_quota_exceeded', 'The sponsor contract allows 15 members', { limit_id: 'members', limit: 15, used: 18 }));
    open();
    await screen.findByText('maria.santos', { selector: 'strong' });
    await choose('alex.rivera', [ALEX, PRIYA]);
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
    await screen.findByText('maria.santos', { selector: 'strong' });
    await choose('priya.nair');
    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('button', { name: 'Send sponsor request' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Send request' }));
    expect(await screen.findByText('That account can’t be a sponsor (422 · invalid_sponsor)')).toBeInTheDocument();

    api.adminTransferSponsor.mockRejectedValueOnce(refusal(503, 'pricing_unavailable', 'SPACE is down'));
    fireEvent.click(screen.getByRole('button', { name: 'Send sponsor request' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Send request' }));
    expect(await screen.findByText('A service isn’t available right now (503 · pricing_unavailable)')).toBeInTheDocument();
  });

  it('offers Replace request when a request is waiting and the administrator sent it, resending with the replace flag', async () => {
    api.listOrganizationSponsorProposals.mockResolvedValue([request({ proposed_user_id: DANA.id, proposed_username: DANA.username })]);
    api.adminTransferSponsor.mockRejectedValueOnce(refusal(409, 'sponsor_proposal_pending', 'A proposal is pending.'));
    open();
    await screen.findByText('maria.santos', { selector: 'strong' });
    await choose('priya.nair');
    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('button', { name: 'Send sponsor request' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Send request' }));

    expect(await screen.findByText('A request is already waiting (409 · sponsor_proposal_pending)')).toBeInTheDocument();
    const card = await screen.findByRole('region', { name: 'Sponsor request sent' });
    api.adminTransferSponsor.mockResolvedValueOnce(request({ id: 'prop-2' }));
    fireEvent.click(within(card).getByRole('button', { name: 'Replace request' }));
    await waitFor(() => expect(api.adminTransferSponsor).toHaveBeenLastCalledWith(ORG.id, PRIYA.id, true));
    expect(await screen.findByText(/Sponsor request sent to priya\.nair/)).toBeInTheDocument();
  });

  it('does not offer Replace when somebody else sent the waiting request', async () => {
    api.listOrganizationSponsorProposals.mockResolvedValue([request({ proposed_by_user_id: MARIA.id, proposed_by_username: MARIA.username })]);
    api.adminTransferSponsor.mockRejectedValueOnce(refusal(409, 'sponsor_proposal_pending', 'A proposal is pending.'));
    open();
    await screen.findByText('maria.santos', { selector: 'strong' });
    await choose('priya.nair');
    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('button', { name: 'Send sponsor request' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Send request' }));

    // The card is already there from the list; the hint arrives with the refusal.
    await screen.findByText('Someone else sent this request. Cancel it first, then send yours.');
    const card = screen.getByRole('region', { name: 'Sponsor request sent' });
    expect(within(card).getByText('Someone else sent this request. Cancel it first, then send yours.')).toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: 'Replace request' })).not.toBeInTheDocument();
    // A platform administrator can cancel any request.
    expect(within(card).getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });

  it('says the account is already the sponsor (409)', async () => {
    api.adminTransferSponsor.mockRejectedValueOnce(refusal(409, 'already_sponsor', 'Already the sponsor.'));
    open();
    await screen.findByText('maria.santos', { selector: 'strong' });
    await choose('priya.nair');
    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('button', { name: 'Send sponsor request' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Send request' }));
    expect(await screen.findByText('That account is already the sponsor (409 · already_sponsor)')).toBeInTheDocument();
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
    await choose('priya.nair');
    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('button', { name: 'Send sponsor request' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Send request' }));
    await waitFor(() => expect(api.adminTransferSponsor).toHaveBeenCalledWith(ORG.id, PRIYA.id));
  });

  it('reads a failure to find the organization apart from not being allowed to', async () => {
    platform.organization.mockRejectedValue(refusal(503, 'accounts_unavailable'));
    open();
    expect(await screen.findByText('A service isn’t available right now (503 · accounts_unavailable)')).toBeInTheDocument();
  });

  it('says that nobody can be made to pay, without any note about consent being skipped or the change going unaudited', async () => {
    open();
    expect(await screen.findByText(/Nobody can make another person pay: naming someone else sends them a request/)).toBeInTheDocument();
    expect(screen.queryByText(/no consent/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/not audited|isn’t audited/i)).not.toBeInTheDocument();
  });

  it('shows a person who is not an administrator nothing, and asks the gateway nothing', async () => {
    open('isa-demo', MARIA);
    expect(await screen.findByText('Not available (403)')).toBeInTheDocument();
    expect(platform.organization).not.toHaveBeenCalled();
    expect(api.adminListUsers).not.toHaveBeenCalled();
  });
});
