import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserProfile } from '../api/auth';
import { HttpError, SESSION_ENDED_EVENT } from '../api/client';
import { clearSessionEnded, hasSessionEnded, markSessionEnded } from '../utils/authFlow';
import { loadDraft, saveDraft } from '../utils/workspaceDraft';
import { AuthProvider } from './AuthContext';
import { useAuth } from './auth';

const client = vi.hoisted(() => ({
  getAccessToken: vi.fn(),
  getOwnProfile: vi.fn(),
  getPricingToken: vi.fn(),
  clearTokens: vi.fn(),
  logout: vi.fn(),
}));

vi.mock('../api/client', async () => ({
  ...await vi.importActual<typeof import('../api/client')>('../api/client'),
  apiClient: client,
}));

const account: UserProfile = {
  id: 'u1', username: 'lucia', email: 'lucia@example.org', role: 'user', plan: 'FREE', is_active: true, created_at: '2026-01-01T00:00:00Z',
};

function Who() {
  const { user, loading } = useAuth();
  return <output>{loading ? 'loading' : user ? `signed in as ${user.username}` : 'signed out'}</output>;
}

describe('AuthProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearSessionEnded();
    client.getAccessToken.mockReturnValue('token');
    client.getOwnProfile.mockResolvedValue(account);
    client.getPricingToken.mockResolvedValue('pricing');
  });

  it('signs the stored session in and forgets any earlier ended session', async () => {
    markSessionEnded();
    render(<AuthProvider><Who /></AuthProvider>);

    expect(await screen.findByText('signed in as lucia')).toBeInTheDocument();
    expect(hasSessionEnded()).toBe(false);
  });

  it('signs out and remembers why when the client reports a session that ended', async () => {
    render(<AuthProvider><Who /></AuthProvider>);
    await screen.findByText('signed in as lucia');

    act(() => { window.dispatchEvent(new CustomEvent(SESSION_ENDED_EVENT)); });

    await waitFor(() => expect(screen.getByText('signed out')).toBeInTheDocument());
    expect(hasSessionEnded()).toBe(true);
  });

  it('keeps the tokens and offers a retry when the gateway answers 503', async () => {
    client.getOwnProfile.mockRejectedValueOnce(new HttpError(503, 'unavailable'));
    render(<AuthProvider><Who /></AuthProvider>);

    expect(await screen.findByRole('heading', { name: 'We couldn’t check your session' })).toBeInTheDocument();
    expect(client.clearTokens).not.toHaveBeenCalled();
    expect(hasSessionEnded()).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('signed in as lucia')).toBeInTheDocument();
    expect(client.clearTokens).not.toHaveBeenCalled();
  });

  it('keeps the tokens when there is no network at all', async () => {
    client.getOwnProfile.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    render(<AuthProvider><Who /></AuthProvider>);

    expect(await screen.findByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(client.clearTokens).not.toHaveBeenCalled();
  });

  it.each([401, 403])('ends the session when the profile is refused with %s', async (status) => {
    client.getOwnProfile.mockRejectedValue(new HttpError(status, 'refused'));
    render(<AuthProvider><Who /></AuthProvider>);

    expect(await screen.findByText('signed out')).toBeInTheDocument();
    expect(client.clearTokens).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });

  it('keeps the person signed in when a later profile refresh fails for a reason that is not the credentials', async () => {
    function Refresher() {
      const { refresh } = useAuth();
      return <button type="button" onClick={() => void refresh()}>Refresh</button>;
    }
    render(<AuthProvider><Who /><Refresher /></AuthProvider>);
    await screen.findByText('signed in as lucia');

    client.getOwnProfile.mockRejectedValueOnce(new HttpError(503, 'unavailable'));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(client.getOwnProfile).toHaveBeenCalledTimes(2));

    expect(screen.getByText('signed in as lucia')).toBeInTheDocument();
    expect(client.clearTokens).not.toHaveBeenCalled();
  });

  it('signs this tab out when another tab removes the session, and in when another tab signs in', async () => {
    render(<AuthProvider><Who /></AuthProvider>);
    await screen.findByText('signed in as lucia');

    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'openbinding-access-token', newValue: null, storageArea: window.localStorage }));
    });
    await waitFor(() => expect(screen.getByText('signed out')).toBeInTheDocument());

    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'openbinding-access-token', newValue: 'token', storageArea: window.localStorage }));
    });
    expect(await screen.findByText('signed in as lucia')).toBeInTheDocument();
  });

  it('forgets the workbench drafts of the person when they sign out, even if the server cannot be told', async () => {
    await saveDraft({ 'instance.json': '{}' }, 'u1:/app/isa/qos/workbench::');
    function Leave() {
      const { signOut } = useAuth();
      return <button type="button" onClick={() => void signOut().catch(() => undefined)}>Leave</button>;
    }
    client.logout.mockRejectedValueOnce(new Error('offline'));
    render(<AuthProvider><Who /><Leave /></AuthProvider>);
    await screen.findByText('signed in as lucia');

    fireEvent.click(screen.getByRole('button', { name: 'Leave' }));

    await waitFor(async () => expect(await loadDraft('u1:/app/isa/qos/workbench::')).toBeNull());
  });

  it('does not claim a session ended for a visitor who never had one', async () => {
    client.getAccessToken.mockReturnValue(null);
    render(<AuthProvider><Who /></AuthProvider>);

    expect(await screen.findByText('signed out')).toBeInTheDocument();
    expect(hasSessionEnded()).toBe(false);
  });
});
