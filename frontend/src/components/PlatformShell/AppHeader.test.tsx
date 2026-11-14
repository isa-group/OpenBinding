import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserProfile } from '../../api/auth';
import type { Organization, Project } from '../../api/platform';
import { AuthContext } from '../../contexts/auth';
import { AppHeader } from './AppHeader';

const api = vi.hoisted(() => ({
  listNotifications: vi.fn(),
  markNotificationRead: vi.fn(),
  markAllNotificationsRead: vi.fn(),
}));

vi.mock('../../api/client', async () => ({
  ...await vi.importActual<typeof import('../../api/client')>('../../api/client'),
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
  id: 'org-1', name: 'ISA Demo Group', slug: 'isa-demo', parent_id: null,
  billing_sponsor_user_id: 'user-1', effective_role: 'OWNER', created_at: '2026-01-01T00:00:00Z',
};
const project: Project = {
  id: 'project-1', organization_id: 'org-1', slug: 'qos', name: 'QoS Benchmarks', description: '',
  visibility: 'private', created_by_id: 'user-1', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
};

const signOut = vi.fn();

function renderHeader(
  currentUser: UserProfile = user,
  { path = '/app', withProject = true }: { path?: string; withProject?: boolean } = {},
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
        }}
      >
        <AppHeader
          organizations={[organization]}
          projects={withProject ? [project] : []}
          organization={organization}
          project={withProject ? project : undefined}
        />
      </AuthContext.Provider>
    </MemoryRouter>,
  );
}

const mainNav = () => screen.getByRole('navigation', { name: 'Main' });
const mobileNav = () => screen.getByRole('navigation', { name: 'Mobile navigation' });
const labToggle = () => within(mainNav()).getByRole('button', { name: /^Lab/ });
const newToggle = () => screen.getByRole('button', { name: /^New/ });
/** The entries of a header scope in document order: links by name and address, disabled entries by name and hint. */
const entriesOf = (scope: HTMLElement) => [...scope.querySelectorAll<HTMLElement>('a[href], [aria-disabled="true"]')].map((item) => {
  if (item.hasAttribute('href')) return [item.textContent, item.getAttribute('href')];
  const hint = document.getElementById(item.getAttribute('aria-describedby') ?? '');
  return [item.textContent, `disabled: ${hint?.textContent}`];
});

