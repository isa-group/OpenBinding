// Renders one screen of an organization at a route, with a signed-in account and the router (what the organization tabs'
// tests need; the old workspace kit also handed out the removed outlet context).

import type { ReactElement } from 'react';
import { render } from '@testing-library/react';
import { MemoryRouter, parsePath, Route, Routes } from 'react-router-dom';
import { vi } from 'vitest';
import type { UserProfile } from '../modules/core/api/account';
import { AuthContext } from '../modules/auth/hooks/useAuth';
import { lucia } from './fixtures/accounts';
import { Where } from './Where';

export interface RenderOptions {
  /** The route pattern. */
  path: string;
  /** The address to open. */
  url: string;
  user?: UserProfile;
  state?: unknown;
}

export function renderScreen(ui: ReactElement, options: RenderOptions) {
  const user = options.user ?? lucia;
  return render(
    <MemoryRouter initialEntries={[{ ...parsePath(options.url), state: options.state }]}>
      <AuthContext.Provider
        value={{
          user,
          loading: false,
          signIn: vi.fn(),
          register: vi.fn(),
          signOut: vi.fn(),
          refresh: vi.fn(),
          resume: vi.fn(),
          isAdmin: user.role === 'admin',
          fetchWithInterceptor: vi.fn(),
        }}
      >
        <Routes>
          <Route path={options.path} element={ui} />
          <Route path="*" element={<p>elsewhere</p>} />
        </Routes>
        <Where />
      </AuthContext.Provider>
    </MemoryRouter>
  );
}
