import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserProfile } from '../api/auth';
import { SESSION_ENDED_EVENT } from '../api/client';
import { clearSessionEnded, hasSessionEnded, markSessionEnded } from '../utils/authFlow';
import { AuthProvider } from './AuthContext';
import { useAuth } from './auth';

const client = vi.hoisted(() => ({
  getAccessToken: vi.fn(),
  getOwnProfile: vi.fn(),
  getPricingToken: vi.fn(),
  clearTokens: vi.fn(),
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

  it('does not claim a session ended for a visitor who never had one', async () => {
    client.getAccessToken.mockReturnValue(null);
    render(<AuthProvider><Who /></AuthProvider>);

    expect(await screen.findByText('signed out')).toBeInTheDocument();
    expect(hasSessionEnded()).toBe(false);
  });
});