describe('AppHeader', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.listNotifications.mockResolvedValue([]);
  });

  it('lists Home, Problems, Lab, Engines and, for an administrator, Admin, in this order', () => {
    renderHeader(adminUser, { path: '/app/isa-demo/qos/problems' });

    expect(screen.getByRole('link', { name: 'OpenBinding home' })).toHaveAttribute('href', '/app');
    const items = [...mainNav().children].map((item) => item.textContent?.trim());
    expect(items).toEqual(['Home', 'Problems', 'Lab', 'Engines', 'Admin']);
    const nav = within(mainNav());
    expect(nav.getByRole('link', { name: 'Home' })).toHaveAttribute('href', '/app');
    expect(nav.getByRole('link', { name: 'Problems' })).toHaveAttribute('href', '/app/isa-demo/qos/problems');
    expect(nav.getByRole('link', { name: 'Engines' })).toHaveAttribute('href', '/engines');
    expect(nav.getByRole('link', { name: 'Admin' })).toHaveAttribute('href', '/app/admin');
  });

  it('offers the Admin entry only to administrators, and no Administration link in the account menu', () => {
    const { unmount } = renderHeader(user);
    expect(within(mainNav()).queryByRole('link', { name: 'Admin' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Admin' })).toBeNull();
    unmount();

    renderHeader(adminUser);
    expect(within(mainNav()).getByRole('link', { name: 'Admin' })).toHaveAttribute('href', '/app/admin');
    fireEvent.click(screen.getByRole('button', { name: 'Account menu' }));
    expect(screen.queryByRole('link', { name: 'Administration' })).toBeNull();
  });

  it('has none of the former entries', () => {
    renderHeader(adminUser);

    for (const name of ['Jobs', 'Explore', 'Tools', 'Verifier', 'Engine catalog', 'Analysis']) {
      expect(screen.queryByRole('link', { name })).toBeNull();
      expect(screen.queryByRole('button', { name })).toBeNull();
    }
    const retired = screen.getAllByRole('link').filter((link) => (link.getAttribute('href') ?? '').startsWith('/app/analysis'));
    expect(retired).toEqual([]);
  });

  it('opens the Lab menu with Runs, Studies and Generator, and closes it with Escape, returning focus', () => {
    renderHeader(user);
    const toggle = labToggle();
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    toggle.focus();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const menu = document.getElementById('app-lab-menu') as HTMLElement;
    expect(entriesOf(menu)).toEqual([['Runs', '/app/runs'], ['Studies', '/app/isa-demo/qos/studies'], ['Generator', '/app/generator']]);

    within(menu).getByRole('link', { name: 'Runs' }).focus();
    fireEvent.keyDown(within(menu).getByRole('link', { name: 'Runs' }), { key: 'Escape' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(document.getElementById('app-lab-menu')).toBeNull();
    expect(toggle).toHaveFocus();
  });

  it('disables Problems and Studies with the hint "Needs a project" and keeps Runs and Generator without a project', () => {
    renderHeader(user, { withProject: false });

    const problems = within(mainNav()).getByText('Problems');
    expect(problems).toHaveAttribute('role', 'link');
    expect(problems).toHaveAttribute('aria-disabled', 'true');
    expect(problems).not.toHaveAttribute('href');
    expect(problems).toHaveAccessibleDescription('Needs a project');

    fireEvent.click(labToggle());
    const menu = document.getElementById('app-lab-menu') as HTMLElement;
    const studies = within(menu).getByText('Studies');
    expect(studies).toHaveAttribute('aria-disabled', 'true');
    expect(studies).not.toHaveAttribute('href');
    expect(studies).toHaveAccessibleDescription('Needs a project');
    expect(within(menu).getByRole('link', { name: 'Runs' })).toHaveAttribute('href', '/app/runs');
    expect(within(menu).getByRole('link', { name: 'Generator' })).toHaveAttribute('href', '/app/generator');
  });

  it('shows the organization and project as a context chip that leads to /app', () => {
    renderHeader();
    const chip = screen.getByTitle('Switch organization or project');
    expect(chip).toHaveTextContent('ISA Demo Group / QoS Benchmarks');
    expect(chip).toHaveAttribute('href', '/app');
    // The mobile menu repeats it.
    expect(within(mobileNav()).getByRole('link', { name: 'ISA Demo Group / QoS Benchmarks' })).toHaveAttribute('href', '/app');
  });

  it.each([
    ['/app', 'Home'],
    ['/app/isa-demo/settings/members', 'Home'],
    ['/app/isa-demo/qos/problems', 'Problems'],
    ['/app/isa-demo/qos/runs/job-1', 'Lab'],
    ['/app/isa-demo/qos/studies/engines-vs-seeds', 'Lab'],
    ['/app/generator', 'Lab'],
    ['/app/engines/registrations', 'Engines'],
    ['/app/admin/moderation', 'Admin'],
    ['/app/isa-demo/qos/published', null],
    ['/app/account/usage', null],
  ] as const)('marks one entry of the header for %s: %s', (path, expected) => {
    renderHeader(adminUser, { path });

    const marked = [...mainNav().querySelectorAll<HTMLElement>('a, button')]
      .filter((item) => item.getAttribute('aria-current') === 'page' || item.classList.contains('is-active'))
      .map((item) => item.textContent?.trim());
    expect(marked).toEqual(expected ? [expected] : []);
  });

  it('marks the entry of the Lab menu that matches the address', () => {
    renderHeader(user, { path: '/app/isa-demo/qos/studies' });
    fireEvent.click(labToggle());

    const menu = document.getElementById('app-lab-menu') as HTMLElement;
    expect(within(menu).getByRole('link', { name: 'Studies' })).toHaveAttribute('aria-current', 'page');
    expect(within(menu).getByRole('link', { name: 'Runs' })).not.toHaveAttribute('aria-current');
  });

  it('lists Problem, Collection, Study and Run in the current project from the New menu', () => {
    renderHeader();
    const toggle = newToggle();
    fireEvent.click(toggle);

    const menu = document.getElementById('app-new-menu') as HTMLElement;
    expect(entriesOf(menu)).toEqual([
      ['Problem', '/app/isa-demo/qos/problems?create=problem'],
      ['Collection', '/app/isa-demo/qos/collections?create=collection'],
      ['Study', '/app/isa-demo/qos/studies/new'],
      ['Run', '/app/isa-demo/qos/runs/new'],
    ]);

    fireEvent.keyDown(within(menu).getAllByRole('link')[0], { key: 'Escape' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });

  it('disables the four items of the New menu with the hint "Needs a project" when there is no project', () => {
    renderHeader(user, { withProject: false });
    fireEvent.click(newToggle());

    const menu = document.getElementById('app-new-menu') as HTMLElement;
    expect(within(menu).queryAllByRole('link', { hidden: false }).filter((link) => link.hasAttribute('href'))).toEqual([]);
    expect(entriesOf(menu)).toEqual([
      ['Problem', 'disabled: Needs a project'], ['Collection', 'disabled: Needs a project'],
      ['Study', 'disabled: Needs a project'], ['Run', 'disabled: Needs a project'],
    ]);
    for (const item of menu.querySelectorAll('[aria-disabled="true"]')) expect(item).toHaveAccessibleDescription('Needs a project');
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
    for (const former of ['Account', 'Plan & permissions', 'Log out']) expect(within(menu).queryByText(former)).toBeNull();
    expect(within(menu).queryByText(/Institutional account/)).toBeNull();

    fireEvent.click(within(menu).getByRole('button', { name: 'Sign out' }));
    expect(signOut).toHaveBeenCalledOnce();
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });

  it('closes an open menu when another menu is opened', () => {
    renderHeader();
    const lab = labToggle();
    fireEvent.click(lab);
    fireEvent.click(screen.getByRole('button', { name: 'Account menu' }));

    expect(lab).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('button', { name: 'Account menu' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('shows the unread count on the bell', async () => {
    api.listNotifications.mockResolvedValue([{
      id: 'n1', kind: 'info', subject: 'Run completed', body: 'Done', payload: {},
      read_at: null, created_at: new Date().toISOString(),
    }]);
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

    it('mirrors the entries of the desktop header, the Lab menu and the New menu', () => {
      renderHeader(adminUser);

      expect(entriesOf(mobileNav())).toEqual([
        ['ISA Demo Group / QoS Benchmarks', '/app'],
        ['Home', '/app'], ['Problems', '/app/isa-demo/qos/problems'],
        ['Runs', '/app/runs'], ['Studies', '/app/isa-demo/qos/studies'], ['Generator', '/app/generator'],
        ['Engines', '/engines'], ['Admin', '/app/admin'],
        ['Problem', '/app/isa-demo/qos/problems?create=problem'], ['Collection', '/app/isa-demo/qos/collections?create=collection'],
        ['Study', '/app/isa-demo/qos/studies/new'], ['Run', '/app/isa-demo/qos/runs/new'],
      ]);
      expect(within(mobileNav()).getByRole('button', { name: 'Search' })).toBeInTheDocument();
    });

    it('disables the project entries with their hint when there is no project, with ids of their own', () => {
      renderHeader(user, { withProject: false });

      const disabled = [...document.querySelectorAll<HTMLElement>('[aria-disabled="true"]')];
      // Problems in the header and in the phone menu, Studies and the four New items in the phone menu.
      expect(disabled.length).toBeGreaterThanOrEqual(6);
      const hints = disabled.map((item) => item.getAttribute('aria-describedby'));
      expect(new Set(hints).size).toBe(hints.length);
      for (const item of disabled) expect(item).toHaveAccessibleDescription('Needs a project');
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
      expect(within(menu).getByText('Universidad de Sevilla · Institutional account')).toBeInTheDocument();

      expect(within(mobileNav()).getByRole('link', mark)).toHaveAttribute('href', 'https://www.us.es');
    });
  });
});
