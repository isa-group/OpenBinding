import type { Organization, OrganizationRole, ProjectAccessKind, Visibility } from '../../api/platform';
import { canWrite, levelOf, type AccessLevel } from './accessLevel';

export { atLeast } from '../Organization/orgModel';
export { canOpenSection, canRead, canWrite, levelOf, type AccessLevel } from './accessLevel';

/** The longest a name and a description may be (`ProjectCreate` in the contract). */
export const NAME_MAX = 160;
export const DESCRIPTION_MAX = 2000;

/** Who can do what in a project: its organization decides, by the role the account has there. */
export interface ProjectAccess {
  role: OrganizationRole | null;
  /** `public_read` for a visitor of a public project, else the role (`ADMIN` for a platform administrator with none); `null` when there is no way in. */
  level: AccessLevel | null;
  /** A visitor of a public project: everything reads, nothing writes, and jobs, package and settings are out of reach. */
  publicRead: boolean;
  /** Create cases and studies; import packages. */
  canCreate: boolean;
  /** Rename, change visibility, delete. */
  canAdminister: boolean;
}

/**
 * Who can do what in a project. `kind` is the project's own `access`: `public_read` wins over everything, a platform
 * administrator included, because the gateway answers a visitor with GET only.
 */
export function accessIn(organization: Pick<Organization, 'effective_role'>, platformAdmin = false, kind?: ProjectAccessKind): ProjectAccess {
  const role = organization.effective_role;
  // A platform administrator who is not a member keeps the reach the gateway gives them (they act as ADMIN).
  const level = levelOf(kind, role) ?? (platformAdmin ? 'ADMIN' : null);
  return {
    role,
    level,
    publicRead: level === 'public_read',
    canCreate: canWrite(level, 'MEMBER'),
    canAdminister: canWrite(level, 'ADMIN'),
  };
}

export function visibilityLabel(visibility: Visibility): string {
  return visibility === 'public' ? 'Public' : 'Private';
}

/** What changing a project to `next` does and does not do, in the words of the visibility panel. */
export function visibilityEffects(next: Visibility): { changes: string[]; stays: string[] } {
  return {
    changes: next === 'public'
      ? ['Anybody can read it, without changing anything']
      : ['Only its members can read it'],
    stays: [
      'Runs and the settings still need membership to open',
    ],
  };
}

