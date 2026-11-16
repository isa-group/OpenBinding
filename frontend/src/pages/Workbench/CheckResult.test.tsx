import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { checkoutFacts, compiledDocument } from '../Problems/fixtures';
import type { Diagnostic } from '../../features/bim-editor/documents';
import { CheckResult } from './CheckResult';
import type { Workbench } from './useWorkbench';

const NO_MESSAGE = 'The gateway sent no message for this diagnostic.';

/** The smallest workbench the check result reads: a failed validation that lists these problems. */
function failed(diagnostics: Diagnostic[], openDiagnostic: (item: Diagnostic) => void = vi.fn()): Workbench {
  return {
    status: 'failed',
    refusal: { kind: 'invalid', status: 422, message: 'Not valid', diagnostics },
    diagnostics,
    resources: [],
    origin: 'package',
    openDiagnostic,
  } as unknown as Workbench;
}

function show(wb: Workbench) {
  return render(
    <MemoryRouter>
      <CheckResult wb={wb} />
    </MemoryRouter>,
  );
}

function buttons(): string[] {
  const list = screen.getByRole('list', { name: 'Diagnostics' });
  return within(list).getAllByRole('button').map((button) => (button.textContent ?? '').replace(/\s+/g, ' ').trim());
}

describe('the diagnostics of a failed validation', () => {
  it('says the gateway sent no message, and never dumps the diagnostic', () => {
    show(failed([{ code: 'E_REF', pointer: '/spec/tasks/0' }]));

    const list = screen.getByRole('list', { name: 'Diagnostics' });
    expect(within(list).getAllByRole('button')).toHaveLength(1);
    expect(buttons()).toEqual([`E_REF ${NO_MESSAGE}`]);
    expect(list.textContent).not.toContain('{');
    expect(list.textContent).not.toContain('"code"');
    expect(within(list).getAllByText('/spec/tasks/0')).toHaveLength(1);
    expect(within(list).getByText('Package')).toBeInTheDocument();
  });

  it('shows the message, then the detail when there is no message', () => {
    show(failed([
      { code: 'E1', message: 'Unknown task' },
      { code: 'E2', message: '', detail: 'Missing candidate' },
      { message: 'No code' },
    ]));

    expect(buttons()).toEqual(['E1 Unknown task', 'E2 Missing candidate', 'diagnostic No code']);
  });

  it('does not crash nor dump a message that is not text', () => {
    const odd = { code: 'E3', message: { en: 'x' } } as unknown as Diagnostic;
    expect(() => show(failed([odd]))).not.toThrow();

    expect(buttons()).toEqual([`E3 ${NO_MESSAGE}`]);
    const list = screen.getByRole('list', { name: 'Diagnostics' });
    expect(list.textContent).not.toContain('{');
    expect(list.textContent).not.toContain('"en"');
  });

  it('still opens the resource of the diagnostic when its button is pressed', () => {
    const item: Diagnostic = { code: 'E_REF', pointer: '/spec/tasks/0' };
    const open = vi.fn();
    show(failed([item], open));

    fireEvent.click(screen.getByRole('button', { name: /^E_REF/ }));

    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(item);
  });
});

describe('the workflow of a valid package', () => {
  /** A checked package; `compiledIr` is what `compile()` stored from `validate?include=ir,facts`. */
  function valid(compiledIr: Workbench['compiledIr'], compile = vi.fn()): Workbench {
    return {
      status: 'valid', refusal: null, diagnostics: [], resources: [], origin: 'package', files: {}, root: null, digests: null,
      compatibleModes: [], allModes: [], analysisData: { tasks: 6, candidates: 22, constraints: 2, placement: false, bindingSpace: '1920' },
      compiledIr, irLoading: false, irError: null, compile, openDiagnostic: vi.fn(), selectResource: vi.fn(),
    } as unknown as Workbench;
  }

  it('asks the gateway to compile before drawing', () => {
    const compile = vi.fn();
    show(valid(null, compile));
    fireEvent.click(screen.getByRole('button', { name: 'Draw the workflow' }));
    expect(compile).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('group', { name: 'Workflow' })).toBeNull();
  });

  it('draws the workflow from the facts of the compiled package, local tasks included', () => {
    show(valid({ digest: 'sha256-ir', document: compiledDocument(), facts: checkoutFacts() }));
    const drawing = screen.getByRole('group', { name: 'Workflow' });
    expect(drawing).toHaveAccessibleDescription(/^Workflow: authenticate, then \(inventory and shipping in parallel\)/);
    expect(within(drawing).getByRole('group', { name: 'Choice, 2 branches, probabilities 0.7, 0.3' })).toBeInTheDocument();
    expect(within(drawing).getByText('local task · not bound')).toBeInTheDocument();
  });
});
