import type { CaseRevision, Study, StudyCell, StudyRun } from '../../api/platform';
import type { BimResourceRef, EngineCatalogEntry, EngineMode } from '../../api/client';
import { bimResourceKey } from '../../api/client';
import type { ExecutionOptimization } from '../../api/jobs';
import type { CaseContent } from '../Project/projectModel';
import { criteriaCountOf, optimizationFor, optimizationTypeOf } from '../Jobs/launchModel';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// --- the limits the gateway enforces on one study (`StudyDefinition`, `create_study`)

export const MAX_CELLS = 10_000;
export const MAX_CASES = 250;
export const MAX_ENGINES = 50;
export const MAX_SETTINGS = 100;
export const MAX_SEEDS = 100;

export const plural = (count: number, one: string, many = `${one}s`): string => `${count.toLocaleString('en-US')} ${count === 1 ? one : many}`;

export interface MatrixSize {
  cases: number;
  engines: number;
  settings: number;
  seeds: number;
  cells: number;
}

export function matrixSize(parts: { cases: number; engines: number; settings: number; seeds: number }): MatrixSize {
  return { ...parts, cells: parts.cases * parts.engines * parts.settings * parts.seeds };
}

/** The matrix a sealed definition spells out: every combination of case revision × engine × setting × seed is one cell. */
export function definitionSize(definition: Study['definition']): MatrixSize {
  return matrixSize({
    cases: definition.case_revision_ids?.length ?? 0,
    engines: definition.engines?.length ?? 0,
    settings: definition.parameter_sets?.length ?? 0,
    seeds: definition.seeds?.length ?? 0,
  });
}

/** `2 case revisions × 2 engines × 1 setting × 2 seeds`. */
export function formulaOf(size: MatrixSize): string {
  return `${plural(size.cases, 'case revision')} × ${plural(size.engines, 'engine')} × ${plural(size.settings, 'setting')} × ${plural(size.seeds, 'seed')}`;
}

// --- seeds

export interface SeedReading {
  seeds: number[];
  /** What is wrong with the text, in a sentence; `undefined` when it reads. */
  error?: string;
}

/** `1, 2, 5-7` → `[1, 2, 5, 6, 7]`. Each value may appear once; at most {@link MAX_SEEDS} of them. */
export function readSeeds(text: string): SeedReading {
  const tokens = text.split(/[,\s]+/).filter(Boolean);
  if (tokens.length === 0) return { seeds: [], error: 'Give at least one seed.' };
  const seeds: number[] = [];
  const seen = new Set<number>();
  for (const token of tokens) {
    const range = token.match(/^(-?\d+)-(\d+)$/);
    const parts = range ? [Number(range[1]), Number(range[2])] : /^-?\d+$/.test(token) ? [Number(token), Number(token)] : null;
    if (!parts || !Number.isSafeInteger(parts[0]) || !Number.isSafeInteger(parts[1])) {
      return { seeds: [], error: `“${token}” isn’t a whole number. Use numbers like 1, 2, 3 or a range like 1-5.` };
    }
    if (parts[1] < parts[0]) return { seeds: [], error: `“${token}” runs backwards. Write the smaller number first.` };
    if (parts[1] - parts[0] + 1 > MAX_SEEDS) return { seeds: [], error: `A study takes at most ${MAX_SEEDS} seeds.` };
    for (let value = parts[0]; value <= parts[1]; value += 1) {
      if (seen.has(value)) return { seeds, error: `Seed ${value} appears twice. Each value can appear once.` };
      seen.add(value);
      seeds.push(value);
      if (seeds.length > MAX_SEEDS) return { seeds, error: `A study takes at most ${MAX_SEEDS} seeds.` };
    }
  }
  return { seeds };
}

// --- settings: the parameter sets of the definition

export interface Variant {
  id: string;
  /** Seconds, as typed; empty keeps the engine's own default. */
  seconds: string;
  iterations: string;
  /** More options as a JSON object. */
  extra: string;
}

export const emptyVariant = (id: string): Variant => ({ id, seconds: '', iterations: '', extra: '' });

export interface VariantReading {
  parameters: Record<string, unknown>;
  error?: string;
}

