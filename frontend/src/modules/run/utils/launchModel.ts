import type { UsageView } from '../../core/api/account';
import type { EngineCatalogEntry, EngineMode } from '../../engine/api/engineClient';
import type { ExecutionOptimization, LaunchRequest } from '../api/runsApi';
import type { PresetSettings } from '../api/presetsApi';
import type { ImmutableResourceRef, RunPresetView } from '../../core/api/types';
import type { ProblemRevision } from '../../problem/api/problemsClient';
import type { CaseContent } from '../../problem/api/loadProblems';
import { planLimit } from './jobStatus';
import { RANGE_CODE, RANGE_REFUSAL } from '../../core/utils/featureRange';
import { formatDate } from '../../core/utils/format';
import { parseBindingSpace } from '../../core/components/binding-space-badge/bindingSpace';
import { optionFacts } from '../../engine/api/enginesModel';
import type { ForecastBar } from './runsModel';
import { LIMIT } from '../../core/utils/limits';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const BUILTIN = 'bim.builtin';

// --- what to solve

export interface SourceChoice {
  id: string;
  label: string;
  detail: string;
  /** The problem revision the run names. */
  revision: ProblemRevision;
  caseSlug: string;
  latest: boolean;
}

interface SourceInput {
  cases: readonly CaseContent[];
  /** The problem the address names (`?problem=`). */
  problem: string | null;
  /** Its version, by number or id (`?revision=`). */
  revision: string | null;
}

const newest = (revisions: readonly ProblemRevision[]): ProblemRevision[] =>
  [...revisions].sort((a, b) => b.revision - a.revision);

/** The versions a run can start from: those of the problem the person came from, else the latest version of the organization's problems. */
export function sourceChoices({ cases, problem, revision }: SourceInput): SourceChoice[] {
  const choices: SourceChoice[] = [];
  const scope = problem ? cases.filter(entry => entry.item.slug === problem) : cases.slice(0, 12);
  for (const entry of scope) {
    const revisions = newest(entry.revisions);
    const wanted = revision
      ? revisions.filter(
          candidate => String(candidate.revision) === revision || candidate.id === revision
        )
      : [];
    const shown = problem
      ? revisions.slice(0, 10)
      : [...wanted, ...revisions.slice(0, 1).filter(candidate => !wanted.includes(candidate))];
    for (const candidate of shown) {
      const latest = candidate === revisions[0];
      choices.push({
        id: `revision:${candidate.id}`,
        label: `${entry.item.name} · version ${candidate.revision}`,
        detail: `${latest ? 'Latest · ' : ''}Sealed ${formatDate(candidate.created_at) ?? 'on an unknown date'}`,
        revision: candidate,
        caseSlug: entry.item.slug,
        latest,
      });
    }
  }
  return choices;
}

/** The choice the address asks for: its revision, else the first one offered. */
export function initialChoice(choices: readonly SourceChoice[], revision: string | null): string {
  const byRevision = revision
    ? choices.find(
        choice => String(choice.revision.revision) === revision || choice.revision.id === revision
      )
    : undefined;
  return (byRevision ?? choices[0])?.id ?? '';
}

// --- engines and modes

export interface ModeChoice {
  key: string;
  engine: ImmutableResourceRef;
  /** The deployment that serves the mode; `null` when the catalog did not name one (the gateway picks the installed built-in). */
  registration: ImmutableResourceRef | null;
  mode: string;
  compat: 'yes' | 'no' | 'unknown';
  reason: string | null;
  /** A deployment of the account's own. */
  federated: boolean;
  /** The package has ranges and this mode takes single values only (or the gateway refused it for that). */
  rangeRefusal?: boolean;
}

const isRef = (value: unknown): value is ImmutableResourceRef =>
  isRecord(value) &&
  typeof value.namespace === 'string' &&
  typeof value.name === 'string' &&
  typeof value.version === 'string' &&
  typeof value.digest === 'string';

