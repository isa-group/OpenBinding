// Adapted from SPHERE frontend/src/modules/pricing-editor/pages/pricing2yaml-editor/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: a BIM package instead of a Pricing2Yaml text. The files, their history and the live check are the layout's
// editor state (useProblemEditor). Visual mode shows OpenBinding's panes over the last valid check's facts (Workflow,
// Candidates with the matrix edited in place, Rules, Forms over the documents, BPMN) as sub-tabs on SPHERE's light preview
// surface; Code mode is the package's files in the bundled Monaco with the gateway's findings as markers and a Source/Changes
// diff. The engines that can run the package are beside the panes, and SPHERE's problems panel is docked below with the
// gateway's BIM findings: a click opens the text range in Code, the element in the BPMN diagram, or the file. The banners
// above say what the check or the draft could not do, the last save, and the composition version highlighted on the package.
// Below 640 px the panes, the engines and the problems are tabs.

import { lazy, Suspense, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Helmet } from 'react-helmet-async';
import { Link } from 'react-router-dom';
import { compositionPath } from '../../../../routes/paths/compositions';
import { problemPath } from '../../../../routes/paths/problems';
import type { FeatureSlot } from '../../../core/utils/featureRange';
import { refusalMarker, refusalText, type Refusal } from '../../../core/api/refusals';
import { Notice } from '../../../core/components/notice';
import ProblemsPanel from '../../../core/components/problems-panel';
import type { RuleOrigin } from '../../../core/components/rules-and-objectives/RulesAndObjectives';
import EditorSkeleton from '../../../core/components/skeletons/editor-skeleton';
import { resolvePointer } from '../../../core/diagnostics/jsonPointer';
import { counts, type Located } from '../../../core/diagnostics/located';
import { useAuth } from '../../../auth/hooks/useAuth';
import { CandidatesPane } from '../../components/candidates-pane';
import { CodePane, type FileSelection } from '../../components/code-pane';
import { FormsPane } from '../../components/forms-pane';
import { EnginesPanel, WorkflowPane } from '../../components/model-panes';
import { RulesPane } from '../../components/rules-pane';
import type { Origin } from '../../hooks/useProblemEditor';
import { useProblemEditorValue } from '../../hooks/useProblemEditorValue';
import type { WorkspaceFiles } from '../../utils/documents';
import { filePaths } from '../../utils/editorModel';
import { writeAtOrigin, type CellOrigin } from '../../utils/matrixEdits';
import { FIELDS } from '../../utils/styles';

const BpmnModeler = lazy(() =>
  import('../../components/bpmn-modeler').then(module => ({ default: module.BpmnModeler }))
);

export type PaneId =
  'workflow' | 'candidates' | 'rules' | 'forms' | 'bpmn' | 'code' | 'engines' | 'problems';

const NARROW = '(max-width: 640px)';

/** Below 640 px the panes, the engines and the problems are tabs. */
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

/** "Problems (2 errors)": the tab of the Problems panel on a phone. */
function problemsTab(diagnostics: readonly Located[]): string {
  const tally = counts(diagnostics);
  const parts = [
    tally.error ? plural(tally.error, 'error', 'errors') : '',
    tally.warning ? plural(tally.warning, 'warning', 'warnings') : '',
  ].filter(Boolean);
  return parts.length ? `Problems (${parts.join(', ')})` : 'Problems';
}

/** Where the package on screen came from, in words. */
function originText(origin: Origin | null, problem: string | null): string {
  switch (origin?.kind) {
    case 'template':
      return `Opened from template ${origin.template}`;
    case 'revision':
      return `Loaded version ${origin.revision} of ${problem ?? 'the problem'}`;
    case 'draft':
      return problem
        ? `Your draft of ${origin.revision !== null ? `version ${origin.revision} of ` : ''}${problem}, kept in this browser`
        : 'Your draft, kept in this browser';
    case 'blank':
      return 'A blank package';
    default:
      return '';
  }
}

const BANNER = {
  warning: 'border-amber-400/20 bg-amber-400/10 text-amber-100',
  error: 'border-red-400/20 bg-red-400/10 text-red-100',
  success: 'border-emerald-400/20 bg-emerald-400/10 text-emerald-100',
  info: 'border-sky-400/20 bg-sky-400/10 text-sky-100',
} as const;

