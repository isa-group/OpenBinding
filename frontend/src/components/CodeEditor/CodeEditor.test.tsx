import { useState } from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import { completionStatus, currentCompletions, startCompletion, type CompletionContext } from '@codemirror/autocomplete';
import { forEachDiagnostic } from '@codemirror/lint';
import { EditorView, runScopeHandlers } from '@codemirror/view';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Located } from '../../shared/diagnostics/located';
import { CodeEditor } from './CodeEditor';

const TEXT = 'version: 1.0.0\nkind: service\nbindings:\n  pay: {}\n';

function viewOf(container: HTMLElement): EditorView {
  const editor = container.querySelector('.cm-editor');
  if (!(editor instanceof HTMLElement)) throw new Error('no editor');
  const view = EditorView.findFromDOM(editor);
  if (!view) throw new Error('no view');
  return view;
}

/** A finding on `kind` (line 2, columns 1 to 5). */
const KIND: Located = {
  code: 'c2y_bad_kind',
  message: 'kind must be one of service, product.',
  severity: 'error',
  where: { kind: 'text', file: 'composition.yaml', from: 15, to: 19, line: 2, column: 1 },
  path: 'kind',
};
const WHOLE: Located = { code: 'c2y_x', message: 'About the whole file.', severity: 'warning', where: { kind: 'file', file: 'composition.yaml' } };

/** The editor as a screen holds it: the text in state, so typing re-renders it with the new value. */
function Holder(props: { selection?: { anchor: number; head?: number }; diagnostics?: readonly Located[] }) {
  const [value, setValue] = useState(TEXT);
  return <CodeEditor value={value} onChange={setValue} language="yaml" ariaLabel="composition.yaml source" {...props} />;
}

describe('CodeEditor', () => {
  // jsdom lays nothing out, and its ranges cannot measure themselves; CodeMirror measures text ranges after each update.
  beforeAll(() => {
    const empty = { x: 0, y: 0, width: 0, height: 0, top: 0, right: 0, bottom: 0, left: 0, toJSON: () => ({}) };
    Range.prototype.getClientRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;
    Range.prototype.getBoundingClientRect = () => empty as DOMRect;
  });

  it('reads YAML and names the text box', () => {
    const { container } = render(<Holder />);
    const view = viewOf(container);
    expect(view.contentDOM).toHaveAttribute('data-language', 'yaml');
    expect(screen.getByRole('textbox', { name: 'composition.yaml source' })).toBe(view.contentDOM);
  });

  it('marks the gateway findings at their offsets and leaves the rest to the Problems panel', async () => {
    const { container, rerender } = render(<Holder diagnostics={[KIND, WHOLE]} />);
    const view = viewOf(container);
    const marked = () => {
      const found: Array<{ from: number; to: number; severity: string; message: string; source?: string }> = [];
      forEachDiagnostic(view.state, (diagnostic, from, to) => found.push({ from, to, severity: diagnostic.severity, message: diagnostic.message, source: diagnostic.source }));
      return found;
    };
    await waitFor(() => expect(marked()).toEqual([{ from: 15, to: 19, severity: 'error', message: KIND.message, source: 'c2y_bad_kind' }]));
    expect(view.state.sliceDoc(15, 19)).toBe('kind');
    await waitFor(() => expect(container.querySelector('.cm-lintRange-error')).not.toBeNull());

    rerender(<Holder diagnostics={[]} />);
    await waitFor(() => expect(marked()).toEqual([]));
    expect(viewOf(container)).toBe(view);
  });

  it('keeps a finding past the end of the text inside it', async () => {
    const late: Located = { ...KIND, where: { kind: 'text', file: 'composition.yaml', from: 500, to: 900, line: 40, column: 1 } };
    const { container } = render(<Holder diagnostics={[late]} />);
    const view = viewOf(container);
    await waitFor(() => {
      const spans: number[][] = [];
      forEachDiagnostic(view.state, (_diagnostic, from, to) => spans.push([from, to]));
      expect(spans).toEqual([[TEXT.length, TEXT.length]]);
    });
  });

  it('moves the cursor on a new selection in the same editor, keeping the undo history and the markers', async () => {
    const { container, rerender } = render(<Holder diagnostics={[KIND]} />);
    const view = viewOf(container);
    act(() => {
      view.dispatch({ changes: { from: 0, insert: '# draft\n' }, userEvent: 'input.type' });
    });

    rerender(<Holder diagnostics={[KIND]} selection={{ anchor: 23, head: 27 }} />);
    await waitFor(() => expect(view.state.selection.main).toMatchObject({ anchor: 23, head: 27 }));
    expect(viewOf(container)).toBe(view);
    expect(view.state.doc.toString()).toBe(`# draft\n${TEXT}`);
    let markers = 0;
    forEachDiagnostic(view.state, () => { markers += 1; });
    expect(markers).toBe(1);

    rerender(<Holder diagnostics={[KIND]} selection={{ anchor: 2 }} />);
    await waitFor(() => expect(view.state.selection.main).toMatchObject({ anchor: 2, head: 2 }));
    expect(viewOf(container)).toBe(view);

    // The edit made before the selection moved is still in the history.
    act(() => {
      expect(runScopeHandlers(view, new KeyboardEvent('keydown', { key: 'z', ctrlKey: true }), 'editor')).toBe(true);
    });
    expect(view.state.doc.toString()).toBe(TEXT);
  });

  it('offers what the completion source gives', async () => {
    const source = vi.fn((context: CompletionContext) => {
      const word = context.matchBefore(/\w*/);
      return { from: word ? word.from : context.pos, options: [{ label: 'offering' }, { label: 'values' }] };
    });
    const { container } = render(
      <CodeEditor value="" onChange={() => undefined} language="yaml" ariaLabel="composition.yaml source" completions={source} />,
    );
    const view = viewOf(container);
    act(() => {
      startCompletion(view);
    });
    await waitFor(() => expect(completionStatus(view.state)).toBe('active'));
    expect(source).toHaveBeenCalled();
    expect(currentCompletions(view.state).map((option) => option.label)).toEqual(['offering', 'values']);
  });

  it('is read-only when asked', () => {
    const { container } = render(<CodeEditor value={TEXT} onChange={() => undefined} language="yaml" readOnly />);
    expect(viewOf(container).state.readOnly).toBe(true);
  });
});
