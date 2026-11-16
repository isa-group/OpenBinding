import { lazy, Suspense, useState, useSyncExternalStore } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { FolderOpen, Redo2, RefreshCw, RotateCcw, Save, Undo2 } from 'lucide-react';
import type { Organization } from '../../api/platform';
import { Action } from '../../components/ui/Action';
import { Notice } from '../../components/ui/Notice';
import { Skeleton } from '../../components/ui/Skeleton';
import { TabBar, TabPanel } from '../../components/ui/TabBar';
import { compositionPath } from '../../routes/paths/compositions';
import { problemEditorPath, problemPath } from '../../routes/paths/problems';
import { refusalMarker, refusalText, type Refusal } from '../../shared/api/refusals';
import { resolvePointer } from '../../shared/diagnostics/jsonPointer';
import { counts, type Located } from '../../shared/diagnostics/located';
import type { FeatureSlot } from '../../utils/featureRange';
import { ProblemsPanel } from '../../widgets/problems-panel/ProblemsPanel';
import type { RuleOrigin } from '../../widgets/rules-and-objectives/RulesAndObjectives';
import { CandidatesPane } from './CandidatesPane';
import { parseJson, type WorkspaceFiles } from './documents';
import { OpenDialog, SaveDialog, type OpenChoice } from './EditorDialogs';
import { filePaths } from './editorModel';
import { FilesPane } from './FilesPane';
import { FormsPane } from './FormsPane';
import { writeAtOrigin, type CellOrigin } from './matrixEdits';
import { EnginesPanel, WorkflowPane } from './ModelPanes';
import { RulesPane } from './RulesPane';
import { useProblemEditor, type Origin, type ProblemEditorState, type SaveOutcome, type SaveTarget } from './useProblemEditor';
import './ProblemEditor.css';

const BpmnModeler = lazy(() => import('./BpmnModeler').then((module) => ({ default: module.BpmnModeler })));

export type PaneId = 'workflow' | 'candidates' | 'rules' | 'files' | 'forms' | 'bpmn' | 'engines' | 'problems';

const NARROW = '(max-width: 640px)';

