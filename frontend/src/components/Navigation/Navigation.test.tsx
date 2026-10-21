import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserProfile } from '../../api/auth';
import { Navigation } from './Navigation';

const auth = vi.hoisted(() => ({
  user: null as UserProfile | null,
  isAdmin: false,
  signOut: vi.fn(),
}));

vi.mock('../../contexts/auth', () => ({ useAuth: () => auth }));

const member: UserProfile = {
  id: 'user-1', username: 'alice', email: 'alice@example.com', role: 'user', is_active: true,
  plan: 'FREE', created_at: '2026-01-01T00:00:00Z',
};

function renderHeader(path = '/') {
  return render(<MemoryRouter initialEntries={[path]}><Navigation /></MemoryRouter>);
}

describe('Public header', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.user = null;
    auth.isAdmin = false;
  });

  it('links to the final public routes', () => {
    renderHeader();

    const nav = screen.getByRole('navigation', { name: 'Primary navigation' });
    expect(within(nav).getByRole('link', { name: 'Explore' })).toHaveAttribute('href', '/explore');
    expect(within(nav).getByRole('link', { name: 'Engines' })).toHaveAttribute('href', '/engines');
    expect(within(nav).getByRole('link', { name: 'Pricing' })).toHaveAttribute('href', '/pricing');
    expect(within(nav).getByRole('link', { name: 'About' })).toHaveAttribute('href', '/about');
    expect(screen.getByRole('link', { name: 'Log in' })).toHaveAttribute('href', '/login');
    expect(screen.getByRole('link', { name: 'Sign up' })).toHaveAttribute('href', '/register');
    expect(screen.getByRole('link', { name: /OpenBinding home/i })).toHaveAttribute('href', '/');
  });

  it('opens the Language menu with its four destinations', () => {
    renderHeader();

    const toggle = screen.getByRole('button', { name: /Language/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('link', { name: /^Workbench/ })).not.toBeInTheDocument();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('link', { name: /^Profiles & dialects/ })).toHaveAttribute('href', '/language');
    expect(screen.getByRole('link', { name: /^Schemas/ })).toHaveAttribute('href', '/language/schemas/application');
    expect(screen.getByRole('link', { name: /^Examples/ })).toHaveAttribute('href', '/examples');
    expect(screen.getByRole('link', { name: /^Workbench/ })).toHaveAttribute('href', '/workbench');
  });

  it('closes the Language menu with Escape and returns focus to its button', () => {
    renderHeader();

    const toggle = screen.getByRole('button', { name: /Language/ });
    fireEvent.click(toggle);
    fireEvent.keyDown(screen.getByRole('link', { name: /^Examples/ }), { key: 'Escape' });

    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveFocus();
  });

  it('closes open menus when pressing outside the header', () => {
    renderHeader();

    const toggle = screen.getByRole('button', { name: /Language/ });
    fireEvent.click(toggle);
    fireEvent.pointerDown(screen.getByRole('link', { name: /^Examples/ }));
    expect(toggle).toHaveAttribute('aria-expanded', 'true');

    fireEvent.pointerDown(document.body);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });

  it('closes the Language menu when navigating', () => {
    renderHeader();

    const toggle = screen.getByRole('button', { name: /Language/ });
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole('link', { name: /^Examples/ }));

    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('link', { name: /^Examples/ })).not.toBeInTheDocument();
  });

  it('marks the current page with aria-current', () => {
    renderHeader('/pricing');

    expect(screen.getByRole('link', { name: 'Pricing' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Explore' })).not.toHaveAttribute('aria-current');
  });

  it('marks the Language entry and the current schema page', () => {
    renderHeader('/language/schemas/application');

    const toggle = screen.getByRole('button', { name: /Language/ });
    expect(toggle).toHaveClass('is-active');
    fireEvent.click(toggle);
    expect(screen.getByRole('link', { name: /^Schemas/ })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: /^Profiles & dialects/ })).not.toHaveAttribute('aria-current');
  });

  it('exposes the complete journey in the mobile menu and closes it after navigating', () => {
    renderHeader();

    const toggle = screen.getByRole('button', { name: 'Open menu' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('navigation', { name: 'Mobile navigation' })).not.toBeInTheDocument();

    fireEvent.click(toggle);
    const mobile = screen.getByRole('navigation', { name: 'Mobile navigation' });
    expect(screen.getByRole('button', { name: 'Close menu' })).toHaveAttribute('aria-expanded', 'true');
    for (const [name, href] of [
      ['Explore', '/explore'], ['Engines', '/engines'], ['Profiles & dialects', '/language'],
      ['Schemas', '/language/schemas/application'], ['Examples', '/examples'], ['Workbench', '/workbench'],
      ['Pricing', '/pricing'], ['About', '/about'], ['Log in', '/login'], ['Sign up', '/register'],
    ] as const) {
      expect(within(mobile).getByRole('link', { name })).toHaveAttribute('href', href);
    }

    fireEvent.click(within(mobile).getByRole('link', { name: 'Pricing' }));
    expect(screen.queryByRole('navigation', { name: 'Mobile navigation' })).not.toBeInTheDocument();
  });

  it('shows the workspace entry points and account menu for signed-in users', () => {
    auth.user = member;
    renderHeader();

    expect(screen.getByRole('link', { name: 'Open workspace' })).toHaveAttribute('href', '/app');
    expect(screen.queryByRole('link', { name: 'Log in' })).not.toBeInTheDocument();

    const toggle = screen.getByRole('button', { name: 'Account menu' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');

    const menu = document.getElementById('public-account-menu') as HTMLElement;
    expect(within(menu).getByText('alice@example.com')).toBeInTheDocument();
    expect(within(menu).getByRole('link', { name: 'Workspace' })).toHaveAttribute('href', '/app');
    expect(within(menu).getByRole('link', { name: 'Account' })).toHaveAttribute('href', '/app/account');
    expect(within(menu).queryByRole('link', { name: 'Administration' })).not.toBeInTheDocument();

    fireEvent.click(within(menu).getByRole('button', { name: 'Log out' }));
    expect(auth.signOut).toHaveBeenCalledOnce();
  });

  it('keeps the administration entry for administrators only', () => {
    auth.user = { ...member, role: 'admin' };
    auth.isAdmin = true;
    renderHeader();

    fireEvent.click(screen.getByRole('button', { name: 'Account menu' }));
    expect(screen.getByRole('link', { name: 'Administration' })).toHaveAttribute('href', '/app/admin');
  });

  it('has no theme switch and does not touch theme state', () => {
    auth.user = member;
    renderHeader();
    fireEvent.click(screen.getByRole('button', { name: 'Account menu' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));

    expect(screen.queryByText(/dark|light|theme/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /mode|theme/i })).not.toBeInTheDocument();
    expect(document.documentElement).not.toHaveAttribute('data-theme');
    expect(localStorage.getItem('openbinding-theme')).toBeNull();
  });
});
