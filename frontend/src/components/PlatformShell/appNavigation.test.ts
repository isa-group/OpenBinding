import { matchRoutes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { Organization } from '../../api/platform';
import { screens as routeDefinitions } from '../../routes/router';
import {
  accountLinks,
  createItems,
  currentSection,
  mainLinks,
  NEEDS_ORGANIZATION,
  organizationEntries,
  organizationSectionOf,
  type MenuEntry,
} from './appNavigation';

const organization = { slug: 'isa-demo', name: 'ISA demo' } as Organization;

/** The screens: a link of the navigation leads to one of them. */
const routed = routeDefinitions.map(definition => ({ id: definition.id, path: definition.path }));
const pathOf = (address: string) => address.split(/[?#]/)[0];
const addressesOf = (entries: readonly MenuEntry[]) =>
  entries.flatMap(entry => (entry.to ? [entry.to] : []));

describe('mainLinks', () => {
  it('lists Home, Engines and Admin, each leading to a routed address and none to a retired path', () => {
    expect(Object.keys(mainLinks)).toEqual(['home', 'engines', 'admin']);
    expect(Object.values(mainLinks).map(link => [link.label, link.to])).toEqual([
      ['Home', '/'],
      ['Engines', '/engines'],
      ['Admin', '/app/admin'],
    ]);
    for (const link of Object.values(mainLinks)) {
      expect(link.to).not.toMatch(/^\/app\/analysis([/?#]|$)/);
      expect(matchRoutes(routed, link.to), link.to).not.toBeNull();
    }
  });

  it('offers no entry of the header, New or account menus that leads to a report, library, resources or project address', () => {
    const addresses = [
      ...Object.values(mainLinks).map(link => link.to),
      ...addressesOf(organizationEntries(organization)),
      ...addressesOf(createItems(organization)),
      ...accountLinks.map(link => link.to),
    ];
    expect(addresses.length).toBeGreaterThan(13);
    expect(
      addresses.filter(address => /\/(reports|library|resources)([/?#]|$)/.test(address))
    ).toEqual([]);
    for (const address of addresses) expect(address).not.toMatch(/project/);
  });
});

describe('organizationEntries', () => {
  it('lead into the organization (compositions, problems, runs, studies), in this order', () => {
    expect(organizationEntries(organization).map(({ id, label, to }) => [id, label, to])).toEqual([
      ['compositions', 'Compositions', '/orgs/isa-demo/compositions'],
      ['problems', 'Problems', '/orgs/isa-demo/problems'],
      ['runs', 'Runs', '/orgs/isa-demo/runs'],
      ['studies', 'Studies', '/orgs/isa-demo/studies'],
    ]);
    for (const address of addressesOf(organizationEntries(organization))) {
      expect(matchRoutes(routed, address), address).not.toBeNull();
    }
  });

  it('disables Compositions, Problems, Runs and Studies without an organization', () => {
    expect(NEEDS_ORGANIZATION).toBe('Needs an organization');
    expect(organizationEntries().map(({ label, to, hint }) => [label, to, hint])).toEqual([
      ['Compositions', undefined, 'Needs an organization'],
      ['Problems', undefined, 'Needs an organization'],
      ['Runs', undefined, 'Needs an organization'],
      ['Studies', undefined, 'Needs an organization'],
    ]);
  });
});

describe('createItems', () => {
  it('offers Composition, Problem, Study and Run in the organization, in this order', () => {
    expect(createItems(organization).map(item => [item.label, item.to])).toEqual([
      ['Composition', '/compositions/new?org=isa-demo'],
      ['Problem', '/problem-editor?org=isa-demo'],
      ['Study', '/studies/new?org=isa-demo'],
      ['Run', '/runs/new?org=isa-demo'],
    ]);
    for (const address of addressesOf(createItems(organization))) {
      expect(matchRoutes(routed, pathOf(address)), address).not.toBeNull();
    }
  });

  it('disables every item without an organization', () => {
    expect(createItems().map(item => [item.label, item.to, item.hint])).toEqual([
      ['Composition', undefined, 'Needs an organization'],
      ['Problem', undefined, 'Needs an organization'],
      ['Study', undefined, 'Needs an organization'],
      ['Run', undefined, 'Needs an organization'],
    ]);
  });

  it('has none of the former items', () => {
    const labels = createItems(organization).map(item => item.label);
    for (const former of [
      'Organization',
      'Project',
      'Case',
      'Collection',
      'Job',
      'API key',
      'Engine',
    ])
      expect(labels).not.toContain(former);
  });
});

describe('accountLinks', () => {
  it('lists Settings and its sections, and API keys, with their addresses, all routed', () => {
    expect(accountLinks.map(link => [link.label, link.to])).toEqual([
      ['Settings', '/me/settings'],
      ['Plan', '/me/settings?section=plan'],
      ['API keys', '/me/api-keys'],
      ['Sign-in & Security', '/me/settings?section=integrations'],
      ['Notifications', '/me/settings?section=notifications'],
      ['Appearance', '/me/settings?section=appearance'],
    ]);
    for (const link of accountLinks)
      expect(matchRoutes(routed, pathOf(link.to)), link.to).not.toBeNull();
  });
});

describe('currentSection', () => {
  it.each([
    ['/app', 'home'],
    ['/app/isa-demo', 'home'],
    ['/app/isa-demo/qos', null],
    ['/app/isa-demo/settings/members', 'home'],
    ['/app/isa-demo/compositions', 'compositions'],
    ['/app/isa-demo/compositions/order-desk', 'compositions'],
    ['/app/isa-demo/problems', 'problems'],
    ['/app/isa-demo/problems/routing', 'problems'],
    ['/orgs/isa-demo/runs', 'runs'],
    ['/runs/new', 'runs'],
    ['/runs/isa-demo/job-1', 'runs'],
    ['/app/isa-demo/studies', 'studies'],
    ['/app/isa-demo/studies/engines-vs-seeds', 'studies'],
    ['/app/isa-demo/qos/studies', null],
    ['/engines', 'engines'],
    ['/me/engines', 'engines'],
    ['/language', null],
    ['/app/admin', 'admin'],
    ['/app/admin/users', 'admin'],
    ['/app/isa-demo/qos/published', null],
    ['/app/isa-demo/qos/settings', null],
    ['/me/settings', null],
    ['/explore', null],
  ] as const)('marks %s as %s', (pathname, expected) => {
    expect(currentSection(pathname)).toBe(expected);
  });

  it('marks every admin screen of the registry as Admin', () => {
    const admin = routeDefinitions.filter(definition => definition.requireAdmin);
    expect(admin.length).toBeGreaterThan(0);
    for (const definition of admin) {
      expect(
        currentSection(definition.path.replace(/:[A-Za-z]+\??/g, 'sample')),
        definition.path
      ).toBe('admin');
    }
  });

  it('marks the entry of each header link at its own address', () => {
    expect(currentSection(mainLinks.home.to)).toBe('home');
    expect(currentSection(mainLinks.engines.to)).toBe('engines');
    expect(currentSection(mainLinks.admin.to)).toBe('admin');
  });
});

describe('organizationSectionOf', () => {
  it('tells the organization section an address belongs to', () => {
    expect(organizationSectionOf('/app/isa-demo/runs/job-1')).toBe('runs');
    expect(organizationSectionOf('/app/isa-demo/qos/runs/job-1')).toBeNull();
    expect(organizationSectionOf('/app/isa-demo/studies/s1')).toBe('studies');
    expect(organizationSectionOf('/app/isa-demo/problems')).toBe('problems');
    expect(organizationSectionOf('/app/isa-demo/compositions/order-desk')).toBe('compositions');
    expect(organizationSectionOf('/app/isa-demo/problem-editor')).toBeNull();
    expect(organizationSectionOf('/me/engines')).toBeNull();
    expect(organizationSectionOf('/app')).toBeNull();
  });
});
