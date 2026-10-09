import type { OrganizationAuditEvent } from '../../api/platform';

/** Audit events as `GET /v1/organizations/{org}/audit` sends them, newest first. For tests. */
export const auditFixture: OrganizationAuditEvent[] = [
  {
    id: 'ev-3', organizationId: 'org-isa-demo', actorId: null, action: 'organization.invitation.created', targetType: 'OrganizationInvitation',
    targetId: 'inv-1', detail: {}, createdAt: '2026-10-08T09:15:00Z',
  },
  {
    id: 'ev-2', organizationId: 'org-isa-demo', actorId: 'user-lucia', action: 'organization.members.batch_updated', targetType: 'Organization',
    targetId: 'org-isa-demo', detail: { changes: [{ user_id: 'user-marco', role: 'ADMIN' }, { user_id: 'user-sofia', role: null }] }, createdAt: '2026-09-25T10:00:00Z',
  },
  {
    id: 'ev-1', organizationId: 'org-isa-demo', actorId: 'user-lucia', action: 'organization.created', targetType: 'Organization',
    targetId: 'org-isa-demo', detail: {}, createdAt: '2026-03-03T08:00:00Z',
  },
];