/** The parameter set one row stands for. A time budget goes in milliseconds, as the engines take it. */
export function readVariant(variant: Variant): VariantReading {
  const parameters: Record<string, unknown> = {};
  if (variant.extra.trim()) {
    try {
      const parsed: unknown = JSON.parse(variant.extra);
      if (!isRecord(parsed)) return { parameters, error: 'Other options must be a JSON object, like {"population_size": 40}.' };
      Object.assign(parameters, parsed);
    } catch {
      return { parameters, error: 'Other options aren’t valid JSON.' };
    }
  }
  if (variant.seconds.trim()) {
    const seconds = Number(variant.seconds.replace(/,/g, ''));
    if (!Number.isFinite(seconds) || seconds <= 0) return { parameters, error: 'The time budget must be a number of seconds above zero.' };
    parameters.time_budget_ms = Math.round(seconds * 1000);
  }
  if (variant.iterations.trim()) {
    const iterations = Number(variant.iterations.replace(/,/g, ''));
    if (!Number.isInteger(iterations) || iterations <= 0) return { parameters, error: 'Iterations must be a whole number above zero.' };
    parameters.iterations = iterations;
  }
  return { parameters };
}

const stable = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
};

/** Two parameter sets that say the same thing, in any key order, have the same key. */
export const parametersKey = (parameters: unknown): string => stable(parameters ?? {});

export function describeParameters(parameters: Record<string, unknown> | undefined): string {
  const entries = Object.entries(parameters ?? {});
  if (entries.length === 0) return 'Engine defaults';
  return entries.map(([key, value]) => {
    if (key === 'time_budget_ms' && typeof value === 'number') return `time budget ${value / 1000} s`;
    return `${key.replace(/_/g, ' ')} ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`;
  }).join(' · ');
}

// --- engines

export interface EngineChoice {
  key: string;
  ref: BimResourceRef;
  mode: string;
  /** `random-search 1.0.0` */
  title: string;
  /** The engine's own time budget for this mode, in seconds, when its options schema declares one. */
  defaultSeconds: number | null;
  federated: boolean;
  /** The mode as the catalog declares it; its scalarizations decide the optimization the study sends. */
  declared: EngineMode;
}

/** One choice per exact engine revision and mode: the study pins both. */
export function engineChoices(engines: readonly EngineCatalogEntry[]): EngineChoice[] {
  return engines.flatMap((engine) => engine.modes.map((mode) => {
    const budget = mode.optionsSchema?.properties?.time_budget_ms;
    const fallback = isRecord(budget) && typeof budget.default === 'number' ? budget.default / 1000 : null;
    return {
      key: `${bimResourceKey(engine.ref)}#${mode.id}`,
      ref: { namespace: engine.namespace, name: engine.name, version: engine.version, digest: engine.digest },
      mode: mode.id,
      title: `${engine.name} ${engine.version}`,
      defaultSeconds: fallback,
      federated: engine.namespace !== 'bim.builtin',
      declared: mode,
    };
  }));
}

/**
 * How many criteria the goal of the chosen case revisions has: the most any of them optimizes. `null` when none of the documents can be
 * read, which {@link studyOptimization} treats as a single criterion.
 */
export function studyCriteriaCount(revisions: readonly Pick<CaseRevision, 'document'>[]): number | null {
  const counts = revisions.map((revision) => criteriaCountOf(revision.document)).filter((count): count is number => count !== null);
  return counts.length > 0 ? Math.max(...counts) : null;
}

/**
 * The optimization one engine of the definition carries (`definition.engines[].optimization`, required by `StudyDefinition`). It is derived
 * as for a job, from the first scalarization the mode declares for the goal type; a mode that declares none that fits still gets the
 * conventional one (`feasibility` without criteria, `weighted-sum` otherwise), so the gateway answers about compatibility rather than a
 * missing field.
 */
export function studyOptimization(mode: EngineMode | undefined, criteria: number | null): ExecutionOptimization {
  const count = criteria ?? 1;
  return optimizationFor(mode, count) ?? { type: optimizationTypeOf(count), scalarization: count === 0 ? 'feasibility' : 'weighted-sum' };
}

/** The `definition.engines[]` entries for the chosen engine modes: the pinned revision, the mode and its optimization. */
export function definitionEngines(chosen: readonly EngineChoice[], criteria: number | null): Study['definition']['engines'] {
  return chosen.map((choice) => ({ ...choice.ref, mode: choice.mode, optimization: studyOptimization(choice.declared, criteria) }));
}

