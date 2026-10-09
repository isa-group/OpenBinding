import { QuotaError } from '../../api/auth';
import {
  HttpError, type CalibrateEngineParams, type ConvertLegacyParams, type CorpusGeneratedResponse, type GenerateInstanceParams, type GeneratorFeature,
  type InstanceGeneratedResponse,
} from '../../api/client';
import type { WorkspaceFiles } from '../../utils/workspaceDraft';
import { fieldErrorsFrom } from '../Auth/authErrors';

/** The settings of the generator lab as the person types them, and what the gateway is asked for. */

export type Spread = 'uniform' | 'normal' | 'skewed';
export type LabTool = 'instance' | 'corpus' | 'convert' | 'calibrate';

export interface LabSettings {
  tasks: string;
  candidates: string;
  seed: string;
  spread: Spread;
  latencyMin: string;
  latencyMax: string;
  count: string;
  name: string;
  controlFlow: string;
  loops: string;
  branches: string;
  parallel: string;
  maxNesting: string;
  constraints: string;
  tension: string;
  guarantee: boolean;
  optimization: 'weighted' | 'pareto';
  engines: string[];
}

export type FieldKey = keyof LabSettings;
export type FieldErrors = Partial<Record<FieldKey, string>>;

/** What the lab last generated, with what it needs to keep exactly that. */
export type Output =
  | { kind: 'instance'; response: InstanceGeneratedResponse; params: GenerateInstanceParams }
  | { kind: 'corpus'; response: CorpusGeneratedResponse; params: GenerateInstanceParams; count: number; name: string }
  | { kind: 'convert'; response: InstanceGeneratedResponse; request: ConvertLegacyParams };

/** A project the person can add to, with the address of its workbench. */
export interface ProjectChoice {
  id: string;
  org: string;
  project: string;
  label: string;
}

export const DEFAULT_SETTINGS: LabSettings = {
  tasks: '6',
  candidates: '5',
  seed: '42',
  spread: 'uniform',
  latencyMin: '50',
  latencyMax: '300',
  count: '20',
  name: 'generated_qaco',
  controlFlow: '50',
  loops: '30',
  branches: '30',
  parallel: '20',
  maxNesting: '3',
  constraints: '1',
  tension: '0.7',
  guarantee: true,
  optimization: 'weighted',
  engines: ['evolutionary-heuristics', 'minizinc-csp'],
};

export const SPREADS: ReadonlyArray<{ id: Spread; label: string }> = [
  { id: 'uniform', label: 'Even spread' },
  { id: 'normal', label: 'Bell curve' },
  { id: 'skewed', label: 'Mostly fast' },
];

export const ENGINE_CHOICES = ['random-search', 'evolutionary-heuristics', 'minizinc-csp'] as const;

/** The ranges the contract allows (`GenerateInstanceRequest`, `GenerateCorpusRequest`). */
export const RANGES = {
  tasks: [2, 1000],
  candidates: [2, 100],
  count: [1, 100],
  controlFlow: [0, 90],
  loops: [0, 100],
  branches: [0, 100],
  parallel: [0, 100],
  maxNesting: [1, 10],
  constraints: [0, 100],
} as const;

const whole = (text: string): number | null => (/^-?\d+$/.test(text.trim()) ? Number(text.trim()) : null);
const decimal = (text: string): number | null => (text.trim() !== '' && Number.isFinite(Number(text)) ? Number(text) : null);

/** What is wrong with the settings before they are sent. The tool decides which fields count. */
export function checkSettings(settings: LabSettings, tool: LabTool): FieldErrors {
  const errors: FieldErrors = {};
  const inRange = (key: keyof typeof RANGES, label: string) => {
    const value = whole(settings[key]);
    const [low, high] = RANGES[key];
    if (value === null || value < low || value > high) errors[key] = `${label}: a whole number from ${low} to ${high}.`;
  };
  inRange('tasks', 'Tasks');
  inRange('candidates', 'Candidates per task');
  if (tool === 'corpus') inRange('count', 'How many instances');
  if (settings.seed.trim() !== '' && whole(settings.seed) === null) errors.seed = 'The seed is a whole number.';
  const low = decimal(settings.latencyMin);
  const high = decimal(settings.latencyMax);
  if (low === null || low < 0) errors.latencyMin = 'The lowest latency is a number of milliseconds, 0 or more.';
  if (high === null || (low !== null && high <= low)) errors.latencyMax = 'The highest latency must be above the lowest.';
  inRange('controlFlow', 'Control flow');
  inRange('maxNesting', 'Nesting depth');
  inRange('constraints', 'Rules');
  for (const key of ['loops', 'branches', 'parallel'] as const) inRange(key, 'This share');
  const tension = decimal(settings.tension);
  if (tension === null || tension < 0 || tension > 1) errors.tension = 'Tightness is a number from 0 to 1.';
  return errors;
}

