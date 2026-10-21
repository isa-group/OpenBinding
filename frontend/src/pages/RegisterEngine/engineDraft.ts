import type {
  BimProfile, EngineManifest, EngineMode, ScalarizationDeclaration, Termination,
} from '../../api/client';
import { isRecord } from '../Engines/registrationModel';

// -- The vocabulary a mode is written in -------------------------------------------------------

export type Selector = 'none' | 'all' | 'only';

export interface Choice {
  selector: Selector;
  values: string[];
}

export interface Dimension {
  id: string;
  /** What a mode may name in this dimension; empty with `open` when the profile lets modes name their own. */
  values: string[];
  open: boolean;
}

export interface Vocabulary {
  /** `qos-binding/v1`: the profile a mode is written for. */
  profile: string;
  ir: { apiVersion: string; kind: string };
  dimensions: Dimension[];
  limits: string[];
  /** Where the vocabulary was read: the gateway’s installed profile, or the copy this screen carries. */
  source: 'gateway' | 'built-in';
}

const AGGREGATIONS = Object.entries({
  sequence: ['sum', 'product', 'min', 'max', 'expression'],
  parallel: ['sum', 'product', 'min', 'max', 'expression'],
  exclusive: ['weightedSum', 'weightedProduct', 'min', 'max', 'expression'],
  repeat: ['scale', 'power', 'identity', 'expression'],
  selection: ['sum', 'product', 'min', 'max', 'expression'],
}).flatMap(([context, operators]) => operators.map((operator) => `${context}.${operator}`));

/** The qos-binding/v1 vocabulary as the gateway installs it: used when the profile list can’t be read. */
export const BUILTIN_VOCABULARY: Vocabulary = {
  profile: 'qos-binding/v1',
  ir: { apiVersion: 'bim/v1', kind: 'BindingProblem' },
  source: 'built-in',
  limits: ['maxTasks', 'maxCandidates', 'minObjectives', 'maxObjectives', 'maxIterations', 'maxPopulation', 'maxSolutions', 'maxTimeBudgetMs'],
  dimensions: [
    { id: 'workflowNodes', open: false, values: ['task', 'empty', 'sequence', 'parallel', 'exclusive.conditional', 'exclusive.probabilistic', 'repeat.count', 'repeat.expectedCount'] },
    { id: 'aggregations', open: false, values: AGGREGATIONS },
    { id: 'featureScopes', open: false, values: ['invocation', 'selectedCandidate'] },
    { id: 'featureValues', open: false, values: ['scalar', 'interval'] },
    { id: 'constraints', open: false, values: ['hard.aggregate-bound', 'hard.expression', 'soft.aggregate-bound', 'soft.expression'] },
    { id: 'scalarizations', open: true, values: [] },
    {
      id: 'expressions',
      open: false,
      values: [
        'literal', 'not', 'negate', 'and', 'or', 'compare', 'arithmetic', 'path.binding', 'path.tasks', 'path.features', 'path.extensions',
        'path.candidate', 'path.capability', 'path.values', 'path.weights', 'path.count', 'call.has', 'call.min', 'call.max', 'call.sum',
        'call.product', 'call.weightedSum', 'call.weightedProduct',
      ],
    },
    { id: 'placement', open: false, values: ['placement'] },
    { id: 'irExtensions', open: true, values: [] },
  ],
};

/** One vocabulary per installed profile that has an engine protocol. */
export function vocabulariesFrom(profiles: BimProfile[]): Vocabulary[] {
  const found = profiles
    .filter((profile) => profile.spec?.capabilityVocabulary?.dimensions && profile.output)
    .map((profile): Vocabulary => ({
      profile: profile.id,
      ir: { apiVersion: profile.output.apiVersion, kind: profile.output.kind },
      source: 'gateway',
      limits: profile.spec.limitVocabulary ?? [],
      dimensions: Object.entries(profile.spec.capabilityVocabulary.dimensions).map(([id, dimension]) => ({
        id,
        open: dimension.openValues === true,
        values: dimension.values ?? [],
      })),
    }));
  return found.length ? found : [BUILTIN_VOCABULARY];
}

// -- The draft ----------------------------------------------------------------------------------

