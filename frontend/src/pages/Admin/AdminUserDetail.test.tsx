import { configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CURRENT_FIXTURE, catalogFixture } from '../Pricing/pricingFixture';
import { AdminUserDetail } from './AdminUserDetail';
import { MARIA, SAM, USERS, subscriptionOf, userPage, usageOf } from '../../test/fixtures/admin';
import { refusal, renderAdmin } from './adminTestUtils';

const api = vi.hoisted(() => ({
  adminGetSubscription: vi.fn(),
  adminListUsers: vi.fn(),
  adminGetUserUsage: vi.fn(),
  adminUpdateSubscription: vi.fn(),
  adminChangePlan: vi.fn(),
  adminResyncUsage: vi.fn(),
  adminRevokeApiKey: vi.fn(),
  getPricingCatalog: vi.fn(),
  getCurrentPricing: vi.fn(),
  getPricingToken: vi.fn(),
}));

vi.mock('../../api/client', async () => ({
  ...await vi.importActual<typeof import('../../api/client')>('../../api/client'),
  apiClient: api,
}));

configure({ asyncUtilTimeout: 5000 });

const KEY_ID = '00000000-0000-4000-8000-0000000003a1';

function open(param: string = SAM.id, options: Parameters<typeof renderAdmin>[1] = {}) {
  return renderAdmin(<AdminUserDetail />, { entry: `/app/admin/users/${param}`, path: '/app/admin/users/:user', ...options });
}

async function ready() {
  await screen.findByRole('heading', { level: 1, name: 'sam.okafor' });
  await screen.findByRole('radiogroup', { name: 'New plan' });
}