/** The spread of the latency of the generated providers, as the contract's distributions. */
function latencyDistribution(settings: LabSettings): GeneratorFeature['distribution'] {
  const minimum = decimal(settings.latencyMin) ?? 0;
  const maximum = decimal(settings.latencyMax) ?? minimum + 1;
  const range = maximum - minimum;
  if (settings.spread === 'uniform') return { kind: 'uniform', minimum, maximum };
  return { kind: 'normal', minimum, maximum, mean: settings.spread === 'normal' ? minimum + range / 2 : minimum + range / 4, stddev: Math.max(range / 6, 1e-6) };
}

/** What the gateway is asked to generate for one instance. A seed is always sent, so keeping an instance keeps exactly the one that was previewed. */
export function instanceParams(settings: LabSettings, seed: number): GenerateInstanceParams {
  const controlFlow = whole(settings.controlFlow) ?? 0;
  const constraints = whole(settings.constraints) ?? 0;
  return {
    name: settings.name.trim() || 'generated_instance',
    tasks: whole(settings.tasks) ?? undefined,
    candidates: whole(settings.candidates) ?? undefined,
    control_flow: controlFlow,
    ...(controlFlow > 0 ? {
      loops: decimal(settings.loops) ?? 0,
      branches: decimal(settings.branches) ?? 0,
      parallel: decimal(settings.parallel) ?? 0,
      max_nesting: whole(settings.maxNesting) ?? 3,
      iterations_per_loop: 5,
    } : {}),
    features: [
      {
        id: 'cost', unit: 'EUR', direction: 'minimize', scope: 'selectedCandidate',
        distribution: { kind: 'uniform', minimum: 0, maximum: 100 }, aggregation: { selection: 'sum' },
      },
      {
        id: 'latency', unit: 'ms', direction: 'minimize', scope: 'invocation', distribution: latencyDistribution(settings),
        aggregation: { sequence: 'sum', parallel: 'max', exclusive: 'weightedSum', repeat: 'scale' },
      },
      ...(['reliability', 'availability', 'security'] as const).map((id): GeneratorFeature => ({
        id, unit: '1', direction: 'maximize', scope: 'selectedCandidate',
        distribution: { kind: 'uniform', minimum: 0, maximum: 1 }, aggregation: { selection: 'min' },
      })),
    ],
    constraints,
    ...(constraints > 0 && settings.guarantee ? { tension: decimal(settings.tension) ?? 0.7 } : {}),
    guarantee_feasibility: settings.guarantee,
    optimization_mode: settings.optimization,
    target_engines: settings.engines,
    seed,
  };
}

/** The seed to use: the one typed, or a fresh one when the field is empty. Either way it is sent, so a result can be kept exactly as it was previewed. */
export function seedOf(settings: Pick<LabSettings, 'seed'>): number {
  return settings.seed.trim() ? Number(settings.seed) : Math.floor(Math.random() * 1_000_000_000);
}

/** Twelve bars that show the spread chosen for the latency, the tallest at 100. */
export function latencyHistogram(spread: Spread, minimum: number, maximum: number): number[] {
  const bins = 12;
  const range = Math.max(maximum - minimum, 1e-6);
  const mean = spread === 'skewed' ? minimum + range / 4 : minimum + range / 2;
  const deviation = range / 6;
  const heights = Array.from({ length: bins }, (_, index) => {
    if (spread === 'uniform') return 1;
    const at = minimum + ((index + 0.5) / bins) * range;
    return Math.exp(-(((at - mean) / deviation) ** 2) / 2);
  });
  const tallest = Math.max(...heights);
  return heights.map((height) => Math.max(4, Math.round((height / tallest) * 100)));
}

/** log10 of the number of combinations when each of `tasks` tasks has `candidates` to choose from. */
export function combinationsLog10(tasks: number, candidates: number): number {
  return tasks > 0 && candidates > 0 ? tasks * Math.log10(candidates) : 0;
}

export function powerText(log10: number): string {
  return `≈ 10^${log10.toFixed(1)}`;
}

export interface Fact {
  label: string;
  value: string;
}

/** What a generated result says about itself, in the order the preview lists it. */
export function outputFacts(output: Output): Fact[] {
  if (output.kind === 'convert') {
    return [
      { label: 'Name', value: output.response.name },
      { label: 'Files', value: String(Object.keys(output.response.files).length) },
      { label: 'Engines it suits', value: output.response.target_engines.length ? output.response.target_engines.join(', ') : 'any' },
    ];
  }
  const tasks = output.params.tasks ?? 0;
  const candidates = output.params.candidates ?? 0;
  const size = powerText(combinationsLog10(tasks, candidates));
  if (output.kind === 'corpus') {
    return [
      { label: 'Instances', value: String(output.response.count) },
      { label: 'Tasks each', value: String(tasks) },
      { label: 'Candidates each', value: String(tasks * candidates) },
      { label: 'Combinations each', value: size },
    ];
  }
  return [
    { label: 'Tasks', value: String(tasks) },
    { label: 'Candidates', value: String(tasks * candidates) },
    { label: 'Combinations', value: size },
    { label: 'Seed', value: String(output.params.seed ?? '—') },
    ...(typeof output.response.actual_constraint_count === 'number' ? [{ label: 'Rules', value: String(output.response.actual_constraint_count) }] : []),
  ];
}

