import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { compositionViewModel } from '../../../../entities/composition/viewModel';
import type { CompositionVersionDiff, CompositionVersionView, CompositionView } from '../../../../shared/api/types';
import fmsDiff from '../../../../test/fixtures/core/fms.diff.json';
import fmsVersion from '../../../../test/fixtures/core/fms.version.json';
import { CompositionRenderer } from '../../CompositionRenderer';
import type { ComparisonData } from './Comparison';

const composition: CompositionView = {
  id: 'composition-fleet', slug: 'fleet-routing', name: 'Fleet routing', description: '', kind: 'application', archived: false,
  visibility: 'private', organization: { id: 'org-isa-demo', slug: 'isa-demo', name: 'ISA Demo Group' }, created_by_id: null,
  created_at: '2026-09-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z', version_count: 3,
  latest_version: { id: 'v3', ordinal: 3, label: '1.2.0', values_status: 'verified', created_at: '2026-10-01T00:00:00Z' },
};

const later = { ...(structuredClone(fmsVersion) as CompositionVersionView), id: 'v2', label: '1.1.0', ordinal: 2 };
const model = compositionViewModel({ composition, version: later, reader: 'member' });
const VERSIONS = [{ id: 'v3', label: '1.2.0' }, { id: 'v2', label: '1.1.0' }, { id: 'v1', label: '1.0.0' }];

const diff = () => structuredClone(fmsDiff) as CompositionVersionDiff;
const ready = <T,>(value: T) => ({ status: 'ready' as const, value });

function renderComparison(over: Partial<ComparisonData> = {}, onlyDifferences = true) {
  const onPair = vi.fn();
  const data: ComparisonData = {
    versions: VERSIONS, from: 'v1', to: 'v2', onPair, view: 'compare', diff: ready(diff()), beforeSelection: ready({ T1: 'catalog/cand_t1_aws' }), ...over,
  };
  render(<CompositionRenderer model={model} mode="comparison" comparison={data} onlyDifferences={onlyDifferences} />);
  return { onPair };
}

const matchMedia = window.matchMedia;
const setMatchMedia = (value: typeof window.matchMedia) => Object.defineProperty(window, 'matchMedia', { configurable: true, value });

afterEach(() => setMatchMedia(matchMedia));

/** Twenty lines, of which the tenth differs. */
const lines = (tenth: string) => Array.from({ length: 20 }, (_, index) => (index === 9 ? tenth : `line ${index + 1}`)).join('\n');

