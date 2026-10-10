import { describe, expect, it } from 'vitest';
import { describeExpression, describeFlow, flowText, irHasRanges, powerText, rangeCandidates, readBindingProblem, rulesText, tasksOfFlow } from './bindingModel';
import { irDocument } from './fixtures';

describe('features that are ranges', () => {
  const model = readBindingProblem(irDocument())!;
  const features = (task: string, id: string) => model.tasks.find((item) => item.id === task)?.candidates.find((candidate) => candidate.id === id)?.features;

  it('reads a number, a closed range, an open one and one with no information', () => {
    expect(features('authenticate', 'authenticate-1')).toEqual({ latency: 40, cost: { min: 0.01, max: 0.02 } });
    expect(features('authenticate', 'authenticate-3')).toEqual({ latency: { min: 100, max: null }, cost: { min: null, max: 0.05 } });
    expect(features('authenticate', 'authenticate-4')).toEqual({ latency: { min: null, max: null }, cost: 0.04 });
  });

  it('leaves out what is not a number or a well-formed range, never turning it into a number', () => {
    const document = irDocument() as { spec: { candidates: { providers: { candidates: Record<string, { features: Record<string, unknown> }> } } } };
    document.spec.candidates.providers.candidates['authenticate-1'].features = {
      a: 1, b: { min: 1 }, c: { min: '1', max: 2 }, d: { min: 1, max: 2, mid: 1 }, e: null, f: 'x', g: { min: Infinity, max: 1 },
    };
    expect(readBindingProblem(document)!.tasks[0].candidates[0].features).toEqual({ a: 1 });
  });

  it('lists the candidates that carry a range and which of their qualities are one', () => {
    expect(rangeCandidates(model)).toEqual([
      { task: 'authenticate', candidate: 'authenticate-1', features: [{ name: 'cost', value: { min: 0.01, max: 0.02 } }] },
      { task: 'authenticate', candidate: 'authenticate-2', features: [{ name: 'cost', value: { min: 0.02, max: 0.04 } }] },
      { task: 'authenticate', candidate: 'authenticate-3', features: [{ name: 'latency', value: { min: 100, max: null } }, { name: 'cost', value: { min: null, max: 0.05 } }] },
      { task: 'authenticate', candidate: 'authenticate-4', features: [{ name: 'latency', value: { min: null, max: null } }] },
      ...model.tasks.filter((task) => task.id !== 'authenticate').flatMap((task) => task.candidates.map((candidate) => ({
        task: task.id, candidate: candidate.id, features: [{ name: 'cost', value: candidate.features.cost }],
      }))),
    ]);
  });

  it('tells whether any slot of any catalog holds a range, even a candidate no task can pick', () => {
    expect(irHasRanges(irDocument())).toBe(true);
    const plain = irDocument() as { spec: { candidates: { providers: { candidates: Record<string, { features: Record<string, unknown> }> } } } };
    for (const candidate of Object.values(plain.spec.candidates.providers.candidates)) candidate.features = { latency: 10 };
    expect(irHasRanges(plain)).toBe(false);
    plain.spec.candidates.providers.candidates.unused = { features: { latency: { min: null, max: 5 } } };
    expect(irHasRanges(plain)).toBe(true);
    expect(irHasRanges(null)).toBe(false);
    expect(irHasRanges({ spec: {} })).toBe(false);
  });
});

describe('describeExpression', () => {
  it('writes comparisons, paths and calls as short formulas', () => {
    expect(describeExpression({
      kind: 'compare', op: 'lte', left: { kind: 'path', segments: ['features', 'latency'] }, right: { kind: 'literal', value: 600 },
    })).toBe('features.latency ≤ 600');
    expect(describeExpression({
      kind: 'and',
      left: { kind: 'compare', op: 'gte', left: { kind: 'path', segments: ['a'] }, right: { kind: 'literal', value: 1 } },
      right: { kind: 'not', value: { kind: 'literal', value: false } },
    })).toBe('(a ≥ 1) and not false');
    expect(describeExpression({ kind: 'call', name: 'max', args: [{ kind: 'literal', value: 1 }, { kind: 'literal', value: 'x' }] })).toBe('max(1, “x”)');
  });

  it('keeps going when the expression is malformed', () => {
    expect(describeExpression(null)).toBe('…');
    expect(describeExpression({ kind: 'mystery' })).toBe('…');
  });
});

