import type { CompositionMove } from '../../shared/api/types';

/**
 * The words the toolchain uses when it compares a one-task move with the binding it starts from (`comparison` of a run's or a
 * composition's neighbourhood), and how screens say them. The word is the gateway's: nothing here compares, ranks or decides
 * it. The table is keyed by the generated enum, so a word the gateway adds is a type error until it is worded here.
 */

export type ComparisonWord = CompositionMove['comparison'];

export interface ComparisonText {
  label: string;
  /** `success` and `warning` carry the verdict the word already says; the label always says it in text. */
  tone: 'success' | 'warning' | 'plain';
}

export const COMPARISON_WORDS: Readonly<Record<ComparisonWord, ComparisonText>> = {
  better: { label: 'Better', tone: 'success' },
  'repairs-feasibility': { label: 'Repairs a broken rule', tone: 'success' },
  worse: { label: 'Worse', tone: 'warning' },
  equal: { label: 'Same quality', tone: 'plain' },
  'trade-off': { label: 'Trade-off', tone: 'plain' },
  infeasible: { label: 'Not feasible', tone: 'warning' },
};

/** Whether a value is one of the gateway's comparison words. */
export const isComparisonWord = (value: unknown): value is ComparisonWord =>
  typeof value === 'string' && Object.hasOwn(COMPARISON_WORDS, value);

/** How a comparison word reads; a word this frontend does not know is shown as the gateway wrote it. */
export function comparisonText(value: unknown): ComparisonText {
  if (isComparisonWord(value)) return COMPARISON_WORDS[value];
  return { label: typeof value === 'string' && value ? value : 'Checked', tone: 'plain' };
}
