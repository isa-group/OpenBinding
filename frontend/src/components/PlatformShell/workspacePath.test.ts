import { describe, expect, it } from 'vitest';
import { RESERVED_SLUGS, workspaceSlugs } from './workspacePath';

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

  it.each([
    'system', 'generator', 'language', 'organizations', 'invitations', 'jobs', 'analysis',
    'verifier', 'account', 'admin', 'engines', 'workbench',
  ])('never reads the fixed screen /app/%s as an organization', (segment) => {
    expect(RESERVED_SLUGS.has(segment)).toBe(true);
    expect(workspaceSlugs(`/app/${segment}`)).toEqual({});
    expect(workspaceSlugs(`/app/${segment}/something`)).toEqual({});
  });
});
