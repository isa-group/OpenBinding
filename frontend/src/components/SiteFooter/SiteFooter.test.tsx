import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserProfile } from '../../api/auth';
import { SiteFooter } from './SiteFooter';

const auth = vi.hoisted(() => ({ user: null as UserProfile | null }));

vi.mock('../../contexts/auth', () => ({ useAuth: () => auth }));

const member: UserProfile = {
  id: 'user-id', username: 'someone', email: 'someone@us.es', role: 'user', is_active: true,
  plan: 'PRO', created_at: '2026-09-01T00:00:00Z',
};

function renderFooter() {
  return render(<MemoryRouter><SiteFooter /></MemoryRouter>);
}

describe('SiteFooter', () => {
  beforeEach(() => { auth.user = null; });

  it('groups the platform, language and about links', () => {
    renderFooter();

    const nav = screen.getByRole('navigation', { name: 'Footer navigation' });
    for (const [name, href] of [
      ['Explore', '/explore'], ['Engines', '/engines'], ['Pricing', '/pricing'], ['Status', '/status'],
      ['Profiles & dialects', '/language'], ['Schemas', '/language/schemas/application'],
      ['Examples', '/examples'], ['Workbench', '/workbench'],
      ['Team', '/about?tab=team'], ['Research', '/about?tab=research'],
      ['Funding', '/about?tab=funding'], ['Changelog', '/about?tab=changelog'],
    ] as const) {
      expect(within(nav).getByRole('link', { name })).toHaveAttribute('href', href);
    }
    expect(within(nav).getAllByRole('link')).toHaveLength(12);
  });

  it('renders the colour band and a dynamic copyright year', () => {
    const { container } = renderFooter();

    expect(container.querySelector('.site-footer-band')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByText(`© ${new Date().getFullYear()} OpenBinding`)).toBeInTheDocument();
    expect(screen.queryByText(/prototype|synthetic/i)).not.toBeInTheDocument();
  });

  it('keeps the institutional text links for every visitor', () => {
    renderFooter();

    expect(screen.getByRole('link', { name: 'SCORE Lab' })).toHaveAttribute('href', 'https://score.us.es');
    expect(screen.getByRole('link', { name: 'ISA Group' })).toHaveAttribute('href', 'https://www.isa.us.es/3.0/');
    expect(screen.getByRole('link', { name: 'Universidad de Sevilla' })).toHaveAttribute('href', 'https://www.us.es');
    expect(screen.getByRole('link', { name: 'GitHub Source' })).toHaveAttribute('href', 'https://github.com/isa-group/OpenBinding');
  });

  it('shows no institutional mark to guests or ordinary accounts', () => {
    const { unmount } = renderFooter();
    expect(screen.queryByRole('img', { name: 'Universidad de Sevilla' })).not.toBeInTheDocument();
    unmount();

    auth.user = member;
    renderFooter();
    expect(screen.queryByRole('img', { name: 'Universidad de Sevilla' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Universidad de Sevilla' })).toBeInTheDocument();
  });

  it('adds the wide mark in the bottom row for institutional accounts', () => {
    auth.user = { ...member, plan: 'RESEARCH' };
    const { container } = renderFooter();

    const image = screen.getByRole('img', { name: 'Universidad de Sevilla' });
    expect(image).toHaveAttribute('src', '/brands/universidad-sevilla.svg');
    expect(container.querySelector('.site-footer-meta')).toContainElement(image);
    expect(screen.getAllByRole('link', { name: 'Universidad de Sevilla' })).toHaveLength(2);
  });
});
