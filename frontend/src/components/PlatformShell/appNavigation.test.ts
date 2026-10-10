import { describe, expect, it } from 'vitest';
import { routeDefinitions, routesByDomain } from '../../routes/registry';
import { currentSection, isToolActive, toolLinks, type MainSection } from './appNavigation';

/** The entry of the main navigation each screen of routes/d1..d8 belongs to. Every other screen leaves them all unmarked. */
const SECTION_OF: Record<string, readonly string[]> = {
  home: ['app-home', 'org-create', 'org-overview', 'org-settings', 'org-members', 'org-audit', 'proj-create', 'proj-overview', 'lib-list', 'lib-artifact', 'lib-draft', 'lib-version'],
  jobs: ['job-launch', 'job-list', 'job-detail', 'job-history'],
  analysis: ['analysis-sources', 'analysis-workspace'],
  explore: ['pub-explore'],
  tools: ['eng-catalog', 'eng-detail', 'lang-profiles', 'lang-schemas', 'gen-lab', 'verifier', 'eng-register', 'eng-registrations', 'eng-registration-detail', 'lang-extensions'],
  admin: routeDefinitions.filter((definition) => definition.id.startsWith('admin-')).map((definition) => definition.id),
};

const expectedSection = (id: string): MainSection => (Object.entries(SECTION_OF).find(([, ids]) => ids.includes(id))?.[0] as MainSection | undefined) ?? null;
const example = (path: string) => path.replace(':org', 'isa-demo').replace(':project', 'qos').replace(/:[A-Za-z]+/g, 'sample');

describe('currentSection', () => {
  it('names only screens that exist', () => {
    const ids = new Set(routeDefinitions.map((definition) => definition.id));
    for (const listed of Object.values(SECTION_OF)) for (const id of listed) expect(ids.has(id), id).toBe(true);
  });

  it.each(Object.keys(routesByDomain))('marks the entry of every screen of domain %s', (domain) => {
    const screens = routesByDomain[domain as keyof typeof routesByDomain];
    expect(screens.length).toBeGreaterThan(0);
    for (const screen of screens) {
      expect(currentSection(example(screen.path)), `${screen.id} ${screen.path}`).toBe(expectedSection(screen.id));
    }
  });

  it('leaves Home alone inside a project: its tabs say where it is', () => {
    for (const section of ['cases', 'cases/checkout', 'library', 'studies', 'studies/new', 'studies/s1/runs/r1', 'reports', 'publications', 'files', 'resources', 'collections', 'package', 'settings', 'workbench']) {
      expect(currentSection(`/app/isa-demo/qos/${section}`), section).toBeNull();
    }
    expect(currentSection('/app/isa-demo/qos')).toBe('home');
  });

  it('keeps the jobs of a project under Jobs, and the organization screens under Home', () => {
    expect(currentSection('/app/isa-demo/qos/jobs')).toBe('jobs');
    expect(currentSection('/app/isa-demo/qos/jobs/new')).toBe('jobs');
    for (const path of ['/app/isa-demo', '/app/isa-demo/settings', '/app/isa-demo/settings/audit', '/app/isa-demo/library/art-1/versions/v1', '/app/isa-demo/new-project']) {
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
