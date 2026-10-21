/**
 * Feature values of BIM candidates: a finite number, or a range `{ min, max }` with exactly those two keys. An end is a finite number
 * or `null`, and `null` means infinity (`min: null` is −∞, `max: null` is +∞). `{ min: null, max: null }` is allowed (no information).
 * `min <= max` is only required when both ends are finite. `null` as a scalar is invalid.
 *
 * Everything the screens do with such a value lives here: reading it, writing it as typed, validating it, naming it in words,
 * ordering it and moving a cell between "single value" and "range" without losing what was entered.
 */

export interface FeatureRange {
  /** `null` is −∞. */
  min: number | null;
  /** `null` is +∞. */
  max: number | null;
}

export type FeatureValue = number | FeatureRange;

/** What a slot holds while it is being edited: a range may be missing an end until both are typed. `validateFeature` says so. */
export interface PartialRange {
  min?: number | null;
  max?: number | null;
}

export type FeatureSlot = number | PartialRange;

const isPlainObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** Is it a well-formed range: an object with exactly `min` and `max`, each a finite number or `null`? Order is not checked. */
export function isRange(value: unknown): value is FeatureRange {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes('min') || !keys.includes('max')) return false;
  return (value.min === null || isFiniteNumber(value.min)) && (value.max === null || isFiniteNumber(value.max));
}

/** Is it a shape a cell can edit: a number or an object that only uses the keys `min` and `max` (maybe not both yet)? */
export function isFeatureSlot(value: unknown): value is FeatureSlot {
  if (typeof value === 'number') return true;
  if (!isPlainObject(value)) return false;
  return Object.entries(value).every(([key, end]) => (key === 'min' || key === 'max') && (end === null || typeof end === 'number'));
}

/** A valid value: a finite number or a well-formed range whose finite ends are in order. */
export function isFeatureValue(value: unknown): value is FeatureValue {
  return validateFeature(value) === null;
}

/**
 * The reason a slot can't be saved, in English, or `null` when it is fine. The gateway refuses the same things
 * (`schema`, `finite_number`, `feature_interval_order`), so this stops them before they get there.
 */
export function validateFeature(value: unknown): string | null {
  if (value === null || value === undefined) return 'A single value can’t be empty. Enter a number, or use a range with no limits.';
  if (typeof value === 'number') return Number.isFinite(value) ? null : 'The value must be a finite number.';
  if (!isPlainObject(value)) return 'A feature is a number or a range with a min and a max.';
  const extra = Object.keys(value).filter((key) => key !== 'min' && key !== 'max');
  if (extra.length) return `A range has only a min and a max, not “${extra[0]}”.`;
  if (!('min' in value) || value.min === undefined) return 'A range needs a min: enter a number or tick “No lower limit”.';
  if (!('max' in value) || value.max === undefined) return 'A range needs a max: enter a number or tick “No upper limit”.';
  if (value.min !== null && !isFiniteNumber(value.min)) return 'Min must be a finite number or have no limit.';
  if (value.max !== null && !isFiniteNumber(value.max)) return 'Max must be a finite number or have no limit.';
  if (isFiniteNumber(value.min) && isFiniteNumber(value.max) && value.min > value.max) return 'Min can’t be greater than max.';
  return null;
}

// --- typing

/** A number as people type it (`0.5`, `-3`, `1e-4`); `undefined` for anything else, so a half-typed value never becomes `NaN`. */
export function parseFiniteNumber(text: string): number | undefined {
  const trimmed = text.trim();
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(trimmed)) return undefined;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : undefined;
}

/** What is in the two fields of a range cell. An end that is open ignores its text. */
export interface RangeInput {
  min: string;
  max: string;
  minOpen: boolean;
  maxOpen: boolean;
}

export interface RangeParse {
  /** What goes into the document. An end that can't be read yet is left out, so the slot stays invalid until it is fixed. */
  value: PartialRange;
  errors: { min?: string; max?: string; range?: string };
}

