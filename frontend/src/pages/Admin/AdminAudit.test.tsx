import { configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminAudit } from './AdminAudit';
import type { AdminAuditPage } from '../../api/auth';
import { ALEX, AUDIT, MARIA, ORG, PRIYA, SAM } from '../../test/fixtures/admin';
import { refusal, renderAdmin } from './adminTestUtils';

const api = vi.hoisted(() => ({ adminAudit: vi.fn() }));

const at = (n: number) => `2026-10-0${n}T09:00:00Z`;
const event = (n: number, action: string, detail: Record<string, unknown>, over: Partial<AdminAuditPage['events'][number]> = {}): AdminAuditPage['events'][number] => ({
  id: `00000000-0000-4000-8000-00000000050${n}`, organizationId: null, organizationSlug: null, actorId: ALEX.id, action, targetType: 'User', targetId: SAM.id, detail, createdAt: at(n), ...over,
});

/** What B2 added to the log: account actions, the CAS link and the events recorded inside an organization. */
const RECENT: AdminAuditPage = {
  events: [
    event(1, 'organization.sponsor.proposed', { proposal_id: 'prop-1', proposed_user_id: PRIYA.id, proposed_by_user_id: ALEX.id, expires_at: '2026-10-24T09:00:00Z' },
      { organizationId: ORG.id, organizationSlug: 'isa-demo', targetType: 'Organization', targetId: ORG.id }),
    event(2, 'admin.user.updated', { username: 'sam.okafor', changes: { role: { from: 'user', to: 'admin' }, is_active: { from: true, to: false } } }),
    event(3, 'admin.api_key.revoked', { user_id: SAM.id, key: { id: 'key-1', name: 'ci pipeline', prefix: 'obk_ab12' } }, { targetType: 'ApiKey', targetId: 'key-1' }),
    event(4, 'admin.usage.resynced', { username: 'sam.okafor', plan: 'BASIC', before: { concurrent_jobs_recorded: 2 }, after: { concurrent_jobs_recorded: 1 }, slots_in_flight: 1, corrected_by: -1 }),
    event(5, 'account.cas.linked', { provider: 'us-cas', plan_changed: { from: 'BASIC', to: 'RESEARCH', extra_cost: false } }),
    event(6, 'organization.updated', { previous_sponsor_user_id: MARIA.id, new_sponsor_user_id: ALEX.id }, { organizationId: ORG.id, organizationSlug: 'isa-demo', targetType: 'Organization', targetId: ORG.id }),
    event(7, 'organization.sponsor.accepted', { proposal_id: 'prop-1', previous_sponsor_user_id: MARIA.id, new_sponsor_user_id: PRIYA.id }, { organizationId: ORG.id, organizationSlug: 'isa-demo' }),
  ],
  total: 7, offset: 0, limit: 100,
};

vi.mock('../../api/client', async () => ({
  ...await vi.importActual<typeof import('../../api/client')>('../../api/client'),
  apiClient: api,
}));

configure({ asyncUtilTimeout: 5000 });

