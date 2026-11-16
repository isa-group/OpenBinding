import { describe, expect, it } from 'vitest';
import type { CompositionVersionView } from '../../modules/core/api/types';
import fms from '../../test/fixtures/core/fms.version.json';
import { formatNumber, formatValue, valueModels, valueStatus } from './values';

const verified = fms as CompositionVersionView;

const withOutcome = (
  outcome: 'verified' | 'binding_invalid' | 'semantics_changed' | 'declared',
  status: 'verified' | 'declared' = 'verified'
) => ({
  ...verified,
  values_status: status,
  current_evaluation: verified.current_evaluation && { ...verified.current_evaluation, outcome },
});

describe('valueStatus', () => {
  it('is verified when the current evaluation verified a linked version', () => {
    expect(valueStatus(verified)).toBe('verified');
  });

  it('is unverified when the current evaluation did not verify it, or there is none', () => {
    expect(valueStatus(withOutcome('semantics_changed'))).toBe('unverified');
    expect(valueStatus(withOutcome('binding_invalid'))).toBe('unverified');
    expect(valueStatus({ values_status: 'verified', current_evaluation: null })).toBe('unverified');
  });

  it('is declared for the author values, whatever the evaluation says', () => {
    expect(valueStatus(withOutcome('declared', 'declared'))).toBe('declared');
  });

  it('reads a list row summary by the gateway’s verified', () => {
    expect(valueStatus({ values_status: 'verified', verified: true })).toBe('verified');
    expect(valueStatus({ values_status: 'verified', verified: false })).toBe('unverified');
    expect(valueStatus({ values_status: 'declared', verified: false })).toBe('declared');
  });
});

describe('valueModels', () => {
  it('lists the values in the order served, with units as written and the version status', () => {
    const models = valueModels(verified);
    expect(models.map(model => model.name)).toEqual([
      'availability',
      'cost',
      'execution_time',
      'reliability',
      'security',
    ]);
    expect(models[1]).toEqual({ name: 'cost', value: 3060, unit: 'USD/month', status: 'verified' });
    expect(models[0].unit).toBe('1');
    expect(models[0].value).toBe(verified.values.availability.value);
  });

  it('marks every value of an unverified version unverified', () => {
    expect(
      valueModels(withOutcome('semantics_changed')).every(model => model.status === 'unverified')
    ).toBe(true);
  });
});

describe('formatValue', () => {
  it('writes the number with the unit as written, and a dimensionless one alone', () => {
    expect(formatValue(3060, 'USD/month')).toBe('3,060 USD/month');
    expect(formatValue(0.9963044476255752, '1')).toBe('0.996304');
    expect(formatValue(-2.5, 'EUR')).toBe('-2.5 EUR');
  });

  it('never rounds a small number to zero', () => {
    expect(formatNumber(1.0e-7)).toBe('1E-7');
    expect(formatNumber(0)).toBe('0');
  });
});
