import { describe, expect, it } from 'vitest';
import type { CaseContent } from '../Project/projectModel';
import { axisOf, cellsCsv, engineRows, measureTitle, percentOf, rankEngines, scatterOf, seedGroups, spreadOf } from './analyticsModel';
import { FLUJO, REVISION_1, REVISION_2, cellFixture, cellsFixture, RANDOM_SEARCH } from './fixtures';
import { measuresOf, revisionIndex } from './studiesModel';

const cases: CaseContent[] = [{ item: FLUJO, revisions: [REVISION_1, REVISION_2] }];
const index = revisionIndex(cases);

describe('spread of values', () => {
  it('finds the range, the middle half, the median and the mean', () => {
    expect(spreadOf([])).toBeNull();
    expect(spreadOf([4])).toEqual({ min: 4, max: 4, q1: 4, median: 4, q3: 4, mean: 4 });
    const spread = spreadOf([5, 1, 3, 2, 4]);
    expect(spread).toEqual({ min: 1, max: 5, q1: 2, median: 3, q3: 4, mean: 3 });
  });

  it('places a value on an axis and widens the axis a little', () => {
    expect(percentOf(5, 0, 10)).toBe(50);
    expect(percentOf(-3, 0, 10)).toBe(0);
    expect(percentOf(30, 0, 10)).toBe(100);
    expect(percentOf(1, 1, 1)).toBe(50);
    const axis = axisOf([10, 20]);
    expect(axis.low).toBeLessThan(10);
    expect(axis.high).toBeGreaterThan(20);
    expect(axisOf([])).toEqual({ low: 0, high: 1 });
    const flat = axisOf([7, 7]);
    expect(flat.low).toBeLessThan(7);
    expect(flat.high).toBeGreaterThan(7);
  });
});

describe('engines side by side', () => {
  const cells = cellsFixture();

  it('counts what each engine ran and where its values fall', () => {
    const rows = engineRows(cells, 'cost');
    expect(rows.map((row) => row.label)).toEqual(['evolutionary', 'random-search']);
    const evolutionary = rows[0];
    expect(evolutionary.cells).toHaveLength(4);
    expect(evolutionary.completed).toHaveLength(2);
    expect(evolutionary.feasible).toBe(2);
    expect(evolutionary.spread).toMatchObject({ min: 0.104, max: 0.112 });
    expect(evolutionary.meanSeconds).toBe(119);
    expect(rows[1].values).toHaveLength(4);
  });

  it('ranks by the lowest mean first, and puts an engine with nothing to rank last', () => {
    const ranked = rankEngines(engineRows(cells, 'cost'));
    expect(ranked.map((row) => row.label)).toEqual(['evolutionary', 'random-search']);
    const none = rankEngines(engineRows(cells.filter((cell) => cell.engine_ref.name === 'random-search' || cell.state !== 'completed'), 'cost'));
    expect(none.map((row) => row.label)).toEqual(['random-search', 'evolutionary']);
  });

  it('names a measure for a chart title', () => {
    expect(measureTitle('cost')).toBe('Cost found');
    expect(measureTitle('runtime')).toBe('Time taken');
  });
});

describe('trade-offs between two objectives', () => {
  const cells = cellsFixture();

  it('marks the cells nobody beats on both, one case at a time', () => {
    const first = scatterOf(cells, REVISION_1.id, 'cost', 'latency');
    expect(first).toHaveLength(3);
    // 0.121 / 430 is beaten on both measures by 0.118 / 412; the other two each win on one.
    expect(first.filter((point) => point.front).map((point) => point.cell.ordinal).sort()).toEqual([0, 3]);
    expect(first.find((point) => point.cell.ordinal === 2)?.front).toBe(false);
    const second = scatterOf(cells, REVISION_2.id, 'cost', 'latency');
    expect(second.filter((point) => point.front).map((point) => point.cell.ordinal).sort()).toEqual([4, 6]);
    expect(second.find((point) => point.cell.ordinal === 7)?.front).toBe(false);
  });

  it('leaves out the cells that lack either measure', () => {
    expect(scatterOf(cells, REVISION_1.id, 'cost', 'nothing')).toEqual([]);
  });
});

describe('seed to seed', () => {
  it('groups the cells of one case, engine and setting and measures how far the seeds are apart', () => {
    const groups = seedGroups(cellsFixture(), 'cost', index);
    expect(groups).toHaveLength(4);
    const random = groups.find((group) => group.label === 'Flujo de checkout r1 · random-search');
    expect(random?.seeds.map((item) => item.seed)).toEqual([1, 2]);
    expect(random?.spread).toBeCloseTo(0.003, 6);
    const failed = groups.find((group) => group.label === 'Flujo de checkout r1 · evolutionary');
    expect(failed?.spread).toBeNull();
  });
});

describe('the CSV of a run', () => {
  it('has one row per cell with the objectives as columns and quotes what needs it', () => {
    const cells = [...cellsFixture().slice(0, 3), cellFixture(9, REVISION_2, RANDOM_SEARCH, 7, 'completed', { feasible: true, objectives: { cost: 1 }, runtimeSeconds: 2 }, { parameters: { note: 'a "b", c' } })];
    const text = cellsCsv(cells, measuresOf(cells), index);
    const lines = text.split('\n');
    expect(lines[0]).toBe('cell,case_revision,engine,engine_version,mode,setting,seed,state,feasible,cost,latency,runtime_seconds,job_id,fingerprint');
    expect(lines).toHaveLength(5);
    expect(lines[1]).toContain('Flujo de checkout · revision 1,evolutionary,1.0.0,genetic,Engine defaults,1,completed,true,0.112,440,120');
    expect(lines[4]).toContain('"note a ""b"", c"');
  });
});
