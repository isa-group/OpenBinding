import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Notification } from '../../api/auth';
import { NotificationDropdown } from './NotificationDropdown';

const api = vi.hoisted(() => ({
  listNotifications: vi.fn(),
  markNotificationRead: vi.fn(),
  markAllNotificationsRead: vi.fn(),
  listMySponsorProposals: vi.fn(),
}));

vi.mock('../../api/client', async () => ({
  ...await vi.importActual<typeof import('../../api/client')>('../../api/client'),
  apiClient: api,
}));

const mockUnreadNotification: Notification = {
  id: 'notif-1',
  kind: 'info',
  subject: 'Job completed successfully',
  body: 'Your optimization job #1234 has finished solving.',
  payload: {},
  read_at: null,
  created_at: new Date(Date.now() - 3600000).toISOString(), // 1 hour ago
};

const mockReadNotification: Notification = {
  id: 'notif-2',
  kind: 'info',
  subject: 'Contract novation notice',
  body: 'Your terms have been updated.',
  payload: {},
  read_at: new Date(Date.now() - 7200000).toISOString(),
  created_at: new Date(Date.now() - 86400000).toISOString(), // 1 day ago
};

describe('NotificationDropdown', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.listMySponsorProposals.mockResolvedValue([]);
  });

  it('renders standard bell icon and no badge when there are no unread notifications', async () => {
    api.listNotifications.mockResolvedValue([mockReadNotification]);

    render(
      <MemoryRouter>
        <NotificationDropdown />
      </MemoryRouter>
    );

    await waitFor(() => expect(api.listNotifications).toHaveBeenCalled());

    const trigger = screen.getByRole('button', { name: 'Notifications' });
    expect(trigger).toBeInTheDocument();
    expect(trigger.querySelector('.notification-badge')).toBeNull();
    expect(trigger.querySelector('.notification-icon.has-unread')).toBeNull();
  });

  it('renders BellDot icon and outside badge with unread count when there are unread notifications', async () => {
    api.listNotifications.mockResolvedValue([mockUnreadNotification, mockReadNotification]);

    render(
      <MemoryRouter>
        <NotificationDropdown />
      </MemoryRouter>
    );

    const trigger = await screen.findByRole('button', { name: '1 unread notifications' });
    expect(trigger).toBeInTheDocument();

    const badge = trigger.querySelector('.notification-badge');
    expect(badge).not.toBeNull();
    expect(badge).toHaveTextContent('1');

    const icon = trigger.querySelector('.notification-icon.has-unread');
    expect(icon).not.toBeNull();
  });

  it('opens dropdown menu on click, showing unread messages by default', async () => {
    api.listNotifications.mockResolvedValue([mockUnreadNotification, mockReadNotification]);

    render(
      <MemoryRouter>
        <NotificationDropdown />
      </MemoryRouter>
    );

    const trigger = await screen.findByRole('button', { name: '1 unread notifications' });
    fireEvent.click(trigger);

    expect(screen.getByRole('dialog', { name: 'Notifications panel' })).toBeInTheDocument();
    expect(screen.getByText('Job completed successfully')).toBeInTheDocument();
    // Default tab is unread, so mockReadNotification is not visible in unread list
    expect(screen.queryByText('Contract novation notice')).toBeNull();
  });

  it('enlarges the panel to view all notifications when clicking enlarge button', async () => {
    api.listNotifications.mockResolvedValue([mockUnreadNotification, mockReadNotification]);

    render(
      <MemoryRouter>
        <NotificationDropdown />
      </MemoryRouter>
    );

    const trigger = await screen.findByRole('button', { name: '1 unread notifications' });
    fireEvent.click(trigger);

    const enlargeBtn = screen.getByRole('button', { name: 'Enlarge to view all' });
    fireEvent.click(enlargeBtn);

    const panel = screen.getByRole('dialog', { name: 'Notifications panel' });
    expect(panel).toHaveClass('is-enlarged');

    // Both unread and read are visible
    expect(screen.getByText('Job completed successfully')).toBeInTheDocument();
    expect(screen.getByText('Contract novation notice')).toBeInTheDocument();

    // The enlarge button switches to reduce
    expect(screen.getByRole('button', { name: 'Reduce size' })).toBeInTheDocument();
  });

  it('marks individual unread notification as read when clicked', async () => {
    api.listNotifications.mockResolvedValue([mockUnreadNotification]);
    api.markNotificationRead.mockResolvedValue({
      ...mockUnreadNotification,
      read_at: new Date().toISOString(),
    });

    render(
      <MemoryRouter>
        <NotificationDropdown />
      </MemoryRouter>
    );

    const trigger = await screen.findByRole('button', { name: '1 unread notifications' });
    fireEvent.click(trigger);

    const notifItem = screen.getByRole('button', { name: /Mark as read: Job completed successfully/ });
    fireEvent.click(notifItem);

    await waitFor(() => {
      expect(api.markNotificationRead).toHaveBeenCalledWith('notif-1');
    });
  });

  it('marks all notifications as read when clicking mark all button', async () => {
    api.listNotifications.mockResolvedValue([mockUnreadNotification]);
    api.markAllNotificationsRead.mockResolvedValue([
      { ...mockUnreadNotification, read_at: new Date().toISOString() },
    ]);

    render(
      <MemoryRouter>
        <NotificationDropdown />
      </MemoryRouter>
    );

    const trigger = await screen.findByRole('button', { name: '1 unread notifications' });
    fireEvent.click(trigger);

    const markAllBtn = screen.getByRole('button', { name: 'Mark all as read' });
    fireEvent.click(markAllBtn);

    await waitFor(() => {
      expect(api.markAllNotificationsRead).toHaveBeenCalled();
    });
  });

  it('displays 7-day lifecycle retention note in footer', async () => {
    api.listNotifications.mockResolvedValue([]);

    render(
      <MemoryRouter>
        <NotificationDropdown />
      </MemoryRouter>
    );

    await waitFor(() => expect(api.listNotifications).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: 'Notifications' }));

    expect(screen.getByText('Lifetime: 7 days')).toBeInTheDocument();
  });

  describe('sponsor requests waiting for the account', () => {
    const waiting = (n: number) => Array.from({ length: n }, (_, index) => ({ id: `prop-${index}`, status: 'pending' }));

    it('shows the count on the bell even when no notice is unread, and says so for assistive technology', async () => {
      api.listNotifications.mockResolvedValue([mockReadNotification]);
      api.listMySponsorProposals.mockResolvedValue(waiting(2));

      render(<MemoryRouter><NotificationDropdown /></MemoryRouter>);

      const trigger = await screen.findByRole('button', { name: 'Notifications, 2 sponsor requests waiting for you' });
      expect(trigger.querySelector('.notification-badge')).toHaveTextContent('2');
      expect(api.listMySponsorProposals).toHaveBeenCalledWith('pending');
    });

    it('does not count a request twice when its notice is unread too', async () => {
      api.listNotifications.mockResolvedValue([mockUnreadNotification]);
      api.listMySponsorProposals.mockResolvedValue(waiting(1));

      render(<MemoryRouter><NotificationDropdown /></MemoryRouter>);

      const trigger = await screen.findByRole('button', { name: '1 unread notifications, 1 sponsor request waiting for you' });
      expect(trigger.querySelector('.notification-badge')).toHaveTextContent('1');
    });

    it('leads from the panel to the place where it is answered', async () => {
      api.listNotifications.mockResolvedValue([]);
      api.listMySponsorProposals.mockResolvedValue(waiting(1));

      render(<MemoryRouter><NotificationDropdown /></MemoryRouter>);

      fireEvent.click(await screen.findByRole('button', { name: 'Notifications, 1 sponsor request waiting for you' }));
      expect(screen.getByRole('link', { name: /1 sponsor request waiting for you/ })).toHaveAttribute('href', '/app/account/notifications');
    });

    it('keeps the bell working when the requests can not be read', async () => {
      api.listNotifications.mockResolvedValue([mockUnreadNotification]);
      api.listMySponsorProposals.mockRejectedValue(new Error('down'));

      render(<MemoryRouter><NotificationDropdown /></MemoryRouter>);

      expect(await screen.findByRole('button', { name: '1 unread notifications' })).toBeInTheDocument();
    });
  });
});
