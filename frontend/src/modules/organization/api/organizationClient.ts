// The organization operations that are not SPHERE's (`useOrganizationsApi`): the member list and the audit log, cut out of
// the old `api/platform.ts`, with the organization types the other modules read.

import { apiClient } from '../../core/api/http';

export interface Organization {
  id: string;
  slug: string;
  name: string;
  parent_id: string | null;
  effective_role: 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER' | null;
  created_at: string;
}

export type OrganizationRole = 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER';

export interface OrganizationMember {
  id: string;
  organization_id: string;
  user_id: string;
  username: string | null;
  email: string | null;
  role: OrganizationRole;
  created_at: string;
}

/** One staged change of `POST /v1/organizations/{org}/members/batch`: a `null` role removes the direct membership. */
export interface MemberChange {
  user_id: string;
  role: OrganizationRole | null;
}

/** The most changes one batch may carry (`MemberBatchUpdate.maxItems`). */
export const MEMBER_BATCH_LIMIT = 100;

/**
 * One row of the organization audit log. The OpenAPI contract types the answer only as an object; this is what
 * `GET /v1/organizations/{org}/audit` sends in practice (`list_organization_audit_events`).
 */
export interface OrganizationAuditEvent {
  id: string;
  organizationId: string | null;
  actorId: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  detail: Record<string, unknown>;
  createdAt: string;
}

export interface OrganizationAuditPage {
  events: OrganizationAuditEvent[];
  total: number;
  offset: number;
  limit: number;
}

const root = (org: string) => `/v1/organizations/${encodeURIComponent(org)}`;

export const organizationClient = {
  /** The audit log needs ADMIN. `action` is an exact action name (`organization.member.removed`), filtered by the server. */
  organizationAudit: (
    org: string,
    params: { action?: string; offset?: number; limit?: number } = {}
  ) => {
    const query = new URLSearchParams();
    if (params.action) query.set('action', params.action);
    if (params.offset) query.set('offset', String(params.offset));
    if (params.limit) query.set('limit', String(params.limit));
    const suffix = query.toString() ? `?${query}` : '';
    return apiClient.request<OrganizationAuditPage>(
      `${root(org)}/audit${suffix}`,
      {},
      undefined,
      true,
      true
    );
  },
  members: (org: string) => apiClient.request<OrganizationMember[]>(`${root(org)}/members`),
};
