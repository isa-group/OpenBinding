import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserProfile } from '../../core/api/account';
import { HttpError, SESSION_ENDED_EVENT } from '../../core/api/http';
import { clearSessionEnded, hasSessionEnded, markSessionEnded } from '../utils/authFlow';
import { loadDraft, saveDraft } from '../../core/editor/drafts';
import { AuthProvider } from './authProvider';
import { useAuth } from '../hooks/useAuth';

const client = vi.hoisted(() => ({
  getAccessToken: vi.fn(),
  getOwnProfile: vi.fn(),
  getPricingToken: vi.fn(),
  clearTokens: vi.fn(),
  logout: vi.fn(),
  login: vi.fn(),
  register: vi.fn(),
  renewSession: vi.fn(),
  tokenDueForRenewal: vi.fn(),
}));

/** A BroadcastChannel stand-in: every instance of one name hears what another posts (as tabs would). */
class FakeChannel {
  static open: FakeChannel[] = [];
  static posted: unknown[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  readonly name: string;
  constructor(name: string) {
    this.name = name;
    FakeChannel.open.push(this);
  }
  postMessage(data: unknown) {
    FakeChannel.posted.push(data);
  }
  close() {
    FakeChannel.open = FakeChannel.open.filter(channel => channel !== this);
  }
  /** Another tab says something on the channel. */
  static fromAnotherTab(data: unknown) {
    for (const channel of FakeChannel.open)
      channel.onmessage?.(new MessageEvent('message', { data }));
  }
}

/** A gateway token (a JWT whose payload names `sub`); the signature is never read here. */
const tokenFor = (sub: string) => `h.${btoa(JSON.stringify({ sub, exp: 4_000_000_000 }))}.s`;

vi.mock('../../core/api/http', async () => ({
  ...(await vi.importActual<typeof import('../../core/api/http')>('../../core/api/http')),
  apiClient: client,
}));
vi.mock('../api/accountClient', async () => ({
  ...(await vi.importActual<typeof import('../api/accountClient')>('../api/accountClient')),
  accountClient: client,
}));
vi.mock('../../settings/api/planClient', async () => ({
  ...(await vi.importActual<typeof import('../../settings/api/planClient')>(
    '../../settings/api/planClient'
  )),
  planClient: client,
}));

const account: UserProfile = {
  id: 'u1',
  username: 'lucia',
  email: 'lucia@example.org',
  role: 'user',
  plan: 'FREE',
  is_active: true,
  created_at: '2026-01-01T00:00:00Z',
  cas_verified: false,
  email_verified: false,
  institutional_email: false,
};

function Who() {
  const { user, loading } = useAuth();
  return (
    <output>{loading ? 'loading' : user ? `signed in as ${user.username}` : 'signed out'}</output>
  );
}

describe('AuthProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearSessionEnded();
    FakeChannel.open = [];
    FakeChannel.posted = [];
    vi.stubGlobal('BroadcastChannel', FakeChannel);
    client.getAccessToken.mockReturnValue(tokenFor('u1'));
    client.renewSession.mockResolvedValue({ access_token: tokenFor('u1'), expires_in: 300 });
    client.tokenDueForRenewal.mockReturnValue(false);
    client.getOwnProfile.mockResolvedValue(account);
    client.getPricingToken.mockResolvedValue('pricing');
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('resumes the session from the cookie and forgets any earlier ended session', async () => {
    markSessionEnded();
    render(
      <AuthProvider>
        <Who />
      </AuthProvider>
    );

    expect(await screen.findByText('signed in as lucia')).toBeInTheDocument();
    expect(client.renewSession).toHaveBeenCalledTimes(1);
    expect(hasSessionEnded()).toBe(false);
  });

  it('keeps no token in Web Storage', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    render(
      <AuthProvider>
        <Who />
      </AuthProvider>
    );
    await screen.findByText('signed in as lucia');
    const written = setItem.mock.calls.map(([key, value]) => `${key}=${value}`);
    expect(
      written.some(entry => entry.includes(tokenFor('u1')) || /access|refresh/i.test(entry))
    ).toBe(false);
    setItem.mockRestore();
  });