/** The range the two fields and the two "no limit" switches describe, with the reason each part can't be used yet. */
export function parseRangeInput(input: RangeInput): RangeParse {
  const errors: RangeParse['errors'] = {};
  const value: PartialRange = {};
  const end = (side: 'min' | 'max', text: string, open: boolean) => {
    if (open) { value[side] = null; return; }
    if (text.trim() === '') { errors[side] = `Enter a number or tick “No ${side === 'min' ? 'lower' : 'upper'} limit”.`; return; }
    const parsed = parseFiniteNumber(text);
    if (parsed === undefined) { errors[side] = `${side === 'min' ? 'Min' : 'Max'} must be a finite number.`; return; }
    value[side] = parsed;
  };
  end('min', input.min, input.minOpen);
  end('max', input.max, input.maxOpen);
  const order = validateFeature(value);
  if (!errors.min && !errors.max && order) errors.range = order;
  return { value, errors };
}

/** The fields of a cell as they should read for a slot already in the document. */
export function rangeInputOf(value: FeatureSlot | undefined): RangeInput {
  if (value === undefined) return { min: '', max: '', minOpen: false, maxOpen: false };
  const range: PartialRange = typeof value === 'number' ? { min: value, max: value } : value;
  const text = (end: number | null | undefined) => (typeof end === 'number' ? String(end) : '');
  return { min: text(range.min), max: text(range.max), minOpen: range.min === null, maxOpen: range.max === null };
}

// --- in words

const NUMBER_FORMAT: Intl.NumberFormatOptions = { maximumFractionDigits: 6 };
const fmt = (value: number) => value.toLocaleString('en-US', NUMBER_FORMAT);

export interface FormatOptions {
  unit?: string | null;
  /** No space after the sign (`≤200`), for narrow cells and chips. */
  compact?: boolean;
  /** Interval notation with the infinity symbol: `(−∞, 200]`, `[100, +∞)`, `[120, 180]`. */
  long?: boolean;
}

/**
 * A slot in words. A number: `120`. A range: `120–180`. Open below: `≤ 200`. Open above: `≥ 100`. Open both ways: `unbounded`.
 * `long` writes ranges as intervals instead (`(−∞, 200]`), which is what a screen reader or a tooltip gets. A slot that is
 * not usable yet (an end is missing) reads `incomplete`.
 */
export function formatFeature(value: FeatureSlot | null | undefined, options: FormatOptions = {}): string {
  if (value === null || value === undefined) return '—';
  const tail = options.unit ? ` ${options.unit}` : '';
  if (typeof value === 'number') return Number.isFinite(value) ? `${fmt(value)}${tail}` : '—';
  const { min, max } = value;
  if (min === undefined || max === undefined) return 'incomplete';
  const gap = options.compact ? '' : ' ';
  if (options.long) {
    const low = min === null ? '(−∞' : `[${fmt(min)}`;
    const high = max === null ? '+∞)' : `${fmt(max)}]`;
    return `${low}, ${high}${tail}`;
  }
  if (min === null && max === null) return 'unbounded';
  if (min === null) return `≤${gap}${fmt(max as number)}${tail}`;
  if (max === null) return `≥${gap}${fmt(min)}${tail}`;
  return `${fmt(min)}–${fmt(max)}${tail}`;
}

/** The `<feature> for <candidate>: value or range` name of the switch of a cell. */
export const modeLabel = (feature: string, candidate: string) => `${feature} for ${candidate}: value or range`;

// --- order

/** Where on the line a slot sits: a number is itself, a closed range its middle, an open range `±Infinity`. Never `NaN`. */
export function featureMidpoint(value: FeatureSlot): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const { min, max } = value;
  if (typeof min === 'number' && typeof max === 'number') return (min + max) / 2;
  return null;
}

/**
 * The key a column is sorted by: the middle of the value, with every range that has an open end after the numbers
 * (`Infinity`), so the order is total and never `NaN`. `compareFeatures` breaks the ties among those.
 */
