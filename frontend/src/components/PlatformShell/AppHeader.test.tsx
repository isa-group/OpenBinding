import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserProfile } from '../../api/auth';
import type { Organization } from '../../api/platform';
import { AuthContext } from '../../modules/auth/hooks/useAuth';
import { AppHeader } from './AppHeader';

const api = vi.hoisted(() => ({
  listNotifications: vi.fn(),
  markNotificationRead: vi.fn(),
  markAllNotificationsRead: vi.fn(),
}));

vi.mock('../../api/client', async () => ({
  ...(await vi.importActual<typeof import('../../api/client')>('../../api/client')),
  apiClient: api,
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
const adminUser: UserProfile = { ...user, role: 'admin' };
const researchUser: UserProfile = { ...user, plan: 'RESEARCH' };

const organization: Organization = {
  id: 'org-1',
  name: 'ISA Demo Group',
  slug: 'isa-demo',
  parent_id: null,
  effective_role: 'OWNER',
  created_at: '2026-01-01T00:00:00Z',
};

const signOut = vi.fn();

function renderHeader(
  currentUser: UserProfile = user,
  { path = '/app', withOrganization = true }: { path?: string; withOrganization?: boolean } = {}
) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthContext.Provider
        value={{
          user: currentUser,
          loading: false,
          signIn: vi.fn(),
          register: vi.fn(),
          signOut,
          refresh: vi.fn(),
          isAdmin: currentUser.role === 'admin',
          fetchWithInterceptor: vi.fn(),
        }}
      >
        <AppHeader
          organizations={[organization]}
          organization={withOrganization ? organization : undefined}
        />
      </AuthContext.Provider>
    </MemoryRouter>
  );
}

const mainNav = () => screen.getByRole('navigation', { name: 'Main' });
const mobileNav = () => screen.getByRole('navigation', { name: 'Mobile navigation' });
const newToggle = () => screen.getByRole('button', { name: /^New/ });
/** The entries of a header scope in document order: links by name and address, disabled entries by name and hint. */
const entriesOf = (scope: HTMLElement) =>
  [...scope.querySelectorAll<HTMLElement>('a[href], [aria-disabled="true"]')].map(item => {
    if (item.hasAttribute('href')) return [item.textContent, item.getAttribute('href')];
    const hint = document.getElementById(item.getAttribute('aria-describedby') ?? '');
    return [item.textContent, `disabled: ${hint?.textContent}`];
  });

describe('AppHeader', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.listNotifications.mockResolvedValue([]);
  });

  it('lists Home, Compositions, Problems, Runs, Studies, Engines and, for an administrator, Admin, in this order', () => {
    renderHeader(adminUser, { path: '/app/isa-demo/problems' });

    expect(screen.getByRole('link', { name: 'OpenBinding home' })).toHaveAttribute('href', '/app');
    const items = [...mainNav().children].map(item => item.textContent?.trim());
    expect(items).toEqual([
      'Home',
      'Compositions',
      'Problems',
      'Runs',
      'Studies',
      'Engines',
      'Admin',
    ]);
    const nav = within(mainNav());
    expect(nav.getByRole('link', { name: 'Home' })).toHaveAttribute('href', '/app');
    expect(nav.getByRole('link', { name: 'Compositions' })).toHaveAttribute(
      'href',
      '/app/isa-demo/compositions'
    );
    expect(nav.getByRole('link', { name: 'Problems' })).toHaveAttribute(
      'href',
      '/app/isa-demo/problems'
    );
    expect(nav.getByRole('link', { name: 'Runs' })).toHaveAttribute('href', '/app/isa-demo/runs');
    expect(nav.getByRole('link', { name: 'Studies' })).toHaveAttribute(
      'href',
      '/app/isa-demo/studies'
    );
    expect(nav.getByRole('link', { name: 'Engines' })).toHaveAttribute('href', '/engines');
    expect(nav.getByRole('link', { name: 'Admin' })).toHaveAttribute('href', '/app/admin');
  });

  it('offers the Admin entry only to administrators, and no Administration link in the account menu', () => {
    const { unmount } = renderHeader(user);
    expect(within(mainNav()).queryByRole('link', { name: 'Admin' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Admin' })).toBeNull();
    unmount();

    renderHeader(adminUser);
    expect(within(mainNav()).getByRole('link', { name: 'Admin' })).toHaveAttribute(
      'href',
      '/app/admin'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Account menu' }));
    expect(screen.queryByRole('link', { name: 'Administration' })).toBeNull();
  });

  it('has none of the former entries', () => {
    renderHeader(adminUser);

    for (const name of [
      'Jobs',
      'Explore',
      'Tools',
      'Verifier',
      'Engine catalog',
      'Analysis',
      'Lab',
      'Projects',
    ]) {
      expect(screen.queryByRole('link', { name })).toBeNull();
      expect(screen.queryByRole('button', { name })).toBeNull();
    }
    const retired = screen
      .getAllByRole('link')
      .filter(link => (link.getAttribute('href') ?? '').startsWith('/app/analysis'));
    expect(retired).toEqual([]);
  });

  it('disables Problems with the hint "Needs an organization" without one', () => {
    renderHeader(user, { withOrganization: false });

    const problems = within(mainNav()).getByText('Problems');
    expect(problems).toHaveAttribute('role', 'link');
    expect(problems).toHaveAttribute('aria-disabled', 'true');
    expect(problems).not.toHaveAttribute('href');
    expect(problems).toHaveAccessibleDescription('Needs an organization');
  });

  it('disables Runs and Studies with the hint "Needs an organization" without one', () => {
    renderHeader(user, { withOrganization: false });

    for (const name of ['Runs', 'Studies']) {
      const entry = within(mainNav()).getByText(name);
      expect(entry).toHaveAttribute('aria-disabled', 'true');
      expect(entry).not.toHaveAttribute('href');
      expect(entry).toHaveAccessibleDescription('Needs an organization');
    }
  });

  it('shows the organization as a context chip that leads to /app', () => {
    renderHeader();
    const chip = screen.getByTitle('Switch organization');
    expect(chip).toHaveTextContent('ISA Demo Group');
    expect(chip).toHaveAttribute('href', '/app');
    // The mobile menu repeats it.
    expect(within(mobileNav()).getByRole('link', { name: 'ISA Demo Group' })).toHaveAttribute(
      'href',
      '/app'
    );
  });

  it.each([
    ['/app', 'Home'],
    ['/app/isa-demo/settings/members', 'Home'],
    ['/app/isa-demo/compositions/order-desk', 'Compositions'],
    ['/app/isa-demo/problems', 'Problems'],
    ['/app/isa-demo/problem-editor', 'Problems'],
    ['/app/isa-demo/runs/job-1', 'Runs'],
    ['/app/isa-demo/studies/engines-vs-seeds', 'Studies'],
    ['/app/engines/registrations', 'Engines'],
    ['/app/admin/moderation', 'Admin'],
    ['/app/isa-demo/qos', null],
    ['/app/account/usage', null],
  ] as const)('marks one entry of the header for %s: %s', (path, expected) => {
    renderHeader(adminUser, { path });

    const marked = [...mainNav().querySelectorAll<HTMLElement>('a, button')]
      .filter(
        item => item.getAttribute('aria-current') === 'page' || item.classList.contains('is-active')
      )
      .map(item => item.textContent?.trim());
    expect(marked).toEqual(expected ? [expected] : []);
  });

  it('lists Composition, Problem, Study and Run in the organization from the New menu', () => {
    renderHeader();
    const toggle = newToggle();
    fireEvent.click(toggle);

    const menu = document.getElementById('app-new-menu') as HTMLElement;
    expect(entriesOf(menu)).toEqual([
      ['Composition', '/app/isa-demo/compositions?create=composition'],
      ['Problem', '/app/isa-demo/problems?create=problem'],
      ['Study', '/app/isa-demo/studies/new'],
      ['Run', '/app/isa-demo/runs/new'],
    ]);

    fireEvent.keyDown(within(menu).getAllByRole('link')[0], { key: 'Escape' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });

  it('has none of the former New items', () => {
    renderHeader();
    fireEvent.click(newToggle());

    const menu = document.getElementById('app-new-menu') as HTMLElement;
    for (const former of ['Organization', 'Project', 'Case', 'Job', 'API key', 'Engine']) {
      expect(within(menu).queryByRole('link', { name: former })).toBeNull();
    }
  });

  it('opens the account menu with the five sections then Sign out', () => {
    renderHeader();
    const toggle = screen.getByRole('button', { name: 'Account menu' });
    expect(toggle).toHaveTextContent('AL');
    fireEvent.click(toggle);

    const menu = document.getElementById('app-account-menu') as HTMLElement;
    expect(within(menu).getByText('alice')).toBeInTheDocument();
    expect(within(menu).getByText('alice@example.com')).toBeInTheDocument();
    expect(entriesOf(menu)).toEqual([
      ['Profile', '/app/account'],
      ['Plan', '/app/account/usage'],
      ['API keys', '/app/account/keys'],
      ['Identities', '/app/account/identities'],
      ['Notifications', '/app/account/notifications'],
    ]);
    const last = [...menu.querySelectorAll('a, button')].at(-1);
    expect(last).toHaveTextContent('Sign out');
    for (const former of ['Account', 'Plan & permissions', 'Log out'])
      expect(within(menu).queryByText(former)).toBeNull();
    expect(within(menu).queryByText(/Institutional account/)).toBeNull();

    fireEvent.click(within(menu).getByRole('button', { name: 'Sign out' }));
    expect(signOut).toHaveBeenCalledOnce();
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });

  it('closes an open menu when another menu is opened', () => {
    renderHeader();
    const create = newToggle();
    fireEvent.click(create);
    fireEvent.click(screen.getByRole('button', { name: 'Account menu' }));

    expect(create).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('button', { name: 'Account menu' })).toHaveAttribute(
      'aria-expanded',
      'true'
    );
  });

  it('shows the unread count on the bell', async () => {
    api.listNotifications.mockResolvedValue([
      {
        id: 'n1',
        kind: 'info',
        subject: 'Run completed',
        body: 'Done',
        payload: {},
        read_at: null,
        created_at: new Date().toISOString(),
      },
    ]);
    renderHeader();

    const bell = await screen.findByRole('button', { name: '1 unread notifications' });
    expect(bell.querySelector('.notification-badge')).toHaveTextContent('1');
  });

  it('opens the command palette from the search button', () => {
    renderHeader();
    fireEvent.click(screen.getByRole('button', { name: /Open command palette/ }));
    expect(screen.getByRole('dialog', { name: 'Command palette' })).toBeInTheDocument();
  });

  describe('mobile menu', () => {
    it('is collapsed by default and toggles with aria-expanded', () => {
      renderHeader();
      const toggle = screen.getByRole('button', { name: 'Open menu' });
      expect(toggle).toHaveAttribute('aria-expanded', 'false');
      expect(mobileNav()).not.toHaveClass('is-open');

      fireEvent.click(toggle);
      const close = screen.getByRole('button', { name: 'Close menu' });
      expect(close).toHaveAttribute('aria-expanded', 'true');
      expect(mobileNav()).toHaveClass('is-open');

      fireEvent.keyDown(within(mobileNav()).getByRole('link', { name: 'Home' }), { key: 'Escape' });
      expect(mobileNav()).not.toHaveClass('is-open');
      expect(screen.getByRole('button', { name: 'Open menu' })).toHaveFocus();
    });

    it('mirrors the entries of the desktop header and the New menu', () => {
      renderHeader(adminUser);

      expect(entriesOf(mobileNav())).toEqual([
        ['ISA Demo Group', '/app'],
        ['Home', '/app'],
        ['Compositions', '/app/isa-demo/compositions'],
        ['Problems', '/app/isa-demo/problems'],
        ['Runs', '/app/isa-demo/runs'],
        ['Studies', '/app/isa-demo/studies'],
        ['Engines', '/engines'],
        ['Admin', '/app/admin'],
        ['Composition', '/app/isa-demo/compositions?create=composition'],
        ['Problem', '/app/isa-demo/problems?create=problem'],
        ['Study', '/app/isa-demo/studies/new'],
        ['Run', '/app/isa-demo/runs/new'],
      ]);
      expect(within(mobileNav()).getByRole('button', { name: 'Search' })).toBeInTheDocument();
    });

    it('disables the organization entries with their hint when there is no organization, with ids of their own', () => {
      renderHeader(user, { withOrganization: false });

      const disabled = [...document.querySelectorAll<HTMLElement>('[aria-disabled="true"]')];
      // Problems, Runs, Studies and the New items, in the header menus and in the phone menu.
      expect(disabled.length).toBeGreaterThanOrEqual(2);
      const hints = disabled.map(item => item.getAttribute('aria-describedby'));
      expect(new Set(hints).size).toBe(hints.length);
      for (const item of disabled)
        expect(item).toHaveAccessibleDescription('Needs an organization');
    });

    it('closes after following a link', () => {
      renderHeader();
      fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
      fireEvent.click(within(mobileNav()).getByRole('link', { name: 'Engines' }));
      expect(mobileNav()).not.toHaveClass('is-open');
    });
  });

  describe('institutional co-brand', () => {
    const mark = { name: 'Universidad de Sevilla' };

    it('shows nothing for ordinary accounts', () => {
      renderHeader(user);
      fireEvent.click(screen.getByRole('button', { name: 'Account menu' }));
      expect(screen.queryByRole('img', mark)).toBeNull();
      expect(screen.queryByText(/Institutional account/)).toBeNull();
    });

    it('puts the compact mark inside the brand link and the chip in the account menu', () => {
      renderHeader(researchUser);

      const brand = screen.getByRole('link', { name: 'OpenBinding home' });
      expect(within(brand).getByRole('img', mark)).toHaveAttribute('src', '/brands/us-fama.png');

      fireEvent.click(screen.getByRole('button', { name: 'Account menu' }));
      const menu = document.getElementById('app-account-menu') as HTMLElement;
      expect(
        within(menu).getByText('Universidad de Sevilla · Institutional account')
      ).toBeInTheDocument();

      expect(within(mobileNav()).getByRole('link', mark)).toHaveAttribute(
        'href',
        'https://www.us.es'
      );
    });
  });
});
