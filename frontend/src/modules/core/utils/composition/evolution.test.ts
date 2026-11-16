import { describe, expect, it } from 'vitest';
import { evolutionModel, type EvolutionRow } from './evolution';

// Light version rows, as `GET …/versions?include=analytics&order=oldest` serves them.
const ANALYTICS = {
  tasks: 3,
  boundTasks: 2,
  localTasks: 1,
  providers: 2,
  upstreamPricings: 0,
  workflow: { depth: 1, and: 0, xor: 1, loop: 0 },
  hasOffering: false,
};

const link = (slug: string, revision: number, digest: string) => ({
  problem: { id: 'p-1', slug, name: slug },
  revision: { id: `r-${revision}`, revision },
  linked_compilation: {
    id: `c-${digest}`,
    compilation_digest: `cd-${digest}`,
    semantic_digest: `sd-${digest}`,
  },
});

const evaluation = (
  outcome: 'verified' | 'semantics_changed' | 'declared',
  digest: string | null
) => ({
  id: `e-${outcome}`,
  basis: digest ? ('bim' as const) : ('declared' as const),
  outcome,
  created_at: '2026-01-01T00:00:00Z',
  compilation: digest
    ? { compilation_digest: `cd-${digest}`, semantic_digest: `sd-${digest}`, toolchain: {} }
    : null,
});

let ordinal = 0;
const row = (overrides: Partial<EvolutionRow> & { day: number }): EvolutionRow => {
  ordinal += 1;
  const { day, ...rest } = overrides;
  return {
    id: `v-${ordinal}`,
    label: `1.${ordinal}.0`,
    ordinal,
    created_at: `2026-03-${String(day).padStart(2, '0')}T12:00:00Z`,
    values: {},
    values_status: 'declared',
    current_evaluation: evaluation('declared', null),
    problem: null,
    analytics: ANALYTICS,
    ...rest,
  };
};

const verifiedOn = (slug: string, revision: number, digest: string) => ({
  values_status: 'verified' as const,
  current_evaluation: evaluation('verified', digest),
  problem: link(slug, revision, digest),
});

function history(): EvolutionRow[] {
  ordinal = 0;
  return [
    row({ day: 1, values: { cost: { value: 10, unit: 'EUR' } } }),
    row({ day: 2, analytics: null, values: { cost: { value: 12, unit: 'EUR' } } }),
    row({
      day: 3,
      ...verifiedOn('shop', 1, 'a'),
      values: { cost: { value: 11.5, unit: 'EUR' }, availability: { value: 0.99, unit: '1' } },
    }),
    row({ day: 4, ...verifiedOn('shop', 1, 'b'), values: { cost: { value: 11, unit: 'USD' } } }),
    row({
      day: 5,
      ...verifiedOn('shop', 2, 'b'),
      current_evaluation: evaluation('semantics_changed', 'b'),
      values: { cost: { value: 11, unit: 'USD' } },
    }),
    row({ day: 6, values: { cost: { value: 9, unit: 'USD' } } }),
  ];
}

describe('evolutionModel', () => {
  it('places every version on the time and the ordinal axes, oldest first whatever the order given', () => {
    const rows = history();
    const model = evolutionModel([...rows].reverse());
    expect(model.points.map(point => point.ordinal)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(model.points[0].t).toBe(Date.parse('2026-03-01T12:00:00Z'));
    expect(model.points[2]).toMatchObject({
      id: 'v-3',
      label: '1.3.0',
      problemKey: 'shop@1',
      compilationKey: 'sd-a',
    });
  });

  it('adds no structure point for a version without analytics, and no synthetic first point', () => {
    const model = evolutionModel(history());
    const tasks = model.structure.find(series => series.metric === 'tasks')!;
    expect(tasks.points.map(point => point.ordinal)).toEqual([1, 3, 4, 5, 6]);
    expect(tasks.points[0]).toEqual({
      t: Date.parse('2026-03-01T12:00:00Z'),
      ordinal: 1,
      value: 3,
    });
    expect(model.structure.find(series => series.metric === 'workflow.xor')!.points[0].value).toBe(
      1
    );
    expect(model.hasOffering.map(point => point.value)).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
  });

  it('keeps a count the gateway did not give as null, never 0', () => {
    const rows = history();
    rows[0].analytics = { tasks: 3, workflow: {} };
    const model = evolutionModel(rows);
    expect(
      model.structure.find(series => series.metric === 'providers')!.points[0].value
    ).toBeNull();
    expect(
      model.structure.find(series => series.metric === 'workflow.depth')!.points[0].value
    ).toBeNull();
    expect(model.hasOffering[0].value).toBeNull();
  });

  it('splits a value whose unit changes into two charts, never sharing an axis', () => {
    const model = evolutionModel(history());
    expect(model.values.map(series => `${series.name} · ${series.unit}`)).toEqual([
      'cost · EUR',
      'availability · 1',
      'cost · USD',
    ]);
    const euros = model.values[0];
    expect(euros.declared.map(point => point.value)).toEqual([10, 12, null, null, null, null]);
    expect(euros.verified.map(point => point.value)).toEqual([null, null, 11.5, null, null, null]);
  });

  it('puts each version value in exactly one status series, the other two holding a gap there', () => {
    const model = evolutionModel(history());
    const dollars = model.values[2];
    expect(dollars.verified.map(point => point.value)).toEqual([null, null, null, 11, null, null]);
    expect(dollars.unverified.map(point => point.value)).toEqual([
      null,
      null,
      null,
      null,
      11,
      null,
    ]);
    expect(dollars.declared.map(point => point.value)).toEqual([null, null, null, null, null, 9]);
    for (const series of model.values) {
      series.verified.forEach((point, index) => {
        const present = [point, series.declared[index], series.unverified[index]].filter(
          item => item.value !== null
        );
        expect(present.length).toBeLessThanOrEqual(1);
      });
    }
  });

  it('leaves a gap where a version does not have the value at all', () => {
    const availability = evolutionModel(history()).values[1];
    expect(
      [...availability.verified, ...availability.declared, ...availability.unverified].filter(
        point => point.value !== null
      )
    ).toEqual([{ t: Date.parse('2026-03-03T12:00:00Z'), ordinal: 3, value: 0.99 }]);
  });

  it('marks a link, a compilation change, a problem revision change and an unlink', () => {
    const model = evolutionModel(history());
    expect(model.markers).toEqual([
      {
        t: Date.parse('2026-03-03T12:00:00Z'),
        ordinal: 3,
        kind: 'linked',
        label: 'Linked to shop@1',
      },
      {
        t: Date.parse('2026-03-04T12:00:00Z'),
        ordinal: 4,
        kind: 'compilation',
        label: 'Compilation changed',
      },
      {
        t: Date.parse('2026-03-05T12:00:00Z'),
        ordinal: 5,
        kind: 'problem',
        label: 'Problem shop@1 to shop@2',
      },
      {
        t: Date.parse('2026-03-06T12:00:00Z'),
        ordinal: 6,
        kind: 'unlinked',
        label: 'No longer linked to shop@2',
      },
    ]);
  });

  it('keys a compilation by the evaluation when the version links none', () => {
    const rows = history();
    rows[0].current_evaluation = evaluation('verified', 'z');
    expect(evolutionModel(rows).points[0].compilationKey).toBe('sd-z');
  });

  it('gives an empty model for no rows', () => {
    expect(evolutionModel([])).toEqual({
      points: [],
      structure: expect.arrayContaining([{ metric: 'tasks', points: [] }]),
      hasOffering: [],
      values: [],
      markers: [],
    });
  });
});
