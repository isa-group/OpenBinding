import { useState, useSyncExternalStore } from 'react';
import { Link2, Redo2, RotateCcw, Undo2, UploadCloud } from 'lucide-react';
import { Action } from '../../components/ui/Action';
import { Modal } from '../../components/ui/Modal';
import { Notice } from '../../components/ui/Notice';
import { Skeleton } from '../../components/ui/Skeleton';
import { TabBar, TabPanel } from '../../components/ui/TabBar';
import { useCopy } from '../../components/ui/useCopy';
import type {
  CompositionVersionView,
  CompositionView,
  SealResult,
} from '../../modules/core/api/types';
import { counts, type Located } from '../../shared/diagnostics/located';
import { ProblemsPanel } from '../../widgets/problems-panel/ProblemsPanel';
import { CodePane } from './CodePane';
import { SealBar, ValuesOnSeal } from './SealBar';
import { UploadDialog } from './UploadDialog';
import { useCompositionEditor, type SealOutcome } from './useCompositionEditor';
import { VisualPane } from './VisualPane';
import './CompositionEditor.css';

export type EditorPane = 'code' | 'visual' | 'problems';

const NARROW = '(max-width: 640px)';

/** Below 640 px the panes are tabs. */
function useNarrow(): boolean {
  return useSyncExternalStore(
    notify => {
      const list = typeof window.matchMedia === 'function' ? window.matchMedia(NARROW) : null;
      list?.addEventListener?.('change', notify);
      return () => list?.removeEventListener?.('change', notify);
    },
    () => (typeof window.matchMedia === 'function' ? window.matchMedia(NARROW).matches : false),
    () => false
  );
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** "Problems (2 errors, 1 warning)": the tab of the Problems pane on a phone. */
function problemsTab(diagnostics: readonly Located[]): string {
  const tally = counts(diagnostics);
  const parts = [
    tally.error ? plural(tally.error, 'error', 'errors') : '',
    tally.warning ? plural(tally.warning, 'warning', 'warnings') : '',
    tally.info ? plural(tally.info, 'note', 'notes') : '',
  ].filter(Boolean);
  return parts.length ? `Problems (${parts.join(', ')})` : 'Problems';
}

interface CompositionEditorProps {
  org: string;
  composition: Pick<CompositionView, 'slug' | 'kind' | 'name'>;
  /** The version the editor starts from; null for a composition with no version. */
  version: Pick<CompositionVersionView, 'id' | 'label'> | null;
  userId: string | null | undefined;
  /** MEMBER: edits and seals. Below it the code is read and checked, never sealed. */
  canSeal: boolean;
  /** The pane the editor opens on (the New version menu chooses it). */
  initialPane?: 'code' | 'visual';
  /** Open the upload dialog at once. */
  openUpload?: boolean;
  /** A new version was sealed (201): the draft is already forgotten. */
  onSealed: (result: SealResult) => void;
  /** Where a version opens, by label. */
  versionHref: (label: string) => string;
  delays?: { validate?: number; check?: number };
}

/**
 * The `editor` mode of a composition (C6): the Composition2Yaml code with the gateway's lint and completion, a visual form over
 * the document as written, drafts with 40 undo steps, upload, a share link and the seal. On a phone, code, visual and problems are
 * tabs, and the seal bar stays at the bottom.
 */
export function CompositionEditor({
  org,
  composition,
  version,
  userId,
  canSeal,
  initialPane = 'code',
  openUpload = false,
  onSealed,
  versionHref,
  delays,
}: CompositionEditorProps) {
  const narrow = useNarrow();
  const [pane, setPane] = useState<EditorPane>(initialPane);
  const editor = useCompositionEditor({
    org,
    composition,
    version,
    userId,
    delays,
    visual: !narrow || pane === 'visual',
  });
  const [selection, setSelection] = useState<{ anchor: number; head: number } | undefined>();
  const [uploading, setUploading] = useState(openUpload && canSeal);
  const [outcome, setOutcome] = useState<{
    text: string;
    outcome: Exclude<SealOutcome, { kind: 'created' }>;
  } | null>(null);
  const { copy, status: copied } = useCopy();
  const readOnly = !canSeal;

  if (editor.loadError !== null) {
    return (
      <Notice
        tone="error"
        action={
          <Action variant="secondary" size="sm" onClick={editor.retry}>
            Retry
          </Action>
        }
      >
        {`The text of version ${version?.label ?? ''} couldn’t be loaded${editor.loadError ? `: ${editor.loadError}` : '.'}`}
      </Notice>
    );
  }
  if (!editor.ready) {
    return (
      <div role="status" aria-busy="true">
        <span className="sr-only">Loading the editor…</span>
        <Skeleton variant="panel" />
      </div>
    );
  }

  const select = (diagnostic: Located) => {
    if (diagnostic.where.kind !== 'text') return;
    setSelection({ anchor: diagnostic.where.from, head: diagnostic.where.to });
    if (narrow) setPane('code');
  };

  const seal = async () => {
    const sent = editor.text;
    const result = await editor.seal();
    if (result.kind === 'created') onSealed(result.result);
    else setOutcome({ text: sent, outcome: result });
  };

  const code = (
    <CodePane
      text={editor.text}
      onChange={editor.setText}
      readOnly={readOnly}
      diagnostics={editor.diagnostics}
      completions={editor.completions}
      selection={selection}
      onSelect={select}
      withProblems={!narrow}
    />
  );
  const visual = (
    <VisualPane
      document={editor.document}
      issue={editor.documentIssue}
      facts={editor.facts}
      mutate={editor.mutate}
      busy={editor.mutating}
      readOnly={readOnly}
    />
  );

  return (
    <div className="ce">
      <p className="cmp-muted">
        {version ? (
          <>
            Editing from version <strong>{version.label}</strong>. Sealing makes a new version; this
            one stays as it is.
          </>
        ) : (
          <>No version yet. Start from this document and seal its first version.</>
        )}
      </p>

      <div className="ce-toolbar" role="toolbar" aria-label="Editor">
        {!readOnly && (
          <>
            <Action
              size="sm"
              variant="ghost"
              onClick={() => editor.undo()}
              disabled={!editor.canUndo}
            >
              <Undo2 aria-hidden="true" />
              Undo
            </Action>
            <Action
              size="sm"
              variant="ghost"
              onClick={() => editor.redo()}
              disabled={!editor.canRedo}
            >
              <Redo2 aria-hidden="true" />
              Redo
            </Action>
            <Action
              size="sm"
              variant="ghost"
              onClick={() => editor.discard()}
              disabled={!editor.dirty}
            >
              <RotateCcw aria-hidden="true" />
              Discard changes
            </Action>
            <Action size="sm" variant="ghost" onClick={() => setUploading(true)}>
              <UploadCloud aria-hidden="true" />
              Upload
            </Action>
          </>
        )}
        <Action size="sm" variant="ghost" onClick={() => void copy(editor.shareLink(), 'share')}>
          <Link2 aria-hidden="true" />
          Copy share link
        </Action>
        <span className="ce-status" role="status" aria-live="polite">
          {copied('share') === 'copied' &&
            'Share link copied. It carries the text in its fragment; nothing is sent to the gateway.'}
          {copied('share') === 'failed' && 'The share link couldn’t be copied.'}
          {copied('share') === 'idle' &&
            (editor.pausedMessage ??
              (editor.checking ? 'Checking…' : editor.dirty ? 'Unsaved changes' : ''))}
        </span>
      </div>

      {editor.draftIssue && <Notice tone="warning">{editor.draftIssue}</Notice>}
      {editor.linkIssue && (
        <Notice
          tone="error"
          action={
            <Action variant="secondary" size="sm" onClick={editor.dismissLinkIssue}>
              Dismiss
            </Action>
          }
        >
          {editor.linkIssue}
        </Notice>
      )}
      {editor.lintIssue && (
        <Notice tone="warning">{`The gateway couldn’t check the text: ${editor.lintIssue}`}</Notice>
      )}

      {narrow ? (
        <>
          <TabBar
            items={[
              { id: 'code', label: 'Code' },
              { id: 'visual', label: 'Visual' },
              { id: 'problems', label: problemsTab(editor.diagnostics) },
            ]}
            value={pane}
            onChange={id => setPane(id as EditorPane)}
            ariaLabel="Editor panes"
            prefix="ce-pane"
          />
          <TabPanel prefix="ce-pane" active={pane}>
            {pane === 'code' && code}
            {pane === 'visual' && visual}
            {pane === 'problems' && (
              <ProblemsPanel diagnostics={editor.diagnostics} onSelect={select} />
            )}
          </TabPanel>
        </>
      ) : (
        <div className="ce-panes">
          {code}
          <div className="ce-visual-column" aria-label="Visual editor" role="region">
            {visual}
          </div>
        </div>
      )}

      {editor.check && (
        <ValuesOnSeal
          check={editor.check}
          canonical={editor.check.content === editor.text}
          readOnly={readOnly}
          onUseCanonical={() => {
            if (editor.check?.content) editor.setText(editor.check.content);
          }}
        />
      )}

      <SealBar
        label={editor.label}
        onLabel={editor.setLabel}
        canSeal={canSeal}
        errors={editor.errors}
        sealing={editor.sealing}
        onSeal={() => void seal()}
        outcome={outcome && outcome.text === editor.text ? outcome.outcome : null}
        versionHref={versionHref}
      />

      {uploading && (
        <UploadDialog
          onClose={() => setUploading(false)}
          onLoad={text => {
            setUploading(false);
            editor.bringIn(text, 'upload');
          }}
        />
      )}
      {editor.incoming && (
        <Modal title="Replace your unsaved changes?" size="sm" onClose={editor.declineIncoming}>
          <p>
            {editor.incoming.source === 'upload'
              ? 'The uploaded file'
              : 'The composition in this link'}{' '}
            replaces the text you have not sealed. Undo brings your text back.
          </p>
          <div className="ui-modal-actions">
            <Action variant="secondary" onClick={editor.declineIncoming}>
              Keep my changes
            </Action>
            <Action variant="primary" onClick={editor.acceptIncoming}>
              Replace
            </Action>
          </div>
        </Modal>
      )}
    </div>
  );
}
