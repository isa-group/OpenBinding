import { matchRoutes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { routeDefinitions } from './registry';

// [utest->req~frontend-nav-route-areas~1]
// Characterization of the screen each address resolves to. Addresses where a fixed segment meets a `:param` segment are the ones a
// reordering of the registry could change; the registry order decides ties of rank.
const config = routeDefinitions.map((definition) => ({ id: definition.id, path: definition.path }));
const resolve = (path: string) => matchRoutes(config, path)?.at(-1)?.route.id ?? null;

describe('address resolution across the registry', () => {
  it.each([
    ['/', 'pub-home'],
    ['/engines/bim.builtin/random-search/1.0.0', 'eng-detail'],
    ['/engines/new', null],
    ['/language/schemas/Instance', 'lang-schemas'],
    ['/resolve/report/sha256-abc', 'pub-resolve'],
    ['/password-reset/complete', 'auth-reset-complete'],
    ['/app', 'app-home'],
    ['/app/jobs', 'job-history'],
    ['/app/jobs/new', 'proj-overview'],
    ['/app/generator', 'gen-lab'],
    ['/app/verifier', 'verifier'],
    ['/app/system/states', 'sys-states'],
    ['/app/organizations/new', 'org-create'],
    ['/app/organizations/acme', 'proj-overview'],
    ['/app/account', 'acct-profile'],
    ['/app/account/usage', 'acct-usage'],
    ['/app/account/keys', 'acct-keys'],
    ['/app/account/keys/new', 'acct-key-new'],
    ['/app/account/keys/other', null],
    ['/app/account/anything', 'proj-overview'],
    ['/app/engines/new', 'eng-register'],
    ['/app/engines/registrations', 'eng-registrations'],
    ['/app/engines/registrations/edge', 'eng-registration-detail'],
    ['/app/engines/registrations/settings', 'eng-registration-detail'],
    ['/app/engines/other', 'proj-overview'],
    ['/app/language/extensions', 'lang-extensions'],
    ['/app/language/other', 'proj-overview'],
    ['/app/admin', 'admin-overview'],
    ['/app/admin/users', 'admin-users'],
    ['/app/admin/users/new', 'admin-user-detail'],
    ['/app/admin/users/settings', 'admin-user-detail'],
    ['/app/admin/audit', 'admin-audit'],
    ['/app/admin/other', 'proj-overview'],
    ['/app/acme', 'org-overview'],
    ['/app/acme/settings', 'org-settings'],
    ['/app/acme/settings/members', 'org-members'],
    ['/app/acme/settings/audit', 'org-audit'],
    ['/app/acme/new-project', 'proj-create'],
    ['/app/settings/settings', 'org-settings'],
    ['/app/new-project/new-project', 'proj-create'],
    ['/app/acme/atlas', 'proj-overview'],
    ['/app/acme/atlas/settings', 'proj-settings'],
    ['/app/acme/atlas/package', 'proj-package'],
    ['/app/acme/atlas/files', 'proj-files'],
    ['/app/acme/atlas/publications', 'proj-publications'],
    ['/app/acme/atlas/workbench', 'wb-workbench'],
    ['/app/acme/atlas/cases', 'case-list'],
    ['/app/acme/atlas/cases/c1', 'case-detail'],
    ['/app/acme/atlas/cases/compare', 'case-detail'],
    ['/app/acme/atlas/cases/c1/compare', 'case-compare'],
    ['/app/acme/atlas/cases/c1/revisions/2', 'case-revision'],
    ['/app/acme/atlas/snapshots/s1', 'snap-detail'],
    ['/app/acme/atlas/collections', 'coll-list'],
    ['/app/acme/atlas/collections/k1', 'coll-detail'],
    ['/app/acme/atlas/jobs', 'job-list'],
    ['/app/acme/atlas/jobs/new', 'job-launch'],
    ['/app/acme/atlas/jobs/j1', 'job-detail'],
    ['/app/acme/atlas/studies', 'study-list'],
    ['/app/acme/atlas/studies/new', 'study-builder'],
    ['/app/acme/atlas/studies/s1', 'study-detail'],
    ['/app/acme/atlas/studies/s1/runs/r1', 'study-run'],
    ['/app/acme/atlas/studies/s1/runs/r1/cells/c1', 'study-cell'],
    ['/app/acme/atlas/studies/s1/runs/r1/analytics', 'study-analytics'],
    ['/app/acme/atlas/other', null],
  ])('%s -> %s', (path, id) => {
    expect(resolve(path)).toBe(id);
  });
});
