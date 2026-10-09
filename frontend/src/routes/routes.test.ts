import { isValidElement } from 'react';
import { matchRoutes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { PendingScreen } from './PendingScreen';
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
    ['study-analytics', `${P}/studies/:study/runs/:run/analytics`], ['analysis-sources', '/app/analysis'],
    ['analysis-workspace', '/app/analysis/workspace'], ['rep-list', `${P}/reports`], ['rep-detail', `${P}/reports/:report`],
    ['proj-publications', `${P}/publications`], ['verifier', '/app/verifier'],
  ],
  D7: [
    ['eng-register', '/app/engines/new'], ['eng-registrations', '/app/engines/registrations'],
    ['eng-registration-detail', '/app/engines/registrations/:name'], ['lang-extensions', '/app/language/extensions'],
  ],
  D8: [
    ['admin-overview', '/app/admin'], ['admin-users', '/app/admin/users'], ['admin-user-detail', '/app/admin/users/:user'],
    ['admin-audit', '/app/admin/audit'], ['admin-errors', '/app/admin/errors'], ['admin-queues', '/app/admin/queues'],
    ['admin-moderation', '/app/admin/moderation'], ['admin-maintenance', '/app/admin/maintenance'],
    ['admin-routing', '/app/admin/engine-routing'], ['admin-sponsor', '/app/admin/organizations/:org/sponsor'],
    ['admin-pricing', '/app/admin/pricing'], ['admin-pricing-draft', '/app/admin/pricing/drafts/new'],
    ['admin-pricing-release', '/app/admin/pricing/:version'],
  ],
};

const DOMAIN_SIZES = { D1: 18, D2: 7, D3: 10, D4: 18, D5: 4, D6: 12, D7: 4, D8: 13 };

/** Pending screens when the registry was created. It may only go down as screens are rebuilt. */
const INITIAL_PENDING = 48;

const isPending = (definition: (typeof routeDefinitions)[number]) => isValidElement(definition.element) && definition.element.type === PendingScreen;
const sample = (path: string) => path.replace(/:[A-Za-z]+/g, 'sample');

