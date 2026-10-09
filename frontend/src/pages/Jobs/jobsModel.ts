import type { JobSolution } from '../../api/jobs';
import type { Job } from '../../api/platform';
import { formatDateTime } from '../../utils/format';

export { jobStatus } from '../Project/projectModel';
export type { JobTone } from '../Project/projectModel';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const text = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

// --- states

export type StatusFilter = '' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export const STATUS_FILTERS: ReadonlyArray<{ id: StatusFilter; label: string }> = [
  { id: '', label: 'All' },
  { id: 'queued', label: 'Queued' },
  { id: 'running', label: 'Running' },
  { id: 'completed', label: 'Completed' },
  { id: 'failed', label: 'Failed' },
  { id: 'cancelled', label: 'Cancelled' },
];

/** Still moving: its state can change, so the screen keeps asking. */
export const isActive = (status: string) => status === 'queued' || status === 'running';

/** Only failed or cancelled runs can be retried (409 otherwise). */
export const canRetryState = (status: string) => status === 'failed' || status === 'cancelled';

export const normalizeStatus = (status: string): string => (status.toLowerCase() === 'canceled' ? 'cancelled' : status.toLowerCase());

export function statusCounts(rows: ReadonlyArray<{ status: string }>): Record<string, number> {
  const counts: Record<string, number> = { '': rows.length };
  for (const row of rows) counts[normalizeStatus(row.status)] = (counts[normalizeStatus(row.status)] ?? 0) + 1;
  return counts;
}

// --- outcomes

export type OutcomeTone = 'success' | 'warning' | 'plain';

/** The plain-language outcome of a finished run. */
export function outcomeOf(termination: string | null | undefined): { label: string; long: string; tone: OutcomeTone } | null {
  switch (termination) {
    case 'OPTIMAL': return { label: 'Optimal', long: 'Optimal: no better combination exists', tone: 'success' };
    case 'FEASIBLE': return { label: 'Feasible', long: 'Feasible: meets every must-hold rule', tone: 'success' };
    case 'INFEASIBLE': return { label: 'No feasible binding', long: 'Infeasible: no combination meets the rules', tone: 'warning' };
    case 'UNKNOWN': return { label: 'No conclusion', long: 'No conclusion', tone: 'plain' };
    default: return null;
  }
}

// --- time

export function secondsBetween(from: string | null | undefined, to: string | null | undefined): number | null {
  if (!from || !to) return null;
  const seconds = (Date.parse(to) - Date.parse(from)) / 1000;
  return Number.isFinite(seconds) ? Math.max(0, Math.round(seconds)) : null;
}

