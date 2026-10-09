import { describe, expect, it } from 'vitest';
import { buildFieldTree, flattenTree, protocolOperations, schemaFacts, type FieldNode, type Json } from './schemaTree';
import { resolveSchemaKind, schemaPathFor } from './schemaKinds';

const schema: Json = {
  $id: 'https://bim.dev/CandidateCatalog',
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  required: ['spec'],
  properties: {
    apiVersion: { const: 'bim/v1' },
    spec: {
      type: 'object',
      required: ['providers'],
      properties: {
        providers: { type: 'array', minItems: 1, description: 'Candidates that can bind a task', items: { $ref: '#/$defs/Candidate' } },
        mode: { enum: ['hard', 'soft'], description: 'How the rule binds' },
        note: { type: ['string', 'null'] },
      },
    },
  },
  $defs: {
    Candidate: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string', description: 'Unique candidate id' },
        metrics: { type: 'object', properties: { latency: { type: 'number', unit: 'ms', minimum: 0, default: 10 } } },
        parent: { $ref: '#/$defs/Candidate' },
      },
    },
  },
};

function find(nodes: FieldNode[], path: string): FieldNode | undefined {
  for (const node of nodes) {
    if (node.path === path) return node;
    const inner = find(node.children, path);
    if (inner) return inner;
  }
  return undefined;
}

describe('schema field tree', () => {
  const tree = buildFieldTree(schema);

  it('names each field with a plain type, whether it is required, its unit and its allowed values', () => {
    expect(tree.map((node) => node.name)).toEqual(['apiVersion', 'spec']);
    expect(find(tree, '/apiVersion')).toMatchObject({ type: 'fixed value', choices: ['bim/v1'], required: false });
    expect(find(tree, '/spec')).toMatchObject({ type: 'group', required: true });
    expect(find(tree, '/spec/providers')).toMatchObject({ type: 'list', required: true, facts: ['at least 1 item'], description: 'Candidates that can bind a task' });
    expect(find(tree, '/spec/mode')).toMatchObject({ type: 'choice', choices: ['hard', 'soft'] });
    expect(find(tree, '/spec/note')?.type).toBe('text, may be empty');
  });

  it('follows references into the items of a list, with their own required fields', () => {
    expect(find(tree, '/spec/providers/{i}')).toMatchObject({ name: '[i]', type: 'group', required: true });
    expect(find(tree, '/spec/providers/{i}/id')).toMatchObject({ type: 'text', required: true, description: 'Unique candidate id' });
    expect(find(tree, '/spec/providers/{i}/metrics/latency')).toMatchObject({ type: 'number', unit: 'ms', facts: ['at least 0', 'default 10'] });
  });

  it('stops a schema that contains itself instead of looping', () => {
    const parent = find(tree, '/spec/providers/{i}/parent');
    expect(parent?.children).toEqual([]);
    expect(parent?.description).toBe('Same structure as Candidate.');
  });

  it('opens two levels by default, everything on request, nothing on collapse', () => {
    const paths = (mode: 'default' | 'all' | 'none', overrides: Record<string, boolean> = {}, query = '') => (
      flattenTree(tree, { mode, overrides, query }).map((row) => row.node.path)
    );
    expect(paths('default')).toEqual(['/apiVersion', '/spec', '/spec/providers', '/spec/providers/{i}', '/spec/mode', '/spec/note']);
    expect(paths('all')).toContain('/spec/providers/{i}/metrics/latency');
    expect(paths('none')).toEqual(['/apiVersion', '/spec']);
    expect(paths('default', { '/spec': false })).toEqual(['/apiVersion', '/spec']);
    expect(paths('none', { '/spec': true })).toContain('/spec/providers');
  });

  it('finds a field and keeps the branches that lead to it', () => {
    const rows = flattenTree(tree, { mode: 'none', overrides: {}, query: 'latency' });
    expect(rows.map((row) => row.node.path)).toEqual([
      '/spec', '/spec/providers', '/spec/providers/{i}', '/spec/providers/{i}/metrics', '/spec/providers/{i}/metrics/latency',
    ]);
    expect(rows.filter((row) => row.matched).map((row) => row.node.path)).toEqual(['/spec/providers/{i}/metrics/latency']);
  });

  it('counts root fields, required fields and reusable definitions', () => {
    expect(schemaFacts(schema)).toEqual({
      identity: 'https://bim.dev/CandidateCatalog',
      draft: 'https://json-schema.org/draft/2020-12/schema',
      rootFields: 2,
      requiredAtRoot: 1,
      definitions: 1,
    });
  });

  it('reads the engine protocol as component schemas and a table of calls', () => {
    const protocol: Json = {
      protocol: 'bim-engine/v1',
      digest: `sha256-${'f'.repeat(64)}`,
      openapi: {
        paths: { '/jobs': { post: { summary: 'Start a job' }, get: { summary: 'List jobs' } }, '/health': { get: {} } },
        components: { schemas: { Job: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } } },
      },
    };
    const nodes = buildFieldTree(protocol);
    expect(nodes.map((node) => node.name)).toEqual(['Job']);
    expect(nodes[0].children[0]).toMatchObject({ name: 'id', path: '/Job/id', required: true });
    expect(protocolOperations(protocol)).toEqual([
      { method: 'GET', path: '/jobs', summary: 'List jobs' },
      { method: 'POST', path: '/jobs', summary: 'Start a job' },
      { method: 'GET', path: '/health', summary: '' },
    ]);
    expect(schemaFacts(protocol)).toMatchObject({ identity: 'bim-engine/v1', rootFields: 1, definitions: 1 });
  });

  it('reads a schema that has no named fields as an empty tree', () => {
    expect(buildFieldTree({ type: 'string' })).toEqual([]);
  });
});

describe('schema kinds', () => {
  it('resolves a kind whatever the case of the address', () => {
    expect(resolveSchemaKind('application')).toBe('Application');
    expect(resolveSchemaKind('BindingProblem')).toBe('BindingProblem');
    expect(resolveSchemaKind('bindingproblem')).toBe('BindingProblem');
    expect(resolveSchemaKind('engine-contract')).toBe('engine-contract');
    expect(resolveSchemaKind('Placment')).toBeNull();
    expect(resolveSchemaKind(undefined)).toBeNull();
  });

  it('builds the address of the kinds it knows', () => {
    expect(schemaPathFor('Placement')).toBe('/language/schemas/Placement');
    expect(schemaPathFor('BPMN')).toBeNull();
  });
});
