import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { candidateMatrix } from '../../entities/binding/candidateMatrix';
import type { ProblemFacts } from '../../shared/api/types';
import ambiguous from '../../test/fixtures/core/ambiguous.facts.json';
import fms from '../../test/fixtures/core/fms.facts.json';
import simpleSeq from '../../test/fixtures/core/simple-seq.facts.json';
import { CandidateMatrix } from './CandidateMatrix';

const ranged = () => {
  const facts = structuredClone(simpleSeq) as ProblemFacts;
  facts.candidates[1].values = { latency: { min: 100, max: null } };
  return facts;
};
const matchMedia = window.matchMedia;

const setMatchMedia = (value: typeof window.matchMedia) => Object.defineProperty(window, 'matchMedia', { configurable: true, value });

afterEach(() => {
  setMatchMedia(matchMedia);
  localStorage.clear();
});

describe('CandidateMatrix', () => {
  it('draws one table per task, with a caption, scoped headers and units in the headers', () => {
    render(<CandidateMatrix matrix={candidateMatrix(simpleSeq as ProblemFacts)} mode="view" label="Candidates" />);
    const t1 = screen.getByRole('table', { name: /Task t1 · 2 candidates/ });
    expect(screen.getAllByRole('table')).toHaveLength(3);
    expect(within(t1).getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual(['Candidate', 'Provider', 'latency (ms)']);
    expect(within(t1).getAllByRole('columnheader')[0]).toHaveAttribute('scope', 'col');
    expect(within(t1).getByRole('rowheader', { name: 'c1a' })).toHaveAttribute('scope', 'row');
    expect(within(t1).getByRole('row', { name: /c1a/ })).toHaveTextContent('10 ms');
  });

  it('writes a range as a range, open ends included, with the origin of every value', () => {
    render(<CandidateMatrix matrix={candidateMatrix(ranged())} mode="view" label="Candidates" />);
    const row = screen.getByRole('row', { name: /c1b/ });
    expect(within(row).getByText('≥ 100 ms')).toHaveAttribute('title', '[100, +∞) ms');
    expect(row.querySelector('.cm-bar.is-interval i')).toHaveClass('is-open-high');
    expect(within(row).getByText('written in candidates.json at /spec/candidates/c1b/features/latency')).toBeInTheDocument();
  });

  it('marks the selected candidate in text and with aria-current', () => {
    render(<CandidateMatrix matrix={candidateMatrix(ambiguous as ProblemFacts, { selection: { t1: 'other/c1a' } })} mode="view" label="Candidates" />);
    const chosen = screen.getByRole('row', { name: /other\/c1a/ });
    expect(chosen).toHaveAttribute('aria-current', 'true');
    expect(within(chosen).getByText('Selected')).toBeInTheDocument();
    expect(screen.getByRole('row', { name: /^c1b/ })).not.toHaveAttribute('aria-current');
  });

  it('writes the tags a screen gives beside a candidate’s name', () => {
    const tags = (task: string, candidate: string) => (task === 't1' && candidate === 'other/c1a' ? ['In 1.0.0', 'In 1.1.0'] : []);
    render(<CandidateMatrix matrix={candidateMatrix(ambiguous as ProblemFacts)} mode="view" label="Candidates" tags={tags} />);
    expect(within(screen.getByRole('row', { name: /other\/c1a/ })).getAllByText(/^In 1\.\d\.0$/).map((tag) => tag.textContent)).toEqual(['In 1.0.0', 'In 1.1.0']);
    expect(within(screen.getByRole('row', { name: /^c1b/ })).queryByText(/^In /)).toBeNull();
  });

  it('says a local task gets no candidate', () => {
    render(<CandidateMatrix matrix={candidateMatrix(fms as ProblemFacts)} mode="view" label="Candidates" />);
    expect(screen.getByText(/is a local task: it gets no candidate\./)).toHaveTextContent('node_classic_routing is a local task');
  });

  it('makes each task a radio group in select mode, moved with the keyboard', () => {
    const select = vi.fn();
    render(<CandidateMatrix matrix={candidateMatrix(simpleSeq as ProblemFacts, { selection: { t1: 'catalog/c1a' } })} mode="select" onSelect={select} label="Candidates" />);
    const group = screen.getByRole('radiogroup', { name: 'Candidate for t1' });
    const [first, second] = within(group).getAllByRole('radio');
    expect(first).toBeChecked();
    expect(first).toHaveAccessibleName('c1a for t1');
    expect(second).toHaveAttribute('name', first.getAttribute('name'));
    fireEvent.click(second);
    expect(select).toHaveBeenCalledWith('t1', 'catalog/c1b');
    expect(screen.getAllByRole('radiogroup')).toHaveLength(3);
  });

  it('hands every cell to renderCell in edit mode', () => {
    render(
      <CandidateMatrix
        matrix={candidateMatrix(simpleSeq as ProblemFacts)}
        mode="edit"
        renderCell={(cell, candidate, row) => <input aria-label={`${cell.feature} of ${candidate.written} in ${row.task}`} defaultValue={String(cell.value)} />}
        label="Candidates"
      />,
    );
    expect(screen.getByRole('textbox', { name: 'latency of c1b in t1' })).toHaveValue('20');
  });

  it('turns each candidate into a card on a small screen', () => {
    setMatchMedia(((query: string) => ({ ...matchMedia(query), matches: query === '(max-width: 640px)' })) as typeof window.matchMedia);
    render(<CandidateMatrix matrix={candidateMatrix(simpleSeq as ProblemFacts, { selection: { t1: 'catalog/c1b' } })} mode="view" label="Candidates" />);
    expect(screen.queryByRole('table')).toBeNull();
    const cards = within(screen.getByRole('list', { name: 'Candidates for t1' })).getAllByRole('listitem');
    expect(cards).toHaveLength(2);
    expect(cards[1]).toHaveAttribute('aria-current', 'true');
    expect(within(cards[1]).getByText('latency (ms)').tagName).toBe('DT');
    expect(cards[1]).toHaveTextContent('Selected');
  });

  it('shows the features that are not required on request and remembers the choice', () => {
    const facts = structuredClone(simpleSeq) as ProblemFacts;
    facts.features.push({ id: 'carbon', unit: 'g', direction: 'min', required: false });
    const { unmount } = render(<CandidateMatrix matrix={candidateMatrix(facts)} mode="view" label="Candidates" />);
    expect(screen.queryByRole('columnheader', { name: 'carbon (g)' })).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: 'carbon (g)' }));
    expect(screen.getAllByRole('columnheader', { name: 'carbon (g)' })).toHaveLength(3);
    unmount();
    render(<CandidateMatrix matrix={candidateMatrix(facts)} mode="view" label="Candidates" />);
    expect(screen.getAllByRole('columnheader', { name: 'carbon (g)' })).toHaveLength(3);
  });
});
