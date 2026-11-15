import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import { bimApi } from '../../api/bim';
import { HttpError, type BimAnalysisData, type BimAnalysisResponse } from '../../api/client';
import { problemsApi, type ProblemUpload } from '../../api/problems';
import { packageFiles, unzipPackage, zipStore } from '../../utils/bimZip';
import { migrateFiles } from '../../utils/bimVocabulary';
import { loadDraft, saveDraft, type WorkspaceFiles } from '../../utils/workspaceDraft';
import { sourceDiff, toYaml } from '../../utils/workspaceViews';
import {
  DEFAULT_BPMN, DEFAULT_FILES, allModesFromAnalysis, diagnosticSelection, errorDiagnostics, instanceResources,
  modesFromAnalysis, parseJson, pretty, resourcePathForDiagnostic,
  type BimDocument, type CompatibleMode, type CompiledIr, type Diagnostic, type WorkspaceStatus,
} from './bimDocuments';
import { refusalOf, refusalText, saveRefusalText, workbenchDraftScope, type Refusal } from './workbenchModel';

export type EditorTab = 'resources' | 'form' | 'bpmn';
export type SourceView = 'json' | 'yaml' | 'workflow' | 'bpmnXml' | 'ir' | 'diff';

/** Where the package on screen was last checked from: the editor, or a file or template that was brought in. */
export type CheckOrigin = 'package' | 'import' | 'example';

export interface WorkbenchOptions {
  orgSlug: string;
  userId?: string;
  pathname: string;
  /** The problem the address opens (`?problem=`). */
  problemRef: string | null;
  /** Its version, by number or id (`?revision=`); the newest without it. */
  revisionRef: string | null;
  /** The template the address opens (`?template=`). */
  requestedExample: string;
}

export interface PackageDigests {
  instance: string;
  package: string;
  compiled: string;
}

export interface SavedRevision {
  /** What the save made: the problem, its revision and compilation. */
  upload: ProblemUpload;
  /** The package already was that version (200): nothing new exists. */
  existing: boolean;
}

/** What a save targets: a new problem of the organization, or a new version of one of its problems. */
export type SaveTarget = { kind: 'new'; slug?: string; name?: string } | { kind: 'version'; problem: string };

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
  const response = await bimApi.validate(zipStore(canonicalFiles));
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

/** What opening the screen found for its address: the draft of the workspace, a problem version, a template, or nothing yet. */
type Hydration =
  | { scope: string; kind: 'files'; files: WorkspaceFiles; migrated: string[] }
  | { scope: string; kind: 'example'; files: WorkspaceFiles; response: BimAnalysisResponse }
  | { scope: string; kind: 'example-refused'; failure: Refusal; diagnostics: Diagnostic[] }
  | { scope: string; kind: 'revision-refused'; failure: Refusal };

interface HydrationRequest {
  scope: string;
  requestedExample: string;
  problemRef: string | null;
  revisionRef: string | null;
  orgSlug: string;
}

/** The package of a problem version, exactly as it was uploaded: the newest version when none is named. */
async function packageOfRevision(org: string, problem: string, revisionRef: string | null): Promise<WorkspaceFiles> {
  let revision = revisionRef;
  if (!revision) {
    const revisions = await problemsApi.revisions(org, problem);
    const newest = [...revisions].sort((a, b) => b.revision - a.revision)[0];
    if (!newest) throw new HttpError(404, 'This problem has no version yet.');
    revision = String(newest.revision);
  }
  return unzipPackage(await problemsApi.source(org, problem, revision));
}

