// Adapted from SPHERE frontend/src/modules/pricing-editor/layouts/editor-layout/editor-header.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: OpenBinding's wordmark and "Problem editor"; the "Editing {problem} · from v{N}" chip names the problem version
// the address opened; the toggle is Visual (the panes) | Code (the package's files); File opens a template, a problem
// version (signed in) or the blank package, imports a `.bim.zip`, and holds Undo, Redo and Reset (the draft's 40 steps);
// Export downloads the `.bim.zip`; a live status pill says what the gateway's check found, next to Check now; "Save" opens
// the Save dialog when signed in, and "Sign in" keeps the package in this browser so it is opened again after the sign-in.
// The menus and the toggle are core/components/editor-chrome, shared with the composition editor; the account menu is the
// composition editor's.

import { useState } from 'react';
import {
  FiArrowUpRight,
  FiCornerUpLeft,
  FiCornerUpRight,
  FiDownload,
  FiFilePlus,
  FiFolder,
  FiLayers,
  FiRefreshCw,
  FiSave,
  FiUpload,
} from 'react-icons/fi';
import { Link } from 'react-router-dom';
import { useAuth } from '../../../auth/hooks/useAuth';
import EditorAccountMenu from '../../../composition-editor/components/editor-account-menu';
import { HeaderMenu, MENU_ITEM, ModeToggle } from '../../../core/components/editor-chrome';
import { useProblemEditorValue } from '../../hooks/useProblemEditorValue';
import { downloadPackage } from '../../services/export';
import { checkStatus, type CheckTone } from '../../utils/checkStatus';

interface Props {
  onOpen: (part: 'template' | 'version') => void;
  onBlank: () => void;
  onImport: () => void;
  onSave: () => void;
  onSignIn: () => void;
}

const PILL: Record<CheckTone, string> = {
  valid: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200',
  invalid: 'border-red-400/30 bg-red-400/10 text-red-200',
  busy: 'border-white/15 bg-white/5 text-white/70',
  waiting: 'border-amber-400/30 bg-amber-400/10 text-amber-200',
  none: 'border-white/15 bg-white/5 text-white/70',
};

