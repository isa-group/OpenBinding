// Adapted from SPHERE frontend/src/modules/pricing-editor/layouts/editor-layout/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: the BIM problem editor's layout (`/problem-editor`), the same dark page as the composition editor's. It reads
// what to open from the address (`?org=&problem=&revision=` a problem version, `?template=` a template,
// `&composition=&compositionVersion=` a composition version to highlight, `?carry=1` the package a visitor kept while
// signing in) and holds OpenBinding's editor state (useProblemEditor) in the context once the account is known, since
// drafts are kept per account. Its dialogs are Open (a template, a problem version, the blank package), Import `.bim.zip`
// (a file of at most the package limit, read and checked as a package before it replaces the files, as one undo step) and
// Save (save-modal); there is no share link: a package is several files, kept as a draft or downloaded.

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { AnimatePresence } from 'framer-motion';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { problemsApi } from '../../../problem/api/problemsClient';
import { BIM_PACKAGE_LIMITS, BimPackageError, unzipPackage } from '../../../core/utils/bimZip';
import { problemEditorPath } from '../../../../routes/paths/problems';
import { useAuth } from '../../../auth/hooks/useAuth';
import { EditorDialog } from '../../../core/components/editor-chrome';
import FileUpload from '../../../core/components/file-upload-input';
import EditorSkeleton from '../../../core/components/skeletons/editor-skeleton';
import OpenModal, { type OpenChoice } from '../../components/open-modal';
import SaveModal from '../../components/save-modal';
import {
  ProblemEditorContext,
  type ProblemEditorMode,
  type SavedPackage,
} from '../../contexts/problemEditorContext';
import { carryDraft, useProblemEditor } from '../../hooks/useProblemEditor';
import { parseJson } from '../../utils/documents';
import EditorHeader from './editor-header';

const MiB = 1024 * 1024;

/** What the File menu opens: the Open dialog on one of its parts, the import or the save. */
type Dialog =
  { kind: 'open'; part: 'template' | 'version' } | { kind: 'import' } | { kind: 'save' };

interface EditorFrameProps {
  org: string | null;
  problem: string | null;
  revision: string | null;
  template: string | null;
  composition: string | null;
  compositionVersion: string | null;
  carry: boolean;
  blank: boolean;
  initialMode: ProblemEditorMode;
  delay?: number;
  children?: ReactNode;
}

