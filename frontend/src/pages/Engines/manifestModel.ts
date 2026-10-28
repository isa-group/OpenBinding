import { isRecord } from './registrationModel';

export type SelectorKind = 'none' | 'all' | 'only';

export interface CapabilityRow {
  id: string;
  label: string;
  selector: SelectorKind | 'unknown';
  values: string[];
}

export interface ScalarizationRow {
  id: string;
  objectives: string;
  weights: string;
}

export interface OptionRow {
  name: string;
  type: string;
  /** `1 – 3,600,000`, `≥ 2`, `≤ 1`, or `—`. */
  range: string;
  default: string;
  required: boolean;
  /** An option fixed to one value (`const`) or limited to a list (`enum`). */
  fixed: string | null;
}

export interface FeatureValuesView {
  declared: boolean;
  scalar: boolean;
  interval: boolean;
}

export interface ModeView {
  id: string;
  profile: string;
  ir: string;
  algorithm: string;
  capabilities: CapabilityRow[];
  featureValues: FeatureValuesView;
  scalarizations: ScalarizationRow[];
  options: OptionRow[];
  limits: Array<[string, number]>;
  termination: string[];
  exact: boolean;
  flags: string[];
}

export interface ManifestView {
  namespace: string;
  name: string;
  version: string;
  description: string | null;
  modes: ModeView[];
  /** What the document carries that this view does not lay out: labels, annotations, extensions. */
  extras: string[];
}

export const DIMENSION_LABELS: Record<string, string> = {
  workflowNodes: 'Workflow nodes',
  featureScopes: 'Feature scopes',
  featureValues: 'Feature values',
  aggregations: 'Aggregations',
  constraints: 'Constraints',
  scalarizations: 'Objective scalarizations',
  expressions: 'Expressions',
  placement: 'Placement',
  irExtensions: 'IR extensions',
  metricScopes: 'Metric scopes',
  optimization: 'Optimization',
  objectiveTypes: 'Objective types',
};

const VALUE_LABELS: Record<string, Record<string, string>> = {
  featureValues: { scalar: 'Scalar (single numbers)', interval: 'Interval (ranges, min–max)' },
  featureScopes: { invocation: 'Invocation', selectedCandidate: 'Selected candidate' },
};

const OBJECTIVE_LABELS: Record<string, string> = { SINGLE: 'one objective', MULTI: 'several objectives', MANY: 'many objectives' };
const WEIGHT_LABELS: Record<string, string> = { required: 'weights required', optional: 'weights optional', forbidden: 'no weights' };

function humanize(id: string): string {
  const words = id.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[-_]+/g, ' ').trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function dimensionLabel(id: string): string {
  return DIMENSION_LABELS[id] ?? humanize(id);
}

