import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PricingUnavailableError, QuotaError } from '../../api/auth';
import type { Notification, NotificationPreferences, SponsorProposal, UserProfile } from '../../api/auth';
import { HttpError } from '../../api/client';
import { AuthContext } from '../../contexts/auth';
import { AccountNotifications } from './AccountNotifications';

const api = vi.hoisted(() => ({
  listNotifications: vi.fn(),
  getNotificationPreferences: vi.fn(),
  updateNotificationPreferences: vi.fn(),
  markNotificationRead: vi.fn(),
  markAllNotificationsRead: vi.fn(),
  listMySponsorProposals: vi.fn(),
  acceptSponsorProposal: vi.fn(),
  declineSponsorProposal: vi.fn(),
}));

vi.mock('../../api/client', async () => ({ ...await vi.importActual<typeof import('../../api/client')>('../../api/client'), apiClient: api }));

const lucia: UserProfile = {
  id: 'user-id', username: 'lucia', email: 'lucia@example.test', role: 'user', is_active: true, plan: 'RESEARCH', created_at: '2026-03-02T00:00:00Z',
};

const contract: Notification = {
  id: 'n1', kind: 'contract.changed', subject: 'Your OpenBinding agreement changed',
  body: 'Plan: BASIC → RESEARCH. Reason: institutional_agreement.',
  payload: { reason: 'institutional_agreement', previous: { plan: 'BASIC', addOns: {} }, current: { plan: 'RESEARCH', addOns: {} }, pricingVersion: '0.1.0' },
  read_at: null, created_at: '2026-09-01T10:00:00Z',
};
const job: Notification = {
  id: 'n2', kind: 'job.finished', subject: 'Job completed', body: 'Job 0000…f1 finished FEASIBLE.', payload: {},
  read_at: '2026-09-30T10:00:00Z', created_at: '2026-09-30T09:00:00Z',
};
const invitation: Notification = {
  id: 'n3', kind: 'organization.invitation', subject: 'You were invited', body: 'ISA Demo Group invited you.', payload: {},
  read_at: null, created_at: '2026-10-01T10:00:00Z',
};

const preferences: NotificationPreferences = { inbox: true, email_contract_changes: true, email_invitations: true, email_job_failures: false };

function renderNotifications() {
  render(
    <MemoryRouter>
      <AuthContext.Provider value={{ user: lucia, loading: false, signIn: vi.fn(), register: vi.fn(), signOut: vi.fn(), refresh: vi.fn(), isAdmin: false }}>
        <AccountNotifications />
      </AuthContext.Provider>
    </MemoryRouter>,
  );
}

const row = (subject: string) => screen.findByRole('button', { name: new RegExp(subject) });

