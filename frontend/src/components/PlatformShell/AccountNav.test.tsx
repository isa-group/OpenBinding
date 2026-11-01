import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { AccountNav, type AccountSection } from './AccountNav';

const SECTIONS: Array<[AccountSection, string, string]> = [
  ['profile', 'Profile', '/app/account'],
  ['usage', 'Plan', '/app/account/usage'],
  ['keys', 'API keys', '/app/account/keys'],
  ['identities', 'Identities', '/app/account/identities'],
  ['notifications', 'Notifications', '/app/account/notifications'],
];

describe('AccountNav', () => {
  // [utest->req~frontend-nav-account-sections~1]
  it('names the five sections of the account page and links their addresses, in order', () => {
    render(<MemoryRouter><AccountNav /></MemoryRouter>);

    const nav = screen.getByRole('navigation', { name: 'Account' });
    expect(within(nav).getAllByRole('link').map((link) => [link.textContent, link.getAttribute('href')])).toEqual(
      SECTIONS.map(([, label, to]) => [label, to]),
    );
  });

  // [utest->req~frontend-nav-account-sections~1]
  it.each(SECTIONS)('marks %s (%s) with aria-current="page" and no other section', (active, label) => {
    render(<MemoryRouter><AccountNav active={active} /></MemoryRouter>);

    const nav = within(screen.getByRole('navigation', { name: 'Account' }));
    expect(nav.getByRole('link', { name: label, current: 'page' })).toBeInTheDocument();
    expect(nav.getAllByRole('link', { current: 'page' })).toHaveLength(1);
  });

  // [utest->req~frontend-nav-account-sections~1]
  it('marks Profile when no section is given', () => {
    render(<MemoryRouter><AccountNav /></MemoryRouter>);

    expect(within(screen.getByRole('navigation', { name: 'Account' })).getByRole('link', { name: 'Profile', current: 'page' })).toBeInTheDocument();
  });
});