export const modeKey = (
  engine: ImmutableResourceRef,
  mode: string,
  registration: ImmutableResourceRef | null
): string =>
  [
    engine.namespace,
    engine.name,
    engine.version,
    engine.digest,
    registration?.name ?? '',
    registration?.digest ?? '',
    mode,
  ].join('|');

/**
 * The engine modes the gateway says can (or cannot) run a problem version. Without that reading (`compatible` is `null`) the catalog's own modes are
 * offered as unchecked: the gateway decides when the run is sent.
 */
export function modeChoices(
  compatible: unknown[] | null,
  catalog: readonly EngineCatalogEntry[],
  ranges = false
): ModeChoice[] {
  const catalogMode = (engine: ImmutableResourceRef, mode: string): EngineMode | undefined =>
    catalog
      .find(
        entry =>
          entry.namespace === engine.namespace &&
          entry.name === engine.name &&
          entry.version === engine.version
      )
      ?.modes.find(item => item.id === mode);
  /** A package with ranges can only go to a mode that declares interval values; the gateway refuses it otherwise (`unsupported_capability_value`). */
  const refusesRanges = (engine: ImmutableResourceRef, mode: string) =>
    ranges && acceptsIntervals(catalogMode(engine, mode)) === false;
  if (compatible) {
    const rows: ModeChoice[] = [];
    for (const item of compatible) {
      if (
        !isRecord(item) ||
        !isRef(item.engine) ||
        !isRef(item.registration) ||
        typeof item.mode !== 'string'
      )
        continue;
      const first = Array.isArray(item.diagnostics) ? item.diagnostics.find(isRecord) : undefined;
      const said = first
        ? typeof first.message === 'string'
          ? first.message
          : typeof first.code === 'string'
            ? first.code
            : null
        : null;
      // The gateway's own verdict decides. When it turned a mode down for ranges (its code), or gave no reason and the mode's manifest
      // takes single values only, the reason says so; any other reason of the gateway is kept as it sent it.
      const rangeRefusal =
        item.compatible !== true &&
        (first?.code === RANGE_CODE || (said === null && refusesRanges(item.engine, item.mode)));
      rows.push({
        key: modeKey(item.engine, item.mode, item.registration),
        engine: item.engine,
        registration: item.registration,
        mode: item.mode,
        compat: item.compatible === true ? 'yes' : 'no',
        reason: rangeRefusal ? RANGE_REFUSAL : said,
        federated: item.registration.namespace !== BUILTIN,
        rangeRefusal,
      });
    }
    return rows.sort((a, b) => Number(b.compat === 'yes') - Number(a.compat === 'yes'));
  }
  return catalog.flatMap(entry =>
    entry.modes.map((mode): ModeChoice => {
      const rangeRefusal = refusesRanges(entry, mode.id);
      return {
        key: modeKey(entry, mode.id, null),
        engine: {
          namespace: entry.namespace,
          name: entry.name,
          version: entry.version,
          digest: entry.digest,
        },
        registration: null,
        mode: mode.id,
        compat: rangeRefusal ? 'no' : 'unknown',
        reason: rangeRefusal ? RANGE_REFUSAL : null,
        federated: entry.namespace !== BUILTIN,
        rangeRefusal,
      };
    })
  );
}

/**
 * Does the mode declare `featureValues` with `interval` (open ranges included)? `undefined` when the mode isn't known. The gateway makes the
 * dimension mandatory for `qos-binding/v1`, so a mode that doesn't name it accepts single values only.
 */
export function acceptsIntervals(mode: EngineMode | undefined): boolean | undefined {
  if (!mode) return undefined;
  const declared = mode.capabilities?.featureValues;
  if (!declared) return false;
  if (declared.selector === 'all') return true;
  return declared.selector === 'only' && (declared.values ?? []).includes('interval');
}

