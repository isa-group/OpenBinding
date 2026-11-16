import type { CompositionVersionSummary, CompositionVersionView } from '../../shared/api/types';

/**
 * The global values of a version and how far to trust them. Every number is the gateway's: the values of the current
 * evaluation (the toolchain's for a linked version, the author's for a declared one). Nothing here computes, converts or
 * compares a value; it only says which status a version's values have and writes a number with its unit as written.
 */

/**
 * - `verified`: a linked version whose current evaluation verified the binding and computed the values;
 * - `declared`: the author's values, with no problem to judge them;
 * - `unverified`: a linked version whose current evaluation did not verify it (`binding_invalid`, `semantics_changed`), or
 *   that has no current evaluation.
 */
export type ValueStatus = 'verified' | 'declared' | 'unverified';

/** What a version view, a light row included, says about its values. */
type Valued = Pick<CompositionVersionView, 'values_status' | 'current_evaluation' | 'values'>;

/**
 * What names a version's value status: a version view, with its current evaluation, or the latest version of a composition as a
 * list row summarizes it (an organization's list and the public one), with the gateway's `verified` for the same evaluation.
 */
type StatusOf =
  | Pick<Valued, 'values_status' | 'current_evaluation'>
  | Pick<CompositionVersionSummary, 'values_status' | 'verified'>;

/** The status of a version's values, from the gateway's `values_status` and whether the current evaluation verified it. */
export function valueStatus(version: StatusOf): ValueStatus {
  if (version.values_status === 'declared') return 'declared';
  const verified = 'current_evaluation' in version ? version.current_evaluation?.outcome === 'verified' : version.verified;
  return verified ? 'verified' : 'unverified';
}

export interface ValueModel {
  name: string;
  value: number;
  /** As written; `"1"` for a dimensionless value. */
  unit: string;
  status: ValueStatus;
}

/** The values of a version in the order the gateway serves them (the document's), each with its unit as written. */
export function valueModels(version: Valued): ValueModel[] {
  const status = valueStatus(version);
  return Object.entries(version.values).map(([name, { value, unit }]) => ({ name, value, unit, status }));
}

const NUMBER = new Intl.NumberFormat('en-US', { maximumFractionDigits: 6 });
const TINY = new Intl.NumberFormat('en-US', { notation: 'scientific', maximumSignificantDigits: 4 });

/** A number as people read it: grouped, at most six decimals, and in scientific notation when that would hide it. */
export function formatNumber(value: number): string {
  const text = NUMBER.format(value);
  return value !== 0 && /^-?0$/.test(text) ? TINY.format(value) : text;
}

/** A value and its unit as written; a dimensionless value (unit `"1"`) is the number alone. */
export function formatValue(value: number, unit: string): string {
  const number = formatNumber(value);
  return unit === '1' || unit === '' ? number : `${number} ${unit}`;
}
