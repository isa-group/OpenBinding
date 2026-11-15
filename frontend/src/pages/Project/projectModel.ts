import type { Organization, OrganizationRole, ProjectAccessKind, StudyCell, StudyRun, Visibility } from '../../api/platform';
import type { StudyContent } from '../../features/workspace/model';
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

// --- what is sealed and what is still a draft

export interface IntegrityItem {
  id: string;
  kind: 'sealed' | 'draft';
  count: number;
  /** `case revision` / `case revisions`. */
  singular: string;
  plural: string;
}

export function latestRun(runs: readonly StudyRun[]): StudyRun | undefined {
  return runs.reduce<StudyRun | undefined>((best, run) => (!best || run.run_number > best.run_number ? run : best), undefined);
}

/** How the cells of a run ended, for the stacked bar of a study. */
export function cellBreakdown(cells: readonly StudyCell[]): Array<{ id: 'completed' | 'failed' | 'cancelled' | 'pending'; count: number; label: string }> {
  const count = (states: string[]) => cells.filter((cell) => states.includes(cell.state)).length;
  return [
    { id: 'completed' as const, count: count(['completed']), label: 'completed' },
    { id: 'failed' as const, count: count(['failed']), label: 'failed' },
    { id: 'cancelled' as const, count: count(['cancelled']), label: 'cancelled' },
    { id: 'pending' as const, count: count(['queued', 'running', 'partial']), label: 'in progress' },
  ].filter((item) => item.count > 0);
}

/**
 * Sealed items carry a fingerprint and never change: case revisions and study runs. Studies themselves are definitions,
 * so they are not counted here.
 */
export function integrityOf(input: { studies?: StudyContent[] }): IntegrityItem[] {
  const runs = (input.studies ?? []).reduce((total, entry) => total + entry.runs.length, 0);
  const items: IntegrityItem[] = [
    { id: 'runs', kind: 'sealed', count: runs, singular: 'study run', plural: 'study runs' },
  ];
  return items.filter((item) => item.count > 0);
}

export function sealedShare(items: readonly IntegrityItem[]): { sealed: number; drafts: number; sealedPct: number; draftPct: number } {
  const sealed = items.filter((item) => item.kind === 'sealed').reduce((total, item) => total + item.count, 0);
  const drafts = items.filter((item) => item.kind === 'draft').reduce((total, item) => total + item.count, 0);
  const total = sealed + drafts;
  return { sealed, drafts, sealedPct: total ? Math.round((sealed / total) * 100) : 0, draftPct: total ? Math.round((drafts / total) * 100) : 0 };
}

export function countWord(item: Pick<IntegrityItem, 'count' | 'singular' | 'plural'>): string {
  return item.count === 1 ? item.singular : item.plural;
}