describe('admin-user-detail · one account', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.adminGetSubscription.mockImplementation(async (id: string) => subscriptionOf(USERS.find((account) => account.id === id) ?? SAM));
    api.adminListUsers.mockResolvedValue(userPage());
    api.adminGetUserUsage.mockResolvedValue(usageOf('BASIC', 10));
    api.getPricingCatalog.mockResolvedValue(catalogFixture);
    api.getCurrentPricing.mockResolvedValue(CURRENT_FIXTURE);
    api.getPricingToken.mockResolvedValue('token');
    api.adminUpdateSubscription.mockImplementation(async (id: string, value: { plan: string; add_ons: Record<string, number> }) => ({
      ...subscriptionOf({ ...SAM, id, plan: value.plan }, value.add_ons), changed: true,
    }));
    api.adminChangePlan.mockResolvedValue({ ...SAM, plan: 'ADVANCED' });
    api.adminResyncUsage.mockResolvedValue({ plan: 'BASIC', slots_in_flight: 1, slots_recorded: 2, corrected_by: -1 });
    api.adminRevokeApiKey.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows who the account is, where its agreement stands and what it has used', async () => {
    open();
    await ready();
    expect(screen.getByText(/sam-okafor@example\.invalid · since Jun 15, 2026/)).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Breadcrumb' })).toHaveTextContent('Accounts');
    expect(screen.getByText('None linked')).toBeInTheDocument();
    expect(screen.queryByText('Institutional identity verified')).not.toBeInTheDocument();
    expect(screen.getByText(/Pinned to pricing 0\.1\.0 · renews Nov 1, 2026/)).toBeInTheDocument();
    expect(await screen.findByText('10 of 10')).toBeInTheDocument();
    expect(screen.getByText('Solves')).toBeInTheDocument();
    const ceilings = screen.getByRole('group', { name: 'Ceilings for each request' });
    expect(within(ceilings).getByText('Max time per job')).toBeInTheDocument();
    expect(within(ceilings).getByText('1 min')).toBeInTheDocument();
    expect(api.adminGetSubscription).toHaveBeenCalledWith(SAM.id);
    expect(api.adminGetUserUsage).toHaveBeenCalledWith(SAM.id);
  });

  it('finds an account by username as well as by id', async () => {
    open('sam.okafor');
    await ready();
    expect(api.adminListUsers).toHaveBeenCalledWith({ search: 'sam.okafor', limit: 200 });
    expect(api.adminGetSubscription).toHaveBeenCalledWith(SAM.id);
  });

  it('says so when no account has that name, and when the gateway has none with that id', async () => {
    open('nobody.here');
    expect(await screen.findByText('No such account')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to accounts' })).toHaveAttribute('href', '/app/admin/users');
    expect(api.adminGetSubscription).not.toHaveBeenCalled();
  });

  it('reports a 404 for an id the gateway does not know', async () => {
    api.adminGetSubscription.mockRejectedValue(refusal(404, 'not_found', 'No such account.'));
    open('00000000-0000-4000-8000-0000000000ff');
    expect(await screen.findByText('No such account')).toBeInTheDocument();
  });

  it('shows the plans of the active pricing and what each choice does to the limits', async () => {
    open();
    await ready();
    const plans = screen.getByRole('radiogroup', { name: 'New plan' });
    expect(within(plans).getAllByRole('radio')).toHaveLength(4);
    expect(within(plans).getByRole('radio', { name: /^BASIC · current/ })).toBeChecked();
    expect(within(plans).getByRole('radio', { name: /^RESEARCH.*Needs a verified CAS identity/ })).toBeInTheDocument();
    expect(screen.getByText('Add-ons for BASIC')).toBeInTheDocument();
    expect(screen.getByText('BASIC has no add-ons.')).toBeInTheDocument();
    expect(screen.getByText(/Nothing is selected yet/)).toBeInTheDocument();

    fireEvent.click(within(plans).getByRole('radio', { name: /^ADVANCED/ }));
    expect(screen.getByText('Add-ons for ADVANCED')).toBeInTheDocument();
    const table = screen.getByRole('table');
    const solves = within(table).getByText('Solves').closest('tr')!;
    expect(within(solves).getByText('10')).toBeInTheDocument();
    expect(within(solves).getByText(/^25/)).toBeInTheDocument();
    expect(screen.getByText(/Limits from pricing 0\.1\.0 \(development copy\)/)).toBeInTheDocument();
  });

  it('adds up the add-ons into the limits and keeps them within what the pricing allows', async () => {
    open();
    await ready();
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'New plan' })).getByRole('radio', { name: /^ADVANCED/ }));
    const more = screen.getByRole('button', { name: 'More compute pack' });
    fireEvent.click(more);
    fireEvent.click(more);
    expect(screen.getByLabelText('Compute pack quantity')).toHaveTextContent('2');
    const solves = within(screen.getByRole('table')).getByText('Solves').closest('tr')!;
    expect(within(solves).getByText(/^225/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Fewer compute pack' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Fewer compute pack' }));
    fireEvent.click(screen.getByRole('button', { name: 'Fewer compute pack' }));
    expect(screen.getByLabelText('Compute pack quantity')).toHaveTextContent('0');
    expect(screen.getByRole('button', { name: 'Fewer compute pack' })).toBeDisabled();
  });

  it('applies an agreement only after a confirmation, with the reason and detail, and says the account was notified', async () => {
    open();
    await ready();
    expect(screen.getByRole('button', { name: 'Apply agreement' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Change plan only, keep add-ons' })).toBeDisabled();

    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'New plan' })).getByRole('radio', { name: /^ADVANCED/ }));
    fireEvent.click(screen.getByRole('button', { name: 'More compute pack' }));
    fireEvent.change(screen.getByLabelText(/^Reason/), { target: { value: 'new_feature' } });
    fireEvent.change(screen.getByLabelText(/^Detail/), { target: { value: 'Ticket 41' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply agreement' }));

    const dialog = screen.getByRole('dialog', { name: 'Apply agreement to sam.okafor?' });
    expect(api.adminUpdateSubscription).not.toHaveBeenCalled();
    expect(within(dialog).getByText(/The account is notified and the change is recorded in the audit log/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply agreement' }));

    expect(await screen.findByText(/Agreement updated for sam\.okafor \(new feature\)/)).toBeInTheDocument();
    expect(api.adminUpdateSubscription).toHaveBeenCalledWith(SAM.id, {
      plan: 'ADVANCED', add_ons: { COMPUTE_PACK: 1 }, reason: 'new_feature', detail: 'Ticket 41',
    });
    await waitFor(() => expect(api.adminGetSubscription).toHaveBeenCalledTimes(2));
  });

  it('changes only the plan, keeping the add-ons, when asked to', async () => {
    open();
    await ready();
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'New plan' })).getByRole('radio', { name: /^ADVANCED/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Change plan only, keep add-ons' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Change plan of sam.okafor?' })).getByRole('button', { name: 'Change plan' }));
    expect(await screen.findByText(/Agreement updated for sam\.okafor \(administrative decision\)/)).toBeInTheDocument();
    expect(api.adminChangePlan).toHaveBeenCalledWith(SAM.id, 'ADVANCED');
    expect(api.adminUpdateSubscription).not.toHaveBeenCalled();
  });

  it('says when nothing changed, so nobody was notified', async () => {
    api.adminUpdateSubscription.mockResolvedValue({ ...subscriptionOf(SAM), changed: false });
    open();
    await ready();
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'New plan' })).getByRole('radio', { name: /^ADVANCED/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Apply agreement' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Apply agreement' }));
    expect(await screen.findByText('No contract values changed, so no notification was sent.')).toBeInTheDocument();
  });

  it('explains a RESEARCH agreement refused for want of a CAS identity (409) and an invalid one (422)', async () => {
    open();
    await ready();
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'New plan' })).getByRole('radio', { name: /^RESEARCH/ }));
    api.adminUpdateSubscription.mockRejectedValueOnce(refusal(409, 'research_requires_us_cas'));
    fireEvent.click(screen.getByRole('button', { name: 'Apply agreement' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Apply agreement' }));
    expect(await screen.findByText('RESEARCH needs a verified CAS identity (409 · research_requires_us_cas)')).toBeInTheDocument();
    expect(screen.getByText(/hasn’t linked a Universidad de Sevilla CAS identity/)).toBeInTheDocument();

    api.adminUpdateSubscription.mockRejectedValueOnce(refusal(422, 'invalid_subscription', 'COMPUTE_PACK is not available for BASIC'));
    fireEvent.click(screen.getByRole('button', { name: 'Apply agreement' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Apply agreement' }));
    expect(await screen.findByText('That agreement isn’t valid (422 · invalid_subscription)')).toBeInTheDocument();
  });

  it('says pricing is unavailable (503) without claiming anything changed', async () => {
    api.adminUpdateSubscription.mockRejectedValue(refusal(503, 'pricing_unavailable', 'SPACE is down'));
    open();
    await ready();
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'New plan' })).getByRole('radio', { name: /^ADVANCED/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Apply agreement' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Apply agreement' }));
    expect(await screen.findByText('A service isn’t available right now (503 · pricing_unavailable)')).toBeInTheDocument();
    expect(screen.queryByText(/Agreement updated/)).not.toBeInTheDocument();
  });

  it('keeps the page useful when the active pricing cannot be read', async () => {
    api.getPricingCatalog.mockRejectedValue(refusal(503, 'pricing_unavailable', 'down'));
    open();
    await screen.findByRole('heading', { level: 1, name: 'sam.okafor' });
    expect(await screen.findByText('The active pricing couldn’t be read')).toBeInTheDocument();
    expect(screen.queryByRole('radiogroup', { name: 'New plan' })).not.toBeInTheDocument();
    expect(await screen.findByText('10 of 10')).toBeInTheDocument();
  });

  it('reports usage that cannot be read without hiding the agreement', async () => {
    api.adminGetUserUsage.mockRejectedValue(refusal(503, 'pricing_unavailable', 'down'));
    open();
    await ready();
    expect(await screen.findByText('A service isn’t available right now (503 · pricing_unavailable)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Resync concurrency' })).toBeInTheDocument();
  });

  it('recounts concurrency after a confirmation and shows what was corrected', async () => {
    open();
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Resync concurrency' }));
    const dialog = screen.getByRole('dialog', { name: 'Resync concurrency?' });
    expect(api.adminResyncUsage).not.toHaveBeenCalled();
    expect(within(dialog).getByText('The resync is recorded in the audit log with your name.')).toBeInTheDocument();
    expect(within(dialog).queryByText(/doesn’t write/)).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Resync' }));
    expect(await screen.findByText('Corrected by')).toBeInTheDocument();
    expect(screen.getByText('-1')).toBeInTheDocument();
    expect(screen.getByText('Slots recorded')).toBeInTheDocument();
    expect(api.adminResyncUsage).toHaveBeenCalledWith(SAM.id);
  });

  it('revokes a key by its id after a confirmation, and says when the account has no such key', async () => {
    open();
    await ready();
    const revoke = screen.getByRole('button', { name: 'Revoke key' });
    expect(revoke).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Key id'), { target: { value: 'not-a-uuid' } });
    expect(revoke).toBeDisabled();
    expect(screen.getByText(/A key id is a UUID/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Key id'), { target: { value: KEY_ID } });
    fireEvent.click(revoke);
    const dialog = screen.getByRole('dialog', { name: 'Revoke the key of sam.okafor?' });
    expect(api.adminRevokeApiKey).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Revoke key' }));
    expect(await screen.findByText(/Key revoked\. Requests with it fail from now on\. It is recorded in the audit log with your name\./)).toBeInTheDocument();
    expect(screen.queryByText(/doesn’t write this to the audit log/)).not.toBeInTheDocument();
    expect(api.adminRevokeApiKey).toHaveBeenCalledWith(SAM.id, KEY_ID);

    api.adminRevokeApiKey.mockRejectedValueOnce(refusal(404, 'not_found'));
    fireEvent.change(screen.getByLabelText('Key id'), { target: { value: KEY_ID } });
    fireEvent.click(screen.getByRole('button', { name: 'Revoke key' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Revoke key' }));
    expect(await screen.findByText('No such API key (404)')).toBeInTheDocument();
  });

  it('is honest about the organizations the gateway does not list, and offers the sponsorship screen', async () => {
    open();
    await ready();
    expect(screen.getByText(/has no list of the organizations an account belongs to or sponsors/)).toBeInTheDocument();
    const open_ = screen.getByRole('button', { name: 'Open sponsorship' });
    expect(open_).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Organization slug or id'), { target: { value: 'isa-demo' } });
    expect(open_).toBeEnabled();
  });

  it('refreshes the pricing token when an administrator changes their own agreement', async () => {
    api.adminGetSubscription.mockImplementation(async () => subscriptionOf({ ...MARIA, id: MARIA.id }));
    open(MARIA.id, { user: { ...MARIA, role: 'admin' } });
    await screen.findByRole('heading', { level: 1, name: 'maria.santos' });
    await screen.findByRole('radiogroup', { name: 'New plan' });
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'New plan' })).getByRole('radio', { name: /^ADVANCED/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Apply agreement' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Apply agreement' }));
    await screen.findByText(/Agreement updated for maria\.santos/);
    expect(api.getPricingToken).toHaveBeenCalled();
  });

  it('shows a person who is not an administrator nothing, and asks the gateway nothing', async () => {
    open(SAM.id, { user: MARIA });
    expect(await screen.findByText('Not available (403)')).toBeInTheDocument();
    expect(api.adminGetSubscription).not.toHaveBeenCalled();
    expect(api.getPricingCatalog).not.toHaveBeenCalled();
  });
});