describe('readBindingProblem', () => {
  const model = readBindingProblem(irDocument())!;

  it('reads the profile, the dialects and the adapters the compiled form names', () => {
    expect(model.profile).toBe('qos-binding/v1');
    expect(model.dialects.map((dialect) => dialect.label)).toEqual(['qos-dialect/v1']);
    expect(model.adapters).toEqual(['qos-adapter@1.0.0']);
  });

  it('reads the tasks and who can serve them', () => {
    expect(model.tasks.map((task) => task.id)).toEqual(['authenticate', 'inventory', 'shipping', 'pay-card', 'pay-transfer', 'notify']);
    expect(model.serviceTasks).toBe(5);
    expect(model.tasks.find((task) => task.id === 'pay-card')?.candidates).toHaveLength(8);
    expect(model.tasks.find((task) => task.id === 'pay-transfer')?.candidates).toHaveLength(4);
    expect(model.tasks.find((task) => task.id === 'notify')).toMatchObject({ kind: 'local', capability: null, candidates: [] });
    expect(model.candidateCount).toBe(4 + 5 + 3 + 8 + 4);
  });

  it('bounds the binding space by the product of the candidate counts', () => {
    expect(model.log10).toBeCloseTo(Math.log10(4 * 5 * 3 * 8 * 4), 6);
    expect(powerText(model.log10)).toBe('10^3.3');
    expect(powerText(null)).toBe('—');
  });

  it('draws the workflow with its probabilities', () => {
    expect(flowText(model.flow)).toBe('authenticate → (inventory ∥ shipping) → [pay-card 70% | pay-transfer 30%] → notify');
    expect(describeFlow(model.flow)).toBe('Workflow: authenticate, then inventory and shipping in parallel, then pay-card (70%) or pay-transfer (30%), then notify');
    expect(tasksOfFlow(model.flow).map((task) => task.id)).toEqual(['authenticate', 'inventory', 'shipping', 'pay-card', 'pay-transfer', 'notify']);
  });

  it('reads the rules as must and should, and the goal with its penalty', () => {
    expect(model.rules).toEqual([
      { id: 'sla-latency', enforcement: 'hard', text: 'features.latency ≤ 600', when: null, penalty: null },
      { id: 'sla-availability', enforcement: 'soft', text: 'features.availability ≥ 99.9', when: null, penalty: '5' },
    ]);
    expect(rulesText(model.rules)).toBe('1 must, 1 should');
    expect(model.criteria.map((criterion) => [criterion.id, criterion.direction, criterion.range])).toEqual([
      ['cost', 'minimize', null], ['latency', 'minimize', { min: 0, max: 1000 }],
    ]);
    expect(model.penalties).toEqual([{ rule: 'sla-availability', weight: 5 }]);
  });

  it('says nothing about placement when none is declared', () => {
    expect(model.placement).toBeNull();
  });

  it('summarizes the placement when one is declared', () => {
    const document = irDocument() as { spec: Record<string, unknown> };
    document.spec.placement = [{
      resource: 'placement', pools: { edge: { ref: { resource: 'placement', id: 'edge' }, kind: 'node', capacity: { cpu: 8 }, properties: {} } },
      demands: [{}], network: [{}, {}], events: { e: {} }, transitions: [],
    }];
    const placed = readBindingProblem(document)!;
    expect(placed.placement).toEqual({ pools: [{ id: 'edge', kind: 'node', capacity: { cpu: 8 } }], demands: 1, links: 2, events: 1, transitions: 0 });
  });

  it('refuses a document that is not a binding problem', () => {
    expect(readBindingProblem({})).toBeNull();
    expect(readBindingProblem(null)).toBeNull();
    expect(readBindingProblem({ spec: { application: { tasks: {} } } })).toBeNull();
  });

  it('leaves the size unknown while a task has no candidate', () => {
    const document = irDocument() as { spec: { eligibility: Record<string, unknown[]> } };
    document.spec.eligibility.shipping = [];
    expect(readBindingProblem(document)!.log10).toBeNull();
  });
});
