import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { HelmetProvider } from 'react-helmet-async';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../../core/api/http';
import { AuthContext } from '../../hooks/useAuth';
import IdentityUsernamePage from '.';

const api = vi.hoisted(() => ({ identityPending: vi.fn(), identityComplete: vi.fn() }));
vi.mock('../../api/identityApi', async () => ({
  ...(await vi.importActual<typeof import('../../api/identityApi')>('../../api/identityApi')),
  identityApi: api,
}));

const PENDING = {
  suggested_username: 'lucia',
  email: 'lucia@example.test',
  email_verified: true,
  display_name: 'Lucía Vega',
  expires_at: '2026-11-01T10:15:00Z',
};

function refusal(status: number, code: string) {
  const error = new HttpError(status, code);
  error.code = code;
  return error;
}

function Where() {
  const location = useLocation();
  return <output data-testid="where">{`${location.pathname}${location.search}`}</output>;
}

const resume = vi.fn();
const signOut = vi.fn();

function draw(entry = '/sso/identity/username?returnTo=%2Fme%2Forgs') {
  return render(
    <HelmetProvider>
      <AuthContext.Provider
        value={{
          user: null,
          loading: false,
          signIn: vi.fn(),
          register: vi.fn(),
          signOut,
          refresh: vi.fn(),
          resume,
          isAdmin: false,
          fetchWithInterceptor: vi.fn(),
        }}
      >
        <MemoryRouter initialEntries={[entry]}>
          <Routes>
            <Route path="/sso/identity/username" element={<IdentityUsernamePage />} />
            <Route path="*" element={<h1>Elsewhere</h1>} />
          </Routes>
          <Where />
        </MemoryRouter>
      </AuthContext.Provider>
    </HelmetProvider>
  );
}

const field = () => screen.getByLabelText('Username');
const submit = () => fireEvent.click(screen.getByRole('button', { name: 'Create my account' }));

describe('IdentityUsernamePage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.identityPending.mockResolvedValue(PENDING);
    resume.mockResolvedValue(undefined);
    signOut.mockResolvedValue(undefined);
  });

  it('prefills the suggestion, names the verified email and says the username is public', async () => {
    draw();
    expect(await screen.findByDisplayValue('lucia')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 1, name: 'Choose your username' })
    ).toBeInTheDocument();
    expect(screen.getByText('lucia@example.test')).toBeInTheDocument();
    expect(screen.getByText(/Welcome, Lucía Vega/)).toBeInTheDocument();
    expect(
      screen.getByText(
        'Your username is public: it names your compositions, engines and organizations.'
      )
    ).toBeInTheDocument();
  });

  it('asks for a username before calling the gateway, and checks its pattern', async () => {
    draw();
    await screen.findByDisplayValue('lucia');
    fireEvent.change(field(), { target: { value: '' } });
    submit();
    expect(await screen.findByText('Choose a username.')).toBeInTheDocument();
    fireEvent.change(field(), { target: { value: '-x' } });
    submit();
    expect(
      await screen.findByText(/Use 3 to 64 letters, digits, dots, hyphens or underscores/)
    ).toBeInTheDocument();
    expect(api.identityComplete).not.toHaveBeenCalled();
    expect(field()).toHaveAttribute('aria-invalid', 'true');
  });

  it.each([
    ['username_taken', 'That username is taken. Choose another one.'],
    ['username_unavailable', 'That username is reserved. Choose another one.'],
    ['pending_in_progress', /already being completed in another tab/],
  ])('names a %s refusal under the field', async (code, words) => {
    api.identityComplete.mockRejectedValueOnce(refusal(409, code));
    draw();
    await screen.findByDisplayValue('lucia');
    submit();
    expect(await screen.findByText(words)).toBeInTheDocument();
    expect(resume).not.toHaveBeenCalled();
  });

  it('creates the account, resumes the session and goes where the person was going', async () => {
    api.identityComplete.mockResolvedValueOnce({ return_to: '/me/orgs' });
    draw();
    await screen.findByDisplayValue('lucia');
    fireEvent.change(field(), { target: { value: 'lucia.vega' } });
    submit();
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/me/orgs'));
    expect(api.identityComplete).toHaveBeenCalledWith('lucia.vega');
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it('sends an expired sign-up back to sign in, whether it expired before or during the form', async () => {
    api.identityPending.mockRejectedValueOnce(refusal(404, 'no_pending_signup'));
    const first = draw();
    await waitFor(() =>
      expect(screen.getByTestId('where')).toHaveTextContent(
        '/authentication?identity_error=expired'
      )
    );
    first.unmount();

    api.identityComplete.mockRejectedValueOnce(refusal(404, 'no_pending_signup'));
    draw();
    await screen.findByDisplayValue('lucia');
    submit();
    await waitFor(() =>
      expect(screen.getByTestId('where')).toHaveTextContent(
        '/authentication?identity_error=expired'
      )
    );
  });

  it('offers another account: it signs out (ending the pending sign-up) and goes home', async () => {
    draw();
    await screen.findByDisplayValue('lucia');
    fireEvent.click(screen.getByRole('button', { name: 'Not you? Use another account' }));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(/^\/$/));
    expect(signOut).toHaveBeenCalledTimes(1);
  });
});
