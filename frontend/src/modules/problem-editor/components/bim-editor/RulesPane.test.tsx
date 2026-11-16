import { fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { ProblemFacts } from '../../../core/api/types';
import completeFacts from '../../../../test/fixtures/core/json-complete.facts.json';
import refusedPackage from '../../../../test/fixtures/core/refused.package.json';
import { DEFAULT_FILES, type WorkspaceFiles } from './documents';
import { RulesPane } from './RulesPane';

// The package of the refused fixture writes the same rules as the facts of `json-complete` (its constraint set and
// optimization), so the view of the facts and the forms of the documents are about one package.
const PACKAGE = refusedPackage as WorkspaceFiles;

function renderPane({
  facts = completeFacts as ProblemFacts,
  files: initial = PACKAGE,
  stale = false,
}: { facts?: ProblemFacts | null; files?: WorkspaceFiles; stale?: boolean } = {}) {
  const onOpenOrigin = vi.fn();
  const onOpenFile = vi.fn();
  function Harness() {
    const [files, setFiles] = useState(initial);
    return (
      <>
        <RulesPane
          facts={facts}
          stale={stale}
          files={files}
          update={updater => setFiles(updater)}
          onOpenOrigin={onOpenOrigin}
          onOpenFile={onOpenFile}
        />
        <output data-testid="constraints">{files['constraints.json']}</output>
        <output data-testid="optimization">{files['optimization.json']}</output>
      </>
    );
  }
  render(<Harness />);
  const read = (id: string) => JSON.parse(screen.getByTestId(id).textContent ?? '');
  return {
    onOpenOrigin,
    onOpenFile,
    constraints: () => read('constraints'),
    optimization: () => read('optimization'),
  };
}

describe('RulesPane', () => {
  it('shows the rules and objectives of the last check, each rule opening where the package writes it', () => {
    const pane = renderPane();
    const view = screen.getByRole('region', { name: 'Rules and objectives' });
    const rules = within(view).getByRole('list', { name: 'Rules of this package' });
    expect(within(rules).getAllByRole('listitem')).toHaveLength(6);
    fireEvent.click(
      within(rules).getByRole('button', {
        name: 'Open constraints/carbon_budget in constraints.json at /spec/constraints/carbon_budget',
      })
    );
    expect(pane.onOpenOrigin).toHaveBeenCalledWith({
      resource: 'constraints',
      path: 'constraints.json',
      pointer: '/spec/constraints/carbon_budget',
    });
    expect(within(view).getByRole('list', { name: 'Criteria to optimize' })).toHaveTextContent(
      'trust'
    );
  });

  it('edits a rule in its constraint set, and lists a rule that should hold in the optimization', () => {
    const pane = renderPane();
    const set = screen.getByRole('region', { name: 'ConstraintSet constraints' });
    fireEvent.change(within(set).getByRole('combobox', { name: 'carbon_budget enforcement' }), {
      target: { value: 'soft' },
    });
    expect(pane.constraints().spec.constraints.carbon_budget).toEqual({
      assert: 'features.carbon <= 30',
      enforcement: 'soft',
      penalty: { literal: 1 },
    });

    fireEvent.click(
      within(set).getByRole('button', { name: 'Add carbon_budget to the Optimization' })
    );
    expect(pane.optimization().spec.penalties).toEqual([
      { constraint: { resource: 'constraints', id: 'carbon_budget' }, weight: 1 },
    ]);
    // The view still shows what the last check read.
    const carbon = within(screen.getByRole('list', { name: 'Rules of this package' }))
      .getAllByRole('listitem')
      .find(item => item.textContent?.includes('features.carbon ≤ 30'));
    expect(carbon).toHaveTextContent('Must');
  });

  it('edits a criterion of the optimization', () => {
    const pane = renderPane();
    const optimization = screen.getByRole('region', { name: 'Optimization optimization' });
    fireEvent.change(
      within(optimization).getByRole('combobox', { name: 'Criterion 1 direction' }),
      { target: { value: 'maximize' } }
    );
    expect(pane.optimization().spec.criteria[0]).toMatchObject({
      id: 'latency',
      direction: 'maximize',
    });
  });

  it('keeps the forms before any check has passed, and says the view comes with one', () => {
    renderPane({ facts: null, files: DEFAULT_FILES });
    expect(
      screen.getByText('The rules and objectives appear once the package passes a check.')
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'The package has no constraint set. Add one to the Instance in Forms to write rules.'
      )
    ).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Optimization optimization' })).toBeInTheDocument();
  });

  it('sends a document that does not parse to Files, and marks the view stale', () => {
    const pane = renderPane({
      files: { ...PACKAGE, 'constraints.json': '{"spec": ' },
      stale: true,
    });
    expect(screen.getByText('Stale: showing the last valid package.')).toBeInTheDocument();
    const set = screen.getByRole('region', { name: 'ConstraintSet constraints' });
    fireEvent.click(within(set).getByRole('button', { name: 'Open constraints.json in Files' }));
    expect(pane.onOpenFile).toHaveBeenCalledWith('constraints.json');
  });
});