// --- case revisions

export interface RevisionInfo {
  id: string;
  caseSlug: string;
  caseName: string;
  revision: number;
  digest: string;
  snapshotId: string | null;
  createdAt: string;
}

export function revisionIndex(cases: readonly CaseContent[]): Map<string, RevisionInfo> {
  const index = new Map<string, RevisionInfo>();
  for (const entry of cases) {
    for (const revision of entry.revisions) {
      index.set(revision.id, {
        id: revision.id, caseSlug: entry.item.slug, caseName: entry.item.name, revision: revision.revision, digest: revision.digest,
        snapshotId: revision.source_snapshot_id, createdAt: revision.created_at,
      });
    }
  }
  return index;
}

/** The revisions of the project's cases that have one of the given ids; ids the project doesn't hold (a collection's) are skipped. */
export function revisionsOf(cases: readonly CaseContent[], ids: readonly string[]): CaseRevision[] {
  const wanted = new Set(ids);
  return cases.flatMap((entry) => entry.revisions.filter((revision) => wanted.has(revision.id)));
}

/** `Flujo de checkout · revision 2`; a revision this project doesn't hold reads by the start of its id. */
export function revisionLabel(index: ReadonlyMap<string, RevisionInfo>, id: string, short = false): string {
  const found = index.get(id);
  if (!found) return `Revision ${id.slice(0, 8)}…`;
  return short ? `${found.caseName} r${found.revision}` : `${found.caseName} · revision ${found.revision}`;
}

/** A revision can be in a study only when a BIM snapshot backs it: that is what the engines receive. */
export const isExecutable = (revision: Pick<CaseRevision, 'source_snapshot_id'>): boolean => Boolean(revision.source_snapshot_id);

/** Every executable revision of every case, case by case and newest first: the list the builder offers. */
export function offeredRevisions(cases: readonly CaseContent[]): Array<{ caseName: string; caseSlug: string; revision: CaseRevision }> {
  return cases.flatMap((entry) => [...entry.revisions]
    .sort((a, b) => b.revision - a.revision)
    .map((revision) => ({ caseName: entry.item.name, caseSlug: entry.item.slug, revision })));
}

/** The newest executable revision of each case. */
export function latestExecutable(cases: readonly CaseContent[]): string[] {
  return cases.flatMap((entry) => {
    const newest = [...entry.revisions].filter(isExecutable).sort((a, b) => b.revision - a.revision)[0];
    return newest ? [newest.id] : [];
  });
}

interface SelectionInput {
  cases: readonly CaseContent[];
  /** `?case=` : a case of this project, by its address. */
  caseSlug: string | null;
  /** `?revision=` : a revision number or id of that case. */
  revision: string | null;
  /** `?collection=` : the case revisions a project collection pins. */
  collectionIds: readonly string[];
}

/** What the builder starts with when another screen sent the person here ("Add to study", "Start a study from this"). */
export function defaultSelection({ cases, caseSlug, revision, collectionIds }: SelectionInput): string[] {
  const picked = new Set<string>();
  const executable = new Set(cases.flatMap((entry) => entry.revisions.filter(isExecutable).map((item) => item.id)));
  for (const id of collectionIds) if (executable.has(id)) picked.add(id);
  const entry = caseSlug ? cases.find((item) => item.item.slug === caseSlug) : undefined;
  if (entry) {
    const wanted = revision ? entry.revisions.find((item) => String(item.revision) === revision || item.id === revision) : undefined;
    const chosen = wanted ?? [...entry.revisions].filter(isExecutable).sort((a, b) => b.revision - a.revision)[0];
    if (chosen && isExecutable(chosen)) picked.add(chosen.id);
  }
  return [...picked];
}

/** The case revisions a sealed Collection version lists (`CollectionArtifactContent.members`); `null` when its content doesn't read as one. */
export function collectionMembers(content: string): string[] | null {
  try {
    const parsed: unknown = JSON.parse(content);
    if (!isRecord(parsed) || !Array.isArray(parsed.members)) return null;
    return parsed.members.flatMap((member) => (isRecord(member) && typeof member.caseRevisionId === 'string' ? [member.caseRevisionId] : []));
  } catch {
    return null;
  }
}

