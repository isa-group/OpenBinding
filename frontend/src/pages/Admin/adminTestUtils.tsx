import type { ReactElement } from 'react';
import { render } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { vi } from 'vitest';
import type { UserProfile } from '../../api/auth';
import { HttpError } from '../../api/client';
import { AuthContext } from '../../contexts/auth';
import { ALEX } from '../../test/fixtures/admin';

/** Render a screen as a signed-in account would see it. Administrators by default; give `path` to read route parameters. */
export function renderAdmin(element: ReactElement, options: { user?: UserProfile; entry?: string; path?: string } = {}) {
  const user = options.user ?? ALEX;
  const page = options.path ? <Routes><Route path={options.path} element={element} /></Routes> : element;
  return render(
    <MemoryRouter initialEntries={[options.entry ?? '/']}>
      <AuthContext.Provider value={{ user, loading: false, signIn: vi.fn(), register: vi.fn(), signOut: vi.fn(), refresh: vi.fn(), isAdmin: user.role === 'admin' }}>
        {page}
      </AuthContext.Provider>
    </MemoryRouter>,
  );
}

/** What the client throws when the gateway refuses with this status and error code. */
export function refusal(status: number, code?: string, message = 'refused'): HttpError {
  const error = new HttpError(status, message);
  if (code) error.code = code;
  return error;
}
