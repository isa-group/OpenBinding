import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QuotaError } from '../../api/auth';
import type { UserProfile } from '../../api/auth';
import { HttpError } from '../../api/client';
import type { Organization, OrganizationMember } from '../../api/platform';
import { AuthContext } from '../../contexts/auth';
import { AcceptInvitation } from './AcceptInvitation';

const api = vi.hoisted(() => ({ organizations: vi.fn(), acceptInvitation: vi.fn() }));

vi.mock('../../api/platform', async () => ({
  ...await vi.importActual<typeof import('../../api/platform')>('../../api/platform'),
  platformApi: api,
}));

const TOKEN = `obi_${'a1b2c3d4'.repeat(2)}_${'e5f6a7b8'.repeat(3)}`;

const user: UserProfile = {
  id: 'u1', username: 'sofia', email: 'sofia@example.org', role: 'user', plan: 'FREE', is_active: true, created_at: '2026-01-01T00:00:00Z',
};

const isaDemo: Organization = {
  id: 'org-1', slug: 'isa-demo', name: 'ISA Demo Group', parent_id: null, billing_sponsor_user_id: 'sponsor', effective_role: 'MEMBER',
  created_at: '2026-01-01T00:00:00Z',
};

const membership: OrganizationMember = {
  id: 'm1', organization_id: 'org-1', user_id: 'u1', username: 'sofia', email: 'sofia@example.org', role: 'MEMBER', created_at: '2026-10-09T10:00:00Z',
};

function problem(status: number, code?: string) {
  const error = new HttpError(status, 'refused');
  error.code = code;
  return error;
}

function Probe() {
  const location = useLocation();
  return <output data-testid="probe">{JSON.stringify({ path: location.pathname, search: location.search, state: location.state })}</output>;
}

function renderPage(entry: string | { pathname: string; search?: string; state?: unknown }, account: UserProfile | null = user, loading = false) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <AuthContext.Provider
        value={{ user: account, loading, signIn: vi.fn(), register: vi.fn(), signOut: vi.fn(), refresh: vi.fn(), isAdmin: false }}
      >
        <Routes>
          <Route path="/invitations/accept" element={<AcceptInvitation />} />
          <Route path="/login" element={<h1>Log in page</h1>} />
          <Route path="/register" element={<h1>Register page</h1>} />
          <Route path="/app/*" element={<h1>Workspace</h1>} />
        </Routes>
        <Probe />
      </AuthContext.Provider>
    </MemoryRouter>,
  );
}

const probe = () => JSON.parse(screen.getByTestId('probe').textContent ?? '{}') as { path: string; search: string; state: { token?: string; from?: string } | null };