export const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const SEMVER_PATTERN = /^([1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
export const ALL_TERMINATIONS: Termination[] = ['OPTIMAL', 'FEASIBLE', 'INFEASIBLE', 'UNKNOWN'];

/** The ways an engine can scalarize objectives. A mode names the ones it offers; the gateway matches a job against them. */
export const SCALARIZATIONS: ReadonlyArray<ScalarizationDeclaration & { label: string }> = [
  { id: 'weighted-sum', label: 'Weighted sum', objectiveTypes: ['SINGLE'], weightPolicy: 'required' },
  { id: 'feasibility', label: 'Feasibility only', objectiveTypes: ['SINGLE'], weightPolicy: 'forbidden' },
  { id: 'lexicographic', label: 'Lexicographic', objectiveTypes: ['MULTI', 'MANY'], weightPolicy: 'forbidden' },
  { id: 'pareto-front', label: 'Pareto front', objectiveTypes: ['MULTI', 'MANY'], weightPolicy: 'forbidden' },
];

export type OptionType = 'integer' | 'number' | 'string' | 'boolean' | 'fixed';

export interface OptionDraft {
  key: string;
  name: string;
  type: OptionType;
  minimum: string;
  maximum: string;
  default: string;
  required: boolean;
  /** Whatever else the option’s schema says (`description`, `const`, `enum`, exclusive bounds): kept as written. */
  rest: Record<string, unknown>;
}

export interface ModeDraft {
  key: string;
  id: string;
  profile: string;
  algorithm: string;
  capabilities: Record<string, Choice>;
  scalarizations: ScalarizationDeclaration[];
  options: OptionDraft[];
  limits: Record<string, string>;
  termination: Termination[];
  exact: boolean;
  deterministic: boolean;
  completePareto: boolean;
}

export interface Extras {
  internal?: boolean;
  labels?: Record<string, string>;
  annotations?: Record<string, unknown>;
  extensions?: Record<string, unknown>;
}

export interface EngineDraft {
  name: string;
  version: string;
  description: string;
  modes: ModeDraft[];
  extras: Extras;
}

let counter = 0;
export function nextKey(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}`;
}

function defaultChoice(dimension: Dimension): Choice {
  if (dimension.id === 'featureValues') return { selector: 'only', values: ['scalar'] };
  return dimension.open ? { selector: 'none', values: [] } : { selector: 'all', values: [] };
}

export function vocabularyFor(vocabularies: Vocabulary[], profile: string): Vocabulary {
  return vocabularies.find((item) => item.profile === profile) ?? vocabularies[0] ?? BUILTIN_VOCABULARY;
}

export function newOption(name = '', patch: Partial<OptionDraft> = {}): OptionDraft {
  return { key: nextKey('option'), name, type: 'integer', minimum: '', maximum: '', default: '', required: false, rest: {}, ...patch };
}

export function newMode(vocabulary: Vocabulary, id = 'default'): ModeDraft {
  const limit = vocabulary.limits.includes('maxTimeBudgetMs') ? 'maxTimeBudgetMs' : vocabulary.limits[0];
  return {
    key: nextKey('mode'),
    id,
    profile: vocabulary.profile,
    algorithm: 'deterministic-search',
    capabilities: Object.fromEntries(vocabulary.dimensions.filter((dimension) => dimension.id !== 'scalarizations').map((dimension) => [dimension.id, defaultChoice(dimension)])),
    scalarizations: [{ id: 'weighted-sum', objectiveTypes: ['SINGLE'], weightPolicy: 'required' }],
    options: [newOption('time_budget_ms', { minimum: '1', maximum: '3600000', default: '60000' })],
    limits: limit ? { [limit]: limit === 'maxTimeBudgetMs' ? '3600000' : '1000' } : {},
    termination: ['FEASIBLE', 'UNKNOWN'],
    exact: false,
    deterministic: false,
    completePareto: false,
  };
}

export function newDraft(vocabulary: Vocabulary): EngineDraft {
  return { name: 'my-engine', version: '1.0.0', description: '', modes: [newMode(vocabulary)], extras: {} };
}

// -- Validation ----------------------------------------------------------------------------------

export interface Issue {
  /** Where it applies: `name`, `version`, `modes.0.id`, `modes.0.options.1.maximum`, … */
  path: string;
  message: string;
}

function numeric(text: string): number | null {
  if (text.trim() === '') return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

export function validateDraft(draft: EngineDraft, vocabularies: Vocabulary[]): Issue[] {
  const issues: Issue[] = [];
  if (!NAME_PATTERN.test(draft.name)) issues.push({ path: 'name', message: 'Start with a letter or digit; then letters, digits, . _ - only.' });
  if (!SEMVER_PATTERN.test(draft.version)) issues.push({ path: 'version', message: 'Use three numbers like 1.0.0, starting at 1.' });
  if (draft.modes.length === 0) issues.push({ path: 'modes', message: 'An engine needs at least one mode.' });
  const seen = new Set<string>();
  draft.modes.forEach((mode, index) => {
    const at = `modes.${index}`;
    const vocabulary = vocabularyFor(vocabularies, mode.profile);
    if (mode.id.trim() === '') issues.push({ path: `${at}.id`, message: 'Give the mode a name.' });
    else if (seen.has(mode.id)) issues.push({ path: `${at}.id`, message: 'Two modes can’t share a name.' });
    seen.add(mode.id);
    if (mode.algorithm.trim() === '') issues.push({ path: `${at}.algorithm`, message: 'Say which algorithm it runs.' });
    for (const dimension of vocabulary.dimensions) {
      if (dimension.id === 'scalarizations') continue;
      const choice = mode.capabilities[dimension.id];
      if (!choice) continue;
      if (choice.selector === 'all' && dimension.open) issues.push({ path: `${at}.capabilities.${dimension.id}`, message: 'This dimension is open: choose nothing, or name the values.' });
      if (choice.selector === 'only' && choice.values.length === 0) issues.push({ path: `${at}.capabilities.${dimension.id}`, message: 'Pick at least one value, or choose nothing.' });
    }
    if (mode.scalarizations.length === 0) issues.push({ path: `${at}.scalarizations`, message: 'Offer at least one way of scalarizing objectives.' });
    if (mode.termination.length === 0) issues.push({ path: `${at}.termination`, message: 'Pick at least one way a run can end.' });
    const names = new Set<string>();
    mode.options.forEach((option, optionIndex) => {
      const optionAt = `${at}.options.${optionIndex}`;
      if (option.name.trim() === '') issues.push({ path: `${optionAt}.name`, message: 'Name the option.' });
      else if (names.has(option.name)) issues.push({ path: `${optionAt}.name`, message: 'Two options can’t share a name.' });
      names.add(option.name);
      if (option.type === 'fixed') return;
      const numberType = option.type === 'integer' || option.type === 'number';
      const bounds = (['minimum', 'maximum', 'default'] as const).filter(() => numberType);
      for (const field of bounds) {
        const text = option[field].trim();
        if (text === '') continue;
        const value = numeric(text);
        if (value === null) issues.push({ path: `${optionAt}.${field}`, message: 'Use a number.' });
        else if (option.type === 'integer' && !Number.isInteger(value)) issues.push({ path: `${optionAt}.${field}`, message: 'Use a whole number.' });
      }
      const low = numberType ? numeric(option.minimum) : null;
      const high = numberType ? numeric(option.maximum) : null;
      const fallback = numberType ? numeric(option.default) : null;
      if (low !== null && high !== null && low > high) issues.push({ path: `${optionAt}.maximum`, message: 'The maximum is below the minimum.' });
      if (fallback !== null && ((low !== null && fallback < low) || (high !== null && fallback > high))) {
        issues.push({ path: `${optionAt}.default`, message: 'The default is outside the range.' });
      }
      if (option.type === 'boolean' && option.default !== '' && option.default !== 'true' && option.default !== 'false') {
        issues.push({ path: `${optionAt}.default`, message: 'Use true or false.' });
      }
    });
    const limits = Object.entries(mode.limits).filter(([, text]) => text.trim() !== '');
    if (limits.length === 0) issues.push({ path: `${at}.limits`, message: 'Declare at least one ceiling.' });
    for (const [name, text] of limits) {
      const value = numeric(text);
      if (value === null || !Number.isInteger(value) || value < 1) issues.push({ path: `${at}.limits.${name}`, message: 'Use a whole number of 1 or more.' });
    }
  });
  return issues;
}

export function issueAt(issues: Issue[], path: string): string | undefined {
  return issues.find((issue) => issue.path === path)?.message;
}

// -- From draft to manifest ------------------------------------------------------------------------

function choiceDocument(choice: Choice): Record<string, unknown> {
  return choice.selector === 'only' ? { selector: 'only', values: choice.values } : { selector: choice.selector };
}

function optionSchema(option: OptionDraft): Record<string, unknown> {
  if (option.type === 'fixed') return option.rest;
  const schema: Record<string, unknown> = { ...option.rest, type: option.type };
  if (option.type === 'integer' || option.type === 'number') {
    const low = numeric(option.minimum);
    const high = numeric(option.maximum);
    if (low !== null) schema.minimum = low;
    if (high !== null) schema.maximum = high;
    const fallback = numeric(option.default);
    if (fallback !== null) schema.default = fallback;
  } else if (option.default !== '') {
    schema.default = option.type === 'boolean' ? option.default === 'true' : option.default;
  }
  return schema;
}

export function buildMode(mode: ModeDraft, vocabularies: Vocabulary[]): EngineMode {
  const vocabulary = vocabularyFor(vocabularies, mode.profile);
  const order = vocabulary.dimensions.map((dimension) => dimension.id);
  const rank = (id: string) => { const at = order.indexOf(id); return at < 0 ? order.length : at; };
  const ids = [...new Set([...order, ...Object.keys(mode.capabilities)])]
    .filter((id) => id === 'scalarizations' || id in mode.capabilities)
    .sort((a, b) => rank(a) - rank(b));
  const capabilities: Record<string, unknown> = {};
  for (const id of ids) {
    capabilities[id] = id === 'scalarizations'
      ? { selector: 'only', values: mode.scalarizations }
      : choiceDocument(mode.capabilities[id]);
  }
  const properties: Record<string, unknown> = {};
  for (const option of mode.options) properties[option.name] = optionSchema(option);
  const required = mode.options.filter((option) => option.required).map((option) => option.name);
  const limits: Record<string, number> = {};
  for (const [name, text] of Object.entries(mode.limits)) {
    const value = numeric(text);
    if (value !== null) limits[name] = value;
  }
  return {
    id: mode.id,
    profile: mode.profile,
    ir: vocabulary.ir,
    algorithm: mode.algorithm,
    capabilities,
    optionsSchema: { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false },
    limits,
    guarantees: {
      termination: mode.termination,
      exact: mode.exact,
      ...(mode.deterministic ? { deterministicWithoutTimeBudget: true } : {}),
      ...(mode.completePareto ? { completeParetoFront: true } : {}),
    },
  } as unknown as EngineMode;
}

/** The Engine document the gateway will be asked to store. The namespace is the account’s, whatever else was written. */
export function buildManifest(draft: EngineDraft, namespace: string, vocabularies: Vocabulary[]): EngineManifest {
  const { extras } = draft;
  return {
    apiVersion: 'bim/v1',
    kind: 'Engine',
    metadata: {
      namespace,
      name: draft.name,
      version: draft.version,
      ...(draft.description.trim() ? { description: draft.description.trim() } : {}),
      ...(extras.internal ? { internal: true } : {}),
      ...(extras.labels ? { labels: extras.labels } : {}),
      ...(extras.annotations ? { annotations: extras.annotations } : {}),
    },
    spec: {
      modes: draft.modes.map((mode) => buildMode(mode, vocabularies)),
      ...(extras.extensions ? { extensions: extras.extensions } : {}),
    },
  } as unknown as EngineManifest;
}

// -- From a manifest to a draft -----------------------------------------------------------------------

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function scalarText(value: unknown): string {
  return typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean' ? String(value) : '';
}

function optionDraft(name: string, raw: unknown, required: string[]): OptionDraft {
  const schema = isRecord(raw) ? raw : {};
  const { type, minimum, maximum, default: fallback, ...rest } = schema;
  if (type !== 'integer' && type !== 'number' && type !== 'string' && type !== 'boolean') {
    return newOption(name, { type: 'fixed', rest: schema, required: required.includes(name) });
  }
  return newOption(name, {
    type,
    minimum: scalarText(minimum),
    maximum: scalarText(maximum),
    default: scalarText(fallback),
    required: required.includes(name),
    rest,
  });
}

function modeDraft(raw: unknown, vocabularies: Vocabulary[]): ModeDraft {
  const mode = isRecord(raw) ? raw : {};
  const vocabulary = vocabularyFor(vocabularies, typeof mode.profile === 'string' ? mode.profile : '');
  const base = newMode(vocabulary, typeof mode.id === 'string' ? mode.id : 'default');
  const declared = isRecord(mode.capabilities) ? mode.capabilities : {};
  const capabilities: Record<string, Choice> = { ...base.capabilities };
  for (const [id, value] of Object.entries(declared)) {
    if (id === 'scalarizations' || !isRecord(value)) continue;
    const selector: Selector = value.selector === 'all' || value.selector === 'only' ? value.selector : 'none';
    capabilities[id] = { selector, values: selector === 'only' ? strings(value.values) : [] };
  }
  const scalarizations = isRecord(declared.scalarizations) && Array.isArray(declared.scalarizations.values)
    ? declared.scalarizations.values.filter(isRecord).map((item) => ({
      id: String(item.id ?? ''),
      objectiveTypes: strings(item.objectiveTypes) as ScalarizationDeclaration['objectiveTypes'],
      weightPolicy: (item.weightPolicy === 'optional' || item.weightPolicy === 'forbidden' ? item.weightPolicy : 'required') as ScalarizationDeclaration['weightPolicy'],
    }))
    : [];
  const optionsSchema = isRecord(mode.optionsSchema) ? mode.optionsSchema : {};
  const properties = isRecord(optionsSchema.properties) ? optionsSchema.properties : {};
  const required = strings(optionsSchema.required);
  const limits = isRecord(mode.limits) ? mode.limits : {};
  const guarantees = isRecord(mode.guarantees) ? mode.guarantees : {};
  return {
    ...base,
    profile: vocabulary.profile,
    algorithm: typeof mode.algorithm === 'string' ? mode.algorithm : '',
    capabilities,
    scalarizations,
    options: Object.entries(properties).map(([name, schema]) => optionDraft(name, schema, required)),
    limits: Object.fromEntries(Object.entries(limits).map(([name, value]) => [name, scalarText(value)])),
    termination: strings(guarantees.termination).filter((item): item is Termination => (ALL_TERMINATIONS as string[]).includes(item)),
    exact: guarantees.exact === true,
    deterministic: guarantees.deterministicWithoutTimeBudget === true,
    completePareto: guarantees.completeParetoFront === true,
  };
}

/** A manifest as the form’s draft, or `null` when it is not an Engine document at all. */
export function draftFromManifest(document: unknown, vocabularies: Vocabulary[]): EngineDraft | null {
  if (!isRecord(document) || !isRecord(document.spec) || !Array.isArray(document.spec.modes)) return null;
  const metadata = isRecord(document.metadata) ? document.metadata : {};
  const extras: Extras = {};
  if (metadata.internal === true) extras.internal = true;
  if (isRecord(metadata.labels) && Object.keys(metadata.labels).length) extras.labels = metadata.labels as Record<string, string>;
  if (isRecord(metadata.annotations) && Object.keys(metadata.annotations).length) extras.annotations = metadata.annotations;
  if (isRecord(document.spec.extensions) && Object.keys(document.spec.extensions).length) extras.extensions = document.spec.extensions;
  return {
    name: typeof metadata.name === 'string' ? metadata.name : '',
    version: typeof metadata.version === 'string' ? metadata.version : '',
    description: typeof metadata.description === 'string' ? metadata.description : '',
    modes: document.spec.modes.map((mode: unknown) => modeDraft(mode, vocabularies)),
    extras,
  };
}

/** `1.0.3` → `1.0.4`: the next revision of a manifest being registered again. Anything else is left alone. */
export function bumpPatch(version: string): string {
  const match = /^(\d+)\.(\d+)\.(\d+)(.*)$/.exec(version);
  return match ? `${match[1]}.${match[2]}.${Number(match[3]) + 1}${match[4]}` : version;
}
