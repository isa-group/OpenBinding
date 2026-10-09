import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { AccountNav, type AccountSection } from './AccountNav';
import { OrgNav, type OrgSection } from './OrgNav';
import { ProjectLibraryNav, type ProjectLibrarySection } from '../ui/SectionNav';
import { ProjectTabs, type ProjectSection } from './ProjectTabs';

const currentOf = (nav: HTMLElement) => within(nav).queryAllByRole('link').filter((link) => link.getAttribute('aria-current') === 'page');

describe('AccountNav', () => {
  it('links the five account screens', () => {
    render(<MemoryRouter><AccountNav /></MemoryRouter>);

    const nav = screen.getByRole('navigation', { name: 'Account' });
    expect(within(nav).getAllByRole('link').map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
      ['Profile & security', '/app/account'],
      ['Usage & plan', '/app/account/usage'],
      ['API keys', '/app/account/keys'],
      ['Identities', '/app/account/identities'],
      ['Notifications', '/app/account/notifications'],
    ]);
  });

  it.each([
    ['profile', 'Profile & security'],
    ['usage', 'Usage & plan'],
    ['keys', 'API keys'],
    ['identities', 'Identities'],
    ['notifications', 'Notifications'],
  ] as Array<[AccountSection, string]>)('marks only %s as the current page', (active, label) => {
    render(<MemoryRouter><AccountNav active={active} /></MemoryRouter>);

    const current = currentOf(screen.getByRole('navigation', { name: 'Account' }));
    expect(current.map((link) => link.textContent)).toEqual([label]);
  });
});

describe('OrgNav', () => {
  it('links back to the organization and to its settings screens', () => {
    render(<MemoryRouter><OrgNav orgName="ISA Demo Group" orgSlug="isa-demo" /></MemoryRouter>);

    const nav = screen.getByRole('navigation', { name: 'Organization settings' });
    expect(within(nav).getAllByRole('link').map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
      ['ISA Demo Group', '/app/isa-demo'],
      ['General', '/app/isa-demo/settings'],
      ['Members & invitations', '/app/isa-demo/settings/members'],
      ['Audit log', '/app/isa-demo/settings/audit'],
    ]);
    expect(within(nav).queryByText('ADMIN')).toBeNull();
  });

  it.each([
    ['general', 'General'],
    ['members', 'Members & invitations'],
    ['audit', 'Audit log'],
  ] as Array<[OrgSection, string]>)('marks only %s as the current page', (active, label) => {
    render(<MemoryRouter><OrgNav active={active} orgName="ISA Demo Group" orgSlug="isa-demo" /></MemoryRouter>);

    const current = currentOf(screen.getByRole('navigation', { name: 'Organization settings' }));
    expect(current.map((link) => link.textContent)).toEqual([label]);
  });

  it('flags the audit log as needing ADMIN when the member cannot read it', () => {
    render(<MemoryRouter><OrgNav orgName="ISA Demo Group" orgSlug="isa-demo" canAudit={false} /></MemoryRouter>);

    const audit = screen.getByRole('link', { name: /Audit log/ });
    expect(within(audit).getByText('ADMIN')).toHaveAttribute('title', 'Needs ADMIN');
    expect(screen.getByRole('link', { name: 'General' })).not.toHaveTextContent('ADMIN');
  });
});

describe('ProjectLibraryNav', () => {
  it('names the screens around the library of a project, and the current one is not a link', () => {
    render(<MemoryRouter><ProjectLibraryNav current="library" orgSlug="isa-demo" projectSlug="qos" /></MemoryRouter>);

    const nav = screen.getByRole('navigation', { name: 'Library sections' });
    expect(within(nav).getAllByRole('link').map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
      ['Collections', '/app/isa-demo/qos/collections'],
      ['Project resources (older view)', '/app/isa-demo/qos/resources'],
      ['Organization library', '/app/isa-demo/library'],
      ['Workbench', '/app/isa-demo/qos/workbench'],
    ]);
    expect(within(nav).getByText('Library used here')).toHaveAttribute('aria-current', 'page');
  });

  it.each([
    ['collections', 'Collections'],
    ['resources', 'Project resources (older view)'],
  ] as Array<[ProjectLibrarySection, string]>)('marks %s as the current page', (current, label) => {
    render(<MemoryRouter><ProjectLibraryNav current={current} orgSlug="isa-demo" projectSlug="qos" /></MemoryRouter>);

    const nav = screen.getByRole('navigation', { name: 'Library sections' });
    expect(within(nav).getByText(label)).toHaveAttribute('aria-current', 'page');
    expect(within(nav).getByRole('link', { name: 'Library used here' })).toHaveAttribute('href', '/app/isa-demo/qos/library');
  });
});

describe('ProjectTabs', () => {
  it('links the project sections', () => {
    render(<MemoryRouter><ProjectTabs orgSlug="isa-demo" projectSlug="qos" /></MemoryRouter>);

    const nav = screen.getByRole('navigation', { name: 'Project sections' });
    expect(within(nav).getAllByRole('link').map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
      ['Overview', '/app/isa-demo/qos'],
      ['Cases', '/app/isa-demo/qos/cases'],
      ['Library', '/app/isa-demo/qos/library'],
      ['Jobs', '/app/isa-demo/qos/jobs'],
      ['Studies', '/app/isa-demo/qos/studies'],
      ['Reports', '/app/isa-demo/qos/reports'],
      ['Files', '/app/isa-demo/qos/files'],
      ['Package', '/app/isa-demo/qos/package'],
      ['Settings', '/app/isa-demo/qos/settings'],
    ]);
  });

  it.each([
    ['overview', 'Overview'],
    ['cases', 'Cases'],
    ['library', 'Library'],
    ['jobs', 'Jobs'],
    ['studies', 'Studies'],
    ['reports', 'Reports'],
    ['files', 'Files'],
    ['package', 'Package'],
    ['settings', 'Settings'],
  ] as Array<[ProjectSection, string]>)('marks only %s as the current page', (active, label) => {
    render(<MemoryRouter><ProjectTabs active={active} orgSlug="isa-demo" projectSlug="qos" /></MemoryRouter>);

    const current = currentOf(screen.getByRole('navigation', { name: 'Project sections' }));
    expect(current.map((link) => link.textContent)).toEqual([label]);
  });
});
