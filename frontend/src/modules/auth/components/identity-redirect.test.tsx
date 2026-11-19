import { render, screen } from '@testing-library/react';
import { StrictMode } from 'react';
import { HelmetProvider } from 'react-helmet-async';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserProfile } from '../../core/api/account';
import { StaticAuthConfig } from '../contexts/authConfig';
import type { AuthConfig } from '../contexts/authConfigContext';
import { AuthContext } from '../hooks/useAuth';
import {
  IDENTITY_ERRORS,
  IdentityAwareLocalPage,
  IdentityCallback,
  IdentityRedirect,
} from './identity-redirect';

const LOGIN = 'https://openbinding.test/api/v1/auth/identity/login';
const scoretech: AuthConfig = { provider: 'scoretech', login_url: LOGIN, account_url: null };
const local: AuthConfig = { provider: 'local' };

const person: UserProfile = {
  id: 'u1',
  username: 'lucia',
  email: 'lucia@example.test',
  role: 'user',
  plan: 'FREE',
  is_active: true,
  created_at: '2026-01-01T00:00:00Z',
  email_verified: true,
  institutional_email: false,
};

function Where() {
  const location = useLocation();
  return <output data-testid="where">{`${location.pathname}${location.search}`}</output>;
}

function draw(
  ui: React.ReactElement,
  entry: string | { pathname: string; search?: string; state?: unknown },
  { config = scoretech, user = null as UserProfile | null, loading = false } = {}
) {
  return render(
    <StrictMode>
      <HelmetProvider>
        <StaticAuthConfig value={config}>
          <AuthContext.Provider
            value={{
              user,
              loading,
              signIn: vi.fn(),
              register: vi.fn(),
              signOut: vi.fn(),
              refresh: vi.fn(),
              resume: vi.fn(),
              isAdmin: false,
              fetchWithInterceptor: vi.fn(),
            }}
          >
            <MemoryRouter initialEntries={[entry]}>
              <Routes>
                <Route path="*" element={ui} />
              </Routes>
              <Where />
            </MemoryRouter>
          </AuthContext.Provider>
        </StaticAuthConfig>
      </HelmetProvider>
    </StrictMode>
  );
}

describe('IdentityRedirect', () => {
  const replace = vi.fn();
  beforeEach(() => {
    replace.mockReset();
    vi.stubGlobal('location', { ...window.location, origin: 'https://openbinding.test', replace });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('replaces the page once with the sign-in URL and where the person was going', () => {
    draw(<IdentityRedirect />, { pathname: '/authentication', state: { from: '/me/orgs?tab=x' } });
    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith(`${LOGIN}?returnTo=%2Fme%2Forgs%3Ftab%3Dx`);
    expect(screen.getByRole('link', { name: 'Continue to SCORETech Identity' })).toHaveAttribute(
      'href',
      `${LOGIN}?returnTo=%2Fme%2Forgs%3Ftab%3Dx`
    );
  });

  it.each(['https://evil.example/', '//evil.example/x', '/pricing', '/sso/identity/callback'])(
    'sends an unsafe return target (%s) home instead',
    from => {
      draw(<IdentityRedirect />, { pathname: '/authentication', state: { from } });
      expect(replace).toHaveBeenCalledWith(`${LOGIN}?returnTo=%2F`);
    }
  );

  it.each(Object.keys(IDENTITY_ERRORS))(
    'stays on the page for identity_error=%s, says what happened and offers Try again',
    code => {
      draw(<IdentityRedirect />, `/authentication?identity_error=${code}`);
      expect(replace).not.toHaveBeenCalled();
      const copy = IDENTITY_ERRORS[code as keyof typeof IDENTITY_ERRORS];
      expect(screen.getByRole('heading', { level: 1, name: copy.title })).toBeInTheDocument();
      expect(screen.getByText(copy.body)).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Try again' })).toHaveAttribute(
        'href',
        `${LOGIN}?returnTo=%2F`
      );
    }
  );

  it('reads an unknown code as a failed sign-in, never looping', () => {
    draw(<IdentityRedirect />, '/authentication?identity_error=whatever');
    expect(replace).not.toHaveBeenCalled();
    expect(
      screen.getByRole('heading', { level: 1, name: IDENTITY_ERRORS.signin_failed.title })
    ).toBeInTheDocument();
  });
});

describe('IdentityCallback', () => {
  it('waits for the session, then goes to the safe returnTo once, even under StrictMode', () => {
    const waiting = draw(<IdentityCallback />, '/sso/identity/callback?returnTo=%2Fme%2Forgs', {
      loading: true,
    });
    expect(screen.getByText('Signing you in…')).toBeInTheDocument();
    expect(screen.getByTestId('where')).toHaveTextContent('/sso/identity/callback');
    waiting.unmount();
    draw(<IdentityCallback />, '/sso/identity/callback?returnTo=%2Fme%2Forgs', { user: person });
    expect(screen.getByTestId('where')).toHaveTextContent(/^\/me\/orgs$/);
  });

  it('sends an unsafe returnTo home', () => {
    draw(<IdentityCallback />, '/sso/identity/callback?returnTo=%2F%2Fevil.example', {
      user: person,
    });
    expect(screen.getByTestId('where')).toHaveTextContent(/^\/$/);
  });

  it('says the sign-in failed when no session came of it', () => {
    draw(<IdentityCallback />, '/sso/identity/callback?returnTo=%2Fme%2Forgs');
    expect(screen.getByTestId('where')).toHaveTextContent(
      '/authentication?identity_error=signin_failed'
    );
  });
});

describe('IdentityAwareLocalPage', () => {
  const replace = vi.fn();
  beforeEach(() =>
    vi.stubGlobal('location', { ...window.location, origin: 'https://openbinding.test', replace })
  );
  afterEach(() => vi.unstubAllGlobals());

  it('shows the local page in local mode', () => {
    draw(
      <IdentityAwareLocalPage>
        <h1>Reset your password</h1>
      </IdentityAwareLocalPage>,
      '/forgot-password',
      { config: local }
    );
    expect(screen.getByRole('heading', { name: 'Reset your password' })).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });

  it('goes to SCORETech Identity instead in SCORETech mode', () => {
    draw(
      <IdentityAwareLocalPage>
        <h1>Reset your password</h1>
      </IdentityAwareLocalPage>,
      '/forgot-password'
    );
    expect(screen.queryByRole('heading', { name: 'Reset your password' })).not.toBeInTheDocument();
    expect(replace).toHaveBeenCalledWith(`${LOGIN}?returnTo=%2F`);
  });
});
