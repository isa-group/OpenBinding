// Accounts, organizations, members and problems shared by the unit tests of the modules (taken from the old workspace's test
// kits when the workspace went).

import type { UserProfile } from '../../modules/core/api/account';
import type {
  Organization,
  OrganizationMember,
} from '../../modules/organization/api/organizationClient';
import type { Problem, ProblemRevision } from '../../modules/problem/api/problemsClient';

export const lucia: UserProfile = {
  id: 'user-lucia',
  username: 'lucia',
  email: 'lucia@example.test',
  role: 'user',
  is_active: true,
  plan: 'RESEARCH',
  created_at: '2026-03-01T00:00:00Z',
  email_verified: false,
  institutional_email: false,
};

export function org(slug: string, over: Partial<Organization> = {}): Organization {
  return {
    id: `org-${slug}`,
    slug,
    name: slug.toUpperCase(),
    parent_id: null,
    effective_role: 'OWNER',
    created_at: '2026-03-03T00:00:00Z',
    ...over,
  };
}

export function member(
  user: string,
  role: OrganizationMember['role'],
  over: Partial<OrganizationMember> = {}
): OrganizationMember {
  return {
    id: `m-${user}`,
    organization_id: 'org-isa-demo',
    user_id: `user-${user}`,
    username: user,
    email: `${user}@example.test`,
    role,
    created_at: '2026-03-04T00:00:00Z',
    ...over,
  };
}

export function caseOf(slug: string, name = slug, over: Partial<Problem> = {}): Problem {
  return {
    id: `case-${slug}`,
    organization_id: 'org-isa',
    slug,
    name,
    description: '',
    created_by_id: lucia.id,
    created_at: '2026-04-02T00:00:00Z',
    updated_at: '2026-04-02T00:00:00Z',
    ...over,
  };
}

export function revisionOf(
  caseItem: Problem,
  revision: number,
  over: Partial<ProblemRevision> = {}
): ProblemRevision {
  return {
    id: `${caseItem.id}-r${revision}`,
    problem_id: caseItem.id,
    revision,
    package_digest: `sha256-${String(revision).repeat(64)}`.slice(0, 71),
    package_size: 2048,
    created_by_id: lucia.id,
    created_at: `2026-04-0${revision}T00:00:00Z`,
    ...over,
  };
}
