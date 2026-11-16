import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import {
  bimApi,
  type BimDiagnostic,
  type BimRefusal,
  type BimValidateResponse,
} from '../../../../api/bim';
import { HttpError } from '../../../../api/client';
import { problemsApi, type ProblemUpload } from '../../../../api/problems';
import { compositionsApi } from '../../../core/utils/composition/api';
import { bindingSelection } from '../../../core/utils/composition/viewModel';
import { refusalOf, refusalText, saveRefusalText, type Refusal } from '../../../core/api/refusals';
import type { ProblemFacts } from '../../../core/api/types';
import { fromBimAll } from '../../../core/diagnostics/bim';
import type { Located } from '../../../core/diagnostics/located';
import { draftScope as scopeOf, loadDraft } from '../../../core/editor/drafts';
import {
  createScheduler,
  pausedMessage,
  type Scheduler,
  type SchedulerStatus,
} from '../../../core/editor/lintScheduler';
import { useDraftStore } from '../../../core/editor/useDraftStore';
import { packageFiles, unzipPackage, zipStore } from '../../../../utils/bimZip';
import { DEFAULT_FILES, parseJson, type WorkspaceFiles } from './documents';

/** Milliseconds of stillness before the package is checked (`POST /v1/bim/validate?include=facts`, the compile budget; A-7). */
export const CHECK_DELAY_MS = 2000;

/** Who made a package the editor saves: the gateway records the version's origin from it. */
export const EDITOR_PRODUCER = 'openbinding-problem-editor';

export interface ProblemEditorOptions {
  org: string;
  userId?: string | null;
  /** The problem the address opens (`?problem=`), and its version by number or id (`?revision=`; the newest without it). */
  problem: string | null;
  revision: string | null;
  /** The template the address opens (`?template=`). */
  template: string | null;
  /** The composition version whose selection is highlighted (`?composition=&compositionVersion=`). */
  composition?: string | null;
  compositionVersion?: string | null;
  /** Open the blank package, whatever the browser kept for this address. */
  blank?: boolean;
  /** The delay of the live check, in milliseconds (tests shorten it). */
  delay?: number;
}

/** Where the package on screen came from. */
export type Origin =
  | { kind: 'template'; template: string }
  | { kind: 'draft'; revision: number | null }
  | { kind: 'revision'; revision: number }
  | { kind: 'blank' };

/** A template the address asked for that was not opened: it could not be read, or the gateway refused it. */
export interface TemplateIssue {
  template: string;
  message: string;
  diagnostics: Located[];
}

/** One answer of the gateway about one state of the package. */
export type CheckOutcome =
  | { files: WorkspaceFiles; valid: true; response: BimValidateResponse }
  | { files: WorkspaceFiles; valid: false; refusal: BimRefusal };

/** What a save came to. */
export type SaveOutcome =
  { kind: 'created' | 'unchanged'; upload: ProblemUpload } | { kind: 'refused'; message: string };

/** What a save targets: a new problem of the organization, or a new version of one of its problems. */
export type SaveTarget =
  { kind: 'new'; slug?: string; name?: string } | { kind: 'version'; problem: string };

/** The composition version highlighted on the package, as read. */
export interface Overlay {
  composition: string;
  name: string;
  label: string;
  /** Task → `<resource>/<id>`, from its current evaluation's binding. */
  selection: Record<string, string>;
  /** The problem version it links, as `<slug>@<revision>`; null when it links none. */
  linked: string | null;
}

interface Hydration {
  scope: string;
  files: WorkspaceFiles;
  origin: Origin;
  /** The gateway's answer about `files`, when opening already asked for it (a template). */
  checked: CheckOutcome | null;
  templateIssue: TemplateIssue | null;
  loadIssue: Refusal | null;
}

const sameFiles = (left: WorkspaceFiles, right: WorkspaceFiles) => {
  if (left === right) return true;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => right[key] === left[key]);
};

const isPackage = (files: WorkspaceFiles | null): files is WorkspaceFiles => {
  const root = files ? parseJson(files['instance.json']) : null;
  return root?.apiVersion === 'bim/v1';
};

/** The JSON files of the package whose text does not parse: the check waits until there are none. */
export function unparsedFiles(files: WorkspaceFiles): string[] {
  return Object.keys(files)
    .filter(path => {
      if (!/\.json$/i.test(path)) return false;
      try {
        JSON.parse(files[path]);
        return false;
      } catch {
        return true;
      }
    })
    .sort();
}

