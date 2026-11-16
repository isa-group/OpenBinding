import { lazy, Suspense } from 'react';
import { Chip } from '../../../core/components/chip';
import type { Located } from '../../../core/diagnostics/located';
import { FileDiff } from '../../../core/components/composition-renderer/modes/comparison/FileDiff';
import type { WorkspaceFiles } from './documents';
import { fileLanguage, filePaths } from './editorModel';

const CodeEditor = lazy(() =>
  import('../../../../components/CodeEditor/CodeEditor').then(module => ({
    default: module.CodeEditor,
  }))
);

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

interface FilesPaneProps {
  files: WorkspaceFiles;
  baseline: WorkspaceFiles;
  path: string;
  onPath: (path: string) => void;
  /** The text of one file changed (one undo step). */
  onChange: (path: string, text: string) => void;
  /** The findings of the last check, located. */
  diagnostics: readonly Located[];
  selection?: { anchor: number; head: number };
  view: 'source' | 'changes';
  onView: (view: 'source' | 'changes') => void;
  /** JSON files whose text does not parse: the check waits for them. */
  unparsed: readonly string[];
}

/**
 * Every file of the package as text: the list, and the selected file in the code editor (JSON with the gateway's findings marked
 * where they are, BPMN as XML), or what changed in it since the package was opened.
 */
export function FilesPane({
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
}: FilesPaneProps) {
  const paths = filePaths(files);
  const shown = path in files ? path : paths[0];
  const findings = (file: string) =>
    diagnostics.filter(
      item => item.where.kind !== 'package' && item.where.file === file && item.severity !== 'info'
    ).length;
  const marked = diagnostics.filter(
    item => item.where.kind === 'text' && item.where.file === shown
  );
  const changed = (file: string) => baseline[file] !== files[file];

  return (
    <div className="pe-files">
      <nav className="pe-file-list" aria-label="Files of the package">
        <ul>
          {paths.map(file => {
            const count = findings(file);
            return (
              <li key={file}>
                <button
                  type="button"
                  className={file === shown ? 'is-selected' : undefined}
                  aria-current={file === shown ? 'true' : undefined}
                  onClick={() => onPath(file)}
                >
                  <code>{file}</code>
                  {changed(file) && <span className="pe-file-tag">changed</span>}
                  {unparsed.includes(file) && (
                    <span className="pe-file-tag is-error">not JSON</span>
                  )}
                  {count > 0 && (
                    <span className="pe-file-tag is-error">
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
        <div className="pe-file">
          <div className="pe-file-head">
            <h3>
              <code>{shown}</code>
            </h3>
            {changed(shown) ? <Chip tone="accent">Changed</Chip> : <Chip>As opened</Chip>}
            <div className="pe-segmented" role="group" aria-label="Show">
              <button
                type="button"
                aria-pressed={view === 'source'}
                onClick={() => onView('source')}
              >
                Source
              </button>
              <button
                type="button"
                aria-pressed={view === 'changes'}
                onClick={() => onView('changes')}
              >
                Changes
              </button>
            </div>
          </div>
          {view === 'source' ? (
            <Suspense
              fallback={
                <p className="pe-muted" role="status">
                  Loading the editor…
                </p>
              }
            >
              <CodeEditor
                key={shown}
                ariaLabel={`${shown} source`}
                language={fileLanguage(shown)}
                value={files[shown]}
                onChange={text => onChange(shown, text)}
                diagnostics={marked}
                selection={selection}
                minHeight="360px"
                maxHeight="70vh"
              />
            </Suspense>
          ) : (
            <FileDiff
              before={baseline[shown] ?? ''}
              after={files[shown]}
              beforeLabel="As opened"
              afterLabel="Now"
            />
          )}
        </div>
      )}
    </div>
  );
}
