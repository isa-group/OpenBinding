import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useOutletContext } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserProfile } from '../../api/auth';
import { AuthContext } from '../../contexts/auth';
import { PlatformShell, type PlatformOutletContext } from './PlatformShell';
import { platformApi, type Organization, type Project } from '../../api/platform';

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

const organization = (id: string, slug: string, name: string): Organization => ({
  id,
  name,
  slug,
  parent_id: null,
  billing_sponsor_user_id: 'user-1',
  effective_role: 'OWNER',
  created_at: '2026-01-01T00:00:00Z',
});

const project = (id: string, organizationId: string, slug: string, name: string): Project => ({
  id,
  organization_id: organizationId,
  slug,
  name,
  description: '',
  visibility: 'private',
  created_by_id: 'user-1',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
});

/** Shows what the layout hands to a screen through the outlet context. */
function ContextProbe() {
  const context = useOutletContext<PlatformOutletContext>();
  return (
    <section aria-label="Screen">
      <output data-testid="organizations">{context.organizations.map((item) => item.slug).join(',')}</output>
      <output data-testid="projects">{context.projects.map((item) => item.slug).join(',')}</output>
      <output data-testid="organization">{context.organization?.slug ?? 'none'}</output>
      <output data-testid="project">{context.project?.slug ?? 'none'}</output>
      <output data-testid="loading">{String(context.loading)}</output>
      <button type="button" onClick={() => void context.reload()}>Reload</button>
    </section>
  );
}

function renderShell(currentUser: UserProfile, initialPath = '/app') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
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
        <Routes>
          <Route element={<PlatformShell />}>
            <Route path="/app/*" element={<ContextProbe />} />
          </Route>
        </Routes>
      </AuthContext.Provider>
    </MemoryRouter>,
  );
}

const ready = () => waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));

describe('PlatformShell (application layout)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(platformApi.organizations).mockResolvedValue([
      organization('org-1', 'test-org', 'Test Org'),
      organization('org-2', 'other-org', 'Other Org'),
    ]);
    vi.mocked(platformApi.projects).mockImplementation(async (slug: string) => (
      slug === 'other-org'
        ? [project('project-3', 'org-2', 'delta', 'Delta')]
        : [project('project-1', 'org-1', 'atlas', 'Atlas'), project('project-2', 'org-1', 'borealis', 'Borealis')]
    ));
  });

  it('renders the application header, the screen and the site footer', async () => {
    renderShell(user);
    await ready();

    expect(screen.getByRole('banner')).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Screen' })).toBeInTheDocument();
    expect(screen.getByRole('contentinfo')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Skip to workspace' })).toHaveAttribute('href', '#platform-main');
    expect(document.getElementById('platform-main')).toContainElement(screen.getByRole('region', { name: 'Screen' }));
  });

  it('keeps the outlet context contract: first organization and project by default', async () => {
    renderShell(user, '/app');
    await ready();

    expect(screen.getByTestId('organizations')).toHaveTextContent('test-org,other-org');
    expect(screen.getByTestId('organization')).toHaveTextContent('test-org');
    expect(screen.getByTestId('projects')).toHaveTextContent('atlas,borealis');
    expect(screen.getByTestId('project')).toHaveTextContent('atlas');
    expect(platformApi.projects).toHaveBeenCalledWith('test-org');
  });

  it('selects the organization and project named by the address', async () => {
    renderShell(user, '/app/other-org/delta/cases');
    await ready();

    expect(screen.getByTestId('organization')).toHaveTextContent('other-org');
    expect(screen.getByTestId('projects')).toHaveTextContent('delta');
    expect(screen.getByTestId('project')).toHaveTextContent('delta');
    expect(platformApi.projects).toHaveBeenCalledWith('other-org');
    expect(screen.getByTitle('Switch organization or project')).toHaveTextContent('Other Org / Delta');
  });

  it('falls back to the first project when the address names an organization section', async () => {
    renderShell(user, '/app/test-org/settings/members');
    await ready();

    expect(screen.getByTestId('organization')).toHaveTextContent('test-org');
    expect(screen.getByTestId('project')).toHaveTextContent('atlas');
  });

  it.each(['/app/verifier', '/app/engines/registrations', '/app/jobs','/app/language/extensions', '/app/system/states'])(
    'does not mistake the fixed screen %s for an organization',
    async (path) => {
      renderShell(user, path);
      await ready();

      expect(platformApi.projects).toHaveBeenCalledOnce();
      expect(platformApi.projects).toHaveBeenCalledWith('test-org');
      expect(screen.getByTestId('organization')).toHaveTextContent('test-org');
    },
  );

  it('reloads the workspace on request', async () => {
    renderShell(user);
    await ready();
    expect(platformApi.organizations).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect(platformApi.organizations).toHaveBeenCalledTimes(2));
  });

  it('hands an empty workspace to the screen when the account has no organization', async () => {
    vi.mocked(platformApi.organizations).mockResolvedValue([]);
    renderShell(user);
    await ready();

    expect(screen.getByTestId('organization')).toHaveTextContent('none');
    expect(screen.getByTestId('project')).toHaveTextContent('none');
    expect(platformApi.projects).not.toHaveBeenCalled();
    expect(screen.queryByTitle('Switch organization or project')).toBeNull();
  });

  it('reports a workspace that cannot be loaded', async () => {
    vi.mocked(platformApi.organizations).mockRejectedValue(new Error('Gateway unavailable'));
    renderShell(user);

    expect(await screen.findByRole('alert')).toHaveTextContent('Gateway unavailable');
    await ready();
  });

  it('offers the account entries in the account menu and no theme switch', async () => {
    renderShell(user);
    await ready();

    fireEvent.click(screen.getByRole('button', { name: 'Account menu' }));
    const menu = document.getElementById('app-account-menu') as HTMLElement;
    expect(within(menu).getByRole('link', { name: 'Account' })).toHaveAttribute('href', '/app/account');
    expect(menu.textContent).not.toMatch(/theme|dark|light/i);
    expect(document.documentElement).not.toHaveAttribute('data-theme');
  });

  it('shows the administration entries only to administrators', async () => {
    const { unmount } = renderShell(user);
    await ready();
    expect(screen.queryByRole('link', { name: /^Admin/ })).toBeNull();
    unmount();

    renderShell(adminUser);
    await ready();
    // Desktop navigation and mobile menu.
    const adminLinks = screen.getAllByRole('link', { name: 'Admin' });
    expect(adminLinks).toHaveLength(2);
    for (const link of adminLinks) expect(link).toHaveAttribute('href', '/app/admin');
  });

  it('does not offer the retired sidebar or direct links to the old public routes', async () => {
    renderShell(user);
    await ready();

    expect(screen.queryByRole('navigation', { name: /Workspace navigation/i })).toBeNull();
    for (const retired of ['/schemas', '/profiles', '/playground', '/app/workbench', '/team', '/changelog']) {
      expect(document.querySelector(`a[href="${retired}"]`), retired).toBeNull();
    }
  });
});