/** `1 min 5 s`, `40 s`. */
export function formatTook(seconds: number | null): string {
  if (seconds === null) return '—';
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ${seconds % 60} s`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

export const tookOf = (job: Pick<Job, 'created_at' | 'finished_at'>): number | null => secondsBetween(job.created_at, job.finished_at);

/** The length of a bar for a duration, against two minutes. */
export const tookPercent = (seconds: number | null): number => (seconds === null ? 0 : Math.min(100, Math.round((seconds / 120) * 100)));

export const shortJobId = (id: string): string => `${id.slice(0, 8)}…${id.slice(-4)}`;

// --- the settings of a run: asked, used

const OPTION_LABELS: Record<string, { label: string; unit: string }> = {
  time_budget_ms: { label: 'Time budget', unit: 'ms' },
  iterations: { label: 'Iterations', unit: 'iterations' },
  max_evaluations: { label: 'Evaluations', unit: 'evaluations' },
  population_size: { label: 'Population', unit: 'individuals' },
  seed: { label: 'Seed', unit: '' },
};

export function optionLabel(name: string): string {
  return OPTION_LABELS[name]?.label ?? name.replace(/[_-]+/g, ' ').replace(/^./, (letter) => letter.toUpperCase());
}

/** `60 s` for a time budget, `100,000` for a count, the JSON of anything else. */
export function formatOption(name: string, value: unknown): string {
  if (typeof value === 'number') {
    if (name === 'time_budget_ms') return value % 1000 === 0 ? `${(value / 1000).toLocaleString('en-US')} s` : `${value.toLocaleString('en-US')} ms`;
    return value.toLocaleString('en-US');
  }
  if (typeof value === 'string' || typeof value === 'boolean') return String(value);
  return value === undefined || value === null ? '—' : JSON.stringify(value);
}

export interface OptionRow {
  key: string;
  label: string;
  asked: string;
  used: string;
  /** The plan brought it down to its ceiling. */
  reduced: boolean;
  note: string | null;
}

/** Settings asked for against the ones the run used, with the plan's reductions (`OPTION_CLAMPED`) named. */
export function optionRows(provenance: Record<string, unknown> | null | undefined): OptionRow[] {
  const requested = provenance?.requestedOptions;
  const effective = provenance?.options;
  const notes = provenance?.warnings;
  const asked: Record<string, unknown> = isRecord(requested) ? requested : {};
  const used: Record<string, unknown> = isRecord(effective) ? effective : {};
  const warnings: Array<Record<string, unknown>> = Array.isArray(notes) ? notes.filter(isRecord) : [];
  const reduced = new Map<string, Record<string, unknown>>();
  for (const warning of warnings) {
    const details = isRecord(warning.details) ? warning.details : {};
    if (warning.code === 'OPTION_CLAMPED' && typeof details.option === 'string') reduced.set(details.option, warning);
  }
  const names = [...new Set([...Object.keys(asked), ...Object.keys(used)])].filter((name) => name !== 'routing');
  return names.map((name) => {
    const warning = reduced.get(name);
    return {
      key: name,
      label: optionLabel(name),
      asked: name in asked ? formatOption(name, asked[name]) : 'Not set',
      used: name in used ? formatOption(name, used[name]) : '—',
      reduced: Boolean(warning),
      note: warning ? text(warning.message) : null,
    };
  });
}

// --- engine, routing and pins

export interface ResourcePin {
  namespace: string;
  name: string;
  version: string;
  digest: string | null;
}

function pinOf(value: unknown): ResourcePin | null {
  if (!isRecord(value)) return null;
  const name = text(value.name);
  if (!name) return null;
  return { namespace: text(value.namespace) ?? '', name, version: text(value.version) ?? '', digest: text(value.digest) };
}

export interface JobPins {
  engine: ResourcePin | null;
  registration: ResourcePin | null;
  mode: string | null;
  algorithm: string | null;
  compiledForm: string | null;
  instance: string | null;
  package: string | null;
  checkedBy: string | null;
  configuration: string | null;
  limits: string[];
}

export function readPins(provenance: Record<string, unknown> | null | undefined): JobPins {
  const p: Record<string, unknown> = provenance ?? {};
  const configuration = isRecord(p.configuration) ? p.configuration : null;
  const limits = isRecord(p.limits) ? p.limits : {};
  const limitLines: string[] = [];
  const seconds = num(limits.effectiveTimeoutSeconds);
  if (seconds !== null) limitLines.push(`${seconds.toLocaleString('en-US')} s per run`);
  return {
    engine: pinOf(p.engine),
    registration: pinOf(p.registration),
    mode: text(p.mode),
    algorithm: text(p.algorithm),
    compiledForm: text(p.irDigest),
    instance: text(p.instanceDigest),
    package: text(p.packageDigest),
    checkedBy: text(p.evaluator),
    configuration: configuration ? `${text(configuration.name) ?? 'configuration'}@${text(configuration.version) ?? '?'}` : null,
    limits: limitLines,
  };
}

export interface RoutingDecision {
  engine: string;
  mode: string;
  reason: string;
  utility: number | null;
  credits: number | null;
  fallback: boolean;
}

/** What the AutoRouter chose, when it chose. */
export function readRouting(provenance: Record<string, unknown> | null | undefined): RoutingDecision | null {
  const routing = provenance?.engineRouting;
  if (!isRecord(routing)) return null;
  return {
    engine: text(routing.selectedEngine) ?? '—',
    mode: text(routing.selectedMode) ?? '—',
    reason: text(routing.adaptationReason) ?? '',
    utility: num(routing.utilityScore),
    credits: num(routing.creditsCost),
    fallback: routing.fallbackActivated === true,
  };
}

export interface RoutingCandidate {
  engine: string;
  admissible: boolean;
  utility: number | null;
  rejection: string | null;
}

export interface AdminRouting {
  loop: string | null;
  workload: Array<[string, string]>;
  candidates: RoutingCandidate[];
}

/** The diagnostic telemetry the gateway only sends on an administrator's own jobs. */
export function readAdminRouting(provenance: Record<string, unknown> | null | undefined): AdminRouting | null {
  const admin = provenance?.engineRoutingAdmin;
  if (!isRecord(admin)) return null;
  const features = isRecord(admin.workloadFeatures) ? admin.workloadFeatures : {};
  const candidates = Array.isArray(admin.candidateEvaluations) ? admin.candidateEvaluations.filter(isRecord) : [];
  return {
    loop: text(admin.adaptationLoopId),
    workload: Object.entries(features).map(([key, value]) => [key, typeof value === 'number' ? String(Math.round(value * 1000) / 1000) : String(value)]),
    candidates: candidates.map((candidate) => ({
      engine: text(candidate.engine) ?? '—',
      admissible: candidate.admissible === true,
      utility: num(candidate.utility),
      rejection: text(candidate.rejectionReason),
    })),
  };
}

// --- the timeline: status changes only

export interface TimelineStep {
  key: string;
  label: string;
  when: string;
  state: 'done' | 'current' | 'waiting' | 'bad';
}

/**
 * The steps a run has gone through. The live updates report status snapshots only, so there is no progress to draw and the time
 * of "running" is not known; each step says what is known about it.
 */
export function timelineOf(status: string, times: { created?: string | null; finished?: string | null }): TimelineStep[] {
  const state = normalizeStatus(status);
  const created = formatDateTime(times.created) ?? 'when it was sent';
  const finished = formatDateTime(times.finished) ?? 'finished';
  const steps: TimelineStep[] = [{ key: 'queued', label: 'Queued', when: created, state: state === 'queued' ? 'current' : 'done' }];
  if (state === 'cancelled' || state === 'failed' || state === 'completed') {
    const lived = secondsBetween(times.created, times.finished);
    const reachedRunning = !(state === 'cancelled' && lived !== null && lived < 5);
    steps.push({ key: 'running', label: 'Running', when: reachedRunning ? 'started' : 'never started', state: reachedRunning ? 'done' : 'waiting' });
    steps.push({
      key: state, label: state === 'completed' ? 'Completed' : state === 'failed' ? 'Failed' : 'Cancelled', when: finished,
      state: state === 'failed' ? 'bad' : 'done',
    });
    return steps;
  }
  steps.push({ key: 'running', label: 'Running', when: state === 'running' ? 'in progress' : 'waiting', state: state === 'running' ? 'current' : 'waiting' });
  steps.push({ key: 'finished', label: 'Finishes', when: 'waiting', state: 'waiting' });
  return steps;
}

// --- results

export interface BindingRow {
  task: string;
  resource: string;
  candidate: string;
}

export function bindingRows(solution: JobSolution | undefined): BindingRow[] {
  const binding = solution?.decision?.binding;
  if (!isRecord(binding)) return [];
  return Object.entries(binding).map(([task, target]) => ({
    task,
    resource: isRecord(target) ? text(target.resource) ?? '' : '',
    candidate: isRecord(target) ? text(target.id) ?? '' : String(target),
  }));
}

export function metricEntries(solution: JobSolution | undefined): Array<[string, number]> {
  const metrics = solution?.metrics;
  if (!isRecord(metrics)) return [];
  return Object.entries(metrics).filter((entry): entry is [string, number] => typeof entry[1] === 'number');
}

export function scoreText(solution: JobSolution | undefined): string | null {
  const score = solution?.objectives?.score;
  const fmt = (value: number) => value.toLocaleString('en-US', { maximumFractionDigits: 4 });
  if (typeof score === 'number') return fmt(score);
  if (Array.isArray(score)) return `[${score.map(fmt).join(', ')}]`;
  return null;
}

export function violationsOf(solution: JobSolution | undefined): Array<Record<string, unknown>> {
  const found = solution?.violations;
  return Array.isArray(found) ? found.filter(isRecord) : [];
}

export function numberText(value: number): string {
  return value.toLocaleString('en-US', { maximumFractionDigits: 4 });
}

// --- the quota forecast of a launch

export interface ForecastBar {
  label: string;
  /** Share of the limit already used, 0-100. */
  before: number;
  /** Share this run adds, 0-100. */
  add: number;
  over: boolean;
  text: string;
}

/**
 * A used/limit bar with the part this run adds. `used` is `null` when the usage could not be read, and `limit` is `null`
 * (or 0) when the plan has no limit.
 */
export function forecastBar(label: string, used: number | null, limit: number | null, add: number, unit: string): ForecastBar {
  const n = (value: number) => value.toLocaleString('en-US');
  if (!limit) return { label, before: 0, add: 0, over: false, text: 'No limit on your plan' };
  if (used === null) {
    return { label, before: 0, add: Math.min(100, Math.round((add / limit) * 100)), over: false, text: `Your usage can’t be read right now · limit ${n(limit)}${unit}` };
  }
  const before = Math.min(100, Math.round((used / limit) * 100));
  const over = used + add > limit;
  return {
    label, before, over,
    add: Math.max(2, Math.min(100 - before, Math.round((add / limit) * 100))),
    text: `${n(used)} used + up to ${n(add)} = ${n(used + add)} of ${n(limit)}${unit}${over ? ' · over the limit' : ''}`,
  };
}