function EditorFrame({
  org,
  problem,
  revision,
  template,
  composition,
  compositionVersion,
  carry,
  blank,
  initialMode,
  delay,
  children,
}: EditorFrameProps) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [mode, setMode] = useState<ProblemEditorMode>(initialMode);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [importIssue, setImportIssue] = useState('');
  const [saved, setSaved] = useState<SavedPackage | null>(null);
  const [problemName, setProblemName] = useState<{ key: string; name: string } | null>(null);

  const editor = useProblemEditor({
    org,
    userId: user?.id,
    problem,
    revision,
    template,
    composition,
    compositionVersion,
    blank,
    carry,
    delay,
  });

  // The name of the problem the address opened, for the "Editing … · from v…" chip; its slug until it is read.
  const nameKey = org && problem ? `${org}/${problem}` : null;
  useEffect(() => {
    if (!nameKey || !org || !problem) return undefined;
    let active = true;
    Promise.resolve()
      .then(() => problemsApi.get(org, problem))
      .then(
        found => {
          if (active && found?.name) setProblemName({ key: nameKey, name: found.name });
        },
        () => undefined
      );
    return () => {
      active = false;
    };
  }, [nameKey, org, problem]);

  // A package carried through the sign-in is opened once; the address forgets `carry` so a reload does not look for it again.
  const ready = editor.ready;
  useEffect(() => {
    if (!carry || !ready) return;
    const params = new URLSearchParams(location.search);
    params.delete('carry');
    const search = params.toString();
    void navigate(`${location.pathname}${search ? `?${search}` : ''}`, { replace: true });
  }, [carry, ready, location.pathname, location.search, navigate]);

  const close = useCallback(() => {
    setDialog(null);
    setImportIssue('');
  }, []);

  const open = (choice: OpenChoice) => {
    close();
    setSaved(null);
    if (choice.kind === 'template')
      void navigate(problemEditorPath(null, { template: choice.template }));
    else if (choice.kind === 'revision')
      void navigate(
        problemEditorPath(choice.org, { problem: choice.problem, revision: choice.revision })
      );
    else void navigate(problemEditorPath(null), { state: { blank: true } });
  };

  const importPackage = async (file: File) => {
    if (file.size > BIM_PACKAGE_LIMITS.compressedBytes) {
      setImportIssue(
        `${file.name} is larger than ${BIM_PACKAGE_LIMITS.compressedBytes / MiB} MiB, the largest package the gateway reads.`
      );
      return;
    }
    try {
      const files = await unzipPackage(await file.arrayBuffer());
      const root = parseJson(files['instance.json']);
      if (root?.apiVersion !== 'bim/v1' || root?.kind !== 'Instance') {
        setImportIssue(`${file.name} has no instance.json that is a bim/v1 Instance.`);
        return;
      }
      editor.replaceAll(files);
      setSaved(null);
      close();
    } catch (caught: unknown) {
      setImportIssue(
        caught instanceof BimPackageError
          ? caught.message
          : `${file.name} couldn’t be read as a .bim.zip package.`
      );
    }
  };

  /** Keep the package for the editor that opens after the sign-in, then sign in. */
  const signIn = () => {
    const params = new URLSearchParams(location.search);
    params.set('carry', '1');
    const from = `${location.pathname}?${params.toString()}`;
    void carryDraft(editor.current())
      .catch(() => undefined)
      .then(() => navigate('/authentication', { state: { from } }));
  };

  const value = useMemo(
    () => ({
      editor,
      mode,
      setMode,
      org,
      problem,
      problemName: problemName && problemName.key === nameKey ? problemName.name : null,
      composition,
      compositionVersion,
      saved,
    }),
    [editor, mode, org, problem, problemName, nameKey, composition, compositionVersion, saved]
  );

  return (
    <ProblemEditorContext.Provider value={value}>
      <div className="flex h-dvh flex-col bg-tp-surface-code">
        <EditorHeader
          onOpen={part => setDialog({ kind: 'open', part })}
          onBlank={() => open({ kind: 'blank' })}
          onImport={() => setDialog({ kind: 'import' })}
          onSave={() => setDialog({ kind: 'save' })}
          onSignIn={signIn}
        />
        <main className="relative flex min-h-0 min-w-0 flex-1 flex-col">{children}</main>
      </div>

      <AnimatePresence>
        {dialog?.kind === 'open' && (
          <OpenModal
            part={dialog.part}
            signedIn={Boolean(user)}
            initialOrg={org}
            onOpen={open}
            onClose={close}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {dialog?.kind === 'import' && (
          <EditorDialog title="Import a .bim.zip" onClose={close}>
            <p className="mt-2 text-center text-sm text-tp-steel">
              The package replaces the files in the editor. Undo brings them back.
            </p>
            <div className="mt-4">
              <FileUpload
                onSubmit={file => void importPackage(file)}
                submitButtonText="Open in the editor"
                accept={{ 'application/zip': ['.zip'] }}
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
        {dialog?.kind === 'save' && (
          <SaveModal
            onClose={close}
            onSaved={next => {
              setSaved(next);
              close();
            }}
          />
        )}
      </AnimatePresence>
    </ProblemEditorContext.Provider>
  );
}

/**
 * The problem editor's layout (`/problem-editor`): a dark page as tall as the window, its header, and the editor state shared
 * by the header, the dialogs and the page. What it opens comes from the address; visitors edit, check and download.
 */
export default function ProblemEditorLayout({
  children,
  delay,
}: {
  children?: ReactNode;
  /** The live check's delay in milliseconds (tests shorten it). */
  delay?: number;
}) {
  const [params] = useSearchParams();
  const location = useLocation();
  const { loading } = useAuth();
  const org = params.get('org');
  const problem = params.get('problem');
  const revision = params.get('revision');
  const template = params.get('template');
  const composition = params.get('composition');
  const compositionVersion = params.get('compositionVersion');
  const carry = params.get('carry') === '1';
  const blank = (location.state as { blank?: boolean } | null)?.blank === true;
  const initialMode: ProblemEditorMode = params.get('mode') === 'code' ? 'code' : 'visual';

  if (loading) {
    return (
      <div className="h-dvh bg-tp-surface-code" role="status" aria-label="Loading the editor">
        <EditorSkeleton />
      </div>
    );
  }

  return (
    <EditorFrame
      key={`${org ?? ''}/${problem ?? ''}@${revision ?? ''}`}
      org={org}
      problem={problem}
      revision={revision}
      template={template}
      composition={composition}
      compositionVersion={compositionVersion}
      carry={carry}
      blank={blank}
      initialMode={initialMode}
      delay={delay}
    >
      {children}
    </EditorFrame>
  );
}
