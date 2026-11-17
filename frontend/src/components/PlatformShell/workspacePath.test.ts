import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { screens as routeDefinitions } from '../../routes/router';
import { RESERVED_SLUGS, workspaceSlugs } from './workspacePath';

/**
 * The first segment after /app of every address the application answers with something other than an organization: its screens.
 * A segment that is a `:param` names an organization and is not listed.
 */
/** The gateway's list (`RESERVED_ORGANIZATION_SLUGS` in models/platform.py), read as text: the two lists must stay equal. */
function gatewayReservedSlugs(): string[] {
  const source = readFileSync(
    join(process.cwd(), '../openbinding-gateway/src/openbinding_gateway/models/platform.py'),
    'utf8'
  );
  const block = /RESERVED_ORGANIZATION_SLUGS = frozenset\(\{([^}]*)\}\)/.exec(source);
  expect(block, 'RESERVED_ORGANIZATION_SLUGS in models/platform.py').not.toBeNull();
  return [...block![1].matchAll(/"([a-z0-9-]+)"/g)].map(match => match[1]).sort();
}

const FIXED_SEGMENTS = [
  ...new Set(
    routeDefinitions.flatMap(route => {
      const [, root, first] = route.path.split('/');
      return root === 'app' && first && !first.startsWith(':') ? [first] : [];
    })
  ),
].sort();

describe('workspaceSlugs', () => {
  it('reads the organization from the address, whatever screen of it is open', () => {
    expect(workspaceSlugs('/app/isa-demo')).toEqual({ org: 'isa-demo' });
    expect(workspaceSlugs('/app/isa-demo/problems/checkout')).toEqual({ org: 'isa-demo' });
    expect(workspaceSlugs('/app/isa-demo/settings/members')).toEqual({ org: 'isa-demo' });
  });

  it('reserves the slugs the gateway refuses (slug_reserved), and only those', () => {
    expect([...RESERVED_SLUGS].sort()).toEqual([
      'account',
      'admin',
      'compositions',
      'engines',
      'invitations',
      'join',
      'new',
      'organizations',
      'presets',
      'problem-editor',
      'problems',
      'public',
      'runs',
      'settings',
      'studies',
    ]);
    expect([...RESERVED_SLUGS].sort()).toEqual(gatewayReservedSlugs());
  });

  it.each(['compositions', 'presets', 'runs', 'problems', 'studies', 'problem-editor'])(
    'never reads the section name %s as an organization',
    segment => {
      expect(workspaceSlugs(`/app/${segment}`)).toEqual({});
      expect(workspaceSlugs(`/app/${segment}/new`)).toEqual({});
    }
  );

  it('names no workspace for the application root or other sites', () => {
    expect(workspaceSlugs('/app')).toEqual({});
    expect(workspaceSlugs('/explore')).toEqual({});
    expect(workspaceSlugs('/')).toEqual({});
  });

  it('finds the fixed segments of the registry', () => {
    expect(FIXED_SEGMENTS).toEqual(expect.arrayContaining(['admin', 'engines']));
  });

  it.each(FIXED_SEGMENTS)('never reads the fixed address /app/%s as an organization', segment => {
    expect(RESERVED_SLUGS.has(segment)).toBe(true);
    expect(workspaceSlugs(`/app/${segment}`)).toEqual({});
    expect(workspaceSlugs(`/app/${segment}/something`)).toEqual({});
  });
});
