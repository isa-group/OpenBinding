import { describe, expect, it } from 'vitest';
import { DEFAULT_FILES } from '../pages/Workbench/bimDocuments';
import { LEGACY_ANNOTATION, migrateContent, migrateDocument, migrateFiles } from './bimVocabulary';

// Documents kept before the editors wrote the vocabulary of the schemas: read in both, written in the real one, nothing dropped.

const doc = (kind: string, spec: Record<string, unknown>, metadata: Record<string, unknown> = { name: 'x' }) => (
  { apiVersion: kind === 'Placement' ? 'qos-binding-placement/v1' : 'qos-binding/v1', kind, metadata, spec }
);

describe('migrating a document to the vocabulary of the schemas', () => {
  it('leaves a document that already uses it exactly as it is', () => {
    for (const [path, source] of Object.entries(DEFAULT_FILES)) {
      if (!path.endsWith('.json')) continue;
      const document = JSON.parse(source) as Record<string, unknown>;
      const migrated = migrateDocument(document);
      expect(migrated.value, path).toBe(document);
      expect(migrated.notes, path).toEqual([]);
    }
  });

  it('renames Application metrics to features, in place', () => {
    const migrated = migrateDocument(doc('Application', { tasks: { a: 'x' }, metrics: { latency: { unit: 'ms' } }, workflow: {} }));
    expect(migrated.value.spec).toEqual({ tasks: { a: 'x' }, features: { latency: { unit: 'ms' } }, workflow: {} });
    expect(Object.keys(migrated.value.spec as object)).toEqual(['tasks', 'features', 'workflow']);
    expect(migrated.notes).toEqual(['spec: "metrics" is now "features".']);
  });

  it('merges metrics into features and keeps the older value of a clash under the legacy annotation', () => {
    const migrated = migrateDocument(doc('Application', {
      metrics: { latency: { unit: 'ms' }, cost: { unit: 'eur' } },
      features: { latency: { unit: 's' } },
    }));
    expect(migrated.value.spec).toEqual({ features: { latency: { unit: 's' }, cost: { unit: 'eur' } } });
    expect((migrated.value.metadata as { annotations: Record<string, unknown> }).annotations[LEGACY_ANNOTATION]).toEqual({ 'spec.metrics': { latency: { unit: 'ms' } } });
    expect(migrated.notes[0]).toContain('latency kept their "features" value');
  });

  it('renames metricBindings and the metrics of every candidate', () => {
    const migrated = migrateDocument(doc('CandidateCatalog', {
      metricBindings: { latency: { resource: 'application', id: 'latency' } },
      candidates: { a: { provides: 'http', metrics: { latency: 10 } }, b: { provides: 'http', features: { latency: { min: 1, max: null } } } },
    }));
    expect(migrated.value.spec).toEqual({
      featureBindings: { latency: { resource: 'application', id: 'latency' } },
      candidates: { a: { provides: 'http', features: { latency: 10 } }, b: { provides: 'http', features: { latency: { min: 1, max: null } } } },
    });
    expect(migrated.notes).toEqual(['spec: "metricBindings" is now "featureBindings".', 'spec.candidates: candidate a: "metrics" is now "features".']);
  });

  it('turns terms into criteria and keeps the strategy and the weights where they are not lost', () => {
    const migrated = migrateDocument(doc('Optimization', {
      type: 'MULTI',
      mode: 'pareto',
      terms: [
        { metric: { resource: 'application', id: 'cost' }, direction: 'minimize', weight: 0.6, normalize: { min: 0, max: 10, clamp: true } },
        { metric: { resource: 'application', id: 'cost' }, weight: 0.4, note: 'second look' },
        { weight: 3 },
      ],
      penalties: [{ constraint: { resource: 'rules', id: 'soft' }, weight: 2 }],
    }));
    expect(migrated.value.spec).toEqual({
      criteria: [
        { id: 'cost', feature: { resource: 'application', id: 'cost' }, direction: 'minimize', normalize: { min: 0, max: 10, clamp: true } },
        { id: 'cost-2', feature: { resource: 'application', id: 'cost' } },
      ],
      penalties: [{ constraint: { resource: 'rules', id: 'soft' }, weight: 2 }],
    });
    expect((migrated.value.metadata as { annotations: Record<string, unknown> }).annotations[LEGACY_ANNOTATION]).toEqual({
      'spec.optimization': {
        type: 'MULTI', mode: 'pareto', weights: { cost: 0.6, 'cost-2': 0.4 }, termKeys: { 'cost-2': { note: 'second look' } }, terms: [{ weight: 3 }],
      },
    });
    expect(migrated.notes).toHaveLength(1);
    expect(migrated.notes[0]).toContain('2 terms became criteria');
    expect(migrated.notes[0]).toContain('1 term without a feature could not be converted and is kept there');
  });

  it('reads a term that already names its feature, and keeps the criteria a document already had', () => {
    const migrated = migrateDocument(doc('Optimization', {
      criteria: [{ id: 'latency', feature: { resource: 'application', id: 'latency' } }],
      terms: [{ feature: { resource: 'application', id: 'latency' } }],
    }));
    expect(migrated.value.spec).toEqual({
      criteria: [
        { id: 'latency', feature: { resource: 'application', id: 'latency' } },
        { id: 'latency-2', feature: { resource: 'application', id: 'latency' } },
      ],
    });
  });

  it('renames the metric of Placement transitions and of the global latency', () => {
    const reference = { resource: 'application', id: 'latency' };
    const migrated = migrateDocument(doc('Placement', {
      pools: { edge: { capacity: {} } },
      transitions: { t1: { from: { resource: 'application', id: 'a' }, to: { resource: 'application', id: 'b' }, metric: reference, maximum: 5 } },
      globalLatency: { metric: reference, includeExecution: true, exclusive: 'routing', parallel: 'max' },
    }));
    expect(migrated.value.spec).toEqual({
      pools: { edge: { capacity: {} } },
      transitions: { t1: { from: { resource: 'application', id: 'a' }, to: { resource: 'application', id: 'b' }, feature: reference, maximum: 5 } },
      globalLatency: { feature: reference, includeExecution: true, exclusive: 'routing', parallel: 'max' },
    });
    expect(migrated.notes).toHaveLength(2);
  });

  it('does not touch the kinds it has nothing to say about, nor a spec that is not an object', () => {
    const rules = doc('ConstraintSet', { constraints: { c: { assert: 'metrics.latency >= 0', enforcement: 'hard' } } });
    expect(migrateDocument(rules).value).toBe(rules);
    const odd = { kind: 'Application', spec: 'text' };
    expect(migrateDocument(odd).value).toBe(odd);
  });

  it('is idempotent: migrating the result changes nothing', () => {
    const once = migrateDocument(doc('Optimization', { mode: 'weighted', terms: [{ metric: { resource: 'application', id: 'latency' }, weight: 1 }] }));
    const twice = migrateDocument(once.value);
    expect(twice.value).toBe(once.value);
    expect(twice.notes).toEqual([]);
  });
});

