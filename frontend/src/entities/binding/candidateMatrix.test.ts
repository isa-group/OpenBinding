import { describe, expect, it } from 'vitest';
import type { ProblemFacts } from '../../shared/api/types';
import ambiguous from '../../test/fixtures/core/ambiguous.facts.json';
import fms from '../../test/fixtures/core/fms.facts.json';
import simpleSeq from '../../test/fixtures/core/simple-seq.facts.json';
import { candidateMatrix } from './candidateMatrix';

/** simple-seq with a second feature and every kind of value on task t1: a number, a closed range, one open above, one open below. */
function rangedFacts(): ProblemFacts {
  const facts = structuredClone(simpleSeq) as ProblemFacts;
  facts.features.push({ id: 'cost', unit: 'EUR', direction: 'min', required: true });
  const [c1a, c1b] = facts.candidates;
  c1a.values = { latency: 10, cost: { min: 0.01, max: 0.02 } };
  c1b.values = { latency: { min: 100, max: null }, cost: { min: null, max: 0.05 } };
  return facts;
}

describe('candidateMatrix', () => {
  it('keeps ranges as written, open ends included', () => {
    const t1 = candidateMatrix(rangedFacts()).rows[0];
    expect(t1.candidates.map(candidate => candidate.cells.map(cell => cell.value))).toEqual([
      [10, { min: 0.01, max: 0.02 }],
      [
        { min: 100, max: null },
        { min: null, max: 0.05 },
      ],
    ]);
    expect(t1.candidates[0].cells[0]).toEqual({
      feature: 'latency',
      value: 10,
      unit: 'ms',
      origin: {
        kind: 'package',
        resource: 'catalog',
        path: 'candidates.json',
        pointer: '/spec/candidates/c1a/features/latency',
      },
    });
  });

  it('gives a value a candidate does not declare as null, with no origin', () => {
    const facts = rangedFacts();
    facts.candidates[0] = { ...facts.candidates[0], values: { latency: 10 }, origins: {} };
    const cell = candidateMatrix(facts).rows[0].candidates[0].cells.find(
      entry => entry.feature === 'cost'
    );
    expect(cell).toEqual({ feature: 'cost', value: null, unit: 'EUR', origin: null });
  });

  it('marks the selection by the candidate keys of EvaluationView.binding', () => {
    const matrix = candidateMatrix(ambiguous as ProblemFacts, {
      selection: { t1: 'other/c1a', t2: 'catalog/c2a' },
    });
    expect(
      matrix.rows.map(row =>
        row.candidates.filter(candidate => candidate.selected).map(candidate => candidate.key)
      )
    ).toEqual([['other/c1a'], ['catalog/c2a'], []]);
  });

  it('takes the written names from the facts, ambiguous ones included', () => {
    const t1 = candidateMatrix(ambiguous as ProblemFacts).rows[0];
    expect(t1.candidates.map(candidate => [candidate.key, candidate.written])).toEqual([
      ['catalog/c1a', 'catalog/c1a'],
      ['catalog/c1b', 'c1b'],
      ['other/c1a', 'other/c1a'],
    ]);
  });

  it('gives a local task a row with no candidates', () => {
    const local = candidateMatrix(fms as ProblemFacts).rows.find(
      row => row.task === 'node_classic_routing'
    );
    expect(local).toEqual({ task: 'node_classic_routing', kind: 'local', candidates: [] });
  });

  it('puts the required features first, each group in the problem’s order', () => {
    const facts = rangedFacts();
    facts.features = [
      { id: 'carbon', unit: 'g', direction: 'min', required: false },
      { id: 'latency', unit: 'ms', direction: 'min', required: true },
      { id: 'trust', unit: '1', direction: 'max', required: false },
      { id: 'cost', unit: 'EUR', direction: null, required: true },
    ];
    const matrix = candidateMatrix(facts);
    expect(matrix.features.map(feature => feature.id)).toEqual([
      'latency',
      'cost',
      'carbon',
      'trust',
    ]);
    expect(matrix.rows[0].candidates[0].cells.map(cell => cell.feature)).toEqual([
      'latency',
      'cost',
      'carbon',
      'trust',
    ]);
  });
});
