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

const PUBLIC_LINKS = [
  ['Home', '/'], ['Explore', '/explore'], ['Engines', '/engines'], ['Language', '/language'], ['Pricing', '/pricing'],
  ['Verify', '/verify'], ['About', '/about'], ['Log in', '/login'], ['Sign up', '/register'],
] as const;

function renderHeader(path = '/') {
  return render(<MemoryRouter initialEntries={[path]}><Navigation /></MemoryRouter>);
}

const labelsOf = (links: HTMLElement[]) => links.map((link) => [link.textContent?.replace('↗', '').trim(), link.getAttribute('href')]);

describe('Public header', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.user = null;
    auth.isAdmin = false;
  });

  // [utest->req~frontend-nav-public-navigation~1]
  it('lists the nine links in order with their addresses', () => {
    renderHeader();

    const nav = screen.getByRole('navigation', { name: 'Primary navigation' });
    const actions = [screen.getByRole('link', { name: 'Log in' }), screen.getByRole('link', { name: 'Sign up' })];
    expect(labelsOf([...within(nav).getAllByRole('link'), ...actions])).toEqual(PUBLIC_LINKS.map(([name, href]) => [name, href]));
    expect(screen.getByRole('link', { name: /OpenBinding home/i })).toHaveAttribute('href', '/');
  });

  // [utest->req~frontend-nav-public-navigation~1]
  it('has no menu and none of the links of the former header', () => {
    renderHeader();

    expect(screen.queryAllByRole('button').map((button) => button.getAttribute('aria-label'))).toEqual(['Open menu']);
    for (const name of ['Profiles & dialects', 'Schemas', 'Examples', 'Workbench']) {
      expect(screen.queryByRole('link', { name })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    }
  });

  // [utest->req~frontend-nav-public-navigation~1]
  it('marks the current page with aria-current', () => {
    renderHeader('/pricing');

    expect(screen.getByRole('link', { name: 'Pricing' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Explore' })).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('link', { name: 'Home' })).not.toHaveAttribute('aria-current');
  });

  // [utest->req~frontend-nav-public-navigation~1]
  it('marks Home only at the root and Language under the language hub', () => {
    const { unmount } = renderHeader('/');
    expect(screen.getByRole('link', { name: 'Home' })).toHaveAttribute('aria-current', 'page');
    unmount();

    renderHeader('/language/schemas/application');
    expect(screen.getByRole('link', { name: 'Language' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Home' })).not.toHaveAttribute('aria-current');
  });

  // [utest->req~frontend-nav-public-navigation~1]
  it('leaves aria-current on /explore/examples to the page and keeps the active style of Explore', () => {
    renderHeader('/explore/examples');

    const explore = screen.getByRole('link', { name: 'Explore' });
    expect(explore).not.toHaveAttribute('aria-current');
    expect(explore).toHaveClass('is-active');
  });

  it('keeps aria-current on Explore elsewhere under /explore', () => {
    renderHeader('/explore/engines');

    expect(screen.getByRole('link', { name: 'Explore' })).toHaveAttribute('aria-current', 'page');
  });

  it('closes open menus when pressing outside the header', () => {
    auth.user = member;
    renderHeader();

    const toggle = screen.getByRole('button', { name: 'Account menu' });
    fireEvent.click(toggle);
    fireEvent.pointerDown(screen.getByRole('link', { name: 'Workspace' }));
    expect(toggle).toHaveAttribute('aria-expanded', 'true');

    fireEvent.pointerDown(document.body);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });

  // [utest->req~frontend-nav-public-navigation~1]
  it('lists the same nine links in the phone menu and closes it after navigating', () => {
    renderHeader();

    const toggle = screen.getByRole('button', { name: 'Open menu' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('navigation', { name: 'Mobile navigation' })).not.toBeInTheDocument();

    fireEvent.click(toggle);
    const mobile = screen.getByRole('navigation', { name: 'Mobile navigation' });
    expect(screen.getByRole('button', { name: 'Close menu' })).toHaveAttribute('aria-expanded', 'true');
    expect(labelsOf(within(mobile).getAllByRole('link'))).toEqual(PUBLIC_LINKS.map(([name, href]) => [name, href]));

    fireEvent.click(within(mobile).getByRole('link', { name: 'Pricing' }));
    expect(screen.queryByRole('navigation', { name: 'Mobile navigation' })).not.toBeInTheDocument();
  });

  it('closes the phone menu with Escape and returns focus to its button', () => {
    renderHeader();

    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
    fireEvent.keyDown(within(screen.getByRole('navigation', { name: 'Mobile navigation' })).getByRole('link', { name: 'About' }), { key: 'Escape' });

    expect(screen.queryByRole('navigation', { name: 'Mobile navigation' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open menu' })).toHaveFocus();
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