describe('migrating the files of a package', () => {
  it('rewrites only the documents that changed and names the file in each note', () => {
    const old = {
      ...DEFAULT_FILES,
      'application.json': JSON.stringify(doc('Application', { tasks: { hello: 'http' }, metrics: { latency: { unit: 'ms' } }, workflow: {} })),
      'broken.json': '{',
      'notes.txt': 'metrics: not json',
    };
    const migrated = migrateFiles(old);
    expect(JSON.parse(migrated.value['application.json']).spec.features).toEqual({ latency: { unit: 'ms' } });
    expect(migrated.value['application.json'].endsWith('\n')).toBe(true);
    for (const path of ['instance.json', 'candidates.json', 'optimization.json', 'workflow.bpmn', 'broken.json', 'notes.txt']) {
      expect(migrated.value[path], path).toBe(old[path as keyof typeof old]);
    }
    expect(migrated.notes).toEqual(['application.json · spec: "metrics" is now "features".']);
  });

  it('returns the same files when there is nothing to migrate', () => {
    const migrated = migrateFiles(DEFAULT_FILES);
    expect(migrated.value).toBe(DEFAULT_FILES);
    expect(migrated.notes).toEqual([]);
  });

  it('migrates the content of a library draft, and passes text through', () => {
    const migrated = migrateContent(doc('CandidateCatalog', { metricBindings: {}, candidates: {} }));
    expect(migrated.value).toMatchObject({ spec: { featureBindings: {}, candidates: {} } });
    expect(migrated.notes).toHaveLength(1);
    expect(migrateContent('<bpmn/>')).toEqual({ value: '<bpmn/>', notes: [] });
  });
});