/** `isa/random-search@1.0.0#sha256-…`, the address `?engine=` carries (`bimResourceKey`). */
export function parseEngineParam(value: string | null): ImmutableResourceRef | null {
  const match = value?.match(/^(.+?)\/(.+?)@(.+?)#(.+)$/);
  return match
    ? { namespace: match[1], name: match[2], version: match[3], digest: match[4] }
    : null;
}

export function modeOfCatalog(
  catalog: readonly EngineCatalogEntry[],
  choice: ModeChoice | null
): EngineMode | undefined {
  if (!choice) return undefined;
  const entry = catalog.find(
    item =>
      item.namespace === choice.engine.namespace &&
      item.name === choice.engine.name &&
      item.version === choice.engine.version
  );
  return entry?.modes.find(mode => mode.id === choice.mode);
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
export function ceilingOf(
  usage: UsageView | null,
  catalog: Record<string, unknown> | null,
  plan: string | undefined,
  id: string
): number | null {
  const reported = usage?.capabilities?.[id];
  if (typeof reported === 'number' && Number.isFinite(reported)) return reported;
  return planLimit(catalog, usage?.plan ?? plan, id);
}

/**
 * The plan sets the time of a run (`maxRunMinutes`); the iterations and the problem size are bounded by the deployment
 * (`MAX_ITERATIONS`, `MAX_BINDING_SPACE_LOG10`), which the interface does not know: the gateway's answer says so.
 */
export function planCeilingsOf(
  usage: UsageView | null,
  catalog: Record<string, unknown> | null,
  plan: string | undefined
): PlanCeilings {
  const minutes = ceilingOf(usage, catalog, plan, LIMIT.maxRunMinutes);
  return {
    seconds: minutes === null ? null : minutes * 60,
    iterations: null,
    complexity: null,
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

const LABELS: Record<string, string> = {
  time_budget_ms: 'Time budget',
  iterations: 'Iterations',
  max_evaluations: 'Evaluations',
  population_size: 'Population',
};

/** The numeric options a mode declares, as the form asks for them, with the plan’s ceiling beside each. */
export function optionInputs(mode: EngineMode | undefined, ceilings: PlanCeilings): OptionInput[] {
  if (!mode) return [];
  return optionFacts(mode)
    .filter(
      fact => fact.type === 'integer' || fact.type === 'number' || typeof fact.default === 'number'
    )
    .map((fact): OptionInput => {
      const kind: OptionInput['kind'] =
        fact.name === 'time_budget_ms'
          ? 'time'
          : fact.name === 'iterations' || fact.name === 'max_evaluations'
            ? 'effort'
            : 'other';
      const fallback = typeof fact.default === 'number' ? fact.default : null;
      return {
        name: fact.name,
        label:
          LABELS[fact.name] ??
          fact.name.replace(/[_-]+/g, ' ').replace(/^./, letter => letter.toUpperCase()),
        unit:
          kind === 'time'
            ? 's'
            : kind === 'effort'
              ? fact.name === 'iterations'
                ? 'iterations'
                : 'evaluations'
              : (fact.unit ?? ''),
        default: kind === 'time' && fallback !== null ? fallback / 1000 : fallback,
        kind,
        ceiling:
          kind === 'time' ? ceilings.seconds : kind === 'effort' ? ceilings.iterations : null,
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

/** A budget (time, iterations, evaluations) must be above 0; any other option (a seed, say) may be 0, and a whole number when its schema says integer. */
export function allowsZero(input: OptionInput): boolean {
  return input.kind === 'other';
}

export function parseAmount(
  raw: string,
  { zero = false, integer = false }: { zero?: boolean; integer?: boolean } = {}
): number | null | 'invalid' {
  const cleaned = raw.replace(/[\s,]/g, '');
  if (!cleaned) return null;
  const value = Number(cleaned);
  if (!Number.isFinite(value) || (zero ? value < 0 : value <= 0)) return 'invalid';
  return integer && !Number.isInteger(value) ? 'invalid' : value;
}

export function planOptions(
  inputs: readonly OptionInput[],
  values: Readonly<Record<string, string>>
): OptionPlan[] {
  return inputs.map(input => {
    const raw =
      input.name in values
        ? values[input.name]
        : input.default !== null
          ? String(input.default)
          : '';
    const zero = allowsZero(input);
    const parsed = parseAmount(raw, { zero, integer: zero && input.integer });
    if (parsed === 'invalid')
      return { input, asked: null, effective: null, reduced: false, invalid: true };
    const effective =
      parsed === null ? null : input.ceiling !== null ? Math.min(parsed, input.ceiling) : parsed;
    return {
      input,
      asked: parsed,
      effective,
      reduced: parsed !== null && effective !== null && effective < parsed,
      invalid: false,
    };
  });
}

/** The options as the API takes them: milliseconds for a time budget, whole numbers for a count. */
export function requestOptions(plans: readonly OptionPlan[]): Record<string, unknown> {
  const options: Record<string, unknown> = {};
  for (const plan of plans) {
    if (plan.asked === null) continue;
    const value =
      plan.input.kind === 'time'
        ? Math.round(plan.asked * 1000)
        : plan.input.integer
          ? Math.round(plan.asked)
          : plan.asked;
    options[plan.input.name] = value;
  }
  return options;
}

// --- the size forecast

interface ForecastInput {
  ceilings: PlanCeilings;
  /** The size of the problem, as the exact number of bindings. */
  bindingSpace: string | null;
  plan: string | undefined;
}

/** How big the problem is against the plan's ceiling. Nothing is consumed by a run, so this is the only measure. */
export function forecastOf({ ceilings, bindingSpace, plan }: ForecastInput): ForecastBar[] {
  const size = bindingSpace ? parseBindingSpace(bindingSpace).log10 : null;
  const reference = ceilings.complexity ?? Math.max(30, Math.ceil((size ?? 0) * 1.2));
  const sizeBar: ForecastBar = {
    label: 'Problem size',
    before: size === null ? 0 : Math.min(100, Math.round((size / reference) * 100)),
    add: 0,
    over: size !== null && ceilings.complexity !== null && size > ceilings.complexity,
    text:
      size === null
        ? 'The size of this problem isn’t known yet'
        : ceilings.complexity !== null
          ? `≈ 10^${Math.round(size * 10) / 10} of up to 10^${ceilings.complexity}${plan ? ` on your ${plan} plan` : ''}`
          : `≈ 10^${Math.round(size * 10) / 10} combinations · this deployment sets the ceiling`,
  };
  return [sizeBar];
}

// --- the optimization a run selects

/**
 * How many criteria the compiled problem optimizes (`spec.optimization.criteria`), or `null` when the form can't be read. Not knowing it
 * sends no optimization and leaves the gateway to refuse the run in its own words.
 */
export function criteriaCountOf(compiled: unknown): number | null {
  const document = isRecord(compiled) && isRecord(compiled.document) ? compiled.document : compiled;
  if (!isRecord(document) || !isRecord(document.spec)) return null;
  const optimization = document.spec.optimization;
  if (!isRecord(optimization)) return 0;
  return Array.isArray(optimization.criteria) ? optimization.criteria.length : 0;
}

/** SINGLE for at most one criterion, MULTI for two or three, MANY beyond. */
export function optimizationTypeOf(criteria: number): ExecutionOptimization['type'] {
  return criteria <= 1 ? 'SINGLE' : criteria <= 3 ? 'MULTI' : 'MANY';
}

/**
 * The execution-time optimization for a mode: SINGLE for one criterion, MULTI for two or three, MANY beyond; the first scalarization the
 * mode declares for that type (`feasibility` when there is no criterion at all). `null` when the mode declares none that fits, or the
 * number of criteria is not known.
 */
export function optimizationFor(
  mode: EngineMode | undefined,
  criteria: number | null
): ExecutionOptimization | null {
  if (!mode || criteria === null) return null;
  const declared = (mode.capabilities as unknown as Record<string, unknown>).scalarizations;
  const values =
    isRecord(declared) && Array.isArray(declared.values) ? declared.values.filter(isRecord) : [];
  const type = optimizationTypeOf(criteria);
  const fits = (item: Record<string, unknown>) =>
    typeof item.id === 'string' &&
    Array.isArray(item.objectiveTypes) &&
    item.objectiveTypes.includes(type);
  const picked =
    criteria === 0
      ? values.find(item => item.id === 'feasibility' && fits(item))
      : values.find(fits);
  return picked ? { type, scalarization: picked.id as string } : null;
}

// --- run presets

const sameRef = (a: ImmutableResourceRef, b: ImmutableResourceRef) =>
  a.namespace === b.namespace &&
  a.name === b.name &&
  a.version === b.version &&
  a.digest === b.digest;

/**
 * The engine mode of the offered ones that a preset names: its exact engine (or the built-in one of that name), its mode (any of the
 * engine's when it names none) and its deployment (a built-in one when it names none). `null` when none is offered: the gateway then
 * decides when the run is sent.
 */
export function presetModeOf(
  preset: Pick<RunPresetView, 'engine' | 'mode' | 'registration'>,
  modes: readonly ModeChoice[]
): ModeChoice | null {
  const exact = typeof preset.engine === 'string' ? null : preset.engine;
  const registration = isRef(preset.registration) ? preset.registration : null;
  return (
    modes.find(
      mode =>
        (exact
          ? sameRef(mode.engine, exact)
          : mode.engine.name === preset.engine && !mode.federated) &&
        (!preset.mode || mode.mode === preset.mode) &&
        (registration
          ? mode.registration !== null && sameRef(mode.registration, registration)
          : !mode.federated)
    ) ?? null
  );
}

/** What the settings form shows for a preset's options once it is detached: seconds for a time budget, the number as written for the rest. */
export function presetValues(
  options: Readonly<Record<string, unknown>>,
  inputs: readonly OptionInput[]
): Record<string, string> {
  const values: Record<string, string> = {};
  for (const input of inputs) {
    const value = options[input.name];
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    values[input.name] = String(input.kind === 'time' ? value / 1000 : value);
  }
  return values;
}

/**
 * The settings chosen by hand as a preset holds them: the exact engine and mode, the deployment only when it is the account's own
 * (a built-in one is the engine's installed deployment, which a preset leaves out), the options and the optimization.
 */
export function presetSettingsOf(
  mode: ModeChoice,
  options: Record<string, unknown>,
  optimization: ExecutionOptimization | null
): PresetSettings {
  return {
    engine: mode.engine,
    registration: mode.federated && mode.registration ? mode.registration : null,
    mode: mode.mode,
    options,
    optimization,
  };
}

// --- the request

export interface RequestInput {
  /** The id of the problem revision to run. */
  revision: string;
  mode: ModeChoice | null;
  options: Record<string, unknown>;
  /** What the mode and the problem allow, from {@link optimizationFor}; left out of the request when `null`. */
  optimization?: ExecutionOptimization | null;
  /** The slug of the run preset the run starts from: it carries every setting, so nothing else is sent. */
  preset?: string | null;
}

/** What `createRun` gets, or `null` while something is missing. */
export function buildRequest(input: RequestInput): LaunchRequest | null {
  if (!input.revision) return null;
  if (input.preset) return { revision: input.revision, preset: input.preset };
  if (!input.mode || input.mode.compat === 'no') return null;
  // Without a named deployment the gateway finds the built-in one installed with the engine from the engine reference alone.
  return {
    revision: input.revision,
    engine: input.mode.engine,
    mode: input.mode.mode,
    options: input.options,
    ...(input.mode.registration ? { registration: input.mode.registration } : {}),
    ...(input.optimization ? { optimization: input.optimization } : {}),
  };
}
