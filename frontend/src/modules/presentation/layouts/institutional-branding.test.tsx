import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserProfile } from '../../core/api/account';
import { InstitutionMark } from '../../auth/components/institution-mark';
import AppFooter from './authenticated-layout/app-footer';
import AppHeader from './authenticated-layout/app-header';
import { headerRoutes } from './router/header-routes';
import FloatingMorphHeader from '../pages/home/components/floating-morph-header';

const Navigation = () => <FloatingMorphHeader navItems={headerRoutes} />;
const SiteFooter = AppFooter;

const auth = vi.hoisted(() => ({
  user: null as UserProfile | null,
  isAdmin: false,
  signOut: vi.fn(),
}));
const platform = vi.hoisted(() => ({ organizations: vi.fn(), projects: vi.fn() }));

vi.mock('../../auth/hooks/useAuth', () => ({ useAuth: () => auth }));
vi.mock('../../../api/platform', () => ({ platformApi: platform }));
vi.mock('../../notification/components/notification-bell', () => ({ default: () => null }));
vi.mock('../../notification/hooks/useNotificationsContext', () => ({
  useNotificationsContext: () => ({ unreadCount: 0 }),
}));

const researchUser: UserProfile = {
  id: 'user-id',
  username: 'researcher',
  email: 'researcher@us.es',
  role: 'user',
  is_active: true,
  plan: 'RESEARCH',
  created_at: '2026-09-01T00:00:00Z',
  cas_verified: true,
  email_verified: false,
  institutional_email: false,
};

const markName = { name: 'Universidad de Sevilla' };

describe('Universidad de Sevilla institutional branding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.user = researchUser;
    platform.organizations.mockResolvedValue([]);
    platform.projects.mockResolvedValue([]);
  });

  it('places the compact co-brand inside the home link of the public header', () => {
    render(
      <MemoryRouter>
        <Navigation />
      </MemoryRouter>
    );

    const brandLink = screen.getByRole('link', { name: /OpenBinding home/i });
    const mark = screen.getByTitle('Institutional account · Universidad de Sevilla');
    const image = screen.getByRole('img', markName);

    expect(brandLink).toHaveAttribute('href', '/');
    expect(brandLink).toContainElement(mark);
    expect(mark).toContainElement(image);
    expect(image).toHaveAttribute('src', '/brands/us-fama.png');
    expect(brandLink.textContent).toContain('OpenBinding');
  });

  it('shows the mark for RESEARCH accounts', () => {
    auth.user = { ...researchUser, plan: 'RESEARCH' };
    render(
      <MemoryRouter>
        <Navigation />
      </MemoryRouter>
    );

    expect(screen.getByRole('img', markName)).toBeInTheDocument();
  });

  it('does not show any mark on another plan', () => {
    auth.user = { ...researchUser, plan: 'LAB' };
    render(
      <MemoryRouter>
        <Navigation />
      </MemoryRouter>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Account menu' }));
    expect(screen.queryByRole('img', markName)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
    expect(screen.getByRole('navigation', { name: 'Mobile navigation' })).toBeInTheDocument();
    expect(screen.queryByRole('img', markName)).not.toBeInTheDocument();
  });

  it('never infers institutional status from a @us.es address', () => {
    auth.user = { ...researchUser, plan: 'FREE', email: 'someone@us.es' };
    render(
      <MemoryRouter>
        <Navigation />
        <SiteFooter />
      </MemoryRouter>
    );

    expect(screen.queryByRole('img', markName)).not.toBeInTheDocument();
  });

  it('shows nothing to guests', () => {
    auth.user = null;
    render(
      <MemoryRouter>
        <Navigation />
        <SiteFooter />
        <InstitutionMark variant="wide" />
      </MemoryRouter>
    );

    expect(screen.queryByRole('img', markName)).not.toBeInTheDocument();
  });

  it('adds the wide mark to the footer without removing the text links', () => {
    render(
      <MemoryRouter>
        <SiteFooter />
      </MemoryRouter>
    );

    expect(screen.getByRole('img', markName)).toHaveAttribute(
      'src',
      '/brands/universidad-sevilla.svg'
    );
    expect(screen.getByRole('link', { name: 'SCORE Lab' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'ISA Group' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'GitHub Source' })).toBeInTheDocument();
  });

  it('places the compact co-brand in the home link of the application header', () => {
    render(
      <MemoryRouter initialEntries={['/app']}>
        <AppHeader />
      </MemoryRouter>
    );

    expect(screen.getAllByRole('img', markName)).toHaveLength(1);
    const brandLink = screen.getByRole('link', { name: /OpenBinding home/i });
    expect(brandLink.querySelector('img[alt="Universidad de Sevilla"]')).toHaveAttribute(
      'src',
      '/brands/us-fama.png'
    );
  });

  it('keeps the application header free of marks for ordinary accounts', () => {
    auth.user = { ...researchUser, plan: 'LAB' };
    render(
      <MemoryRouter initialEntries={['/app']}>
        <AppHeader />
      </MemoryRouter>
    );

    expect(screen.queryByRole('img', markName)).not.toBeInTheDocument();
  });
});
