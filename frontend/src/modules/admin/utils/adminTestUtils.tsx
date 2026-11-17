import type { ReactElement } from 'react';
import { render } from '@testing-library/react';
import { HelmetProvider } from 'react-helmet-async';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { vi } from 'vitest';
import type { UserProfile } from '../../core/api/account';
import { HttpError } from '../../core/api/http';
import { AuthContext } from '../../auth/hooks/useAuth';
import { ALEX } from '../../../test/fixtures/admin';
import AdminPage from '../pages/admin';

/**
 * Render a screen as a signed-in account would see it. Administrators by default; give `path` to read route parameters.
 * The administration API is the test's own: mock `modules/admin/api/adminApi` (`useAdminApi`) in the test file.
 */
export function renderAdmin(
  element: ReactElement,
  options: { user?: UserProfile; entry?: string; path?: string } = {}
) {
  const user = options.user ?? ALEX;
  const page = options.path ? (
    <Routes>
      <Route path={options.path} element={element} />
    </Routes>
  ) : (
    element
  );
  return render(
    <HelmetProvider>
      <MemoryRouter initialEntries={[options.entry ?? '/']}>
        <AuthContext.Provider
          value={{
            user,
            loading: false,
            signIn: vi.fn(),
            register: vi.fn(),
            signOut: vi.fn(),
            refresh: vi.fn(),
            isAdmin: user.role === 'admin',
            fetchWithInterceptor: vi.fn(),
          }}
        >
          {page}
        </AuthContext.Provider>
      </MemoryRouter>
    </HelmetProvider>
  );
}

/** Render `/admin/:section?` at `entry` (`/admin/users`, `/admin/audit`…), as an administrator by default. */
export function renderSection(entry: string, options: { user?: UserProfile } = {}) {
  return renderAdmin(<AdminPage />, { ...options, entry, path: '/admin/:section?' });
}

/** What the client throws when the gateway refuses with this status and error code. */
export function refusal(status: number, code?: string, message = 'refused'): HttpError {
  const error = new HttpError(status, message);
  if (code) error.code = code;
  return error;
}