/** A line under the header in the dark layout: what the check, the draft or a save came to. */
function Banner({
  tone,
  role,
  title,
  children,
  action,
}: {
  tone: keyof typeof BANNER;
  role?: 'alert' | 'status' | 'note';
  title?: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div
      role={role ?? (tone === 'error' ? 'alert' : 'status')}
      className={`flex shrink-0 flex-wrap items-start gap-x-3 gap-y-1 border-b px-3 py-2 text-xs ${BANNER[tone]}`}
    >
      <span className="min-w-0 flex-1">
        {title ? <strong className="mr-1 font-semibold">{title}</strong> : null}
        {children}
      </span>
      {action}
    </div>
  );
}

const BANNER_ACTION =
  'cursor-pointer font-medium text-white underline decoration-white/40 underline-offset-2 hover:decoration-white';

/** A refusal of the check that is not about the package (a credential, a size, an outage): said once, with a way to retry. */
function CheckIssue({ issue, onRetry }: { issue: Refusal; onRetry: () => void }) {
  const title =
    issue.kind === 'session'
      ? 'Checking the package needs a session'
      : issue.kind === 'too-large'
        ? 'The package is too large to check'
        : 'The package couldn’t be checked';
  return (
    <Banner
      tone="error"
      title={`${title}${refusalMarker(issue)}.`}
      action={
        <button type="button" onClick={onRetry} className={BANNER_ACTION}>
          Check again
        </button>
      }
    >
      {refusalText(issue, 'nothing was checked')}
    </Banner>
  );
}

