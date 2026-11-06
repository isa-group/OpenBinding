import { describe, expect, it } from 'vitest';

import type { CompositionChange, CompositionDiff } from '../../api/compositions';
import { cell, compositionRows, compositionSummary, countsByCategory, COMPOSITION_DIFF_CATEGORIES } from './compositionDiffModel';

const change = (over: Partial<CompositionChange>): CompositionChange => ({
  section: 'properties',
  subject: 'cost.direction',
  kind: 'changed',
  was: 'minimize',
  now: 'maximize',
  ...over,
});

describe('the categories', () => {
  it('are the composition’s own sections, not the binding case’s five', () => {
    expect([...COMPOSITION_DIFF_CATEGORIES]).toEqual(['identity', 'properties', 'tasks', 'workflow', 'candidates', 'rules', 'goals', 'studio']);
    // Resources is the case screen's, and it is empty for a composition: its rows come
    // from library ArtifactRefs and a composition's manifest names files.
    expect(COMPOSITION_DIFF_CATEGORIES).not.toContain('Resources');
    // Properties is the one the five had no room for, and it is the largest.
    expect(COMPOSITION_DIFF_CATEGORIES).toContain('properties');
  });
});

describe('cell', () => {
  it('renders a missing value as an em dash rather than as undefined', () => {
    expect(cell(undefined)).toBe('—');
    expect(cell(null)).toBe('—');
    expect(cell('')).toBe('—');
    expect(cell([])).toBe('—');
  });

  it('keeps a number and a boolean readable', () => {
    expect(cell(0.3)).toBe('0.3');
    expect(cell(false)).toBe('false');
  });

  it('flattens a list and an object instead of printing [object Object]', () => {
    expect(cell(['service/t1', 'service/t2'])).toBe('service/t1, service/t2');
    expect(cell({ min: 0, max: 10000, clamp: true })).toBe('min 0, max 10000, clamp true');
    expect(cell(['/sequence[0]'])).toBe('/sequence[0]');
  });
});

describe('compositionRows', () => {
  it('keeps the server’s order and carries the verdict', () => {
    const rows = compositionRows([
      change({ section: 'tasks', subject: 'pick', kind: 'renamed', was: 'pick', now: 'collect' }),
      change({ section: 'goals', subject: 'cost.normalize', kind: 'changed', was: { min: 0, max: 10000, clamp: true }, now: { min: 0, max: 25000, clamp: true } }),
    ]);
    expect(rows.map((row) => [row.category, row.what, row.kind])).toEqual([
      ['tasks', 'pick', 'renamed'],
      ['goals', 'cost.normalize', 'changed'],
    ]);
    expect(rows[1].a).toBe('min 0, max 10000, clamp true');
    expect(rows[1].b).toBe('min 0, max 25000, clamp true');
  });

  it('marks every row changed, because the server sends only what changed', () => {
    // The old model inferred `changed` from whether two cells print differently, which is
    // how a moved normalization range rendered as "Same".
    const rows = compositionRows([change({ was: 'minimize', now: 'minimize' })]);
    expect(rows[0].changed).toBe(true);
  });

  it('shows an addition as an em dash on the left', () => {
    const rows = compositionRows([change({ section: 'tasks', subject: 'Q', kind: 'added', was: null, now: 'open' })]);
    expect([rows[0].a, rows[0].b]).toEqual(['—', 'open']);
  });
});

describe('countsByCategory', () => {
  it('counts every category, including the empty ones', () => {
    const counts = countsByCategory(compositionRows([
      change({ section: 'tasks', subject: 'a' }),
      change({ section: 'tasks', subject: 'b' }),
      change({ section: 'goals', subject: 'c' }),
    ]));
    expect(counts.tasks).toBe(2);
    expect(counts.goals).toBe(1);
    expect(counts.studio).toBe(0);
    expect(Object.keys(counts)).toHaveLength(COMPOSITION_DIFF_CATEGORIES.length);
  });
});

describe('compositionSummary', () => {
  const diff = (changes: CompositionChange[]): CompositionDiff => ({
    identical: changes.length === 0,
    changes,
    counts: {} as CompositionDiff['counts'],
  });

  it('says nothing changed when nothing did', () => {
    expect(compositionSummary(diff([]))).toBe('No changes.');
  });

  it('names the verdicts rather than counting rows', () => {
    // "27 changes" and "six replaced, two renamed" answer the same question, and only one
    // of them is useful.
    const summary = compositionSummary(diff([
      change({ kind: 'added' }),
      change({ kind: 'added' }),
      change({ kind: 'renamed' }),
      change({ kind: 'changed' }),
    ]));
    expect(summary).toBe('2 added, 1 renamed, 1 changed.');
  });
});
