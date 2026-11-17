// Adapted from SPHERE frontend/src/modules/pricing-editor/layouts/editor-layout/editor-header.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: OpenBinding's wordmark and "Composition editor"; the "Editing {name} · from {version}" chip names a composition
// version; the visual pane writes each change to the text at once, so leaving it asks nothing and the toggle has no unsaved
// dot; File holds Undo and Redo (the draft's 40 steps) next to Reset, Import YAML and Clear, each undoable; Export downloads
// `{composition}-{version}.yaml` and opens the share link; Docs is the Composition2Yaml reference (`/language`); "Publish"
// opens the Publish dialog when signed in, and "Sign in" carries the text in the address so it survives the sign-in; the
// menus are menus to assistive technology and close on Escape; the toggle is a pair of pressed buttons; Publish is on the
// accent, which reaches 4.5:1 under its white label. The menus and the toggle are core/components/editor-chrome, shared
// with the problem editor.

import { useState } from 'react';
import {
  FiArrowUpRight,
  FiCornerUpLeft,
  FiCornerUpRight,
  FiDownload,
  FiLink,
  FiMinus,
  FiRefreshCw,
  FiUpload,
  FiUploadCloud,
} from 'react-icons/fi';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../../../auth/hooks/useAuth';
import { compositionFragment } from '../../../core/utils/sphere/composition-fragment';
import { HeaderMenu, MENU_ITEM as ITEM, ModeToggle } from '../../../core/components/editor-chrome';
import type { EditorMode } from '../../contexts/editorValueContext';
import { useEditorValue } from '../../hooks/useEditorValue';
import { downloadYaml } from '../../services/export';
import EditorAccountMenu from '../../components/editor-account-menu';

interface Props {
  onShareLink: () => void;
  onImport: () => void;
  onPublish: () => void;
}

export default function EditorHeader({ onShareLink, onImport, onPublish }: Props) {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, loading } = useAuth();
  const { editor, editorMode, setEditorMode, source } = useEditorValue();
  const [menu, setMenu] = useState<'file' | 'export' | null>(null);

  const opener = (name: 'file' | 'export') => (open: boolean) => setMenu(open ? name : null);
  const run = (action: () => void) => () => {
    action();
    setMenu(null);
  };

  const handleModeToggle = (mode: EditorMode) => setEditorMode(mode);

  const signIn = () =>
    void navigate('/authentication', {
      state: { from: `${location.pathname}${location.search}${compositionFragment(editor.text)}` },
    });

  return (
    <header className="editor-header sticky top-0 z-40 grid min-h-14 shrink-0 grid-cols-[auto_1fr_auto] items-center gap-x-2 gap-y-1 border-b border-white/10 bg-tp-surface-code px-3 py-2 sm:flex sm:h-14 sm:flex-nowrap sm:px-4 sm:py-0">
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
          Composition editor
        </h1>
        {source ? (
          <span
            className="hidden max-w-[18rem] truncate rounded-full border border-white/10 bg-white/5 px-2 py-1 text-[10px] text-white/70 xl:inline"
            title={`Editing ${source.name}${source.version ? ` from version ${source.version}` : ''}`}
          >
            Editing <span className="font-medium text-white/90">{source.name}</span>
            {source.version ? ` · from ${source.version}` : ' · first version'}
          </span>
        ) : null}
      </div>

      {/* Centre: mode toggle */}
      <div className="col-span-3 row-start-2 justify-self-center sm:absolute sm:top-1/2 sm:left-1/2 sm:-translate-x-1/2 sm:-translate-y-1/2">
        <ModeToggle
          modes={[
            { id: 'code', label: 'Code' },
            { id: 'visual', label: 'Visual' },
          ]}
          value={editorMode}
          onChange={handleModeToggle}
          layoutId="editor-mode-bg"
        />
      </div>

      {/* Right: actions */}
      <div className="col-start-3 row-start-1 ml-auto flex items-center gap-0.5 sm:gap-1">
        <HeaderMenu label="File" open={menu === 'file'} onOpenChange={opener('file')} align="left">
          <button
            type="button"
            role="menuitem"
            disabled={!editor.canUndo}
            onClick={run(editor.undo)}
            className={ITEM}
          >
            <FiCornerUpLeft className="h-3.5 w-3.5" aria-hidden="true" />
            Undo
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!editor.canRedo}
            onClick={run(editor.redo)}
            className={ITEM}
          >
            <FiCornerUpRight className="h-3.5 w-3.5" aria-hidden="true" />
            Redo
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!editor.dirty}
            onClick={run(editor.discard)}
            className={ITEM}
          >
            <FiRefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
            Reset
          </button>
          <button type="button" role="menuitem" onClick={run(onImport)} className={ITEM}>
            <FiUpload className="h-3.5 w-3.5" aria-hidden="true" />
            Import YAML
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={run(() => editor.setText(''))}
            className={ITEM}
          >
            <FiMinus className="h-3.5 w-3.5" aria-hidden="true" />
            Clear
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
            onClick={run(() => downloadYaml(editor.text))}
            className={ITEM}
          >
            <FiDownload className="h-3.5 w-3.5" aria-hidden="true" />
            Download YAML
          </button>
          <button type="button" role="menuitem" onClick={run(onShareLink)} className={ITEM}>
            <FiLink className="h-3.5 w-3.5" aria-hidden="true" />
            Share link
          </button>
        </HeaderMenu>

        <Link
          to="/language"
          className="hidden rounded-md px-3 py-1.5 text-xs font-medium text-white/70 transition-colors hover:bg-white/10 hover:text-white lg:block"
        >
          Docs
        </Link>

        <span className="mx-1 h-5 w-px bg-white/10" aria-hidden="true" />

        {loading ? (
          <span className="h-8 w-24 animate-pulse rounded-lg bg-white/10" />
        ) : user ? (
          <>
            <button
              type="button"
              onClick={onPublish}
              className="group inline-flex cursor-pointer items-center gap-2 rounded-lg bg-tp-accent px-3 py-2 text-xs font-semibold text-tp-on-primary shadow-sm transition-all hover:bg-tp-accent-hover hover:shadow-md"
            >
              <FiUploadCloud className="h-4 w-4" aria-hidden="true" />
              Publish
              <FiArrowUpRight
                className="hidden h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5 xl:block"
                aria-hidden="true"
              />
            </button>
            <EditorAccountMenu />
          </>
        ) : (
          <button
            type="button"
            onClick={signIn}
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
