import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { versionChanges } from '../../../core/utils/composition/changes';
import type { CompositionVersionDiff } from '../../../core/api/types';
import fms from '../../../../test/fixtures/core/fms.diff.json';
import { ChangeSummary } from './ChangeSummary';

const diff = () => structuredClone(fms) as CompositionVersionDiff;
const ready = (value: CompositionVersionDiff) => ({
  status: 'ready' as const,
  summary: versionChanges(value),
});

describe('ChangeSummary', () => {
  it('lists the sections with their counts, the candidate that moved and the values that moved', () => {
    render(
      <ChangeSummary
        state={ready(diff())}
        heading="Changes since 1.0.0"
        createdAt="2026-09-25T15:45:00Z"
      />
    );

    expect(screen.getByText('Changes since 1.0.0')).toBeInTheDocument();
    expect(screen.getByText('Sealed Sep 25, 2026')).toBeInTheDocument();
    const sections = screen
      .getAllByRole('listitem')
      .filter(item => item.classList.contains('cs-section'));
    expect(sections.map(item => item.querySelector('.cs-section-label')?.textContent)).toEqual([
      'Binding',
      'Values',
    ]);
    expect(sections[0]).toHaveTextContent('~1 changed');
    expect(sections[1]).toHaveTextContent('~4 changed');
    // Three names, then how many more.
    expect(sections[1]).toHaveTextContent(
      '~changed availability, ~changed cost, ~changed execution_time +1 more'
    );
    expect(
      within(screen.getByRole('list', { name: 'Candidate changes' })).getByRole('listitem')
    ).toHaveTextContent('T1: cand_t1_aws → cand_t1_google_cloud');
    expect(
      within(screen.getByRole('list', { name: 'Value changes' })).getAllByRole('listitem')[1]
    ).toHaveTextContent('cost: 3,060 → 3,080');
    expect(screen.queryByText(/Not comparable/)).toBeNull();
  });

  it('marks added and removed entries, and a task that became local', () => {
    const value = diff();
    value.sections[0].entries = [
      { kind: 'added', name: 'dailySummary', changes: [] },
      { kind: 'removed', name: 'archive', changes: [] },
      {
        kind: 'changed',
        name: 'notify',
        changes: [{ path: 'candidate', before: 'brevo.business', after: null }],
      },
    ];
    render(<ChangeSummary state={ready(value)} />);

    const binding = screen.getAllByRole('listitem')[0];
    expect(binding).toHaveTextContent('+1 added−1 removed~1 changed');
    expect(binding).toHaveTextContent('+added dailySummary, −removed archive, ~changed notify');
    expect(screen.getByRole('list', { name: 'Candidate changes' })).toHaveTextContent(
      'notify: brevo.business → local'
    );
  });

  it('says why the values are not compared, and lists none', () => {
    const value = diff();
    value.comparison = {
      comparable: false,
      problemRefChanged: false,
      compilationChanged: true,
      valueStatus: { before: 'verified', after: 'verified' },
    };
    value.sections[1].entries = [];
    render(<ChangeSummary state={ready(value)} />);

    expect(screen.getByText('Not comparable: compilation changed')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Value changes' })).toBeNull();
  });

  it('counts changed fields outside the sections', () => {
    const value = diff();
    value.general = [{ path: 'workflow', before: { seq: ['T1'] }, after: { seq: ['T1', 'T2'] } }];
    render(<ChangeSummary state={ready(value)} />);
    expect(screen.getByText('1 other field changed')).toBeInTheDocument();
  });

  it('says when it is comparing, when it could not compare and when nothing changed', () => {
    const { rerender } = render(<ChangeSummary state={{ status: 'loading' }} />);
    expect(screen.getByRole('status')).toHaveTextContent('Comparing…');

    rerender(<ChangeSummary state={{ status: 'error' }} />);
    expect(screen.getByText('Could not compare these versions.')).toBeInTheDocument();

    const empty = diff();
    empty.sections = empty.sections.map(section => ({ ...section, entries: [] }));
    empty.isEmpty = true;
    rerender(<ChangeSummary state={ready(empty)} />);
    expect(screen.getByText('No changes.')).toBeInTheDocument();
  });
});
