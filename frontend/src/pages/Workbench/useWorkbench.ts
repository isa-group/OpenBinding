import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import { HttpError, apiClient, type BimAnalysisData, type BimAnalysisResponse, type EngineRoutingUserProvenance } from '../../api/client';
import type { ArtifactVersion } from '../../api/library';
import { platformApi, type CaseRevision } from '../../api/platform';
import { workbenchApi } from '../../api/workbench';
import { packageFiles, unzipPackage, zipStore } from '../../utils/bimZip';
import { migrateFiles } from '../../utils/bimVocabulary';
import { loadDraft, saveDraft, type WorkspaceFiles } from '../../utils/workspaceDraft';
import { sourceDiff, toYaml } from '../../utils/workspaceViews';
import {
  DEFAULT_BPMN, DEFAULT_FILES, allModesFromAnalysis, diagnosticSelection, errorDiagnostics, executionKey, instanceResources, isRecord,
  isRegisteredResourceRef, modesFromAnalysis, parseJson, pretty, resourcePathForDiagnostic,
  type BindingResult, type BimDocument, type CompatibleMode, type CompiledIr, type Diagnostic, type WorkspaceStatus,
} from './bimDocuments';
import { isAbort, pollV1Job } from './pollJob';
import {
  RANGE_RUN_ERROR, filesHaveRanges, isRangeRefusal, rangePointers, refusalOf, refusalText, saveRefusalText, workbenchDraftScope, type Refusal,
} from './workbenchModel';

export type EditorTab = 'resources' | 'form' | 'bpmn';
export type SourceView = 'json' | 'yaml' | 'workflow' | 'bpmnXml' | 'ir' | 'diff';
export type RunState = 'idle' | 'queued' | 'running' | 'completed' | 'failed';
export type AutoProfile = 'balanced' | 'quality_first' | 'latency_first' | 'cost_first';

/** Where the package on screen was last checked from: the editor, or a file or example that was brought in. */
export type CheckOrigin = 'package' | 'import' | 'example';

export interface WorkbenchOptions {
  orgSlug: string;
  projectSlug: string;
  userId?: string;
  pathname: string;
  caseRef: string | null;
  revisionRef: string | null;
  requestedExample: string;
}

export interface PackageDigests {
  instance: string;
  package: string;
  compiled: string;
}

export interface SavedRevision {
  revision: CaseRevision;
  /** The same content was sealed before: nothing new exists. */
  existing: boolean;
}

interface Snapshot {
  id: string;
  irDigest: string;
}

/** A case revision's package: its registered resources as they are, or the files of the snapshot it came from. */
async function packageOfRevision(revision: CaseRevision): Promise<WorkspaceFiles> {
  const spec = revision.document.spec as { resources?: Record<string, Record<string, unknown>> } | undefined;
  const exact = Object.values(spec?.resources || {}).every((group) => Object.values(group).every((target) => isRegisteredResourceRef(target)));
  if (exact) return { 'instance.json': pretty(revision.document) };
  if (revision.source_snapshot_id) return unzipPackage(await platformApi.snapshotArchive(revision.source_snapshot_id));
  return { 'instance.json': pretty(revision.document) };
}

/** Read a package and have the gateway check it. Throws for a package that isn't a bim/v1 Instance or isn't valid. */
async function checkedPackage(archive: ArrayBuffer): Promise<{ files: WorkspaceFiles; response: BimAnalysisResponse }> {
  const candidateFiles = await unzipPackage(archive);
  const candidateRoot = parseJson(candidateFiles['instance.json']);
  if (candidateRoot?.apiVersion !== 'bim/v1' || candidateRoot?.kind !== 'Instance') {
    throw Object.assign(new HttpError(422, 'The package root must be a bim/v1 Instance.'), {
      diagnostics: [{ code: 'not_instance', message: 'The package root must be a bim/v1 Instance.', resource: 'instance.json' }],
    });
  }
  const canonicalFiles = packageFiles(candidateFiles);
  const response = await workbenchApi.validate(zipStore(canonicalFiles));
  if (response.valid === false) {
    throw Object.assign(new HttpError(422, 'The BIM package did not pass validation.'), { diagnostics: response.diagnostics ?? [] });
  }
  return { files: canonicalFiles, response };
}

const bpmnPathOf = (files: WorkspaceFiles) => Object.keys(files).find((path) => path.endsWith('.bpmn'));

