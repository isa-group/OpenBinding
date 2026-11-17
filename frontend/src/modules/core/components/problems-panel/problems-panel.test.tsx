import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Located } from '../../diagnostics/located';
import ProblemsPanel from '.';

const UNKNOWN: Located = {
  code: 'c2y_unknown_key',
  message: 'Unknown key presentation.',
  severity: 'warning',
  where: { kind: 'text', file: 'composition.yaml', from: 40, to: 52, line: 4, column: 1 },
  path: 'presentation',
};
const MISSING: Located = {
  code: 'c2y_missing_key',
  message: 'version is required.',
  severity: 'error',
  where: { kind: 'text', file: 'composition.yaml', from: 0, to: 4, line: 1, column: 1 },
  path: 'version',
};
const WHOLE: Located = {
  code: 'c2y_empty',
  message: 'The document is empty.',
  severity: 'error',
  where: { kind: 'file', file: 'composition.yaml' },
};

describe('ProblemsPanel', () => {
  it('counts errors and warnings in words, in the header and in a polite live region', () => {
    const { container } = render(
      <ProblemsPanel diagnostics={[UNKNOWN, MISSING, WHOLE]} onSelect={vi.fn()} />
    );
    const header = screen.getByRole('button', { name: /Problems/ });
    expect(header).toHaveTextContent('2 errors');
    expect(header).toHaveTextContent('1 warning');
    expect(header).toHaveAttribute('aria-expanded', 'true');
    const live = container.querySelector('[aria-live="polite"]');
    expect(live).toHaveTextContent('2 errors, 1 warning');
  });

  it('says there is nothing to fix and lists nothing', () => {
    const { container } = render(<ProblemsPanel diagnostics={[]} onSelect={vi.fn()} />);
    expect(screen.getByRole('button', { name: /Problems/ })).toHaveTextContent('No issues');
    expect(container.querySelector('[aria-live="polite"]')).toHaveTextContent('No issues');
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
  });

  it('updates the live region when a new check answers', () => {
    const { container, rerender } = render(
      <ProblemsPanel diagnostics={[MISSING]} onSelect={vi.fn()} />
    );
    const live = container.querySelector('[aria-live="polite"]');
    expect(live).toHaveTextContent('1 error');
    rerender(<ProblemsPanel diagnostics={[]} onSelect={vi.fn()} />);
    expect(live).toHaveTextContent('No issues');
  });

  it('lists one button per finding, in reading order, with its place, path and code', () => {
    render(<ProblemsPanel diagnostics={[UNKNOWN, MISSING, WHOLE]} onSelect={vi.fn()} />);
    const list = screen.getByRole('list');
    const entries = within(list).getAllByRole('button');
    expect(entries.map(entry => entry.textContent)).toEqual([
      'Error: version is required.Line 1, column 1versionc2y_missing_key',
      'Warning: Unknown key presentation.Line 4, column 1presentationc2y_unknown_key',
      'Error: The document is empty.composition.yamlc2y_empty',
    ]);
  });

  it('jumps to a finding from the keyboard: each entry is a native button in the tab order', () => {
    const onSelect = vi.fn();
    render(<ProblemsPanel diagnostics={[UNKNOWN, MISSING]} onSelect={onSelect} />);
    const entry = screen.getByRole('button', { name: /Unknown key presentation/ });
    // Enter and Space activate a native button; jsdom has no default actions, so the activation is the click they fire.
    expect(entry.tagName).toBe('BUTTON');
    expect(entry).toHaveAttribute('type', 'button');
    expect(entry).not.toHaveAttribute('tabindex');
    entry.focus();
    expect(entry).toHaveFocus();
    fireEvent.click(entry);
    expect(onSelect).toHaveBeenCalledWith(UNKNOWN);
  });

  it('folds the list from its header', async () => {
    render(<ProblemsPanel diagnostics={[MISSING]} onSelect={vi.fn()} />);
    const header = screen.getByRole('button', { name: /Problems/ });
    fireEvent.click(header);
    expect(header).toHaveAttribute('aria-expanded', 'false');
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /version is required/ })).not.toBeInTheDocument()
    );
    fireEvent.click(header);
    expect(await screen.findByRole('button', { name: /version is required/ })).toBeInTheDocument();
  });

  it('is a read-only list without onSelect', () => {
    render(<ProblemsPanel diagnostics={[MISSING]} />);
    expect(screen.getByText('version is required.')).toBeInTheDocument();
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });

  it('groups findings by file, with the package last', () => {
    const catalog: Located = {
      code: 'bim_unknown_feature',
      message: 'Unknown feature.',
      severity: 'error',
      where: { kind: 'text', file: 'candidates.json', from: 3, to: 9, line: 2, column: 3 },
    };
    const flow: Located = {
      code: 'bim_bpmn',
      message: 'Task without a name.',
      severity: 'warning',
      where: { kind: 'bpmn', file: 'workflow.bpmn', element: 'Task_1' },
    };
    const pack: Located = {
      code: 'bim_no_objective',
      message: 'No objective.',
      severity: 'info',
      where: { kind: 'package' },
    };
    render(<ProblemsPanel diagnostics={[pack, flow, catalog]} onSelect={vi.fn()} groups />);
    const groups = screen.getAllByRole('listitem').filter(item => item.dataset.group);
    expect(groups.map(group => group.firstChild?.textContent)).toEqual([
      'candidates.json',
      'workflow.bpmn',
      'Package',
    ]);
    expect(within(groups[1]).getByRole('button')).toHaveTextContent('Diagram element Task_1');
    expect(screen.getByRole('button', { name: /Problems/ })).toHaveTextContent('1 note');
  });
});
