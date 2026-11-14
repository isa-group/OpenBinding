import { matchRoutes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { routeDefinitions, routesByArea } from '../registry';

// One pair per line: screenBudget.test.ts counts them.
const PROTOTYPE: Array<[string, string]> = [
  ['admin-overview', '/app/admin'],
  ['admin-users', '/app/admin/users'],
  ['admin-user-detail', '/app/admin/users/:user'],
  ['admin-moderation', '/app/admin/moderation'],
];

describe('area admin', () => {
  it('has 4 screens, with the ids and routes of the prototype', () => {
    expect(routesByArea.admin).toHaveLength(4);
    expect(routesByArea.admin.map((definition) => [definition.id, definition.path])).toEqual(PROTOTYPE);
  });

  it('declares no sponsorship screen, and keeps the audit log, errors, queues and maintenance inside the overview', () => {
    const ids = routeDefinitions.map((definition) => definition.id);
    const paths = routeDefinitions.map((definition) => definition.path);
    expect(ids).not.toContain('admin-sponsor');
    expect(paths.filter((path) => path.endsWith('/sponsor') || path.startsWith('/app/admin/organizations'))).toEqual([]);
    for (const section of ['audit', 'errors', 'queues', 'maintenance']) {
      expect(ids).not.toContain(`admin-${section}`);
      expect(paths).not.toContain(`/app/admin/${section}`);
    }
  });

  it('reads each administration address as its own screen, with accounts named in the path', () => {
    const config = routeDefinitions.map((definition) => ({ id: definition.id, path: definition.path }));
    const resolve = (path: string) => matchRoutes(config, path)?.at(-1)?.route.id;

    expect(resolve('/app/admin')).toBe('admin-overview');
    expect(resolve('/app/admin?section=audit')).toBe('admin-overview');
    expect(resolve('/app/admin/users')).toBe('admin-users');
    expect(resolve('/app/admin/users/00000000-0000-4000-8000-000000000002')).toBe('admin-user-detail');
    expect(resolve('/app/admin/users/marco.diaz')).toBe('admin-user-detail');
    expect(resolve('/app/admin/moderation')).toBe('admin-moderation');
  });

  describe('address resolution', () => {
    const config = routeDefinitions.map((definition) => ({ id: definition.id, path: definition.path }));

    it.each([
      ['/app/admin', 'admin-overview'],
      ['/app/admin/users', 'admin-users'],
      ['/app/admin/users/new', 'admin-user-detail'],
      ['/app/admin/users/settings', 'admin-user-detail'],
    ])('%s -> %s', (path, id) => {
      expect(matchRoutes(config, path)?.at(-1)?.route.id ?? null).toBe(id);
    });

    it.each(['/app/admin/audit', '/app/admin/errors', '/app/admin/queues', '/app/admin/maintenance'])('serves %s by no administration screen', (path) => {
      expect(routesByArea.admin.map((definition) => definition.id)).not.toContain(matchRoutes(config, path)?.at(-1)?.route.id);
    });
  });
});