export function featureSortKey(value: FeatureSlot | null | undefined): number {
  if (value === null || value === undefined) return Number.POSITIVE_INFINITY;
  const middle = featureMidpoint(value);
  return middle === null ? Number.POSITIVE_INFINITY : middle;
}

/** The finite end that tells open ranges apart: `≤ 200` and `≥ 100` order by 200 and 100; `unbounded` last. */
function openRank(value: FeatureSlot): number {
  if (typeof value === 'number') return 0;
  const { min, max } = value;
  if (typeof min === 'number' && typeof max === 'number') return 0;
  if (typeof min === 'number' || typeof max === 'number') return 1;
  return 2;
}

const anchorOf = (value: FeatureSlot): number => {
  if (typeof value === 'number') return value;
  return typeof value.min === 'number' ? value.min : typeof value.max === 'number' ? value.max : 0;
};

/** Ascending order of two slots: numbers and closed ranges by middle, then ranges open at one end, then `unbounded`. */
export function compareFeatures(a: FeatureSlot, b: FeatureSlot): number {
  const rank = openRank(a) - openRank(b);
  if (rank !== 0) return rank;
  const key = featureSortKey(a) - featureSortKey(b);
  if (Number.isFinite(key) && key !== 0) return key;
  const anchor = anchorOf(a) - anchorOf(b);
  if (anchor !== 0) return anchor;
  // Same middle: the narrower one first, a number before a range of the same middle.
  const width = (value: FeatureSlot) => (typeof value === 'number' ? 0 : typeof value.min === 'number' && typeof value.max === 'number' ? value.max - value.min : 0);
  return width(a) - width(b);
}

/** `compareFeatures` for a column in which a candidate may have no value: those go last. */
export function compareOptionalFeatures(a: FeatureSlot | undefined, b: FeatureSlot | undefined): number {
  if (a === undefined || b === undefined) return a === b ? 0 : a === undefined ? 1 : -1;
  return compareFeatures(a, b);
}

// --- between "single value" and "range"

/** A single value as a range: `120` becomes `{ min: 120, max: 120 }`. A range stays as it is. */
export function toRange(value: FeatureSlot): PartialRange {
  return typeof value === 'number' ? { min: value, max: value } : { ...value };
}

export interface ScalarConversion {
  /** What the cell holds as a single value; `null` leaves it empty. */
  value: number | null;
  /** True when going to a single value drops something (the range was wider than a point, or open). The cell asks first. */
  lossy: boolean;
  /** What is dropped, for the question: `the upper limit (180)`. */
  dropped: string | null;
}

/**
 * A range as a single value. Only a point (`min === max`, both finite) converts without losing anything. Otherwise the cell
 * asks, and the answer keeps the finite `min` (else the finite `max`); a range with no finite end leaves the cell empty.
 */
export function toScalar(value: FeatureSlot): ScalarConversion {
  if (typeof value === 'number') return { value, lossy: false, dropped: null };
  const { min, max } = value;
  if (typeof min === 'number' && min === max) return { value: min, lossy: false, dropped: null };
  const kept = typeof min === 'number' ? min : typeof max === 'number' ? max : null;
  if (kept === null) return { value: null, lossy: min !== undefined || max !== undefined, dropped: 'both limits' };
  const other = kept === min ? max : min;
  const dropped = typeof other === 'number' ? `the ${kept === min ? 'upper' : 'lower'} limit (${fmt(other)})` : `the ${kept === min ? 'upper' : 'lower'} limit (no limit)`;
  return { value: kept, lossy: other !== undefined && other !== kept, dropped };
}

/** The code the gateway refuses a job with when a package carries ranges to an engine mode that doesn't declare `interval` values. */
export const RANGE_CODE = 'unsupported_capability_value';

/** Why such a mode is off in a list of engines. */
export const RANGE_REFUSAL = 'This package has range features; this engine only accepts single values';

/** Does this value, or any value inside it, have a range in it? For a map of slots (`features` of one candidate). */
export function hasRange(values: Record<string, unknown> | undefined | null): boolean {
  return !!values && Object.values(values).some((value) => isPlainObject(value));
}
