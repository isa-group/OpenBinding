// The account's role in the organization that owns a composition, from the organization context, and what it allows.

import { useCallback } from 'react';
import { useOrganization } from '../../organization/hooks/useOrganization';
import type { OrgRole } from '../../organization/api/organizationsApi';

const RANK: Record<OrgRole, number> = { VIEWER: 0, MEMBER: 1, ADMIN: 2, OWNER: 3 };

/** Whether `role` is `least` or above (OWNER > ADMIN > MEMBER > VIEWER); no role is below them all. */
export function roleAtLeast(role: OrgRole | null | undefined, least: OrgRole): boolean {
  return role ? RANK[role] >= RANK[least] : false;
}

/** The account's effective role in an organization (by slug), or null when it holds none. */
export function useCompositionRole() {
  const { organizations } = useOrganization();
  return useCallback(
    (org: string): OrgRole | null =>
      organizations.find(organization => organization.slug === org)?.effective_role ?? null,
    [organizations]
  );
}
