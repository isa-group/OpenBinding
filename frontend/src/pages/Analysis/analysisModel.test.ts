import { describe, expect, it } from 'vitest';
import type { BudgetMap, Geometry } from '../../analysis/archive';
import { analysisProblem } from './analysisErrors';
import { HttpError } from '../../api/client';
import {
  budgetRungs, evidenceKey, groupSources, groupTitle, lossSegments, longestLoss, searchOfSources, stretchesOf, targetOf, viewOf,
} from './analysisModel';
import { JOB_DONE, JOB_OLD, JOB_RUNNING, JOB_SECOND, ROWS, SOURCES, archiveOf, sourceOf } from './fixtures';

describe('grouping the results that can be ranked together', () => {
  it('puts results of one model and checker together, apart from legacy and unfinished ones', () => {
    const other = sourceOf('f9a1b2c3-0000-4000-8000-000000000009', 'minizinc', { irDigest: `sha256-${'0d'.repeat(32)}` });
    const grouped = groupSources([...SOURCES, other]);

    expect(grouped.groups.map((group) => group.sources.map((source) => source.id))).toEqual([[JOB_DONE, JOB_SECOND], [other.id]]);
    expect(grouped.legacy.map((source) => source.id)).toEqual([JOB_OLD]);
    expect(grouped.unfinished.map((source) => source.id)).toEqual([JOB_RUNNING]);
    expect(groupTitle(grouped.groups[0])).toBe('Model sha256-c3d4…c3d4 · checked by sha256-1a2b…1a2b');
  });

  it('treats a result with no recorded evaluator as legacy even when it is not flagged', () => {
    const grouped = groupSources([sourceOf('x', 'random-search', { evaluatorDigest: null })]);
    expect(grouped.groups).toEqual([]);
    expect(grouped.legacy).toHaveLength(1);
  });
});

describe('what the address names', () => {
  it('reads jobs, a saved decision and study evidence', () => {
    const target = targetOf(new URLSearchParams(`job=a&job=b&report=acme/atlas/choice&study=s&run=r&cell=c&org=acme&project=atlas`));
    expect(target.jobs).toEqual(['a', 'b']);
    expect(target.report).toEqual({ org: 'acme', project: 'atlas', slug: 'choice' });
    expect(target.study).toEqual({ org: 'acme', project: 'atlas', study: 's', run: 'r', cell: 'c' });
  });

  it('ignores a half-written report reference or study', () => {
    const target = targetOf(new URLSearchParams('report=acme/atlas&study=s'));
    expect(target.report).toBeNull();
    expect(target.study).toBeNull();
  });

  it('keeps the view out of the identity of the evidence', () => {
    expect(evidenceKey(new URLSearchParams('job=a&view=budgets'))).toBe('job=a');
    expect(viewOf('budgets')).toBe('budgets');
    expect(viewOf('nonsense')).toBe('decision');
    expect(viewOf(null)).toBe('decision');
    expect(searchOfSources(['a b', 'c'])).toBe('job=a%20b&job=c');
  });
});

describe('the bars and ladders drawn from an answer', () => {
  it('shows each binding’s weighted losses as shares of the longest bar', () => {
    const data = archiveOf();
    const longest = longestLoss(data.rows, data);
    expect(longest).toBeCloseTo(0.5 * 0.22 + 0.5 * 0.35);
    const segments = lossSegments(ROWS.payco, data, longest);
    expect(segments.map((segment) => segment.key)).toEqual(['cost', 'latency']);
    expect(segments.reduce((sum, segment) => sum + segment.width, 0)).toBeCloseTo(100);
    expect(lossSegments(ROWS.fastpay, data, longest).reduce((sum, segment) => sum + segment.width, 0)).toBeLessThan(100);
  });

  it('turns the corners of the budget map into rungs in the objectives’ own units', () => {
    const budgets: BudgetMap = {
      available: true, axes: [0, 1], signs: [1, 1], bounds: [300, 0.1, 450, 0.14], selected: [null, null], resolution: 64, aggregated: false, cornerCount: 2, witnessCount: 2,
      corners: [{ x: 327, y: 0.131, id: 'b' }, { x: 412, y: 0.118, id: 'a' }], tiles: [], excluded: [], skipped: [], meaning: '', detail: '',
    };
    const rungs = budgetRungs(budgets);
    expect(rungs.map((rung) => [rung.id, rung.budget, rung.achieved])).toEqual([['b', 327, 0.131], ['a', 412, 0.118]]);
    expect(rungs[0].position).toBeCloseTo(18);
    expect(rungs[1].position).toBeCloseTo(74.67, 1);
  });

  it('splits the preference scale into the stretches where each binding wins, merging neighbours with the same winner', () => {
    const geometry: Geometry = {
      kind: 'sensitivity', state: 'complete', scenarios: [
        { t: 0, winners: ['b'], winnerCount: 1, score: [0] },
        { t: 0.25, winners: ['b'], winnerCount: 2, score: [0] },
        { t: 0.75, winners: ['a'], winnerCount: 1, score: [0] },
        { t: 1, winners: ['a'], winnerCount: 1, score: [0] },
      ],
    };
    expect(stretchesOf(geometry)).toEqual([{ from: 0, to: 0.5, winner: 'b', count: 2 }, { from: 0.5, to: 1, winner: 'a', count: 1 }]);
    expect(stretchesOf(null)).toEqual([]);
  });
});

describe('what a refusal of the analysis means', () => {
  const refused = (status: number, message: string) => Object.assign(new HttpError(status, message), { code: undefined });

  it('says sources that are not yours and sources that changed apart', () => {
    expect(analysisProblem(refused(404, 'Analysis source unavailable'))).toMatchObject({ kind: 'missing', status: 404 });
    expect(analysisProblem(refused(409, 'The source archive has changed; reload before making this decision'))).toMatchObject({ kind: 'stale' });
    expect(analysisProblem(refused(409, 'The pinned model is unavailable for this source'))).toMatchObject({ kind: 'conflict' });
    expect(analysisProblem(refused(429, 'busy'))).toMatchObject({ kind: 'busy' });
    expect(analysisProblem(refused(403, 'The API key boundary excludes this resource'))).toMatchObject({ kind: 'key' });
    expect(analysisProblem(refused(503, 'down'))).toMatchObject({ kind: 'unavailable' });
  });

  it('keeps the gateway’s own words for a 422 document, which arrives as a plain error', () => {
    expect(analysisProblem(new Error('A requirement names an unknown objective'))).toMatchObject({ kind: 'refused', text: 'A requirement names an unknown objective' });
    expect(analysisProblem(new TypeError('Failed to fetch'))).toMatchObject({ kind: 'unavailable', title: 'OpenBinding couldn’t be reached' });
  });
});
