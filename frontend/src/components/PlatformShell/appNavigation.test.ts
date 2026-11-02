import { matchRoutes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { Organization, Project } from '../../api/platform';
import { movedRoutes, routeDefinitions } from '../../routes/registry';
import {
  accountLinks, createItems, currentSection, labEntries, labEntryOf, labLinks, mainLinks, NEEDS_PROJECT, problemsEntry,
  type MenuEntry,
} from './appNavigation';

const organization = { slug: 'isa-demo', name: 'ISA demo' } as Organization;
const project = { slug: 'qos', name: 'QoS' } as Project;

/** The screens, and the old addresses that stay valid on purpose (`permanent`): a link of the navigation may lead to either. */
const routed = [
  ...routeDefinitions.map((definition) => ({ id: definition.id, path: definition.path })),
  ...movedRoutes.filter((route) => route.permanent).map((route) => ({ id: route.id, path: route.path })),
];
const pathOf = (address: string) => address.split(/[?#]/)[0];
const addressesOf = (entries: readonly MenuEntry[]) => entries.flatMap((entry) => (entry.to ? [entry.to] : []));

describe('mainLinks', () => {
  // [utest->req~frontend-nav-signed-in-navigation~1]
  it('lists Home, Engines, Language and Admin, each leading to a routed address and none to a retired path', () => {
    expect(Object.keys(mainLinks)).toEqual(['home', 'engines', 'language', 'admin']);
    expect(Object.values(mainLinks).map((link) => [link.label, link.to])).toEqual([
      ['Home', '/app'], ['Engines', '/engines'], ['Language', '/language'], ['Admin', '/app/admin'],
    ]);
    for (const link of Object.values(mainLinks)) {
      expect(link.to).not.toMatch(/^\/app\/analysis([/?#]|$)/);
      expect(matchRoutes(routed, link.to), link.to).not.toBeNull();
    }
  });

  // [utest->req~frontend-retire-reports-navigation~1]
  // [utest->req~frontend-retire-library-navigation~1]
  it('offers no entry of the header, Lab, New or account menus that leads to a report, library or resources address', () => {
    const addresses = [
      ...Object.values(mainLinks).map((link) => link.to),
      ...addressesOf([problemsEntry(organization, project)]),
      ...addressesOf(labEntries(organization, project)),
      ...addressesOf(createItems(organization, project)),
      ...accountLinks.map((link) => link.to),
    ];
    expect(addresses.length).toBeGreaterThan(15);
    expect(addresses.filter((address) => /\/(reports|library|resources)([/?#]|$)/.test(address))).toEqual([]);
  });
});

describe('problemsEntry and labEntries', () => {
  // [utest->req~frontend-nav-signed-in-navigation~1]
  it('lead into the current project, and Runs and Generator do not need one', () => {
    expect(problemsEntry(organization, project)).toEqual({ label: 'Problems', to: '/app/isa-demo/qos/problems' });
    expect(labEntries(organization, project).map(({ id, label, to }) => [id, label, to])).toEqual([
      ['runs', 'Runs', '/app/runs'], ['studies', 'Studies', '/app/isa-demo/qos/studies'], ['generator', 'Generator', '/app/generator'],
    ]);
    for (const address of [...addressesOf([problemsEntry(organization, project)]), ...addressesOf(labEntries(organization, project))]) {
      expect(matchRoutes(routed, address), address).not.toBeNull();
    }
  });

  // [utest->req~frontend-nav-signed-in-navigation~1]
  it('disables Problems and Studies with the hint "Needs a project" without a current project', () => {
    expect(NEEDS_PROJECT).toBe('Needs a project');
    expect(problemsEntry(organization)).toEqual({ label: 'Problems', hint: 'Needs a project' });
    expect(problemsEntry()).toEqual({ label: 'Problems', hint: 'Needs a project' });
    expect(labEntries(organization).map(({ label, to, hint }) => [label, to, hint])).toEqual([
      ['Runs', labLinks.runs.to, undefined], ['Studies', undefined, 'Needs a project'], ['Generator', labLinks.generator.to, undefined],
    ]);
  });
});

describe('createItems', () => {
  // [utest->req~frontend-nav-new-menu~1]
  it('offers Problem, Collection, Study and Run in the current project, in this order', () => {
    expect(createItems(organization, project).map((item) => [item.label, item.to])).toEqual([
      ['Problem', '/app/isa-demo/qos/problems?create=problem'],
      ['Collection', '/app/isa-demo/qos/collections?create=collection'],
      ['Study', '/app/isa-demo/qos/studies/new'],
      ['Run', '/app/isa-demo/qos/runs/new'],
    ]);
    for (const address of addressesOf(createItems(organization, project))) {
      expect(matchRoutes(routed, pathOf(address)), address).not.toBeNull();
    }
  });

  // [utest->req~frontend-nav-new-menu~1]
  it('disables the four items with the hint "Needs a project" when no project is current', () => {
    for (const items of [createItems(), createItems(organization)]) {
      expect(items.map((item) => [item.label, item.to, item.hint])).toEqual([
        ['Problem', undefined, 'Needs a project'], ['Collection', undefined, 'Needs a project'],
        ['Study', undefined, 'Needs a project'], ['Run', undefined, 'Needs a project'],
      ]);
    }
  });

  // [utest->req~frontend-nav-new-menu~1]
  it('has none of the former items', () => {
    const labels = createItems(organization, project).map((item) => item.label);
    for (const former of ['Organization', 'Project', 'Case', 'Job', 'API key', 'Engine']) expect(labels).not.toContain(former);
  });
});

describe('accountLinks', () => {
  // [utest->req~frontend-nav-account-menu~1]
  it('lists Profile, Plan, API keys, Identities and Notifications with their addresses, all routed', () => {
    expect(accountLinks.map((link) => [link.label, link.to])).toEqual([
      ['Profile', '/app/account'], ['Plan', '/app/account/usage'], ['API keys', '/app/account/keys'],
      ['Identities', '/app/account/identities'], ['Notifications', '/app/account/notifications'],
    ]);
    for (const link of accountLinks) expect(matchRoutes(routed, link.to), link.to).not.toBeNull();
  });
});

describe('currentSection', () => {
  // [utest->req~frontend-nav-signed-in-navigation~1]
  it.each([
    ['/app', 'home'],
    ['/app/isa-demo', 'home'],
    ['/app/isa-demo/qos', 'home'],
    ['/app/isa-demo/settings/members', 'home'],
    ['/app/isa-demo/qos/problems', 'problems'],
    ['/app/isa-demo/qos/problems/routing', 'problems'],
    ['/app/runs', 'lab'],
    ['/app/isa-demo/qos/runs', 'lab'],
    ['/app/isa-demo/qos/runs/new', 'lab'],
    ['/app/isa-demo/qos/studies', 'lab'],
    ['/app/isa-demo/qos/studies/engines-vs-seeds', 'lab'],
    ['/app/generator', 'lab'],
    ['/engines', 'engines'],
    ['/app/engines/registrations', 'engines'],
    ['/language', 'language'],
    ['/language/extensions', 'language'],
    ['/app/admin', 'admin'],
    ['/app/admin/audit', 'admin'],
    ['/app/isa-demo/qos/published', null],
    ['/app/isa-demo/qos/settings', null],
    ['/app/account/usage', null],
    ['/app/system/states', null],
    ['/explore', null],
    ['/verify', null],
  ] as const)('marks %s as %s', (pathname, expected) => {
    expect(currentSection(pathname)).toBe(expected);
  });

  it('marks every admin screen of the registry as Admin', () => {
    const admin = routeDefinitions.filter((definition) => definition.requireAdmin);
    expect(admin.length).toBeGreaterThan(0);
    for (const definition of admin) {
      expect(currentSection(definition.path.replace(/:[A-Za-z]+\??/g, 'sample')), definition.path).toBe('admin');
    }
  });

  it('marks the entry of each header link at its own address', () => {
    expect(currentSection(mainLinks.home.to)).toBe('home');
    expect(currentSection(mainLinks.engines.to)).toBe('engines');
    expect(currentSection(mainLinks.language.to)).toBe('language');
    expect(currentSection(mainLinks.admin.to)).toBe('admin');
    expect(currentSection(labLinks.runs.to)).toBe('lab');
    expect(currentSection(labLinks.generator.to)).toBe('lab');
  });
});

describe('labEntryOf', () => {
  it('tells the entry of the Lab menu an address belongs to', () => {
    expect(labEntryOf('/app/runs')).toBe('runs');
    expect(labEntryOf('/app/isa-demo/qos/runs/job-1')).toBe('runs');
    expect(labEntryOf('/app/isa-demo/qos/studies/s1')).toBe('studies');
    expect(labEntryOf('/app/generator')).toBe('generator');
    expect(labEntryOf('/app/isa-demo/qos/problems')).toBeNull();
    expect(labEntryOf('/app')).toBeNull();
  });
});