export default function ProblemEditorPage() {
  const { user } = useAuth();
  const { editor, mode, setMode, org, problem, compositionVersion, composition, saved } =
    useProblemEditorValue();
  const narrow = useNarrow();
  // The tab shown in each mode: switching mode shows that mode's own last tab (Code opens on the files).
  const [panes, setPanes] = useState<Record<'visual' | 'code', PaneId>>({
    visual: 'workflow',
    code: 'code',
  });
  const pane = panes[mode];
  const setPane = (id: PaneId, inMode: 'visual' | 'code' = mode) =>
    setPanes(current => ({ ...current, [inMode]: id }));
  const [filePath, setFilePath] = useState('instance.json');
  const [fileView, setFileView] = useState<'source' | 'changes'>('source');
  const [selection, setSelection] = useState<FileSelection | null>(null);
  const [formPath, setFormPath] = useState('instance.json');
  const [task, setTask] = useState<string | null>(null);
  const [bpmnFocus, setBpmnFocus] = useState<string | null>(null);
  const [bpmnIssue, setBpmnIssue] = useState<string | null>(null);

  const title = (
    <Helmet>
      <title>OpenBinding - Problem editor</title>
    </Helmet>
  );

  if (editor.loadIssue) {
    const missing = editor.loadIssue.status === 404;
    return (
      <div className="m-auto max-w-[28rem] px-4 text-center" role="alert">
        {title}
        <p className="font-display text-lg font-semibold text-white">
          The problem version couldn’t be loaded
        </p>
        <p className="mt-2 text-sm text-white/70">
          {missing
            ? `That problem version doesn’t exist any more, or you’re not in the organization it belongs to${refusalMarker(editor.loadIssue)}. The package was not loaded.`
            : refusalText(editor.loadIssue, 'the package was not loaded')}
        </p>
        <button
          type="button"
          onClick={editor.retryLoad}
          className="mt-4 cursor-pointer rounded-lg border border-white/20 px-3 py-2 text-xs font-medium text-white hover:bg-white/10"
        >
          Try again
        </button>
      </div>
    );
  }

  if (!editor.ready) {
    return (
      <div className="h-full w-full" role="status" aria-label="Opening the package">
        {title}
        <EditorSkeleton />
      </div>
    );
  }

  const files = editor.files;
  const bpmnPath = filePaths(files).find(path => /\.bpmn$/i.test(path));
  const overlay = editor.overlay;
  const selected = overlay?.selection ?? {};

  const openFile = (path: string, at?: { anchor: number; head: number }) => {
    setFilePath(path);
    setFileView('source');
    setSelection(at ? { path, ...at } : null);
    setMode('code');
    setPane('code', 'code');
  };

  /** Show a finding where it is: the range in its file, the element in the diagram, or the file. */
  const openFinding = (finding: Located) => {
    const { where } = finding;
    if (where.kind === 'text') openFile(where.file, { anchor: where.from, head: where.to });
    else if (where.kind === 'bpmn') {
      setBpmnFocus(where.element);
      setMode('visual');
      setPane('bpmn', 'visual');
    } else if (where.kind === 'file') openFile(where.file);
  };

  const selectTask = (id: string) => {
    setTask(id);
    setPane('candidates');
  };

  const changeFile = (path: string, text: string) => {
    if (editor.current()[path] !== text) editor.commit(now => ({ ...now, [path]: text }));
  };

  const update = (updater: (now: WorkspaceFiles) => WorkspaceFiles) => editor.commit(updater);

  /** A value of the matrix, written where the package declares it, as one undo step. */
  const editValue = (origin: CellOrigin, value: FeatureSlot | null) => {
    const now = editor.current();
    const next = writeAtOrigin(now, origin, value);
    if (next && next !== now) editor.commit(next);
  };

  /** A rule where the package writes it: its file, at the rule's range when the pointer still lands. */
  const openOrigin = (origin: RuleOrigin) => {
    const text = editor.current()[origin.path];
    const target = text === undefined ? null : resolvePointer(text, origin.pointer);
    openFile(origin.path, target ? { anchor: target.from, head: target.to } : undefined);
  };

  /** The modeler's diagram, once it is valid XML: one undo step when it differs from the file. */
  const acceptBpmn = (xml: string) => {
    if (!bpmnPath) return;
    const text = xml.replace(/\r\n?/g, '\n');
    if (editor.current()[bpmnPath] !== text) editor.commit(now => ({ ...now, [bpmnPath]: text }));
    setBpmnIssue(null);
  };

  const visualPanes: Array<{ id: PaneId; label: string }> = [
    { id: 'workflow', label: 'Workflow' },
    { id: 'candidates', label: 'Candidates' },
    { id: 'rules', label: 'Rules' },
    { id: 'forms', label: 'Forms' },
    ...(bpmnPath ? [{ id: 'bpmn' as const, label: 'BPMN' }] : []),
  ];
  const extras: Array<{ id: PaneId; label: string }> = narrow
    ? [
        { id: 'engines', label: 'Engines' },
        { id: 'problems', label: problemsTab(editor.diagnostics) },
      ]
    : [];
  const tabs =
    mode === 'visual'
      ? [...visualPanes, ...extras]
      : narrow
        ? [{ id: 'code' as const, label: 'Files' }, ...extras]
        : [];
  const active: PaneId = tabs.some(item => item.id === pane)
    ? pane
    : mode === 'code'
      ? 'code'
      : 'workflow';

  const problems = (
    <ProblemsPanel diagnostics={editor.diagnostics} onSelect={openFinding} groups tone="dark" />
  );
  const engines = <EnginesPanel response={editor.response} stale={editor.stale} />;
  const origin = originText(editor.origin, problem);

  const visual = (id: PaneId) => (
    <div className={`h-full overflow-y-auto bg-tp-surface px-3 py-4 sm:px-5 ${FIELDS}`}>
      <div className="mx-auto w-full max-w-6xl">
        {id === 'workflow' && (
          <WorkflowPane
            facts={editor.facts}
            stale={editor.stale}
            selection={selected}
            response={editor.response}
            onSelectTask={selectTask}
          />
        )}
        {id === 'candidates' && (
          <CandidatesPane
            facts={editor.facts}
            stale={editor.stale}
            selection={selected}
            task={task}
            onTask={setTask}
            files={files}
            diagnostics={editor.diagnostics}
            onEdit={editValue}
            update={update}
            onOpenFile={path => openFile(path)}
            onOpenFinding={openFinding}
          />
        )}
        {id === 'rules' && (
          <RulesPane
            facts={editor.facts}
            stale={editor.stale}
            files={files}
            update={update}
            onOpenOrigin={openOrigin}
            onOpenFile={path => openFile(path)}
          />
        )}
        {id === 'forms' && (
          <FormsPane
            files={files}
            path={formPath}
            onPath={setFormPath}
            update={update}
            onOpenFile={path => openFile(path)}
          />
        )}
        {id === 'bpmn' && bpmnPath && (
          <div className="flex flex-col gap-3">
            {bpmnIssue && <Notice tone="warning">{bpmnIssue}</Notice>}
            <Suspense
              fallback={
                <p className="text-sm text-tp-slate" role="status">
                  Loading the diagram…
                </p>
              }
            >
              <BpmnModeler
                candidateXml={files[bpmnPath]}
                fallbackXml={editor.baseline[bpmnPath]}
                focusElement={bpmnFocus}
                onValidXml={acceptBpmn}
                onError={setBpmnIssue}
              />
            </Suspense>
          </div>
        )}
        {id === 'engines' && engines}
      </div>
    </div>
  );

  const body =
    active === 'code' ? (
      <CodePane
        files={files}
        baseline={editor.baseline}
        path={filePath}
        onPath={path => {
          setFilePath(path);
          setSelection(null);
        }}
        onChange={changeFile}
        diagnostics={editor.diagnostics}
        selection={selection}
        view={fileView}
        onView={setFileView}
        unparsed={editor.unparsed}
      />
    ) : active === 'problems' ? (
      <div className="h-full overflow-y-auto">{problems}</div>
    ) : (
      visual(active)
    );

  return (
    <>
      {title}
      {!user && (
        <Banner tone="info" role="note">
          Nothing is stored: you can edit, check and download the package here. Sign in to save it
          as a problem of one of your organizations.
        </Banner>
      )}
      {editor.draftIssue && <Banner tone="warning">{editor.draftIssue}</Banner>}
      {editor.templateIssue && (
        <Banner tone="error" title={`The template ${editor.templateIssue.template} wasn’t opened.`}>
          {`${editor.templateIssue.message} Your package was kept.`}
        </Banner>
      )}
      {editor.checkIssue && <CheckIssue issue={editor.checkIssue} onRetry={editor.checkNow} />}
      {saved && (
        <Banner
          tone="success"
          action={
            <Link
              to={problemPath(saved.org, saved.outcome.upload.problem.slug, undefined, {
                version: saved.outcome.upload.revision.revision,
              })}
              viewTransition
              className={BANNER_ACTION}
            >
              Open the problem
            </Link>
          }
        >
          {saved.outcome.kind === 'unchanged'
            ? `Unchanged: version ${saved.outcome.upload.revision.revision} of ${saved.outcome.upload.problem.name} already holds this package.`
            : `Saved as version ${saved.outcome.upload.revision.revision} of ${saved.outcome.upload.problem.name}. Run it from its page.`}
        </Banner>
      )}
      {composition && compositionVersion && editor.overlayLoading && (
        <Banner tone="info">Loading the composition version to highlight…</Banner>
      )}
      {editor.overlayIssue && (
        <Banner tone="error">{`The composition version ${compositionVersion} of ${composition} couldn’t be loaded: ${editor.overlayIssue}`}</Banner>
      )}
      {overlay && org && (
        <Banner
          tone="info"
          role="note"
          action={
            <Link
              to={compositionPath(org, overlay.composition, undefined, { version: overlay.label })}
              viewTransition
              className={BANNER_ACTION}
            >
              Back to {overlay.name} {overlay.label}
            </Link>
          }
        >
          {Object.keys(overlay.selection).length ? (
            <>
              The candidates{' '}
              <strong>
                {overlay.name} {overlay.label}
              </strong>{' '}
              chose are selected
              {overlay.linked ? (
                <>
                  , as it chose them on <code className="font-mono">{overlay.linked}</code>
                </>
              ) : null}
              .
            </>
          ) : (
            <>
              {overlay.name} {overlay.label} has no evaluated binding to highlight.
            </>
          )}
        </Banner>
      )}

      <div className="flex min-h-0 flex-1">
        <section aria-label="Package" className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex shrink-0 items-center gap-2 border-b border-white/10 bg-tp-surface-code px-2 py-1.5">
            {tabs.length > 0 ? (
              <div
                role="tablist"
                aria-label="Editor panes"
                className="flex min-w-0 gap-1 overflow-x-auto"
              >
                {tabs.map(item => (
                  <button
                    key={item.id}
                    id={`pe-pane-tab-${item.id}`}
                    type="button"
                    role="tab"
                    aria-selected={active === item.id}
                    aria-controls="pe-pane-panel"
                    onClick={() => setPane(item.id)}
                    className={`shrink-0 cursor-pointer rounded-md px-3 py-1 text-xs font-medium whitespace-nowrap ${active === item.id ? 'bg-white/15 text-white' : 'text-white/60 hover:text-white'}`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            ) : null}
            <p className="ml-auto hidden min-w-0 truncate px-1 text-[11px] text-white/60 sm:block">
              {origin}
            </p>
          </div>
          <div
            id="pe-pane-panel"
            role={tabs.length > 0 ? 'tabpanel' : undefined}
            aria-labelledby={tabs.length > 0 ? `pe-pane-tab-${active}` : undefined}
            className="min-h-0 flex-1"
          >
            {body}
          </div>
        </section>
        {!narrow && (
          <aside className="hidden w-72 shrink-0 overflow-y-auto border-l border-white/10 bg-tp-surface p-4 sm:block">
            {engines}
          </aside>
        )}
      </div>
      {!narrow && problems}
    </>
  );
}
