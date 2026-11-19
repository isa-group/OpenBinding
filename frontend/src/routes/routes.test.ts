import { isValidElement } from 'react';
import { matchRoutes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { screens } from './router';

// The rules every screen of the table follows. The exact list is in screenBudget.test.ts; what addresses resolve to, in
// matching.test.ts.

const P = '/app/:org/:project';
const config = screens.map(screen => ({ id: screen.id, path: screen.path }));
const ids = screens.map(screen => screen.id);
const paths = screens.map(screen => screen.path);

/** An address the path leads to: an optional segment (`:section?`) dropped with its slash, every other parameter filled. */
const sample = (path: string) =>
  path.replace(/\/:[A-Za-z]+\?/g, '').replace(/:[A-Za-z]+/g, 'sample') || '/';

describe('route table', () => {
  it('declares none of the library catalogue, project and project resources screens', () => {
    for (const id of [
      'lib-list',
      'lib-artifact',
      'lib-draft',
      'lib-version',
      'proj-library',
      'proj-resources',
      'proj-resource-detail',
    ])
      expect(ids, id).not.toContain(id);
    expect(paths.filter(path => /\/(library|resources)(\/|$)/.test(path))).toEqual([]);
  });

  it('declares no screen retired by M2.4, no report screen and no former account, organization or problem screen', () => {
    for (const id of [
      'analysis-sources',
      'analysis-workspace',
      'rep-list',
      'rep-detail',
      'acct-profile',
      'acct-usage',
      'acct-keys',
      'acct-key-new',
      'acct-identities',
      'acct-notifications',
      'org-members',
      'org-presets',
      'org-audit',
      'org-create',
      'pub-explore',
      'pub-status',
    ])
      expect(ids, id).not.toContain(id);
    expect(paths).not.toContain('/app/analysis');
    expect(paths).not.toContain(`${P}/reports`);
    expect(paths.filter(path => /\/(reports|jobs|cases)(\/|$)/.test(path))).toEqual([]);
  });

  it('uses unique ids and unique paths', () => {
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('serves no screen under /app: the old workspace is gone', () => {
    expect(
      screens.filter(screen => screen.path === '/app' || screen.path.startsWith('/app/'))
    ).toEqual([]);
  });

  it('lets a screen that takes the chrome of the session be public: it never requires an account or an administrator', () => {
    const session = screens.filter(screen => screen.layout === 'session');
    expect(session.length).toBeGreaterThan(0);
    for (const screen of session) expect(screen.requireAdmin ?? false, screen.id).toBe(false);
  });

  it('requires an administrator for every admin screen and for nothing else', () => {
    const admin = screens.filter(screen => screen.id === 'admin' || screen.id.startsWith('admin-'));
    expect(admin.length).toBeGreaterThan(0);
    for (const screen of admin) {
      expect(screen.requireAdmin, screen.id).toBe(true);
      expect(screen.path, screen.id).toMatch(/^\/admin(\/|$)/);
    }
    expect(screens.filter(screen => screen.requireAdmin)).toHaveLength(admin.length);
  });

  it('has no pending screen left: every screen renders a real page, never a placeholder', () => {
    expect(
      screens.filter(screen => !isValidElement(screen.element)).map(screen => screen.id)
    ).toEqual([]);
  });

  it('resolves every route pattern to its own screen', () => {
    for (const screen of screens) {
      expect(
        matchRoutes(config, sample(screen.path))?.at(-1)?.route.id,
        `${screen.path} -> ${screen.id}`
      ).toBe(screen.id);
    }
  });

  it('no longer serves the legacy addresses that have no screen', () => {
    for (const path of [
      '/playground',
      '/sso/callback',
      '/engines/new',
      '/funding',
      '/about',
      '/profiles',
      '/schemas',
      '/app/acme/atlas/verifier',
      '/app/acme/atlas/analytics',
      '/app/acme/atlas/artifacts',
      '/language/schemas/Instance',
      '/language/extensions',
      '/app/acme/library',
      '/app/acme/library/a1',
      '/app/acme/atlas/reports',
      '/app/acme/atlas/reports/engine-comparison',
      '/password-reset/complete',
      '/password-reset',
      '/login',
      '/register',
      '/auth/cas/callback',
    ])
      expect(matchRoutes(config, path), path).toBeNull();
  });

  it('keeps no redirect table: every address the application answers is a screen of the table', () => {
    const files = import.meta.glob('./**/*.{ts,tsx}', {
      query: '?raw',
      import: 'default',
      eager: true,
    }) as Record<string, string>;
    const sources = Object.entries(files).filter(([path]) => !/\.test\.tsx?$/.test(path));
    expect(sources.length).toBeGreaterThan(3);
    expect(
      sources
        .filter(([, source]) => /<Navigate\b|\bmovedRoutes\b|\bRETIRED_ROUTES\b/.test(source))
        .map(([path]) => path)
    ).toEqual([]);
  });
});
