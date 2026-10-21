import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserProfile } from '../api/auth';
import { InstitutionMark } from './InstitutionMark';
import { Navigation } from './Navigation/Navigation';
import { PlatformShell } from './PlatformShell/PlatformShell';
import { SiteFooter } from './SiteFooter/SiteFooter';

const auth = vi.hoisted(() => ({
  user: null as UserProfile | null,
  isAdmin: false,
  signOut: vi.fn(),
}));
const platform = vi.hoisted(() => ({ organizations: vi.fn(), projects: vi.fn() }));

vi.mock('../contexts/auth', () => ({ useAuth: () => auth }));
vi.mock('../api/platform', () => ({ platformApi: platform }));

const researchUser: UserProfile = {
  id: 'user-id', username: 'researcher', email: 'researcher@us.es', role: 'user', is_active: true,
  plan: 'RESEARCH', created_at: '2026-09-01T00:00:00Z', cas_verified: true, institutional_branding: true,
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
    render(<MemoryRouter><Navigation /></MemoryRouter>);

    const brandLink = screen.getByRole('link', { name: /OpenBinding home/i });
    const mark = screen.getByTitle('Institutional account · Universidad de Sevilla');
    const image = screen.getByRole('img', markName);

    expect(brandLink).toHaveAttribute('href', '/');
    expect(brandLink).toContainElement(mark);
    expect(mark).toContainElement(image);
    expect(image).toHaveAttribute('src', '/brands/us-fama.png');
    expect(brandLink.textContent).toContain('OpenBinding');
  });

  it('adds a wide mark row to the mobile menu and a chip to the account menu', () => {
    render(<MemoryRouter><Navigation /></MemoryRouter>);

    fireEvent.click(screen.getByRole('button', { name: 'Account menu' }));
    expect(screen.getByText('Universidad de Sevilla · Institutional account')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));

    const mobile = screen.getByRole('navigation', { name: 'Mobile navigation' });
    const wide = within(mobile).getByRole('link', markName);
    expect(wide).toHaveAttribute('href', 'https://www.us.es');
    expect(within(wide).getByRole('img', markName)).toHaveAttribute('src', '/brands/universidad-sevilla.svg');
  });

  it('shows the mark for RESEARCH accounts even when the flag is omitted', () => {
    auth.user = { ...researchUser, plan: 'RESEARCH', institutional_branding: false };
    render(<MemoryRouter><Navigation /></MemoryRouter>);

    expect(screen.getByRole('img', markName)).toBeInTheDocument();
  });

  it('shows the mark for flagged accounts that are not on the RESEARCH plan', () => {
    auth.user = { ...researchUser, plan: 'PRO', institutional_branding: true };
    render(<MemoryRouter><Navigation /></MemoryRouter>);

    expect(screen.getByRole('img', markName)).toBeInTheDocument();
  });

  it('does not show any mark when the contract does not grant it', () => {
    auth.user = { ...researchUser, plan: 'PRO', institutional_branding: false };
    render(<MemoryRouter><Navigation /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: 'Account menu' }));
    expect(screen.queryByRole('img', markName)).not.toBeInTheDocument();
    expect(screen.queryByText(/Institutional account/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
    expect(screen.getByRole('navigation', { name: 'Mobile navigation' })).toBeInTheDocument();
    expect(screen.queryByRole('img', markName)).not.toBeInTheDocument();
  });

  it('never infers institutional status from a @us.es address', () => {
    auth.user = { ...researchUser, plan: 'FREE', institutional_branding: false, email: 'someone@us.es' };
    render(<MemoryRouter><Navigation /><SiteFooter /></MemoryRouter>);

    expect(screen.queryByRole('img', markName)).not.toBeInTheDocument();
  });

  it('shows nothing to guests', () => {
    auth.user = null;
    render(<MemoryRouter><Navigation /><SiteFooter /><InstitutionMark variant="wide" /></MemoryRouter>);

    expect(screen.queryByRole('img', markName)).not.toBeInTheDocument();
  });

  it('adds the wide mark to the footer without removing the text links', () => {
    render(<MemoryRouter><SiteFooter /></MemoryRouter>);

    expect(screen.getByRole('img', markName)).toHaveAttribute('src', '/brands/universidad-sevilla.svg');
    expect(screen.getByRole('link', { name: 'SCORE Lab' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'ISA Group' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'GitHub Source' })).toBeInTheDocument();
  });

  it('uses the shared component inside the authenticated platform shell', async () => {
    render(<MemoryRouter initialEntries={['/app']}><PlatformShell /></MemoryRouter>);

    await waitFor(() => expect(platform.organizations).toHaveBeenCalledOnce());
    // Topbar (compact), sidebar (wide) and mobile menu (wide).
    expect(screen.getAllByRole('img', markName)).toHaveLength(3);
    const brandLink = screen.getByRole('link', { name: /OpenBinding home/i });
    expect(brandLink.querySelector('img[alt="Universidad de Sevilla"]')).toHaveAttribute('src', '/brands/us-fama.png');
    expect(screen.getAllByRole('link', markName).every((link) => link.getAttribute('href') === 'https://www.us.es')).toBe(true);
  });

  it('keeps the platform shell free of marks for ordinary accounts', async () => {
    auth.user = { ...researchUser, plan: 'PRO', institutional_branding: false };
    render(<MemoryRouter initialEntries={['/app']}><PlatformShell /></MemoryRouter>);

    await waitFor(() => expect(platform.organizations).toHaveBeenCalledOnce());
    expect(screen.queryByRole('img', markName)).not.toBeInTheDocument();
  });
});
