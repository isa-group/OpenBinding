import { isValidElement } from 'react';
import { matchRoutes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { movedRoutes, routeDefinitions } from './registry';

// The list of each area, its size and the tests about its own screens are in areas/<area>.test.ts; the total is in screenBudget.test.ts.

const P = '/app/:org/:project';

/** An address the path leads to: an optional segment (`:section?`) dropped with its slash, every other parameter filled. */
const sample = (path: string) => path.replace(/\/:[A-Za-z]+\?/g, '').replace(/:[A-Za-z]+/g, 'sample') || '/';

describe('route registry', () => {
  // [utest->req~frontend-retire-library-screens-not-routed~1]
  it('declares none of the library catalogue and project resources screens', () => {
    const ids = routeDefinitions.map((definition) => definition.id);
    const paths = routeDefinitions.map((definition) => definition.path);
    for (const id of ['lib-list', 'lib-artifact', 'lib-draft', 'lib-version', 'proj-library', 'proj-resources', 'proj-resource-detail']) {
      expect(ids, id).not.toContain(id);
    }
    expect(paths.filter((path) => /\/(library|resources)(\/|$)/.test(path))).toEqual([]);
  });

  // [utest->req~frontend-retire-screens-not-routed~1]
  it('declares no screen retired by M2.4', () => {
    const ids = routeDefinitions.map((definition) => definition.id);
    const paths = routeDefinitions.map((definition) => definition.path);
    expect(ids).not.toContain('analysis-sources');
    expect(ids).not.toContain('analysis-workspace');
    expect(paths).not.toContain('/app/analysis');
    expect(paths).not.toContain('/app/analysis/workspace');
  });

  // [utest->req~frontend-retire-reports-screens-not-routed~1]
  it('declares neither the report list nor the report editor', () => {
    const ids = routeDefinitions.map((definition) => definition.id);
    const paths = routeDefinitions.map((definition) => definition.path);
    expect(ids).not.toContain('rep-list');
    expect(ids).not.toContain('rep-detail');
    expect(paths).not.toContain(`${P}/reports`);
    expect(paths).not.toContain(`${P}/reports/:report`);
    expect(paths.filter((path) => /\/reports(\/|$)/.test(path))).toEqual([]);
  });

  it('uses unique ids and unique paths', () => {
    const ids = routeDefinitions.map((definition) => definition.id);
    const paths = routeDefinitions.map((definition) => definition.path);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('places every screen under /app in the application layout and the rest in the public layout', () => {
    for (const definition of routeDefinitions) {
      const underApp = definition.path === '/app' || definition.path.startsWith('/app/');
      expect(definition.layout, definition.id).toBe(underApp ? 'app' : 'public');
      expect(Boolean(definition.requireAuth), definition.id).toBe(underApp);
    }
  });

  it('lets a screen that switches header with the session be public, without ever requiring one', () => {
    const adaptive = routeDefinitions.filter((definition) => definition.sessionHeader);
    for (const definition of adaptive) {
      expect(definition.layout, definition.id).toBe('public');
      expect(definition.requireAuth, definition.id).toBe(false);
    }
  });

  // [utest->req~frontend-retire-sponsorship-screen-not-routed~1]
  it('requires an administrator for every admin screen and for nothing else', () => {
    const admin = routeDefinitions.filter((definition) => definition.id.startsWith('admin-'));
    expect(admin.length).toBeGreaterThan(0);
    for (const definition of admin) {
      expect(definition.requireAdmin, definition.id).toBe(true);
      expect(definition.path, definition.id).toMatch(/^\/app\/admin(\/|$)/);
    }
    expect(routeDefinitions.filter((definition) => definition.requireAdmin)).toHaveLength(admin.length);
  });

  it('has no pending screen left: every definition renders a real page, never a placeholder', () => {
    const placeholders = routeDefinitions.filter((definition) => !isValidElement(definition.element)).map((definition) => definition.id);
    expect(placeholders).toEqual([]);
    expect(routeDefinitions.filter((definition) => 'status' in definition)).toEqual([]);
  });

  it('resolves every route pattern to its own screen', () => {
    const config = routeDefinitions.map((definition) => ({ id: definition.id, path: definition.path }));
    for (const definition of routeDefinitions) {
      const matches = matchRoutes(config, sample(definition.path));
      expect(matches?.at(-1)?.route.id, `${definition.path} -> ${definition.id}`).toBe(definition.id);
    }
  });

  // [utest->req~frontend-retire-library-screens-not-routed~1]
  it('answers the retired library addresses by no screen of the registry', () => {
    const config = routeDefinitions.map((definition) => ({ id: definition.id, path: definition.path }));
    const retired = [
      '/app/acme/library/a1', '/app/acme/library/a1/drafts/d1', '/app/acme/library/a1/versions/v1',
      '/app/acme/atlas/library', '/app/acme/atlas/resources', '/app/acme/atlas/resources/r1',
    ];
    for (const path of retired) expect(matchRoutes(config, path), path).toBeNull();
    // Without its screen `/app/acme/library` reads as a project named `library`, which the redirect table answers first. It is the
    // screen of any project, the one `/app/acme/atlas` shows.
    const id = matchRoutes(config, '/app/acme/library')?.at(-1)?.route.id;
    expect(id).toBeDefined();
    expect(id).toBe(matchRoutes(config, '/app/acme/atlas')?.at(-1)?.route.id);
  });

  // [utest->req~frontend-retire-reports-screens-not-routed~1]
  it('answers the retired report addresses by no screen of the registry', () => {
    const config = routeDefinitions.map((definition) => ({ id: definition.id, path: definition.path }));
    for (const path of ['/app/acme/atlas/reports', '/app/acme/atlas/reports/engine-comparison']) expect(matchRoutes(config, path), path).toBeNull();
  });

  it('no longer serves the legacy routes that have no equivalent in the prototype', () => {
    const config = routeDefinitions.map((definition) => ({ id: definition.id, path: definition.path }));
    const legacy = [
      '/playground', '/engines/new', '/team', '/research', '/funding', '/contributions', '/changelog',
      '/profiles', '/schemas', '/app/acme/atlas/verifier', '/app/acme/atlas/analytics', '/app/acme/atlas/artifacts',
    ];
    for (const path of legacy) expect(matchRoutes(config, path), path).toBeNull();
  });

  it('declares no legacy parameter names: every detail page reads the prototype ones', () => {
    expect(routeDefinitions.filter((definition) => 'paramAliases' in definition)).toEqual([]);
  });

  // [utest->req~frontend-nav-redirects~1]
  it('gives every moved address an id and a path of its own, never the address of a screen', () => {
    const ids = [...routeDefinitions, ...movedRoutes].map((route) => route.id);
    const paths = [...routeDefinitions, ...movedRoutes].map((route) => route.path);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(paths).size).toBe(paths.length);
  });
});
