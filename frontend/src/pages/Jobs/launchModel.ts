import type { UsageView } from '../../api/auth';
import type { BimResourceRef, EngineCatalogEntry, EngineMode } from '../../api/client';
import type { LaunchRequest } from '../../api/jobs';
import type { ArtifactRef } from '../../api/library';
import type { CaseRevision } from '../../api/platform';
import type { CaseContent } from '../Project/projectModel';
import { planLimit } from '../Project/projectModel';
import { formatDate } from '../../utils/format';
import { shortDigest } from '../../utils/digest';
import { parseBindingSpace } from '../../components/BindingSpaceBadge/bindingSpace';
import { optionFacts } from '../Engines/enginesModel';
import { forecastBar, type ForecastBar } from './jobsModel';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const BUILTIN = 'bim.builtin';

// --- what to solve

export interface SourceChoice {
  id: string;
  kind: 'revision' | 'snapshot';
  label: string;
  detail: string;
  /** The snapshot the run starts from; `null` for a revision that has none yet (one is made when the person continues). */
  snapshotId: string | null;
  revision: CaseRevision | null;
  caseSlug: string | null;
  latest: boolean;
}

interface SourceInput {
  cases: readonly CaseContent[];
  caseSlug: string | null;
  revision: string | null;
  snapshot: string | null;
}

const newest = (revisions: readonly CaseRevision[]): CaseRevision[] => [...revisions].sort((a, b) => b.revision - a.revision);

/** The things a run can start from: the snapshot or revision the person came from first, then the project's latest revisions. */
export function sourceChoices({ cases, caseSlug, revision, snapshot }: SourceInput): SourceChoice[] {
  const choices: SourceChoice[] = [];
  if (snapshot) {
    choices.push({
      id: `snapshot:${snapshot}`, kind: 'snapshot', label: `Snapshot ${snapshot.slice(0, 8)}…`,
      detail: 'A compiled snapshot · it never changes', snapshotId: snapshot, revision: null, caseSlug: null, latest: false,
    });
  }
  const scope = caseSlug ? cases.filter((entry) => entry.item.slug === caseSlug) : cases.slice(0, 12);
  for (const entry of scope) {
    const revisions = newest(entry.revisions);
    const wanted = revision ? revisions.filter((candidate) => String(candidate.revision) === revision || candidate.id === revision) : [];
    const shown = caseSlug ? revisions.slice(0, 10) : [...wanted, ...revisions.slice(0, 1).filter((candidate) => !wanted.includes(candidate))];
    for (const candidate of shown) {
      const latest = candidate === revisions[0];
      choices.push({
        id: `revision:${candidate.id}`, kind: 'revision', label: `${entry.item.name} · revision ${candidate.revision}`,
        detail: `${latest ? 'Latest · ' : ''}Sealed ${formatDate(candidate.created_at) ?? 'on an unknown date'} · ${shortDigest(candidate.digest)}`,
        snapshotId: candidate.source_snapshot_id, revision: candidate, caseSlug: entry.item.slug, latest,
      });
    }
  }
  return choices;
}

/** The choice the address asks for: its revision, else its snapshot, else the first one offered. */
export function initialChoice(choices: readonly SourceChoice[], revision: string | null, snapshot: string | null): string {
  const byRevision = revision ? choices.find((choice) => choice.revision && (String(choice.revision.revision) === revision || choice.revision.id === revision)) : undefined;
  const bySnapshot = snapshot ? choices.find((choice) => choice.id === `snapshot:${snapshot}`) : undefined;
  return (byRevision ?? bySnapshot ?? choices[0])?.id ?? '';
}

// --- engines and modes

export interface ModeChoice {
  key: string;
  engine: BimResourceRef;
  /** The deployment that serves the mode; `null` when the catalog did not name one (the gateway picks the installed built-in). */
  registration: BimResourceRef | null;
  mode: string;
  compat: 'yes' | 'no' | 'unknown';
  reason: string | null;
  /** A deployment of the account's own, which counts as a federated solve. */
  federated: boolean;
}