async function hydrate({ scope, requestedExample, problemRef, revisionRef, orgSlug }: HydrationRequest): Promise<Hydration> {
  if (requestedExample) {
    try {
      const prepared = await checkedPackage(await bimApi.template(requestedExample));
      return { scope, kind: 'example', files: prepared.files, response: prepared.response };
    } catch (reason: unknown) {
      const failure = refusalOf(reason);
      return { scope, kind: 'example-refused', failure, diagnostics: failure.diagnostics.length ? failure.diagnostics : errorDiagnostics(reason, 'example') };
    }
  }
  let draft = await loadDraft(scope);
  if (!draft && problemRef && orgSlug) {
    try {
      draft = await packageOfRevision(orgSlug, problemRef, revisionRef);
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
 * and the problem version saved from them. Nothing runs here: a saved version runs from its problem page. Screens read it and call its
 * actions; nothing here draws.
 */
export function useWorkbench({ orgSlug, userId, pathname, problemRef, revisionRef, requestedExample }: WorkbenchOptions) {
  const draftScope = workbenchDraftScope(userId, pathname, problemRef, revisionRef);

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

  // The compiled form and the saved version
  const [compiledIr, setCompiledIr] = useState<CompiledIr | null>(null);
  const [irLoading, setIrLoading] = useState(false);
  const [irError, setIrError] = useState<string | null>(null);
  const [saveBusy, setSaveBusy] = useState(false);
  const [saved, setSaved] = useState<SavedRevision | null>(null);
  const [saveIssue, setSaveIssue] = useState<string | null>(null);

  // The editor
  const [editorTab, setEditorTab] = useState<EditorTab>('resources');
  const [sourceOpen, setSourceOpen] = useState(false);
  const [sourceView, setSourceView] = useState<SourceView>('json');
  const [focusedBpmnElement, setFocusedBpmnElement] = useState<string | null>(null);
  const [editorSelection, setEditorSelection] = useState<{ anchor: number; head: number } | undefined>();

  const hydrated = hydratedScope === draftScope;
  const loadIssue = revisionRefusal?.scope === draftScope ? revisionRefusal.failure : null;
  const root = useMemo(() => parseJson(files['instance.json']), [files]);
  const resources = useMemo(() => instanceResources(root, files), [root, files]);
  const selectedDocument = useMemo(() => parseJson(files[selectedPath]), [files, selectedPath]);
  const applicationResource = resources.find((resource) => resource.role === 'application' && resource.kind === 'Application');
  const application = applicationResource?.path ? parseJson(files[applicationResource.path]) : null;
  const bpmnPath = resources.find((resource) => resource.kind === 'BPMN')?.path;
  const workflowText = pretty(application?.spec?.workflow || {});
  const selectedResource = resources.find((resource) => resource.path === selectedPath);
  const selectedKind = selectedPath === 'instance.json' ? 'Instance' : selectedResource?.kind || selectedDocument?.kind || 'Unknown';
  const selectedYaml = useMemo(() => (selectedDocument ? toYaml(selectedDocument) : null), [selectedDocument]);
  const selectedDiff = useMemo(
    () => sourceDiff(baseline[selectedPath] || '', files[selectedPath] || ''),
    [baseline, files, selectedPath],
  );
  const selectedChanged = baseline[selectedPath] !== files[selectedPath];

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
    setCompiledIr(null);
    setIrError(null);
    setSaved(null);
    setSaveIssue(null);
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
    void hydrate({ scope: draftScope, requestedExample, problemRef, revisionRef, orgSlug }).then((outcome) => {
      if (active) applyHydration(outcome);
    });
    void bimApi.templates().then((value) => { if (active) setExamples(value); }).catch(() => { if (active) setExamples([]); });
    return () => { active = false; };
  }, [draftScope, requestedExample, problemRef, revisionRef, orgSlug, attempt]);

  /** Read the problem version again after it could not be loaded. */
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
    clearChecks();
  };

  // --- the check

  /** Have the gateway check the package. Answers with its analysis, or `null` when it refused. */
  const validate = async (candidateFiles: WorkspaceFiles = filesRef.current): Promise<BimAnalysisResponse | null> => {
    setStatus('validating');
    setOrigin('package');
    setRefusal(null);
    setDiagnostics([]);
    try {
      const response = await bimApi.validate(zipStore(packageFiles(candidateFiles)));
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

  /** Bring in a `.bim.zip` or a template. It replaces the workspace only when the gateway accepts it; otherwise the workspace stays as it was. */
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
      setStatus('valid');
    } catch (caught: unknown) {
      const failure = refusalOf(caught);
      setStatus('failed');
      setRefusal(failure);
      setDiagnostics(failure.diagnostics.length ? failure.diagnostics : errorDiagnostics(caught, from));
    }
  };

  /** A file the person chose or dropped: refused here when it is bigger than the deployment takes in one request, as the gateway would (413). */
  // No size check here: the deployment sets the ceiling, and its 413 says so.
  const importFile = async (file: File) => {
    await importArchive(await file.arrayBuffer(), 'import');
  };

  const loadExample = async (path: string) => {
    if (!path) return;
    setStatus('validating');
    setOrigin('example');
    setRefusal(null);
    try {
      await importArchive(await bimApi.template(path), 'example');
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

  // --- compiled form, saving

  /**
   * Read the compiled form of the package as it is now: the gateway validates it once more and answers with its IR, for the source
   * view, and its facts, for the workflow drawing (nothing is stored).
   */
  const compile = async (): Promise<boolean> => {
    setIrLoading(true);
    setIrError(null);
    try {
      const response = await bimApi.validate(zipStore(packageFiles(filesRef.current)), { include: 'ir,facts' });
      if (!response.ir || !response.facts) throw new HttpError(422, 'The gateway did not return the compiled form.');
      setCompiledIr({ digest: String(response.irDigest ?? ''), document: response.ir, facts: response.facts });
      return true;
    } catch (caught: unknown) {
      setIrError(refusalText(refusalOf(caught), 'the package could not be compiled'));
      return false;
    } finally {
      setIrLoading(false);
    }
  };

  /**
   * Save the package: as a new problem of the organization, or as a new version of one of its problems. The same package again is not a
   * new version: the gateway answers with the version it already is (200), and `saved.existing` says so.
   */
  const save = async (target: SaveTarget) => {
    setSaveBusy(true);
    setSaveIssue(null);
    setSaved(null);
    try {
      const archive = zipStore(packageFiles(filesRef.current));
      const upload = target.kind === 'new'
        ? await problemsApi.create(orgSlug, archive, { slug: target.slug, name: target.name })
        : await problemsApi.createRevision(orgSlug, target.problem, archive);
      setSaved({ upload, existing: !upload.created });
      return upload;
    } catch (caught: unknown) {
      setSaveIssue(saveRefusalText(refusalOf(caught)));
      return null;
    } finally {
      setSaveBusy(false);
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
    // compiled form and saved version
    compiledIr, irLoading, irError, saveBusy, saved, saveIssue,
    // editor
    editorTab, setEditorTab, sourceOpen, setSourceOpen, sourceView, setSourceView, focusedBpmnElement, editorSelection,
    // actions
    validate, importArchive, importFile, loadExample, exportPackage, compile, save, retryLoad,
    undo, reset, updateWorkspace, updateSelectedDocument, updateSource, updateWorkflow, acceptBpmn, bpmnFailed, updateBpmnDraft, selectResource, openDiagnostic,
  };
}

export type Workbench = ReturnType<typeof useWorkbench>;
