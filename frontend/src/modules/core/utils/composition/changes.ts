import type { CompositionVersionDiff } from '../../api/types';
import { summarizeChanges, type ChangeSummary } from '../sphere/change-summary';
import { formatNumber } from './values';

/**
 * How a diff of two versions reads. The diff is the gateway's (`GET …/diff`, SPHERE's shape plus `comparison`); this only
 * words it. A field that is absent on one side comes as `null` there, where SPHERE's own diff leaves it `undefined`, so
 * `formatDiffValue` reads `null` as absent instead of printing it.
 */

export interface VersionChanges extends ChangeSummary {
  /** Why the two sides' values are not compared, in words; null when they are. */
  notComparable: string | null;
}

function notComparableReason(diff: CompositionVersionDiff): string | null {
  const { comparison, from, to } = diff;
  if (comparison.comparable) return null;
  const reasons: string[] = [];
  const { before, after } = comparison.valueStatus;
  if (before !== after)
    reasons.push(`the values of ${from.label} are ${before} and those of ${to.label} are ${after}`);
  if (comparison.problemRefChanged) reasons.push('the two versions link different problems');
  else if (comparison.compilationChanged)
    reasons.push('the two versions were judged on different compilations');
  return reasons.length
    ? `Values are not compared: ${reasons.join(', and ')}.`
    : 'Values are not compared.';
}

/**
 * Why the two sides' values are not compared, in a few words for a summary line: the problem changed, the compilation changed, or
 * one side's values are verified and the other's declared. Null when they compare. Built only from the gateway's flags.
 */
export function notComparableShort(
  comparison: CompositionVersionDiff['comparison']
): string | null {
  if (comparison.comparable) return null;
  const reasons: string[] = [];
  if (comparison.problemRefChanged) reasons.push('problem changed');
  else if (comparison.compilationChanged) reasons.push('compilation changed');
  const { before, after } = comparison.valueStatus;
  if (before !== after) reasons.push(`${before} vs ${after}`);
  return reasons.length ? reasons.join(', ') : 'the gateway did not compare them';
}

/** What changed from one version to the other: sections, candidate and value changes, and whether values compare. */
export function versionChanges(diff: CompositionVersionDiff): VersionChanges {
  return { ...summarizeChanges(diff), notComparable: notComparableReason(diff) };
}

/** Which side of a change a value is on. */
export type DiffSide = 'before' | 'after';

/**
 * A value of a field change as text. `null` (or nothing) is the field's absence: "not set" before it was added, "removed"
 * after it was removed, whether the whole entry was added or removed or only that field of a changed entry.
 */
export function formatDiffValue(value: unknown, side: DiffSide): string {
  if (value === null || value === undefined) return side === 'before' ? 'not set' : 'removed';
  if (typeof value === 'number') return formatNumber(value);
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return JSON.stringify(value);
}

export interface FieldPath {
  /** The fields that lead to it, outermost first. */
  parents: string[];
  /** The field itself, which a screen emphasises. */
  leaf: string;
  /** The whole path as a reader sees it: `from › version`. */
  text: string;
}

/** A dotted field path of a change (`from.version`) in reading form. */
export function fieldPath(path: string): FieldPath {
  const parts = path.split('.').filter(Boolean);
  const leaf = parts.pop() ?? '';
  return { parents: parts, leaf, text: [...parts, leaf].join(' › ') };
}
