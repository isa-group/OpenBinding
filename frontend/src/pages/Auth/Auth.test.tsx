import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PricingUnavailableError } from '../../api/auth';
import type { UserProfile } from '../../api/auth';
import { HttpError } from '../../api/client';
import { AuthContext } from '../../contexts/auth';
import {
  clearSessionEnded, clearSignInNote, forgetCasFlow, hasRecentSignIn, markSessionEnded, noteSignInStarted, readCasFlow,
} from '../../utils/authFlow';
import { Login } from './Login';
import { Register } from './Register';

const sampleUser: UserProfile = {
  id: 'alice-id',
  username: 'alice',
  email: 'alice@example.test',
  role: 'user',
  plan: 'FREE',
  is_active: true,
  created_at: '2026-01-01T00:00:00Z',
};

function problem(status: number, code?: string, message = 'refused') {
  const error = new HttpError(status, message);
  error.code = code;
  return error;
}

function Where() {
  const location = useLocation();
  return <output data-testid="where">{location.pathname}{location.search}</output>;
}

describe('Auth screens', () => {
  const signInMock = vi.fn();
  const registerMock = vi.fn();
  const signOutMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    clearSessionEnded();
    clearSignInNote();
    forgetCasFlow();
  });

  function renderWithAuth(
    ui: React.ReactElement,
    initialPath: string | { pathname: string; state?: unknown },
    user: UserProfile | null = null,
    loading = false,
  ) {
    const entry = typeof initialPath === 'string' ? { pathname: initialPath } : initialPath;
    return render(
      <MemoryRouter initialEntries={[entry]}>
        <AuthContext.Provider
          value={{
            user,
            loading,
            signIn: signInMock,
            register: registerMock,
            signOut: signOutMock,
            refresh: vi.fn(),
            isAdmin: false,
          }}
        >
          <Routes>
            <Route path="/login" element={ui} />
            <Route path="/register" element={ui} />
            <Route path="/app" element={<h1>Platform Dashboard</h1>} />
            <Route path="/app/org/project" element={<h1>Project Workspace</h1>} />
            <Route path="/invitations/accept" element={<h1>Invitation page</h1>} />
            <Route path="/account" element={<h1>Legacy Account</h1>} />
            <Route path="/app/account" element={<h1>Account Settings</h1>} />
            <Route path="/pricing" element={<h1>Public Pricing</h1>} />
            <Route path="/password-reset" element={<h1>Reset page</h1>} />
          </Routes>
          <Where />
        </AuthContext.Provider>
      </MemoryRouter>,
    );
  }

  const fillLogin = (identifier = 'alice', password = 'password123') => {
    fireEvent.change(screen.getByLabelText('Username or email'), { target: { value: identifier } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: password } });
    fireEvent.click(screen.getByRole('button', { name: 'Log in' }));
  };

  describe('Login', () => {
    it('shows the welcome heading, the CAS action and the form', () => {
      renderWithAuth(<Login />, '/login');

      expect(screen.getByRole('heading', { level: 1, name: 'Welcome back' })).toBeInTheDocument();
      const cas = screen.getByRole('link', { name: 'Continue with Universidad de Sevilla (CAS)' });
      expect(cas).toHaveAttribute('href', expect.stringContaining('/v1/auth/cas/start?mode=login'));
      expect(cas.querySelector('img')).toHaveAttribute('src', '/brands/us-fama.png');
      expect(screen.getByRole('link', { name: 'Forgot password?' })).toHaveAttribute('href', '/password-reset');
      expect(screen.getByRole('link', { name: 'Create one' })).toHaveAttribute('href', '/register');
      expect(screen.getByLabelText('Username or email')).toHaveAttribute('autocomplete', 'username');
      expect(screen.getByLabelText('Password')).toHaveAttribute('autocomplete', 'current-password');
    });

    it('redirects to /app upon sign in by default', async () => {
      signInMock.mockResolvedValue(undefined);
      renderWithAuth(<Login />, '/login');

      fillLogin();

      expect(signInMock).toHaveBeenCalledWith('alice', 'password123');
      expect(await screen.findByRole('heading', { name: 'Platform Dashboard' })).toBeInTheDocument();
      expect(screen.queryByRole('heading', { name: 'Account Settings' })).not.toBeInTheDocument();
    });

    it('redirects to a deep /app route if origin state points to the platform', async () => {
      signInMock.mockResolvedValue(undefined);
      renderWithAuth(<Login />, { pathname: '/login', state: { from: '/app/org/project' } });

      fillLogin();

      expect(await screen.findByRole('heading', { name: 'Project Workspace' })).toBeInTheDocument();
    });

    it('redirects to /app/account if origin state points to /app/account', async () => {
      signInMock.mockResolvedValue(undefined);
      renderWithAuth(<Login />, { pathname: '/login', state: { from: '/app/account' } });

      fillLogin();

      expect(await screen.findByRole('heading', { name: 'Account Settings' })).toBeInTheDocument();
    });

    it('returns to the invitation page, token included', async () => {
      signInMock.mockResolvedValue(undefined);
      renderWithAuth(<Login />, { pathname: '/login', state: { from: '/invitations/accept?token=obi_secret' } });

      fillLogin();

      expect(await screen.findByRole('heading', { name: 'Invitation page' })).toBeInTheDocument();
      expect(screen.getByTestId('where')).toHaveTextContent('/invitations/accept?token=obi_secret');
    });

    it.each(['/pricing', '/account', '//evil.example/app', '/appx'])('ignores %s as an origin and goes to /app', async (from) => {
      signInMock.mockResolvedValue(undefined);
      renderWithAuth(<Login />, { pathname: '/login', state: { from } });

      fillLogin();

      expect(await screen.findByRole('heading', { name: 'Platform Dashboard' })).toBeInTheDocument();
    });

    it('tells a signed-in visitor so, instead of showing the form', () => {
      renderWithAuth(<Login />, '/login', sampleUser);

      expect(screen.getByRole('heading', { name: 'You’re already signed in' })).toBeInTheDocument();
      expect(screen.getByText('Signed in as alice (alice@example.test).')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Continue to your workspace' })).toHaveAttribute('href', '/app');
      expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Log in as someone else' }));
      expect(signOutMock).toHaveBeenCalled();
    });

    it('sends the already signed-in visitor on to the page they asked for', () => {
      renderWithAuth(<Login />, { pathname: '/login', state: { from: '/app/org/project' } }, sampleUser);

      expect(screen.getByRole('link', { name: 'Continue to your workspace' })).toHaveAttribute('href', '/app/org/project');
    });

    it('does not flash the already-signed-in notice while its own sign-in is finishing', async () => {
      let finish: () => void = () => undefined;
      signInMock.mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));
      const view = renderWithAuth(<Login />, '/login');

      fillLogin();
      // The context now has a user, as it does while the profile loads, but the sign-in has not returned.
      view.rerender(
        <MemoryRouter initialEntries={['/login']}>
          <AuthContext.Provider value={{ user: sampleUser, loading: false, signIn: signInMock, register: registerMock, signOut: signOutMock, refresh: vi.fn(), isAdmin: false }}>
            <Routes><Route path="/login" element={<Login />} /><Route path="/app" element={<h1>Platform Dashboard</h1>} /></Routes>
          </AuthContext.Provider>
        </MemoryRouter>,
      );
      expect(screen.queryByRole('heading', { name: 'You’re already signed in' })).not.toBeInTheDocument();
      finish();
      expect(await screen.findByRole('heading', { name: 'Platform Dashboard' })).toBeInTheDocument();
    });

    it('continues to the asked-for page when this screen replaces the one that just signed the person in', async () => {
      // The interface restarts when the account changes: the new instance finds a user it did not see sign in.
      noteSignInStarted();
      renderWithAuth(<Login />, { pathname: '/login', state: { from: '/app/org/project' } }, sampleUser);

      expect(screen.queryByRole('heading', { name: 'You’re already signed in' })).not.toBeInTheDocument();
      expect(await screen.findByRole('heading', { name: 'Project Workspace' })).toBeInTheDocument();
      expect(hasRecentSignIn()).toBe(false);
    });

    it('does not take an old sign-in for a fresh one', () => {
      sessionStorage.setItem('openbinding-sign-in-started', String(Date.now() - 60_000));
      renderWithAuth(<Login />, '/login', sampleUser);

      expect(screen.getByRole('heading', { name: 'You’re already signed in' })).toBeInTheDocument();
    });

    it('forgets the note when the sign-in fails', async () => {
      signInMock.mockRejectedValue(problem(401, 'invalid_credentials'));
      renderWithAuth(<Login />, '/login');

      fillLogin();

      await screen.findByRole('alert');
      expect(hasRecentSignIn()).toBe(false);
    });

    it('asks for both fields before calling the gateway, and says which one is missing', () => {
      renderWithAuth(<Login />, '/login');

      fireEvent.click(screen.getByRole('button', { name: 'Log in' }));

      expect(signInMock).not.toHaveBeenCalled();
      expect(screen.getByText('Enter your username or email.')).toBeInTheDocument();
      expect(screen.getByText('Enter your password.')).toBeInTheDocument();
      const identifier = screen.getByLabelText('Username or email');
      expect(identifier).toHaveAttribute('aria-invalid', 'true');
      expect(identifier).toHaveAccessibleDescription('Enter your username or email.');
      expect(identifier).toHaveFocus();
      expect(screen.getByLabelText('Password')).toHaveAttribute('aria-invalid', 'true');
    });

    it('answers a wrong password and an unknown account in the same words', async () => {
      signInMock.mockRejectedValue(problem(401, 'invalid_credentials'));
      renderWithAuth(<Login />, '/login');

      fillLogin('ghost', 'wrong-password');

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('That username or email and password don’t match an active account.');
      expect(screen.getByLabelText('Username or email')).toHaveAttribute('aria-invalid', 'true');
      expect(screen.getByLabelText('Password')).toHaveAttribute('aria-invalid', 'true');
      expect(screen.queryByRole('heading', { name: 'Platform Dashboard' })).not.toBeInTheDocument();
    });

    it('says when accounts are unavailable and points to the service status', async () => {
      signInMock.mockRejectedValue(problem(503, 'auth_unavailable'));
      renderWithAuth(<Login />, '/login');

      fillLogin();

      expect(await screen.findByRole('alert')).toHaveTextContent('Sign-in is unavailable right now (503)');
      expect(screen.getByRole('link', { name: 'Service status' })).toHaveAttribute('href', '/status');
    });

    it('treats an unreachable pricing service as unavailable, not as a wrong password', async () => {
      signInMock.mockRejectedValue(new PricingUnavailableError('pricing is down'));
      renderWithAuth(<Login />, '/login');

      fillLogin();

      expect(await screen.findByRole('alert')).toHaveTextContent('Sign-in is unavailable right now');
    });

    it('says when OpenBinding cannot be reached at all', async () => {
      signInMock.mockRejectedValue(new TypeError('Failed to fetch'));
      renderWithAuth(<Login />, '/login');

      fillLogin();

      expect(await screen.findByRole('alert')).toHaveTextContent('OpenBinding couldn’t be reached.');
    });

    it('disables the form while the request is in flight', async () => {
      signInMock.mockReturnValue(new Promise(() => undefined));
      renderWithAuth(<Login />, '/login');

      fillLogin();

      await waitFor(() => expect(screen.getByRole('button', { name: 'Signing in…' })).toBeDisabled());
      expect(screen.getByLabelText('Username or email')).toBeDisabled();
    });

    it('explains a session that ended without being asked to', () => {
      markSessionEnded();
      renderWithAuth(<Login />, '/login');

      expect(screen.getByText(/Your session ended and couldn’t be renewed\./)).toBeInTheDocument();
    });

    it('stays quiet about sessions when none ended', () => {
      renderWithAuth(<Login />, '/login');

      expect(screen.queryByText(/Your session ended/)).not.toBeInTheDocument();
    });

    it('shows the notice handed over by another screen', () => {
      renderWithAuth(<Login />, { pathname: '/login', state: { notice: 'Password changed. Log in with the new password.' } });

      expect(screen.getByText('Password changed. Log in with the new password.')).toBeInTheDocument();
    });

    it('remembers that the CAS flow is a login, and where the person was heading', () => {
      renderWithAuth(<Login />, { pathname: '/login', state: { from: '/app/org/project' } });
      const cas = screen.getByRole('link', { name: 'Continue with Universidad de Sevilla (CAS)' });
      cas.addEventListener('click', (event) => event.preventDefault());

      fireEvent.click(cas);

      expect(readCasFlow()).toEqual({ mode: 'login', returnTo: '/app/org/project' });
    });

    it('waits for the stored session before offering anything', () => {
      renderWithAuth(<Login />, '/login', null, true);

      expect(screen.getByText('Checking your session…')).toBeInTheDocument();
      expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
    });
  });

  describe('Register', () => {
    const fillRegister = (password = 'password123') => {
      fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'alice' } });
      fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'alice@example.test' } });
      fireEvent.change(screen.getByLabelText('Password'), { target: { value: password } });
      fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    };

    it('redirects to /app upon registration by default', async () => {
      registerMock.mockResolvedValue(undefined);
      renderWithAuth(<Register />, '/register');

      fillRegister();

      expect(registerMock).toHaveBeenCalledWith({
        username: 'alice',
        email: 'alice@example.test',
        password: 'password123',
      });
      expect(await screen.findByRole('heading', { name: 'Platform Dashboard' })).toBeInTheDocument();
      expect(screen.queryByRole('heading', { name: 'Account Settings' })).not.toBeInTheDocument();
    });

    it('redirects to a deep /app route if origin state points to the platform', async () => {
      registerMock.mockResolvedValue(undefined);
      renderWithAuth(<Register />, { pathname: '/register', state: { from: '/app/org/project' } });

      fillRegister();

      expect(await screen.findByRole('heading', { name: 'Project Workspace' })).toBeInTheDocument();
    });

    it('redirects to /app/account if origin state points to /app/account', async () => {
      registerMock.mockResolvedValue(undefined);
      renderWithAuth(<Register />, { pathname: '/register', state: { from: '/app/account' } });

      fillRegister();

      expect(await screen.findByRole('heading', { name: 'Account Settings' })).toBeInTheDocument();
    });

    it('redirects to /app and ignores public or /account origin routes', async () => {
      registerMock.mockResolvedValue(undefined);
      renderWithAuth(<Register />, { pathname: '/register', state: { from: '/account' } });

      fillRegister();

      expect(await screen.findByRole('heading', { name: 'Platform Dashboard' })).toBeInTheDocument();
      expect(screen.queryByRole('heading', { name: 'Account Settings' })).not.toBeInTheDocument();
    });

    it('continues to the asked-for page when this screen replaces the one that just created the account', async () => {
      noteSignInStarted();
      renderWithAuth(<Register />, { pathname: '/register', state: { from: '/app/account' } }, sampleUser);

      expect(screen.queryByRole('heading', { name: 'You already have an account' })).not.toBeInTheDocument();
      expect(await screen.findByRole('heading', { name: 'Account Settings' })).toBeInTheDocument();
    });

    it('tells a signed-in visitor they already have an account', () => {
      renderWithAuth(<Register />, '/register', sampleUser);

      expect(screen.getByRole('heading', { name: 'You already have an account' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Create account' })).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Log out' }));
      expect(signOutMock).toHaveBeenCalled();
    });

    it('checks the three fields locally and focuses the first one that is wrong', () => {
      renderWithAuth(<Register />, '/register');

      fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'a!' } });
      fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'not-an-email' } });
      fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'short' } });
      fireEvent.click(screen.getByRole('button', { name: 'Create account' }));

      expect(registerMock).not.toHaveBeenCalled();
      expect(screen.getByLabelText('Username')).toHaveAttribute('aria-invalid', 'true');
      expect(screen.getByLabelText('Username')).toHaveFocus();
      expect(screen.getByText('Enter a valid email address.')).toBeInTheDocument();
      expect(screen.getByText('Password must be at least 10 characters long.')).toBeInTheDocument();
    });

    it('counts the characters still needed as the password grows', () => {
      renderWithAuth(<Register />, '/register');
      const password = screen.getByLabelText('Password');

      expect(password).toHaveAccessibleDescription('At least 10 characters. Length is the only rule.');
      fireEvent.change(password, { target: { value: 'abcd' } });
      expect(password).toHaveAccessibleDescription('6 more characters needed');
      fireEvent.change(password, { target: { value: 'abcdefghij' } });
      expect(password).toHaveAccessibleDescription('✓ At least 10 characters');
    });

    it('says the name or email is taken and offers to log in or reset', async () => {
      registerMock.mockRejectedValue(problem(409, 'already_registered'));
      renderWithAuth(<Register />, '/register');

      fillRegister();

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('That username or email is already registered (409).');
      expect(within(alert).getByRole('link', { name: 'Log in' })).toHaveAttribute('href', '/login');
      expect(within(alert).getByRole('link', { name: 'reset your password' })).toHaveAttribute('href', '/password-reset');
    });

    it('puts the gateway’s weak-password complaint on the password field', async () => {
      registerMock.mockRejectedValue(problem(422, 'weak_password', 'Password is on the common-passwords list.'));
      renderWithAuth(<Register />, '/register');

      fillRegister();

      expect(await screen.findByText('Password is on the common-passwords list.')).toBeInTheDocument();
      expect(screen.getByLabelText('Password')).toHaveAttribute('aria-invalid', 'true');
    });

    it('maps field-level validation answers to their fields', async () => {
      const refused = problem(422);
      refused.problem = {
        code: 'validation_error',
        detail: 'Request validation failed: /email: value is not a valid email address',
        diagnostics: [{ code: 'value_error', message: 'value is not a valid email address', in: 'body', pointer: '/email', loc: ['body', 'email'] }],
      };
      registerMock.mockRejectedValue(refused);
      renderWithAuth(<Register />, '/register');

      fillRegister();

      expect(await screen.findByText('value is not a valid email address')).toBeInTheDocument();
      expect(screen.getByLabelText('Email')).toHaveAttribute('aria-invalid', 'true');
    });

    it('reports an unavailable gateway without claiming anything was saved', async () => {
      registerMock.mockRejectedValue(problem(503, 'auth_unavailable'));
      renderWithAuth(<Register />, '/register');

      fillRegister();

      expect(await screen.findByRole('alert')).toHaveTextContent('Accounts can’t be created right now (503). Nothing was saved');
    });

    it('offers the way back to log in and the plans', () => {
      renderWithAuth(<Register />, '/register');

      expect(screen.getByRole('link', { name: 'Log in' })).toHaveAttribute('href', '/login');
      expect(screen.getByRole('link', { name: 'Compare plans' })).toHaveAttribute('href', '/pricing');
    });
  });
});
