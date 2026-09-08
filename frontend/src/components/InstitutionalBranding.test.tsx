import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserProfile } from '../api/auth';
import { Navigation } from './Navigation/Navigation';
import { PlatformShell } from './PlatformShell/PlatformShell';

const auth = vi.hoisted(() => ({
  user: null as UserProfile | null,
  isAdmin: false,
  signOut: vi.fn(),
}));
const platform = vi.hoisted(() => ({ organizations: vi.fn(), projects: vi.fn() }));

vi.mock('../contexts/auth', () => ({ useAuth: () => auth }));
vi.mock('../contexts/theme', () => ({ useTheme: () => ({ theme: 'light', toggleTheme: vi.fn() }) }));
vi.mock('../api/platform', () => ({ platformApi: platform }));

const researchUser: UserProfile = {
  id: 'user-id', username: 'researcher', email: 'researcher@us.es', role: 'user', is_active: true,
  plan: 'RESEARCH', created_at: '2026-09-01T00:00:00Z', cas_verified: true, institutional_branding: true,
};

describe('Universidad de Sevilla institutional branding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.user = researchUser;
    platform.organizations.mockResolvedValue([]);
    platform.projects.mockResolvedValue([]);
  });

  it('shows the official institutional mark in the public header and mobile menu', () => {
    render(<MemoryRouter><Navigation /></MemoryRouter>);

    const marks = screen.getAllByRole('img', { name: /Universidad de Sevilla/i });
    expect(marks).toHaveLength(2);
    expect(marks.every((mark) => /^\/brands\/(us-fama|universidad-sevilla)\.(png|svg)$/.test(mark.getAttribute('src') ?? ''))).toBe(true);
  });

  it('uses the Fama brand emblem for the top navigation bar', () => {
    render(<MemoryRouter><Navigation /></MemoryRouter>);

    const usImg = screen.getAllByRole('img', { name: /Universidad de Sevilla/i })[0];
    expect(usImg.getAttribute('src')).toBe('/brands/us-fama.png');
  });

  it('keeps the institutional mark visible inside the authenticated platform shell', async () => {
    render(<MemoryRouter initialEntries={['/app']}><PlatformShell /></MemoryRouter>);

    await waitFor(() => expect(platform.organizations).toHaveBeenCalledOnce());
    expect(screen.getAllByRole('img', { name: 'Universidad de Sevilla' }).length).toBeGreaterThanOrEqual(2);
    const platformBrandLink = screen.getByRole('link', { name: /OpenBinding home/i });
    const usTopImg = platformBrandLink.querySelector('img[alt="Universidad de Sevilla"]');
    expect(usTopImg).not.toBeNull();
    expect(usTopImg?.getAttribute('src')).toBe('/brands/us-fama.png');
  });

  it('renders the US logo inside the same clickable brand button alongside OpenBinding for RESEARCH accounts', () => {
    render(<MemoryRouter><Navigation /></MemoryRouter>);

    const brandLink = screen.getByRole('link', { name: /OpenBinding home/i });
    const usHeaderSpan = screen.getByTitle('Cuenta institucional · Universidad de Sevilla');
    const usImg = screen.getByRole('img', { name: 'Universidad de Sevilla' });

    expect(brandLink).toContainElement(usHeaderSpan);
    expect(usHeaderSpan).toContainElement(usImg);
    expect(brandLink.getAttribute('href')).toBe('/');
  });

  it('renders co-branding for accounts with plan RESEARCH even when institutional_branding is omitted', () => {
    auth.user = { ...researchUser, plan: 'RESEARCH', institutional_branding: false };
    render(<MemoryRouter><Navigation /></MemoryRouter>);

    const marks = screen.getAllByRole('img', { name: /Universidad de Sevilla/i });
    expect(marks).toHaveLength(2);
  });

  it('does not render co-branding when the contract does not grant it', () => {
    auth.user = { ...researchUser, plan: 'PRO', institutional_branding: false };
    render(<MemoryRouter><Navigation /></MemoryRouter>);

    expect(screen.queryByRole('img', { name: /Universidad de Sevilla/i })).not.toBeInTheDocument();
  });
});