describe('admin-audit · the platform audit log', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.adminAudit.mockResolvedValue(AUDIT);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lists the events newest first, each in a sentence', async () => {
    renderAdmin(<AdminAudit />);
    expect(screen.getByRole('heading', { level: 1, name: 'Audit log' })).toBeInTheDocument();
    expect(await screen.findByText('2 abandoned jobs were reconciled.')).toBeInTheDocument();
    expect(screen.getByText('Pricing live activated: 0.1.0.')).toBeInTheDocument();
    expect(screen.getByText('Agreement changed from BASIC to RESEARCH (no add-ons).')).toBeInTheDocument();
    const timeline = screen.getByRole('list', { name: 'Events, newest first' });
    expect(within(timeline).getAllByRole('listitem')).toHaveLength(3);
    expect(api.adminAudit).toHaveBeenCalledWith({ action: undefined, offset: 0, limit: 100 });
    expect(screen.getByText(/Events recorded inside an organization, such as a change of sponsor, appear here too with the organization named/)).toBeInTheDocument();
    expect(screen.queryByText(/are in that organization’s own audit log/)).not.toBeInTheDocument();
  });

  describe('the events B2 put in the log', () => {
    beforeEach(() => {
      api.adminAudit.mockResolvedValue(RECENT);
    });

    it('words each new kind of event for a person', async () => {
      renderAdmin(<AdminAudit />);

      expect(await screen.findByText('A request to become the billing sponsor was sent.')).toBeInTheDocument();
      expect(screen.getByText('Account sam.okafor was updated: role user → admin; status active → inactive.')).toBeInTheDocument();
      expect(screen.getByText('API key “ci pipeline” (obk_ab12…) was revoked.')).toBeInTheDocument();
      expect(screen.getByText('Running-job slots of sam.okafor were recounted (corrected by -1).')).toBeInTheDocument();
      expect(screen.getByText('An institutional identity was linked and the plan went from BASIC to RESEARCH at no extra cost.')).toBeInTheDocument();
      expect(screen.getByText('The organization’s billing sponsor was changed.')).toBeInTheDocument();
      expect(screen.getByText('A request to become the billing sponsor was accepted.')).toBeInTheDocument();
    });

    it('shows the facts of an account action in the detail, never a secret', async () => {
      renderAdmin(<AdminAudit />);
      await screen.findByText('A request to become the billing sponsor was sent.');
      fireEvent.click(screen.getByRole('button', { name: /admin\.api_key\.revoked/ }));

      const aside = screen.getByRole('complementary', { name: 'Event detail' });
      expect(within(aside).getByText('ci pipeline')).toBeInTheDocument();
      expect(within(aside).getByText('obk_ab12')).toBeInTheDocument();
      expect(within(aside).getByText('key-1', { selector: 'dd' })).toBeInTheDocument();
      expect(within(aside).queryByText(/secret|hash/i)).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: /account\.cas\.linked/ }));
      expect(within(aside).getByText('BASIC → RESEARCH · no extra cost')).toBeInTheDocument();
      expect(within(aside).getByLabelText('Before and after')).toHaveTextContent('BASIC');
    });

    it('names the organization of an event with a chip, and not for a platform event', async () => {
      renderAdmin(<AdminAudit />);
      await screen.findByText('A request to become the billing sponsor was sent.');
      const timeline = screen.getByRole('list', { name: 'Events, newest first' });
      const items = within(timeline).getAllByRole('listitem');

      expect(within(items[0]).getByText('isa-demo')).toBeInTheDocument();
      expect(within(items[1]).queryByText('isa-demo')).not.toBeInTheDocument();
      const aside = screen.getByRole('complementary', { name: 'Event detail' });
      expect(within(aside).getByText('Organization')).toBeInTheDocument();
      expect(within(aside).getByText(/isa-demo ·/)).toBeInTheDocument();
    });

    it('keeps only one organization’s events on request, and drops the filter again', async () => {
      renderAdmin(<AdminAudit />);
      await screen.findByText('A request to become the billing sponsor was sent.');

      fireEvent.click(screen.getByRole('button', { name: 'Only this organization' }));
      await waitFor(() => expect(api.adminAudit).toHaveBeenLastCalledWith({ action: undefined, organizationId: ORG.id, offset: 0, limit: 100 }));
      expect(screen.getByLabelText('Organization id (optional)')).toHaveValue(ORG.id);

      fireEvent.click(await screen.findByRole('button', { name: 'Clear organization filter' }));
      await waitFor(() => expect(api.adminAudit).toHaveBeenLastCalledWith({ action: undefined, organizationId: undefined, offset: 0, limit: 100 }));
    });

    it('asks for an organization by id and refuses what is not one', async () => {
      renderAdmin(<AdminAudit />);
      await screen.findByText('A request to become the billing sponsor was sent.');
      const calls = api.adminAudit.mock.calls.length;

      fireEvent.change(screen.getByLabelText('Organization id (optional)'), { target: { value: 'isa-demo' } });
      fireEvent.click(screen.getByRole('button', { name: 'Filter' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('Use the organization’s id');
      expect(screen.getByLabelText('Organization id (optional)')).toBeInvalid();
      expect(api.adminAudit).toHaveBeenCalledTimes(calls);

      fireEvent.change(screen.getByLabelText('Organization id (optional)'), { target: { value: ORG.id } });
      fireEvent.click(screen.getByRole('button', { name: 'Filter' }));
      await waitFor(() => expect(api.adminAudit).toHaveBeenLastCalledWith({ action: undefined, organizationId: ORG.id, offset: 0, limit: 100 }));
    });

    it('narrows the page to account events or to organization events', async () => {
      renderAdmin(<AdminAudit />);
      await screen.findByText('A request to become the billing sponsor was sent.');
      const kinds = screen.getByRole('group', { name: 'Kind of event' });

      fireEvent.click(within(kinds).getByRole('button', { name: 'Accounts' }));
      expect(within(screen.getByRole('list', { name: 'Events, newest first' })).getAllByRole('listitem')).toHaveLength(4);
      fireEvent.click(within(kinds).getByRole('button', { name: 'Organizations' }));
      expect(within(screen.getByRole('list', { name: 'Events, newest first' })).getAllByRole('listitem')).toHaveLength(3);
    });
  });

  it('shows the detail of the event you pick, with what it changed from and to', async () => {
    renderAdmin(<AdminAudit />);
    await screen.findByText('2 abandoned jobs were reconciled.');
    const aside = screen.getByRole('complementary', { name: 'Event detail' });
    expect(within(aside).getByText('maintenance.jobs.reconciled')).toBeInTheDocument();
    expect(within(aside).queryByLabelText('Before and after')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /contract\.subscription\.changed/ }));
    expect(within(aside).getByText('contract.subscription.changed')).toBeInTheDocument();
    const change = within(aside).getByLabelText('Before and after');
    expect(within(change).getByText('BASIC · no add-ons')).toBeInTheDocument();
    expect(within(change).getByText('RESEARCH · no add-ons')).toBeInTheDocument();
    expect(within(aside).getByText('Institutional agreement')).toBeInTheDocument();
    expect(within(aside).getByText('Agreement 2026-14')).toBeInTheDocument();
    expect(within(aside).getByRole('link', { name: '00000000…' })).toHaveAttribute('href', `/app/admin/users/${ALEX.id}`);
    expect(within(aside).getByText('00000000-0000-4000-8000-000000000401')).toBeInTheDocument();
    expect(within(aside).getByText('View source')).toBeInTheDocument();
  });

  it('narrows the page by kind of event', async () => {
    renderAdmin(<AdminAudit />);
    await screen.findByText('2 abandoned jobs were reconciled.');
    const kinds = screen.getByRole('group', { name: 'Kind of event' });
    fireEvent.click(within(kinds).getByRole('button', { name: 'Pricing' }));
    expect(screen.getByText('Pricing live activated: 0.1.0.')).toBeInTheDocument();
    expect(screen.queryByText('2 abandoned jobs were reconciled.')).not.toBeInTheDocument();
    fireEvent.click(within(kinds).getByRole('button', { name: 'Other' }));
    expect(screen.getByText('No events for this filter')).toBeInTheDocument();
    fireEvent.click(within(kinds).getByRole('button', { name: 'All' }));
    expect(screen.getByText('2 abandoned jobs were reconciled.')).toBeInTheDocument();
  });

  it('asks the gateway for an exact action, and can drop the filter again', async () => {
    renderAdmin(<AdminAudit />);
    await screen.findByText('2 abandoned jobs were reconciled.');
    fireEvent.change(screen.getByLabelText('Exact action'), { target: { value: 'contract.subscription.changed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Filter' }));
    await waitFor(() => expect(api.adminAudit).toHaveBeenLastCalledWith({ action: 'contract.subscription.changed', offset: 0, limit: 100 }));
    fireEvent.click(await screen.findByRole('button', { name: 'Clear “contract.subscription.changed”' }));
    await waitFor(() => expect(api.adminAudit).toHaveBeenLastCalledWith({ action: undefined, offset: 0, limit: 100 }));
  });

  it('says so when there are no events', async () => {
    api.adminAudit.mockResolvedValue({ events: [], total: 0, offset: 0, limit: 100 });
    renderAdmin(<AdminAudit />);
    expect(await screen.findByText('No events for this filter')).toBeInTheDocument();
    expect(screen.getByText('Nothing has been recorded yet.')).toBeInTheDocument();
  });

  it('pages through the log', async () => {
    api.adminAudit.mockResolvedValue({ ...AUDIT, total: 250 });
    renderAdmin(<AdminAudit />);
    expect(await screen.findByText('Showing 1–3 of 250 events')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(api.adminAudit).toHaveBeenLastCalledWith({ action: undefined, offset: 100, limit: 100 }));
  });

  it('keeps a failure apart from an empty log and tries again', async () => {
    api.adminAudit.mockRejectedValueOnce(refusal(503, 'accounts_unavailable'));
    renderAdmin(<AdminAudit />);
    expect(await screen.findByText('A service isn’t available right now (503 · accounts_unavailable)')).toBeInTheDocument();
    expect(screen.queryByText('No events for this filter')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('2 abandoned jobs were reconciled.')).toBeInTheDocument();
  });

  it('says when the API key cannot read the log (403)', async () => {
    api.adminAudit.mockRejectedValue(refusal(403, 'insufficient_api_key_permission'));
    renderAdmin(<AdminAudit />);
    expect(await screen.findByText('This key can’t use administration (403)')).toBeInTheDocument();
  });

  it('shows a person who is not an administrator nothing, and asks the gateway nothing', async () => {
    renderAdmin(<AdminAudit />, { user: MARIA });
    expect(await screen.findByText('Not available (403)')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Events, newest first' })).not.toBeInTheDocument();
    expect(api.adminAudit).not.toHaveBeenCalled();
  });
});