  it('signs out and remembers why when the client reports a session that ended', async () => {
    render(
      <AuthProvider>
        <Who />
      </AuthProvider>
    );
    await screen.findByText('signed in as lucia');

    act(() => {
      window.dispatchEvent(new CustomEvent(SESSION_ENDED_EVENT));
    });

    await waitFor(() => expect(screen.getByText('signed out')).toBeInTheDocument());
    expect(hasSessionEnded()).toBe(true);
  });

  it('keeps the session and offers a retry when Identity cannot renew it (503)', async () => {
    client.renewSession.mockRejectedValueOnce(
      Object.assign(new HttpError(503, 'unavailable'), { code: 'identity_unavailable' })
    );
    client.getAccessToken.mockReturnValueOnce(null);
    render(
      <AuthProvider>
        <Who />
      </AuthProvider>
    );

    expect(
      await screen.findByRole('heading', { name: 'We couldn’t check your session' })
    ).toBeInTheDocument();
    expect(client.clearTokens).not.toHaveBeenCalled();
    expect(hasSessionEnded()).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('signed in as lucia')).toBeInTheDocument();
  });

  it('keeps the session and offers a retry when the profile cannot be read (503)', async () => {
    client.getOwnProfile.mockRejectedValueOnce(new HttpError(503, 'unavailable'));
    render(
      <AuthProvider>
        <Who />
      </AuthProvider>
    );

    expect(await screen.findByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(client.clearTokens).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('signed in as lucia')).toBeInTheDocument();
  });

  it.each([
    ['no session (401)', new HttpError(401, 'no_session')],
    ['no gateway at all', new TypeError('Failed to fetch')],
  ])('lets a visitor browse signed out when there is %s', async (_name, error) => {
    client.renewSession.mockRejectedValueOnce(error);
    render(
      <AuthProvider>
        <Who />
      </AuthProvider>
    );

    expect(await screen.findByText('signed out')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    expect(hasSessionEnded()).toBe(false);
    expect(client.getOwnProfile).not.toHaveBeenCalled();
  });

  it.each([401, 403])('ends the session when the profile is refused with %s', async status => {
    client.getOwnProfile.mockRejectedValue(new HttpError(status, 'refused'));
    render(
      <AuthProvider>
        <Who />
      </AuthProvider>
    );

    expect(await screen.findByText('signed out')).toBeInTheDocument();
    expect(client.clearTokens).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });

  it('keeps the person signed in when a later profile refresh fails for a reason that is not the credentials', async () => {
    function Refresher() {
      const { refresh } = useAuth();
      return (
        <button type="button" onClick={() => void refresh()}>
          Refresh
        </button>
      );
    }
    render(
      <AuthProvider>
        <Who />
        <Refresher />
      </AuthProvider>
    );
    await screen.findByText('signed in as lucia');

    client.getOwnProfile.mockRejectedValueOnce(new HttpError(503, 'unavailable'));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(client.getOwnProfile).toHaveBeenCalledTimes(2));

    expect(screen.getByText('signed in as lucia')).toBeInTheDocument();
    expect(client.clearTokens).not.toHaveBeenCalled();
  });

  it('follows another tab: signed out when it signs out, signed in when it signs in', async () => {
    render(
      <AuthProvider>
        <Who />
      </AuthProvider>
    );
    await screen.findByText('signed in as lucia');

    act(() => FakeChannel.fromAnotherTab({ type: 'signed-out' }));
    await waitFor(() => expect(screen.getByText('signed out')).toBeInTheDocument());
    expect(client.clearTokens).toHaveBeenCalled();

    act(() => FakeChannel.fromAnotherTab({ type: 'signed-in', userId: 'u1' }));
    expect(await screen.findByText('signed in as lucia')).toBeInTheDocument();
    expect(client.renewSession).toHaveBeenCalledTimes(2);
  });

  it('tells the other tabs when this one signs in and out', async () => {
    client.renewSession.mockRejectedValueOnce(new HttpError(401, 'no_session'));
    function Door() {
      const { signIn, signOut } = useAuth();
      return (
        <>
          <button type="button" onClick={() => void signIn('lucia', 'pw')}>
            In
          </button>
          <button type="button" onClick={() => void signOut('all')}>
            Out
          </button>
        </>
      );
    }
    render(
      <AuthProvider>
        <Who />
        <Door />
      </AuthProvider>
    );
    await screen.findByText('signed out');
    fireEvent.click(screen.getByRole('button', { name: 'In' }));
    await screen.findByText('signed in as lucia');
    expect(FakeChannel.posted).toContainEqual({ type: 'signed-in', userId: 'u1' });

    fireEvent.click(screen.getByRole('button', { name: 'Out' }));
    await waitFor(() => expect(screen.getByText('signed out')).toBeInTheDocument());
    expect(client.logout).toHaveBeenCalledWith('all');
    expect(FakeChannel.posted).toContainEqual({ type: 'signed-out' });
  });

  it('renews the token under a minute before it runs out, on focus, on visibility and every 30 s', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(
      <AuthProvider>
        <Who />
      </AuthProvider>
    );
    await screen.findByText('signed in as lucia');
    expect(client.renewSession).toHaveBeenCalledTimes(1);

    // More than a minute left: nothing happens.
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    expect(client.renewSession).toHaveBeenCalledTimes(1);

    client.tokenDueForRenewal.mockReturnValue(true);
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    await waitFor(() => expect(client.renewSession).toHaveBeenCalledTimes(2));

    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect(client.renewSession).toHaveBeenCalledTimes(3));

    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(() => expect(client.renewSession).toHaveBeenCalledTimes(4));
  });

  it('ends the session when a renewal is refused', async () => {
    render(
      <AuthProvider>
        <Who />
      </AuthProvider>
    );
    await screen.findByText('signed in as lucia');
    client.tokenDueForRenewal.mockReturnValue(true);
    client.renewSession.mockRejectedValueOnce(new HttpError(401, 'session_ended'));

    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });

    await waitFor(() => expect(screen.getByText('signed out')).toBeInTheDocument());
    expect(hasSessionEnded()).toBe(true);
  });

  it('follows the cookie to another account when a renewal names somebody else', async () => {
    render(
      <AuthProvider>
        <Who />
      </AuthProvider>
    );
    await screen.findByText('signed in as lucia');
    client.tokenDueForRenewal.mockReturnValue(true);
    client.renewSession.mockResolvedValueOnce({ access_token: tokenFor('u2'), expires_in: 300 });
    client.getOwnProfile.mockResolvedValueOnce({ ...account, id: 'u2', username: 'mateo' });

    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });

    expect(await screen.findByText('signed in as mateo')).toBeInTheDocument();
  });

  it('forgets the drafts of the person when they sign out, even if the server cannot be told, and leaves the others alone', async () => {
    await saveDraft('u1:problem:isa:qos:none', { 'instance.json': '{}' });
    await saveDraft('u1:composition:isa:checkout:new', { 'composition.yaml': 'name: checkout' });
    await saveDraft('u2:problem:isa:qos:none', { 'instance.json': '{}' });
    function Leave() {
      const { signOut } = useAuth();
      return (
        <button type="button" onClick={() => void signOut().catch(() => undefined)}>
          Leave
        </button>
      );
    }
    client.logout.mockRejectedValueOnce(new Error('offline'));
    render(
      <AuthProvider>
        <Who />
        <Leave />
      </AuthProvider>
    );
    await screen.findByText('signed in as lucia');

    fireEvent.click(screen.getByRole('button', { name: 'Leave' }));

    await waitFor(async () => expect(await loadDraft('u1:problem:isa:qos:none')).toBeNull());
    expect(await loadDraft('u1:composition:isa:checkout:new')).toBeNull();
    expect(await loadDraft('u2:problem:isa:qos:none')).toEqual({ 'instance.json': '{}' });
  });
});
