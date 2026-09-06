import { describe, expect, it } from 'vitest';
import { sourceDiff, toYaml } from './workspaceViews';

describe('workspace representations', () => {
  it('projects nested BIM JSON into deterministic YAML 1.2', () => {
    expect(toYaml({ apiVersion: 'bim/v1', spec: { enabled: true, seeds: [0, 4], empty: [] } })).toBe(
      'apiVersion: "bim/v1"\nspec:\n  enabled: true\n  seeds:\n    - 0\n    - 4\n  empty:\n    []\n',
    );
  });

  it('keeps shared edges and marks the exact changed source block', () => {
    expect(sourceDiff('a\nb\nc', 'a\nB\nc')).toEqual([
      { kind: 'context', value: 'a' },
      { kind: 'removed', value: 'b' },
      { kind: 'added', value: 'B' },
      { kind: 'context', value: 'c' },
    ]);
  });
});
