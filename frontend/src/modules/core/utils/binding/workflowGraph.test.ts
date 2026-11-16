import { describe, expect, it } from 'vitest';
import jsonComplete from '../../../../test/fixtures/core/json-complete.facts.json';
import { blockLabel, workflowGraph, type WNode } from './workflowGraph';

const task = (id: string): WNode => ({ kind: 'task', id });

describe('workflowGraph', () => {
  it('reads a task, the null leaf as empty, a sequence and a parallel block', () => {
    expect(workflowGraph('pick').root).toEqual(task('pick'));
    expect(workflowGraph(null).root).toEqual({ kind: 'empty' });
    expect(workflowGraph({ seq: ['a', { and: ['b', 'c'] }] }).root).toEqual({
      kind: 'seq',
      children: [task('a'), { kind: 'and', children: [task('b'), task('c')] }],
    });
  });

  it('flattens a nested sequence', () => {
    expect(workflowGraph({ seq: ['a', { seq: ['b', { seq: ['c'] }] }, 'd'] }).root).toEqual({
      kind: 'seq',
      children: [task('a'), task('b'), task('c'), task('d')],
    });
  });

  it('reads a choice with probabilities, with uniform branches, and with neither', () => {
    expect(
      workflowGraph({
        xor: [
          { probability: 0.7, flow: 'card' },
          { probability: 0.3, flow: null },
        ],
      }).root
    ).toEqual({
      kind: 'xor',
      uniform: false,
      branches: [
        { probability: 0.7, node: task('card') },
        { probability: 0.3, node: { kind: 'empty' } },
      ],
    });
    expect(workflowGraph({ xor: ['a', 'b', 'c'], uniform: true }).root).toEqual({
      kind: 'xor',
      uniform: true,
      branches: ['a', 'b', 'c'].map(id => ({ probability: null, node: task(id) })),
    });
    expect(workflowGraph({ xor: ['a', { seq: ['b', 'c'] }] }).root).toMatchObject({
      uniform: false,
      branches: [{ probability: null }, { node: { kind: 'seq' } }],
    });
  });

  it('reads a loop with a count and one with an expected number of times', () => {
    expect(workflowGraph({ loop: 'notify', count: 2 }).root).toEqual({
      kind: 'loop',
      body: task('notify'),
      count: 2,
      expected: null,
    });
    expect(workflowGraph({ loop: 'retry', expected: 2.5 }).root).toEqual({
      kind: 'loop',
      body: task('retry'),
      count: null,
      expected: 2.5,
    });
  });

  it('keeps an unknown shape as unreadable, never dropping it', () => {
    const graph = workflowGraph({ seq: ['a', { fork: ['b'] }, 7, ''] });
    expect(graph.root).toEqual({
      kind: 'seq',
      children: [
        task('a'),
        { kind: 'unreadable', reason: 'an unknown step with fork' },
        { kind: 'unreadable', reason: 'a number where a step was expected' },
        { kind: 'unreadable', reason: 'a task without an id' },
      ],
    });
    expect(workflowGraph({ seq: ['a'], and: ['b'] }).root.kind).toBe('unreadable');
    expect(workflowGraph(undefined).root).toEqual({ kind: 'unreadable', reason: 'a missing step' });
  });

  it('lists each task once, in depth-first order', () => {
    expect(
      workflowGraph({ xor: [{ seq: ['pick', 'courier'] }, { seq: ['pick', 'post'] }] }).tasks
    ).toEqual(['pick', 'courier', 'post']);
    expect(workflowGraph(jsonComplete.workflow).tasks).toEqual(
      jsonComplete.tasks.map(entry => entry.id)
    );
  });

  it('describes the workflow in words for assistive technology', () => {
    expect(
      workflowGraph({
        seq: [
          'authenticate',
          { and: ['inventory', 'shipping'] },
          {
            xor: [
              { probability: 0.7, flow: 'pay-card' },
              { probability: 0.3, flow: 'pay-transfer' },
            ],
          },
          { loop: 'notify', count: 2 },
        ],
      }).description
    ).toBe(
      'Workflow: authenticate, then (inventory and shipping in parallel), then (one of pay-card (probability 0.7) or pay-transfer (probability 0.3)), then notify repeated 2 times'
    );
    expect(workflowGraph({ xor: ['a', 'b'], uniform: true }).description).toBe(
      'Workflow: one of a or b, equally likely'
    );
    expect(workflowGraph({ loop: 'retry', expected: 2.5 }).description).toBe(
      'Workflow: retry repeated about 2.5 times'
    );
    expect(workflowGraph({ fork: [] }).description).toBe(
      'Workflow: a step that can’t be read (an unknown step with fork)'
    );
  });

  it('names each block for its group', () => {
    expect(blockLabel(workflowGraph({ and: ['a', 'b'] }).root)).toBe('Parallel, 2 branches');
    expect(
      blockLabel(
        workflowGraph({
          xor: [
            { probability: 0.5, flow: 'a' },
            { probability: 0.3, flow: 'b' },
            { probability: 0.2, flow: 'c' },
          ],
        }).root
      )
    ).toBe('Choice, 3 branches, probabilities 0.5, 0.3, 0.2');
    expect(blockLabel(workflowGraph({ xor: ['a', 'b'], uniform: true }).root)).toBe(
      'Choice, 2 branches, equally likely'
    );
    expect(blockLabel(workflowGraph({ loop: 'a', expected: 2.5 }).root)).toBe(
      'Repeat, expected 2.5 times'
    );
    expect(blockLabel(workflowGraph({ loop: 'a', count: 3 }).root)).toBe('Repeat, 3 times');
  });
});