export default function EditorHeader({ onOpen, onBlank, onImport, onSave, onSignIn }: Props) {
  const { user, loading } = useAuth();
  const { editor, mode, setMode, problem, problemName } = useProblemEditorValue();
  const [menu, setMenu] = useState<'file' | 'export' | null>(null);

  const opener = (name: 'file' | 'export') => (open: boolean) => setMenu(open ? name : null);
  const run = (action: () => void) => () => {
    action();
    setMenu(null);
  };

  const origin = editor.origin;
  const fromVersion =
    origin?.kind === 'revision' || origin?.kind === 'draft' ? origin.revision : null;
  const status = checkStatus(editor);
  const checkBlocked = editor.unparsed.length > 0 || editor.pausedMessage !== null;

  return (
    <header className="editor-header sticky top-0 z-40 grid min-h-14 shrink-0 grid-cols-[auto_1fr_auto] items-center gap-x-2 gap-y-1.5 border-b border-white/10 bg-tp-surface-code px-3 py-2 sm:flex sm:h-14 sm:flex-nowrap sm:px-4 sm:py-0">
      {/* Left: wordmark and where the editor is */}
      <div className="flex min-w-0 items-center gap-3">
        <Link
          to="/"
          className="text-xs font-semibold tracking-[0.22em] text-white/70 transition-colors hover:text-white"
        >
          OPENBINDING
        </Link>
        <span className="hidden text-white/30 md:inline" aria-hidden="true">
          /
        </span>
        <h1 className="sr-only font-sans text-xs font-normal text-white/60 md:not-sr-only md:inline md:truncate">
          Problem editor
        </h1>
        {problem ? (
          <span
            className="hidden max-w-[18rem] truncate rounded-full border border-white/10 bg-white/5 px-2 py-1 text-[10px] text-white/70 2xl:inline"
            title={`Editing ${problemName ?? problem}${fromVersion !== null ? ` from version ${fromVersion}` : ''}`}
          >
            Editing <span className="font-medium text-white/90">{problemName ?? problem}</span>
            {fromVersion !== null ? ` · from v${fromVersion}` : ''}
          </span>
        ) : null}
      </div>

      {/* Centre: the mode toggle and the live check */}
      <div className="col-span-3 row-start-2 flex flex-wrap items-center justify-center gap-2 sm:mx-auto sm:flex-nowrap">
        <ModeToggle
          modes={[
            { id: 'visual', label: 'Visual' },
            { id: 'code', label: 'Code' },
          ]}
          value={mode}
          onChange={setMode}
          layoutId="problem-editor-mode-bg"
        />
        <span
          role="status"
          aria-live="polite"
          data-testid="pe-check-status"
          title={status.text || undefined}
          className={`max-w-[14rem] truncate rounded-full border px-2.5 py-1 text-[11px] font-medium empty:hidden ${PILL[status.tone]}`}
        >
          {status.text}
        </span>
        <button
          type="button"
          onClick={editor.checkNow}
          disabled={checkBlocked}
          className="inline-flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1.5 text-[11px] font-medium text-white/70 transition-colors hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
        >
          <FiRefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
          Check now
        </button>
      </div>

      {/* Right: actions */}
      <div className="col-start-3 row-start-1 ml-auto flex items-center gap-0.5 sm:ml-0 sm:gap-1">
        <HeaderMenu label="File" open={menu === 'file'} onOpenChange={opener('file')} align="left">
          <button
            type="button"
            role="menuitem"
            onClick={run(() => onOpen('template'))}
            className={MENU_ITEM}
          >
            <FiLayers className="h-3.5 w-3.5" aria-hidden="true" />
            Open a template…
          </button>
          {user ? (
            <button
              type="button"
              role="menuitem"
              onClick={run(() => onOpen('version'))}
              className={MENU_ITEM}
            >
              <FiFolder className="h-3.5 w-3.5" aria-hidden="true" />
              Open a problem version…
            </button>
          ) : null}
          <button type="button" role="menuitem" onClick={run(onBlank)} className={MENU_ITEM}>
            <FiFilePlus className="h-3.5 w-3.5" aria-hidden="true" />
            Blank package
          </button>
          <button type="button" role="menuitem" onClick={run(onImport)} className={MENU_ITEM}>
            <FiUpload className="h-3.5 w-3.5" aria-hidden="true" />
            Import .bim.zip
          </button>
          <span className="my-1 block h-px bg-white/10" role="separator" />
          <button
            type="button"
            role="menuitem"
            disabled={!editor.canUndo}
            onClick={run(editor.undo)}
            className={MENU_ITEM}
          >
            <FiCornerUpLeft className="h-3.5 w-3.5" aria-hidden="true" />
            Undo
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!editor.canRedo}
            onClick={run(editor.redo)}
            className={MENU_ITEM}
          >
            <FiCornerUpRight className="h-3.5 w-3.5" aria-hidden="true" />
            Redo
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!editor.dirty}
            onClick={run(editor.reset)}
            className={MENU_ITEM}
          >
            <FiRefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
            Reset
          </button>
        </HeaderMenu>

        <HeaderMenu
          label="Export"
          open={menu === 'export'}
          onOpenChange={opener('export')}
          align="right"
        >
          <button
            type="button"
            role="menuitem"
            onClick={run(() => downloadPackage(editor.current()))}
            className={MENU_ITEM}
          >
            <FiDownload className="h-3.5 w-3.5" aria-hidden="true" />
            Download .bim.zip
          </button>
        </HeaderMenu>

        <span className="mx-1 h-5 w-px bg-white/10" aria-hidden="true" />

        {loading ? (
          <span className="h-8 w-24 animate-pulse rounded-lg bg-white/10" />
        ) : user ? (
          <>
            <button
              type="button"
              onClick={onSave}
              disabled={!editor.savable}
              title={editor.savable ? undefined : 'Save once the package passes its check'}
              className="group inline-flex cursor-pointer items-center gap-2 rounded-lg bg-tp-accent px-3 py-2 text-xs font-semibold text-tp-on-primary shadow-sm transition-all hover:bg-tp-accent-hover hover:shadow-md disabled:cursor-not-allowed disabled:opacity-50"
            >
              <FiSave className="h-4 w-4" aria-hidden="true" />
              Save
            </button>
            <EditorAccountMenu />
          </>
        ) : (
          <button
            type="button"
            onClick={onSignIn}
            className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-white/15 px-3 py-2 text-xs font-medium text-white/80 transition-colors hover:border-white/30 hover:bg-white/10 hover:text-white"
          >
            Sign in
            <FiArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        )}
      </div>
    </header>
  );
}
