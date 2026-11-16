import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ProblemFacts } from '../../shared/api/types';
import fmsFacts from '../../test/fixtures/core/fms.facts.json';
import { completionAt, schemaKeys, schemaValues, type JsonSchema } from './completion';
import { cursorPlace, scalarAt, withTopLevelScalar } from './yamlText';

/** The schema the gateway serves (`GET /v1/compositions/schema`), read from the file it ships. */
const SCHEMA = JSON.parse(
  readFileSync(
    join(
      process.cwd(),
      '../openbinding-gateway/src/openbinding_gateway/composition/resources/composition2yaml/1.0/composition.schema.json'
    ),
    'utf8'
  )
) as JsonSchema;
const FACTS = fmsFacts as unknown as ProblemFacts;

/** `|` marks the cursor. */
function at(marked: string, facts: ProblemFacts | null = null) {
  const pos = marked.indexOf('|');
  const text = marked.slice(0, pos) + marked.slice(pos + 1);
  const found = completionAt(text, pos, { schema: SCHEMA, facts });
  return found
    ? {
        from: found.from,
        labels: found.options.map(option => option.label),
        apply: found.options.map(option => option.apply),
      }
    : null;
}

const HEAD = 'syntaxVersion: "1.0"\ncomposition: fleet\nversion: 1.0.0\nkind: workflow\n';

describe('the key path at the cursor', () => {
  it('reads block mappings by indentation and flow mappings on the line', () => {
    const text = `${HEAD}binding:\n  T1:\n    candidate: cand\n  T2: {candidate: x, from: {sph`;
    expect(cursorPlace(text, text.indexOf('cand\n') + 4)).toMatchObject({
      path: ['binding', 'T1', 'candidate'],
      at: 'value',
      key: 'candidate',
      word: 'cand',
    });
    expect(cursorPlace(text, text.length)).toMatchObject({
      path: ['binding', 'T2', 'from'],
      at: 'key',
      word: 'sph',
    });
    const empty = `${HEAD}binding:\n  T1:\n    `;
    expect(cursorPlace(empty, empty.length)).toMatchObject({
      path: ['binding', 'T1'],
      at: 'key',
      word: '',
    });
    expect(cursorPlace(HEAD, HEAD.length)).toMatchObject({ path: [], at: 'key' });
  });

  it('finds and rewrites a scalar, keeping everything else as written', () => {
    const text = `# a comment\n${HEAD}problem: {ref: isa/problems/fleet@2, compilation: sha256-abc}\n`;
    expect(scalarAt(text, ['version'])?.value).toBe('1.0.0');
    expect(scalarAt(text, ['syntaxVersion'])?.value).toBe('1.0');
    expect(scalarAt(text, ['problem', 'ref'])?.value).toBe('isa/problems/fleet@2');
    expect(scalarAt(text, ['missing'])).toBeNull();
    expect(withTopLevelScalar(text, 'version', '1.1.0')).toBe(
      text.replace('version: 1.0.0', 'version: 1.1.0')
    );
    expect(withTopLevelScalar('kind: system\n', 'version', '2.0.0')).toBe(
      'version: 2.0.0\nkind: system\n'
    );
  });
});

describe('completion from the schema', () => {
  it('offers the document’s keys at the top and the keys of nested mappings', () => {
    expect(schemaKeys(SCHEMA, [])).toEqual([
      'syntaxVersion',
      'composition',
      'version',
      'kind',
      'problem',
      'workflow',
      'binding',
      'values',
      'offering',
      'evidence',
    ]);
    expect(at(`${HEAD}|`)?.labels).toContain('binding');
    expect(at(`${HEAD}|`)?.apply).toContain('binding: ');
    expect(at(`${HEAD}binding:\n  notify:\n    |`)?.labels).toEqual(['candidate', 'from', 'local']);
    expect(at(`${HEAD}binding:\n  notify: {candidate: x, from: {|`)?.labels).toEqual([
      'sphere',
      'registry',
      'version',
      'plan',
      'addons',
    ]);
    expect(at(`${HEAD}values:\n  cost:\n    u|`)).toEqual({
      from: expect.any(Number),
      labels: ['value', 'unit'],
      apply: ['value: ', 'unit: '],
    });
    expect(at(`${HEAD}offering:\n  |`)?.labels).toEqual(['sphere', 'registry', 'url']);
    expect(at(`${HEAD}problem:\n  |`)?.labels).toEqual(['ref', 'compilation']);
  });

  it('offers the fixed values the schema allows', () => {
    expect(at('kind: |')?.labels).toEqual(['application', 'workflow', 'pipeline', 'system']);
    expect(at('syntaxVersion: |')?.labels).toEqual(['"1.0"']);
    expect(schemaValues(SCHEMA, ['binding', 'signIn', 'local'])).toEqual(['true']);
    expect(at(`${HEAD}evidence:\n  evaluatedBy: |`)?.labels).toEqual(['gateway', 'declared']);
  });

  it('starts the replaced word where the word being written starts', () => {
    const found = at(`${HEAD}kind: work|`);
    expect(found?.from).toBe(HEAD.length + 'kind: '.length);
  });

  it('without facts offers keys only: no task ids, candidates or features', () => {
    expect(at(`${HEAD}binding:\n  |`)).toBeNull();
    expect(at(`${HEAD}binding:\n  T1: {candidate: |`)).toBeNull();
    expect(at(`${HEAD}values:\n  |`)).toBeNull();
  });
});

describe('completion from the facts of the linked problem', () => {
  it('offers the task ids as binding keys and the features as value keys', () => {
    expect(at(`${HEAD}binding:\n  |`, FACTS)?.labels).toEqual([
      'T1',
      'T2',
      'T3',
      'node_classic_routing',
      'T5',
      'T6',
    ]);
    expect(at(`${HEAD}values:\n  |`, FACTS)?.labels).toEqual([
      'cost',
      'execution_time',
      'availability',
      'reliability',
      'security',
    ]);
  });

  it('offers each task its own eligible candidates, as the problem writes them', () => {
    expect(at(`${HEAD}binding:\n  T1:\n    candidate: |`, FACTS)?.labels).toEqual([
      'cand_t1_aws',
      'cand_t1_google_cloud',
    ]);
    expect(at(`${HEAD}binding:\n  T6: {candidate: cand_|}`, FACTS)?.labels).toEqual([
      'cand_t6_paypal',
      'cand_t6_stripe',
    ]);
    expect(at(`${HEAD}binding:\n  nope:\n    candidate: |`, FACTS)).toBeNull();
  });

  it('offers a value the unit the problem writes for its feature', () => {
    expect(at(`${HEAD}values:\n  cost: {value: 12, unit: |}`, FACTS)?.labels).toEqual([
      'USD/month',
    ]);
    expect(at(`${HEAD}values:\n  execution_time:\n    unit: |`, FACTS)?.labels).toEqual(['ms']);
  });
});
