// Pattern only, after SPHERE frontend/src/modules/pricing-editor/pages/pricing2yaml-editor/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// The problem editor's Code mode: every file of the package in the bundled Monaco (core/components/code-editor), JSON and
// BPMN XML, with the gateway's findings as markers (core/utils/located-markers) as SPHERE publishes its linter's; and what
// changed in a file since the package was opened, drawn by the composition module's file diff (SPHERE's file-diff-view).

import { useEffect, useState } from 'react';
import type * as Monaco from 'monaco-editor';
import CodeEditor from '../../../core/components/code-editor';
import EditorSkeleton from '../../../core/components/skeletons/editor-skeleton';
import type { Located } from '../../../core/diagnostics/located';
import { locatedMarkers } from '../../../core/utils/located-markers';
import FileDiffView from '../../../composition/components/version-diff/file-diff-view';
import type { WorkspaceFiles } from '../../utils/documents';
import { fileLanguage, filePaths } from '../../utils/editorModel';

/** Namespace under which the gateway's findings own their markers, so they never clear Monaco's own. */
const MARKER_OWNER = 'bim-gateway';

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** Where the caret goes in a file: a new object moves it (a finding, a rule, a matrix cell sent here). */
export interface FileSelection {
  path: string;
  anchor: number;
  head: number;
}

interface CodePaneProps {
  files: WorkspaceFiles;
  baseline: WorkspaceFiles;
  path: string;
  onPath: (path: string) => void;
  /** The text of one file changed (one undo step). */
  onChange: (path: string, text: string) => void;
  /** The findings of the last check, located. */
  diagnostics: readonly Located[];
  selection: FileSelection | null;
  view: 'source' | 'changes';
  onView: (view: 'source' | 'changes') => void;
  /** JSON files whose text does not parse: the check waits for them. */
  unparsed: readonly string[];
}

const TAG = 'rounded-full px-1.5 text-[10px] font-medium';

export function CodePane({
  files,
  baseline,
  path,
  onPath,
  onChange,
  diagnostics,
  selection,
  view,
  onView,
  unparsed,
}: CodePaneProps) {
  const [monaco, setMonaco] = useState<typeof Monaco | null>(null);
  const [editor, setEditor] = useState<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const paths = filePaths(files);
  const shown = path in files ? path : paths[0];
  const text = shown === undefined ? '' : files[shown];
  const findings = (file: string) =>
    diagnostics.filter(
      item => item.where.kind !== 'package' && item.where.file === file && item.severity !== 'info'
    ).length;
  const changed = (file: string) => baseline[file] !== files[file];

  // The gateway's findings in this file as markers: the squiggles and the hover messages.
  useEffect(() => {
    const model = editor?.getModel();
    if (!monaco || !model || shown === undefined || view !== 'source') return undefined;
    monaco.editor.setModelMarkers(
      model,
      MARKER_OWNER,
      locatedMarkers(diagnostics, model.getValue(), shown, 'BIM')
    );
    return () => {
      if (!model.isDisposed()) monaco.editor.setModelMarkers(model, MARKER_OWNER, []);
    };
  }, [monaco, editor, diagnostics, shown, text, view]);

  // The caret goes where it was sent, once the file is the one on screen.
  useEffect(() => {
    const model = editor?.getModel();
    if (!editor || !model || !selection || selection.path !== shown || view !== 'source') return;
    const start = model.getPositionAt(selection.anchor);
    const end = model.getPositionAt(selection.head);
    editor.setSelection({
      startLineNumber: start.lineNumber,
      startColumn: start.column,
      endLineNumber: end.lineNumber,
      endColumn: end.column,
    });
    editor.revealLineInCenter(start.lineNumber);
    editor.focus();
  }, [editor, selection, shown, view]);

  return (
    <div className="flex h-full min-h-0 flex-col md:flex-row">
      <nav
        aria-label="Files of the package"
        className="shrink-0 overflow-x-auto border-b border-white/10 bg-tp-surface-code md:w-60 md:overflow-y-auto md:border-r md:border-b-0"
      >
        <ul className="flex gap-0.5 p-1.5 md:flex-col">
          {paths.map(file => {
            const count = findings(file);
            const selected = file === shown;
            return (
              <li key={file} className="shrink-0">
                <button
                  type="button"
                  aria-current={selected ? 'true' : undefined}
                  onClick={() => onPath(file)}
                  className={`flex w-full cursor-pointer flex-wrap items-center gap-x-2 gap-y-0.5 rounded-md border-l-2 px-2.5 py-1.5 text-left text-xs transition-colors ${selected ? 'border-l-tp-primary bg-white/10 text-white' : 'border-l-transparent text-white/70 hover:bg-white/5 hover:text-white'}`}
                >
                  <code className="font-mono [overflow-wrap:anywhere]">{file}</code>
                  {changed(file) && (
                    <span className={`${TAG} bg-white/10 text-white/70`}>changed</span>
                  )}
                  {unparsed.includes(file) && (
                    <span className={`${TAG} bg-red-400/15 text-red-200`}>not JSON</span>
                  )}
                  {count > 0 && (
                    <span className={`${TAG} bg-red-400/15 text-red-200`}>
                      {plural(count, 'finding', 'findings')}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      </nav>
      {shown !== undefined && (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-white/10 bg-tp-surface-code px-3 py-1.5">
            <h2 className="min-w-0 truncate font-mono text-xs text-white/80">{shown}</h2>
            <span
              className={`${TAG} ${changed(shown) ? 'bg-tp-primary/30 text-white' : 'bg-white/10 text-white/60'}`}
            >
              {changed(shown) ? 'Changed' : 'As opened'}
            </span>
            <div
              className="ml-auto inline-flex overflow-hidden rounded-md border border-white/10"
              role="group"
              aria-label="Show"
            >
              {(['source', 'changes'] as const).map(option => (
                <button
                  key={option}
                  type="button"
                  aria-pressed={view === option}
                  onClick={() => onView(option)}
                  className={`cursor-pointer px-3 py-1 text-[11px] font-medium transition-colors ${view === option ? 'bg-white/15 text-white' : 'text-white/60 hover:text-white'}`}
                >
                  {option === 'source' ? 'Source' : 'Changes'}
                </button>
              ))}
            </div>
          </div>
          {view === 'source' ? (
            <div className="min-h-[360px] flex-1 md:min-h-0">
              <CodeEditor
                height="100%"
                path={shown}
                language={fileLanguage(shown)}
                ariaLabel={`${shown} source`}
                value={text}
                onChange={value => {
                  if (value !== undefined && value !== files[shown]) onChange(shown, value);
                }}
                onMount={(mounted, instance) => {
                  setEditor(mounted);
                  setMonaco(instance as unknown as typeof Monaco);
                }}
                loading={<EditorSkeleton />}
              />
            </div>
          ) : (
            <div
              role="region"
              aria-label={`Changes in ${shown}`}
              className="min-h-0 flex-1 overflow-y-auto bg-tp-surface p-3"
            >
              <FileDiffView
                before={baseline[shown] ?? ''}
                after={text}
                beforeLabel="As opened"
                afterLabel="Now"
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
