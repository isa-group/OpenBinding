import { describe, expect, it } from 'vitest';
import { KIND_OPTIONS, isKind, kindLabel } from './kinds';

describe('the kinds of a composition', () => {
  it('names each kind with its word, in the order of the language reference', () => {
    expect(KIND_OPTIONS).toEqual([
      { id: 'application', label: 'Application' },
      { id: 'workflow', label: 'Workflow' },
      { id: 'pipeline', label: 'Pipeline' },
      { id: 'system', label: 'System' },
    ]);
    expect(kindLabel('pipeline')).toBe('Pipeline');
  });

  it('tells a kind from any other text', () => {
    expect(isKind('system')).toBe(true);
    for (const value of ['System', 'service', '', null, undefined]) expect(isKind(value), String(value)).toBe(false);
  });
});
