import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { workflowGraph } from '../../utils/binding/workflowGraph';
import fms from '../../../../test/fixtures/core/fms.facts.json';
import { WorkflowGraph } from './WorkflowGraph';

const CHECKOUT = {
  seq: [
    'authenticate',
    { and: ['inventory', 'shipping'] },
    {
      xor: [
        { probability: 0.7, flow: 'pay-card' },
        { probability: 0.3, flow: 'pay-transfer' },
      ],
    },
    { xor: ['express', 'post'], uniform: true },
    { loop: 'notify', count: 2 },
    { loop: 'retry', expected: 2.5 },
  ],
};

describe('WorkflowGraph', () => {
  it('is a named group described by the workflow in words', () => {
    const graph = workflowGraph(CHECKOUT);
    render(<WorkflowGraph graph={graph} label="Workflow" />);
    const figure = screen.getByRole('group', { name: 'Workflow' });
    expect(figure).toHaveAccessibleDescription(graph.description);
    expect(within(figure).getByRole('list', { name: 'Sequence, 6 steps' })).toBeInTheDocument();
  });

  it('names each block by its kind, branches, probabilities and times', () => {
    render(<WorkflowGraph graph={workflowGraph(CHECKOUT)} label="Workflow" />);
    expect(screen.getByRole('group', { name: 'Parallel, 2 branches' })).toBeInTheDocument();
    const choice = screen.getByRole('group', {
      name: 'Choice, 2 branches, probabilities 0.7, 0.3',
    });
    expect(within(choice).getByText('0.7')).toBeInTheDocument();
    expect(
      within(screen.getByRole('group', { name: 'Choice, 2 branches, equally likely' })).getByText(
        'One of · equal'
      )
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole('group', { name: 'Repeat, 2 times' })).getByText('Repeat · 2 times')
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole('group', { name: 'Repeat, expected 2.5 times' })).getByText(
        'Repeat · about 2.5 times'
      )
    ).toBeInTheDocument();
  });

  it('names a task’s candidate and status in text, and a local task as not bound', () => {
    const graph = workflowGraph(fms.workflow);
    render(
      <WorkflowGraph
        graph={graph}
        label="Workflow"
        overlay={{
          T1: { candidate: 'cand_t1_aws', status: 'changed' },
          node_classic_routing: { local: true },
        }}
      />
    );
    const t1 = screen.getByText('T1').closest('[data-wg-task]') as HTMLElement;
    expect(t1).toHaveTextContent('candidate cand_t1_aws');
    expect(t1).toHaveTextContent('changed');
    expect(screen.getByText('node_classic_routing').closest('[data-wg-task]')).toHaveTextContent(
      'local task · not bound'
    );
    expect(screen.getByText('Local task')).toBeInTheDocument();
  });

  it('makes each task a button when a task can be chosen', () => {
    const choose = vi.fn();
    render(
      <WorkflowGraph
        graph={workflowGraph({ seq: ['a', 'b'] })}
        label="Workflow"
        onSelectTask={choose}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /^b/ }));
    expect(choose).toHaveBeenCalledWith('b');
  });

  it('says so when a step cannot be drawn', () => {
    render(
      <WorkflowGraph graph={workflowGraph({ seq: ['a', { fork: ['b'] }] })} label="Workflow" />
    );
    expect(screen.getByRole('note')).toHaveTextContent(
      'This step can’t be drawn: an unknown step with fork.'
    );
  });

  it('stacks vertically when asked to', () => {
    render(<WorkflowGraph graph={workflowGraph('a')} label="Workflow" orientation="vertical" />);
    expect(screen.getByRole('group', { name: 'Workflow' })).toHaveAttribute(
      'data-orientation',
      'vertical'
    );
  });
});
