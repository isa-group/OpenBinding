import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { compositionViewModel, type Reader } from '../../../utils/composition/viewModel';
import type { CompositionVersionView, CompositionView, ProblemFacts } from '../../../api/types';
import fmsFacts from '../../../../../test/fixtures/core/fms.facts.json';
import fmsVersion from '../../../../../test/fixtures/core/fms.version.json';
import { CompositionRenderer } from '../CompositionRenderer';

const composition = {
  id: 'composition-fms',
  slug: 'fms',
  name: 'Fleet management',
  description: '',
  kind: 'application',
  archived: false,
  visibility: 'private',
  organization: { id: 'org-isa-demo', slug: 'isa-demo', name: 'ISA demo' },
  created_by_id: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  version_count: 1,
} as CompositionView;

const facts = fmsFacts as ProblemFacts;

function renderWorkflow(
  options: { reader?: Reader; facts?: ProblemFacts; version?: CompositionVersionView | null } = {}
) {
  const version =
    options.version === undefined
      ? (structuredClone(fmsVersion) as CompositionVersionView)
      : options.version;
  const model = compositionViewModel({
    composition,
    version,
    facts: options.facts,
    reader: options.reader ?? 'member',
  });
  return render(<CompositionRenderer model={model} mode="workflow" />);
}

const section = (name: string) => screen.getByRole('region', { name });
const taskBox = (id: string) =>
  within(section('Workflow'))
    .getByText(id, { selector: 'code' })
    .closest('.wg-task') as HTMLElement;

describe('the workflow mode', () => {
  it('draws the workflow with the candidate of each task and the local task as not bound', () => {
    renderWorkflow();
    const drawing = within(section('Workflow')).getByRole('group', {
      name: 'The workflow of Fleet management',
    });
    expect(within(drawing).getByRole('list', { name: 'Sequence, 5 steps' })).toBeInTheDocument();
    expect(
      within(drawing).getByRole('group', { name: 'Choice, 2 branches, probabilities 0.8, 0.2' })
    ).toBeInTheDocument();
    expect(taskBox('T1')).toHaveTextContent('candidate cand_t1_aws');
    expect(taskBox('T5')).toHaveTextContent('candidate cand_t5_amazon_braket');
    expect(taskBox('node_classic_routing')).toHaveTextContent('local task · not bound');
  });

  it('shows the problem’s candidates to a member, with the candidate the evaluation used selected', () => {
    renderWorkflow({ facts });
    const candidates = section('Problem candidates');
    const t1 = within(candidates).getByRole('region', { name: 'Candidates for T1' });
    const chosen = within(t1).getByRole('row', { name: /^cand_t1_aws/ });
    expect(chosen).toHaveAttribute('aria-current', 'true');
    expect(within(chosen).getByText('Selected')).toBeInTheDocument();
    expect(within(t1).getByRole('row', { name: /^cand_t1_google_cloud/ })).not.toHaveAttribute(
      'aria-current'
    );
    expect(
      within(candidates).getByText('is a local task: it gets no candidate.', { exact: false })
    ).toBeInTheDocument();
    // View mode: nothing to choose.
    expect(within(candidates).queryByRole('radio')).toBeNull();
  });

  it('shows no candidates without the facts', () => {
    renderWorkflow();
    expect(screen.queryByRole('region', { name: 'Problem candidates' })).toBeNull();
  });

  it('never shows the problem’s candidates to a public reader', () => {
    renderWorkflow({ facts, reader: 'public' });
    expect(section('Workflow')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Problem candidates' })).toBeNull();
  });

  it('draws nothing before the first version', () => {
    const { container } = renderWorkflow({ version: null });
    expect(container.querySelector('[data-mode="workflow"]')).toBeEmptyDOMElement();
  });
});
