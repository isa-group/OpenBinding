import type { OrganizationInvitation } from '../../api/organizationsApi';

/** The address an invitation code opens. */
export const joinUrl = (code: string) => `${window.location.origin}/orgs/join/${code}`;

/** Whether a code still lets people in: not expired, not used up. */
export function isActiveInvitation(invitation: OrganizationInvitation, now = new Date()): boolean {
  const unexpired = !invitation.expires_at || new Date(invitation.expires_at) > now;
  const room = invitation.max_uses === null || invitation.use_count < invitation.max_uses;
  return unexpired && room;
}
