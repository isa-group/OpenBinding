import { describe, expect, it } from 'vitest';
import type { Organization, Project } from '../../api/platform';
import { routeDefinitions, routesByArea } from '../../routes/registry';
import { accountLinks, createItems, currentSection, isToolActive, mainLinks, toolLinks, type MainSection } from './appNavigation';

/** The entry of the main navigation each screen of the registry (routes/areas) belongs to. Every other screen leaves them all unmarked. */
const SECTION_OF: Record<string, readonly string[]> = {
  home: ['app-home', 'org-create', 'org-overview', 'org-settings', 'org-members', 'org-audit', 'proj-create', 'proj-overview'],
  jobs: ['job-launch', 'job-list', 'job-detail', 'job-history'],
  explore: ['pub-explore'],
  tools: ['eng-catalog', 'eng-detail', 'lang-profiles', 'lang-schemas', 'gen-lab', 'verifier', 'eng-register', 'eng-registrations', 'eng-registration-detail', 'lang-extensions'],
  admin: routeDefinitions.filter((definition) => definition.id.startsWith('admin-')).map((definition) => definition.id),
};

const expectedSection = (id: string): MainSection => (Object.entries(SECTION_OF).find(([, ids]) => ids.includes(id))?.[0] as MainSection | undefined) ?? null;
const example = (path: string) => path.replace(':org', 'isa-demo').replace(':project', 'qos').replace(/:[A-Za-z]+/g, 'sample');

describe('mainLinks', () => {
  // [utest->req~frontend-retire-navigation~1]
  it('lists Home, Jobs, Explore and Admin, none of them a retired path', () => {
    expect(Object.values(mainLinks).map((link) => link.to)).toEqual(['/app', '/app/jobs', '/explore', '/app/admin']);
    for (const link of Object.values(mainLinks)) expect(link.to).not.toMatch(/^\/app\/analysis([/?#]|$)/);
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
});

describe('currentSection', () => {
  it('names only screens that exist', () => {
    const ids = new Set(routeDefinitions.map((definition) => definition.id));
    for (const listed of Object.values(SECTION_OF)) for (const id of listed) expect(ids.has(id), id).toBe(true);
  });

  it.each(Object.keys(routesByArea))('marks the entry of every screen of area %s', (area) => {
    const screens = routesByArea[area as keyof typeof routesByArea];
    expect(screens.length).toBeGreaterThan(0);
    for (const screen of screens) {
      expect(currentSection(example(screen.path)), `${screen.id} ${screen.path}`).toBe(expectedSection(screen.id));
    }
  });

  it('leaves Home alone inside a project: its tabs say where it is', () => {
    for (const section of ['cases', 'cases/checkout', 'studies', 'studies/new', 'studies/s1/runs/r1', 'publications', 'files', 'collections', 'package', 'settings', 'workbench']) {
      expect(currentSection(`/app/isa-demo/qos/${section}`), section).toBeNull();
    }
    expect(currentSection('/app/isa-demo/qos')).toBe('home');
  });

  it('keeps the jobs of a project under Jobs, and the organization screens under Home', () => {
    expect(currentSection('/app/isa-demo/qos/jobs')).toBe('jobs');
    expect(currentSection('/app/isa-demo/qos/jobs/new')).toBe('jobs');
    for (const path of ['/app/isa-demo', '/app/isa-demo/settings', '/app/isa-demo/settings/audit', '/app/isa-demo/new-project']) {
      expect(currentSection(path), path).toBe('home');
    }
  });
});

describe('isToolActive', () => {
  it('marks the tool whose address the page is under, and no other', () => {
    const marked = (pathname: string) => toolLinks.filter((link) => isToolActive(pathname, link)).map((link) => link.label);

    expect(marked('/app/verifier')).toEqual(['Verifier']);
    expect(marked('/engines/isa/solver/1.0.0')).toEqual(['Engine catalog']);
    expect(marked('/app/engines/registrations/edge-solver')).toEqual(['My engines']);
    expect(marked('/app/engines/new')).toEqual(['My engines']);
    expect(marked('/app/language/extensions')).toEqual(['Language extensions']);
    expect(marked('/app/generator')).toEqual(['Generator lab']);
    expect(marked('/language/schemas/application')).toEqual(['Language docs']);
    expect(marked('/app/isa-demo/qos/studies')).toEqual([]);
  });
});
