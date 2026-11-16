import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useOutletContext } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserProfile } from '../../api/auth';
import { AuthContext } from '../../modules/auth/hooks/useAuth';
import { PlatformShell, type PlatformOutletContext } from './PlatformShell';
import { buildCommands } from './paletteCommands';
import { platformApi, type Organization } from '../../api/platform';
import { routeDefinitions } from '../../routes/registry';

vi.mock('../../api/platform', async () => ({
  ...(await vi.importActual<typeof import('../../api/platform')>('../../api/platform')),
  platformApi: {
    organizations: vi.fn(),
  },
}));

/**
 * One address for each fixed first segment under /app that the registry answers with something other than an organization: the
 * screens. A segment that is a `:param` names an organization and is not listed.
 */
const FIXED_ADDRESSES = [
  ...new Map(
    routeDefinitions.flatMap(route => {
      const [, root, first] = route.path.split('/');
      const address = route.path.replace(/\/:[A-Za-z]+\?/g, '').replace(/:[A-Za-z]+/g, 'sample');
      return root === 'app' && first && !first.startsWith(':') ? [[first, address] as const] : [];
    })
  ).values(),
];

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
  effective_role: 'OWNER',
  created_at: '2026-01-01T00:00:00Z',
});

/** Shows what the layout hands to a screen through the outlet context. */
function ContextProbe() {
  const context = useOutletContext<PlatformOutletContext>();
  return (
    <section aria-label="Screen">
      <output data-testid="organizations">
        {context.organizations.map(item => item.slug).join(',')}
      </output>
      <output data-testid="organization">{context.organization?.slug ?? 'none'}</output>
      <output data-testid="loading">{String(context.loading)}</output>
      <button type="button" onClick={() => void context.reload()}>
        Reload
      </button>
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
          fetchWithInterceptor: vi.fn(),
        }}
      >
        <Routes>
          <Route element={<PlatformShell />}>
            <Route path="/app/*" element={<ContextProbe />} />
          </Route>
        </Routes>
      </AuthContext.Provider>
    </MemoryRouter>
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
  });

  it('renders the application header, the screen and the site footer', async () => {
    renderShell(user);
    await ready();

    expect(screen.getByRole('banner')).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Screen' })).toBeInTheDocument();
    expect(screen.getByRole('contentinfo')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Skip to workspace' })).toHaveAttribute(
      'href',
      '#platform-main'
    );
    expect(document.getElementById('platform-main')).toContainElement(
      screen.getByRole('region', { name: 'Screen' })
    );
  });

  it('keeps the outlet context contract: the organizations, and the first one by default', async () => {
    renderShell(user, '/app');
    await ready();

    expect(screen.getByTestId('organizations')).toHaveTextContent('test-org,other-org');
    expect(screen.getByTestId('organization')).toHaveTextContent('test-org');
    expect(platformApi.organizations).toHaveBeenCalledOnce();
  });

  it('selects the organization named by the address, whatever screen of it is open', async () => {
    renderShell(user, '/app/other-org/problems');
    await ready();

    expect(screen.getByTestId('organization')).toHaveTextContent('other-org');
    expect(screen.getByTitle('Switch organization')).toHaveTextContent('Other Org');
  });

  it('knows the fixed addresses of the registry', () => {
    expect(FIXED_ADDRESSES.length).toBeGreaterThanOrEqual(3);
  });

  it.each(FIXED_ADDRESSES)(
    'does not mistake the fixed screen %s for an organization',
    async path => {
      renderShell(user, path);
      await ready();

      expect(screen.getByTestId('organization')).toHaveTextContent('test-org');
    }
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
    expect(screen.queryByTitle('Switch organization')).toBeNull();
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
    expect(within(menu).getByRole('link', { name: 'Profile' })).toHaveAttribute(
      'href',
      '/app/account'
    );
    expect(within(menu).getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
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

  it('has no link to the retired report address in the header of an organization, and fills the palette with its commands', async () => {
    renderShell(user, '/app/test-org/problems');
    await ready();

    const hrefs = Array.from(document.querySelectorAll('a[href]')).map(
      link => link.getAttribute('href') ?? ''
    );
    expect(hrefs.length).toBeGreaterThan(5);
    expect(hrefs.filter(href => /\/reports([/?#]|$)/.test(href))).toEqual([]);

    fireEvent.click(screen.getAllByRole('button', { name: /Open command palette/ })[0]);
    const palette = await screen.findByRole('dialog', { name: 'Command palette' });
    const links = within(palette).getAllByRole('link');
    expect(
      links.filter(link => /\/reports([/?#]|$)/.test(link.getAttribute('href') ?? ''))
    ).toEqual([]);
    // The palette offers what paletteCommands.ts builds for the loaded workspace (the commands themselves are tested there).
    const organizations = [
      organization('org-1', 'test-org', 'Test Org'),
      organization('org-2', 'other-org', 'Other Org'),
    ];
    const expected = buildCommands({
      organizations,
      organization: organizations[0],
      isAdmin: false,
    });
    expect(links.map(link => link.getAttribute('href'))).toEqual(
      expected.map(command => command.href)
    );
  });

  it('does not offer the retired sidebar or direct links to the old public routes', async () => {
    renderShell(user);
    await ready();

    expect(screen.queryByRole('navigation', { name: /Workspace navigation/i })).toBeNull();
    for (const retired of [
      '/schemas',
      '/profiles',
      '/playground',
      '/app/workbench',
      '/team',
      '/changelog',
    ]) {
      expect(document.querySelector(`a[href="${retired}"]`), retired).toBeNull();
    }
  });
});
