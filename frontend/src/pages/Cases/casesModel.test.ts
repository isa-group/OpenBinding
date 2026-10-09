import { describe, expect, it } from 'vitest';
import { readBindingProblem } from './bindingModel';
import {
  aliasFrom, changesBetween, describeChange, diffRevisions, diffSummary, exactReference, newestFirst, refLabel, resourceUses, sizeChange, type RevisionView,
} from './casesModel';
import { irDocument, refOf, revisionDocument } from './fixtures';

const app3 = refOf('checkout-app', '3', '1');
const catalog2 = refOf('providers-eu', '2', '2');
const catalog3 = refOf('providers-eu', '3', '3');
const rules1 = refOf('sla-hard', '1', '4');
const goal1 = refOf('weighted-cost-latency', '1', '5');

const doc = (catalog = catalog3) => revisionDocument([['optimization', 'goal', goal1], ['candidateCatalog', 'providers', catalog], ['application', 'checkout', app3], ['constraintSet', 'sla', rules1]]);

describe('resourceUses', () => {
  it('lists the library versions a revision names in the order of the four parts', () => {
    expect(resourceUses(doc()).map((use) => `${use.role}/${use.alias}`)).toEqual(['application/checkout', 'candidateCatalog/providers', 'constraintSet/sla', 'optimization/goal']);
  });

  it('skips what is not an exact reference', () => {
    expect(resourceUses({ spec: { resources: { application: { app: 'app.json' }, other: 3 } } })).toEqual([]);
    expect(resourceUses({})).toEqual([]);
    expect(resourceUses(undefined)).toEqual([]);
  });
});

describe('labels', () => {
  it('writes a reference, a citation and a name for a library item', () => {
    expect(refLabel(catalog3)).toBe('providers-eu v3');
    expect(refLabel({ name: 'x', version: 'beta' })).toBe('x beta');
    expect(exactReference('checkout-flow', { revision: 2, digest: 'sha256-ab' })).toBe('checkout-flow@2 sha256-ab');
    expect(aliasFrom('Proveedores UE')).toBe('Proveedores-UE');
    expect(aliasFrom('---')).toBe('part');
  });

  it('orders revisions newest first without touching the original', () => {
    const list = [{ revision: 1 }, { revision: 3 }, { revision: 2 }] as unknown as Parameters<typeof newestFirst>[0];
    expect(newestFirst(list).map((item) => item.revision)).toEqual([3, 2, 1]);
    expect(list.map((item) => item.revision)).toEqual([1, 3, 2]);
  });
});

describe('changesBetween', () => {
  it('names what moved to another version, what was added and what was removed', () => {
    const before = resourceUses(doc(catalog2));
    const after = resourceUses(revisionDocument([['application', 'checkout', app3], ['candidateCatalog', 'providers', catalog3], ['optimization', 'goal', refOf('other-goal', '1', '6')]]));
    expect(changesBetween(before, after).map(describeChange)).toEqual([
      'Candidate catalog · providers: providers-eu v2 → providers-eu v3',
      'Goal · goal: weighted-cost-latency v1 → other-goal v1',
      'Rules · sla removed (was sla-hard v1)',
    ]);
  });

  it('finds nothing when the versions are the same', () => {
    expect(changesBetween(resourceUses(doc()), resourceUses(doc()))).toEqual([]);
  });
});

describe('diffRevisions', () => {
  const view = (revision: number, catalog: typeof catalog3, pay: number): RevisionView => ({
    revision, uses: resourceUses(doc(catalog)), model: readBindingProblem(irDocument(pay)),
  });
  const from = view(1, catalog2, 5);
  const to = view(2, catalog3, 8);
  const rows = diffRevisions(from, to);

  it('marks the resources that changed and the ones that did not', () => {
    const resources = rows.filter((row) => row.category === 'Resources');
    expect(resources.find((row) => row.what === 'Candidate catalog · providers')).toMatchObject({ a: expect.stringContaining('providers-eu v2'), b: expect.stringContaining('providers-eu v3'), changed: true });
    expect(resources.find((row) => row.what === 'Rules · sla')?.changed).toBe(false);
  });

  it('compares the providers of each task', () => {
    expect(rows.find((row) => row.what === 'Candidates for pay-card')).toMatchObject({ category: 'Providers', a: '5', b: '8', changed: true });
    expect(rows.find((row) => row.what === 'Candidates for inventory')).toMatchObject({ a: '5', b: '5', changed: false });
    expect(rows.find((row) => row.what === 'Providers in total')?.changed).toBe(true);
  });

  it('compares tasks, rules and goal', () => {
    expect(rows.find((row) => row.what === 'Workflow')?.changed).toBe(false);
    expect(rows.find((row) => row.what === 'sla-latency')).toMatchObject({ category: 'Rules', changed: false });
    expect(rows.find((row) => row.what === 'cost')).toMatchObject({ category: 'Goal', a: 'minimize cost', changed: false });
    expect(rows.find((row) => row.what === 'Penalty for breaking sla-availability')?.changed).toBe(false);
  });

  it('compares only the library versions when a compiled form is missing', () => {
    const partial = diffRevisions({ ...from, model: null }, to);
    expect([...new Set(partial.map((row) => row.category))]).toEqual(['Resources']);
  });

  it('summarizes the change in one line', () => {
    const line = diffSummary('checkout-flow', from, to, rows);
    expect(line).toContain('checkout-flow r1 → r2:');
    expect(line).toContain('Candidates for pay-card 5 → 8');
    expect(line).toContain('combinations 10^');
    expect(diffSummary('c', from, from, diffRevisions(from, from))).toContain('no changes');
  });
});

describe('sizeChange', () => {
  it('says how many times bigger or smaller the second problem is', () => {
    expect(sizeChange(4.2, 5.1)).toEqual({ text: '≈ 7.9× more combinations (10^0.9)', grew: true });
    expect(sizeChange(5.1, 4.2)).toEqual({ text: '≈ 7.9× fewer combinations (10^0.9)', grew: false });
    expect(sizeChange(3, 3.01)?.text).toBe('About the same number of combinations');
    expect(sizeChange(null, 3)).toBeNull();
  });
});
