import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { ProposalStepView, ProposalView } from '../../api/types';
import pending from '../../../../test/fixtures/core/zproposals.pending.json';
import completed from '../../../../test/fixtures/core/zproposals.completed.json';
import partial from '../../../../test/fixtures/core/zproposals.partial.json';
import superseded from '../../../../test/fixtures/core/zproposals.superseded.json';
import { ProposalCard, type ProposalCardProps } from '.';
import { normalisePhrase } from './phrase';

const draw = (proposal: unknown, props: Partial<ProposalCardProps> = {}) =>
  render(
    <MemoryRouter>
      <ProposalCard proposal={proposal as ProposalView} {...props} />
    </MemoryRouter>
  );

const card = () => screen.getByRole('group', { name: /^Proposal:/ });

describe('the proposal card', () => {
  it.each([
    [pending, 'Waiting for your confirmation'],
    [completed, 'Applied'],
    [partial, 'Partly applied'],
    [superseded, 'Replaced by a newer proposal'],
    [{ ...pending, status: 'stale' }, 'Out of date'],
    [{ ...pending, status: 'cancelled' }, 'Cancelled'],
    [{ ...pending, status: 'failed' }, 'Not applied'],
    [{ ...pending, status: 'executing' }, 'Applying…'],
  ])('says its status in SPHERE’s words (%#)', (proposal, label) => {
    draw(proposal);
    expect(card()).toHaveTextContent(label);
    expect(card()).toHaveTextContent('From the web');
    expect(card()).toHaveTextContent((proposal as ProposalView).summary);
  });

  it('lets its author confirm or cancel a pending proposal, with each step and its base', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    draw(pending, { onConfirm, onCancel });
    const steps = within(card()).getByRole('list', { name: 'Steps' });
    expect(within(steps).getAllByRole('listitem')).toHaveLength(2);
    expect(steps).toHaveTextContent('Seal 1.2.0 from tomatometer-email@5');
    expect(steps).toHaveTextContent(
      'Built on the composition’s latest version as it was, and on the exact document shown.'
    );
    // The adopt step takes the version the seal step makes: decided then, never shown as a value.
    expect(steps).toHaveTextContent('The version is decided when step 1 has run.');
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and apply' }));
    expect(onConfirm).toHaveBeenCalledWith(pending, undefined);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledWith(pending);
  });

  it('draws the gateway’s diff through the renderer it is given, and the stored document', () => {
    const renderDiff = vi.fn(() => <p>the diff</p>);
    const renderDocument = (document: string) => (
      <div aria-label="The document step 1 seals">{document}</div>
    );
    draw(pending, { renderDiff, renderDocument });
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Compare with the version in effect in Production (1.0.0)',
      })
    );
    expect(screen.getByText('the diff')).toBeInTheDocument();
    expect(renderDiff).toHaveBeenCalledWith(
      pending.steps[0].preview?.diff,
      expect.objectContaining({ ordinal: 1 })
    );
    fireEvent.click(screen.getByRole('button', { name: 'Show the document' }));
    expect(screen.getByLabelText('The document step 1 seals')).toHaveTextContent(
      'composition: tomatometer'
    );
  });

  it('offers no comparison for a step whose input an earlier step decides', () => {
    const decided: ProposalStepView = {
      ...(pending.steps[0] as unknown as ProposalStepView),
      preview: null,
      deferred: ['revisionId', 'contentDigest'],
      dependsOn: [1],
      ordinal: 2,
    };
    draw({ ...pending, steps: [pending.steps[0], decided] });
    const second = within(card()).getAllByRole('listitem')[1];
    expect(second).toHaveTextContent('decided when step 1 has run');
    expect(within(second).queryByRole('button', { name: /Compare/ })).toBeNull();
  });

  it('reports a partial proposal step by step: done, then failed with the gateway’s refusal', () => {
    draw(partial, {
      resultLink: step =>
        step.kind === 'seal_derived' ? { label: 'Compare 1.3.0', to: '/v' } : null,
    });
    expect(card()).toHaveTextContent('1 of 2 steps done · 1 failed');
    expect(card()).toHaveTextContent('What is done stays done; nothing else was changed.');
    fireEvent.click(screen.getByRole('button', { name: '2 steps' }));
    expect(screen.getByRole('link', { name: 'Compare 1.3.0' })).toHaveAttribute('href', '/v');
    expect(card()).toHaveTextContent(
      'The resource changed since it was read; fetch it again and retry. (412)'
    );
    expect(screen.getByLabelText('Failed')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Confirm and apply' })).toBeNull();
  });

  it('shows the running step while the proposal is applied', () => {
    draw({ ...pending, status: 'executing' }, { runningStep: 1 });
    expect(card()).toHaveTextContent('Step 1 of 2');
    expect(screen.getByLabelText('Running')).toBeInTheDocument();
  });

  it('waits for the typed phrase of a destructive step, as SPHERE normalises it', () => {
    const onConfirm = vi.fn();
    const destructive = {
      ...superseded,
      status: 'pending',
      confirmationPhrase: 'Order Desk',
      steps: [{ ...superseded.steps[0], destructive: true }],
    };
    draw(destructive, { onConfirm });
    const button = screen.getByRole('button', { name: 'Delete permanently' });
    expect(button).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '  order   desk ' } });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ id: superseded.id }),
      '  order   desk '
    );
    expect(normalisePhrase('  Order\tDESK ')).toBe('order desk');
  });

  it('offers nothing to a member who did not make it', () => {
    draw({ ...pending, mine: false }, { onConfirm: vi.fn(), onCancel: vi.fn() });
    expect(screen.queryByRole('button', { name: 'Confirm and apply' })).toBeNull();
    expect(card()).toHaveTextContent('Only fixture-author can confirm or cancel it.');
  });
});
