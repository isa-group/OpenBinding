import { describe, expect, it } from 'vitest';
import { movedRoutes, routeDefinitions } from '../../routes/registry';
import { RETIRED_ROUTES } from '../../routes/retiredRoutes';
import { RESERVED_SLUGS, workspaceSlugs } from './workspacePath';

/**
 * The first segment after /app of every address the application answers with something other than an organization: the screens, the
 * retired addresses (they redirect) and the moved ones. A segment that is a `:param` names an organization and is not listed.
 */
const FIXED_SEGMENTS = [...new Set(
  [...routeDefinitions, ...RETIRED_ROUTES, ...movedRoutes].flatMap((route) => {
    const [, root, first] = route.path.split('/');
    return root === 'app' && first && !first.startsWith(':') ? [first] : [];
  }),
)].sort();

describe('workspaceSlugs', () => {
  it('reads the organization and project from the address', () => {
    expect(workspaceSlugs('/app/isa-demo')).toEqual({ org: 'isa-demo', project: undefined });
    expect(workspaceSlugs('/app/isa-demo/qos')).toEqual({ org: 'isa-demo', project: 'qos' });
    expect(workspaceSlugs('/app/isa-demo/qos/cases/checkout')).toEqual({ org: 'isa-demo', project: 'qos' });
  });

  it('does not take organization-level sections for projects', () => {
    expect(workspaceSlugs('/app/isa-demo/settings/members')).toEqual({ org: 'isa-demo', project: undefined });
    expect(workspaceSlugs('/app/isa-demo/new-project')).toEqual({ org: 'isa-demo', project: undefined });
  });

  it.each(['library', 'resources'])('keeps %s unusable as an organization slug, though its screens are retired', (segment) => {
    expect(RESERVED_SLUGS.has(segment)).toBe(true);
    expect(workspaceSlugs(`/app/${segment}`)).toEqual({});
  });

  it('names no workspace for the application root or other sites', () => {
    expect(workspaceSlugs('/app')).toEqual({});
    expect(workspaceSlugs('/explore')).toEqual({});
    expect(workspaceSlugs('/')).toEqual({});
  });

  it('finds the fixed segments of the registry', () => {
    expect(FIXED_SEGMENTS.length).toBeGreaterThan(3);
  });

  it.each(FIXED_SEGMENTS)('never reads the fixed address /app/%s as an organization', (segment) => {
    expect(RESERVED_SLUGS.has(segment)).toBe(true);
    expect(workspaceSlugs(`/app/${segment}`)).toEqual({});
    expect(workspaceSlugs(`/app/${segment}/something`)).toEqual({});
  });
});
