import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { Diagnostic } from './bimDocuments';
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
      <CheckResult wb={wb} plan={{ name: null, ceiling: null, maxLabel: null }} pricingHref="/pricing" />
    </MemoryRouter>,
  );
}

function buttons(): string[] {
  const list = screen.getByRole('list', { name: 'Diagnostics' });
  return within(list).getAllByRole('button').map((button) => (button.textContent ?? '').replace(/\s+/g, ' ').trim());
}

describe('the diagnostics of a failed validation', () => {
  // [utest->req~frontend-rendering-check-result-diagnostic-text~1]
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

  // [utest->req~frontend-rendering-check-result-diagnostic-text~1]
  it('shows the message, then the detail when there is no message', () => {
    show(failed([
      { code: 'E1', message: 'Unknown task' },
      { code: 'E2', message: '', detail: 'Missing candidate' },
      { message: 'No code' },
    ]));

    expect(buttons()).toEqual(['E1 Unknown task', 'E2 Missing candidate', 'diagnostic No code']);
  });

  // [utest->req~frontend-rendering-check-result-diagnostic-text~1]
  it('does not crash nor dump a message that is not text', () => {
    const odd = { code: 'E3', message: { en: 'x' } } as unknown as Diagnostic;
    expect(() => show(failed([odd]))).not.toThrow();

    expect(buttons()).toEqual([`E3 ${NO_MESSAGE}`]);
    const list = screen.getByRole('list', { name: 'Diagnostics' });
    expect(list.textContent).not.toContain('{');
    expect(list.textContent).not.toContain('"en"');
  });

  // [utest->req~frontend-rendering-check-result-diagnostic-text~1]
  it('still opens the resource of the diagnostic when its button is pressed', () => {
    const item: Diagnostic = { code: 'E_REF', pointer: '/spec/tasks/0' };
    const open = vi.fn();
    show(failed([item], open));

    fireEvent.click(screen.getByRole('button', { name: /^E_REF/ }));

    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(item);
  });
});
