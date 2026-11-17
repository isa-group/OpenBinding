import { describe, expect, it } from 'vitest';
import type { EngineCatalogEntry, EngineMode } from '../../../api/client';
import { catalogFilterOptions, engineRows, filterRows } from './enginesModel';

function mode(id: string, extra: Partial<EngineMode> = {}): EngineMode {
  const all = { selector: 'all' as const };
  return {
    id,
    profile: 'qos-binding/v1',
    ir: { apiVersion: 'bim/v1', kind: 'BindingProblem' },
    algorithm: id,
    capabilities: {
      workflowNodes: all,
      metricScopes: all,
      aggregations: all,
      constraints: all,
      optimization: all,
      objectiveTypes: { selector: 'only', values: ['SINGLE'] },
      expressions: all,
      placement: { selector: 'none' },
      irExtensions: { selector: 'none' },
      featureValues: { selector: 'only', values: ['scalar'] },
    },
    optionsSchema: { type: 'object', properties: {}, additionalProperties: false },
    limits: {},
    guarantees: { termination: ['FEASIBLE'], exact: false },
    ...extra,
  };
}

function engine(namespace: string, name: string, modes: EngineMode[]): EngineCatalogEntry {
  const ref = { namespace, name, version: '1.0.0', digest: `sha256-${'a'.repeat(64)}` };
  return { ...ref, id: `${namespace}/${name}`, ref, modes };
}

const rows = engineRows(
  [
    engine('bim.builtin', 'random-search', [mode('sampling')]),
    engine('bim.builtin', 'exhaustive', [
      mode('enumeration', {
        guarantees: { termination: ['OPTIMAL'], exact: true },
        capabilities: {
          ...mode('x').capabilities,
          placement: { selector: 'all' },
          featureValues: { selector: 'all' },
          objectiveTypes: { selector: 'only', values: ['SINGLE', 'MULTI'] },
        },
      }),
    ]),
    engine('lucia', 'edge-solver', [mode('sampling')]),
  ],
  { username: 'lucia', revisions: [], registrations: [] }
);

describe('the catalog filters', () => {
  it('offers the families, modes, capabilities and visibilities of the revisions the reader sees', () => {
    const options = catalogFilterOptions(rows);
    expect(options.families.map(option => option.label)).toEqual([
      'Random Search',
      'Exhaustive',
      'Federated',
    ]);
    expect(options.modes.map(option => option.value)).toEqual(['enumeration', 'sampling']);
    expect(options.capabilities.map(option => option.value)).toEqual([
      'exact',
      'multi-objective',
      'placement',
      'intervals',
    ]);
    expect(options.visibilities).toEqual([
      { value: 'public', label: 'Published' },
      { value: 'private', label: 'Private' },
    ]);
  });

  it('keeps the revisions that match the search and any value of every filter', () => {
    const names = (query: Parameters<typeof filterRows>[1]) =>
      filterRows(rows, query).map(row => row.engine.name);
    expect(names({})).toEqual(['random-search', 'exhaustive', 'edge-solver']);
    expect(names({ q: 'EDGE' })).toEqual(['edge-solver']);
    expect(names({ families: ['federated', 'exhaustive'] })).toEqual(['exhaustive', 'edge-solver']);
    expect(names({ modes: ['sampling'], visibility: ['public'] })).toEqual(['random-search']);
    expect(names({ capabilities: ['exact'] })).toEqual(['exhaustive']);
    expect(names({ capabilities: ['intervals'], families: ['federated'] })).toEqual([]);
  });
});
