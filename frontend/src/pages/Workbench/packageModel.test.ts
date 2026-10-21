import { describe, expect, it } from 'vitest';
import { BimPackageError, zipStore } from '../../utils/bimZip';
import { readPackageModel } from './packageModel';

const instance = {
  apiVersion: 'bim/v1',
  kind: 'Instance',
  metadata: { name: 'checkout', description: 'A checkout flow' },
  spec: {
    profile: 'qos-binding/v1',
    resources: {
      application: { application: 'application.json' },
      candidateCatalog: { catalog: 'candidates.json' },
      constraintSet: { rules: 'rules.json' },
      optimization: { optimization: 'optimization.json' },
      extra: { shared: { namespace: 'isa-demo', name: 'shared-catalog', version: '2.0.0', digest: `sha256-${'a'.repeat(64)}` } },
    },
  },
};

const application = {
  kind: 'Application',
  spec: {
    tasks: { t1: 'service/auth', t2: 'service/stock', t3: 'service/pay' },
    features: { latency: { unit: 'ms' } },
    workflow: {
      sequence: [
        { task: { resource: 'application', id: 't1' } },
        { parallel: [{ task: { resource: 'application', id: 't2' } }] },
        { exclusive: [{ branch: { task: { resource: 'application', id: 't3' } }, probability: 0.7 }] },
      ],
    },
  },
};

const catalog = {
  kind: 'CandidateCatalog',
  spec: {
    candidates: {
      a: { provides: 'service/auth', features: { latency: 10 } },
      b: { provides: 'service/auth', features: { latency: 20 } },
      c: { provides: 'service/stock', features: { latency: 5 } },
      d: { provides: 'service/pay', features: { latency: 7 } },
    },
  },
};

const rules = {
  kind: 'ConstraintSet',
  spec: { constraints: [{ id: 'sla', enforcement: 'hard', description: 'Latency ≤ 600 ms' }, { id: 'avail', penalty: 5, description: 'Availability ≥ 99.9 %' }] },
};

const optimization = {
  kind: 'Optimization',
  spec: { mode: 'weighted', criteria: [{ id: 'cost', weight: 0.6, direction: 'minimize' }, { id: 'latency', weight: 0.4, direction: 'minimize' }] },
};

function archive(files: Record<string, unknown>): ArrayBuffer {
  const bytes = zipStore(Object.fromEntries(Object.entries(files).map(([path, value]) => [path, JSON.stringify(value)])));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

const full = () => archive({
  'instance.json': instance,
  'application.json': application,
  'candidates.json': catalog,
  'rules.json': rules,
  'optimization.json': optimization,
  'notes/readme.json': { kind: 'Note' },
});

describe('package model', () => {
  it('reads the instance: name, profile, files with the role the instance gives them, and registered resources', async () => {
    const model = await readPackageModel(full());
    expect(model).toMatchObject({ name: 'checkout', description: 'A checkout flow', profile: 'qos-binding/v1' });
    expect(model.files.map((file) => file.path).sort()).toEqual([
      'application.json', 'candidates.json', 'instance.json', 'notes/readme.json', 'optimization.json', 'rules.json',
    ]);
    expect(model.files.find((file) => file.path === 'candidates.json')).toMatchObject({ role: 'candidateCatalog', logicalId: 'catalog', kind: 'CandidateCatalog' });
    expect(model.files.find((file) => file.path === 'notes/readme.json')).toMatchObject({ role: null, kind: 'Note' });
    expect(model.registered).toEqual([{ role: 'extra', logicalId: 'shared', reference: 'isa-demo/shared-catalog@2.0.0' }]);
    expect(model.tree.map((node) => node.name)).toEqual(['notes', 'application.json', 'candidates.json', 'instance.json', 'optimization.json', 'rules.json']);
    expect(model.tree[0].children.map((node) => node.name)).toEqual(['readme.json']);
  });

  it('counts the choices of each task and the range of every feature', async () => {
    const model = await readPackageModel(full());
    expect(model.tasks).toEqual([
      { id: 't1', capability: 'service/auth', candidates: 2, ranges: [{ feature: 'latency', min: 10, max: 20, unit: 'ms' }] },
      { id: 't2', capability: 'service/stock', candidates: 1, ranges: [{ feature: 'latency', min: 5, max: 5, unit: 'ms' }] },
      { id: 't3', capability: 'service/pay', candidates: 1, ranges: [{ feature: 'latency', min: 7, max: 7, unit: 'ms' }] },
    ]);
    expect(model.bindingSpaceLog10).toBeCloseTo(Math.log10(2), 5);
  });

  it('turns the workflow into nested blocks with its tasks and branch probabilities', async () => {
    const model = await readPackageModel(full());
    expect(model.workflow).toEqual({
      type: 'block',
      label: 'SEQUENCE',
      note: '',
      children: [
        { type: 'task', id: 't1', capability: 'service/auth', candidates: 2, note: '' },
        { type: 'block', label: 'PARALLEL', note: '', children: [{ type: 'task', id: 't2', capability: 'service/stock', candidates: 1, note: '' }] },
        { type: 'block', label: 'EXCLUSIVE', note: '', children: [{ type: 'task', id: 't3', capability: 'service/pay', candidates: 1, note: 'p 0.7' }] },
      ],
    });
  });

  it('lists the constraints as hard or soft and the objective with its weights', async () => {
    const model = await readPackageModel(full());
    expect(model.constraints).toEqual([
      { id: 'sla', enforcement: 'hard', text: 'Latency ≤ 600 ms', penalty: null },
      { id: 'avail', enforcement: 'soft', text: 'Availability ≥ 99.9 %', penalty: 5 },
    ]);
    expect(model.optimizationMode).toBe('weighted');
    expect(model.criteria).toEqual([
      { id: 'cost', direction: 'minimize', weight: 0.6 },
      { id: 'latency', direction: 'minimize', weight: 0.4 },
    ]);
  });

  it('shows what it can of a package that lacks the usual resources, without guessing', async () => {
    const model = await readPackageModel(archive({ 'instance.json': { kind: 'Instance', spec: { profile: 'qos-binding/v1' } }, 'blob.json': [1, 2] }));
    expect(model.workflow).toBeNull();
    expect(model.tasks).toEqual([]);
    expect(model.bindingSpaceLog10).toBeNull();
    // Entries come back in the archive's order: blob.json, then instance.json.
    expect(model.files.map((file) => [file.path, file.kind])).toEqual([['blob.json', null], ['instance.json', 'Instance']]);
  });

  it('refuses what is not a readable BIM package', async () => {
    await expect(readPackageModel(new TextEncoder().encode('not a zip').buffer as ArrayBuffer)).rejects.toBeInstanceOf(BimPackageError);
  });
});