/** The cells a sealed Study version spells out (`StudyArtifactContent`); `null` when its content doesn't read as one. */
export function studyContentSize(content: string): MatrixSize | null {
  try {
    const parsed: unknown = JSON.parse(content);
    if (!isRecord(parsed) || !Array.isArray(parsed.cases) || !Array.isArray(parsed.engines)) return null;
    return matrixSize({
      cases: parsed.cases.length,
      engines: parsed.engines.length,
      settings: Array.isArray(parsed.parameter_sets) ? parsed.parameter_sets.length : 1,
      seeds: Array.isArray(parsed.seeds) ? parsed.seeds.length : 1,
    });
  } catch {
    return null;
  }
}

// --- runs and cells

export const isActiveState = (state: string): boolean => state === 'queued' || state === 'running';
export const isRetryable = (state: string): boolean => state === 'failed' || state === 'cancelled';

export const STATE_WORDS: Record<string, { label: string; tone: 'running' | 'queued' | 'ok' | 'warn' | 'bad' | 'off' }> = {
  queued: { label: 'Queued', tone: 'queued' },
  running: { label: 'Running', tone: 'running' },
  completed: { label: 'Completed', tone: 'ok' },
  partial: { label: 'Partial', tone: 'warn' },
  failed: { label: 'Failed', tone: 'bad' },
  cancelled: { label: 'Cancelled', tone: 'off' },
};

export function stateWord(state: string): { label: string; tone: 'running' | 'queued' | 'ok' | 'warn' | 'bad' | 'off' } {
  return STATE_WORDS[state] ?? { label: state, tone: 'off' };
}

export function latestOf(runs: readonly StudyRun[]): StudyRun | undefined {
  return runs.reduce<StudyRun | undefined>((best, run) => (!best || run.run_number > best.run_number ? run : best), undefined);
}

export interface CellMetrics {
  status?: string;
  feasible?: boolean;
  termination?: string;
  objectives: Record<string, number>;
  runtimeSeconds?: number;
  engine?: string;
  code?: string;
  detail?: string;
}

/** What the gateway recorded for a finished cell (`metrics_from_job`). Everything is optional: a cell that hasn't finished has `{}`. */
export function metricsOf(cell: Pick<StudyCell, 'metrics'>): CellMetrics {
  const raw = isRecord(cell.metrics) ? cell.metrics : {};
  const objectives: Record<string, number> = {};
  if (isRecord(raw.objectives)) {
    for (const [name, value] of Object.entries(raw.objectives)) {
      if (typeof value === 'number' && Number.isFinite(value)) objectives[name] = value;
    }
  }
  return {
    status: typeof raw.status === 'string' ? raw.status : undefined,
    feasible: typeof raw.feasible === 'boolean' ? raw.feasible : undefined,
    termination: typeof raw.termination === 'string' ? raw.termination : undefined,
    objectives,
    runtimeSeconds: typeof raw.runtimeSeconds === 'number' && Number.isFinite(raw.runtimeSeconds) ? raw.runtimeSeconds : undefined,
    engine: typeof raw.engine === 'string' ? raw.engine : undefined,
    code: typeof raw.code === 'string' ? raw.code : undefined,
    detail: typeof raw.detail === 'string' ? raw.detail : undefined,
  };
}

const FAILURES: Record<string, string> = {
  engine_unreachable: 'The engine deployment didn’t answer in time.',
  invalid_engine: 'The engine or mode this cell pins was refused.',
  executable_snapshot_required: 'The case revision has no compiled snapshot for the engines to run.',
  snapshot_not_found: 'The snapshot behind the case revision no longer exists.',
  invalid_case_revision: 'The case revision could not be read as a problem.',
  job_rejected: 'The job pipeline refused to start this cell.',
  job_not_persisted: 'The job for this cell could not be stored.',
  snapshot_persistence_failed: 'The snapshot could not be prepared for this account.',
};

/** What a failed cell says about itself: the code the gateway recorded, in words, and its own detail. */
export function explainFailure(metrics: Pick<CellMetrics, 'code' | 'detail'>): { title: string; detail: string | null } {
  const title = metrics.code ? FAILURES[metrics.code] ?? 'The engine could not produce a result for this cell.' : 'The engine could not produce a result for this cell.';
  return { title, detail: metrics.detail ?? null };
}

