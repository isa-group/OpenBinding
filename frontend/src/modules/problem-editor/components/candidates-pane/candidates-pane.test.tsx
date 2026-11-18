import { fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { Located } from '../../../core/diagnostics/located';
import type { ProblemFacts } from '../../../core/api/types';
import { CandidatesPane } from '.';
import { DEFAULT_FILES, type WorkspaceFiles } from '../../utils/documents';
import { BLANK_LATENCY, blankFacts } from '../../utils/editorTestKit';
import { writeAtOrigin } from '../../utils/matrixEdits';

const POINTER = BLANK_LATENCY;
const factsOf = blankFacts;

const finding: Located = {
  code: 'feature_value_domain',
  message: 'candidate feature value is above its declared domain',
  severity: 'error',
  where: { kind: 'text', file: 'candidates.json', from: 10, to: 13, line: 2, column: 1 },
  pointer: POINTER,
};

/** The pane over files it writes, as the editor holds them; `catalog()` reads the catalog as it is now. */
function renderPane({
  facts = factsOf(),
  diagnostics = [],
  files: initial = DEFAULT_FILES,
  selection = {},
}: {
  facts?: ProblemFacts;
  diagnostics?: Located[];
  files?: WorkspaceFiles;
  selection?: Record<string, string>;
} = {}) {
  const onOpenFinding = vi.fn();
  const onOpenFile = vi.fn();
  function Harness({
    facts: shown,
    diagnostics: found,
  }: {
    facts: ProblemFacts;
    diagnostics: Located[];
  }) {
    const [files, setFiles] = useState(initial);
    return (
      <>
        <CandidatesPane
          facts={shown}
          stale={false}
          selection={selection}
          task={null}
          onTask={() => undefined}
          files={files}
          diagnostics={found}
          onEdit={(origin, value) => setFiles(now => writeAtOrigin(now, origin, value) ?? now)}
          update={updater => setFiles(updater)}
          onOpenFile={onOpenFile}
          onOpenFinding={onOpenFinding}
        />
        <output data-testid="catalog">{files['candidates.json']}</output>
      </>
    );
  }
  const view = render(<Harness facts={facts} diagnostics={diagnostics} />);
  return {
    ...view,
    onOpenFinding,
    onOpenFile,
    catalog: () => JSON.parse(screen.getByTestId('catalog').textContent ?? ''),
    check: (next: ProblemFacts, found: Located[] = []) =>
      view.rerender(<Harness facts={next} diagnostics={found} />),
  };
}

const table = () => screen.getByRole('table', { name: /Task hello/ });
const cell = () => within(table()).getAllByRole('cell')[1];

describe('CandidatesPane', () => {
  it('writes a value where its origin points, and says it is pending until a check reads it', () => {
    const pane = renderPane();
    expect(within(cell()).queryByText('Pending check')).toBeNull();

    fireEvent.change(within(table()).getByRole('textbox', { name: 'latency for service-a' }), {
      target: { value: '25' },
    });
    expect(pane.catalog().spec.candidates['service-a'].features.latency).toBe(25);
    expect(within(table()).getByRole('textbox', { name: 'latency for service-a' })).toHaveValue(
      '25'
    );
    expect(within(cell()).getByText('Pending check')).toBeInTheDocument();

    // A check that read the package before the edit leaves it pending; the one that reads the edit does not.
    pane.check(factsOf(10));
    expect(within(cell()).getByText('Pending check')).toBeInTheDocument();
    pane.check(factsOf(25));
    expect(within(cell()).queryByText('Pending check')).toBeNull();
  });

  it('writes a range with an open end', () => {
    const pane = renderPane();
    fireEvent.click(within(table()).getByRole('button', { name: 'Range' }));
    expect(pane.catalog().spec.candidates['service-a'].features.latency).toEqual({
      min: 10,
      max: 10,
    });
    fireEvent.click(
      within(table()).getByRole('checkbox', { name: 'latency for service-a: no upper limit' })
    );
    expect(pane.catalog().spec.candidates['service-a'].features.latency).toEqual({
      min: 10,
      max: null,
    });
    expect(within(cell()).getByText('Pending check')).toBeInTheDocument();

    pane.check(factsOf({ min: 10, max: null }));
    expect(within(cell()).queryByText('Pending check')).toBeNull();
    expect(within(table()).getByRole('textbox', { name: 'latency for service-a max' })).toHaveValue(
      '+∞'
    );
  });

  it('shows the check’s finding about a value on its cell, and opens it', () => {
    const pane = renderPane({
      files: writeAtOrigin(DEFAULT_FILES, { path: 'candidates.json', pointer: POINTER }, 900)!,
      diagnostics: [finding],
    });
    expect(within(cell()).getByText('Pending check')).toBeInTheDocument();
    fireEvent.click(
      within(cell()).getByRole('button', {
        name: 'candidate feature value is above its declared domain',
      })
    );
    expect(pane.onOpenFinding).toHaveBeenCalledWith(finding);
  });

  it('opens a candidate’s catalog form beside the matrix, with its providers and the values it misses', () => {
    const pane = renderPane({
      facts: factsOf(null),
      files: writeAtOrigin(DEFAULT_FILES, { path: 'candidates.json', pointer: POINTER }, null)!,
    });
    expect(cell()).toHaveTextContent('not declared');
    fireEvent.click(within(cell()).getByRole('button', { name: 'Add latency for service-a' }));

    const panel = screen.getByRole('complementary', { name: 'Candidate service-a' });
    expect(panel).toHaveTextContent('in candidates.json');
    expect(
      within(panel).getByText('Some candidates give no value to a feature the Optimization uses')
    ).toBeInTheDocument();
    expect(within(panel).queryByText('Feature bindings')).toBeNull();
    fireEvent.change(within(panel).getByRole('spinbutton', { name: 'service-a QoS latency' }), {
      target: { value: '40' },
    });
    expect(pane.catalog().spec.candidates['service-a'].features.latency).toBe(40);

    fireEvent.change(within(panel).getByRole('textbox', { name: 'New provider id' }), {
      target: { value: 'acme' },
    });
    fireEvent.click(within(panel).getByRole('button', { name: 'Add provider' }));
    expect(pane.catalog().spec.providers).toEqual({ acme: {} });
    fireEvent.change(within(panel).getByRole('combobox', { name: 'service-a provider' }), {
      target: { value: 'acme' },
    });
    expect(pane.catalog().spec.candidates['service-a'].provider).toEqual({
      resource: 'catalog',
      id: 'acme',
    });

    fireEvent.click(within(panel).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('complementary')).toBeNull();
  });

  it('adds a candidate to the catalog, and says it appears after the next check', () => {
    const pane = renderPane();
    fireEvent.click(screen.getByRole('button', { name: 'Add a candidate' }));
    expect(Object.keys(pane.catalog().spec.candidates)).toEqual(['service-a', 'candidate2']);
    const panel = screen.getByRole('complementary', { name: 'Candidate candidate2' });
    expect(panel).toHaveTextContent(
      'candidate2 is not in the matrix yet: it appears after the next check, under the tasks that can take it.'
    );
    // The matrix still draws the last check: one candidate.
    expect(within(table()).getAllByRole('row')).toHaveLength(2);

    fireEvent.click(within(panel).getByRole('button', { name: 'Remove candidate' }));
    expect(Object.keys(pane.catalog().spec.candidates)).toEqual(['service-a']);
    expect(panel).toHaveTextContent('candidate2 is no longer in this catalog.');
  });

  it('opens a candidate from its name, and reads the matrix without inputs on request', () => {
    renderPane();
    fireEvent.click(within(table()).getByRole('button', { name: 'Edit candidate service-a' }));
    expect(screen.getByRole('complementary', { name: 'Candidate service-a' })).toBeInTheDocument();
    expect(
      within(table()).getByRole('button', { name: 'Edit candidate service-a' })
    ).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(screen.getByRole('button', { name: 'Edit values' }));
    expect(screen.getByRole('button', { name: 'Edit values' })).toHaveAttribute(
      'aria-pressed',
      'false'
    );
    expect(within(table()).queryByRole('textbox')).toBeNull();
    expect(cell()).toHaveTextContent('10 ms');
  });

  it('sends to Files a value whose file does not parse', () => {
    const pane = renderPane({ files: { ...DEFAULT_FILES, 'candidates.json': '{"spec": ' } });
    fireEvent.click(
      within(cell()).getByRole('button', { name: 'Repair candidates.json in Files to edit it' })
    );
    expect(pane.onOpenFile).toHaveBeenCalledWith('candidates.json');
  });

  it('marks the candidate a highlighted composition version chose, while its values stay editable', () => {
    renderPane({ selection: { hello: 'catalog/service-a' } });
    const row = within(table()).getByRole('row', { name: /service-a/ });
    expect(row).toHaveAttribute('aria-current', 'true');
    expect(row).toHaveTextContent('Selected');
    expect(within(row).getByRole('textbox', { name: 'latency for service-a' })).toHaveValue('10');
  });

  it('says which values come from SPHERE and warns that editing one makes it hand-written', () => {
    const facts = factsOf();
    facts.candidates[0].origins.latency = {
      ...facts.candidates[0].origins.latency,
      source: {
        kind: 'manual',
        carried: false,
        detail: { key: 'service-a' },
        pricing: null,
      },
    };
    renderPane({ facts });
    expect(screen.getByText(/One value comes from SPHERE/)).toBeInTheDocument();
    expect(
      within(cell()).getByText('Comes from SPHERE; editing makes it a hand-written value.')
    ).toHaveClass('group-focus-within:inline');
  });

  it('says nothing about SPHERE when no value was imported', () => {
    renderPane();
    expect(screen.queryByText(/from SPHERE/)).toBeNull();
  });
});
