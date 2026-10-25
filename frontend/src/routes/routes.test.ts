import { isValidElement } from 'react';
import { matchRoutes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { routeDefinitions, routesByDomain } from './registry';

const P = '/app/:org/:project';

/** The authoritative screen list of the design prototype (Index.dc.html): [id, route] per domain. */
const PROTOTYPE: Record<keyof typeof routesByDomain, Array<[string, string]>> = {
  D1: [
    ['pub-home', '/'], ['pub-explore', '/explore'], ['pub-resolve', '/resolve/:kind/:digest'], ['eng-catalog', '/engines'],
    ['eng-detail', '/engines/:namespace/:name/:version'], ['lang-profiles', '/language'], ['lang-schemas', '/language/schemas/:kind'],
    ['lang-examples', '/examples'], ['pub-workbench', '/workbench'], ['pub-about', '/about'], ['pub-status', '/status'],
    ['auth-login', '/login'], ['auth-register', '/register'], ['auth-reset-request', '/password-reset'],
    ['auth-reset-complete', '/password-reset/complete'], ['auth-cas-callback', '/auth/cas/callback'],
    ['org-invite-accept', '/invitations/accept'], ['sys-states', '/app/system/states'],
  ],
  D2: [
    ['pub-pricing', '/pricing'], ['acct-profile', '/app/account'], ['acct-usage', '/app/account/usage'],
    ['acct-keys', '/app/account/keys'], ['acct-key-new', '/app/account/keys/new'], ['acct-identities', '/app/account/identities'],
    ['acct-notifications', '/app/account/notifications'],
  ],
  D3: [
    ['app-home', '/app'], ['org-create', '/app/organizations/new'], ['org-overview', '/app/:org'], ['org-settings', '/app/:org/settings'],
    ['org-members', '/app/:org/settings/members'], ['org-audit', '/app/:org/settings/audit'], ['proj-create', '/app/:org/new-project'],
    ['proj-overview', P], ['proj-settings', `${P}/settings`], ['proj-package', `${P}/package`],
  ],
  D4: [
    ['case-list', `${P}/cases`], ['case-detail', `${P}/cases/:case`], ['case-composer', `${P}/cases/:case/compose`],
    ['case-revision', `${P}/cases/:case/revisions/:revision`], ['case-compare', `${P}/cases/:case/compare`],
    ['wb-workbench', `${P}/workbench`], ['snap-detail', `${P}/snapshots/:snapshot`], ['lib-list', '/app/:org/library'],
    ['lib-artifact', '/app/:org/library/:artifact'], ['lib-draft', '/app/:org/library/:artifact/drafts/:draft'],
    ['lib-version', '/app/:org/library/:artifact/versions/:version'], ['proj-library', `${P}/library`], ['proj-files', `${P}/files`],
    ['proj-resources', `${P}/resources`], ['proj-resource-detail', `${P}/resources/:resource`], ['coll-list', `${P}/collections`],
    ['coll-detail', `${P}/collections/:collection`], ['gen-lab', '/app/generator'],
  ],
  D5: [
    ['job-launch', `${P}/jobs/new`], ['job-list', `${P}/jobs`], ['job-detail', `${P}/jobs/:job`], ['job-history', '/app/jobs'],
  ],
  D6: [
    ['study-list', `${P}/studies`], ['study-builder', `${P}/studies/new`], ['study-detail', `${P}/studies/:study`],
    ['study-run', `${P}/studies/:study/runs/:run`], ['study-cell', `${P}/studies/:study/runs/:run/cells/:cell`],
    ['study-analytics', `${P}/studies/:study/runs/:run/analytics`], ['proj-publications', `${P}/publications`], ['verifier', '/app/verifier'],
  ],
  D7: [
    ['eng-register', '/app/engines/new'], ['eng-registrations', '/app/engines/registrations'],
    ['eng-registration-detail', '/app/engines/registrations/:name'], ['lang-extensions', '/app/language/extensions'],
  ],
  D8: [
    ['admin-overview', '/app/admin'], ['admin-users', '/app/admin/users'], ['admin-user-detail', '/app/admin/users/:user'],
    ['admin-audit', '/app/admin/audit'], ['admin-errors', '/app/admin/errors'], ['admin-queues', '/app/admin/queues'],
    ['admin-moderation', '/app/admin/moderation'], ['admin-maintenance', '/app/admin/maintenance'],
    ['admin-sponsor', '/app/admin/organizations/:org/sponsor'],
  ],
};

const DOMAIN_SIZES = { D1: 18, D2: 7, D3: 10, D4: 18, D5: 4, D6: 8, D7: 4, D8: 9 };

const sample = (path: string) => path.replace(/:[A-Za-z]+/g, 'sample');

describe('route registry', () => {
  // [utest->req~frontend-retire-screen-count~1]
  // [utest->req~frontend-retire-reports-screen-count~1]
  it('registers the 82 screens of the prototype minus the retired ones, 78 after slice 2', () => {
    expect(routeDefinitions).toHaveLength(78);
    expect(Object.values(PROTOTYPE).flat()).toHaveLength(78);
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

  // [utest->req~frontend-retire-reports-screen-count~1]
  it('keeps the publications and the verifier in domain D6, which holds the studies and nothing about reports', () => {
    expect(routesByDomain.D6.map((definition) => definition.id)).toEqual([
      'study-list', 'study-builder', 'study-detail', 'study-run', 'study-cell', 'study-analytics', 'proj-publications', 'verifier',
    ]);
  });

  it.each(Object.entries(DOMAIN_SIZES))('domain %s has %i screens', (domain, size) => {
    expect(routesByDomain[domain as keyof typeof routesByDomain]).toHaveLength(size);
  });

  it('uses unique ids and unique paths', () => {
    const ids = routeDefinitions.map((definition) => definition.id);
    const paths = routeDefinitions.map((definition) => definition.path);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it.each(Object.keys(PROTOTYPE) as Array<keyof typeof PROTOTYPE>)('lists the same ids and routes as the prototype for %s', (domain) => {
    expect(routesByDomain[domain].map((definition) => [definition.id, definition.path])).toEqual(PROTOTYPE[domain]);
  });

  it('places every screen under /app in the application layout and the rest in the public layout', () => {
    for (const definition of routeDefinitions) {
      const underApp = definition.path === '/app' || definition.path.startsWith('/app/');
      expect(definition.layout, definition.id).toBe(underApp ? 'app' : 'public');
      expect(Boolean(definition.requireAuth), definition.id).toBe(underApp);
    }
  });

  it('lets only the invitation link switch header with the session, without ever requiring one', () => {
    const adaptive = routeDefinitions.filter((definition) => definition.sessionHeader);
    expect(adaptive.map((definition) => definition.id)).toEqual(['org-invite-accept']);
    for (const definition of adaptive) {
      expect(definition.layout, definition.id).toBe('public');
      expect(definition.requireAuth, definition.id).toBe(false);
    }
  });

  it('requires an administrator for every admin screen and for nothing else', () => {
    const admin = routeDefinitions.filter((definition) => definition.id.startsWith('admin-'));
    expect(admin).toHaveLength(9);
    for (const definition of admin) {
      expect(definition.requireAdmin, definition.id).toBe(true);
      expect(definition.path, definition.id).toMatch(/^\/app\/admin(\/|$)/);
    }
    expect(routeDefinitions.filter((definition) => definition.requireAdmin)).toHaveLength(admin.length);
  });

  it('has the workbench and the generator lab at the addresses of the prototype', () => {
    expect(routeDefinitions.find((definition) => definition.id === 'wb-workbench')?.path).toBe('/app/:org/:project/workbench');
    expect(routeDefinitions.find((definition) => definition.id === 'gen-lab')?.path).toBe('/app/generator');
  });

  it('reads each administration address as its own screen, with accounts and organizations named in the path', () => {
    const config = routeDefinitions.map((definition) => ({ id: definition.id, path: definition.path }));
    const resolve = (path: string) => matchRoutes(config, path)?.at(-1)?.route.id;

    expect(resolve('/app/admin')).toBe('admin-overview');
    expect(resolve('/app/admin/users')).toBe('admin-users');
    expect(resolve('/app/admin/users/00000000-0000-4000-8000-000000000002')).toBe('admin-user-detail');
    expect(resolve('/app/admin/users/marco.diaz')).toBe('admin-user-detail');
    expect(resolve('/app/admin/audit')).toBe('admin-audit');
    expect(resolve('/app/admin/errors')).toBe('admin-errors');
    expect(resolve('/app/admin/queues')).toBe('admin-queues');
    expect(resolve('/app/admin/organizations/isa-demo/sponsor')).toBe('admin-sponsor');
    expect(resolve('/app/admin/moderation')).toBe('admin-moderation');
    expect(resolve('/app/admin/maintenance')).toBe('admin-maintenance');
  });

  it('reads the registration detail below the registrations list and /engines/new as the form', () => {
    const config = routeDefinitions.map((definition) => ({ id: definition.id, path: definition.path }));
    const resolve = (path: string) => matchRoutes(config, path)?.at(-1)?.route.id;

    expect(resolve('/app/engines/registrations')).toBe('eng-registrations');
    expect(resolve('/app/engines/registrations/edge-solver')).toBe('eng-registration-detail');
    expect(resolve('/app/language/extensions')).toBe('lang-extensions');
  });

  it('reads /studies/new as the builder and any other address below /studies as a study', () => {
    const config = routeDefinitions.map((definition) => ({ id: definition.id, path: definition.path }));
    const resolve = (path: string) => matchRoutes(config, path)?.at(-1)?.route.id;

    expect(resolve('/app/acme/atlas/studies/new')).toBe('study-builder');
    expect(resolve('/app/acme/atlas/studies/engines-vs-seeds')).toBe('study-detail');
    expect(resolve('/app/acme/atlas/studies/engines-vs-seeds/runs/r1')).toBe('study-run');
    expect(resolve('/app/acme/atlas/studies/engines-vs-seeds/runs/r1/cells/c1')).toBe('study-cell');
    expect(resolve('/app/acme/atlas/studies/engines-vs-seeds/runs/r1/analytics')).toBe('study-analytics');
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

  it('keeps the fixed /app screens from being read as an organization or project', () => {
    const config = routeDefinitions.map((definition) => ({ id: definition.id, path: definition.path }));
    const resolve = (path: string) => matchRoutes(config, path)?.at(-1)?.route.id;

    expect(resolve('/app/organizations/new')).toBe('org-create');
    expect(resolve('/app/engines/new')).toBe('eng-register');
    expect(resolve('/app/account/usage')).toBe('acct-usage');
    expect(resolve('/app/acme/new-project')).toBe('proj-create');
    expect(resolve('/app/acme/settings')).toBe('org-settings');
    expect(resolve('/app/acme/library')).toBe('lib-list');
    expect(resolve('/app/acme/atlas/jobs/new')).toBe('job-launch');
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
});