describe('AcceptInvitation', () => {
  beforeEach(() => {
    api.organizations.mockReset().mockResolvedValue([]);
    api.acceptInvitation.mockReset();
  });

  it('asks a visitor to log in and carries the invitation through the sign-in', () => {
    renderPage(`/invitations/accept?token=${TOKEN}`, null);

    expect(screen.getByRole('heading', { level: 1, name: 'Log in to accept' })).toBeInTheDocument();
    expect(screen.getByText(/Your invitation link is kept/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Invitation token')).not.toBeInTheDocument();
    expect(api.acceptInvitation).not.toHaveBeenCalled();
  });

  it('hands the token to the log in and register screens as a return address', () => {
    renderPage(`/invitations/accept?token=${TOKEN}`, null);

    fireEvent.click(screen.getByRole('link', { name: 'Log in' }));

    expect(screen.getByRole('heading', { name: 'Log in page' })).toBeInTheDocument();
    expect(probe().path).toBe('/login');
    expect(probe().state?.from).toBe(`/invitations/accept?token=${encodeURIComponent(TOKEN)}`);
  });

  it('offers the address-less return when there is no token yet', () => {
    renderPage('/invitations/accept', null);

    fireEvent.click(screen.getByRole('link', { name: 'Create an account' }));

    expect(probe().path).toBe('/register');
    expect(probe().state?.from).toBe('/invitations/accept');
  });

  it('moves the token out of the address bar into the entry’s own state', async () => {
    renderPage(`/invitations/accept?token=${TOKEN}`);

    await waitFor(() => expect(probe().search).toBe(''));
    expect(probe().state).toEqual({ token: TOKEN });
    expect(screen.getByLabelText('Invitation token')).toHaveValue(TOKEN);
  });

  it('reads a token kept in state, as after a reload', () => {
    renderPage({ pathname: '/invitations/accept', state: { token: TOKEN } });

    expect(screen.getByRole('heading', { name: 'Join with this invitation' })).toBeInTheDocument();
    expect(screen.getByLabelText('Invitation token')).toHaveValue(TOKEN);
  });

  it('invites a signed-in visitor without a link to paste the token, and says what is not known yet', () => {
    renderPage('/invitations/accept');

    expect(screen.getByRole('heading', { level: 1, name: 'Paste your invitation' })).toBeInTheDocument();
    expect(screen.getByLabelText('Invitation token')).toHaveValue('');
    expect(screen.getByLabelText('Invitation token')).toHaveAccessibleDescription('Tokens are valid for 7 days and work once.');
    expect(screen.getByText(/the API has no endpoint to preview an invitation/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Not now' })).toHaveAttribute('href', '/app');
  });

  it('will not call the gateway with an empty or too short token', () => {
    renderPage('/invitations/accept');

    fireEvent.click(screen.getByRole('button', { name: 'Accept invitation' }));
    expect(screen.getByLabelText('Invitation token')).toHaveAccessibleDescription(expect.stringContaining('Paste the invitation token.'));
    expect(screen.getByLabelText('Invitation token')).toHaveFocus();

    fireEvent.change(screen.getByLabelText('Invitation token'), { target: { value: 'obi_short' } });
    expect(screen.getByLabelText('Invitation token')).toHaveAccessibleDescription(expect.stringContaining('at least 32 characters'));
    expect(api.acceptInvitation).not.toHaveBeenCalled();
  });

  it('joins the organization and shows its name, handle and the role it was accepted with', async () => {
    api.organizations.mockResolvedValueOnce([]).mockResolvedValueOnce([isaDemo]);
    api.acceptInvitation.mockResolvedValue(membership);
    renderPage('/invitations/accept');

    fireEvent.change(screen.getByLabelText('Invitation token'), { target: { value: `  ${TOKEN}  ` } });
    fireEvent.click(screen.getByRole('button', { name: 'Accept invitation' }));

    expect(await screen.findByRole('heading', { level: 1, name: 'You joined ISA Demo Group' })).toBeInTheDocument();
    expect(api.acceptInvitation).toHaveBeenCalledWith(TOKEN);
    expect(screen.getByText('@isa-demo')).toBeInTheDocument();
    expect(screen.getByText('MEMBER')).toBeInTheDocument();
    expect(screen.getByText(/As a member you can create projects and cases/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open the organization' })).toHaveAttribute('href', '/app/isa-demo');
    expect(screen.queryByLabelText('Invitation token')).not.toBeInTheDocument();
  });

  it('says so when the account already belonged to the organization', async () => {
    api.organizations.mockResolvedValue([isaDemo]);
    api.acceptInvitation.mockResolvedValue({ ...membership, role: 'ADMIN' });
    renderPage({ pathname: '/invitations/accept', state: { token: TOKEN } });

    fireEvent.click(screen.getByRole('button', { name: 'Accept invitation' }));

    expect(await screen.findByRole('heading', { level: 1, name: 'You’re already a member of ISA Demo Group' })).toBeInTheDocument();
    expect(screen.getByText('Nothing changed: your current role stays as it is.')).toBeInTheDocument();
    expect(screen.getByText('ADMIN')).toBeInTheDocument();
  });

  it('still reports the join when the organization list cannot be read afterwards', async () => {
    api.organizations.mockResolvedValueOnce([]).mockRejectedValueOnce(problem(503));
    api.acceptInvitation.mockResolvedValue(membership);
    renderPage({ pathname: '/invitations/accept', state: { token: TOKEN } });

    fireEvent.click(screen.getByRole('button', { name: 'Accept invitation' }));

    expect(await screen.findByRole('heading', { level: 1, name: 'You joined the organization' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open the organization' })).toHaveAttribute('href', '/app');
  });

  it('reports invalid, expired, used and wrong-email tokens together, because the gateway does', async () => {
    api.acceptInvitation.mockRejectedValue(problem(404, 'not_found'));
    renderPage({ pathname: '/invitations/accept', state: { token: TOKEN } });

    fireEvent.click(screen.getByRole('button', { name: 'Accept invitation' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('This invitation can’t be used.');
    expect(alert).toHaveTextContent('different email address than sofia@example.org');
    expect(screen.getByLabelText('Invitation token')).toHaveValue(TOKEN);
    expect(screen.getByRole('button', { name: 'Accept invitation' })).toBeEnabled();
  });

  it('names the sponsor limit on a 402 and keeps the invitation valid', async () => {
    api.acceptInvitation.mockRejectedValue(new QuotaError('sponsor_quota_exceeded', 'full', { limit_id: 'members', limit: 15, used: 16 }));
    renderPage({ pathname: '/invitations/accept', state: { token: TOKEN } });

    fireEvent.click(screen.getByRole('button', { name: 'Accept invitation' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('402 · sponsor_quota_exceeded');
    expect(alert).toHaveTextContent('unique-member limit of their plan (15)');
    expect(alert).toHaveTextContent('your invitation stays valid until it expires');
  });

  it('puts a 422 on the token field', async () => {
    api.acceptInvitation.mockRejectedValue(problem(422));
    renderPage({ pathname: '/invitations/accept', state: { token: TOKEN } });

    fireEvent.click(screen.getByRole('button', { name: 'Accept invitation' }));

    await waitFor(() => expect(screen.getByLabelText('Invitation token')).toHaveAttribute('aria-invalid', 'true'));
  });

  it('reports an outage as such, and a network failure as another thing', async () => {
    api.acceptInvitation.mockRejectedValueOnce(problem(503)).mockRejectedValueOnce(new TypeError('Failed to fetch'));
    renderPage({ pathname: '/invitations/accept', state: { token: TOKEN } });

    fireEvent.click(screen.getByRole('button', { name: 'Accept invitation' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Invitations are unavailable right now (503).');

    fireEvent.click(screen.getByRole('button', { name: 'Accept invitation' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('OpenBinding couldn’t be reached.'));
  });

  it('disables the form while the invitation is being accepted', async () => {
    api.acceptInvitation.mockReturnValue(new Promise(() => undefined));
    renderPage({ pathname: '/invitations/accept', state: { token: TOKEN } });

    fireEvent.click(screen.getByRole('button', { name: 'Accept invitation' }));

    expect(await screen.findByRole('button', { name: 'Accepting…' })).toBeDisabled();
    expect(screen.getByLabelText('Invitation token')).toBeDisabled();
  });

  it('waits for the stored session instead of sending a signed-in person to log in', () => {
    renderPage(`/invitations/accept?token=${TOKEN}`, null, true);

    expect(screen.queryByRole('heading', { name: 'Log in to accept' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Invitation token')).not.toBeInTheDocument();
  });
});
