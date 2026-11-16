import { describe, expect, it } from 'vitest';
import { COMPARISON_WORDS, comparisonText, isComparisonWord } from './comparison';

describe('the comparison words of a neighbourhood', () => {
  it('words every comparison the gateway sends, a trade-off included', () => {
    expect(Object.keys(COMPARISON_WORDS).sort()).toEqual([
      'better',
      'equal',
      'infeasible',
      'repairs-feasibility',
      'trade-off',
      'worse',
    ]);
    expect(comparisonText('trade-off')).toEqual({ label: 'Trade-off', tone: 'plain' });
    expect(comparisonText('better')).toEqual({ label: 'Better', tone: 'success' });
    expect(comparisonText('infeasible')).toEqual({ label: 'Not feasible', tone: 'warning' });
  });

  it('shows a word it does not know as the gateway wrote it, and never invents a verdict', () => {
    expect(isComparisonWord('incomparable')).toBe(false);
    expect(comparisonText('incomparable')).toEqual({ label: 'incomparable', tone: 'plain' });
    expect(comparisonText(undefined)).toEqual({ label: 'Checked', tone: 'plain' });
    expect(isComparisonWord('toString')).toBe(false);
  });
});
