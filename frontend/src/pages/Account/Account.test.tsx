import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserProfile } from '../../api/auth';
import { HttpError } from '../../api/client';
import { AuthContext } from '../../contexts/auth';
import { Account } from './Account';

const api = vi.hoisted(() => ({
  getOwnUsage: vi.fn(),
  updateOwnProfile: vi.fn(),
  deleteOwnAccount: vi.fn(),
  clearTokens: vi.fn(),
}));
const navigation = vi.hoisted(() => ({ leaveTo: vi.fn() }));

vi.mock('../../api/client', async () => ({ ...await vi.importActual<typeof import('../../api/client')>('../../api/client'), apiClient: api }));
vi.mock('../../utils/navigation', () => navigation);

const alice: UserProfile = {
  id: 'user-id', username: 'alice', email: 'alice@example.test', role: 'user', is_active: true, plan: 'BASIC', created_at: '2026-03-02T00:00:00Z',
};

const refusal = (status: number, code: string) => {
  const error = new HttpError(status, code);
  error.code = code;
  return error;
};

function renderAccount(user: UserProfile = alice, entry = '/app/account') {
  const auth = { user, loading: false, signIn: vi.fn(), register: vi.fn(), signOut: vi.fn().mockResolvedValue(undefined), refresh: vi.fn().mockResolvedValue(undefined), isAdmin: user.role === 'admin' };
  render(
    <MemoryRouter initialEntries={[entry]}>
      <AuthContext.Provider value={auth}>
        <Routes>
          <Route path="/app/account" element={<Account />} />
          <Route path="/app/account/keys" element={<h1>Keys screen</h1>} />
          <Route path="/app/account/identities" element={<h1>Identities screen</h1>} />
          <Route path="/app/jobs" element={<h1>Job history screen</h1>} />
          <Route path="/login" element={<h1>Sign in screen</h1>} />
        </Routes>
      </AuthContext.Provider>
    </MemoryRouter>,
  );
  return auth;
}

const type = (label: string | RegExp, value: string, index = 0) =>
  fireEvent.change(screen.getAllByLabelText(label)[index], { target: { value } });

