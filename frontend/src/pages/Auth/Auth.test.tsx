import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserProfile } from '../../api/auth';
import { AuthContext } from '../../contexts/auth';
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

describe('Auth navigation to platform', () => {
  const signInMock = vi.fn();
  const registerMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function renderWithAuth(
    ui: React.ReactElement,
    initialPath: string | { pathname: string; state?: unknown },
    user: UserProfile | null = null
  ) {
    const entry = typeof initialPath === 'string' ? { pathname: initialPath } : initialPath;
    return render(
      <MemoryRouter initialEntries={[entry]}>
        <AuthContext.Provider
          value={{
            user,
            loading: false,
            signIn: signInMock,
            register: registerMock,
            signOut: vi.fn(),
            refresh: vi.fn(),
            isAdmin: false,
          }}
        >
          <Routes>
            <Route path="/login" element={ui} />
            <Route path="/register" element={ui} />
            <Route path="/app" element={<h1>Platform Dashboard</h1>} />
            <Route path="/app/org/project" element={<h1>Project Workspace</h1>} />
            <Route path="/account" element={<h1>Legacy Account</h1>} />
            <Route path="/app/account" element={<h1>Account Settings</h1>} />
            <Route path="/pricing" element={<h1>Public Pricing</h1>} />
          </Routes>
        </AuthContext.Provider>
      </MemoryRouter>
    );
  }

  describe('Login', () => {
    it('redirects to /app upon sign in by default', async () => {
      signInMock.mockResolvedValue(undefined);
      renderWithAuth(<Login />, '/login');

      fireEvent.change(screen.getByLabelText(/username or email/i), { target: { value: 'alice' } });
      fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'password123' } });
      fireEvent.click(screen.getByRole('button', { name: /sign in/i }));

      expect(signInMock).toHaveBeenCalledWith('alice', 'password123');
      expect(await screen.findByRole('heading', { name: 'Platform Dashboard' })).toBeInTheDocument();
      expect(screen.queryByRole('heading', { name: 'Account Settings' })).not.toBeInTheDocument();
    });

    it('redirects to a deep /app route if origin state points to the platform', async () => {
      signInMock.mockResolvedValue(undefined);
      renderWithAuth(<Login />, { pathname: '/login', state: { from: '/app/org/project' } });

      fireEvent.change(screen.getByLabelText(/username or email/i), { target: { value: 'alice' } });
      fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'password123' } });
      fireEvent.click(screen.getByRole('button', { name: /sign in/i }));

      expect(await screen.findByRole('heading', { name: 'Project Workspace' })).toBeInTheDocument();
    });

    it('redirects to /app/account if origin state points to /app/account', async () => {
      signInMock.mockResolvedValue(undefined);
      renderWithAuth(<Login />, { pathname: '/login', state: { from: '/app/account' } });

      fireEvent.change(screen.getByLabelText(/username or email/i), { target: { value: 'alice' } });
      fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'password123' } });
      fireEvent.click(screen.getByRole('button', { name: /sign in/i }));

      expect(await screen.findByRole('heading', { name: 'Account Settings' })).toBeInTheDocument();
    });

    it('redirects to /app and ignores public or /account origin routes', async () => {
      signInMock.mockResolvedValue(undefined);
      renderWithAuth(<Login />, { pathname: '/login', state: { from: '/pricing' } });

      fireEvent.change(screen.getByLabelText(/username or email/i), { target: { value: 'alice' } });
      fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'password123' } });
      fireEvent.click(screen.getByRole('button', { name: /sign in/i }));

      expect(await screen.findByRole('heading', { name: 'Platform Dashboard' })).toBeInTheDocument();
      expect(screen.queryByRole('heading', { name: 'Public Pricing' })).not.toBeInTheDocument();
    });

    it('redirects immediately to /app if user is already authenticated', async () => {
      renderWithAuth(<Login />, '/login', sampleUser);

      expect(await screen.findByRole('heading', { name: 'Platform Dashboard' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /sign in/i })).not.toBeInTheDocument();
    });
  });

  describe('Register', () => {
    it('redirects to /app upon registration by default', async () => {
      registerMock.mockResolvedValue(undefined);
      renderWithAuth(<Register />, '/register');

      fireEvent.change(screen.getByLabelText(/^username$/i), { target: { value: 'alice' } });
      fireEvent.change(screen.getByLabelText(/^email$/i), { target: { value: 'alice@example.test' } });
      fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: 'password123' } });
      fireEvent.click(screen.getByRole('button', { name: /create account/i }));

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

      fireEvent.change(screen.getByLabelText(/^username$/i), { target: { value: 'alice' } });
      fireEvent.change(screen.getByLabelText(/^email$/i), { target: { value: 'alice@example.test' } });
      fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: 'password123' } });
      fireEvent.click(screen.getByRole('button', { name: /create account/i }));

      expect(await screen.findByRole('heading', { name: 'Project Workspace' })).toBeInTheDocument();
    });

    it('redirects to /app/account if origin state points to /app/account', async () => {
      registerMock.mockResolvedValue(undefined);
      renderWithAuth(<Register />, { pathname: '/register', state: { from: '/app/account' } });

      fireEvent.change(screen.getByLabelText(/^username$/i), { target: { value: 'alice' } });
      fireEvent.change(screen.getByLabelText(/^email$/i), { target: { value: 'alice@example.test' } });
      fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: 'password123' } });
      fireEvent.click(screen.getByRole('button', { name: /create account/i }));

      expect(await screen.findByRole('heading', { name: 'Account Settings' })).toBeInTheDocument();
    });

    it('redirects to /app and ignores public or /account origin routes', async () => {
      registerMock.mockResolvedValue(undefined);
      renderWithAuth(<Register />, { pathname: '/register', state: { from: '/account' } });

      fireEvent.change(screen.getByLabelText(/^username$/i), { target: { value: 'alice' } });
      fireEvent.change(screen.getByLabelText(/^email$/i), { target: { value: 'alice@example.test' } });
      fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: 'password123' } });
      fireEvent.click(screen.getByRole('button', { name: /create account/i }));

      expect(await screen.findByRole('heading', { name: 'Platform Dashboard' })).toBeInTheDocument();
      expect(screen.queryByRole('heading', { name: 'Account Settings' })).not.toBeInTheDocument();
    });

    it('redirects immediately to /app if user is already authenticated', async () => {
      renderWithAuth(<Register />, '/register', sampleUser);

      expect(await screen.findByRole('heading', { name: 'Platform Dashboard' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /create account/i })).not.toBeInTheDocument();
    });
  });
});
