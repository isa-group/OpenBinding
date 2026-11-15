import { useEffect, useMemo, useRef, useState } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { autocompletion, type CompletionSource } from '@codemirror/autocomplete';
import { json } from '@codemirror/lang-json';
import { yaml } from '@codemirror/lang-yaml';
import { lintGutter, setDiagnostics, type Diagnostic } from '@codemirror/lint';
import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import type { Located } from '../../shared/diagnostics/located';
import './CodeEditor.css';

export type CodeLanguage = 'json' | 'yaml' | 'xml' | 'text';

interface CodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  readOnly?: boolean;
  placeholder?: string;
  minHeight?: string;
  maxHeight?: string;
  /** `xml` is shown as plain text for now. */
  language?: CodeLanguage;
  ariaLabel?: string;
  /** Where the cursor goes. A new object moves it, in the same editor: history and lint markers stay. */
  selection?: { anchor: number; head?: number };
  /**
   * The gateway's findings about this text, located by an adapter (`fromC2y`, `fromBim`). They are pushed into the editor
   * whenever they change, because the checks answer asynchronously; findings that are not about a range of this text are
   * for the Problems panel only.
   */
  diagnostics?: readonly Located[];
  /** What to offer while typing. It only offers: the gateway judges the text. */
  completions?: CompletionSource;
}

const clamp = (offset: number, length: number) => Math.max(0, Math.min(length, offset));

/** The findings that sit on a range of the text, as CodeMirror marks them. */
function markers(diagnostics: readonly Located[], length: number): Diagnostic[] {
  const marked: Diagnostic[] = [];
  for (const diagnostic of diagnostics) {
    const { where } = diagnostic;
    if (where.kind !== 'text') continue;
    const from = clamp(where.from, length);
    marked.push({
      from,
      to: Math.max(from, clamp(where.to, length)),
      severity: diagnostic.severity,
      message: diagnostic.message,
      source: diagnostic.code,
    });
  }
  return marked;
}

export function CodeEditor({
  value,
  onChange,
  readOnly = false,
  placeholder,
  minHeight = '200px',
  maxHeight = '600px',
  language = 'json',
  ariaLabel = 'Source editor',
  selection,
  diagnostics,
  completions,
}: CodeEditorProps) {
  const [view, setView] = useState<EditorView | null>(null);
  const linted = diagnostics !== undefined;

  const extensions = useMemo(() => {
    const list: Extension[] = [EditorView.lineWrapping, EditorView.contentAttributes.of({ 'aria-label': ariaLabel })];
    if (language === 'json') list.push(json());
    if (language === 'yaml') list.push(yaml());
    if (completions) list.push(autocompletion({ override: [completions] }));
    if (linted) list.push(lintGutter());
    return list;
  }, [ariaLabel, language, completions, linted]);

  // The cursor follows `selection` without a remount; only a change after the first placement takes the focus with it.
  const placed = useRef(false);
  useEffect(() => {
    if (!view || !selection) return;
    const length = view.state.doc.length;
    const anchor = clamp(selection.anchor, length);
    view.dispatch({ selection: { anchor, head: clamp(selection.head ?? selection.anchor, length) }, scrollIntoView: true });
    if (placed.current) view.focus();
    placed.current = true;
  }, [view, selection]);

  useEffect(() => {
    if (!view || !diagnostics) return;
    view.dispatch(setDiagnostics(view.state, markers(diagnostics, view.state.doc.length)));
  }, [view, diagnostics]);

  return (
    <div className="code-editor-wrapper">
      <CodeMirror
        value={value}
        onChange={onChange}
        onCreateEditor={setView}
        extensions={extensions}
        theme="light"
        readOnly={readOnly}
        placeholder={placeholder}
        basicSetup={{
          lineNumbers: true,
          highlightActiveLineGutter: true,
          highlightActiveLine: true,
          foldGutter: true,
          dropCursor: true,
          indentOnInput: true,
          bracketMatching: true,
          closeBrackets: true,
          autocompletion: !completions,
          highlightSelectionMatches: true,
        }}
        style={{
          minHeight,
          maxHeight,
          fontSize: '14px',
          border: '1px solid var(--color-border)',
          borderRadius: 'var(--radius-md)',
          overflow: 'auto',
        }}
      />
    </div>
  );
}