/** The archive of the package as the gateway reads it. */
const archiveOf = (files: WorkspaceFiles) => zipStore(packageFiles(files));

/** Have the gateway check a package: its analysis and facts, or its refusal (422) as a result. */
const check = (files: WorkspaceFiles, signal?: AbortSignal) =>
  bimApi.validate(archiveOf(files), { include: ['facts'], signal, acceptRefusal: true });

/**
 * The files of a template as it writes them (the check sends their canonical form); throws for a package that is not one, or whose
 * root is not a bim/v1 Instance.
 */
async function templatePackage(template: string): Promise<WorkspaceFiles> {
  const files = await unzipPackage(await bimApi.template(template));
  packageFiles(files);
  const root = parseJson(files['instance.json']);
  if (root?.apiVersion !== 'bim/v1' || root?.kind !== 'Instance')
    throw new HttpError(422, 'The package root must be a bim/v1 Instance.');
  return files;
}

/** The package of a problem version exactly as it was uploaded (the newest version when none is named), with its number. */
async function revisionPackage(
  org: string,
  problem: string,
  revisionRef: string | null
): Promise<{ files: WorkspaceFiles; revision: number }> {
  const revisions = await problemsApi.revisions(org, problem);
  const found = revisionRef
    ? revisions.find(item => String(item.revision) === revisionRef || item.id === revisionRef)
    : [...revisions].sort((a, b) => b.revision - a.revision)[0];
  if (!found)
    throw new HttpError(
      404,
      revisionRef ? 'That problem version does not exist.' : 'This problem has no version yet.'
    );
  return {
    files: await unzipPackage(await problemsApi.source(org, problem, found.revision)),
    revision: found.revision,
  };
}

/** What a refusal without findings says about the package as a whole (an archive the toolchain cannot read, a size limit). */
function refusalFindings(refusal: BimRefusal, files: WorkspaceFiles): Located[] {
  if (refusal.diagnostics.length) return fromBimAll(refusal.diagnostics, files, 'error');
  return [
    { code: refusal.code, message: refusal.message, severity: 'error', where: { kind: 'package' } },
  ];
}

/**
 * The order an editor opens in: the template the address names, once the gateway has accepted it; else the draft this browser
 * kept for the address; else the problem version's source; else the blank package.
 */
async function hydrate(scope: string, options: ProblemEditorOptions): Promise<Hydration> {
  const empty = { scope, checked: null, templateIssue: null, loadIssue: null };
  if (options.blank) return { ...empty, files: DEFAULT_FILES, origin: { kind: 'blank' } };
  let templateIssue: TemplateIssue | null = null;
  if (options.template) {
    try {
      const files = await templatePackage(options.template);
      const answer = await check(files);
      if (answer.valid) {
        return {
          ...empty,
          files,
          origin: { kind: 'template', template: options.template },
          checked: { files, valid: true, response: answer },
        };
      }
      templateIssue = {
        template: options.template,
        message: answer.message,
        diagnostics: refusalFindings(answer, files),
      };
    } catch (reason: unknown) {
      templateIssue = {
        template: options.template,
        message: refusalText(refusalOf(reason), 'the template was not opened'),
        diagnostics: [],
      };
    }
  }
  const kept = await loadDraft(scope);
  const revisionNumber =
    options.revision && /^\d+$/.test(options.revision) ? Number(options.revision) : null;
  if (isPackage(kept))
    return {
      ...empty,
      templateIssue,
      files: kept,
      origin: { kind: 'draft', revision: options.problem ? revisionNumber : null },
    };
  if (options.problem) {
    try {
      const opened = await revisionPackage(options.org, options.problem, options.revision);
      return {
        ...empty,
        templateIssue,
        files: opened.files,
        origin: { kind: 'revision', revision: opened.revision },
      };
    } catch (reason: unknown) {
      return {
        ...empty,
        templateIssue,
        files: DEFAULT_FILES,
        origin: { kind: 'blank' },
        loadIssue: refusalOf(reason),
      };
    }
  }
  return { ...empty, templateIssue, files: DEFAULT_FILES, origin: { kind: 'blank' } };
}

/**
 * The BIM problem editor without its screens: the files of the package and their 40-step history in the draft store
 * (`kind: problem`, per problem and version it started from), the live check (`validate?include=facts`, 2000 ms after the last
 * change, once every JSON file parses, paused by `Retry-After` on 429), the facts of the last valid package (kept, marked stale,
 * while the package is refused), the save as a new problem or a new version, and the composition version highlighted on it.
 */
