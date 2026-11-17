// Adapted from SPHERE frontend/src/modules/pricing-editor/pages/pricing2yaml-editor/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: Composition2Yaml instead of Pricing2Yaml. The text, its history and the checks are the layout's editor state
// (useCompositionEditor), loaded from the address there; there is no client-side lint: the problems panel and the Monaco
// markers show the gateway's `c2y_*` findings only (validate, and the seal's check on a composition), and clicking one
// reveals its line. Completion comes from the gateway's JSON Schema and the linked problem's facts (services/completion),
// next to the templates (⌘K). The preview is the renderer's catalog preset over `POST /v1/compositions/parse`, debounced by
// 1000 ms with a stale guard, as SPHERE previews a pricing. Visual mode is OpenBinding's visual pane in SPHERE's side-panel
// look. Below 640 px the code, the preview and the problems are tabs. Monaco is bundled (core/components/code-editor).

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type * as Monaco from 'monaco-editor';
import { AnimatePresence, motion } from 'framer-motion';
import { Helmet } from 'react-helmet-async';
import { readApiError } from '../../../core/api/errors';
import CodeEditor from '../../../core/components/code-editor';
import { CompositionRenderer } from '../../../core/components/composition-renderer/CompositionRenderer';
import ProblemsPanel from '../../../core/components/problems-panel';
import EditorSkeleton from '../../../core/components/skeletons/editor-skeleton';
import type { Located } from '../../../core/diagnostics/located';
import { locatedMarkers } from '../../../core/utils/located-markers';
import { readDocument, type CompositionDocument } from '../../../core/utils/composition/document';
import { COMPOSITION_FILE } from '../../../core/utils/composition/viewModel';
import { languageApi } from '../../../composition/api/compositionsApi';
import TemplatesMenu from '../../components/templates-menu';
import VisualPane from '../../components/visual-pane';
import { useCompositionSnippets } from '../../hooks/useCompositionSnippets';
import { useEditorValue } from '../../hooks/useEditorValue';
import { registerCompositionCompletions } from '../../services/completion';
import { previewModel } from '../../services/preview';
import { COMPOSITION2YAML_SNIPPETS } from '../../services/snippets/templates';
import { templatesShortcutLabel } from '../../services/snippets';

/** Namespace under which the gateway's findings own their markers, so they never clear anyone else's. */
const MARKER_OWNER = 'composition2yaml-gateway';

/** Milliseconds of stillness before the preview is parsed again. */
export const PREVIEW_DELAY_MS = 1000;

/** Shortcut advertised next to the templates menu. */
const TEMPLATES_SHORTCUT = templatesShortcutLabel();

/** Monaco keeps quick suggestions off inside strings, where a plain YAML scalar is: on, they suggest as the user types. */
const EDITOR_QUICK_SUGGESTIONS = { other: true, comments: false, strings: true } as const;

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

type Pane = 'code' | 'preview' | 'problems';

interface Preview {
  text: string;
  document: CompositionDocument | null;
  message: string | null;
}

/** The document the gateway parses from the text, 1000 ms after the last change; an older answer never replaces a newer one. */
function usePreview(text: string, enabled: boolean): Preview | null {
  const [preview, setPreview] = useState<Preview | null>(null);
  const requestId = useRef(0);
  useEffect(() => {
    if (!enabled) return undefined;
    const id = ++requestId.current;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      languageApi.parse(text, controller.signal).then(
        answer => {
          if (id === requestId.current)
            setPreview({ text, document: readDocument(answer.document), message: null });
        },
        (caught: unknown) => {
          if (controller.signal.aborted || id !== requestId.current) return;
          const refusal = readApiError(caught);
          setPreview({
            text,
            document: null,
            message:
              refusal.status === 422
                ? 'The preview shows a valid document: fix the problems in the code.'
                : refusal.message || 'The preview couldn’t be drawn.',
          });
        }
      );
    }, PREVIEW_DELAY_MS);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [text, enabled]);
  return preview;
}

function Banner({
  tone,
  children,
  action,
}: {
  tone: 'warning' | 'error';
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={`flex shrink-0 items-start gap-3 border-b px-3 py-2 text-xs ${tone === 'error' ? 'border-red-400/20 bg-red-400/10 text-red-200' : 'border-amber-400/20 bg-amber-400/10 text-amber-200'}`}
    >
      <span className="min-w-0 flex-1">{children}</span>
      {action}
    </div>
  );
}