describe('the comparison mode', () => {
  it('picks two versions and swaps them', () => {
    const { onPair } = renderComparison();
    expect(screen.getByRole('combobox', { name: 'Base version' })).toHaveValue('v1');
    expect(screen.getByRole('combobox', { name: 'Compared with' })).toHaveValue('v2');

    fireEvent.click(screen.getByRole('button', { name: 'Swap versions' }));
    expect(onPair).toHaveBeenLastCalledWith('v2', 'v1');
    fireEvent.change(screen.getByRole('combobox', { name: 'Base version' }), { target: { value: 'v3' } });
    expect(onPair).toHaveBeenLastCalledWith('v3', 'v2');
    fireEvent.change(screen.getByRole('combobox', { name: 'Compared with' }), { target: { value: 'v3' } });
    expect(onPair).toHaveBeenLastCalledWith('v1', 'v3');
  });

  it('lists the changed entries by section, opening a changed one with few fields', () => {
    renderComparison();
    const binding = screen.getByRole('region', { name: /^Binding/ });
    const t1 = within(binding).getByRole('button', { name: /T1/ });
    expect(t1).toHaveAttribute('aria-expanded', 'true');
    expect(t1).toHaveTextContent('Changed');
    expect(binding).toHaveTextContent('candidatecand_t1_aws to cand_t1_google_cloud');
    expect(screen.getByRole('region', { name: /^Values/ })).toHaveTextContent('3,060 to 3,080');

    fireEvent.click(t1);
    expect(t1).toHaveAttribute('aria-expanded', 'false');
    expect(binding).not.toHaveTextContent('cand_t1_google_cloud');
  });

  it('filters by kind with the summary tiles, which say how many of each there are', () => {
    const value = diff();
    value.sections[0].entries.push({ kind: 'added', name: 'T9', changes: [{ path: 'candidate', before: null, after: 'cand_t9' }] });
    value.totals = { added: 1, removed: 0, changed: 5 };
    renderComparison({ diff: ready(value) });

    const tiles = screen.getByRole('group', { name: 'Show one kind of change' });
    expect(within(tiles).getByRole('button', { name: /0\s*Removed/ })).toBeDisabled();
    fireEvent.click(within(tiles).getByRole('button', { name: /1\s*Added/ }));
    expect(within(tiles).getByRole('button', { name: /1\s*Added/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText(/Showing only/)).toHaveTextContent('Showing only added items');
    expect(screen.queryByRole('region', { name: /^Values/ })).toBeNull();
    const binding = screen.getByRole('region', { name: /^Binding/ });
    expect(within(binding).queryByRole('button', { name: /T1/ })).toBeNull();

    // An added entry shows only its after side.
    fireEvent.click(within(binding).getByRole('button', { name: /T9/ }));
    expect(binding).toHaveTextContent('candidatecand_t9');
    expect(binding).not.toHaveTextContent('not set');

    fireEvent.click(screen.getByRole('button', { name: 'Clear filter' }));
    expect(screen.getByRole('region', { name: /^Values/ })).toBeInTheDocument();
  });

  it('reads null as absent inside a changed entry, and names a changed workflow instead of printing it', () => {
    const value = diff();
    value.sections[0].entries[0].changes.push({ path: 'from.plan', before: null, after: 'STARTER' }, { path: 'from.version', before: 'abc', after: null });
    value.general = [{ path: 'workflow', before: { seq: ['T1'] }, after: { seq: ['T1', 'T2'] } }];
    renderComparison({ diff: ready(value) });

    const binding = screen.getByRole('region', { name: /^Binding/ });
    expect(binding).toHaveTextContent('from › plannot set to STARTER');
    expect(binding).toHaveTextContent('from › versionabc to removed');
    expect(binding).not.toHaveTextContent('null');
    const general = screen.getByRole('region', { name: 'General' });
    expect(general).toHaveTextContent('workflowchanged; the file view shows how');
    expect(general).not.toHaveTextContent('seq');
  });

  it('says why the values are not compared, and leaves them out', () => {
    const value = diff();
    value.comparison = { comparable: false, problemRefChanged: false, compilationChanged: true, valueStatus: { before: 'verified', after: 'verified' } };
    value.sections[1].entries = [];
    renderComparison({ diff: ready(value) });

    expect(screen.getByText('These versions’ values are not compared')).toBeInTheDocument();
    expect(screen.getByText(/the two versions were judged on different compilations\. The values section is left out\./)).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: /^Values/ })).toBeNull();
  });

  it('says when nothing differs, and offers a retry when the gateway refused', () => {
    const empty = diff();
    empty.sections = empty.sections.map((section) => ({ ...section, entries: [] }));
    empty.isEmpty = true;
    renderComparison({ diff: ready(empty) });
    expect(screen.getByText('1.0.0 and 1.1.0 bind, value and offer the same.')).toBeInTheDocument();
  });

  it('offers a retry when the gateway refused', () => {
    const retry = vi.fn();
    renderComparison({ diff: { status: 'error', message: 'What changed between the two versions couldn’t be read (503).', retry } });
    expect(screen.getByRole('alert')).toHaveTextContent('What changed between the two versions couldn’t be read (503).');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(retry).toHaveBeenCalled();
  });

  it('shows both texts side by side, folding the unchanged stretches until asked', () => {
    renderComparison({ view: 'file', files: ready({ before: lines('line ten'), after: lines('line TEN') }) });

    const table = within(screen.getByRole('region', { name: 'The text of 1.0.0 and 1.1.0' })).getByRole('table');
    expect(within(table).getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual(['1.0.0', '1.1.0']);
    expect(screen.getByText('1 line removed')).toBeInTheDocument();
    expect(screen.getByText('1 line added')).toBeInTheDocument();
    const changed = within(table).getAllByRole('row').find((row) => row.textContent?.includes('removed: line ten'));
    expect(changed).toHaveTextContent('added: line TEN');
    expect(changed?.querySelector('mark')).toHaveTextContent('ten');
    expect(table).not.toHaveTextContent('line 2');
    expect(table.querySelector('pre')).toBeNull();

    fireEvent.click(within(table).getByRole('button', { name: 'Show 6 unchanged lines' }));
    expect(table).toHaveTextContent('line 2');
    expect(within(table).getByRole('button', { name: 'Show 7 unchanged lines' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show unchanged lines' }));
    expect(within(table).queryByRole('button', { name: /unchanged lines/ })).toBeNull();
    expect(table).toHaveTextContent('line 20');
  });

  it('shows every line at first when not only the differences are asked for', () => {
    renderComparison({ view: 'file', files: ready({ before: lines('line ten'), after: lines('line TEN') }) }, false);
    expect(screen.getByRole('button', { name: 'Hide unchanged lines' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('table')).toHaveTextContent('line 20');
  });

  it('shows one unified column with − and + in text on a small screen, with the same folds', () => {
    setMatchMedia(((query: string) => ({ ...matchMedia(query), matches: query === '(max-width: 640px)' })) as typeof window.matchMedia);
    renderComparison({ view: 'file', files: ready({ before: lines('line ten'), after: lines('line TEN') }) });

    const table = screen.getByRole('table');
    expect(within(table).getAllByRole('columnheader')).toHaveLength(4);
    const rows = within(table).getAllByRole('row');
    const removed = rows.find((row) => row.textContent?.includes('line ten'));
    const added = rows.find((row) => row.textContent?.includes('line TEN'));
    expect(removed).not.toBe(added);
    expect(removed?.querySelector('.fd-sign')).toHaveTextContent('− removed');
    expect(added?.querySelector('.fd-sign')).toHaveTextContent('+ added');
    expect(within(table).getByRole('button', { name: 'Show 6 unchanged lines' })).toBeInTheDocument();
  });

  it('says when the two texts are identical', () => {
    renderComparison({ view: 'file', files: ready({ before: 'same\n', after: 'same\n' }) });
    expect(screen.getByText('The two files are identical.')).toBeInTheDocument();
  });
});
