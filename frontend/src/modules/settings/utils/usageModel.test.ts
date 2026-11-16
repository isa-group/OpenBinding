import { describe, expect, it } from 'vitest';
import type { UsageView } from '../../../api/auth';
import { exactValueText, usageRows } from './usageModel';

describe('plan rows', () => {
  const usage: UsageView = {
    plan: 'PRO',
    contract_pending: false,
    features: { runs: true },
    capabilities: { maxFederatedEngines: null, maxApiKeys: 25, maxRunMinutes: 30, newThing: 5 },
  };
  const rows = usageRows(usage);
  const row = (id: string) => rows.find(item => item.id === id)!;

  it('lists what the plan allows, in a stable order, with the unknown ones last', () => {
    expect(rows.map(item => item.id)).toEqual([
      'maxFederatedEngines',
      'maxApiKeys',
      'maxRunMinutes',
      'newThing',
    ]);
    expect(row('maxApiKeys')).toMatchObject({ limit: 25 });
    expect(row('maxRunMinutes')).toMatchObject({ limit: 30 });
  });

  it('reads a null capability as no limit', () => {
    expect(row('maxFederatedEngines')).toMatchObject({ limit: null });
  });

  it('words the exact value: a figure when there is a ceiling, "No limit" (never `.inf`) when there is none', () => {
    expect(exactValueText(row('maxRunMinutes'))).toBe('30 min');
    expect(exactValueText(row('maxApiKeys'))).toBe('25');
    expect(exactValueText(row('maxFederatedEngines'))).toBe('No limit');
    expect(exactValueText({ ...row('maxApiKeys'), limit: Number.POSITIVE_INFINITY })).toBe(
      'No limit'
    );
    for (const item of rows) expect(exactValueText(item)).not.toMatch(/\.inf|Infinity|null/);
  });

  it('carries no consumption at all', () => {
    for (const item of rows) expect(Object.keys(item).sort()).toEqual(['id', 'info', 'limit']);
  });

  it('reads an answer without capabilities as no rows', () => {
    expect(usageRows({ plan: 'BASIC', contract_pending: true, features: {} } as UsageView)).toEqual(
      []
    );
  });
});
