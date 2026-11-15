import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { compositionViewModel } from '../../../../entities/composition/viewModel';
import type { CompositionVersionDiff, CompositionVersionView, CompositionView, ProblemFacts } from '../../../../shared/api/types';
import fmsDiff from '../../../../test/fixtures/core/fms.diff.json';
import fmsFacts from '../../../../test/fixtures/core/fms.facts.json';
import fmsVersion from '../../../../test/fixtures/core/fms.version.json';
import { MODE_SECTIONS } from '../../presets';
import { GraphDiff } from './GraphDiff';

const composition: CompositionView = {
  id: 'composition-fleet', slug: 'fleet-routing', name: 'Fleet routing', description: '', kind: 'application', archived: false,
  visibility: 'private', organization: { id: 'org-isa-demo', slug: 'isa-demo', name: 'ISA Demo Group' }, created_by_id: null,
  created_at: '2026-09-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z', version_count: 2,
  latest_version: { id: 'v2', ordinal: 2, label: '1.1.0', values_status: 'verified', created_at: '2026-10-01T00:00:00Z' },
};

/** The later version: the fixture with T1 bound to Google Cloud, as the diff says. */
function laterVersion(): CompositionVersionView {
  const version = structuredClone(fmsVersion) as CompositionVersionView;
  const document = version.document as { binding: Record<string, unknown> };
  document.binding.T1 = { candidate: 'cand_t1_google_cloud' };
  version.evaluations = version.evaluations.map((evaluation) => ({ ...evaluation, binding: { ...evaluation.binding, T1: 'catalog/cand_t1_google_cloud' } }));
  return { ...version, id: 'v2', label: '1.1.0', ordinal: 2 };
}

const diff = () => structuredClone(fmsDiff) as CompositionVersionDiff;
const BEFORE = { ...fmsVersion.evaluations[0].binding };

describe('GraphDiff', () => {
  it('draws the later workflow with the task whose binding changed marked, in text', () => {
    const model = compositionViewModel({ composition, version: laterVersion(), reader: 'member' });
    render(<GraphDiff model={model} diff={diff()} beforeSelection={BEFORE} sections={MODE_SECTIONS.comparison} />);

    const region = screen.getByRole('region', { name: 'Workflow changes' });
    expect(region).toHaveTextContent('The workflow of 1.1.0. A task marked added or changed is bound differently from 1.0.0.');
    const graph = within(region).getByRole('group', { name: 'The workflow of Fleet routing at 1.1.0' });
    const t1 = graph.querySelector('.wg-task.is-changed');
    expect(t1).toHaveTextContent('T1');
    expect(t1).toHaveTextContent('candidate cand_t1_google_cloud');
    expect(t1).toHaveTextContent('changed');
    expect(graph.querySelectorAll('.wg-status')).toHaveLength(1);
    // No facts: no matrix.
    expect(screen.queryByRole('region', { name: 'Problem candidates' })).toBeNull();
  });

  it('names the tasks the later workflow no longer has, and says when the workflow itself changed', () => {
    const value = diff();
    value.sections[0].entries.push({ kind: 'removed', name: 'T0', changes: [{ path: 'candidate', before: 'cand_t0', after: null }] });
    value.general = [{ path: 'workflow', before: { seq: ['T0', 'T1'] }, after: { seq: ['T1'] } }];
    const model = compositionViewModel({ composition, version: laterVersion(), reader: 'member' });
    render(<GraphDiff model={model} diff={value} beforeSelection={BEFORE} sections={MODE_SECTIONS.comparison} />);

    expect(screen.getByText(/The workflow itself changed too/)).toBeInTheDocument();
    expect(screen.getByText(/Not in 1\.1\.0 any more/)).toHaveTextContent('Not in 1.1.0 any more: T0');
  });

  it('marks the candidate each version chose in the matrix, when the problem’s facts are readable', () => {
    const model = compositionViewModel({ composition, version: laterVersion(), facts: fmsFacts as ProblemFacts, reader: 'member' });
    render(<GraphDiff model={model} diff={diff()} beforeSelection={BEFORE} sections={MODE_SECTIONS.comparison} />);

    const matrix = screen.getByRole('region', { name: 'Problem candidates' });
    const aws = within(matrix).getByRole('row', { name: /^cand_t1_aws/ });
    const google = within(matrix).getByRole('row', { name: /^cand_t1_google_cloud/ });
    expect(aws).toHaveTextContent('In 1.0.0');
    expect(aws).not.toHaveTextContent('In 1.1.0');
    expect(google).toHaveTextContent('In 1.1.0');
    expect(google).not.toHaveTextContent('In 1.0.0');
    const paypal = within(matrix).getByRole('row', { name: /^cand_t6_paypal/ });
    expect(paypal).toHaveTextContent('In 1.0.0In 1.1.0');
  });

  it('shows no matrix to a public reader, and only the sections asked for', () => {
    const model = compositionViewModel({ composition, version: laterVersion(), facts: fmsFacts as ProblemFacts, reader: 'public' });
    const { rerender } = render(<GraphDiff model={model} diff={diff()} beforeSelection={null} sections={MODE_SECTIONS.comparison} />);
    expect(screen.queryByRole('region', { name: 'Problem candidates' })).toBeNull();

    rerender(<GraphDiff model={model} diff={diff()} beforeSelection={null} sections={['changes']} />);
    expect(screen.queryByRole('region', { name: 'Workflow changes' })).toBeNull();
  });
});
