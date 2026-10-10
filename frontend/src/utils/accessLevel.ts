import type { OrganizationRole, ProjectAccessKind } from '../api/platform';

/**
 * The levels at which a project can be reached, lowest first. `public_read` is how a non-member reads a public project:
 * it sits BELOW `VIEWER` (a viewer is a member and sees jobs, the package and the settings; a visitor sees none of them)
 * and is not a role, so it never counts as one.
 */
export type AccessLevel = 'public_read' | OrganizationRole;

const RANK: Record<AccessLevel, number> = { public_read: 0, VIEWER: 1, MEMBER: 2, ADMIN: 3, OWNER: 4 };

/** The level of someone who has a role, or who reads a public project (`access` wins over any role: it never writes). */
export function levelOf(access: ProjectAccessKind | undefined, role: OrganizationRole | null | undefined): AccessLevel | null {
  if (access === 'public_read') return 'public_read';
  return role ?? null;
}

/** Can this level read something that needs at least `minimum`? `public_read` reaches only what is public. */
export function canRead(level: AccessLevel | null | undefined, minimum: AccessLevel = 'public_read'): boolean {
  return level != null && RANK[level] >= RANK[minimum];
}

/**
 * Can this level change something that needs at least `minimum` (MEMBER to create, ADMIN to delete or publish)?
 * No level below VIEWER writes, and a VIEWER only reads: whatever `minimum` says, `public_read` is never enough.
 */
export function canWrite(level: AccessLevel | null | undefined, minimum: Exclude<AccessLevel, 'public_read' | 'VIEWER'> = 'MEMBER'): boolean {
  return level != null && level !== 'public_read' && RANK[level] >= RANK[minimum];
}

/** The parts of a project a visitor never sees (the backend refuses them: jobs, the package export, the settings). */
const MEMBER_ONLY = ['jobs', 'package', 'settings'] as const;

export function isMemberOnly(section: string): boolean {
  return (MEMBER_ONLY as readonly string[]).includes(section);
}

/**
 * Can this level open a project section? A visitor (`public_read`) opens everything but the member-only parts; whoever got
 * as far as the project as a member (or as a platform administrator) opens them all.
 */
export function canOpenSection(level: AccessLevel | null | undefined, section: string): boolean {
  return level === 'public_read' ? !isMemberOnly(section) : true;
}
