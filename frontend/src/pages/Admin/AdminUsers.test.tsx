import { configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserProfile } from '../../api/auth';
import { AdminUsers } from './AdminUsers';
import { ALEX, DANA, JORDAN, MARIA, SAM, USERS, userPage } from '../../test/fixtures/admin';
import { refusal, renderAdmin } from './adminTestUtils';

const api = vi.hoisted(() => ({
  adminListUsers: vi.fn(),
  adminUpdateUser: vi.fn(),
}));

vi.mock('../../api/client', async () => ({
  ...await vi.importActual<typeof import('../../api/client')>('../../api/client'),
  apiClient: api,
}));

// The first render of a file is slow on a busy machine.
configure({ asyncUtilTimeout: 5000 });

const row = (name: string) => screen.getByRole('row', { name });

describe('admin-users · accounts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.adminListUsers.mockResolvedValue(userPage());
    api.adminUpdateUser.mockImplementation(async (userId: string) => USERS.find((account) => account.id === userId));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lists each account with its role, plan, status and a way into its agreement', async () => {
    renderAdmin(<AdminUsers />);
    expect(screen.getByRole('heading', { level: 1, name: 'Accounts' })).toBeInTheDocument();
    const sam = await screen.findByRole('row', { name: 'sam.okafor' });
    expect(within(sam).getByRole('link', { name: 'sam.okafor' })).toHaveAttribute('href', `/app/admin/users/${SAM.id}`);
    expect(within(sam).getByText('BASIC')).toBeInTheDocument();
    expect(within(row('jordan.lee')).getByText('contract pending')).toBeInTheDocument();
    expect(within(row('dana.kim')).getByText('Inactive')).toBeInTheDocument();
    const alex = row('alex.rivera');
    expect(within(alex).getByText('you')).toBeInTheDocument();
    expect(within(alex).getByText('Admin')).toBeInTheDocument();
    expect(within(row('maria.santos')).getByText('✓ CAS')).toBeInTheDocument();
    expect(screen.getByText('Showing 1–6 of 6 accounts')).toBeInTheDocument();
  });

  it('shows the administration bar with this section as the current one', async () => {
    renderAdmin(<AdminUsers />);
    await screen.findByRole('row', { name: 'sam.okafor' });
    const nav = screen.getByRole('navigation', { name: 'Administration' });
    expect(within(nav).getByText('Accounts')).toHaveAttribute('aria-current', 'page');
    expect(within(nav).getByRole('link', { name: 'Overview' })).toHaveAttribute('href', '/app/admin');
    expect(within(nav).getByRole('link', { name: 'Audit' })).toHaveAttribute('href', '/app/admin/audit');
    expect(screen.getByRole('navigation', { name: 'Breadcrumb' })).toBeInTheDocument();
  });

  it('asks the gateway for matches after a pause in typing', async () => {
    renderAdmin(<AdminUsers />);
    await screen.findByRole('row', { name: 'sam.okafor' });
    api.adminListUsers.mockResolvedValue(userPage([SAM]));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search accounts' }), { target: { value: 'sam' } });
    await waitFor(() => expect(api.adminListUsers).toHaveBeenLastCalledWith({ search: 'sam', offset: 0, limit: 50 }));
    await waitFor(() => expect(screen.queryByRole('row', { name: 'maria.santos' })).not.toBeInTheDocument());
    expect(row('sam.okafor')).toBeInTheDocument();
  });

  it('narrows the page by role, status and plan', async () => {
    renderAdmin(<AdminUsers />);
    await screen.findByRole('row', { name: 'sam.okafor' });

    fireEvent.click(within(screen.getByRole('group', { name: 'Role' })).getByRole('button', { name: 'Admins' }));
    expect(row('alex.rivera')).toBeInTheDocument();
    expect(screen.queryByRole('row', { name: 'sam.okafor' })).not.toBeInTheDocument();
    fireEvent.click(within(screen.getByRole('group', { name: 'Role' })).getByRole('button', { name: 'Any role' }));

    fireEvent.click(within(screen.getByRole('group', { name: 'Status' })).getByRole('button', { name: 'Contract pending' }));
    expect(row('jordan.lee')).toBeInTheDocument();
    expect(screen.queryByRole('row', { name: 'maria.santos' })).not.toBeInTheDocument();
    fireEvent.click(within(screen.getByRole('group', { name: 'Status' })).getByRole('button', { name: 'Inactive' }));
    expect(row('dana.kim')).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole('group', { name: 'Status' })).getByRole('button', { name: 'Any status' }));

    fireEvent.change(screen.getByLabelText('Plan'), { target: { value: 'ADVANCED' } });
    expect(row('priya.nair')).toBeInTheDocument();
    expect(screen.queryByRole('row', { name: 'sam.okafor' })).not.toBeInTheDocument();
    expect(screen.getByText(/Filters narrow the accounts on this page/)).toBeInTheDocument();
  });

  it('says so when nothing matches, and clears the filters', async () => {
    renderAdmin(<AdminUsers />);
    await screen.findByRole('row', { name: 'sam.okafor' });
    fireEvent.click(within(screen.getByRole('group', { name: 'Role' })).getByRole('button', { name: 'Admins' }));
    fireEvent.click(within(screen.getByRole('group', { name: 'Status' })).getByRole('button', { name: 'Inactive' }));
    expect(screen.getByText('No account matches')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(await screen.findByRole('row', { name: 'sam.okafor' })).toBeInTheDocument();
  });

  it('invites nothing when the platform has no accounts at all', async () => {
    api.adminListUsers.mockResolvedValue(userPage([]));
    renderAdmin(<AdminUsers />);
    expect(await screen.findByText('There are no accounts yet')).toBeInTheDocument();
    expect(screen.queryByText('No account matches')).not.toBeInTheDocument();
  });

  it('deactivates an account only after a confirmation, then reads the list again', async () => {
    renderAdmin(<AdminUsers />);
    await screen.findByRole('row', { name: 'sam.okafor' });
    fireEvent.click(screen.getByRole('button', { name: 'Deactivate sam.okafor' }));
    const dialog = screen.getByRole('dialog', { name: 'Deactivate sam.okafor?' });
    expect(api.adminUpdateUser).not.toHaveBeenCalled();
    expect(within(dialog).getByText(/The gateway doesn’t write this change to the audit log/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Deactivate' }));
    expect(await screen.findByText('sam.okafor was deactivated.')).toBeInTheDocument();
    expect(api.adminUpdateUser).toHaveBeenCalledWith(SAM.id, { is_active: false });
    await waitFor(() => expect(api.adminListUsers).toHaveBeenCalledTimes(2));
  });

  it('reactivates an inactive account and changes a role', async () => {
    renderAdmin(<AdminUsers />);
    await screen.findByRole('row', { name: 'dana.kim' });
    fireEvent.click(screen.getByRole('button', { name: 'Reactivate dana.kim' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Reactivate dana.kim?' })).getByRole('button', { name: 'Reactivate' }));
    expect(await screen.findByText('dana.kim was reactivated.')).toBeInTheDocument();
    expect(api.adminUpdateUser).toHaveBeenCalledWith(DANA.id, { is_active: true });

    fireEvent.click(screen.getByRole('button', { name: 'Make admin maria.santos' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Make maria.santos an administrator?' })).getByRole('button', { name: 'Make administrator' }));
    expect(await screen.findByText('maria.santos is now an administrator.')).toBeInTheDocument();
    expect(api.adminUpdateUser).toHaveBeenCalledWith(MARIA.id, { role: 'admin' });
  });

  it('does not close the dialog on a click of Cancel, and changes nothing', async () => {
    renderAdmin(<AdminUsers />);
    await screen.findByRole('row', { name: 'jordan.lee' });
    fireEvent.click(screen.getByRole('button', { name: 'Deactivate jordan.lee' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(api.adminUpdateUser).not.toHaveBeenCalled();
    expect(JORDAN.is_active).toBe(true);
  });

  it('refuses to let an administrator deactivate or demote themselves, without asking the gateway', async () => {
    renderAdmin(<AdminUsers />);
    await screen.findByRole('row', { name: 'alex.rivera' });
    fireEvent.click(screen.getByRole('button', { name: 'Make user alex.rivera' }));
    expect(screen.getByText('You can’t demote or deactivate yourself (409 · cannot_demote_self)')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Deactivate alex.rivera' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(api.adminUpdateUser).not.toHaveBeenCalled();
  });

  it('reports what the gateway refuses with (409 cannot_demote_self from someone else’s session, 503)', async () => {
    renderAdmin(<AdminUsers />);
    await screen.findByRole('row', { name: 'maria.santos' });
    api.adminUpdateUser.mockRejectedValueOnce(refusal(409, 'cannot_demote_self'));
    fireEvent.click(screen.getByRole('button', { name: 'Deactivate maria.santos' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Deactivate' }));
    expect(await screen.findByText('You can’t demote or deactivate yourself (409 · cannot_demote_self)')).toBeInTheDocument();

    api.adminUpdateUser.mockRejectedValueOnce(refusal(503, 'pricing_unavailable', 'SPACE is down'));
    fireEvent.click(screen.getByRole('button', { name: 'Deactivate maria.santos' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Deactivate' }));
    expect(await screen.findByText('A service isn’t available right now (503 · pricing_unavailable)')).toBeInTheDocument();
  });

  it('pages through the accounts', async () => {
    api.adminListUsers.mockResolvedValue(userPage(USERS, { total: 120 }));
    renderAdmin(<AdminUsers />);
    expect(await screen.findByText('Showing 1–6 of 120 accounts')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(api.adminListUsers).toHaveBeenLastCalledWith({ search: undefined, offset: 50, limit: 50 }));
  });

  it('keeps a failed load apart from an empty list and retries', async () => {
    api.adminListUsers.mockRejectedValueOnce(refusal(503, 'accounts_unavailable', 'down'));
    renderAdmin(<AdminUsers />);
    expect(await screen.findByText('A service isn’t available right now (503 · accounts_unavailable)')).toBeInTheDocument();
    expect(screen.queryByText('There are no accounts yet')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('row', { name: 'sam.okafor' })).toBeInTheDocument();
  });

  it('says when the API key behind the session cannot use administration (403)', async () => {
    api.adminListUsers.mockRejectedValue(refusal(403, 'insufficient_api_key_permission'));
    renderAdmin(<AdminUsers />);
    expect(await screen.findByText('This key can’t use administration (403)')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });

  it('shows a person who is not an administrator nothing, and asks the gateway nothing', async () => {
    const maria: UserProfile = { ...MARIA };
    renderAdmin(<AdminUsers />, { user: maria });
    expect(await screen.findByText('Not available (403)')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1, name: 'Accounts' })).not.toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Administration' })).not.toBeInTheDocument();
    expect(api.adminListUsers).not.toHaveBeenCalled();
    expect(ALEX.role).toBe('admin');
  });
});