const digestsOf = (response: BimAnalysisResponse): PackageDigests => ({
  instance: String(response.instanceDigest ?? ''),
  package: String(response.packageDigest ?? ''),
  compiled: String(response.irDigest ?? ''),
});

/** What opening the screen found for its address: the draft of the workspace, a case revision, an example, or nothing yet. */
type Hydration =
  | { scope: string; kind: 'files'; files: WorkspaceFiles; migrated: string[] }
  | { scope: string; kind: 'example'; files: WorkspaceFiles; response: BimAnalysisResponse }
  | { scope: string; kind: 'example-refused'; failure: Refusal; diagnostics: Diagnostic[] }
  | { scope: string; kind: 'revision-refused'; failure: Refusal };

interface HydrationRequest {
  scope: string;
  requestedExample: string;
  caseRef: string | null;
  revisionRef: string | null;
  orgSlug: string;
  projectSlug: string;
}

async function hydrate({ scope, requestedExample, caseRef, revisionRef, orgSlug, projectSlug }: HydrationRequest): Promise<Hydration> {
  if (requestedExample) {
    try {
      const prepared = await checkedPackage(await apiClient.getBimExamplePackage(requestedExample));
      return { scope, kind: 'example', files: prepared.files, response: prepared.response };
    } catch (reason: unknown) {
      const failure = refusalOf(reason);
      return { scope, kind: 'example-refused', failure, diagnostics: failure.diagnostics.length ? failure.diagnostics : errorDiagnostics(reason, 'example') };
    }
  }
  let draft = await loadDraft(scope);
  if (!draft && caseRef && revisionRef && orgSlug && projectSlug) {
    try {
      const revisions = await platformApi.caseRevisions(orgSlug, projectSlug, caseRef);
      const revision = revisions.find((item) => item.id === revisionRef || String(item.revision) === revisionRef);
      if (!revision) throw new HttpError(404, 'The selected case revision is unavailable.');
      draft = await packageOfRevision(revision);
    } catch (reason: unknown) {
      return { scope, kind: 'revision-refused', failure: refusalOf(reason) };
    }
  }
  if (!draft || parseJson(draft['instance.json'])?.apiVersion !== 'bim/v1') return { scope, kind: 'files', files: DEFAULT_FILES, migrated: [] };
  // A draft kept before the editors wrote the vocabulary of the schemas is read in both and opened in the real one.
  const migrated = migrateFiles(draft);
  return { scope, kind: 'files', files: migrated.value, migrated: migrated.notes };
}

/**
 * The state of the workbench: the files of the package and the history of editing them, what the gateway said when it checked them,
 * the snapshot and revision made from them, and the run. Screens read it and call its actions; nothing here draws.
 */
