// Adapted from SPHERE frontend/src/modules/pricing-editor/layouts/editor-layout/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: the layout reads what to open from the address (`?source=org/slug&version=&mode=`, `?org=`) and holds
// OpenBinding's editor state (useCompositionEditor) in the context, once the account is known, since drafts are kept per
// account; the share link is the full `#composition=` encoding only (no short cached links, plan §13); Import YAML reads a
// file of at most 256 KiB; a text brought in over unsaved changes (an import, a share link) asks before it replaces them;
// the Publish dialog is opened from here; the dialogs are labelled, close on Escape, and the share dialog says that the link
// carries the text and nothing is sent to the gateway.

import { useCallback, useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Link, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../../auth/hooks/useAuth';
import { readApiError } from '../../../core/api/errors';
import type { CompositionVersionView, CompositionView } from '../../../core/api/types';
import ConfirmModal from '../../../core/components/confirm-modal';
import CopyToClipboardIcon from '../../../core/components/copy-icon';
import FileUpload from '../../../core/components/file-upload-input';
import EditorSkeleton from '../../../core/components/skeletons/editor-skeleton';
import { compositionsApi } from '../../../composition/api/compositionsApi';
import {
  EditorValueContext,
  type EditorMode,
  type EditorSource,
} from '../../contexts/editorValueContext';
import { UPLOAD_LIMIT_BYTES, useCompositionEditor } from '../../hooks/useCompositionEditor';
import EditorHeader from './editor-header';
import PublishModal from './publish-modal';

interface Opened {
  composition: Pick<CompositionView, 'slug' | 'kind' | 'name'>;
  version: Pick<CompositionVersionView, 'id' | 'label'> | null;
}

/** A dialog of the editor: SPHERE's backdrop and card, labelled by its title. */
function EditorDialog({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const titleId = useId();
  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [onClose]);
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-tp-ink/60 p-4"
      role="presentation"
      onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 8 }}
        transition={{ duration: 0.2, ease: 'easeOut' }}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="w-full max-w-[500px] rounded-xl border border-tp-hairline bg-tp-canvas p-6 shadow-elevation-4"
        onClick={event => event.stopPropagation()}
      >
        <h2 id={titleId} className="text-center font-display text-lg font-semibold text-tp-ink">
          {title}
        </h2>
        {children}
      </motion.div>
    </motion.div>
  );
}