describe('route registry', () => {
  it('registers exactly the 86 screens of the prototype', () => {
    expect(routeDefinitions).toHaveLength(86);
    expect(Object.values(PROTOTYPE).flat()).toHaveLength(86);
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
    expect(admin).toHaveLength(13);
    for (const definition of admin) {
      expect(definition.requireAdmin, definition.id).toBe(true);
      expect(definition.path, definition.id).toMatch(/^\/app\/admin(\/|$)/);
    }
    expect(routeDefinitions.filter((definition) => definition.requireAdmin)).toHaveLength(admin.length);
  });

  it('keeps status in step with the element: pending screens render the PendingScreen placeholder', () => {
    for (const definition of routeDefinitions) {
      expect(isPending(definition), definition.id).toBe(definition.status === 'pending');
      expect(['live', 'pending']).toContain(definition.status);
    }
  });

  it('counts the screens that are still pending, and never more than at the start', () => {
    const pendingIds = routeDefinitions.filter((definition) => definition.status === 'pending').map((definition) => definition.id);
    const live = routeDefinitions.length - pendingIds.length;
    const perDomain = Object.fromEntries(Object.entries(routesByDomain).map(([domain, list]) => [
      domain, `${list.filter((definition) => definition.status === 'live').length}/${list.length} live`,
    ]));
    console.info(`routes: ${live} live, ${pendingIds.length} pending`, perDomain);

    expect(pendingIds.length).toBeLessThanOrEqual(INITIAL_PENDING);
    expect(live + pendingIds.length).toBe(86);
  });

  it('has rebuilt the case screens and the snapshot', () => {
    const rebuilt = ['case-list', 'case-detail', 'case-composer', 'case-revision', 'case-compare', 'snap-detail'];
    for (const id of rebuilt) expect(routeDefinitions.find((definition) => definition.id === id)?.status, id).toBe('live');
  });

  it('has rebuilt the library screens', () => {
    const rebuilt = ['lib-list', 'lib-artifact', 'lib-draft', 'lib-version', 'proj-library'];
    for (const id of rebuilt) expect(routeDefinitions.find((definition) => definition.id === id)?.status, id).toBe('live');
  });

  it('has rebuilt the files, resources and collections screens', () => {
    const rebuilt = ['proj-files', 'proj-resources', 'proj-resource-detail', 'coll-list', 'coll-detail'];
    for (const id of rebuilt) expect(routeDefinitions.find((definition) => definition.id === id)?.status, id).toBe('live');
    expect(routeDefinitions.find((definition) => definition.id === 'coll-detail')?.paramAliases).toBeUndefined();
  });

  it('has rebuilt the workbench and the generator lab, which closes domain 4', () => {
    const rebuilt = ['wb-workbench', 'gen-lab'];
    for (const id of rebuilt) expect(routeDefinitions.find((definition) => definition.id === id)?.status, id).toBe('live');
    expect(routeDefinitions.find((definition) => definition.id === 'wb-workbench')?.path).toBe('/app/:org/:project/workbench');
    expect(routeDefinitions.find((definition) => definition.id === 'gen-lab')?.path).toBe('/app/generator');
    expect(routesByDomain.D4.filter((definition) => definition.status === 'pending').map((definition) => definition.id)).toEqual([]);
  });

  it('has rebuilt the execution screens, which closes domain 5', () => {
    const rebuilt = ['job-launch', 'job-list', 'job-detail', 'job-history'];
    for (const id of rebuilt) expect(routeDefinitions.find((definition) => definition.id === id)?.status, id).toBe('live');
    expect(routeDefinitions.find((definition) => definition.id === 'job-detail')?.paramAliases).toBeUndefined();
    expect(routesByDomain.D5.filter((definition) => definition.status === 'pending').map((definition) => definition.id)).toEqual([]);
  });

  it('has rebuilt the study screens with the ids and routes of the prototype', () => {
    const rebuilt = ['study-list', 'study-builder', 'study-detail', 'study-run', 'study-cell', 'study-analytics'];
    for (const id of rebuilt) expect(routeDefinitions.find((definition) => definition.id === id)?.status, id).toBe('live');
    for (const id of rebuilt) expect(routeDefinitions.find((definition) => definition.id === id)?.paramAliases, id).toBeUndefined();
    expect(routesByDomain.D6.filter((definition) => definition.status === 'pending').map((definition) => definition.id)).toEqual(['analysis-workspace', 'proj-publications']);
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

  // The closing task of the redesign turns this on (VITE_ROUTES_REQUIRE_LIVE=1 pnpm test).
  it.skipIf(!import.meta.env.VITE_ROUTES_REQUIRE_LIVE)('has no pending screen left', () => {
    expect(routeDefinitions.filter((definition) => definition.status === 'pending').map((definition) => definition.id)).toEqual([]);
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
    expect(resolve('/app/admin/pricing/drafts/new')).toBe('admin-pricing-draft');
  });

  it('no longer serves the legacy routes that have no equivalent in the prototype', () => {
    const config = routeDefinitions.map((definition) => ({ id: definition.id, path: definition.path }));
    const legacy = [
      '/playground', '/engines/new', '/team', '/research', '/funding', '/contributions', '/changelog',
      '/profiles', '/schemas', '/app/acme/atlas/verifier', '/app/acme/atlas/analytics', '/app/acme/atlas/artifacts',
    ];
    for (const path of legacy) expect(matchRoutes(config, path), path).toBeNull();
  });

  it('declares the legacy parameter names the live detail pages still read', () => {
    const aliases = Object.fromEntries(routeDefinitions.filter((definition) => definition.paramAliases)
      .map((definition) => [definition.id, definition.paramAliases]));
    expect(aliases).toEqual({
      'rep-detail': { report: 'reportSlug' },
    });
  });
});
