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
const hrefs = (scope: HTMLElement) => within(scope).getAllByRole('link')
  .map((link) => link.getAttribute('href'))
  .filter((href): href is string => href !== null);

describe('AppHeader', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.listNotifications.mockResolvedValue([]);
  });

  it('links the wordmark and the main navigation to the application screens', () => {
    renderHeader();

    expect(screen.getByRole('link', { name: 'OpenBinding home' })).toHaveAttribute('href', '/app');
    const nav = within(mainNav());
    expect(nav.getByRole('link', { name: 'Home' })).toHaveAttribute('href', '/app');
    expect(nav.getByRole('link', { name: 'Jobs' })).toHaveAttribute('href', '/app/jobs');
    expect(nav.getByRole('link', { name: 'Analysis' })).toHaveAttribute('href', '/app/analysis');
    expect(nav.getByRole('link', { name: 'Explore' })).toHaveAttribute('href', '/explore');
  });

  it('shows the organization and project as a context chip that leads to /app', () => {
    renderHeader();
    const chip = screen.getByTitle('Switch organization or project');
    expect(chip).toHaveTextContent('ISA Demo Group / QoS Benchmarks');
    expect(chip).toHaveAttribute('href', '/app');
    // The mobile menu repeats it.
    expect(within(mobileNav()).getByRole('link', { name: 'ISA Demo Group / QoS Benchmarks' })).toHaveAttribute('href', '/app');
  });

  it('marks the section of the current address', () => {
    const { unmount } = renderHeader(user, { path: '/app/isa-demo/qos/jobs' });
    expect(within(mainNav()).getByRole('link', { name: 'Jobs' })).toHaveAttribute('aria-current', 'page');
    expect(within(mainNav()).getByRole('link', { name: 'Home' })).not.toHaveAttribute('aria-current');
    unmount();

    renderHeader(user, { path: '/app/verifier' });
    expect(within(mainNav()).getByRole('button', { name: /Tools/ })).toHaveClass('is-active');
  });

  it.each([
    ['D1', '/app/system/states', null],
    ['D2', '/app/account/usage', null],
    ['D3', '/app/isa-demo/settings/members', 'Home'],
    ['D4', '/app/isa-demo/qos/cases', null],
    ['D5', '/app/isa-demo/qos/jobs/job-1', 'Jobs'],
    ['D6 analysis', '/app/analysis/workspace', 'Analysis'],
    ['D6 studies', '/app/isa-demo/qos/studies/engines-vs-seeds', null],
    ['D7', '/app/engines/registrations', 'Tools'],
    ['D8', '/app/admin/audit', 'Admin'],
  ] as const)('marks one entry of the main navigation for a screen of %s (%s)', (_domain, path, expected) => {
    renderHeader(adminUser, { path });

    const marked = within(mainNav()).getAllByRole('link').concat(within(mainNav()).getAllByRole('button', { name: /Tools/ }))
      .filter((item) => item.getAttribute('aria-current') === 'page' || item.classList.contains('is-active'))
      .map((item) => item.textContent?.trim().replace(/\s+/g, ' '));
    expect(marked).toEqual(expected ? [expected] : []);
  });

  it('opens the Tools menu with the keyboard and closes it with Escape, returning focus', () => {
    renderHeader();
    const tools = within(mainNav()).getByRole('button', { name: /Tools/ });
    expect(tools).toHaveAttribute('aria-expanded', 'false');

    tools.focus();
    fireEvent.click(tools);
    expect(tools).toHaveAttribute('aria-expanded', 'true');
    const menu = document.getElementById('app-tools-menu') as HTMLElement;
    expect(within(menu).getAllByRole('link').map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
      ['Verifier', '/app/verifier'],
      ['Engine catalog', '/engines'],
      ['My engines', '/app/engines/registrations'],
      ['Language extensions', '/app/language/extensions'],
      ['Generator lab', '/app/generator'],
      ['Language docs', '/language'],
    ]);

    within(menu).getByRole('link', { name: 'Verifier' }).focus();
    fireEvent.keyDown(within(menu).getByRole('link', { name: 'Verifier' }), { key: 'Escape' });
    expect(tools).toHaveAttribute('aria-expanded', 'false');
    expect(document.getElementById('app-tools-menu')).toBeNull();
    expect(tools).toHaveFocus();
  });

  it('lists what can be created from the New menu', () => {
    renderHeader();
    const toggle = screen.getByRole('button', { name: /^New/ });
    fireEvent.click(toggle);

    const menu = document.getElementById('app-new-menu') as HTMLElement;
    expect(within(menu).getAllByRole('link').map((link) => [link.firstChild?.textContent, link.getAttribute('href')])).toEqual([
      ['Organization', '/app/organizations/new'],
      ['Project', '/app/isa-demo/new-project'],
      ['Case', '/app/isa-demo/qos/cases'],
      ['Job', '/app/isa-demo/qos/jobs/new'],
      ['Study', '/app/isa-demo/qos/studies/new'],
      ['API key', '/app/account/keys/new'],
      ['Engine', '/app/engines/new'],
    ]);

    fireEvent.keyDown(within(menu).getAllByRole('link')[0], { key: 'Escape' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });

  it('disables the project items of the New menu when there is no project', () => {
    renderHeader(user, { withProject: false });
    fireEvent.click(screen.getByRole('button', { name: /^New/ }));

    const menu = document.getElementById('app-new-menu') as HTMLElement;
    expect(within(menu).queryByRole('link', { name: /^Job/ })).toBeNull();
    const disabled = menu.querySelectorAll('[aria-disabled="true"]');
    expect([...disabled].map((item) => item.firstChild?.textContent)).toEqual(['Case', 'Job', 'Study']);
    expect(within(menu).getByRole('link', { name: /^Project/ })).toHaveAttribute('href', '/app/isa-demo/new-project');
  });

  it('offers the Admin entry only to administrators', () => {
    const { unmount } = renderHeader(user);
    expect(within(mainNav()).queryByRole('link', { name: 'Admin' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Account menu' }));
    expect(screen.queryByRole('link', { name: 'Administration' })).toBeNull();
    unmount();

    renderHeader(adminUser);
    expect(within(mainNav()).getByRole('link', { name: 'Admin' })).toHaveAttribute('href', '/app/admin');
    fireEvent.click(screen.getByRole('button', { name: 'Account menu' }));
    expect(screen.getByRole('link', { name: 'Administration' })).toHaveAttribute('href', '/app/admin');
  });

  it('opens the account menu with the profile links and signs out', () => {
    renderHeader();
    const toggle = screen.getByRole('button', { name: 'Account menu' });
    expect(toggle).toHaveTextContent('AL');
    fireEvent.click(toggle);

    const menu = document.getElementById('app-account-menu') as HTMLElement;
    expect(within(menu).getByText('alice')).toBeInTheDocument();
    expect(within(menu).getByText('alice@example.com')).toBeInTheDocument();
    expect(within(menu).getAllByRole('link').map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
      ['Account', '/app/account'],
      ['Plan & permissions', '/app/account/usage'],
      ['API keys', '/app/account/keys'],
      ['Notifications', '/app/account/notifications'],
    ]);
    expect(within(menu).queryByText(/Institutional account/)).toBeNull();

    fireEvent.click(within(menu).getByRole('button', { name: 'Log out' }));
    expect(signOut).toHaveBeenCalledOnce();
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });

  it('closes an open menu when another menu is opened', () => {
    renderHeader();
    const tools = within(mainNav()).getByRole('button', { name: /Tools/ });
    fireEvent.click(tools);
    fireEvent.click(screen.getByRole('button', { name: 'Account menu' }));

    expect(tools).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('button', { name: 'Account menu' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('shows the unread count on the bell', async () => {
    api.listNotifications.mockResolvedValue([{
      id: 'n1', kind: 'info', subject: 'Job completed', body: 'Done', payload: {},
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

    it('carries the same destinations as the desktop navigation, Tools and New', () => {
      renderHeader(adminUser);
      const desktop = new Set([
        ...hrefs(mainNav()),
        ...toolsHrefs(),
        '/app/organizations/new', '/app/isa-demo/new-project', '/app/isa-demo/qos/cases',
        '/app/isa-demo/qos/jobs/new', '/app/isa-demo/qos/studies/new', '/app/account/keys/new', '/app/engines/new',
      ]);
      const mobile = new Set(hrefs(mobileNav()));

      for (const href of desktop) expect(mobile, href).toContain(href);
      expect(within(mobileNav()).getByRole('button', { name: 'Search' })).toBeInTheDocument();
    });

    it('closes after following a link', () => {
      renderHeader();
      fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
      fireEvent.click(within(mobileNav()).getByRole('link', { name: 'Jobs' }));
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

function toolsHrefs() {
  fireEvent.click(within(mainNav()).getByRole('button', { name: /Tools/ }));
  const menu = document.getElementById('app-tools-menu') as HTMLElement;
  const found = hrefs(menu);
  fireEvent.click(within(mainNav()).getByRole('button', { name: /Tools/ }));
  return found;
}