export const engineName = (ref: Record<string, string>): string => ref.name ?? 'engine';
export const engineTitle = (ref: Record<string, string>): string => (ref.version ? `${engineName(ref)} ${ref.version}` : engineName(ref));
export const engineKeyOf = (ref: Record<string, string>): string => [ref.namespace, ref.name, ref.version, ref.digest, ref.mode ?? ''].join('|');

/** The engines of a set of cells, in order of appearance, each with a label that tells two modes of one engine apart. */
export function enginesOf(cells: readonly StudyCell[]): Array<{ key: string; label: string; mode: string | undefined }> {
  const seen = new Map<string, { key: string; ref: Record<string, string> }>();
  for (const cell of cells) {
    const key = engineKeyOf(cell.engine_ref);
    if (!seen.has(key)) seen.set(key, { key, ref: cell.engine_ref });
  }
  const names = [...seen.values()].map((entry) => engineName(entry.ref));
  return [...seen.values()].map(({ key, ref }) => ({
    key,
    mode: ref.mode,
    label: names.filter((name) => name === engineName(ref)).length > 1 && ref.mode ? `${engineName(ref)} (${ref.mode})` : engineName(ref),
  }));
}

export const RUNTIME = 'runtime';

/** The measures cells can be coloured and compared by: each objective the engines reported, then the run time. */
export function measuresOf(cells: readonly StudyCell[]): string[] {
  const names: string[] = [];
  let timed = false;
  for (const cell of cells) {
    const metrics = metricsOf(cell);
    for (const name of Object.keys(metrics.objectives)) if (!names.includes(name)) names.push(name);
    if (metrics.runtimeSeconds !== undefined) timed = true;
  }
  return timed ? [...names, RUNTIME] : names;
}

export function measureLabel(measure: string): string {
  return measure === RUNTIME ? 'Time taken' : measure.replace(/[_-]+/g, ' ').replace(/^./, (letter) => letter.toUpperCase());
}

export function measureValue(cell: StudyCell, measure: string): number | null {
  if (cell.state !== 'completed') return null;
  const metrics = metricsOf(cell);
  const value = measure === RUNTIME ? metrics.runtimeSeconds : metrics.objectives[measure];
  return value === undefined ? null : value;
}

/** Up to four significant digits, no trailing zeros: `0.121`, `430`, `1,234`. */
export function formatMeasure(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  if (Math.abs(value) >= 1000) return Math.round(value).toLocaleString('en-US');
  return String(Number(value.toPrecision(4)));
}

export function formatSeconds(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  if (value >= 3600) return `${Number((value / 3600).toFixed(1))} h`;
  if (value >= 60) {
    const rest = Math.round(value % 60);
    return rest === 0 ? `${Math.floor(value / 60)} min` : `${Math.floor(value / 60)} min ${rest} s`;
  }
  return `${Number(value.toFixed(value < 10 ? 2 : 1))} s`;
}

/** Lower is better. 0 is the best quarter of the range, 3 the worst; a range with one value is all best. */
export function heatLevel(value: number, min: number, max: number): 0 | 1 | 2 | 3 {
  if (max <= min) return 0;
  const share = (value - min) / (max - min);
  return share < 0.25 ? 0 : share < 0.5 ? 1 : share < 0.75 ? 2 : 3;
}

export interface Column {
  key: string;
  engineKey: string;
  engine: string;
  seed: number;
  settingIndex: number;
  label: string;
}

export interface MatrixView {
  /** Case revision ids, in order of appearance. */
  rows: string[];
  columns: Column[];
  /** `${row}\u0000${column}` → the cell. */
  at: Map<string, StudyCell>;
  settings: number;
}

export const slot = (row: string, column: string): string => `${row}\u0000${column}`;

