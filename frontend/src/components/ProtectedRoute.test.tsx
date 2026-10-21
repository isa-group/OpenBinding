import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { UserProfile } from '../api/auth';
import { AuthContext } from '../contexts/auth';
import { ProtectedRoute } from './ProtectedRoute';

const account: UserProfile = {
  id: 'alice-id',
  username: 'alice',
  email: 'alice@example.test',
  role: 'user',
  plan: 'FREE',
  is_active: true,
  created_at: '2026-01-01T00:00:00Z',
};

function SignIn() {
  const from = (useLocation().state as { from?: string } | null)?.from;
  return <h1>Sign in{from ? ` (from ${from})` : ''}</h1>;
}

function renderGuard(user: UserProfile | null, requireAdmin = false, loading = false, entry = '/protected') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <AuthContext.Provider value={{
        user,
        loading,
        signIn: vi.fn(),
        register: vi.fn(),
        signOut: vi.fn(),
        refresh: vi.fn(),
        isAdmin: user?.role === 'admin',
      }}>
        <Routes>
          <Route path="/login" element={<SignIn />} />
          <Route path="/app/account" element={<h1>Account</h1>} />
          <Route path="/protected" element={<ProtectedRoute requireAdmin={requireAdmin}><h1>Protected content</h1></ProtectedRoute>} />
        </Routes>
      </AuthContext.Provider>
    </MemoryRouter>,
  );
}

describe('ProtectedRoute', () => {
  it('redirects anonymous visitors to sign in and remembers where they were going', () => {
    renderGuard(null);
    expect(screen.getByRole('heading', { name: 'Sign in (from /protected)' })).toBeInTheDocument();
    expect(screen.queryByText('Protected content')).not.toBeInTheDocument();
  });

  it('remembers the query string too, so a deep link survives the sign-in detour', () => {
    renderGuard(null, false, false, '/protected?tab=queue');
    expect(screen.getByRole('heading', { name: 'Sign in (from /protected?tab=queue)' })).toBeInTheDocument();
  });

  it('waits for the stored session instead of bouncing a signed-in user to sign in', () => {
    renderGuard(null, false, true);
    expect(screen.getByText('Checking your session…')).toBeInTheDocument();
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
  });

  it('sends anonymous visitors to sign in on admin pages too', () => {
    renderGuard(null, true);
    expect(screen.getByRole('heading', { name: /^Sign in/ })).toBeInTheDocument();
  });

  it('lets administrators into admin pages', () => {
    renderGuard({ ...account, role: 'admin' }, true);
    expect(screen.getByRole('heading', { name: 'Protected content' })).toBeInTheDocument();
  });

  it('allows an authenticated account', () => {
    renderGuard(account);
    expect(screen.getByRole('heading', { name: 'Protected content' })).toBeInTheDocument();
  });

  it('keeps non-administrators out of admin pages', () => {
    renderGuard(account, true);
    expect(screen.getByRole('heading', { name: 'Account' })).toBeInTheDocument();
    expect(screen.queryByText('Protected content')).not.toBeInTheDocument();
  });
});