/** Below 640 px the panes, the engines and the problems are tabs. */
function useNarrow(): boolean {
  return useSyncExternalStore(
    (notify) => {
      const list = typeof window.matchMedia === 'function' ? window.matchMedia(NARROW) : null;
      list?.addEventListener?.('change', notify);
      return () => list?.removeEventListener?.('change', notify);
    },
    () => (typeof window.matchMedia === 'function' ? window.matchMedia(NARROW).matches : false),
    () => false,
  );
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** "Problems (2 errors)": the tab of the Problems panel on a phone. */
function problemsTab(diagnostics: readonly Located[]): string {
  const tally = counts(diagnostics);
  const parts = [tally.error ? plural(tally.error, 'error', 'errors') : '', tally.warning ? plural(tally.warning, 'warning', 'warnings') : ''].filter(Boolean);
  return parts.length ? `Problems (${parts.join(', ')})` : 'Problems';
}

/** Where the package on screen came from, in words. */
function originText(origin: Origin | null, problem: string | null): string {
  switch (origin?.kind) {
    case 'template': return `Opened from template ${origin.template}`;
    case 'revision': return `Loaded version ${origin.revision} of ${problem ?? 'the problem'}`;
    case 'draft': return problem ? `Your draft of ${origin.revision !== null ? `version ${origin.revision} of ` : ''}${problem}, kept in this browser` : 'Your draft, kept in this browser';
    case 'blank': return 'A blank package';
    default: return '';
  }
}

/** What the live check is doing, in words. */
function checkText(editor: ProblemEditorState): string {
  if (editor.pausedMessage) return editor.pausedMessage;
  if (editor.unparsed.length) return `Waiting for valid JSON in ${editor.unparsed.join(', ')}`;
  if (editor.checking) return 'Checking…';
  if (editor.upToDate && editor.last) {
    if (editor.last.valid) return 'Valid package';
    const errors = counts(editor.diagnostics).error;
    return `Not valid · ${plural(errors, 'problem', 'problems')}`;
  }
  return editor.checkIssue ? 'Not checked' : '';
}

/** A refusal of the check that is not about the package (a credential, a size, an outage): said once, with a way to retry. */
function CheckIssue({ issue, onRetry }: { issue: Refusal; onRetry: () => void }) {
  const title = issue.kind === 'session' ? 'Checking the package needs a session' : issue.kind === 'too-large' ? 'The package is too large to check' : 'The package couldn’t be checked';
  return (
    <Notice tone="error" title={`${title}${refusalMarker(issue)}`} action={<Action variant="secondary" size="sm" onClick={onRetry}>Check again</Action>}>
      {refusalText(issue, 'nothing was checked')}
    </Notice>
  );
}

function SavedNotice({ org, outcome }: { org: string; outcome: Exclude<SaveOutcome, { kind: 'refused' }> }) {
  const { problem, revision } = outcome.upload;
  return (
    <Notice
      tone="success"
      action={<Link to={problemPath(org, problem.slug, undefined, { version: revision.revision })} viewTransition>Open the problem</Link>}
    >
      {outcome.kind === 'unchanged'
        ? `Unchanged: version ${revision.revision} of ${problem.name} already holds this package.`
        : `Saved as version ${revision.revision} of ${problem.name}. Run it from its page.`}
    </Notice>
  );
}

interface ProblemEditorProps {
  organization: Organization;
  /** MEMBER or above: saves into the organization. Below it the package is edited and checked, never saved. */
  canSave: boolean;
  userId?: string | null;
  /** The delay of the live check, in milliseconds (tests shorten it). */
  delay?: number;
}

/**
 * The BIM problem editor (`problem-editor`): the package as a workflow, its candidates (edited in the matrix), its rules and
 * objectives, its files, forms over its documents and its BPMN diagram, checked live by the gateway, with the findings listed under it and the engines that can run it beside it.
 * `?problem=&revision=` opens a version, `?template=` a template, `&composition=&compositionVersion=` highlights what a
 * composition version chose. On a phone the panes are tabs.
 */
export function ProblemEditor({ organization, canSave, userId, delay }: ProblemEditorProps) {
  const org = organization.slug;
  const [params] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const narrow = useNarrow();
  const problem = params.get('problem');
  const revision = params.get('revision');
  const template = params.get('template');
  const composition = params.get('composition');
  const compositionVersion = params.get('compositionVersion');
  const blank = (location.state as { blank?: boolean } | null)?.blank === true;
  const editor = useProblemEditor({ org, userId, problem, revision, template, composition, compositionVersion, blank, delay });

  const [pane, setPane] = useState<PaneId>('workflow');
  const [filePath, setFilePath] = useState('instance.json');
  const [fileView, setFileView] = useState<'source' | 'changes'>('source');
  const [selection, setSelection] = useState<{ anchor: number; head: number } | undefined>();
  const [formPath, setFormPath] = useState('instance.json');
  const [task, setTask] = useState<string | null>(null);
  const [bpmnFocus, setBpmnFocus] = useState<string | null>(null);
  const [bpmnIssue, setBpmnIssue] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveIssue, setSaveIssue] = useState<string | null>(null);
  const [saved, setSaved] = useState<Exclude<SaveOutcome, { kind: 'refused' }> | null>(null);

  if (editor.loadIssue) {
    const missing = editor.loadIssue.status === 404;
    return (
      <Notice tone="error" title="The problem version couldn’t be loaded" action={<Action variant="secondary" size="sm" onClick={editor.retryLoad}>Try again</Action>}>
        {missing
          ? `That problem version doesn’t exist any more, or you’re not in the organization it belongs to${refusalMarker(editor.loadIssue)}. The package was not loaded.`
          : refusalText(editor.loadIssue, 'the package was not loaded')}
      </Notice>
    );
  }
  if (!editor.ready) {
    return <div role="status" aria-busy="true"><span className="sr-only">Opening the package…</span><Skeleton variant="panel" /></div>;
  }

  const files = editor.files;
  const bpmnPath = filePaths(files).find((path) => /\.bpmn$/i.test(path));
  const overlay = editor.overlay;
  const selected = overlay?.selection ?? {};

  const openFile = (path: string, at?: { anchor: number; head: number }) => {
    setFilePath(path);
    setFileView('source');
    setSelection(at);
    setPane('files');
  };

  /** Show a finding where it is: the range in its file, the element in the diagram, or the file. */
  const openFinding = (finding: Located) => {
    const { where } = finding;
    if (where.kind === 'text') openFile(where.file, { anchor: where.from, head: where.to });
    else if (where.kind === 'bpmn') {
      setBpmnFocus(where.element);
      setPane('bpmn');
    } else if (where.kind === 'file') openFile(where.file);
  };

  const selectTask = (id: string) => {
    setTask(id);
    setPane('candidates');
  };

  const changeFile = (path: string, text: string) => {
    if (editor.current()[path] !== text) editor.commit((now) => ({ ...now, [path]: text }));
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
    if (editor.current()[bpmnPath] !== text) editor.commit((now) => ({ ...now, [bpmnPath]: text }));
    setBpmnIssue(null);
  };

  const open = (choice: OpenChoice) => {
    setOpening(false);
    setSaved(null);
    if (choice.kind === 'template') navigate(problemEditorPath(org, { template: choice.template }));
    else if (choice.kind === 'revision') navigate(problemEditorPath(org, { problem: choice.problem, revision: choice.revision }));
    else navigate(problemEditorPath(org), { state: { blank: true } });
  };

  const save = async (target: SaveTarget) => {
    setSaveIssue(null);
    const outcome = await editor.save(target);
    if (outcome.kind === 'refused') {
      setSaveIssue(outcome.message);
      return;
    }
    setSaving(false);
    setSaved(outcome);
  };

  const root = parseJson(files['instance.json']);
  const packageName = typeof root?.metadata?.name === 'string' ? root.metadata.name : '';
  const status = checkText(editor);

  const panes: Array<{ id: PaneId; label: string }> = [
    { id: 'workflow', label: 'Workflow' },
    { id: 'candidates', label: 'Candidates' },
    { id: 'rules', label: 'Rules' },
    { id: 'files', label: 'Files' },
    { id: 'forms', label: 'Forms' },
    ...(bpmnPath ? [{ id: 'bpmn' as const, label: 'BPMN' }] : []),
    ...(narrow ? [{ id: 'engines' as const, label: 'Engines' }, { id: 'problems' as const, label: problemsTab(editor.diagnostics) }] : []),
  ];
  const active = panes.some((item) => item.id === pane) ? pane : 'workflow';
  const problems = <ProblemsPanel diagnostics={editor.diagnostics} onSelect={openFinding} groups />;
  const engines = <EnginesPanel response={editor.response} stale={editor.stale} />;

  return (
    <div className="pe">
      <div className="pe-bar" role="toolbar" aria-label="Problem editor">
        <Action size="sm" variant="secondary" onClick={() => setOpening(true)}><FolderOpen aria-hidden="true" />Open…</Action>
        <Action size="sm" variant="ghost" onClick={() => editor.undo()} disabled={!editor.canUndo}><Undo2 aria-hidden="true" />Undo</Action>
        <Action size="sm" variant="ghost" onClick={() => editor.redo()} disabled={!editor.canRedo}><Redo2 aria-hidden="true" />Redo</Action>
        <Action size="sm" variant="ghost" onClick={() => editor.reset()} disabled={!editor.dirty}><RotateCcw aria-hidden="true" />Reset</Action>
        {canSave && (
          <Action
            size="sm"
            variant="primary"
            disabled={!editor.savable}
            title={editor.savable ? undefined : 'Save once the package passes its check'}
            onClick={() => { setSaveIssue(null); setSaving(true); }}
          >
            <Save aria-hidden="true" />Save as version…
          </Action>
        )}
        <span className="pe-status">
          <span role="status" aria-live="polite" data-testid="pe-check-status">{status}</span>
          <Action size="sm" variant="ghost" onClick={editor.checkNow} disabled={editor.unparsed.length > 0 || editor.pausedMessage !== null}>
            <RefreshCw aria-hidden="true" />Check now
          </Action>
        </span>
      </div>
      <p className="pe-origin">{originText(editor.origin, problem)}</p>

      {!canSave && <p className="pe-note" role="note">You can edit and check here; saving into the organization needs MEMBER.</p>}
      {editor.draftIssue && <Notice tone="warning">{editor.draftIssue}</Notice>}
      {editor.templateIssue && (
        <Notice tone="error" title={`The template ${editor.templateIssue.template} wasn’t opened`}>
          {`${editor.templateIssue.message} Your package was kept.`}
        </Notice>
      )}
      {editor.checkIssue && <CheckIssue issue={editor.checkIssue} onRetry={editor.checkNow} />}
      {saved && <SavedNotice org={org} outcome={saved} />}
      {composition && compositionVersion && editor.overlayLoading && <p className="pe-muted" role="status">Loading the composition version to highlight…</p>}
      {editor.overlayIssue && <Notice tone="error">{`The composition version ${compositionVersion} of ${composition} couldn’t be loaded: ${editor.overlayIssue}`}</Notice>}
      {overlay && (
        <div className="pe-overlay" role="note">
          <span>
            {Object.keys(overlay.selection).length
              ? <>The candidates <strong>{overlay.name} {overlay.label}</strong> chose are selected{overlay.linked ? <>, as it chose them on <code>{overlay.linked}</code></> : null}.</>
              : <>{overlay.name} {overlay.label} has no evaluated binding to highlight.</>}
          </span>
          <Link to={compositionPath(org, overlay.composition, undefined, { version: overlay.label })} viewTransition>Back to {overlay.name} {overlay.label}</Link>
        </div>
      )}

      <div className={narrow ? 'pe-body is-narrow' : 'pe-body'}>
        <div className="pe-main">
          <TabBar items={panes} value={active} onChange={(id) => setPane(id as PaneId)} ariaLabel="Editor panes" prefix="pe-pane" />
          <TabPanel prefix="pe-pane" active={active}>
            {active === 'workflow' && <WorkflowPane facts={editor.facts} stale={editor.stale} selection={selected} response={editor.response} onSelectTask={selectTask} />}
            {active === 'candidates' && (
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
                onOpenFile={(path) => openFile(path)}
                onOpenFinding={openFinding}
              />
            )}
            {active === 'rules' && (
              <RulesPane facts={editor.facts} stale={editor.stale} files={files} update={update} onOpenOrigin={openOrigin} onOpenFile={(path) => openFile(path)} />
            )}
            {active === 'files' && (
              <FilesPane
                files={files}
                baseline={editor.baseline}
                path={filePath}
                onPath={(path) => { setFilePath(path); setSelection(undefined); }}
                onChange={changeFile}
                diagnostics={editor.diagnostics}
                selection={selection}
                view={fileView}
                onView={setFileView}
                unparsed={editor.unparsed}
              />
            )}
            {active === 'forms' && <FormsPane files={files} path={formPath} onPath={setFormPath} update={update} onOpenFile={(path) => openFile(path)} />}
            {active === 'bpmn' && bpmnPath && (
              <div className="pe-diagram">
                {bpmnIssue && <Notice tone="warning">{bpmnIssue}</Notice>}
                <Suspense fallback={<p className="pe-muted" role="status">Loading the diagram…</p>}>
                  <BpmnModeler candidateXml={files[bpmnPath]} fallbackXml={editor.baseline[bpmnPath]} focusElement={bpmnFocus} onValidXml={acceptBpmn} onError={setBpmnIssue} />
                </Suspense>
              </div>
            )}
            {active === 'engines' && engines}
            {active === 'problems' && problems}
          </TabPanel>
        </div>
        {!narrow && <aside className="pe-side">{engines}</aside>}
      </div>
      {!narrow && problems}

      {opening && <OpenDialog org={org} onOpen={open} onClose={() => setOpening(false)} />}
      {saving && (
        <SaveDialog
          org={org}
          packageName={packageName}
          initialProblem={problem}
          busy={editor.saving}
          issue={saveIssue}
          onSave={(target) => void save(target)}
          onClose={() => setSaving(false)}
        />
      )}
    </div>
  );
}
