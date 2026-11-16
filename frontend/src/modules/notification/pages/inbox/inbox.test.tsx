import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { addressNow, fakeGateway, renderModule } from '../../../../test/moduleKit';
import { NotificationsProvider } from '../../contexts/notificationsProvider';
import NotificationBell from '../../components/notification-bell';
import InboxPage from '.';

const note = (
  id: string,
  kind: string,
  subject: string,
  payload: Record<string, unknown>,
  read = false
) => ({
  id,
  kind,
  subject,
  body: `${subject}.`,
  payload,
  read_at: read ? '2026-11-01T00:00:00Z' : null,
  created_at: '2026-11-15T10:00:00Z',
});
const invite = note(
  'n1',
  'OrganizationInvitation',
  'You have been invited to join ISA Demo Group',
  {
    invitation_code: 'c0de0000c0de0000',
    organization_name: 'ISA Demo Group',
  }
);
const run = note(
  'n2',
  'RunFinished',
  'Run finished',
  { run_id: 'r-1', organization_slug: 'isa-demo' },
  true
);

function gateway() {
  return fakeGateway({
    'GET /v1/notifications': ({ path }) => ({
      body: path.includes('kind=RunFinished')
        ? [run]
        : path.includes('unread_only')
          ? [invite]
          : [invite, run],
    }),
    'GET /v1/notifications/unread-count': { body: { count: 1 } },
    'POST /v1/notifications/n1/read': { body: { ...invite, read_at: '2026-11-16T00:00:00Z' } },
    'DELETE /v1/notifications/n2': { status: 204 },
    'POST /v1/notifications/read-all': { body: { updated: 1 } },
  });
}

const renderInbox = (entry = '/notifications', element = <InboxPage />) =>
  renderModule(<NotificationsProvider>{element}</NotificationsProvider>, {
    entry,
    gateway: gateway(),
    routes: { '/orgs/join/:code': <h1>Join page</h1> },
  });

describe('/notifications', () => {
  it('lists the notifications with the unread count, and filters by kind in the address', async () => {
    renderInbox();
    expect(await screen.findByText('You have 1 unread notification')).toBeInTheDocument();
    expect(
      await screen.findByText('You have been invited to join ISA Demo Group')
    ).toBeInTheDocument();
    expect(screen.getByText('Organization: ISA Demo Group')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Runs finished' }));
    await waitFor(() => expect(addressNow()).toBe('/notifications?kind=RunFinished'));
    await waitFor(() =>
      expect(
        screen.queryByText('You have been invited to join ISA Demo Group')
      ).not.toBeInTheDocument()
    );
  });

  it('opens an invitation at its join page, marking it read', async () => {
    const { gateway: calls } = renderInbox();
    fireEvent.click(await screen.findByRole('button', { name: /^You have been invited/ }));
    await waitFor(() => expect(addressNow()).toBe('/orgs/join/c0de0000c0de0000'));
    expect(calls).toHaveBeenCalledWith(
      '/v1/notifications/n1/read',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('deletes one notification', async () => {
    const { gateway: calls } = renderInbox();
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Run finished' }));
    await waitFor(() => expect(screen.queryByText('Run finished.')).not.toBeInTheDocument());
    expect(calls).toHaveBeenCalledWith(
      '/v1/notifications/n2',
      expect.objectContaining({ method: 'DELETE' })
    );
  });
});

describe('the notification bell', () => {
  it('says how many are unread and opens the latest ten, with the way to the inbox', async () => {
    renderInbox('/', <NotificationBell />);
    const bell = await screen.findByRole('button', { name: 'Notifications, 1 unread' });
    fireEvent.click(bell);
    const panel = await screen.findByRole('dialog', { name: 'Notifications' });
    expect(await within(panel).findByText('Run finished')).toBeInTheDocument();
    expect(within(panel).getByRole('link', { name: 'View all notifications' })).toHaveAttribute(
      'href',
      '/notifications'
    );
  });
});