export function useWorkbench({ orgSlug, projectSlug, userId, pathname, caseRef, revisionRef, requestedExample }: WorkbenchOptions) {
  const draftScope = workbenchDraftScope(userId, pathname, caseRef, revisionRef);

  // The package
  const [files, setFiles] = useState<WorkspaceFiles>(DEFAULT_FILES);
  const [baseline, setBaseline] = useState<WorkspaceFiles>(DEFAULT_FILES);
  const [selectedPath, setSelectedPath] = useState('instance.json');
  const [bpmnDraft, setBpmnDraft] = useState(DEFAULT_BPMN);
  const [hydratedScope, setHydratedScope] = useState<string | null>(null);
  const [historyDepth, setHistoryDepth] = useState(0);
  const [revisionRefusal, setRevisionRefusal] = useState<{ scope: string; failure: Refusal } | null>(null);
  const [draftIssue, setDraftIssue] = useState<string | null>(null);
  const [migrationNotes, setMigrationNotes] = useState<string[]>([]);
  const [examples, setExamples] = useState<string[]>([]);
  const [attempt, setAttempt] = useState(0);
  const historyRef = useRef<WorkspaceFiles[]>([]);
  const filesRef = useRef<WorkspaceFiles>(DEFAULT_FILES);

  // The check
  const [status, setStatus] = useState<WorkspaceStatus>('idle');
  const [origin, setOrigin] = useState<CheckOrigin>('package');
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([]);
  const [allModes, setAllModes] = useState<CompatibleMode[]>([]);
  const [compatibleModes, setCompatibleModes] = useState<CompatibleMode[]>([]);
  const [analysisData, setAnalysisData] = useState<BimAnalysisData | null>(null);
  const [digests, setDigests] = useState<PackageDigests | null>(null);

  // The snapshot and the revision
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const snapshotRef = useRef<Snapshot | null>(null);
  /** Closing the screen stops the polling of a run; starting another run stops the one before it. */
  const screenOpen = useRef<AbortController | null>(null);
  const runWatcher = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    screenOpen.current = controller;
    return () => controller.abort();
  }, []);
  const [snapshotBusy, setSnapshotBusy] = useState(false);
  const [snapshotIssue, setSnapshotIssue] = useState<Refusal | null>(null);
  const [compiledIr, setCompiledIr] = useState<CompiledIr | null>(null);
  const [irLoading, setIrLoading] = useState(false);
  const [irError, setIrError] = useState<string | null>(null);
  const [saveBusy, setSaveBusy] = useState(false);
  const [saved, setSaved] = useState<SavedRevision | null>(null);
  const [saveIssue, setSaveIssue] = useState<string | null>(null);

  // The run
  const [runState, setRunState] = useState<RunState>('idle');
  const [runError, setRunError] = useState<string | null>(null);
  const [runRange, setRunRange] = useState(false);
  const [result, setResult] = useState<BindingResult | null>(null);
  const [resultJobId, setResultJobId] = useState<string>();
  const [selectedMode, setSelectedMode] = useState('');
  const [configuration, setConfiguration] = useState<{ org: string; version: ArtifactVersion } | null>(null);
  const [routingProvenance, setRoutingProvenance] = useState<EngineRoutingUserProvenance | null>(null);
  const [autoProfile, setAutoProfile] = useState<AutoProfile>('balanced');
  const [autoMaxCredits, setAutoMaxCredits] = useState(40);
  const [autoMinQuality, setAutoMinQuality] = useState(0.85);
  const [autoMaxFailureRisk, setAutoMaxFailureRisk] = useState(0.3);
  const [autoRequireExact, setAutoRequireExact] = useState(false);
  const [autoAllowFallback, setAutoAllowFallback] = useState(true);

  // The editor
  const [editorTab, setEditorTab] = useState<EditorTab>('resources');
  const [sourceOpen, setSourceOpen] = useState(false);
  const [sourceView, setSourceView] = useState<SourceView>('json');
  const [focusedBpmnElement, setFocusedBpmnElement] = useState<string | null>(null);
  const [editorSelection, setEditorSelection] = useState<{ anchor: number; head: number } | undefined>();

  /** A configuration picked for one organization is not carried to another. */
  const executionConfiguration = configuration?.org === orgSlug ? configuration.version : null;
  const setExecutionConfiguration = (version: ArtifactVersion | null) => setConfiguration(version ? { org: orgSlug, version } : null);

  const hydrated = hydratedScope === draftScope;
  const loadIssue = revisionRefusal?.scope === draftScope ? revisionRefusal.failure : null;
  const root = useMemo(() => parseJson(files['instance.json']), [files]);
  const resources = useMemo(() => instanceResources(root, files), [root, files]);
  const selectedDocument = useMemo(() => parseJson(files[selectedPath]), [files, selectedPath]);
  const applicationResource = resources.find((resource) => resource.role === 'application' && resource.kind === 'Application');
  const application = applicationResource?.path ? parseJson(files[applicationResource.path]) : null;
  const bpmnPath = resources.find((resource) => resource.kind === 'BPMN')?.path;
  const workflowText = pretty(application?.spec?.workflow || {});
  const selectedCompatibility = compatibleModes.find((item) => executionKey(item) === selectedMode);
  const selectedResource = resources.find((resource) => resource.path === selectedPath);
  const selectedKind = selectedPath === 'instance.json' ? 'Instance' : selectedResource?.kind || selectedDocument?.kind || 'Unknown';
  const selectedYaml = useMemo(() => (selectedDocument ? toYaml(selectedDocument) : null), [selectedDocument]);
  const selectedDiff = useMemo(
    () => sourceDiff(baseline[selectedPath] || '', files[selectedPath] || ''),
    [baseline, files, selectedPath],
  );
  const selectedChanged = baseline[selectedPath] !== files[selectedPath];
  const rootDocument = root as Record<string, unknown> | null;
  const hasRanges = useMemo(() => filesHaveRanges(files), [files]);

  // --- bringing a package in

  /** The workspace changes: the files the next call reads are these, even before the screen has drawn them. */
  const commitFiles = (next: WorkspaceFiles) => {
    filesRef.current = next;
    setFiles(next);
  };

  const clearChecks = () => {
    setStatus('idle');
    setRefusal(null);
    setDiagnostics([]);
    setAllModes([]);
    setCompatibleModes([]);
    setAnalysisData(null);
    setDigests(null);
    setSelectedMode((current) => (current === 'auto' ? 'auto' : ''));
    snapshotRef.current = null;
    setSnapshot(null);
    setSnapshotIssue(null);
    setCompiledIr(null);
    setIrError(null);
    setSaved(null);
    setSaveIssue(null);
    setResult(null);
    setRunState('idle');
    setRunError(null);
  };

  const remember = (current: WorkspaceFiles) => {
    historyRef.current = [...historyRef.current.slice(-39), current];
    setHistoryDepth(historyRef.current.length);
  };

  const showBpmnOf = (next: WorkspaceFiles) => {
    const nextBpmn = bpmnPathOf(next);
    setBpmnDraft(nextBpmn ? next[nextBpmn] : DEFAULT_BPMN);
  };

  const applyHydration = useEffectEvent((outcome: Hydration) => {
    if (outcome.kind === 'files') {
      commitFiles(outcome.files);
      setBaseline(outcome.files);
      setMigrationNotes(outcome.migrated);
      showBpmnOf(outcome.files);
      setSelectedPath('instance.json');
      clearChecks();
    } else if (outcome.kind === 'example') {
      commitFiles(outcome.files);
      setBaseline(outcome.files);
      showBpmnOf(outcome.files);
      const modes = modesFromAnalysis(outcome.response);
      setOrigin('example');
      setAllModes(allModesFromAnalysis(outcome.response));
      setCompatibleModes(modes);
      setAnalysisData(outcome.response.analysis || null);
      setDigests(digestsOf(outcome.response));
      setSelectedMode(modes[0] ? executionKey(modes[0]) : '');
      setStatus('valid');
    } else if (outcome.kind === 'example-refused') {
      setOrigin('example');
      setStatus('failed');
      setRefusal(outcome.failure);
      setDiagnostics(outcome.diagnostics);
    } else {
      setRevisionRefusal({ scope: outcome.scope, failure: outcome.failure });
      return;
    }
    setHydratedScope(outcome.scope);
  });

  useEffect(() => {
    let active = true;
    void hydrate({ scope: draftScope, requestedExample, caseRef, revisionRef, orgSlug, projectSlug }).then((outcome) => {
      if (active) applyHydration(outcome);
    });
    void apiClient.getBimExamples().then((value) => { if (active) setExamples(value); }).catch(() => { if (active) setExamples([]); });
    return () => { active = false; };
  }, [draftScope, requestedExample, caseRef, revisionRef, orgSlug, projectSlug, attempt]);

  /** Read the case revision again after it could not be loaded. */
  const retryLoad = () => {
    setRevisionRefusal(null);
    setAttempt((value) => value + 1);
  };

  useEffect(() => {
    if (hydratedScope !== draftScope) return;
    void saveDraft(files, draftScope)
      .then(() => setDraftIssue(null))
      .catch((reason: unknown) => setDraftIssue(reason instanceof Error ? reason.message : 'This draft could not be kept in the browser.'));
  }, [files, hydratedScope, draftScope]);

  /** A whole package replaces the workspace: a new baseline and fresh checks. */
  const replaceWorkspace = (nextFiles: WorkspaceFiles) => {
    remember(filesRef.current);
    setBaseline(nextFiles);
    commitFiles(nextFiles);
    setSelectedPath('instance.json');
    setEditorTab('resources');
    showBpmnOf(nextFiles);
    clearChecks();
  };

  const updateWorkspace = (updater: (current: WorkspaceFiles) => WorkspaceFiles) => {
    const current = filesRef.current;
    remember(current);
    commitFiles(updater(current));
    clearChecks();
  };

  const undo = () => {
    const previous = historyRef.current.pop();
    if (!previous) return;
    commitFiles(previous);
    setHistoryDepth(historyRef.current.length);
    showBpmnOf(previous);
    clearChecks();
  };

  const reset = () => {
    remember(filesRef.current);
    commitFiles(baseline);
    showBpmnOf(baseline);
    setSelectedPath('instance.json');
    setEditorTab('resources');
    setRoutingProvenance(null);
    clearChecks();
  };

  // --- the check

  /** Have the gateway check the package. Answers with its analysis, or `null` when it refused. */
  const validate = async (candidateFiles: WorkspaceFiles = filesRef.current): Promise<BimAnalysisResponse | null> => {
    setStatus('validating');
    setOrigin('package');
    setRefusal(null);
    setDiagnostics([]);
    setResult(null);
    try {
      const response = await workbenchApi.validate(zipStore(packageFiles(candidateFiles)));
      if (response.valid === false) {
        const problems = (response.diagnostics ?? []) as Diagnostic[];
        setStatus('failed');
        setRefusal({ kind: 'invalid', status: 422, message: 'The package is not valid.', diagnostics: problems });
        setDiagnostics(problems);
        return null;
      }
      const modes = modesFromAnalysis(response);
      setAllModes(allModesFromAnalysis(response));
      setCompatibleModes(modes);
      setAnalysisData(response.analysis || null);
      setDigests(digestsOf(response));
      setSelectedMode((current) => (current === 'auto' ? 'auto' : modes.some((item) => executionKey(item) === current) ? current : modes[0] ? executionKey(modes[0]) : ''));
      setDiagnostics((response.diagnostics ?? []) as Diagnostic[]);
      setStatus('valid');
      return response;
    } catch (caught: unknown) {
      const failure = refusalOf(caught);
      setStatus('failed');
      setRefusal(failure);
      setDiagnostics(failure.diagnostics.length || failure.kind !== 'invalid' ? failure.diagnostics : errorDiagnostics(caught, 'analysis'));
      return null;
    }
  };

  /** Bring in a `.bim.zip` or an example. It replaces the workspace only when the gateway accepts it; otherwise the workspace stays as it was. */
  const importArchive = async (archive: ArrayBuffer, from: CheckOrigin = 'import') => {
    setStatus('validating');
    setOrigin(from);
    setRefusal(null);
    try {
      const prepared = await checkedPackage(archive);
      replaceWorkspace(prepared.files);
      const modes = modesFromAnalysis(prepared.response);
      setAllModes(allModesFromAnalysis(prepared.response));
      setCompatibleModes(modes);
      setAnalysisData(prepared.response.analysis || null);
      setDigests(digestsOf(prepared.response));
      if (modes[0]) setSelectedMode(executionKey(modes[0]));
      setStatus('valid');
    } catch (caught: unknown) {
      const failure = refusalOf(caught);
      setStatus('failed');
      setRefusal(failure);
      setDiagnostics(failure.diagnostics.length ? failure.diagnostics : errorDiagnostics(caught, from));
    }
  };

  /** A file the person chose or dropped: refused here when it is bigger than the plan takes in one request, as the gateway would (413). */
  const importFile = async (file: File, maxBytes: number | null) => {
    if (maxBytes !== null && file.size > maxBytes) {
      setStatus('failed');
      setOrigin('import');
      setDiagnostics([]);
      setRefusal({ kind: 'too-large', status: 413, message: 'The file is larger than the plan allows per request.', diagnostics: [] });
      return;
    }
    await importArchive(await file.arrayBuffer(), 'import');
  };

  const loadExample = async (path: string) => {
    if (!path) return;
    setStatus('validating');
    setOrigin('example');
    setRefusal(null);
    try {
      await importArchive(await apiClient.getBimExamplePackage(path), 'example');
    } catch (caught: unknown) {
      const failure = refusalOf(caught);
      setStatus('failed');
      setRefusal(failure);
      setDiagnostics(failure.diagnostics.length ? failure.diagnostics : errorDiagnostics(caught, 'example'));
    }
  };

  const exportPackage = () => {
    try {
      const archive = zipStore(files);
      const archiveBuffer = archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength) as ArrayBuffer;
      const url = URL.createObjectURL(new Blob([archiveBuffer], { type: 'application/vnd.bim+zip' }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${root?.metadata?.name || 'instance'}.bim.zip`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (caught: unknown) {
      setStatus('failed');
      setDiagnostics(errorDiagnostics(caught, 'export'));
    }
  };

  // --- snapshot, compiled form, revision

  /** The private snapshot of the package as it is now: made once, reused until the package changes. */
  const ensureSnapshot = async (): Promise<Snapshot> => {
    if (snapshotRef.current) return snapshotRef.current;
    const made = await workbenchApi.snapshot(zipStore(packageFiles(filesRef.current)));
    snapshotRef.current = made;
    setSnapshot(made);
    return made;
  };

  /** Snapshot the package and read its compiled form. */
  const compile = async (): Promise<boolean> => {
    setIrLoading(true);
    setIrError(null);
    setSnapshotBusy(true);
    setSnapshotIssue(null);
    try {
      const made = await ensureSnapshot();
      const document = await workbenchApi.ir(made.id);
      setCompiledIr({ snapshot: made.id, digest: made.irDigest, document });
      return true;
    } catch (caught: unknown) {
      const failure = refusalOf(caught);
      setSnapshotIssue(failure);
      setIrError(refusalText(failure, 'the package could not be compiled'));
      return false;
    } finally {
      setIrLoading(false);
      setSnapshotBusy(false);
    }
  };

  const saveRevision = async (caseSlug: string, existing: readonly CaseRevision[]) => {
    if (!rootDocument) return;
    setSaveBusy(true);
    setSaveIssue(null);
    setSaved(null);
    try {
      const made = await ensureSnapshot();
      const revision = await workbenchApi.saveRevision(orgSlug, projectSlug, caseSlug, rootDocument, made.id);
      setSaved({ revision, existing: existing.some((item) => item.id === revision.id) });
    } catch (caught: unknown) {
      setSaveIssue(saveRefusalText(refusalOf(caught)));
    } finally {
      setSaveBusy(false);
    }
  };

  // --- the run

  const run = async () => {
    const isAutoRouter = selectedMode === 'auto';
    let mode = selectedCompatibility;
    if (!mode && !executionConfiguration && !isAutoRouter) {
      const analysis = await validate();
      if (!analysis) return;
      mode = modesFromAnalysis(analysis)[0];
    }
    if (!mode && !executionConfiguration && !isAutoRouter) {
      setRunState('failed');
      setRunError('No engine mode is compatible with this package. Open “Engines that can run it” to see why.');
      return;
    }
    setRunState('queued');
    setRunError(null);
    setRunRange(false);
    setRoutingProvenance(null);
    setResult(null);
    runWatcher.current?.abort();
    const watcher = new AbortController();
    runWatcher.current = watcher;
    screenOpen.current?.signal.addEventListener('abort', () => watcher.abort(), { once: true });
    try {
      const made = await ensureSnapshot();
      const receipt = isAutoRouter
        ? await apiClient.createAutoRouterBimJob(made.id, {
          strategy: 'auto',
          profile: autoProfile,
          hardConstraints: {
            maxCredits: autoMaxCredits,
            minQuality: autoMinQuality,
            maxFailureRisk: autoMaxFailureRisk,
            requireExact: autoRequireExact,
          },
          adaptation: { allowFallback: autoAllowFallback },
        })
        : executionConfiguration
          ? await apiClient.createConfiguredBimJob(made.id, executionConfiguration.ref)
          : await apiClient.createBimJob(made.id, mode!.engine, mode!.registration, mode!.mode);
      if (watcher.signal.aborted) return;
      const job = await pollV1Job(receipt.id, { signal: watcher.signal, onStatus: (reading) => { if (reading.status === 'running') setRunState('running'); } });
      if (job.status === 'failed') {
        const detail = isRecord(job.result) && typeof job.result.error === 'string' ? job.result.error : (job.error || 'The run failed.');
        throw new Error(detail);
      }
      setResultJobId(receipt.id);
      if (isRecord(job.provenance) && isRecord(job.provenance.engineRouting)) {
        setRoutingProvenance(job.provenance.engineRouting as unknown as EngineRoutingUserProvenance);
      }
      setResult(isRecord(job.result) ? job.result as BindingResult : null);
      setRunState('completed');
    } catch (caught: unknown) {
      // The screen closed or a newer run took over: nobody is waiting for this one any more.
      if (watcher.signal.aborted || isAbort(caught)) return;
      setRunState('failed');
      if (isRangeRefusal(caught)) {
        setRunRange(true);
        setRunError(`${RANGE_RUN_ERROR}${rangePointers(caught)}`);
        return;
      }
      setRunError(refusalText(refusalOf(caught), 'the run did not finish'));
    }
  };

  // --- editing

  const updateSelectedDocument = (document: BimDocument) => updateWorkspace((current) => ({ ...current, [selectedPath]: pretty(document) }));

  const updateSource = (path: string, value: string) => {
    setEditorSelection(undefined);
    updateWorkspace((current) => ({ ...current, [path]: value }));
  };

  const updateWorkflow = (value: string) => {
    if (!applicationResource?.path || !application) return;
    try {
      const workflow = JSON.parse(value);
      updateWorkspace((current) => ({ ...current, [applicationResource.path!]: pretty({ ...application, spec: { ...application.spec, workflow } }) }));
    } catch {
      // The source editor keeps the unfinished value without corrupting a valid document.
    }
  };

  const acceptBpmn = (xml: string) => {
    if (!bpmnPath) return;
    const normalized = xml.replace(/\r\n?/g, '\n');
    if (filesRef.current[bpmnPath] !== normalized) updateWorkspace((current) => ({ ...current, [bpmnPath]: normalized }));
    setBpmnDraft(xml);
    setDiagnostics((current) => current.filter((item) => item.code !== 'bpmn-editor'));
  };

  const bpmnFailed = (message: string) => {
    setDiagnostics((current) => [...current.filter((item) => item.code !== 'bpmn-editor'), { code: 'bpmn-editor', message }]);
  };

  const updateBpmnDraft = (xml: string) => {
    setBpmnDraft(xml);
    const parsed = new DOMParser().parseFromString(xml, 'application/xml');
    const parserError = parsed.getElementsByTagName('parsererror')[0];
    setDiagnostics((current) => {
      const retained = current.filter((item) => item.code !== 'bpmn-editor');
      if (!parserError) return retained;
      const detail = parserError.textContent?.replace(/\s+/g, ' ').trim() || 'invalid XML';
      return [...retained, { code: 'bpmn-editor', message: `BPMN XML was not applied: ${detail}` }];
    });
  };

  const selectResource = (path: string, kind?: string) => {
    setSelectedPath(path);
    setEditorTab(kind === 'BPMN' ? 'bpmn' : 'form');
  };

  /** Show a diagnostic where it lives: the BPMN element in the diagram, or the place in the source of its file. */
  const openDiagnostic = (item: Diagnostic) => {
    const element = item.bpmnElement || item.element;
    if (element && bpmnPath) {
      setFocusedBpmnElement(element);
      setEditorTab('bpmn');
      return;
    }
    const path = resourcePathForDiagnostic(resources, item);
    if (path && files[path] !== undefined) {
      setSelectedPath(path);
      setEditorSelection(diagnosticSelection(files[path], item));
    } else {
      setEditorSelection(diagnosticSelection(files[selectedPath] || '', item));
    }
    setSourceView('json');
    setSourceOpen(true);
  };

  return {
    // package
    files, selectedPath, bpmnDraft, hydrated, historyDepth, loadIssue, draftIssue, migrationNotes, dismissMigration: () => setMigrationNotes([]), examples, baseline,
    root, resources, selectedDocument, selectedResource, selectedKind, selectedYaml, selectedDiff, selectedChanged, application,
    bpmnPath, workflowText,
    // check: while an example is being brought in, the package is being checked
    status: !hydrated && requestedExample ? 'validating' as WorkspaceStatus : status,
    origin, refusal, diagnostics, allModes, compatibleModes, analysisData, digests,
    // snapshot and revision
    snapshot, snapshotBusy, snapshotIssue, compiledIr, irLoading, irError, saveBusy, saved, saveIssue,
    // run
    hasRanges, runRange, runState, runError, result, resultJobId, selectedMode, setSelectedMode, executionConfiguration, setExecutionConfiguration, routingProvenance,
    autoProfile, setAutoProfile, autoMaxCredits, setAutoMaxCredits, autoMinQuality, setAutoMinQuality, autoMaxFailureRisk, setAutoMaxFailureRisk,
    autoRequireExact, setAutoRequireExact, autoAllowFallback, setAutoAllowFallback,
    // editor
    editorTab, setEditorTab, sourceOpen, setSourceOpen, sourceView, setSourceView, focusedBpmnElement, editorSelection,
    // actions
    validate, importArchive, importFile, loadExample, exportPackage, ensureSnapshot, compile, saveRevision, run, retryLoad,
    undo, reset, updateWorkspace, updateSelectedDocument, updateSource, updateWorkflow, acceptBpmn, bpmnFailed, updateBpmnDraft, selectResource, openDiagnostic,
  };
}

export type Workbench = ReturnType<typeof useWorkbench>;
