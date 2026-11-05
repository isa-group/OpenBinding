import { matchRoutes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { followMoved } from '../followMoved';
import { movedRoutes, routeDefinitions, routesByArea } from '../registry';
import { moved as moves } from './project';

// One pair per line: screenBudget.test.ts counts them.
const SCREENS: Array<[string, string]> = [
  ['proj-overview', '/app/:org/:project'],
  ['proj-settings', '/app/:org/:project/settings/:section?'],
  ['proj-publications', '/app/:org/:project/published'],
];

const config = routeDefinitions.map((definition) => ({ id: definition.id, path: definition.path }));
const resolve = (path: string) => matchRoutes(config, path)?.at(-1)?.route.id;
const entry = (path: string) => moves.find((route) => route.path === path);
const idsOfScreens = routeDefinitions.map((definition) => definition.id);

describe('area project', () => {
  it('has 3 screens: the overview, the settings and the published results', () => {
    expect(routesByArea.project).toHaveLength(3);
    expect(routesByArea.project.map((definition) => [definition.id, definition.path])).toEqual(SCREENS);
  });

  it('declares neither proj-files nor proj-package', () => {
    expect(idsOfScreens).not.toContain('proj-files');
    expect(idsOfScreens).not.toContain('proj-package');
    expect(routeDefinitions.map((definition) => definition.path)).not.toContain('/app/:org/:project/files');
    expect(routeDefinitions.map((definition) => definition.path)).not.toContain('/app/:org/:project/package');
  });

  it('keeps the published results, which hold nothing about reports', () => {
    expect(idsOfScreens).toContain('proj-publications');
  });

  it('resolves the published address through the route definitions, and no longer the publications one', () => {
    expect(resolve('/app/acme/atlas/published')).toBe('proj-publications');
    expect(resolve('/app/acme/atlas/publications') ?? null).toBeNull();
  });

  it('declares no creation screen: a new project is made in a dialog over the organization', () => {
    expect(idsOfScreens).not.toContain('proj-create');
    expect(routeDefinitions.map((definition) => definition.path)).not.toContain('/app/:org/new-project');
  });

  describe('address resolution', () => {
    it.each([
      ['/app/acme/atlas', 'proj-overview'],
      ['/app/acme/atlas/settings', 'proj-settings'],
      ['/app/acme/atlas/settings/members', 'proj-settings'],
      ['/app/acme/atlas/settings/anything', 'proj-settings'],
      ['/app/acme/atlas/published', 'proj-publications'],
      ['/app/acme/atlas/package', null],
      ['/app/acme/atlas/files', null],
      ['/app/acme/atlas/publications', null],
    ])('%s -> %s', (path, id) => {
      expect(resolve(path) ?? null).toBe(id);
    });
  });
});

describe('the moved addresses of the project area', () => {
  const org = 'acme';
  const project = 'atlas';
  const target = (path: string, search = '') => entry(path)?.target(new URLSearchParams(search), { org, project });

  it('declares the creation address, publications, files and package, with ids of their own', () => {
    expect(moves.map((route) => route.path)).toEqual([
      '/app/:org/new-project',
      '/app/:org/:project/publications',
      '/app/:org/:project/files',
      '/app/:org/:project/package',
    ]);
    for (const route of moves) expect(idsOfScreens).not.toContain(route.id);
  });

  it('moves the old creation address to the dialog over the organization, and drops its query', () => {
    expect(target('/app/:org/new-project')).toBe('/app/acme?create=project');
    expect(target('/app/:org/new-project', 'a=1')).toBe('/app/acme?create=project');
    expect(entry('/app/:org/new-project')?.permanent).toBeUndefined();
    expect(resolve('/app/acme')).toBe('org-overview');
  });

  it('keeps no hash on the creation address either', () => {
    expect(entry('/app/:org/new-project')?.keepQuery).toBe(false);
    for (const address of ['/app/acme/new-project?a=1#x', '/app/acme/new-project#x']) {
      const end = followMoved(address, routeDefinitions, movedRoutes);
      expect(end).toBe('/app/acme?create=project');
      expect(new URL(end, 'http://localhost').hash).toBe('');
    }
  });

  it('moves the publications to the published results and keeps the query', () => {
    expect(target('/app/:org/:project/publications')).toBe('/app/acme/atlas/published');
    expect(target('/app/:org/:project/publications', 'a=1')).toBe('/app/acme/atlas/published?a=1');
    expect(entry('/app/:org/:project/publications')?.permanent).toBeUndefined();
  });

  it('moves the files to the project overview, as a permanent address, and the package to the settings', () => {
    expect(target('/app/:org/:project/files', 'a=1')).toBe('/app/acme/atlas');
    expect(entry('/app/:org/:project/files')?.permanent).toBe(true);
    expect(target('/app/:org/:project/package', 'a=1')).toBe('/app/acme/atlas/settings');
    expect(entry('/app/:org/:project/package')?.permanent).toBeUndefined();
  });

  it('leads every entry to a screen of the registry', () => {
    for (const route of moves) {
      const address = route.target(new URLSearchParams(''), { org, project });
      expect(resolve(address.split(/[?#]/)[0]), address).toBeDefined();
    }
  });

  it('gives every moved entry an id that no screen and no other entry uses', () => {
    const ids = [...idsOfScreens, ...movedRoutes.map((route) => route.id)];
    expect(new Set(ids).size).toBe(ids.length);
  });
});