describe('Notifications', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.listNotifications.mockResolvedValue([contract, job, invitation]);
    api.getNotificationPreferences.mockResolvedValue(preferences);
    api.updateNotificationPreferences.mockImplementation(async (value: NotificationPreferences) => value);
    api.markNotificationRead.mockResolvedValue({ ...contract, read_at: '2026-10-09T12:00:00Z' });
    api.markAllNotificationsRead.mockResolvedValue([]);
    api.listMySponsorProposals.mockReset();
    api.listMySponsorProposals.mockResolvedValue([]);
  });

  it('lists the notices, says how many are unread and marks them', async () => {
    renderNotifications();

    expect(await screen.findByRole('heading', { level: 1, name: 'Notifications' })).toBeInTheDocument();
    expect(await screen.findByText('You have 2 unread notifications')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Notifications', current: 'page' })).toBeInTheDocument();
    expect(await screen.findAllByRole('img', { name: 'Unread' })).toHaveLength(2);
    expect(screen.getByRole('list', { name: 'Notifications' }).children).toHaveLength(3);
    expect(screen.getByText('Notifications are kept for 7 days.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mark all read' })).toBeEnabled();
  });

  it('filters by kind and by unread', async () => {
    renderNotifications();
    await row('Your OpenBinding agreement changed');
    const list = () => screen.getByRole('list', { name: 'Notifications' });

    fireEvent.click(screen.getByRole('button', { name: 'Contract changes' }));
    expect(screen.getByRole('button', { name: 'Contract changes' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(list()).getAllByRole('listitem')).toHaveLength(1);
    expect(within(list()).getByText('Your OpenBinding agreement changed')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Jobs' }));
    expect(within(list()).getByText('Job completed')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Invitations' }));
    expect(within(list()).getByText('You were invited')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    fireEvent.click(screen.getByLabelText('Show unread only'));
    expect(within(list()).getAllByRole('listitem')).toHaveLength(2);
    expect(within(list()).queryByText('Job completed')).not.toBeInTheDocument();
  });

  it('opens a contract change to show what it was before and after', async () => {
    renderNotifications();
    const button = await row('Your OpenBinding agreement changed');
    expect(button).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(button);

    expect(button).toHaveAttribute('aria-expanded', 'true');
    const change = within(screen.getByRole('group', { name: 'Before and after' }));
    expect(change.getByText('Before')).toBeInTheDocument();
    expect(change.getByText('BASIC')).toBeInTheDocument();
    expect(change.getByText('After')).toBeInTheDocument();
    expect(change.getByText('RESEARCH')).toBeInTheDocument();
    expect(change.getAllByText('Add-ons: none')).toHaveLength(2);
    expect(screen.getByText('Reason: institutional agreement · pricing version 0.1.0')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'See my usage' })).toHaveAttribute('href', '/app/account/usage');
  });

  it('marks one as read and tells the header bell', async () => {
    const heard = vi.fn();
    window.addEventListener('openbinding:notifications-updated', heard);
    renderNotifications();
    fireEvent.click(await row('Your OpenBinding agreement changed'));

    fireEvent.click(screen.getByRole('button', { name: 'Mark as read' }));

    await waitFor(() => expect(api.markNotificationRead).toHaveBeenCalledWith('n1'));
    expect(await screen.findByText('You have 1 unread notification')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mark as read' })).not.toBeInTheDocument();
    expect(heard).toHaveBeenCalled();
    window.removeEventListener('openbinding:notifications-updated', heard);
  });

  it('marks all as read', async () => {
    renderNotifications();
    await row('Your OpenBinding agreement changed');
    fireEvent.click(screen.getByRole('button', { name: 'Mark all read' }));

    await waitFor(() => expect(api.markAllNotificationsRead).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('All caught up!')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mark all read' })).toBeDisabled();
    expect(screen.queryAllByRole('img', { name: 'Unread' })).toHaveLength(0);
  });

  it('points a job notice to the job history', async () => {
    renderNotifications();
    fireEvent.click(await row('Job completed'));
    expect(screen.getByRole('link', { name: 'Open job history' })).toHaveAttribute('href', '/app/jobs');
  });

  describe('sponsor requests for you', () => {
    const request = (over: Partial<SponsorProposal> = {}): SponsorProposal => ({
      id: 'prop-1', organization_id: 'org-1', organization_slug: 'isa-demo', organization_name: 'ISA Demo Group',
      proposed_user_id: 'user-id', proposed_username: 'lucia', proposed_by_user_id: 'user-nora', proposed_by_username: 'nora',
      status: 'pending', created_at: '2026-10-08T09:00:00Z', expires_at: '2099-12-31T09:00:00Z',
      decided_at: null, decided_by_user_id: null, decision_reason: null,
      ...over,
    });
    const block = () => screen.findByRole('region', { name: 'Sponsor requests for you' });

    it('shows nothing at all when no one asks', async () => {
      renderNotifications();
      await row('Job completed');
      expect(screen.queryByRole('region', { name: 'Sponsor requests for you' })).not.toBeInTheDocument();
      expect(api.listMySponsorProposals).toHaveBeenCalledWith('pending');
    });

    it('lists who asks for what, with Accept and Decline', async () => {
      api.listMySponsorProposals.mockResolvedValue([request()]);
      renderNotifications();

      const section = within(await block());
      expect(section.getByRole('heading', { name: 'Sponsor requests for you' })).toBeInTheDocument();
      expect(section.getByText('ISA Demo Group')).toBeInTheDocument();
      expect(section.getByText(/nora asks you to sponsor it and everything under it/)).toBeInTheDocument();
      expect(section.getByText(/Expires Dec 31, 2099/)).toBeInTheDocument();
      expect(section.getByRole('button', { name: 'Accept sponsoring ISA Demo Group' })).toBeInTheDocument();
      expect(section.getByRole('button', { name: 'Decline sponsoring ISA Demo Group' })).toBeInTheDocument();
    });

    it('explains whose quota and plan are used before accepting, and accepts only on confirmation', async () => {
      api.listMySponsorProposals.mockResolvedValueOnce([request()]).mockResolvedValue([]);
      api.acceptSponsorProposal.mockResolvedValue(request({ status: 'accepted' }));
      const heard = vi.fn();
      window.addEventListener('openbinding:notifications-updated', heard);
      renderNotifications();

      fireEvent.click(within(await block()).getByRole('button', { name: 'Accept sponsoring ISA Demo Group' }));
      const dialog = await screen.findByRole('dialog', { name: 'Sponsor ISA Demo Group?' });
      expect(dialog).toHaveTextContent('passes to your quota and is limited by your plan (RESEARCH)');
      expect(dialog).toHaveTextContent('If they don’t fit, nothing changes and the request stays open');
      expect(api.acceptSponsorProposal).not.toHaveBeenCalled();

      fireEvent.click(within(dialog).getByRole('button', { name: 'Accept and sponsor' }));
      await waitFor(() => expect(api.acceptSponsorProposal).toHaveBeenCalledWith('prop-1'));
      expect(await screen.findByText('You are now the sponsor of ISA Demo Group. Its consumption counts against your plan.')).toBeInTheDocument();
      expect(heard).toHaveBeenCalled();
      window.removeEventListener('openbinding:notifications-updated', heard);
    });

    it('declines on confirmation and says nothing changes', async () => {
      api.listMySponsorProposals.mockResolvedValueOnce([request()]).mockResolvedValue([]);
      api.declineSponsorProposal.mockResolvedValue(request({ status: 'declined' }));
      renderNotifications();

      fireEvent.click(within(await block()).getByRole('button', { name: 'Decline sponsoring ISA Demo Group' }));
      const dialog = await screen.findByRole('dialog', { name: 'Decline sponsoring ISA Demo Group?' });
      expect(dialog).toHaveTextContent('Nothing changes: ISA Demo Group keeps its current sponsor');
      fireEvent.click(within(dialog).getByRole('button', { name: 'Decline request' }));

      await waitFor(() => expect(api.declineSponsorProposal).toHaveBeenCalledWith('prop-1'));
      expect(await screen.findByText('You declined to sponsor ISA Demo Group.')).toBeInTheDocument();
    });

    it.each([
      ['402 over the plan', new QuotaError('sponsor_quota_exceeded', 'full', { limit_id: 'members', limit: 15, used: 18 }),
        'Your plan can’t take this organization and everything under it (402 · sponsor_quota_exceeded). members: 18 of 15 used. The request is still waiting'],
      ['503 pricing', new PricingUnavailableError('down'), 'Limits can’t be checked right now (503 · pricing_unavailable). Nothing changed; the request is still waiting. Try again in a moment.'],
      ['409 expired', Object.assign(new HttpError(409, 'expired'), { code: 'sponsor_proposal_expired' }), 'This request expired (409 · sponsor_proposal_expired).'],
      ['409 answered already', Object.assign(new HttpError(409, 'no'), { code: 'sponsor_proposal_not_pending', problem: { detail: { status: 'cancelled' } } }), 'This request was already cancelled (409 · sponsor_proposal_not_pending).'],
    ])('keeps the dialog open and says why when accepting fails: %s', async (_name, error, text) => {
      api.listMySponsorProposals.mockResolvedValue([request()]);
      api.acceptSponsorProposal.mockRejectedValue(error);
      renderNotifications();

      fireEvent.click(within(await block()).getByRole('button', { name: 'Accept sponsoring ISA Demo Group' }));
      const dialog = await screen.findByRole('dialog');
      fireEvent.click(within(dialog).getByRole('button', { name: 'Accept and sponsor' }));

      expect(await within(dialog).findByRole('alert')).toHaveTextContent(text);
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    it('offers to try again after a pricing outage', async () => {
      api.listMySponsorProposals.mockResolvedValue([request()]);
      api.acceptSponsorProposal.mockRejectedValueOnce(new PricingUnavailableError('down')).mockResolvedValueOnce(request({ status: 'accepted' }));
      renderNotifications();

      fireEvent.click(within(await block()).getByRole('button', { name: 'Accept sponsoring ISA Demo Group' }));
      const dialog = await screen.findByRole('dialog');
      fireEvent.click(within(dialog).getByRole('button', { name: 'Accept and sponsor' }));
      fireEvent.click(await within(dialog).findByRole('button', { name: 'Try again' }));

      await waitFor(() => expect(api.acceptSponsorProposal).toHaveBeenCalledTimes(2));
      expect(await screen.findByText(/You are now the sponsor of ISA Demo Group/)).toBeInTheDocument();
    });
  });

  it('says when it is all caught up and when a filter hides everything', async () => {
    api.listNotifications.mockResolvedValue([]);
    renderNotifications();

    expect(await screen.findByText('No notifications found')).toBeInTheDocument();
    expect(screen.getByText('Contract changes and other notices will show up here.')).toBeInTheDocument();
    expect(screen.getByText('All caught up!')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mark all read' })).toBeDisabled();
  });

  it('says nothing matches when the filters hide every notice', async () => {
    api.listNotifications.mockResolvedValue([job]);
    renderNotifications();
    await row('Job completed');

    fireEvent.click(screen.getByRole('button', { name: 'Invitations' }));
    expect(await screen.findByText('Nothing matches these filters.')).toBeInTheDocument();
  });

  it('says plainly when the notices cannot be loaded, and tries again on request', async () => {
    api.listNotifications.mockRejectedValueOnce(new HttpError(503, 'down'));
    renderNotifications();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Notifications couldn’t be loaded.');
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await row('Job completed')).toBeInTheDocument();
  });

  it('explains a refused read (403)', async () => {
    api.listNotifications.mockRejectedValue(new HttpError(403, 'forbidden'));
    renderNotifications();
    expect(await screen.findByRole('alert')).toHaveTextContent('notifications:read');
  });

  describe('email preferences', () => {
    const switchFor = (label: string) => screen.findByRole('switch', { name: label });

    it('shows the contract-change switch first, with the other delivery preferences of the contract', async () => {
      renderNotifications();

      const first = await switchFor('Email me about contract changes');
      expect(first).toHaveAttribute('aria-checked', 'true');
      expect(screen.getByRole('switch', { name: 'Email me about invitations' })).toHaveAttribute('aria-checked', 'true');
      expect(screen.getByRole('switch', { name: 'Email me about failed jobs' })).toHaveAttribute('aria-checked', 'false');
      expect(screen.getByRole('switch', { name: 'Keep notifications in the account inbox' })).toHaveAttribute('aria-checked', 'true');
      expect(screen.getAllByRole('switch')[0]).toBe(first);
      expect(screen.getByText('In-app notifications are always on.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Save preferences' })).toBeDisabled();
    });

    it('saves the whole set of preferences after a change, and says it was saved', async () => {
      renderNotifications();
      fireEvent.click(await switchFor('Email me about contract changes'));

      expect(screen.getByText('You have unsaved changes')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Save preferences' }));

      await waitFor(() => expect(api.updateNotificationPreferences).toHaveBeenCalledWith({
        inbox: true, email_contract_changes: false, email_invitations: true, email_job_failures: false,
      }));
      expect(await screen.findByRole('button', { name: 'Saved' })).toBeDisabled();
      expect(screen.getByRole('switch', { name: 'Email me about contract changes' })).toHaveAttribute('aria-checked', 'false');

      fireEvent.click(screen.getByRole('switch', { name: 'Email me about contract changes' }));
      expect(screen.getByRole('button', { name: 'Save preferences' })).toBeEnabled();
    });

    it('does not claim a save that failed', async () => {
      api.updateNotificationPreferences.mockRejectedValue(new HttpError(503, 'down'));
      renderNotifications();
      fireEvent.click(await switchFor('Email me about failed jobs'));
      fireEvent.click(screen.getByRole('button', { name: 'Save preferences' }));

      expect(await screen.findByText(/Nothing was saved/)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Saved' })).not.toBeInTheDocument();
      expect(screen.getByText('You have unsaved changes')).toBeInTheDocument();
    });

    it('says when the preferences cannot be loaded', async () => {
      api.getNotificationPreferences.mockRejectedValue(new HttpError(503, 'down'));
      renderNotifications();
      expect(await screen.findByText('Email preferences couldn’t be loaded.')).toBeInTheDocument();
      expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    });
  });
});