export default function CompositionEditorPage() {
  const { editor, editorMode, setEditorMode } = useEditorValue();
  const narrow = useNarrow();
  const [pane, setPane] = useState<Pane>('code');
  const [monacoInstance, setMonacoInstance] = useState<typeof Monaco | null>(null);
  const [codeEditor, setCodeEditor] = useState<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const [isTemplatesMenuOpen, setIsTemplatesMenuOpen] = useState(false);
  const insertSnippet = useCompositionSnippets(
    codeEditor,
    monacoInstance,
    COMPOSITION2YAML_SNIPPETS,
    useCallback(() => setIsTemplatesMenuOpen(true), [])
  );

  const showPreview = editorMode === 'code' && (!narrow || pane === 'preview');
  const preview = usePreview(editor.text, editor.ready && showPreview);
  const model = useMemo(
    () => (preview?.document ? previewModel(preview.document) : null),
    [preview]
  );

  // Completion reads the schema and facts the editor has at the moment it is asked.
  const sources = useRef(editor.completions);
  useEffect(() => {
    sources.current = editor.completions;
  }, [editor.completions]);
  useEffect(() => {
    if (!monacoInstance) return undefined;
    const disposable = registerCompositionCompletions(monacoInstance, () => sources.current);
    return () => disposable.dispose();
  }, [monacoInstance]);

  // The gateway's findings as markers: the squiggles and the hover messages over the text.
  useEffect(() => {
    const textModel = codeEditor?.getModel();
    if (!monacoInstance || !textModel) return undefined;
    monacoInstance.editor.setModelMarkers(
      textModel,
      MARKER_OWNER,
      locatedMarkers(editor.diagnostics, textModel.getValue(), COMPOSITION_FILE, 'Composition2Yaml')
    );
    return () => {
      if (!textModel.isDisposed())
        monacoInstance.editor.setModelMarkers(textModel, MARKER_OWNER, []);
    };
  }, [monacoInstance, codeEditor, editor.diagnostics, editor.text]);

  /** Moves the caret to a finding so the user can fix it straight away. */
  const goToDiagnostic = (diagnostic: Located) => {
    if (diagnostic.where.kind !== 'text') return;
    if (editorMode !== 'code') setEditorMode('code');
    if (narrow) setPane('code');
    const textModel = codeEditor?.getModel();
    if (!codeEditor || !textModel) return;
    const start = textModel.getPositionAt(diagnostic.where.from);
    const end = textModel.getPositionAt(diagnostic.where.to);
    codeEditor.revealLineInCenter(start.lineNumber);
    codeEditor.setSelection({
      startLineNumber: start.lineNumber,
      startColumn: start.column,
      endLineNumber: end.lineNumber,
      endColumn: end.column,
    });
    codeEditor.focus();
  };

  const status =
    editor.pausedMessage ?? (editor.checking ? 'Checking…' : editor.dirty ? 'Unsaved changes' : '');

  const banners = (
    <>
      {editor.draftIssue && <Banner tone="warning">{editor.draftIssue}</Banner>}
      {editor.linkIssue && (
        <Banner
          tone="error"
          action={
            <button
              type="button"
              onClick={editor.dismissLinkIssue}
              className="cursor-pointer font-medium text-white underline"
            >
              Dismiss
            </button>
          }
        >
          {editor.linkIssue}
        </Banner>
      )}
      {editor.lintIssue && (
        <Banner tone="warning">{`The gateway couldn’t check the text: ${editor.lintIssue}`}</Banner>
      )}
    </>
  );

  if (editor.loadError !== null) {
    return (
      <div className="m-auto max-w-[28rem] px-4 text-center" role="alert">
        <p className="font-display text-lg font-semibold text-white">The text couldn’t be loaded</p>
        <p className="mt-2 text-sm text-white/70">
          {editor.loadError || 'The gateway didn’t answer.'}
        </p>
        <button
          type="button"
          onClick={editor.retry}
          className="mt-4 cursor-pointer rounded-lg border border-white/20 px-3 py-2 text-xs font-medium text-white hover:bg-white/10"
        >
          Retry
        </button>
      </div>
    );
  }

  if (!editor.ready) {
    return (
      <div className="h-full w-full" role="status" aria-label="Loading the editor">
        <EditorSkeleton />
      </div>
    );
  }

  const problems = (
    <ProblemsPanel diagnostics={editor.diagnostics} onSelect={goToDiagnostic} tone="dark" />
  );

  const code = (
    <div className="relative flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-white/10 bg-tp-surface-code px-3 py-1.5">
        <TemplatesMenu
          snippets={COMPOSITION2YAML_SNIPPETS}
          onSelect={insertSnippet}
          isOpen={isTemplatesMenuOpen}
          onOpenChange={setIsTemplatesMenuOpen}
          disabled={!codeEditor}
        />
        <p className="hidden text-[10px] text-white/50 xl:block">
          Type <span className="font-mono text-white/70">candidate</span>,{' '}
          <span className="font-mono text-white/70">value</span>… in the editor, or press{' '}
          <kbd className="rounded border border-white/10 bg-white/5 px-1 py-0.5 font-mono text-[9px] text-white/70">
            {TEMPLATES_SHORTCUT}
          </kbd>
        </p>
        <span role="status" aria-live="polite" className="ml-auto text-[11px] text-white/60">
          {status}
        </span>
      </div>
      {banners}
      <div className="min-h-0 flex-1">
        <CodeEditor
          height="100%"
          defaultLanguage="yaml"
          path={COMPOSITION_FILE}
          ariaLabel="composition.yaml source"
          value={editor.text}
          onChange={value => editor.setText(value ?? '')}
          onMount={(mounted, instance) => {
            setCodeEditor(mounted);
            setMonacoInstance(instance as unknown as typeof Monaco);
          }}
          loading={<EditorSkeleton />}
          options={{ quickSuggestions: EDITOR_QUICK_SUGGESTIONS }}
        />
      </div>
      {!narrow && problems}
    </div>
  );

  const previewPane = (
    <div
      role="region"
      aria-label="Preview"
      className="box-border flex h-full min-h-0 flex-col overflow-x-hidden overflow-y-auto bg-tp-surface p-3"
    >
      {model ? (
        <CompositionRenderer model={model} mode="catalog" />
      ) : preview?.message ? (
        <div
          role="status"
          className="m-4 rounded-lg border border-tp-hairline bg-tp-canvas px-4 py-3 text-sm text-tp-slate"
        >
          {preview.message}
        </div>
      ) : (
        <EditorSkeleton />
      )}
    </div>
  );

  return (
    <>
      <Helmet>
        <title>OpenBinding - Composition editor</title>
      </Helmet>

      <AnimatePresence mode="wait">
        {editorMode === 'visual' ? (
          <motion.div
            key="visual"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
            className="flex h-full w-full flex-col overflow-y-auto bg-tp-surface"
          >
            {banners}
            <div
              role="region"
              aria-label="Visual editor"
              className="mx-auto w-full max-w-5xl px-3 py-4 sm:px-6"
            >
              <VisualPane
                document={editor.document}
                issue={editor.documentIssue}
                facts={editor.facts}
                mutate={editor.mutate}
                busy={editor.mutating}
                readOnly={false}
              />
            </div>
          </motion.div>
        ) : narrow ? (
          <motion.div
            key="tabs"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
            className="flex h-full w-full min-w-0 flex-col"
          >
            <div
              role="tablist"
              aria-label="Editor panes"
              className="flex shrink-0 gap-1 border-b border-white/10 bg-tp-surface-code px-2 py-1.5"
            >
              {(['code', 'preview', 'problems'] as Pane[]).map(id => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={pane === id}
                  onClick={() => setPane(id)}
                  className={`cursor-pointer rounded-md px-3 py-1 text-xs font-medium ${pane === id ? 'bg-white/15 text-white' : 'text-white/60 hover:text-white'}`}
                >
                  {id === 'code' ? 'Code' : id === 'preview' ? 'Preview' : 'Problems'}
                  {id === 'problems' && editor.errors > 0 ? ` (${editor.errors})` : ''}
                </button>
              ))}
            </div>
            <div role="tabpanel" className="min-h-0 flex-1 overflow-y-auto">
              {pane === 'code' && code}
              {pane === 'preview' && previewPane}
              {pane === 'problems' && problems}
            </div>
          </motion.div>
        ) : (
          <motion.div
            key="code"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
            className="grid h-full w-full min-w-0 lg:grid-cols-2"
          >
            {code}
            {previewPane}
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