/** The cells laid out as the matrix they came from: one row per case revision, one column per engine × setting × seed. */
export function matrixView(cells: readonly StudyCell[]): MatrixView {
  const engines = enginesOf(cells);
  const labelOf = new Map(engines.map((engine) => [engine.key, engine.label]));
  const settingKeys: string[] = [];
  const rows: string[] = [];
  const columns: Column[] = [];
  const known = new Set<string>();
  const at = new Map<string, StudyCell>();
  const ordered = [...cells].sort((a, b) => a.ordinal - b.ordinal);
  for (const cell of ordered) {
    const setting = parametersKey(cell.parameters);
    if (!settingKeys.includes(setting)) settingKeys.push(setting);
  }
  for (const cell of ordered) {
    const engineKey = engineKeyOf(cell.engine_ref);
    const settingIndex = settingKeys.indexOf(parametersKey(cell.parameters));
    const key = `${engineKey}|${settingIndex}|${cell.seed}`;
    if (!rows.includes(cell.binding_case_revision_id)) rows.push(cell.binding_case_revision_id);
    if (!known.has(key)) {
      known.add(key);
      const engine = labelOf.get(engineKey) ?? engineName(cell.engine_ref);
      columns.push({
        key, engineKey, engine, seed: cell.seed, settingIndex,
        label: `${engine}${settingKeys.length > 1 ? ` · set ${settingIndex + 1}` : ''} · seed ${cell.seed}`,
      });
    }
    at.set(slot(cell.binding_case_revision_id, key), cell);
  }
  return { rows, columns, at, settings: settingKeys.length };
}

export interface DefinitionGrid {
  rows: string[];
  columns: Array<{ key: string; label: string }>;
  /** The cell numbers can be told from the definition alone: with several settings the gateway orders them by fingerprint. */
  numbered: boolean;
}

/** The matrix a definition spells out, in the order the gateway expands it: case revisions by id, engines by identity, settings, seeds ascending. */
export function definitionGrid(definition: Study['definition']): DefinitionGrid {
  const rows = [...(definition.case_revision_ids ?? [])].sort();
  const engines = [...(definition.engines ?? [])].sort((a, b) => (
    [a.namespace, a.name, a.version, a.digest, a.mode ?? ''].join('\u0000').localeCompare([b.namespace, b.name, b.version, b.digest, b.mode ?? ''].join('\u0000'))
  ));
  const settings = definition.parameter_sets?.length ?? 0;
  const seeds = [...(definition.seeds ?? [])].sort((a, b) => a - b);
  const columns: DefinitionGrid['columns'] = [];
  engines.forEach((engine, enginePosition) => {
    for (let setting = 0; setting < settings; setting += 1) {
      for (const seed of seeds) {
        columns.push({
          key: `${enginePosition}|${setting}|${seed}`,
          label: `${engine.name ?? 'engine'}${engine.mode ? ` (${engine.mode})` : ''}${settings > 1 ? ` · set ${setting + 1}` : ''} · seed ${seed}`,
        });
      }
    }
  });
  return { rows, columns, numbered: settings <= 1 };
}

/** The cells that got the same input as this one (same case revision, same setting, same seed), one per engine: the fair comparison. */
export function rivalsOf(cell: StudyCell, cells: readonly StudyCell[]): StudyCell[] {
  const setting = parametersKey(cell.parameters);
  return cells.filter((other) => (
    other.binding_case_revision_id === cell.binding_case_revision_id && other.seed === cell.seed && parametersKey(other.parameters) === setting
  ));
}

/** The cells of the same engine on the same case and setting, one per seed: how steady the engine is. */
export function seedsOf(cell: StudyCell, cells: readonly StudyCell[]): StudyCell[] {
  const setting = parametersKey(cell.parameters);
  const engine = engineKeyOf(cell.engine_ref);
  return cells
    .filter((other) => other.binding_case_revision_id === cell.binding_case_revision_id && engineKeyOf(other.engine_ref) === engine && parametersKey(other.parameters) === setting)
    .sort((a, b) => a.seed - b.seed);
}

export function countStates(cells: readonly StudyCell[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const cell of cells) counts[cell.state] = (counts[cell.state] ?? 0) + 1;
  return counts;
}

/** `6 completed, 1 failed, 1 cancelled of 8 cells`, for the bar that draws the same. */
export function breakdownText(cells: readonly StudyCell[]): string {
  if (cells.length === 0) return 'No cells';
  const counts = countStates(cells);
  const parts = (['completed', 'failed', 'cancelled', 'running', 'queued'] as const)
    .filter((state) => counts[state])
    .map((state) => `${counts[state]} ${state}`);
  return `${parts.join(', ') || 'No cells'} of ${plural(cells.length, 'cell')}`;
}

export const CELLS_PER_PAGE = 50;
/** Beyond this many cells the colour grid would be a wall of squares: the table carries the run. */
export const MAX_GRID_CELLS = 600;
