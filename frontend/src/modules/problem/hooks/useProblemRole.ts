// The account's role in the organization that owns a problem, from the organization context, and what it allows.

import { useOrganization } from '../../organization/hooks/useOrganization';
import type { OrgRole } from '../../organization/api/organizationsApi';

const RANK: Record<OrgRole, number> = { VIEWER: 0, MEMBER: 1, ADMIN: 2, OWNER: 3 };

/** What the account may do with the problems of an organization. */
export interface ProblemAccess {
  role: OrgRole | null;
  /** Upload, edit and save versions, run them: MEMBER. */
  canCreate: boolean;
  /** Delete: ADMIN. */
  canAdminister: boolean;
}

export function problemAccessOf(role: OrgRole | null | undefined): ProblemAccess {
  const rank = role ? RANK[role] : -1;
  return { role: role ?? null, canCreate: rank >= RANK.MEMBER, canAdminister: rank >= RANK.ADMIN };
}

/** The organization of the account named `org` (problems are private to it), while the account's organizations load. */
export function useProblemOrganization(org: string) {
  const { organizations, isLoading } = useOrganization();
  const organization = organizations.find(item => item.slug === org) ?? null;
  return {
    organization,
    loading: isLoading && organization === null,
    access: problemAccessOf(organization?.effective_role),
  };
}
