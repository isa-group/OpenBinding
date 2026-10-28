import { matchRoutes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { Organization, Project } from '../../api/platform';
import { movedRoutes, routeDefinitions, routesByArea, type AreaName } from '../../routes/registry';
import type { RouteDefinition } from '../../routes/types';
import { accountLinks, createItems, currentSection, isToolActive, mainLinks, toolLinks, type MainSection } from './appNavigation';

// The expectations come from the registry (routes/areas) and from the navigation data under test (mainLinks, toolLinks, accountLinks), not
// from the id of any screen: a change that merges, moves or removes the screens of one area leaves them alone.

const under = (path: string, root: string) => path === root || path.startsWith(`${root}/`);
/** The part of an address that names a place of its own: `/app/<place>` under the application, the first segment elsewhere. */
const rootOf = (to: string) => to.split('/').slice(0, to.startsWith('/app/') ? 3 : 2).join('/');

/** An address the path leads to: an optional segment dropped, the example organization and project, any other parameter filled. */
const example = (path: string) => path
  .replace(/\/:[A-Za-z]+\?/g, '')
  .replace(':org', 'isa-demo')
  .replace(':project', 'qos')
  .replace(/:[A-Za-z]+/g, 'sample') || '/';

const toolRoots = toolLinks.map((link) => rootOf(link.to));
/** The segment that names the jobs below a project: the last segment of the Jobs entry's address. */
const jobsSegment = mainLinks.jobs.to.split('/').at(-1);
const isProjectJobs = (address: string) => new RegExp(`^/app/[^/]+/[^/]+/${jobsSegment}(/|$)`).test(address);

const areaOf = Object.fromEntries(
  Object.entries(routesByArea).flatMap(([area, screens]) => screens.map((screen) => [screen.id, area as AreaName] as const)),
);

/** The entry of the main navigation a screen of the registry belongs to. Every other screen leaves them all unmarked. */
function expectedSection(definition: RouteDefinition): MainSection {
  const address = example(definition.path);
  if (definition.requireAdmin) return 'admin';
  if (under(address, mainLinks.jobs.to) || isProjectJobs(address)) return 'jobs';
  if (toolRoots.some((root) => under(address, root))) return 'tools';
  if (under(address, mainLinks.explore.to)) return 'explore';
  const area = areaOf[definition.id];
  // The workspace home is where organizations and projects are browsed: the screens of an organization, and a project's overview. The
  // sections inside a project mark themselves in the project tabs.
  if (area === 'organizations') return 'home';
  if (area === 'project') return address.split('/').filter(Boolean).length <= 3 ? 'home' : null;
  return null;
}

/** The screens, and the old addresses that stay valid on purpose (`permanent`): a link of the navigation may lead to either. */
const routed = [
  ...routeDefinitions.map((definition) => ({ id: definition.id, path: definition.path })),
  ...movedRoutes.filter((route) => route.permanent).map((route) => ({ id: route.id, path: route.path })),
];

describe('mainLinks', () => {
  // [utest->req~frontend-retire-navigation~1]
  it('lists Home, Jobs, Explore and Admin, each leading to a routed address and none to a retired path', () => {
    expect(Object.keys(mainLinks)).toEqual(['home', 'jobs', 'explore', 'admin']);
    for (const link of Object.values(mainLinks)) {
      expect(link.to).not.toMatch(/^\/app\/analysis([/?#]|$)/);
      expect(matchRoutes(routed, link.to), link.to).not.toBeNull();
    }
  });

  // [utest->req~frontend-retire-reports-navigation~1]
  it('offers no entry of the main, tool, account or New menus that leads to a report address', () => {
    const organization = { slug: 'isa-demo', name: 'ISA demo' } as Organization;
    const project = { slug: 'qos', name: 'QoS' } as Project;
    const addresses = [
      ...Object.values(mainLinks).map((link) => link.to),
      ...toolLinks.map((link) => link.to),
      ...accountLinks.map((link) => link.to),
      ...createItems(organization, project).flatMap((item) => (item.to ? [item.to] : [])),
    ];
    expect(addresses.length).toBeGreaterThan(15);
    expect(addresses.filter((address) => /\/reports([/?#]|$)/.test(address))).toEqual([]);
  });

  // [utest->req~frontend-retire-library-navigation~1]
  it('offers no entry of the main, tool, account or New menus that leads to the library catalogue or the resources', () => {
    const organization = { slug: 'isa-demo', name: 'ISA demo' } as Organization;
    const project = { slug: 'qos', name: 'QoS' } as Project;
    const addresses = [
      ...Object.values(mainLinks).map((link) => link.to),
      ...toolLinks.map((link) => link.to),
      ...accountLinks.map((link) => link.to),
      ...createItems(organization, project).flatMap((item) => (item.to ? [item.to] : [])),
    ];
    expect(addresses.filter((address) => /\/(library|resources)([/?#]|$)/.test(address))).toEqual([]);
  });

  it('leads every entry of the tool and account menus to a routed address', () => {
    for (const link of [...toolLinks, ...accountLinks]) expect(matchRoutes(routed, link.to), `${link.label} ${link.to}`).not.toBeNull();
  });
});

describe('currentSection', () => {
  it('marks the entry of each main link at its own address', () => {
    for (const [section, link] of Object.entries(mainLinks)) expect(currentSection(link.to), link.to).toBe(section);
  });

  it('marks the tools entry at the address of each tool', () => {
    for (const link of toolLinks) expect(currentSection(link.to), link.to).toBe('tools');
  });

  it.each(Object.keys(routesByArea))('marks the entry of every screen of area %s', (area) => {
    for (const screen of routesByArea[area as AreaName]) {
      expect(currentSection(example(screen.path)), `${screen.id} ${screen.path}`).toBe(expectedSection(screen));
    }
  });

  it('leaves Home alone inside a project: its tabs say where it is', () => {
    const inside = routeDefinitions.filter((definition) => /^\/app\/:org\/:project\/[^/]/.test(definition.path) && !isProjectJobs(example(definition.path)));
    expect(inside.length).toBeGreaterThan(0);
    for (const definition of inside) expect(currentSection(example(definition.path)), definition.path).toBeNull();
    expect(currentSection('/app/isa-demo/qos')).toBe('home');
  });

  it('keeps the jobs of a project under Jobs', () => {
    expect(currentSection(`/app/isa-demo/qos/${jobsSegment}`)).toBe('jobs');
    expect(currentSection(`/app/isa-demo/qos/${jobsSegment}/new`)).toBe('jobs');
  });
});

describe('isToolActive', () => {
  const marked = (pathname: string) => toolLinks.filter((link) => isToolActive(pathname, link)).map((link) => link.label);

  it('marks the tool whose address the page is under, and no other', () => {
    for (const link of toolLinks) {
      expect(marked(link.to), link.to).toEqual([link.label]);
      expect(marked(`${link.to}/something/else`), `${link.to}/something/else`).toEqual([link.label]);
    }
    expect(marked('/app/isa-demo/qos')).toEqual([]);
  });

  it('marks a tool for every screen of the registry that sits under the tools entry', () => {
    const screens = routeDefinitions.filter((definition) => expectedSection(definition) === 'tools');
    expect(screens.length).toBeGreaterThan(0);
    for (const screen of screens) expect(marked(example(screen.path)).length, `${screen.id} ${screen.path}`).toBe(1);
  });
});
