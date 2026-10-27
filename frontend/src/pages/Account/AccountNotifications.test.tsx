import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Notification, NotificationPreferences, UserProfile } from '../../api/auth';
import { HttpError } from '../../api/client';
import { AuthContext } from '../../contexts/auth';
import { AccountNotifications } from './AccountNotifications';

const api = vi.hoisted(() => ({
  listNotifications: vi.fn(),
  getNotificationPreferences: vi.fn(),
  updateNotificationPreferences: vi.fn(),
  markNotificationRead: vi.fn(),
  markAllNotificationsRead: vi.fn(),
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
    expect(screen.getByRole('link', { name: 'See your plan' })).toHaveAttribute('href', '/app/account/usage');
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
