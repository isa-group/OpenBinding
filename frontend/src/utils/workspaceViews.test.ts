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

it('compares JSON structurally with escaped paths and ordered array entries', async () => {
  const { jsonChanges } = await import('./workspaceViews');
  expect(jsonChanges({ 'a/b': [1, 2], same: true }, { same: true, 'a/b': [1, 3, 4] })).toEqual([
    { path: '/a~1b/1', kind: 'changed', before: 2, after: 3 },
    { path: '/a~1b/2', kind: 'added', before: undefined, after: 4 },
  ]);
  expect(jsonChanges({}, [])).toEqual([{ path: '/', kind: 'changed', before: {}, after: [] }]);
});