describe('Profile & security', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getOwnUsage.mockResolvedValue({ plan: 'BASIC', contract_pending: false, features: {}, capabilities: {}, limits: {} });
    api.updateOwnProfile.mockResolvedValue(alice);
    api.deleteOwnAccount.mockResolvedValue(undefined);
  });

  it('shows who is signed in, with the role and the plan apart, and the account navigation', async () => {
    renderAccount();

    expect(await screen.findByRole('heading', { level: 1, name: 'Account' })).toBeInTheDocument();
    expect(screen.getByText('alice')).toBeInTheDocument();
    expect(screen.getByText('alice@example.test · member since Mar 2, 2026')).toBeInTheDocument();
    expect(screen.getByText('Role · user')).toBeInTheDocument();
    expect(screen.getByText('Plan · BASIC')).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Account' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Profile & security' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'API keys' })).toHaveAttribute('href', '/app/account/keys');
    expect(screen.queryByText(/Universidad de Sevilla/)).not.toBeInTheDocument();
  });

  it('marks an institutional account by its plan, and never by its email address', async () => {
    renderAccount({ ...alice, email: 'lucia@us.es', plan: 'RESEARCH' });
    expect(await screen.findByText('Universidad de Sevilla · verified')).toBeInTheDocument();
  });

  it('does not take a @us.es address for an institutional account', async () => {
    renderAccount({ ...alice, email: 'someone@us.es', plan: 'BASIC' });
    await screen.findByRole('heading', { level: 1, name: 'Account' });
    expect(screen.queryByText('Universidad de Sevilla · verified')).not.toBeInTheDocument();
  });

  it('says when the contract is still pending', async () => {
    api.getOwnUsage.mockResolvedValue({ plan: 'BASIC', contract_pending: true, features: {}, capabilities: {}, limits: {} });
    renderAccount();
    expect(await screen.findByText('Contract pending')).toBeInTheDocument();
  });

  it('explains a refused read (403) without breaking the page', async () => {
    api.getOwnUsage.mockRejectedValue(refusal(403, 'forbidden'));
    renderAccount();

    const notice = await screen.findByRole('alert');
    expect(notice).toHaveTextContent('403');
    expect(notice).toHaveTextContent('account:read');
    expect(screen.getByRole('heading', { name: 'Email' })).toBeInTheDocument();
  });

  it('sends visitors of the old tabs to the screens that replaced them', async () => {
    renderAccount(alice, '/app/account?tab=keys');
    expect(await screen.findByRole('heading', { name: 'Keys screen' })).toBeInTheDocument();
  });

  it('sends the old history tab to the job history screen', async () => {
    renderAccount(alice, '/app/account?tab=history');
    expect(await screen.findByRole('heading', { name: 'Job history screen' })).toBeInTheDocument();
  });

  describe('email', () => {
    it('cannot be saved until it changes, and needs the current password', async () => {
      renderAccount();
      const save = await screen.findByRole('button', { name: 'Save changes' });
      expect(save).toBeDisabled();

      type('Email address', 'new@example.test');
      expect(save).toBeEnabled();
      expect(screen.getByText('You have unsaved changes')).toBeInTheDocument();

      fireEvent.click(save);
      expect(await screen.findByText('Enter your current password to change your email.')).toBeInTheDocument();
      expect(api.updateOwnProfile).not.toHaveBeenCalled();
    });

    it('saves the new address with the current password and refreshes the profile', async () => {
      const auth = renderAccount();
      await screen.findByRole('button', { name: 'Save changes' });

      type('Email address', 'new@example.test');
      type('Current password', 'old-password-123', 0);
      fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

      await waitFor(() => expect(api.updateOwnProfile).toHaveBeenCalledWith({ email: 'new@example.test', current_password: 'old-password-123' }));
      expect(await screen.findByText('Email updated to new@example.test.')).toBeInTheDocument();
      expect(auth.refresh).toHaveBeenCalled();
    });

    it('reports an address already in use (409) on the field', async () => {
      api.updateOwnProfile.mockRejectedValue(refusal(409, 'already_registered'));
      renderAccount();
      await screen.findByRole('button', { name: 'Save changes' });

      type('Email address', 'taken@example.test');
      type('Current password', 'old-password-123', 0);
      fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

      const field = await screen.findByLabelText('Email address');
      await waitFor(() => expect(field).toHaveAttribute('aria-invalid', 'true'));
      expect(field).toHaveAccessibleDescription('That email is already used by another account (409 · already_registered).');
    });

    it('reports a wrong current password (401) on the password field', async () => {
      api.updateOwnProfile.mockRejectedValue(refusal(401, 'invalid_credentials'));
      renderAccount();
      await screen.findByRole('button', { name: 'Save changes' });

      type('Email address', 'new@example.test');
      type('Current password', 'wrong', 0);
      fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

      await waitFor(() => expect(screen.getAllByLabelText('Current password')[0]).toHaveAttribute('aria-invalid', 'true'));
      expect(screen.getAllByLabelText('Current password')[0]).toHaveAccessibleDescription('That isn’t your current password (401 · invalid_credentials).');
    });
  });

  describe('password', () => {
    it('asks for the new password twice before calling the API', async () => {
      renderAccount();
      await screen.findByRole('button', { name: 'Change password' });

      type('Current password', 'old-password-123', 1);
      type('New password', 'new-secure-password');
      type('Confirm new password', 'something-different');
      fireEvent.click(screen.getByRole('button', { name: 'Change password' }));

      expect(await screen.findByText('New password and confirm password do not match.')).toBeInTheDocument();
      expect(api.updateOwnProfile).not.toHaveBeenCalled();
    });

    it('asks for at least ten characters, like the gateway does', async () => {
      renderAccount();
      await screen.findByRole('button', { name: 'Change password' });

      type('New password', 'short');
      expect(screen.getByText('5 more characters needed')).toBeInTheDocument();
      type('Current password', 'old-password-123', 1);
      type('Confirm new password', 'short');
      fireEvent.click(screen.getByRole('button', { name: 'Change password' }));

      expect(await screen.findAllByText('Password must be at least 10 characters long.')).not.toHaveLength(0);
      expect(api.updateOwnProfile).not.toHaveBeenCalled();
    });

    it('changes it and clears the form', async () => {
      renderAccount();
      await screen.findByRole('button', { name: 'Change password' });

      type('Current password', 'old-password-123', 1);
      type('New password', 'new-secure-password');
      type('Confirm new password', 'new-secure-password');
      fireEvent.click(screen.getByRole('button', { name: 'Change password' }));

      await waitFor(() => expect(api.updateOwnProfile).toHaveBeenCalledWith({ current_password: 'old-password-123', new_password: 'new-secure-password' }));
      expect(await screen.findByText('Password changed.')).toBeInTheDocument();
      expect(screen.getByLabelText('New password')).toHaveValue('');
      expect(screen.getByLabelText('Confirm new password')).toHaveValue('');
    });

    it('shows a refusal of the new password (422) on that field', async () => {
      const weak = refusal(422, 'weak_password');
      weak.message = 'HTTP 422: That password is on the list of common passwords.';
      api.updateOwnProfile.mockRejectedValue(weak);
      renderAccount();
      await screen.findByRole('button', { name: 'Change password' });

      type('Current password', 'old-password-123', 1);
      type('New password', 'password1234');
      type('Confirm new password', 'password1234');
      fireEvent.click(screen.getByRole('button', { name: 'Change password' }));

      await waitFor(() => expect(screen.getByLabelText('New password')).toHaveAttribute('aria-invalid', 'true'));
      expect(screen.getByLabelText('New password')).toHaveAccessibleDescription('That password is on the list of common passwords.');
    });
  });

  it('logs out and goes to the sign-in page', async () => {
    const auth = renderAccount();
    fireEvent.click(await screen.findByRole('button', { name: 'Log out' }));

    await waitFor(() => expect(auth.signOut).toHaveBeenCalled());
    expect(await screen.findByRole('heading', { name: 'Sign in screen' })).toBeInTheDocument();
  });

  describe('danger zone', () => {
    async function openDeletion() {
      renderAccount();
      fireEvent.click(await screen.findByRole('button', { name: 'Delete my account' }));
      return screen.findByRole('dialog', { name: 'Confirm deletion' });
    }

    it('asks to type the username and does not delete until it matches exactly', async () => {
      const dialog = within(await openDeletion());
      const submit = dialog.getByRole('button', { name: 'Delete account' });
      expect(submit).toBeDisabled();

      fireEvent.change(dialog.getByLabelText('Type alice to confirm'), { target: { value: 'Alice' } });
      expect(submit).toBeDisabled();
      fireEvent.change(dialog.getByLabelText('Type alice to confirm'), { target: { value: 'alice' } });
      expect(submit).toBeEnabled();
      expect(api.deleteOwnAccount).not.toHaveBeenCalled();
    });

    it('deletes the account, forgets the session and leaves', async () => {
      const dialog = within(await openDeletion());
      fireEvent.change(dialog.getByLabelText('Type alice to confirm'), { target: { value: 'alice' } });
      fireEvent.change(dialog.getByLabelText('Current password (if your account has one)'), { target: { value: 'secret-password' } });
      fireEvent.click(dialog.getByRole('button', { name: 'Delete account' }));

      await waitFor(() => expect(api.deleteOwnAccount).toHaveBeenCalledWith('alice', 'secret-password'));
      await waitFor(() => expect(navigation.leaveTo).toHaveBeenCalledWith('/'));
      expect(api.clearTokens).toHaveBeenCalled();
    });

    it.each([
      ['last_owner', '409 · last_owner'],
      ['organization_owner_required', '409 · organization_owner_required'],
      ['sponsor_transfer_required', '409 · sponsor_transfer_required'],
      ['last_pricing_admin', '409 · last_pricing_admin'],
    ])('explains why a %s refusal (409) stops the deletion', async (code, marker) => {
      api.deleteOwnAccount.mockRejectedValue(refusal(409, code));
      const dialog = within(await openDeletion());
      fireEvent.change(dialog.getByLabelText('Type alice to confirm'), { target: { value: 'alice' } });
      fireEvent.click(dialog.getByRole('button', { name: 'Delete account' }));

      expect(await dialog.findByRole('alert')).toHaveTextContent(marker);
      expect(navigation.leaveTo).not.toHaveBeenCalled();
      expect(screen.getByRole('dialog', { name: 'Confirm deletion' })).toBeInTheDocument();
    });

    it('reports a wrong password (401) on the password field and keeps the dialog open', async () => {
      api.deleteOwnAccount.mockRejectedValue(refusal(401, 'invalid_credentials'));
      const dialog = within(await openDeletion());
      fireEvent.change(dialog.getByLabelText('Type alice to confirm'), { target: { value: 'alice' } });
      fireEvent.click(dialog.getByRole('button', { name: 'Delete account' }));

      await waitFor(() => expect(dialog.getByLabelText('Current password (if your account has one)')).toHaveAttribute('aria-invalid', 'true'));
      expect(navigation.leaveTo).not.toHaveBeenCalled();
    });

    it('cancels without deleting', async () => {
      const dialog = within(await openDeletion());
      fireEvent.click(dialog.getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(api.deleteOwnAccount).not.toHaveBeenCalled();
    });
  });
});