function EditorFrame({
  opened,
  source,
  organization,
  initialMode,
  children,
}: {
  opened: Opened | null;
  source: EditorSource | null;
  organization: string | null;
  initialMode: EditorMode;
  children?: ReactNode;
}) {
  const { user } = useAuth();
  const [editorMode, setEditorMode] = useState<EditorMode>(initialMode);
  const [sharedLinkModalOpen, setSharedLinkModalOpen] = useState(false);
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [publishModalOpen, setPublishModalOpen] = useState(false);
  const [importIssue, setImportIssue] = useState('');
  const [shareLinkValue, setShareLinkValue] = useState('');

  const editor = useCompositionEditor({
    org: source?.org ?? null,
    composition: opened?.composition ?? null,
    version: opened?.version ?? null,
    userId: user?.id,
    visual: editorMode === 'visual',
  });

  const onSubmitImport = async (file: File) => {
    if (file.size > UPLOAD_LIMIT_BYTES) {
      setImportIssue(
        `${file.name} is larger than 256 KiB, the largest document the gateway reads.`
      );
      return;
    }
    const text = await file.text();
    setImportModalOpen(false);
    setImportIssue('');
    editor.bringIn(text, 'upload');
  };

  const closeShare = useCallback(() => setSharedLinkModalOpen(false), []);
  const closeImport = useCallback(() => {
    setImportModalOpen(false);
    setImportIssue('');
  }, []);
  const closePublish = useCallback(() => setPublishModalOpen(false), []);

  const value = useMemo(
    () => ({ editor, editorMode, setEditorMode, source, organization }),
    [editor, editorMode, source, organization]
  );

  return (
    <EditorValueContext.Provider value={value}>
      <div className="flex h-dvh flex-col bg-tp-surface-code">
        <EditorHeader
          onShareLink={() => {
            // The link is made once per opening of the dialog, from the text at that moment.
            setShareLinkValue(editor.shareLink());
            setSharedLinkModalOpen(true);
          }}
          onImport={() => setImportModalOpen(true)}
          onPublish={() => setPublishModalOpen(true)}
        />
        <main className="relative flex min-h-0 min-w-0 flex-1">{children}</main>
      </div>

      <AnimatePresence>
        {sharedLinkModalOpen && (
          <EditorDialog title="Share your composition" onClose={closeShare}>
            <p className="mt-2 text-center text-sm text-tp-steel">
              Share this link to let others view and edit their own copy.
            </p>
            <p className="mt-3 rounded-lg bg-tp-surface px-3 py-2 text-center text-xs text-tp-steel">
              The link carries the whole text in its fragment: nothing is sent to the gateway. A
              large document may make a link longer than some browsers accept.
            </p>
            <div className="mt-4 flex justify-center">
              <CopyToClipboardIcon value={shareLinkValue} />
            </div>
          </EditorDialog>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {importModalOpen && (
          <EditorDialog title="Import YAML" onClose={closeImport}>
            <div className="mt-4">
              <FileUpload
                onSubmit={file => void onSubmitImport(file)}
                submitButtonText="Open in the editor"
                accept={{ 'application/yaml': ['.yaml', '.yml'], 'text/yaml': ['.yaml', '.yml'] }}
              />
            </div>
            {importIssue && (
              <p role="alert" className="mt-3 text-center text-xs text-tp-error-text">
                {importIssue}
              </p>
            )}
          </EditorDialog>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {publishModalOpen ? <PublishModal onClose={closePublish} /> : null}
      </AnimatePresence>

      <AnimatePresence>
        {editor.incoming && (
          <ConfirmModal
            message={`${editor.incoming.source === 'upload' ? 'The imported file' : 'The composition in this link'} replaces the text you have not published. Undo brings your text back.`}
            onConfirm={editor.acceptIncoming}
            onCancel={editor.declineIncoming}
            confirmLabel="Replace"
            cancelLabel="Keep my changes"
          />
        )}
      </AnimatePresence>
    </EditorValueContext.Provider>
  );
}

type Resolved =
  | { status: 'loading' }
  | { status: 'ready'; opened: Opened | null; source: EditorSource | null }
  | { status: 'error'; message: string };

/**
 * The standalone editor's layout (`/editor`): a dark page as tall as the window, its header, and the editor state shared by
 * the header, the dialogs and the page. What it opens comes from the address.
 */
export default function EditorLayout({ children }: { children?: ReactNode }) {
  const [params] = useSearchParams();
  const { loading } = useAuth();
  const sourceParam = params.get('source');
  const versionParam = params.get('version');
  const initialMode: EditorMode = params.get('mode') === 'visual' ? 'visual' : 'code';
  const organization = params.get('org');
  const [resolved, setResolved] = useState<Resolved>(
    sourceParam ? { status: 'loading' } : { status: 'ready', opened: null, source: null }
  );

  useEffect(() => {
    if (!sourceParam) return undefined;
    const [org, slug] = sourceParam.split('/');
    let active = true;
    void (async () => {
      const { value: view } = await compositionsApi.get(org, slug);
      const version = versionParam
        ? await compositionsApi.version(org, slug, versionParam)
        : (view.latest_version ?? null);
      if (!active) return;
      setResolved({
        status: 'ready',
        opened: {
          composition: { slug: view.slug, kind: view.kind, name: view.name },
          version: version ? { id: version.id, label: version.label } : null,
        },
        source: {
          org,
          slug,
          name: view.name,
          kind: view.kind,
          version: version?.label ?? null,
        },
      });
    })().catch((caught: unknown) => {
      if (active) setResolved({ status: 'error', message: readApiError(caught).message });
    });
    return () => {
      active = false;
    };
  }, [sourceParam, versionParam]);

  if (resolved.status === 'error') {
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-3 bg-tp-surface-code px-4 text-center">
        <p className="font-display text-lg font-semibold text-white">
          There is no composition to edit
        </p>
        <p className="max-w-md text-sm text-white/70">
          This composition or version is unavailable. Sign in if you have access to a private
          composition.{resolved.message ? ` (${resolved.message})` : ''}
        </p>
        <Link to="/editor" reloadDocument className="text-sm font-medium text-white underline">
          Start from the starter instead
        </Link>
      </div>
    );
  }

  if (resolved.status === 'loading' || loading) {
    return (
      <div className="h-dvh bg-tp-surface-code" role="status" aria-label="Loading the editor">
        <EditorSkeleton />
      </div>
    );
  }

  return (
    <EditorFrame
      key={`${sourceParam ?? ''}@${versionParam ?? ''}`}
      opened={resolved.opened}
      source={resolved.source}
      organization={organization}
      initialMode={initialMode}
    >
      {children}
    </EditorFrame>
  );
}
