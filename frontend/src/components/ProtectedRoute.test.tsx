import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
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

function renderGuard(user: UserProfile | null, requireAdmin = false) {
  return render(
    <MemoryRouter initialEntries={['/protected']}>
      <AuthContext.Provider value={{
        user,
        loading: false,
        signIn: vi.fn(),
        register: vi.fn(),
        signOut: vi.fn(),
        refresh: vi.fn(),
        isAdmin: user?.role === 'admin',
      }}>
        <Routes>
          <Route path="/login" element={<h1>Sign in</h1>} />
          <Route path="/account" element={<h1>Account</h1>} />
          <Route path="/protected" element={<ProtectedRoute requireAdmin={requireAdmin}><h1>Protected content</h1></ProtectedRoute>} />
        </Routes>
      </AuthContext.Provider>
    </MemoryRouter>,
  );
}

describe('ProtectedRoute', () => {
  it('redirects anonymous visitors to sign in', () => {
    renderGuard(null);
    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.queryByText('Protected content')).not.toBeInTheDocument();
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
