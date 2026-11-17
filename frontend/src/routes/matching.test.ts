import { matchRoutes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { screens } from './router';

// What each address resolves to, across the whole table. Addresses where a fixed segment meets a `:param` segment are the ones a
// reordering could change; retired addresses (projects, cases, jobs, reports, library) resolve to no screen, because there are no
// redirects. The table came from the per-area tests of the old registry, merged when the routes became one table.
const config = screens.map(screen => ({ id: screen.id, path: screen.path }));
const resolve = (path: string) => matchRoutes(config, path)?.at(-1)?.route.id ?? null;

// prettier-ignore
const RESOLUTION: Array<[string, string | null]> = [
  ['/', 'pub-home'],
  ['/about', 'pub-about'],
  ['/app', null],
  ['/app/account', null],
  ['/app/account/billing', null],
  ['/app/account/identities', null],
  ['/app/account/keys', null],
  ['/app/account/keys/new', null],
  ['/app/account/keys/other', null],
  ['/app/account/notifications', null],
  ['/app/account/usage', null],
  ['/app/acme', null],
  ['/app/acme/atlas/cases', null],
  ['/app/acme/atlas/cases/c1', null],
  ['/app/acme/atlas/cases/c1/runs', null],
  ['/app/acme/atlas/problem-editor', null],
  ['/app/acme/atlas/problems', null],
  ['/app/acme/atlas/snapshots/s1', null],
  ['/app/acme/atlas/studies', null],
  ['/app/acme/atlas/studies/new', null],
  ['/app/acme/compositions', null],
  ['/me/compositions', 'my-compositions'],
  ['/compositions/acme/order-desk', 'composition-card'],
  ['/compositions/acme/order-desk/editor', 'composition-card'],
  ['/compositions/new', 'composition-new'],
  ['/p/c-1', 'composition-permalink'],
  ['/app/acme/compositions/order-desk', null],
  ['/compositions/acme/order-desk/versions/2', null],
  ['/app/acme/jobs/j1', null],
  ['/app/acme/jobs/new', null],
  ['/app/acme/problem-editor', null],
  ['/problem-editor', 'problem-editor'],
  ['/app/acme/problems', null],
  ['/app/acme/problems/c1', null],
  ['/orgs/acme/problems', 'org-detail'],
  ['/problems/acme/c1', 'problem-detail'],
  ['/problems/acme/c1/revisions/2', null],
  ['/problems/acme/c1/runs', 'problem-detail'],
  ['/problems/acme/c1/settings', 'problem-detail'],
  ['/problems/acme/c1/source', 'problem-detail'],
  ['/problems/acme/c1/versions', 'problem-detail'],
  ['/problems/acme', null],
  ['/app/acme/runs', null],
  ['/app/acme/runs/j1', null],
  ['/app/acme/runs/new', null],
  ['/runs/new', 'run-launch'],
  ['/runs/acme/j1', 'run-detail'],
  ['/runs/acme', null],
  ['/orgs/acme/runs', 'org-detail'],
  ['/app/acme/settings', null],
  ['/orgs/acme', 'org-detail'],
  ['/orgs/acme/members', 'org-detail'],
  ['/orgs/acme/presets', 'org-detail'],
  ['/orgs/new', 'org-new'],
  ['/organizations', 'org-explore'],
  ['/me/orgs', 'org-list'],
  ['/me/settings', 'acct-settings'],
  ['/me/settings/account', null],
  ['/me/api-keys', 'acct-api-keys'],
  ['/me/api-keys/new', null],
  ['/app/acme/studies', null],
  ['/app/acme/studies/new', null],
  ['/app/acme/studies/s1', null],
  ['/studies', null],
  ['/studies/new', 'study-builder'],
  ['/studies/acme', null],
  ['/studies/acme/s1', 'study-detail'],
  ['/studies/acme/s1/setup', 'study-detail'],
  ['/studies/acme/s1/front', 'study-detail'],
  ['/studies/acme/s1/runs/r1', null],
  ['/orgs/acme/studies', 'org-detail'],
  ['/app/admin', 'admin-overview'],
  ['/app/admin/users', 'admin-users'],
  ['/app/admin/users/new', 'admin-user-detail'],
  ['/app/admin/users/settings', 'admin-user-detail'],
  ['/app/engines/new', 'eng-register'],
  ['/app/engines/registrations', 'eng-registrations'],
  ['/app/engines/registrations/edge', 'eng-registration-detail'],
  ['/app/engines/registrations/settings', 'eng-registration-detail'],
  ['/app/settings/settings', null],
  ['/c/acme', null],
  ['/c/acme/order-desk', null],
  ['/c/acme/order-desk/versions', null],
  ['/compositions', 'pub-compositions'],
  ['/engines/bim.builtin/random-search/1.0.0', 'eng-detail'],
  ['/engines/new', null],
  ['/explore', null],
  ['/explore/examples', null],
  ['/language', 'pub-language'],
  ['/language/extensions', null],
  ['/language/schemas/Application', null],
  ['/authentication', 'auth'],
  ['/authentication/register', null],
  ['/forgot-password', 'auth-forgot-password'],
  ['/reset-password', 'auth-reset-password'],
  ['/sso/callback', 'auth-sso-callback'],
  ['/password-reset', null],
  ['/app/runs', null],
  ['/app/acme/zz-no-such-section', null],
  ['/app/acme/zz-no-such-section/zz', null],
  ['/app/acme/new-project', null],
  ['/app/organizations/new', null],
  ['/app/acme/atlas', null],
  ['/app/acme/atlas/settings', null],
  ['/status', null],
  ['/password-reset/complete', null],
];

describe('address resolution across the route table', () => {
  it.each(RESOLUTION)('%s -> %s', (path, id) => {
    expect(resolve(path)).toBe(id);
  });

  // A fixed segment under /app (`/app/admin`, `/app/engines`, …): an unknown address one level below it resolves to no screen, or to a
  // screen that owns that segment.
  const fixedSegments = [
    ...new Set(
      screens.flatMap(screen => {
        const [, root, first] = screen.path.split('/');
        return root === 'app' && first && !first.startsWith(':') ? [first] : [];
      })
    ),
  ];

  it('finds fixed segments under /app', () => {
    expect(fixedSegments).toEqual(expect.arrayContaining(['admin', 'engines']));
  });

  it.each(fixedSegments)(
    'reads an unknown address below /app/%s as no screen, or as a screen of that segment',
    segment => {
      const owners = new Set(
        screens.filter(screen => screen.path.split('/')[2] === segment).map(screen => screen.id)
      );
      const id = resolve(`/app/${segment}/zz-unknown`);
      expect(id === null || owners.has(id), `/app/${segment}/zz-unknown -> ${id}`).toBe(true);
    }
  );

  it('has no screen called org-create, proj-create or any proj-*', () => {
    const ids = screens.map(screen => screen.id);
    expect(ids).not.toContain('org-create');
    expect(ids).not.toContain('proj-create');
    expect(ids.filter(id => id.startsWith('proj-'))).toEqual([]);
    expect(screens.filter(screen => screen.path.includes(':project'))).toEqual([]);
  });
});
