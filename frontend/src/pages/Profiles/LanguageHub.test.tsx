import { configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserProfile } from '../../api/auth';
import { AuthContext } from '../../contexts/auth';
import { COMMUNITY_DIALECT, PLACEMENT_DIALECT, QOS_PROFILE, REGISTERED_RESOURCES } from '../../test/fixtures/engines';
import { LanguageHub } from './LanguageHub';

const api = vi.hoisted(() => ({
  getProfiles: vi.fn(),
  getDialects: vi.fn(),
  getRegisteredResources: vi.fn(),
  getRegisteredResourceContent: vi.fn(),
  getBimSchema: vi.fn(),
}));

vi.mock('../../api/client', async () => ({ ...await vi.importActual<typeof import('../../api/client')>('../../api/client'), apiClient: api }));

configure({ asyncUtilTimeout: 5000 });

const lucia: UserProfile = { id: 'u', username: 'lucia', email: 'l@example.test', role: 'user', is_active: true, plan: 'BASIC', created_at: '2026-01-01T00:00:00Z' };

function renderHub(path: string, options: { user?: UserProfile | null; loading?: boolean } = {}) {
  const user = options.user === undefined ? lucia : options.user;
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthContext.Provider value={{ user, loading: options.loading ?? false, signIn: vi.fn(), register: vi.fn(), signOut: vi.fn(), refresh: vi.fn(), isAdmin: false }}>
        <Routes><Route path="/language/:section?/:item?" element={<LanguageHub />} /></Routes>
      </AuthContext.Provider>
    </MemoryRouter>,
  );
}

describe('language hub', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getProfiles.mockResolvedValue([QOS_PROFILE]);
    api.getDialects.mockResolvedValue([PLACEMENT_DIALECT, COMMUNITY_DIALECT]);
    api.getRegisteredResources.mockResolvedValue(REGISTERED_RESOURCES);
    api.getBimSchema.mockResolvedValue({ $id: 'bim/v1/application', type: 'object', properties: { name: { type: 'string' } }, required: ['name'] });
  });

  // [utest->req~frontend-nav-language-hub~1]
  it('opens on Profiles & dialects and marks it in the section navigation', async () => {
    renderHub('/language');
    expect(await screen.findByRole('heading', { level: 1, name: 'The BIM language' })).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Language sections' });
    expect(within(nav).getByText('Profiles and dialects')).toHaveAttribute('aria-current', 'page');
    expect(within(nav).getByRole('link', { name: 'Schemas' })).toHaveAttribute('href', '/language/schemas');
    expect(within(nav).getByRole('link', { name: 'Extensions' })).toHaveAttribute('href', '/language/extensions');
    expect(within(nav).getByRole('link', { name: 'Examples' })).toHaveAttribute('href', '/examples');
    expect(within(nav).getByRole('link', { name: 'Workbench' })).toHaveAttribute('href', '/workbench');
    expect(api.getBimSchema).not.toHaveBeenCalled();
  });

  // [utest->req~frontend-nav-language-hub~1]
  it('switches between the sections without leaving the screen', async () => {
    renderHub('/language');
    await screen.findByRole('heading', { level: 1, name: 'The BIM language' });

    fireEvent.click(within(screen.getByRole('navigation', { name: 'Language sections' })).getByRole('link', { name: 'Schemas' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Schemas' })).toBeInTheDocument();
    await waitFor(() => expect(api.getBimSchema).toHaveBeenCalledWith('Application'));
    expect(within(screen.getByRole('navigation', { name: 'Language sections' })).getByText('Schemas')).toHaveAttribute('aria-current', 'page');

    fireEvent.click(within(screen.getByRole('navigation', { name: 'Language sections' })).getByRole('link', { name: 'Extensions' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Language extensions' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Breadcrumb' })).not.toBeInTheDocument();
  });

  // [utest->req~frontend-nav-language-hub~1]
  it('deep link: /language/schemas/<Kind> opens that kind', async () => {
    renderHub('/language/schemas/Instance');
    expect(await screen.findByRole('heading', { level: 2, name: 'Instance' })).toBeInTheDocument();
    await waitFor(() => expect(api.getBimSchema).toHaveBeenCalledWith('Instance'));
  });

  // [utest->req~frontend-nav-language-hub~1]
  it('Schemas without an item opens on application', async () => {
    renderHub('/language/schemas');
    expect(await screen.findByRole('heading', { level: 2, name: 'Application' })).toBeInTheDocument();
  });

  // [utest->req~frontend-nav-language-hub~1]
  it('an unknown kind keeps the hub and says 404', async () => {
    renderHub('/language/schemas/Nope');
    expect(await screen.findByText(/Unknown kind “Nope” \(404\)/)).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Language sections' })).toBeInTheDocument();
  });

  // [utest->req~frontend-nav-language-hub~1]
  it('deep link: /language/extensions lists the extensions of a signed-in user', async () => {
    renderHub('/language/extensions');
    expect(await screen.findByRole('heading', { level: 1, name: 'Language extensions' })).toBeInTheDocument();
    await waitFor(() => expect(api.getDialects).toHaveBeenCalled());
  });

  // [utest->req~frontend-nav-language-hub~1]
  it('signed out, Extensions explains and offers the login, with no API call', () => {
    renderHub('/language/extensions', { user: null });
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Language extensions');
    expect(screen.getByRole('link', { name: 'Log in to see and manage language extensions' })).toHaveAttribute('href', '/login');
    expect(api.getDialects).not.toHaveBeenCalled();
    expect(api.getProfiles).not.toHaveBeenCalled();
    expect(api.getRegisteredResources).not.toHaveBeenCalled();
  });

  // [utest->req~frontend-nav-language-hub~1]
  it('while the session loads, Extensions shows a skeleton and calls nothing', () => {
    renderHub('/language/extensions', { user: null, loading: true });
    expect(screen.queryByRole('link', { name: 'Log in to see and manage language extensions' })).not.toBeInTheDocument();
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(api.getDialects).not.toHaveBeenCalled();
  });

  // [utest->req~frontend-nav-language-hub~1]
  it('an unknown section shows a heading and a 404 notice', () => {
    renderHub('/language/nowhere');
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
    expect(screen.getByText(/no “nowhere” section \(404\)/)).toBeInTheDocument();
  });
});