/** The files of a generated package as the workspace holds them: text, with the objects written as JSON. */
export function workspaceFilesOf(files: Record<string, unknown>): WorkspaceFiles {
  const result: WorkspaceFiles = {};
  for (const [name, content] of Object.entries(files)) {
    result[name] = typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`;
  }
  return result;
}

/** The field a name in the contract belongs to. */
const FIELD_OF: Record<string, FieldKey> = {
  tasks: 'tasks', candidates: 'candidates', seed: 'seed', name: 'name', control_flow: 'controlFlow', loops: 'loops', branches: 'branches',
  parallel: 'parallel', max_nesting: 'maxNesting', constraints: 'constraints', tension: 'tension', count: 'count',
};

export type Refusal =
  | { kind: 'config'; text: string; fields: FieldErrors }
  | { kind: 'missing' | 'forbidden' | 'session' | 'quota' | 'busy' | 'unavailable' | 'other'; text: string };

const marker = (status: number | undefined, code: string | undefined) => {
  const parts = [status, code].filter((part) => part !== undefined && part !== '');
  return parts.length ? ` (${parts.join(' · ')})` : '';
};

/** What the person was doing when a request was refused: it decides what a 401, a 403, a 404 or a 422 means. */
export type LabAction = 'settings' | 'text' | 'runs' | 'keep';

const REJECTED: Record<Exclude<LabAction, 'keep'>, { subject: string; code: string; verdict: string }> = {
  settings: { subject: 'These settings can’t be generated', code: 'invalid generation config', verdict: 'the server rejected the combination' },
  text: { subject: 'That text can’t be converted', code: 'invalid legacy instance', verdict: 'the server could not read it as an old-format instance' },
  runs: { subject: 'Those runs can’t be used to calibrate', code: 'invalid observations', verdict: 'the server rejected them' },
};

/** Words for each way the generator can refuse a request. `doing` completes “… so {doing}”. */
export function labRefusal(caught: unknown, doing: string, action: LabAction = 'settings'): Refusal {
  if (caught instanceof QuotaError) {
    return { kind: 'quota', text: `Your plan has no room for this${marker(402, caught.code)}, so ${doing}.` };
  }
  if (caught instanceof HttpError) {
    const where = marker(caught.status, caught.code);
    switch (caught.status) {
      case 401: return { kind: 'session', text: action === 'keep' ? `Saving to a project needs an account${where}.` : `Your session has ended${where}. Log in again to continue.` };
      case 403: return { kind: 'forbidden', text: action === 'keep' ? `You can generate, but you don’t have permission to add to that project${where}.` : `Your account can’t do this${where}, so ${doing}.` };
      case 404: return { kind: 'missing', text: action === 'keep' ? `That project no longer exists or you lost access${where}.` : `That wasn’t found${where}, so ${doing}.` };
      case 422: {
        const fields: FieldErrors = {};
        for (const [name, message] of Object.entries(fieldErrorsFrom(caught))) {
          const key = FIELD_OF[name];
          if (key && message) fields[key] = message;
        }
        const words = REJECTED[action === 'keep' ? 'settings' : action];
        return { kind: 'config', fields, text: `${words.subject}${caught.code ? where : ` (422 · ${words.code})`}: ${words.verdict}.` };
      }
      case 429: return { kind: 'busy', text: `Too many requests${where}. Wait a moment and try again.` };
      default:
        return caught.status >= 500
          ? { kind: 'unavailable', text: `A service OpenBinding depends on isn’t answering${where}, so ${doing}. Try again in a moment.` }
          : { kind: 'other', text: `That couldn’t be done${where}, so ${doing}.` };
    }
  }
  if (caught instanceof TypeError) return { kind: 'unavailable', text: `OpenBinding couldn’t be reached, so ${doing}. Check your connection and try again.` };
  return { kind: 'other', text: caught instanceof Error ? caught.message : `That couldn’t be done, so ${doing}.` };
}

type Observations = NonNullable<CalibrateEngineParams['observations']>;

/** Observations for the calibration, read from a JSON array. */
export function readObservations(text: string): { observations: Observations } | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: 'The observations must be valid JSON: a list of runs.' };
  }
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'object' && item !== null && !Array.isArray(item))) {
    return { error: 'The observations must be a list of runs, each with its workload features, latency, quality and success.' };
  }
  return { observations: parsed as Observations };
}
