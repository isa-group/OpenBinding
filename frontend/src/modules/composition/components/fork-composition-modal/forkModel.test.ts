import { describe, expect, it } from 'vitest';
import type { Organization } from '../../../organization/api/organizationsApi';
import type { ApiError } from '../../../core/api/errors';
import {
  NEEDS_MEMBER,
  SAME_ORGANIZATION,
  forkRefusal,
  forkRequest,
  forkSuggestion,
  linksProblem,
  nameProblem,
  slugProblem,
  stepsOf,
  targetReason,
} from './forkModel';

const organization = (slug: string, role: Organization['effective_role']): Organization => ({
  id: `org-${slug}`,
  slug,
  name: slug,
  parent_id: null,
  effective_role: role,
  description: '',
  created_at: '2026-03-03T00:00:00Z',
});

const refusal = (status: number, code: string, over: Partial<ApiError> = {}): ApiError => ({
  status,
  code,
  message: '',
  diagnostics: [],
  ...over,
});

describe('fork model', () => {
  it('offers another organization where the account is MEMBER or more', () => {
    expect(targetReason(organization('isa-demo', 'OWNER'), 'isa-demo')).toBe(SAME_ORGANIZATION);
    expect(targetReason(organization('read-lab', 'VIEWER'), 'isa-demo')).toBe(NEEDS_MEMBER);
    expect(targetReason(organization('nobody', null), 'isa-demo')).toBe(NEEDS_MEMBER);
    for (const role of ['MEMBER', 'ADMIN', 'OWNER'] as const)
      expect(targetReason(organization('qos-lab', role), 'isa-demo')).toBeNull();
  });

  it('adds the problem step only for a version that links a problem', () => {
    expect(linksProblem({ problem: null })).toBe(false);
    expect(stepsOf(false)).toEqual(['target']);
    expect(stepsOf(true)).toEqual(['target', 'problem']);
  });

  it('suggests <slug>-fork and <name> (fork), within the gateway’s lengths', () => {
    expect(forkSuggestion({ slug: 'fleet-routing', name: 'Fleet routing' })).toEqual({
      slug: 'fleet-routing-fork',
      name: 'Fleet routing (fork)',
    });
    const long = forkSuggestion({ slug: `${'a'.repeat(58)}-bcdef`, name: 'n'.repeat(160) });
    expect(long.slug).toBe(`${'a'.repeat(58)}-fork`);
    expect(long.slug.length).toBeLessThanOrEqual(64);
    expect(long.name.length).toBe(160);
    expect(long.name.endsWith(' (fork)')).toBe(true);
  });

  it('refuses the taken name in any case, an empty name, a bad or taken address', () => {
    expect(nameProblem('  fleet ROUTING ', 'Fleet routing')).toMatch(
      /name of the composition already there/
    );
    expect(nameProblem(' ', 'Fleet routing')).toBe('Give the fork a name.');
    expect(nameProblem('Fleet routing (fork)', 'Fleet routing')).toBeNull();
    expect(slugProblem('Fleet', 'fleet-routing', 'QoS Lab')).toBe(
      'Lowercase letters, numbers and hyphens.'
    );
    expect(slugProblem('fleet-routing', 'fleet-routing', 'QoS Lab')).toBe(
      'fleet-routing is in use in QoS Lab. Choose another address.'
    );
    expect(slugProblem('fleet-routing-fork', 'fleet-routing', 'QoS Lab')).toBeNull();
  });

  it('builds the request: the version id, the target, dropProblem for a linked version, and a new name only when given', () => {
    expect(forkRequest({ id: 'v3', problem: null }, 'qos-lab')).toEqual({
      version: 'v3',
      targetOrganization: 'qos-lab',
      dropProblem: false,
    });
    const link = { id: 'v3', problem: {} as never };
    expect(forkRequest(link, 'qos-lab', { slug: 'fleet-eu', name: ' Fleet EU ' })).toEqual({
      version: 'v3',
      targetOrganization: 'qos-lab',
      dropProblem: true,
      slug: 'fleet-eu',
      name: 'Fleet EU',
    });
  });

  it('words each refusal, a taken address at its field', () => {
    expect(forkRefusal(refusal(409, 'slug_conflict'), 'QoS Lab', 'fleet-eu')).toEqual({
      message: 'fleet-eu is in use in QoS Lab (409 · slug_conflict). Choose another address.',
      field: 'slug',
      findings: [],
    });
    expect(forkRefusal(refusal(403, 'organization_forbidden'), 'QoS Lab', 'x').message).toBe(
      'Forking into QoS Lab needs MEMBER there (403 · organization_forbidden).'
    );
    expect(
      forkRefusal(refusal(429, 'composition_busy', { retryAfter: 2 }), 'QoS Lab', 'x').message
    ).toBe('The gateway is busy (429 · composition_busy). Try again in 2 s.');
    expect(forkRefusal(refusal(503, 'unknown', { message: 'down' }), 'QoS Lab', 'x').message).toBe(
      'The composition couldn’t be forked (503): down'
    );
    expect(forkRefusal(refusal(0, 'network'), 'QoS Lab', 'x').message).toBe(
      'The composition couldn’t be forked.'
    );
  });
});