export function useProblemEditor(options: ProblemEditorOptions) {
  const {
    org,
    userId,
    problem,
    revision,
    template,
    composition = null,
    compositionVersion = null,
    blank = false,
  } = options;
  const delay = options.delay ?? CHECK_DELAY_MS;
  const scope = scopeOf({
    user: userId,
    kind: 'problem',
    org,
    entity: problem || 'new',
    base: revision || 'none',
  });
  const draft = useDraftStore<WorkspaceFiles>({ scope, initial: DEFAULT_FILES });
  const { files } = draft;

  // -- Opening

  const [opened, setOpened] = useState<{
    scope: string;
    origin: Origin;
    templateIssue: TemplateIssue | null;
    loadIssue: Refusal | null;
  } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [last, setLast] = useState<CheckOutcome | null>(null);
  const [good, setGood] = useState<Extract<CheckOutcome, { valid: true }> | null>(null);
  const [checkIssue, setCheckIssue] = useState<Refusal | null>(null);
  const [status, setStatus] = useState<SchedulerStatus>({ state: 'idle' });
  /** The files the check last asked about (or is asking about): the same files again are not sent twice. */
  const asked = useRef<WorkspaceFiles | null>(null);

  const settle = useEffectEvent((outcome: Hydration) => {
    draft.start(outcome.files);
    asked.current = outcome.checked ? outcome.files : null;
    setLast(outcome.checked);
    setGood(outcome.checked?.valid ? outcome.checked : null);
    setCheckIssue(null);
    setOpened({
      scope: outcome.scope,
      origin: outcome.origin,
      templateIssue: outcome.templateIssue,
      loadIssue: outcome.loadIssue,
    });
  });

  // One opening per address: an effect that runs again for the same address (React's development double run) reads the same
  // answer instead of fetching and checking the template a second time against the compile budget.
  const opening = useRef<{ key: string; outcome: Promise<Hydration> } | null>(null);
  useEffect(() => {
    let active = true;
    const key = JSON.stringify([scope, template, blank, attempt]);
    if (opening.current?.key !== key)
      opening.current = { key, outcome: hydrate(scope, { ...options, blank }) };
    void opening.current.outcome.then(outcome => {
      if (active) settle(outcome);
    });
    return () => {
      active = false;
    };
    // The scope names the organization, the problem and the version; the template and `blank` are read with it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, template, blank, attempt]);

  const ready = draft.hydrated && opened?.scope === scope;

  // -- The live check

  const scheduler = useRef<Scheduler<WorkspaceFiles> | null>(null);
  useEffect(() => {
    const checks = createScheduler<WorkspaceFiles, BimValidateResponse | BimRefusal>({
      delay,
      run: (input, signal) => check(input, signal),
      onResult: (answer, input) => {
        setCheckIssue(null);
        if (answer.valid) {
          const outcome = { files: input, valid: true as const, response: answer };
          setLast(outcome);
          setGood(outcome);
        } else {
          setLast({ files: input, valid: false, refusal: answer });
        }
      },
      onError: reason => setCheckIssue(refusalOf(reason)),
      onStatus: setStatus,
    });
    scheduler.current = checks;
    return () => checks.dispose();
  }, [delay]);

  const unparsed = useMemo(() => unparsedFiles(files), [files]);

  useEffect(() => {
    if (!ready) return;
    if (unparsed.length) {
      scheduler.current?.cancel();
      asked.current = null;
      return;
    }
    if (asked.current && sameFiles(asked.current, files)) return;
    asked.current = files;
    scheduler.current?.schedule(files);
  }, [files, ready, unparsed]);

  /** Check the package as it is now, without waiting for the delay (still never during a pause). */
  const checkNow = useCallback(() => {
    const now = draft.current();
    if (unparsedFiles(now).length) return;
    asked.current = now;
    scheduler.current?.schedule(now);
    scheduler.current?.flush();
  }, [draft]);

  // While the check is paused the notice counts down.
  const pausedUntil = status.state === 'paused' ? status.until : null;
  const [, tick] = useState(0);
  useEffect(() => {
    if (pausedUntil === null) return undefined;
    const timer = window.setInterval(() => tick(value => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [pausedUntil]);

  const diagnostics = useMemo<Located[]>(() => {
    if (!last) return [];
    return last.valid
      ? fromBimAll((last.response.diagnostics ?? []) as BimDiagnostic[], last.files, 'warning')
      : refusalFindings(last.refusal, last.files);
  }, [last]);

  /** The package on screen is the one the last answer was about. */
  const upToDate = last !== null && sameFiles(last.files, files);
  const facts: ProblemFacts | null = good?.response.facts ?? null;
  /** The last answer refused the package: the facts shown are those of the last valid one. */
  const stale = last !== null && !last.valid && good !== null;

  // -- Saving

  const [saving, setSaving] = useState(false);
  const save = useCallback(
    async (target: SaveTarget): Promise<SaveOutcome> => {
      setSaving(true);
      try {
        const archive = archiveOf(draft.current());
        const upload =
          target.kind === 'new'
            ? await problemsApi.create(org, archive, {
                slug: target.slug,
                name: target.name,
                producer: EDITOR_PRODUCER,
              })
            : await problemsApi.createRevision(org, target.problem, archive, {
                producer: EDITOR_PRODUCER,
              });
        if (!upload.created) return { kind: 'unchanged', upload };
        await draft.forget();
        return { kind: 'created', upload };
      } catch (reason: unknown) {
        return { kind: 'refused', message: saveRefusalText(refusalOf(reason)) };
      } finally {
        setSaving(false);
      }
    },
    [draft, org]
  );

  // -- The composition version highlighted on the package

  const overlayKey =
    composition && compositionVersion ? `${org}/${composition}@${compositionVersion}` : null;
  const [overlay, setOverlay] = useState<{
    key: string;
    value: Overlay | null;
    issue: string | null;
  } | null>(null);
  useEffect(() => {
    if (!overlayKey || !composition || !compositionVersion) return undefined;
    let active = true;
    void Promise.all([
      compositionsApi.get(org, composition),
      compositionsApi.version(org, composition, compositionVersion),
    ]).then(
      ([found, version]) => {
        if (!active) return;
        const link = version.problem;
        setOverlay({
          key: overlayKey,
          issue: null,
          value: {
            composition,
            name: found.value.name,
            label: version.label,
            selection: bindingSelection(version),
            linked: link ? `${link.problem.slug}@${link.revision.revision}` : null,
          },
        });
      },
      (reason: unknown) => {
        if (active)
          setOverlay({
            key: overlayKey,
            value: null,
            issue: refusalText(refusalOf(reason), 'nothing is highlighted'),
          });
      }
    );
    return () => {
      active = false;
    };
    // The key names the organization, the composition and its version.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overlayKey]);
  const shownOverlay = overlay && overlay.key === overlayKey ? overlay : null;

  /** A whole package replaces the workspace as one undo step and becomes what Reset and Changes compare against. */
  const replaceAll = useCallback(
    (next: WorkspaceFiles) => draft.replace(next, { asBaseline: true }),
    [draft]
  );

  return {
    scope,
    ready,
    files,
    baseline: draft.baseline,
    dirty: draft.dirty,
    origin: ready ? (opened?.origin ?? null) : null,
    templateIssue: ready ? (opened?.templateIssue ?? null) : null,
    loadIssue: ready ? (opened?.loadIssue ?? null) : null,
    retryLoad: () => setAttempt(value => value + 1),
    draftIssue: draft.issue,
    /** Change the files as one undo step. */
    commit: draft.commit,
    /** The files as they are now, changes not drawn yet included. */
    current: draft.current,
    replaceAll,
    canUndo: draft.canUndo,
    canRedo: draft.canRedo,
    undo: draft.undo,
    redo: draft.redo,
    reset: draft.reset,
    // the check
    status,
    unparsed,
    checking: status.state === 'waiting' || status.state === 'running',
    pausedMessage: pausedUntil !== null ? pausedMessage(pausedUntil) : null,
    checkNow,
    last,
    /** The last answer is about the package on screen. */
    upToDate,
    diagnostics,
    checkIssue,
    facts,
    stale,
    response: good?.response ?? null,
    /** The package on screen passed its last check: it can be saved. */
    savable: upToDate && last !== null && last.valid,
    // saving
    save,
    saving,
    // the highlight
    overlay: shownOverlay?.value ?? null,
    overlayIssue: shownOverlay?.issue ?? null,
    overlayLoading: overlayKey !== null && shownOverlay === null,
  };
}

export type ProblemEditorState = ReturnType<typeof useProblemEditor>;
