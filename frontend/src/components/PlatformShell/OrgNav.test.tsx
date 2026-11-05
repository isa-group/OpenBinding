import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { OrgNav, type OrgSection } from './OrgNav';

const currentOf = (nav: HTMLElement) => within(nav).queryAllByRole('link').filter((link) => link.getAttribute('aria-current') === 'page');

describe('OrgNav', () => {
  it('links back to the organization and to its settings sections', () => {
    render(<MemoryRouter><OrgNav orgName="ISA Demo Group" orgSlug="isa-demo" /></MemoryRouter>);

    const nav = screen.getByRole('navigation', { name: 'Organization settings' });
    expect(within(nav).getAllByRole('link').map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
      ['ISA Demo Group', '/app/isa-demo'],
      ['General', '/app/isa-demo/settings'],
      ['Members', '/app/isa-demo/settings/members'],
      ['Audit', '/app/isa-demo/settings/audit'],
    ]);
    expect(within(nav).queryByText('ADMIN')).toBeNull();
  });

  it.each([
    ['general', 'General'],
    ['members', 'Members'],
    ['audit', 'Audit'],
  ] as Array<[OrgSection, string]>)('marks only %s as the current page', (active, label) => {
    render(<MemoryRouter><OrgNav active={active} orgName="ISA Demo Group" orgSlug="isa-demo" /></MemoryRouter>);

    const current = currentOf(screen.getByRole('navigation', { name: 'Organization settings' }));
    expect(current.map((link) => link.textContent)).toEqual([label]);
  });

  it('flags the audit section as needing ADMIN when the member cannot read it', () => {
    render(<MemoryRouter><OrgNav orgName="ISA Demo Group" orgSlug="isa-demo" canAudit={false} /></MemoryRouter>);

    const audit = screen.getByRole('link', { name: /^Audit/ });
    expect(within(audit).getByText('ADMIN')).toHaveAttribute('title', 'Needs ADMIN');
    expect(screen.getByRole('link', { name: 'General' })).not.toHaveTextContent('ADMIN');
  });
});
