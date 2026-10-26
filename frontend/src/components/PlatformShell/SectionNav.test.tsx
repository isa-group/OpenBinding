import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountNav, type AccountSection } from './AccountNav';
import { OrgNav, type OrgSection } from './OrgNav';
import { ProjectTabs, type ProjectSection } from './ProjectTabs';

const currentOf = (nav: HTMLElement) => within(nav).queryAllByRole('link').filter((link) => link.getAttribute('aria-current') === 'page');

describe('AccountNav', () => {
  it('links the five account screens', () => {
    render(<MemoryRouter><AccountNav /></MemoryRouter>);

    const nav = screen.getByRole('navigation', { name: 'Account' });
    expect(within(nav).getAllByRole('link').map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
      ['Profile & security', '/app/account'],
      ['Plan & permissions', '/app/account/usage'],
      ['API keys', '/app/account/keys'],
      ['Identities', '/app/account/identities'],
      ['Notifications', '/app/account/notifications'],
    ]);
  });

  it.each([
    ['profile', 'Profile & security'],
    ['usage', 'Plan & permissions'],
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

/** The unit-test DOM has no layout: give the navigation a row 300 wide inside 600 of content, and the current link a place 400 from its left. */
describe('a side navigation that becomes a row that scrolls sideways', () => {
  const scrolled: Array<{ left: number }> = [];
  const box = (left: number, width: number) => ({ left, width, right: left + width, top: 0, bottom: 0, height: 0, x: left, y: 0, toJSON: () => ({}) }) as DOMRect;

  beforeEach(() => {
    scrolled.length = 0;
    vi.spyOn(Element.prototype, 'scrollWidth', 'get').mockReturnValue(600);
    vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(300);
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function rect(this: Element) {
      return this.tagName === 'NAV' ? box(0, 300) : box(400, 100);
    });
    Object.defineProperty(Element.prototype, 'scrollTo', { configurable: true, value(options: { left: number }) { scrolled.push(options); } });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(Element.prototype, 'scrollTo');
  });

  it.each(['keys', 'identities', 'notifications'] as AccountSection[])('centres the current account screen (%s) in the row', (active) => {
    render(<MemoryRouter><AccountNav active={active} /></MemoryRouter>);

    // 0 already scrolled + 400 to the link - (300 row - 100 link) / 2
    expect(scrolled).toEqual([{ left: 300 }]);
  });

  it('centres the current settings screen of an organization', () => {
    render(<MemoryRouter><OrgNav active="audit" orgName="ISA Demo Group" orgSlug="isa-demo" /></MemoryRouter>);

    expect(scrolled).toEqual([{ left: 300 }]);
  });

  it('never scrolls to before the start of the row', () => {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function rect(this: Element) {
      return this.tagName === 'NAV' ? box(0, 300) : box(20, 100);
    });
    render(<MemoryRouter><AccountNav active="profile" /></MemoryRouter>);

    expect(scrolled).toEqual([{ left: 0 }]);
  });

  it('leaves a row that fits alone', () => {
    vi.spyOn(Element.prototype, 'scrollWidth', 'get').mockReturnValue(300);
    render(<MemoryRouter><AccountNav active="notifications" /></MemoryRouter>);

    expect(scrolled).toEqual([]);
  });
});

describe('ProjectTabs', () => {
  // [utest->req~frontend-retire-reports-navigation~1]
  // [utest->req~frontend-retire-library-navigation~1]
  it('links the project sections', () => {
    render(<MemoryRouter><ProjectTabs orgSlug="isa-demo" projectSlug="qos" /></MemoryRouter>);

    const nav = screen.getByRole('navigation', { name: 'Project sections' });
    expect(within(nav).getAllByRole('link').map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
      ['Overview', '/app/isa-demo/qos'],
      ['Cases', '/app/isa-demo/qos/cases'],
      ['Collections', '/app/isa-demo/qos/collections'],
      ['Jobs', '/app/isa-demo/qos/jobs'],
      ['Studies', '/app/isa-demo/qos/studies'],
      ['Publications', '/app/isa-demo/qos/publications'],
      ['Files', '/app/isa-demo/qos/files'],
      ['Package', '/app/isa-demo/qos/package'],
      ['Settings', '/app/isa-demo/qos/settings'],
    ]);
  });

  // [utest->req~frontend-retire-reports-navigation~1]
  // [utest->req~frontend-retire-library-navigation~1]
  it('has no Reports or Library tab and no tab that leads to a retired address', () => {
    render(<MemoryRouter><ProjectTabs orgSlug="isa-demo" projectSlug="qos" /></MemoryRouter>);

    const nav = screen.getByRole('navigation', { name: 'Project sections' });
    expect(within(nav).queryByRole('link', { name: 'Reports' })).not.toBeInTheDocument();
    expect(within(nav).queryByRole('link', { name: 'Library' })).not.toBeInTheDocument();
    for (const link of within(nav).getAllByRole('link')) expect(link.getAttribute('href')).not.toMatch(/\/(reports|library|resources)([/?#]|$)/);
    expect(within(nav).getByRole('link', { name: 'Publications' })).toHaveAttribute('href', '/app/isa-demo/qos/publications');
  });

  // [utest->req~frontend-retire-reports-navigation~1]
  it.each([
    ['overview', 'Overview'],
    ['cases', 'Cases'],
    ['collections', 'Collections'],
    ['jobs', 'Jobs'],
    ['studies', 'Studies'],
    ['publications', 'Publications'],
    ['files', 'Files'],
    ['package', 'Package'],
    ['settings', 'Settings'],
  ] as Array<[ProjectSection, string]>)('marks only %s as the current page', (active, label) => {
    render(<MemoryRouter><ProjectTabs active={active} orgSlug="isa-demo" projectSlug="qos" /></MemoryRouter>);

    const current = currentOf(screen.getByRole('navigation', { name: 'Project sections' }));
    expect(current.map((link) => link.textContent)).toEqual([label]);
  });

  describe('for someone who reads a public project without being a member', () => {
    // [utest->req~frontend-retire-reports-navigation~1]
    // [utest->req~frontend-retire-library-navigation~1]
    it('drops the tabs only members can open and says the project is read-only, and still shows Publications', () => {
      render(<MemoryRouter><ProjectTabs orgSlug="open" projectSlug="qos" access="public_read" /></MemoryRouter>);

      const nav = screen.getByRole('navigation', { name: 'Project sections' });
      expect(within(nav).getAllByRole('link').map((link) => link.textContent)).toEqual(['Overview', 'Cases', 'Collections', 'Studies', 'Publications', 'Files']);
      expect(within(nav).getByRole('link', { name: 'Publications' })).toHaveAttribute('href', '/app/open/qos/publications');
      expect(screen.getByRole('note')).toHaveTextContent('You are viewing a public project (read-only).');
    });

    it('shows every tab and no strip to a member, or when nothing says otherwise', () => {
      const { rerender } = render(<MemoryRouter><ProjectTabs orgSlug="isa-demo" projectSlug="qos" access="member" /></MemoryRouter>);
      expect(within(screen.getByRole('navigation', { name: 'Project sections' })).getAllByRole('link')).toHaveLength(9);
      expect(screen.queryByRole('note')).not.toBeInTheDocument();

      rerender(<MemoryRouter><ProjectTabs orgSlug="isa-demo" projectSlug="qos" /></MemoryRouter>);
      expect(within(screen.getByRole('navigation', { name: 'Project sections' })).getAllByRole('link')).toHaveLength(9);
    });
  });

  describe('on a row that scrolls', () => {
    const scrolled: HTMLElement[] = [];

    beforeEach(() => {
      scrolled.length = 0;
      Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
        configurable: true,
        value(this: HTMLElement) { scrolled.push(this); },
      });
    });

    afterEach(() => {
      Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
    });

    it.each(['jobs', 'studies', 'publications', 'files', 'settings'] as ProjectSection[])('brings the current tab (%s) into view', (active) => {
      render(<MemoryRouter><ProjectTabs active={active} orgSlug="isa-demo" projectSlug="qos" /></MemoryRouter>);

      expect(scrolled.map((tab) => tab.getAttribute('aria-current'))).toEqual(['page']);
      expect(scrolled[0]).toBe(currentOf(screen.getByRole('navigation', { name: 'Project sections' }))[0]);
    });

    it('follows the current tab when the section changes', () => {
      const { rerender } = render(<MemoryRouter><ProjectTabs active="cases" orgSlug="isa-demo" projectSlug="qos" /></MemoryRouter>);
      rerender(<MemoryRouter><ProjectTabs active="files" orgSlug="isa-demo" projectSlug="qos" /></MemoryRouter>);

      expect(scrolled.map((tab) => tab.textContent)).toEqual(['Cases', 'Files']);
    });
  });
});
