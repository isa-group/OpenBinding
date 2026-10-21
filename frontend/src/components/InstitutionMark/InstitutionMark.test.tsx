import { render, renderHook, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserProfile } from '../../api/auth';
import { InstitutionMark } from './InstitutionMark';
import { isInstitutionalAccount, useInstitutionalBranding } from './institution';

const auth = vi.hoisted(() => ({ user: null as UserProfile | null }));

vi.mock('../../contexts/auth', () => ({ useAuth: () => auth }));

const base: UserProfile = {
  id: 'user-id', username: 'someone', email: 'someone@example.com', role: 'user', is_active: true,
  plan: 'PRO', created_at: '2026-09-01T00:00:00Z',
};

describe('isInstitutionalAccount', () => {
  it('grants the mark to RESEARCH accounts without the flag', () => {
    expect(isInstitutionalAccount({ ...base, plan: 'RESEARCH' })).toBe(true);
    expect(isInstitutionalAccount({ ...base, plan: 'RESEARCH', institutional_branding: false })).toBe(true);
  });

  it('grants the mark to flagged accounts without the RESEARCH plan', () => {
    expect(isInstitutionalAccount({ ...base, plan: 'PRO', institutional_branding: true })).toBe(true);
  });

  it('does not grant the mark to ordinary accounts or guests', () => {
    expect(isInstitutionalAccount({ ...base, plan: 'PRO' })).toBe(false);
    expect(isInstitutionalAccount({ ...base, plan: 'PRO', institutional_branding: false })).toBe(false);
    expect(isInstitutionalAccount(null)).toBe(false);
    expect(isInstitutionalAccount(undefined)).toBe(false);
  });

  it('never infers the mark from the e-mail address', () => {
    const researcher: UserProfile = { ...base, email: 'researcher@us.es' };
    const student: UserProfile = { ...base, email: 'student@alum.us.es', institutional_branding: false };
    expect(isInstitutionalAccount(researcher)).toBe(false);
    expect(isInstitutionalAccount(student)).toBe(false);
  });
});

describe('useInstitutionalBranding', () => {
  beforeEach(() => { auth.user = null; });

  it('applies the rule to the authenticated user', () => {
    expect(renderHook(() => useInstitutionalBranding()).result.current).toBe(false);
    auth.user = { ...base, plan: 'RESEARCH' };
    expect(renderHook(() => useInstitutionalBranding()).result.current).toBe(true);
    auth.user = { ...base, email: 'researcher@us.es' };
    expect(renderHook(() => useInstitutionalBranding()).result.current).toBe(false);
  });
});

describe('InstitutionMark', () => {
  beforeEach(() => { auth.user = { ...base, plan: 'RESEARCH' }; });

  it('renders the compact co-brand as a plain mark with the institutional title', () => {
    render(<InstitutionMark variant="compact" />);

    const image = screen.getByRole('img', { name: 'Universidad de Sevilla' });
    expect(image).toHaveAttribute('src', '/brands/us-fama.png');
    expect(screen.getByTitle('Institutional account · Universidad de Sevilla')).toContainElement(image);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('defaults to the compact variant', () => {
    render(<InstitutionMark />);
    expect(screen.getByRole('img', { name: 'Universidad de Sevilla' })).toHaveAttribute('src', '/brands/us-fama.png');
  });

  it('renders the wide variant as an external link to the university', () => {
    render(<InstitutionMark variant="wide" />);

    const link = screen.getByRole('link', { name: 'Universidad de Sevilla' });
    expect(link).toHaveAttribute('href', 'https://www.us.es');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noreferrer');
    expect(link).toHaveAttribute('title', 'Institutional account · Universidad de Sevilla');
    expect(screen.getByRole('img', { name: 'Universidad de Sevilla' })).toHaveAttribute('src', '/brands/universidad-sevilla.svg');
  });

  it.each(['compact', 'wide'] as const)('renders nothing for non-institutional accounts (%s)', (variant) => {
    auth.user = { ...base, plan: 'PRO' };
    const { container } = render(<InstitutionMark variant={variant} />);
    expect(container).toBeEmptyDOMElement();
  });

  it.each(['compact', 'wide'] as const)('renders nothing for guests (%s)', (variant) => {
    auth.user = null;
    const { container } = render(<InstitutionMark variant={variant} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing for a @us.es address without institutional status', () => {
    auth.user = { ...base, email: 'researcher@us.es', plan: 'FREE' };
    const { container } = render(<InstitutionMark variant="compact" />);
    expect(container).toBeEmptyDOMElement();
  });
});