const isRef = (value: unknown): value is BimResourceRef => isRecord(value)
  && typeof value.namespace === 'string' && typeof value.name === 'string' && typeof value.version === 'string' && typeof value.digest === 'string';

export const modeKey = (engine: BimResourceRef, mode: string, registration: BimResourceRef | null): string => (
  [engine.namespace, engine.name, engine.version, engine.digest, registration?.name ?? '', registration?.digest ?? '', mode].join('|')
);

/**
 * The engine modes the gateway says can (or cannot) run a snapshot. Without that reading (`compatible` is `null`) the catalog's own modes are
 * offered as unchecked: the gateway decides when the run is sent.
 */
export function modeChoices(compatible: unknown[] | null, catalog: readonly EngineCatalogEntry[]): ModeChoice[] {
  if (compatible) {
    const rows: ModeChoice[] = [];
    for (const item of compatible) {
      if (!isRecord(item) || !isRef(item.engine) || !isRef(item.registration) || typeof item.mode !== 'string') continue;
      const first = Array.isArray(item.diagnostics) ? item.diagnostics.find(isRecord) : undefined;
      const reason = first ? (typeof first.message === 'string' ? first.message : typeof first.code === 'string' ? first.code : null) : null;
      rows.push({
        key: modeKey(item.engine, item.mode, item.registration), engine: item.engine, registration: item.registration, mode: item.mode,
        compat: item.compatible === true ? 'yes' : 'no', reason, federated: item.registration.namespace !== BUILTIN,
      });
    }
    return rows.sort((a, b) => Number(b.compat === 'yes') - Number(a.compat === 'yes'));
  }
  return catalog.flatMap((entry) => entry.modes.map((mode) => ({
    key: modeKey(entry, mode.id, null),
    engine: { namespace: entry.namespace, name: entry.name, version: entry.version, digest: entry.digest },
    registration: null, mode: mode.id, compat: 'unknown' as const, reason: null, federated: entry.namespace !== BUILTIN,
  })));
}

