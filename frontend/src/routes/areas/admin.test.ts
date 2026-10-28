import { matchRoutes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { routeDefinitions, routesByArea } from '../registry';

// One pair per line: screenBudget.test.ts counts them.
const PROTOTYPE: Array<[string, string]> = [
  ['admin-overview', '/app/admin'],
  ['admin-users', '/app/admin/users'],
  ['admin-user-detail', '/app/admin/users/:user'],
  ['admin-audit', '/app/admin/audit'],
  ['admin-errors', '/app/admin/errors'],
  ['admin-queues', '/app/admin/queues'],
  ['admin-moderation', '/app/admin/moderation'],
  ['admin-maintenance', '/app/admin/maintenance'],
];

describe('area admin', () => {
  // [utest->req~frontend-nav-route-areas~1]
  it('has 8 screens, with the ids and routes of the prototype', () => {
    expect(routesByArea.admin).toHaveLength(8);
    expect(routesByArea.admin.map((definition) => [definition.id, definition.path])).toEqual(PROTOTYPE);
  });

  // [utest->req~frontend-retire-sponsorship-screen-not-routed~1]
  it('declares no sponsorship screen, and keeps the eight administration screens', () => {
    const ids = routeDefinitions.map((definition) => definition.id);
    const paths = routeDefinitions.map((definition) => definition.path);
    expect(ids).not.toContain('admin-sponsor');
    expect(paths.filter((path) => path.endsWith('/sponsor') || path.startsWith('/app/admin/organizations'))).toEqual([]);
    expect(routesByArea.admin.map((definition) => definition.id)).toEqual([
      'admin-overview', 'admin-users', 'admin-user-detail', 'admin-audit', 'admin-errors', 'admin-queues', 'admin-moderation', 'admin-maintenance',
    ]);
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
    expect(resolve('/app/admin/moderation')).toBe('admin-moderation');
    expect(resolve('/app/admin/maintenance')).toBe('admin-maintenance');
  });
});
