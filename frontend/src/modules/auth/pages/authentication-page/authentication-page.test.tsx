import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { HelmetProvider } from 'react-helmet-async';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PricingUnavailableError } from '../../../core/api/account';
import type { UserProfile } from '../../../core/api/account';
import { HttpError } from '../../../core/api/http';
import { AuthContext } from '../../hooks/useAuth';
import {
  clearSessionEnded,
  clearSignInNote,
  hasRecentSignIn,
  markSessionEnded,
  noteSignInStarted,
} from '../../utils/authFlow';
import { StaticAuthConfig } from '../../contexts/authConfig';
import type { AuthConfig } from '../../contexts/authConfigContext';
import AuthenticationPage from '.';

const sampleUser: UserProfile = {
  id: 'alice-id',
  username: 'alice',
  email: 'alice@example.test',
  role: 'user',
  plan: 'FREE',
  is_active: true,
  created_at: '2026-01-01T00:00:00Z',
  email_verified: false,
  institutional_email: false,
};

function problem(status: number, code?: string, message = 'refused') {
  const error = new HttpError(status, message);
  error.code = code;
  return error;
}

function Where() {
  const location = useLocation();
  return (
    <output data-testid="where">
      {location.pathname}
      {location.search}
    </output>
  );
}

describe('AuthenticationPage', () => {
  const signInMock = vi.fn();
  const registerMock = vi.fn();
  const signOutMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    clearSessionEnded();
    clearSignInNote();
  });

  function renderWithAuth(
    ui: React.ReactElement,
    initialPath: string | { pathname: string; search?: string; state?: unknown },
    user: UserProfile | null = null,
    loading = false,
    config: AuthConfig = { provider: 'local' }
  ) {
    return render(
      <HelmetProvider>
        <StaticAuthConfig value={config}>
          <MemoryRouter initialEntries={[initialPath]}>
            <AuthContext.Provider
              value={{
                user,
                loading,
                signIn: signInMock,
                register: registerMock,
                signOut: signOutMock,
                refresh: vi.fn(),
                resume: vi.fn(),
                isAdmin: false,
                fetchWithInterceptor: vi.fn(),
              }}
            >
              <Routes>
                <Route path="/authentication" element={ui} />
                <Route path="/" element={<h1>Platform Dashboard</h1>} />
                <Route path="/problems/org/project" element={<h1>Project Workspace</h1>} />
                <Route path="/orgs/join/:code" element={<h1>Invitation page</h1>} />
                <Route
                  path="/compositions/:org/:composition"
                  element={<h1>Public composition</h1>}
                />
                <Route path="/account" element={<h1>Legacy Account</h1>} />
                <Route path="/me/settings" element={<h1>Account Settings</h1>} />
                <Route path="/pricing" element={<h1>Public Pricing</h1>} />
                <Route path="/forgot-password" element={<h1>Reset page</h1>} />
              </Routes>
              <Where />
            </AuthContext.Provider>
          </MemoryRouter>
        </StaticAuthConfig>
      </HelmetProvider>
    );
  }

  const fillLogin = (identifier = 'alice', password = 'password123') => {
    fireEvent.change(screen.getByLabelText('Username or email'), { target: { value: identifier } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: password } });
    fireEvent.click(screen.getByRole('button', { name: 'Log in' }));
  };

  describe('Login', () => {
    it('shows the welcome heading and the form, with no single sign-on button', () => {
      renderWithAuth(<AuthenticationPage />, '/authentication');

      expect(screen.getByRole('heading', { level: 1, name: 'Welcome back' })).toBeInTheDocument();
      expect(
        screen.queryByRole('link', { name: 'Continue with Universidad de Sevilla' })
      ).not.toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Forgot password?' })).toHaveAttribute(
        'href',
        '/forgot-password'
      );
      expect(screen.getByRole('link', { name: 'Create one' })).toHaveAttribute(
        'href',
        '/authentication?view=register'
      );
      expect(screen.getByLabelText('Username or email')).toHaveAttribute(
        'autocomplete',
        'username'
      );
      expect(screen.getByLabelText('Password')).toHaveAttribute('autocomplete', 'current-password');
      expect(screen.getByRole('link', { name: 'Back' })).toHaveAttribute('href', '/');
    });

    it('redirects to /app upon sign in by default', async () => {
      signInMock.mockResolvedValue(undefined);
      renderWithAuth(<AuthenticationPage />, '/authentication');

      fillLogin();

      expect(signInMock).toHaveBeenCalledWith('alice', 'password123');
      expect(
        await screen.findByRole('heading', { name: 'Platform Dashboard' })
      ).toBeInTheDocument();
      expect(screen.queryByRole('heading', { name: 'Account Settings' })).not.toBeInTheDocument();
    });

    it('redirects to a deep /app route if origin state points to the platform', async () => {
      signInMock.mockResolvedValue(undefined);
      renderWithAuth(<AuthenticationPage />, {
        pathname: '/authentication',
        state: { from: '/problems/org/project' },
      });

      fillLogin();

      expect(await screen.findByRole('heading', { name: 'Project Workspace' })).toBeInTheDocument();
    });

    it('redirects to /app/account if origin state points to /app/account', async () => {
      signInMock.mockResolvedValue(undefined);
      renderWithAuth(<AuthenticationPage />, {
        pathname: '/authentication',
        state: { from: '/me/settings' },
      });

      fillLogin();

      expect(await screen.findByRole('heading', { name: 'Account Settings' })).toBeInTheDocument();
    });

    it('returns to the invitation link it was asked from', async () => {
      signInMock.mockResolvedValue(undefined);
      renderWithAuth(<AuthenticationPage />, {
        pathname: '/authentication',
        state: { from: '/orgs/join/c0de0000c0de0000' },
      });

      fillLogin();

      expect(await screen.findByRole('heading', { name: 'Invitation page' })).toBeInTheDocument();
      expect(screen.getByTestId('where')).toHaveTextContent('/orgs/join/c0de0000c0de0000');
    });

    it('returns to the page of a composition with the fork asked for there', async () => {
      signInMock.mockResolvedValue(undefined);
      renderWithAuth(<AuthenticationPage />, {
        pathname: '/authentication',
        state: { from: '/compositions/lab-other/fleet-routing?version=1.1.0&fork=1' },
      });

      fillLogin();

      expect(
        await screen.findByRole('heading', { name: 'Public composition' })
      ).toBeInTheDocument();
      expect(screen.getByTestId('where')).toHaveTextContent(
        '/compositions/lab-other/fleet-routing?version=1.1.0&fork=1'
      );
    });

    it.each(['/pricing', '/account', '//evil.example/app', '/appx', '/c/lab-other/fleet-routing'])(
      'ignores %s as an origin and goes to /app',
      async from => {
        signInMock.mockResolvedValue(undefined);
        renderWithAuth(<AuthenticationPage />, { pathname: '/authentication', state: { from } });

        fillLogin();

        expect(
          await screen.findByRole('heading', { name: 'Platform Dashboard' })
        ).toBeInTheDocument();
      }
    );

    it('tells a signed-in visitor so, instead of showing the form', () => {
      renderWithAuth(<AuthenticationPage />, '/authentication', sampleUser);

      expect(screen.getByRole('heading', { name: 'You’re already signed in' })).toBeInTheDocument();
      expect(screen.getByText('Signed in as alice (alice@example.test).')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Continue to your workspace' })).toHaveAttribute(
        'href',
        '/'
      );
      expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Log in as someone else' }));
      expect(signOutMock).toHaveBeenCalled();
    });

    it('sends the already signed-in visitor on to the page they asked for', () => {
      renderWithAuth(
        <AuthenticationPage />,
        { pathname: '/authentication', state: { from: '/problems/org/project' } },
        sampleUser
      );

      expect(screen.getByRole('link', { name: 'Continue to your workspace' })).toHaveAttribute(
        'href',
        '/problems/org/project'
      );
    });

    it('does not flash the already-signed-in notice while its own sign-in is finishing', async () => {
      let finish: () => void = () => undefined;
      signInMock.mockReturnValue(
        new Promise<void>(resolve => {
          finish = resolve;
        })
      );
      const view = renderWithAuth(<AuthenticationPage />, '/authentication');

      fillLogin();
      // The context now has a user, as it does while the profile loads, but the sign-in has not returned.
      view.rerender(
        <HelmetProvider>
          <StaticAuthConfig value={{ provider: 'local' }}>
            <MemoryRouter initialEntries={['/authentication']}>
              <AuthContext.Provider
                value={{
                  user: sampleUser,
                  loading: false,
                  signIn: signInMock,
                  register: registerMock,
                  signOut: signOutMock,
                  refresh: vi.fn(),
                  resume: vi.fn(),
                  isAdmin: false,
                  fetchWithInterceptor: vi.fn(),
                }}
              >
                <Routes>
                  <Route path="/authentication" element={<AuthenticationPage />} />
                  <Route path="/" element={<h1>Platform Dashboard</h1>} />
                </Routes>
              </AuthContext.Provider>
            </MemoryRouter>
          </StaticAuthConfig>
        </HelmetProvider>
      );
      expect(
        screen.queryByRole('heading', { name: 'You’re already signed in' })
      ).not.toBeInTheDocument();
      finish();
      expect(
        await screen.findByRole('heading', { name: 'Platform Dashboard' })
      ).toBeInTheDocument();
    });

    it('continues to the asked-for page when this screen replaces the one that just signed the person in', async () => {
      // The interface restarts when the account changes: the new instance finds a user it did not see sign in.
      noteSignInStarted();
      renderWithAuth(
        <AuthenticationPage />,
        { pathname: '/authentication', state: { from: '/problems/org/project' } },
        sampleUser
      );

      expect(
        screen.queryByRole('heading', { name: 'You’re already signed in' })
      ).not.toBeInTheDocument();
      expect(await screen.findByRole('heading', { name: 'Project Workspace' })).toBeInTheDocument();
      expect(hasRecentSignIn()).toBe(false);
    });

    it('does not take an old sign-in for a fresh one', () => {
      sessionStorage.setItem('openbinding-sign-in-started', String(Date.now() - 60_000));
      renderWithAuth(<AuthenticationPage />, '/authentication', sampleUser);

      expect(screen.getByRole('heading', { name: 'You’re already signed in' })).toBeInTheDocument();
    });

    it('forgets the note when the sign-in fails', async () => {
      signInMock.mockRejectedValue(problem(401, 'invalid_credentials'));
      renderWithAuth(<AuthenticationPage />, '/authentication');

      fillLogin();

      await screen.findByRole('alert');
      expect(hasRecentSignIn()).toBe(false);
    });

    it('asks for both fields before calling the gateway, and says which one is missing', () => {
      renderWithAuth(<AuthenticationPage />, '/authentication');

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
      renderWithAuth(<AuthenticationPage />, '/authentication');

      fillLogin('ghost', 'wrong-password');

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent(
        'That username or email and password don’t match an active account.'
      );
      expect(screen.getByLabelText('Username or email')).toHaveAttribute('aria-invalid', 'true');
      expect(screen.getByLabelText('Password')).toHaveAttribute('aria-invalid', 'true');
      expect(screen.queryByRole('heading', { name: 'Platform Dashboard' })).not.toBeInTheDocument();
    });

    it('says when accounts are unavailable and points to the service status', async () => {
      signInMock.mockRejectedValue(problem(503, 'auth_unavailable'));
      renderWithAuth(<AuthenticationPage />, '/authentication');

      fillLogin();

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Sign-in is unavailable right now (503)'
      );
      // The gateway's own health beside the refusal, as the footer shows it.
      expect(screen.getByRole('alert')).toHaveTextContent(/Service status: /);
    });

    it('treats an unreachable pricing service as unavailable, not as a wrong password', async () => {
      signInMock.mockRejectedValue(new PricingUnavailableError('pricing is down'));
      renderWithAuth(<AuthenticationPage />, '/authentication');

      fillLogin();

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Sign-in is unavailable right now'
      );
    });

    it('says when OpenBinding cannot be reached at all', async () => {
      signInMock.mockRejectedValue(new TypeError('Failed to fetch'));
      renderWithAuth(<AuthenticationPage />, '/authentication');

      fillLogin();

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'OpenBinding couldn’t be reached.'
      );
    });

    it('disables the form while the request is in flight', async () => {
      signInMock.mockReturnValue(new Promise(() => undefined));
      renderWithAuth(<AuthenticationPage />, '/authentication');

      fillLogin();

      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Signing in…' })).toBeDisabled()
      );
      expect(screen.getByLabelText('Username or email')).toBeDisabled();
    });

    it('explains a session that ended without being asked to', () => {
      markSessionEnded();
      renderWithAuth(<AuthenticationPage />, '/authentication');

      expect(screen.getByText(/Your session ended and couldn’t be renewed\./)).toBeInTheDocument();
    });

    it('stays quiet about sessions when none ended', () => {
      renderWithAuth(<AuthenticationPage />, '/authentication');

      expect(screen.queryByText(/Your session ended/)).not.toBeInTheDocument();
    });

    it('shows the notice handed over by another screen', () => {
      renderWithAuth(<AuthenticationPage />, {
        pathname: '/authentication',
        state: { notice: 'Password changed. Log in with the new password.' },
      });

      expect(
        screen.getByText('Password changed. Log in with the new password.')
      ).toBeInTheDocument();
    });

    it('waits for the stored session before offering anything', () => {
      renderWithAuth(<AuthenticationPage />, '/authentication', null, true);

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
      renderWithAuth(<AuthenticationPage />, '/authentication?view=register');

      fillRegister();

      expect(registerMock).toHaveBeenCalledWith({
        username: 'alice',
        email: 'alice@example.test',
        password: 'password123',
      });
      expect(
        await screen.findByRole('heading', { name: 'Platform Dashboard' })
      ).toBeInTheDocument();
      expect(screen.queryByRole('heading', { name: 'Account Settings' })).not.toBeInTheDocument();
    });

    it('redirects to a deep /app route if origin state points to the platform', async () => {
      registerMock.mockResolvedValue(undefined);
      renderWithAuth(<AuthenticationPage />, {
        pathname: '/authentication',
        search: '?view=register',
        state: { from: '/problems/org/project' },
      });

      fillRegister();

      expect(await screen.findByRole('heading', { name: 'Project Workspace' })).toBeInTheDocument();
    });

    it('redirects to /app/account if origin state points to /app/account', async () => {
      registerMock.mockResolvedValue(undefined);
      renderWithAuth(<AuthenticationPage />, {
        pathname: '/authentication',
        search: '?view=register',
        state: { from: '/me/settings' },
      });

      fillRegister();

      expect(await screen.findByRole('heading', { name: 'Account Settings' })).toBeInTheDocument();
    });

    it('redirects to /app and ignores public or /account origin routes', async () => {
      registerMock.mockResolvedValue(undefined);
      renderWithAuth(<AuthenticationPage />, {
        pathname: '/authentication',
        search: '?view=register',
        state: { from: '/account' },
      });

      fillRegister();

      expect(
        await screen.findByRole('heading', { name: 'Platform Dashboard' })
      ).toBeInTheDocument();
      expect(screen.queryByRole('heading', { name: 'Account Settings' })).not.toBeInTheDocument();
    });

    it('continues to the asked-for page when this screen replaces the one that just created the account', async () => {
      noteSignInStarted();
      renderWithAuth(
        <AuthenticationPage />,
        { pathname: '/authentication', search: '?view=register', state: { from: '/me/settings' } },
        sampleUser
      );

      expect(
        screen.queryByRole('heading', { name: 'You already have an account' })
      ).not.toBeInTheDocument();
      expect(await screen.findByRole('heading', { name: 'Account Settings' })).toBeInTheDocument();
    });

    it('tells a signed-in visitor they already have an account', () => {
      renderWithAuth(<AuthenticationPage />, '/authentication?view=register', sampleUser);

      expect(
        screen.getByRole('heading', { name: 'You already have an account' })
      ).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Create account' })).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Log out' }));
      expect(signOutMock).toHaveBeenCalled();
    });

    it('checks the three fields locally and focuses the first one that is wrong', () => {
      renderWithAuth(<AuthenticationPage />, '/authentication?view=register');

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
      renderWithAuth(<AuthenticationPage />, '/authentication?view=register');
      const password = screen.getByLabelText('Password');

      expect(password).toHaveAccessibleDescription(
        'At least 10 characters. Length is the only rule.'
      );
      fireEvent.change(password, { target: { value: 'abcd' } });
      expect(password).toHaveAccessibleDescription('6 more characters needed');
      fireEvent.change(password, { target: { value: 'abcdefghij' } });
      expect(password).toHaveAccessibleDescription('✓ At least 10 characters');
    });

    it('says the name or email is taken and offers to log in or reset', async () => {
      registerMock.mockRejectedValue(problem(409, 'already_registered'));
      renderWithAuth(<AuthenticationPage />, '/authentication?view=register');

      fillRegister();

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('That username or email is already registered (409).');
      expect(within(alert).getByRole('link', { name: 'Log in' })).toHaveAttribute(
        'href',
        '/authentication'
      );
      expect(within(alert).getByRole('link', { name: 'reset your password' })).toHaveAttribute(
        'href',
        '/forgot-password'
      );
    });

    it('puts the gateway’s weak-password complaint on the password field', async () => {
      registerMock.mockRejectedValue(
        problem(422, 'weak_password', 'Password is on the common-passwords list.')
      );
      renderWithAuth(<AuthenticationPage />, '/authentication?view=register');

      fillRegister();

      expect(
        await screen.findByText('Password is on the common-passwords list.')
      ).toBeInTheDocument();
      expect(screen.getByLabelText('Password')).toHaveAttribute('aria-invalid', 'true');
    });

    it('maps field-level validation answers to their fields', async () => {
      const refused = problem(422);
      refused.problem = {
        code: 'validation_error',
        detail: 'Request validation failed: /email: value is not a valid email address',
        diagnostics: [
          {
            code: 'value_error',
            message: 'value is not a valid email address',
            in: 'body',
            pointer: '/email',
            loc: ['body', 'email'],
          },
        ],
      };
      registerMock.mockRejectedValue(refused);
      renderWithAuth(<AuthenticationPage />, '/authentication?view=register');

      fillRegister();

      expect(await screen.findByText('value is not a valid email address')).toBeInTheDocument();
      expect(screen.getByLabelText('Email')).toHaveAttribute('aria-invalid', 'true');
    });

    it('reports an unavailable gateway without claiming anything was saved', async () => {
      registerMock.mockRejectedValue(problem(503, 'auth_unavailable'));
      renderWithAuth(<AuthenticationPage />, '/authentication?view=register');

      fillRegister();

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Accounts can’t be created right now (503). Nothing was saved'
      );
    });

    it('shows how strong the password is as it is typed', () => {
      renderWithAuth(<AuthenticationPage />, '/authentication?view=register');

      expect(screen.getByText('Strength: Not set')).toBeInTheDocument();
      fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'abcdefghijk' } });
      expect(screen.getByText('Strength: Good')).toBeInTheDocument();
      fireEvent.change(screen.getByLabelText('Password'), {
        target: { value: 'Abcdefghijk-1234' },
      });
      expect(screen.getByText('Strength: Strong')).toBeInTheDocument();
    });

    it('is a view of the log in page that keeps where the person was heading', async () => {
      registerMock.mockResolvedValue(undefined);
      renderWithAuth(<AuthenticationPage />, {
        pathname: '/authentication',
        state: { from: '/problems/org/project' },
      });

      fireEvent.click(screen.getByRole('link', { name: 'Create one' }));

      expect(
        screen.getByRole('heading', { level: 1, name: 'Create your account' })
      ).toBeInTheDocument();
      expect(screen.getByTestId('where')).toHaveTextContent('/authentication?view=register');
      fillRegister();
      expect(await screen.findByRole('heading', { name: 'Project Workspace' })).toBeInTheDocument();
    });

    it('offers the way back to log in and the plans', () => {
      renderWithAuth(<AuthenticationPage />, '/authentication?view=register');

      expect(screen.getByRole('link', { name: 'Log in' })).toHaveAttribute(
        'href',
        '/authentication'
      );
      expect(screen.getByRole('link', { name: 'Compare plans' })).toHaveAttribute(
        'href',
        '/pricing'
      );
    });
  });
  describe('in SCORETech mode', () => {
    const identity: AuthConfig = {
      provider: 'scoretech',
      login_url: 'https://openbinding.test/api/v1/auth/identity/login',
      account_url: null,
    };
    it('shows no form and sends the browser to SCORETech Identity, for logging in and for signing up', () => {
      const replace = vi.fn();
      vi.stubGlobal('location', {
        ...window.location,
        origin: 'https://openbinding.test',
        replace,
      });
      for (const path of ['/authentication', '/authentication?view=register']) {
        const { unmount } = renderWithAuth(<AuthenticationPage />, path, null, false, identity);
        expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
        expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
          'Opening SCORETech Identity'
        );
        unmount();
      }
      expect(replace).toHaveBeenCalledTimes(2);
      for (const [href] of replace.mock.calls)
        expect(href).toBe('https://openbinding.test/api/v1/auth/identity/login?returnTo=%2F');
      vi.unstubAllGlobals();
    });
  });
});
