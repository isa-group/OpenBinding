import type { PricingCatalog, UsageView } from '../../api/auth';
import type { BindingCase, CaseRevision, Organization, OrganizationRole, ProjectAccessKind, Publication, Report, Study, StudyCell, StudyRun, Visibility } from '../../api/platform';
import { canWrite, levelOf, type AccessLevel } from './accessLevel';

export { atLeast, SLUG_PATTERN, slugFromName } from '../Organization/orgModel';
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
  /** Create cases, studies and reports; import packages. */
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
      ? ['Its card (name, description) appears in Explore', 'It stops counting as a private project for the sponsor']
      : ['It disappears from Explore', 'It counts as a private project for the sponsor'],
    stays: [
      'Cases, drafts and runs still need membership to open',
      'Nothing gets published: publishing is a separate step per report',
      'Already-published reports stay verifiable by fingerprint',
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

export interface CaseContent {
  item: BindingCase;
  revisions: CaseRevision[];
}

export interface StudyContent {
  study: Study;
  runs: StudyRun[];
  /** The cells of the latest run, read only for the studies a card shows. */
  latestCells?: StudyCell[];
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
 * Sealed items carry a fingerprint and never change: case revisions, frozen reports and study runs. A report draft
 * can still be edited. Studies themselves are definitions, so they are not counted here.
 */
export function integrityOf(input: { cases?: CaseContent[]; reports?: Report[]; studies?: StudyContent[] }): IntegrityItem[] {
  const revisions = (input.cases ?? []).reduce((total, entry) => total + entry.revisions.length, 0);
  const runs = (input.studies ?? []).reduce((total, entry) => total + entry.runs.length, 0);
  const frozen = (input.reports ?? []).filter((item) => item.state === 'frozen').length;
  const drafts = (input.reports ?? []).filter((item) => item.state === 'draft').length;
  const items: IntegrityItem[] = [
    { id: 'revisions', kind: 'sealed', count: revisions, singular: 'case revision', plural: 'case revisions' },
    { id: 'runs', kind: 'sealed', count: runs, singular: 'study run', plural: 'study runs' },
    { id: 'frozen', kind: 'sealed', count: frozen, singular: 'frozen report', plural: 'frozen reports' },
    { id: 'drafts', kind: 'draft', count: drafts, singular: 'report draft', plural: 'report drafts' },
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

// --- jobs

export type JobTone = 'running' | 'queued' | 'ok' | 'warn' | 'bad' | 'off';

/** The word and the colour of a job, from the state it reports and how it ended. */
export function jobStatus(status: string, termination?: string | null): { label: string; tone: JobTone } {
  const state = status.toLowerCase();
  if (state === 'running') return { label: 'Running', tone: 'running' };
  if (state === 'queued') return { label: 'Queued', tone: 'queued' };
  if (state === 'failed') return { label: 'Failed', tone: 'bad' };
  if (state === 'cancelled' || state === 'canceled') return { label: 'Cancelled', tone: 'off' };
  if (state === 'completed') {
    if (termination === 'INFEASIBLE') return { label: 'No feasible binding', tone: 'warn' };
    if (termination === 'OPTIMAL') return { label: 'Optimal', tone: 'ok' };
    if (termination === 'FEASIBLE') return { label: 'Feasible', tone: 'ok' };
    return { label: 'Completed', tone: 'ok' };
  }
  return { label: status, tone: 'off' };
}

// --- reports

export type ReportStanding = 'published' | 'frozen' | 'draft';

export function reportStanding(report: Report, publications: readonly Publication[]): ReportStanding {
  if (report.state === 'draft') return 'draft';
  const published = publications.some((item) => item.report_id === report.id && !item.withdrawn);
  return published ? 'published' : 'frozen';
}

// --- the import ceiling

/** The gateway refuses a package bigger than this whatever the plan says (`import_project_package`). */
export const GATEWAY_PACKAGE_LIMIT = 128 * 1024 * 1024;

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** The plan's value of a limit in the pricing document: its own, else the document's default; `null` when unlimited or unknown. */
export function planLimit(catalog: PricingCatalog | null | undefined, plan: string | undefined, id: string): number | null {
  if (!catalog || !plan) return null;
  const own = record(record(record(record(catalog.plans)[plan]).usageLimits)[id]);
  const raw = 'value' in own ? own.value : record(record(catalog.usageLimits)[id]).defaultValue;
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
}

export interface ImportCeiling {
  /** The plan's `maxPayloadBytes`, when it is known. */
  plan: number | null;
  /** What the gateway really accepts: the plan's ceiling, never above its own 128 MiB. */
  effective: number;
  /** The plan allows more than the gateway takes. */
  clamped: boolean;
}

export function importCeiling(usage: UsageView | null | undefined, catalog: PricingCatalog | null | undefined, plan: string | undefined): ImportCeiling {
  const fromUsage = usage?.capabilities?.maxPayloadBytes;
  const planValue = typeof fromUsage === 'number' && Number.isFinite(fromUsage) ? fromUsage : planLimit(catalog, plan, 'maxPayloadBytes');
  const effective = planValue === null ? GATEWAY_PACKAGE_LIMIT : Math.min(planValue, GATEWAY_PACKAGE_LIMIT);
  return { plan: planValue, effective, clamped: planValue !== null && planValue > GATEWAY_PACKAGE_LIMIT };
}
