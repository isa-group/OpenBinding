import { describe, expect, it } from 'vitest';
import { diffRevisions, diffSummary, exactReference, newestFirst, powerText, type RevisionView } from './casesModel';
import { checkoutFacts } from './fixtures';

describe('labels', () => {
  it('writes the exact reference of a version: problem, number and package digest', () => {
    expect(exactReference('checkout-flow', { revision: 2, package_digest: 'sha256-ab' })).toBe('checkout-flow@2 sha256-ab');
  });

  it('orders revisions newest first without touching the original', () => {
    const list = [{ revision: 1 }, { revision: 3 }, { revision: 2 }] as unknown as Parameters<typeof newestFirst>[0];
    expect(newestFirst(list).map((item) => item.revision)).toEqual([3, 2, 1]);
    expect(list.map((item) => item.revision)).toEqual([1, 3, 2]);
  });
});

describe('diffRevisions', () => {
  const view = (revision: number, pay: number): RevisionView => ({
    revision, digest: `sha256-${String(revision).repeat(64)}`, facts: checkoutFacts(pay),
  });
  const from = view(1, 5);
  const to = view(2, 8);
  const rows = diffRevisions(from, to);

  it('shows no digest in the rows', () => {
    expect(JSON.stringify(rows)).not.toMatch(/sha256-/);
  });

  it('compares the providers of each task', () => {
    expect(rows.find((row) => row.what === 'Candidates for pay-card')).toMatchObject({ category: 'Providers', a: '5', b: '8', changed: true });
    expect(rows.find((row) => row.what === 'Candidates for inventory')).toMatchObject({ a: '5', b: '5', changed: false });
    expect(rows.find((row) => row.what === 'Providers in total')?.changed).toBe(true);
  });

  it('compares tasks, rules and goal', () => {
    expect(rows.find((row) => row.what === 'Workflow')?.changed).toBe(false);
    expect(rows.find((row) => row.what === 'rules/sla-latency')).toMatchObject({ category: 'Rules', a: 'Must: features.latency ≤ 600', changed: false });
    expect(rows.find((row) => row.what === 'cost')).toMatchObject({ category: 'Goal', a: 'minimize cost', changed: false });
    expect(rows.find((row) => row.what === 'Penalty for breaking sla-availability')?.changed).toBe(false);
  });

  describe('qualities that are numbers or ranges', () => {
    const edited = (changes: Array<[string, string, unknown]>): RevisionView => {
      const facts = checkoutFacts(8);
      for (const [id, name, value] of changes) {
        const candidate = facts.candidates.find((entry) => entry.id === id);
        if (candidate) candidate.values = { ...candidate.values, [name]: value as number };
      }
      return { revision: 2, digest: 'sha256-2', facts };
    };
    const base = view(1, 8);
    const feature = (changes: Array<[string, string, unknown]>, what: string) => diffRevisions(base, edited(changes)).find((row) => row.what === what);

    it('shows a number that became a range, before and after', () => {
      expect(feature([['authenticate-1', 'latency', { min: null, max: 60 }]], 'authenticate-1 · latency (now a range)')).toMatchObject({
        category: 'Providers', a: '40 ms', b: '≤ 60 ms', changed: true,
      });
      expect(feature([['authenticate-2', 'latency', { min: 70, max: null }]], 'authenticate-2 · latency (now a range)')).toMatchObject({ a: '80 ms', b: '≥ 70 ms' });
    });

    it('shows a range that became a number, and one that moved', () => {
      expect(feature([['authenticate-3', 'latency', 90]], 'authenticate-3 · latency (now a single value)')).toMatchObject({ a: '≥ 100 ms', b: '90 ms' });
      expect(feature([['authenticate-1', 'cost', { min: 0.01, max: 0.03 }]], 'authenticate-1 · cost (range changed)')).toMatchObject({ a: '0.01–0.02 EUR', b: '0.01–0.03 EUR' });
      expect(feature([['authenticate-4', 'latency', { min: null, max: 500 }]], 'authenticate-4 · latency (range changed)')).toMatchObject({ a: 'unbounded', b: '≤ 500 ms' });
    });

    it('shows a number that changed as a number', () => {
      expect(feature([['authenticate-1', 'latency', 55]], 'authenticate-1 · latency')).toMatchObject({ a: '40 ms', b: '55 ms', changed: true });
    });

    it('says nothing about a quality that did not change, and names a change in the summary', () => {
      const changes: Array<[string, string, unknown]> = [['authenticate-1', 'latency', { min: null, max: 60 }]];
      const rows = diffRevisions(base, edited(changes));
      expect(rows.filter((row) => / · (latency|cost)/.test(row.what))).toHaveLength(1);
      expect(diffSummary('c', base, edited(changes), rows)).toContain('authenticate-1 · latency (now a range) 40 ms → ≤ 60 ms');
    });
  });

  it('compares nothing when a compiled form is missing', () => {
    expect(diffRevisions({ ...from, facts: null }, to)).toEqual([]);
  });

  it('summarizes the change in one line', () => {
    const line = diffSummary('checkout-flow', from, to, rows);
    expect(line).toContain('checkout-flow v1 → v2:');
    expect(line).toContain('Candidates for pay-card 5 → 8');
    expect(line).toContain('combinations 10^2.8 → 10^3.3');
    expect(diffSummary('c', from, from, diffRevisions(from, from))).toContain('no changes');
  });
});

describe('the workflow row', () => {
  it('compares the workflows the gateway wrote and shows them in words', () => {
    const left = checkoutFacts(8);
    const right = checkoutFacts(8);
    right.workflow = { seq: ['authenticate', { and: ['inventory', 'shipping'] }, 'pay-card', 'notify'] };
    const row = diffRevisions({ revision: 1, digest: 'a', facts: left }, { revision: 2, digest: 'b', facts: right }).find((entry) => entry.what === 'Workflow');
    expect(row).toMatchObject({ changed: true, b: 'authenticate, then (inventory and shipping in parallel), then pay-card, then notify' });
    expect(row?.a).toContain('one of pay-card (probability 0.7) or pay-transfer (probability 0.3)');
  });
});

describe('powerText', () => {
  it('writes a binding-space size as a power of ten', () => {
    expect(powerText('1920')).toBe('10^3.3');
    expect(powerText('1')).toBe('10^0');
    expect(powerText(null)).toBe('—');
  });
});