/** `isa/random-search@1.0.0#sha256-…`, the address `?engine=` carries (`bimResourceKey`). */
export function parseEngineParam(value: string | null): BimResourceRef | null {
  const match = value?.match(/^(.+?)\/(.+?)@(.+?)#(.+)$/);
  return match ? { namespace: match[1], name: match[2], version: match[3], digest: match[4] } : null;
}

export function modeOfCatalog(catalog: readonly EngineCatalogEntry[], choice: ModeChoice | null): EngineMode | undefined {
  if (!choice) return undefined;
  const entry = catalog.find((item) => item.namespace === choice.engine.namespace && item.name === choice.engine.name && item.version === choice.engine.version);
  return entry?.modes.find((mode) => mode.id === choice.mode);
}

// --- settings against the plan

export interface PlanCeilings {
  /** Seconds one run may last; `null` when the plan has no ceiling or it is not known. */
  seconds: number | null;
  /** Iterations or evaluations one run may do. */
  iterations: number | null;
  /** log10 of the combinations the plan solves. */
  complexity: number | null;
}

/** A capability of the account if it reports one, else the plan's value in the pricing document; `null` for no limit or unknown. */
export function ceilingOf(usage: UsageView | null, catalog: Record<string, unknown> | null, plan: string | undefined, id: string): number | null {
  const reported = usage?.capabilities?.[id];
  if (typeof reported === 'number' && Number.isFinite(reported)) return reported;
  return planLimit(catalog, usage?.plan ?? plan, id);
}

export function planCeilingsOf(usage: UsageView | null, catalog: Record<string, unknown> | null, plan: string | undefined): PlanCeilings {
  return {
    seconds: ceilingOf(usage, catalog, plan, 'maxTimeoutSeconds'),
    iterations: ceilingOf(usage, catalog, plan, 'maxIterations'),
    complexity: ceilingOf(usage, catalog, plan, 'maxInstanceComplexityLog10'),
  };
}

export interface OptionInput {
  name: string;
  label: string;
  /** What the person types: seconds for a time budget, a plain count for the rest. */
  unit: string;
  default: number | null;
  kind: 'time' | 'effort' | 'other';
  /** The plan's ceiling in the unit of the input; `null` when the plan does not reduce it. */
  ceiling: number | null;
  integer: boolean;
}

const LABELS: Record<string, string> = { time_budget_ms: 'Time budget', iterations: 'Iterations', max_evaluations: 'Evaluations', population_size: 'Population' };

/** The numeric options a mode declares, as the form asks for them, with the plan’s ceiling beside each. */
export function optionInputs(mode: EngineMode | undefined, ceilings: PlanCeilings): OptionInput[] {
  if (!mode) return [];
  return optionFacts(mode)
    .filter((fact) => fact.type === 'integer' || fact.type === 'number' || typeof fact.default === 'number')
    .map((fact): OptionInput => {
      const kind: OptionInput['kind'] = fact.name === 'time_budget_ms' ? 'time' : fact.name === 'iterations' || fact.name === 'max_evaluations' ? 'effort' : 'other';
      const fallback = typeof fact.default === 'number' ? fact.default : null;
      return {
        name: fact.name,
        label: LABELS[fact.name] ?? fact.name.replace(/[_-]+/g, ' ').replace(/^./, (letter) => letter.toUpperCase()),
        unit: kind === 'time' ? 's' : kind === 'effort' ? (fact.name === 'iterations' ? 'iterations' : 'evaluations') : fact.unit ?? '',
        default: kind === 'time' && fallback !== null ? fallback / 1000 : fallback,
        kind,
        ceiling: kind === 'time' ? ceilings.seconds : kind === 'effort' ? ceilings.iterations : null,
        integer: fact.type !== 'number',
      };
    });
}

export interface OptionPlan {
  input: OptionInput;
  /** What the person typed; `null` when the field is empty (the engine's own default applies). */
  asked: number | null;
  /** What the run will use after the plan's reduction; `null` when nothing is sent. */
  effective: number | null;
  reduced: boolean;
  invalid: boolean;
}

export function parseAmount(raw: string): number | null | 'invalid' {
  const cleaned = raw.replace(/[\s,]/g, '');
  if (!cleaned) return null;
  const value = Number(cleaned);
  return Number.isFinite(value) && value > 0 ? value : 'invalid';
}

export function planOptions(inputs: readonly OptionInput[], values: Readonly<Record<string, string>>): OptionPlan[] {
  return inputs.map((input) => {
    const raw = input.name in values ? values[input.name] : input.default !== null ? String(input.default) : '';
    const parsed = parseAmount(raw);
    if (parsed === 'invalid') return { input, asked: null, effective: null, reduced: false, invalid: true };
    const effective = parsed === null ? null : input.ceiling !== null ? Math.min(parsed, input.ceiling) : parsed;
    return { input, asked: parsed, effective, reduced: parsed !== null && effective !== null && effective < parsed, invalid: false };
  });
}

/** The options as the API takes them: milliseconds for a time budget, whole numbers for a count. */
export function requestOptions(plans: readonly OptionPlan[]): Record<string, unknown> {
  const options: Record<string, unknown> = {};
  for (const plan of plans) {
    if (plan.asked === null) continue;
    const value = plan.input.kind === 'time' ? Math.round(plan.asked * 1000) : plan.input.integer ? Math.round(plan.asked) : plan.asked;
    options[plan.input.name] = value;
  }
  return options;
}

// --- the AutoRouter

export type AutoProfile = 'balanced' | 'quality_first' | 'latency_first' | 'cost_first';

export interface AutoPolicy {
  profile: AutoProfile;
  maxCredits: number;
  minQuality: number;
  maxFailureRisk: number;
  requireExact: boolean;
  allowFallback: boolean;
}

export const DEFAULT_POLICY: AutoPolicy = { profile: 'balanced', maxCredits: 40, minQuality: 0.85, maxFailureRisk: 0.3, requireExact: false, allowFallback: true };

export const PROFILE_LABELS: Record<AutoProfile, string> = {
  balanced: 'Balanced', quality_first: 'Quality first', latency_first: 'Latency first', cost_first: 'Cost first',
};

// --- the quota forecast

interface ForecastInput {
  usage: UsageView | null;
  ceilings: PlanCeilings;
  /** Seconds of solver time this run may take at most. */
  seconds: number;
  /** The size of the problem, as the exact number of bindings. */
  bindingSpace: string | null;
  plan: string | undefined;
}

/** What this run adds to the month: one solve, its solver time, one job slot, and how big the problem is for the plan. */
export function forecastOf({ usage, ceilings, seconds, bindingSpace, plan }: ForecastInput): ForecastBar[] {
  const read = (id: string): { used: number | null; limit: number | null } => {
    const entry = usage?.limits?.[id];
    return entry ? { used: entry.used, limit: entry.limit } : { used: usage ? 0 : null, limit: null };
  };
  const solves = read('taskStarts');
  const time = read('solverSeconds');
  const slots = read('concurrentJobs');
  const size = bindingSpace ? parseBindingSpace(bindingSpace).log10 : null;
  const reference = ceilings.complexity ?? Math.max(30, Math.ceil((size ?? 0) * 1.2));
  const sizeBar: ForecastBar = {
    label: 'Problem size',
    before: size === null ? 0 : Math.min(100, Math.round((size / reference) * 100)),
    add: 0,
    over: size !== null && ceilings.complexity !== null && size > ceilings.complexity,
    text: size === null
      ? 'The size of this problem isn’t known yet'
      : `≈ 10^${Math.round(size * 10) / 10} of up to ${ceilings.complexity !== null ? `10^${ceilings.complexity}` : 'no ceiling'}${plan ? ` on your ${plan} plan` : ''}`,
  };
  return [
    forecastBar('Solves this month', solves.used, solves.limit, 1, ''),
    forecastBar('Solver time this month', time.used, time.limit, seconds, ' s'),
    forecastBar('Jobs running at once', slots.used, slots.limit, 1, ''),
    sizeBar,
  ];
}

// --- the request

export type SettingsSource = 'inline' | 'saved';

export interface RequestInput {
  snapshot: string;
  settings: SettingsSource;
  configuration: ArtifactRef | null;
  auto: boolean;
  policy: AutoPolicy;
  mode: ModeChoice | null;
  options: Record<string, unknown>;
}

/** What `POST /v1/jobs` gets, or `null` while something is missing. Sealed settings go alone: they carry their own engine, mode and options. */
export function buildRequest(input: RequestInput): LaunchRequest | null {
  if (!input.snapshot) return null;
  if (input.settings === 'saved') return input.configuration ? { snapshot: input.snapshot, configuration: input.configuration } : null;
  if (input.auto) {
    return {
      snapshot: input.snapshot,
      engine: 'auto',
      options: {
        ...input.options,
        routing: {
          strategy: 'auto',
          profile: input.policy.profile,
          hardConstraints: {
            maxCredits: input.policy.maxCredits,
            minQuality: input.policy.minQuality,
            maxFailureRisk: input.policy.maxFailureRisk,
            requireExact: input.policy.requireExact,
          },
          adaptation: { allowFallback: input.policy.allowFallback },
        },
      },
    };
  }
  if (!input.mode || input.mode.compat === 'no') return null;
  // Without a named deployment the gateway finds the built-in one installed with the engine from the engine reference alone.
  return {
    snapshot: input.snapshot, engine: input.mode.engine, mode: input.mode.mode, options: input.options,
    ...(input.mode.registration ? { registration: input.mode.registration } : {}),
  };
}
