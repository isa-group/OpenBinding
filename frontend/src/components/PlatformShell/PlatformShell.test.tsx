import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserProfile } from '../../api/auth';
import { AuthContext } from '../../contexts/auth';
import { ThemeContext } from '../../contexts/theme';
import { PlatformShell } from './PlatformShell';
import { platformApi } from '../../api/platform';

vi.mock('../../api/platform', () => ({
  platformApi: {
    organizations: vi.fn(),
    projects: vi.fn(),
  },
}));

const user: UserProfile = {
  id: 'user-1',
  username: 'alice',
  email: 'alice@example.com',
  role: 'user',
  plan: 'FREE',
  is_active: true,
  created_at: '2026-01-01T00:00:00Z',
};

const adminUser: UserProfile = {
  ...user,
  role: 'admin',
};

function renderShell(currentUser: UserProfile, initialPath = '/app') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <ThemeContext.Provider value={{ theme: 'light', setTheme: vi.fn(), toggleTheme: vi.fn() }}>
        <AuthContext.Provider
          value={{
            user: currentUser,
            loading: false,
            signIn: vi.fn(),
            register: vi.fn(),
            signOut: vi.fn(),
            refresh: vi.fn(),
            isAdmin: currentUser.role === 'admin',
          }}
        >
          <PlatformShell />
        </AuthContext.Provider>
      </ThemeContext.Provider>
    </MemoryRouter>,
  );
}

describe('PlatformShell System Navigation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(platformApi.organizations).mockResolvedValue([
      {
        id: 'org-1',
        name: 'Test Org',
        slug: 'test-org',
        parent_id: null,
        billing_sponsor_user_id: 'user-1',
        effective_role: 'OWNER',
        created_at: '2026-01-01T00:00:00Z',
      },
    ]);
    vi.mocked(platformApi.projects).mockResolvedValue([]);
  });

  it('renders Account link under System navigation pointing to /app/account', async () => {
    renderShell(user);

    const accountLinks = screen.getAllByRole('link', { name: /Account/i });
    const systemAccountLink = accountLinks.find((l) => l.getAttribute('href') === '/app/account');
    expect(systemAccountLink).toBeInTheDocument();

    // Verify Administration is not visible for non-admin
    expect(screen.queryByRole('link', { name: /Administration/i })).not.toBeInTheDocument();
  });

  it('renders Administration link under System navigation pointing to /app/admin for admins', async () => {
    renderShell(adminUser);

    const adminLinks = screen.getAllByRole('link', { name: /Administration/i });
    expect(adminLinks.length).toBeGreaterThanOrEqual(1);
    for (const link of adminLinks) {
      expect(link).toHaveAttribute('href', '/app/admin');
    }
  });

  it('renders /app/account link in user account dropdown menu', async () => {
    renderShell(user);

    const dropdownAccountLink = screen.getAllByRole('link', { name: /Account/i })
      .find((link) => link.closest('.account-menu') !== null);
    expect(dropdownAccountLink).toBeInTheDocument();
    expect(dropdownAccountLink).toHaveAttribute('href', '/app/account');
  });

  it('renders zero-state workspace buttons when organizations or projects are empty', async () => {
    vi.mocked(platformApi.organizations).mockResolvedValue([]);
    renderShell(user);

    expect(await screen.findByRole('link', { name: /New Organization/i })).toBeInTheDocument();
  });

  it('renders /app/engines link under System navigation and no direct public links to /engines or /schemas', async () => {
    renderShell(user);

    const enginesLink = await screen.findByRole('link', { name: /Engines/i });
    expect(enginesLink).toHaveAttribute('href', '/app/engines');

    // Sidebar should not contain direct links to public /engines or /schemas
    const sidebar = screen.getByRole('navigation', { name: /Workspace navigation/i });
    expect(sidebar.querySelector('a[href="/engines"]')).toBeNull();
    expect(sidebar.querySelector('a[href="/schemas"]')).toBeNull();
  });
});