export function valueLabel(dimension: string, value: string): string {
  return VALUE_LABELS[dimension]?.[value] ?? value;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function format(value: number): string {
  return value.toLocaleString('en-US');
}

function rangeOf(schema: Record<string, unknown>): string {
  const low = typeof schema.minimum === 'number' ? schema.minimum : typeof schema.exclusiveMinimum === 'number' ? schema.exclusiveMinimum : null;
  const high = typeof schema.maximum === 'number' ? schema.maximum : typeof schema.exclusiveMaximum === 'number' ? schema.exclusiveMaximum : null;
  if (low !== null && high !== null) return `${format(low)} – ${format(high)}`;
  if (low !== null) return `≥ ${format(low)}`;
  if (high !== null) return `≤ ${format(high)}`;
  return '—';
}

function scalar(value: unknown): string {
  return typeof value === 'number' ? format(value) : typeof value === 'string' || typeof value === 'boolean' ? String(value) : '—';
}

export interface FixedOptionView {
  /** `always X` for a `const`, `one of a, b` for an `enum`; null for any other schema. */
  summary: string | null;
  /** Every other schema keyword with a short reading of its value: never JSON text. */
  pairs: Array<{ keyword: string; value: string }>;
}

function keywordValue(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return value.map(keywordValue).join(', ');
  if (isRecord(value)) {
    const count = Object.keys(value).length;
    return `${count} field${count === 1 ? '' : 's'}`;
  }
  return scalar(value);
}

/** What a fixed option schema says, in words: the `const`/`enum` reading of the options table, plus the other keywords as pairs. */
// [impl->req~frontend-registration-fixed-option-rendered~1]
export function describeFixedOption(schema: unknown): FixedOptionView {
  const body = isRecord(schema) ? schema : {};
  const summary = 'const' in body
    ? `always ${keywordValue(body.const)}`
    : Array.isArray(body.enum) ? `one of ${body.enum.map(keywordValue).join(', ')}` : null;
  const pairs = Object.entries(body)
    .filter(([keyword]) => keyword !== 'const' && keyword !== 'enum')
    .map(([keyword, value]) => ({ keyword, value: keywordValue(value) }));
  return { summary, pairs };
}

function readOptions(schema: unknown): OptionRow[] {
  const body = isRecord(schema) ? schema : {};
  const properties = isRecord(body.properties) ? body.properties : {};
  const required = strings(body.required);
  return Object.entries(properties).map(([name, raw]) => {
    const option = isRecord(raw) ? raw : {};
    const fixed = describeFixedOption(option).summary;
    return {
      name,
      type: typeof option.type === 'string' ? option.type : fixed ? 'fixed' : '—',
      range: rangeOf(option),
      default: 'default' in option ? scalar(option.default) : '—',
      required: required.includes(name),
      fixed,
    };
  });
}

function readCapability(id: string, raw: unknown): CapabilityRow {
  const body = isRecord(raw) ? raw : {};
  const selector = body.selector === 'none' || body.selector === 'all' || body.selector === 'only' ? body.selector : 'unknown';
  const values = selector === 'only' && Array.isArray(body.values)
    ? body.values.map((item) => (typeof item === 'string' ? item : isRecord(item) && typeof item.id === 'string' ? item.id : JSON.stringify(item)))
    : [];
  return { id, label: dimensionLabel(id), selector, values };
}

function readScalarizations(raw: unknown): ScalarizationRow[] {
  const values = isRecord(raw) && Array.isArray(raw.values) ? raw.values : [];
  return values.filter(isRecord).map((item) => ({
    id: typeof item.id === 'string' ? item.id : '—',
    objectives: strings(item.objectiveTypes).map((type) => OBJECTIVE_LABELS[type] ?? type).join(' · ') || '—',
    weights: typeof item.weightPolicy === 'string' ? WEIGHT_LABELS[item.weightPolicy] ?? item.weightPolicy : '—',
  }));
}

function featureValuesOf(raw: unknown): FeatureValuesView {
  if (!isRecord(raw)) return { declared: false, scalar: false, interval: false };
  if (raw.selector === 'all') return { declared: true, scalar: true, interval: true };
  if (raw.selector === 'only') {
    const values = strings(raw.values);
    return { declared: true, scalar: values.includes('scalar'), interval: values.includes('interval') };
  }
  return { declared: true, scalar: false, interval: false };
}

function readMode(raw: unknown, index: number): ModeView {
  const mode = isRecord(raw) ? raw : {};
  const capabilities = isRecord(mode.capabilities) ? mode.capabilities : {};
  const guarantees = isRecord(mode.guarantees) ? mode.guarantees : {};
  const limits = isRecord(mode.limits) ? mode.limits : {};
  const ir = isRecord(mode.ir) ? mode.ir : {};
  const flags = Object.entries(guarantees)
    .filter(([key, value]) => key !== 'termination' && key !== 'exact' && value === true)
    .map(([key]) => humanize(key));
  return {
    id: typeof mode.id === 'string' ? mode.id : `mode-${index + 1}`,
    profile: typeof mode.profile === 'string' ? mode.profile : '—',
    ir: [ir.apiVersion, ir.kind].filter((part): part is string => typeof part === 'string').join(' · ') || '—',
    algorithm: typeof mode.algorithm === 'string' ? mode.algorithm : '—',
    capabilities: Object.entries(capabilities).filter(([id]) => id !== 'scalarizations').map(([id, value]) => readCapability(id, value)),
    featureValues: featureValuesOf(capabilities.featureValues),
    scalarizations: readScalarizations(capabilities.scalarizations),
    options: readOptions(mode.optionsSchema),
    limits: Object.entries(limits).filter((entry): entry is [string, number] => typeof entry[1] === 'number'),
    termination: strings(guarantees.termination),
    exact: guarantees.exact === true,
    flags,
  };
}

/** An Engine document laid out for reading; `null` when it is not an object with a `spec`. */
export function readManifest(document: unknown): ManifestView | null {
  if (!isRecord(document) || !isRecord(document.spec)) return null;
  const metadata = isRecord(document.metadata) ? document.metadata : {};
  const modes = Array.isArray(document.spec.modes) ? document.spec.modes : [];
  const extras: string[] = [];
  if (isRecord(metadata.labels) && Object.keys(metadata.labels).length) extras.push('labels');
  if (isRecord(metadata.annotations) && Object.keys(metadata.annotations).length) extras.push('annotations');
  if (isRecord(document.spec.extensions) && Object.keys(document.spec.extensions).length) extras.push('extensions');
  return {
    namespace: typeof metadata.namespace === 'string' ? metadata.namespace : '',
    name: typeof metadata.name === 'string' ? metadata.name : '',
    version: typeof metadata.version === 'string' ? metadata.version : '',
    description: typeof metadata.description === 'string' && metadata.description ? metadata.description : null,
    modes: modes.map(readMode),
    extras,
  };
}
