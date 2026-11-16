import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import examples from '../../content/composition2yaml-examples.json';
import { compositionsApi, languageApi } from '../../entities/composition/api';
import { COMPOSITION_FILE } from '../../entities/composition/viewModel';
import { problemFactsApi } from '../../entities/problem/facts';
import { readApiError } from '../../modules/core/api/errors';
import type {
  CheckResult,
  CompositionDiagnosticView,
  CompositionVersionView,
  CompositionView,
  ProblemFacts,
  SealResult,
  ValidateResult,
} from '../../modules/core/api/types';
import { draftScope, type DraftFiles } from '../../shared/editor/drafts';
import {
  createScheduler,
  pausedMessage,
  type Scheduler,
  type SchedulerStatus,
} from '../../shared/editor/lintScheduler';
import { useDraftStore } from '../../shared/editor/useDraftStore';
import { fromC2y, type Located } from '../../shared/diagnostics/located';
import {
  compositionFragment,
  takeCompositionFragment,
  type CompositionFragment,
} from '../../shared/sphere/composition-fragment';
import { compositionCompletions, compositionSchema, type JsonSchema } from './completion';
import type { DocumentModel } from './mutations';
import { scalarAt, withTopLevelScalar } from './yamlText';

/** Milliseconds of stillness before the text is linted (`POST /v1/compositions/validate`, A-7). */
export const VALIDATE_DELAY_MS = 600;
/** Milliseconds of stillness before a linked text is assessed as a seal would (`POST …/versions/check`, A-7). */
export const CHECK_DELAY_MS = 1500;
/** The largest file the editor reads; the gateway refuses a larger body with 413 anyway. */
export const UPLOAD_LIMIT_BYTES = 256 * 1024;

/** The starting document of a composition with no version: the starter, with this composition's slug and kind. */
export function starterFor(composition: Pick<CompositionView, 'slug' | 'kind'>): string {
  return withTopLevelScalar(
    withTopLevelScalar(examples.starter, 'composition', composition.slug),
    'kind',
    composition.kind
  );
}

/** Does the text link a problem? Only then is a check worth its budget. */
export const linksProblem = (text: string) => /^problem\s*:/m.test(text);

/** The problem a text links, when it is one of this organization's: what the editor reads the facts of, for completion. */
export function linkedProblemOf(
  text: string,
  org: string
): { problem: string; revision: string; compilation: string } | null {
  const ref = scalarAt(text, ['problem', 'ref'])?.value;
  const compilation = scalarAt(text, ['problem', 'compilation'])?.value;
  const match = ref ? /^([^/]+)\/problems\/([^@]+)@(.+)$/.exec(ref) : null;
  if (!match || !compilation || match[1] !== org) return null;
  return { problem: match[2], revision: match[3], compilation };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const textOf = (value: unknown) => (typeof value === 'string' ? value : '');
const SEVERITIES = ['error', 'warning', 'info'] as const;

/** The Composition2Yaml findings a refusal carries (a 422 `composition_invalid`), as the gateway located them. */
export function refusalFindings(error: unknown): CompositionDiagnosticView[] {
  const record = isRecord(error) ? error : {};
  const problem = isRecord(record.problem) ? record.problem : {};
  const rows =
    Array.isArray(record.diagnostics) && record.diagnostics.length
      ? record.diagnostics
      : Array.isArray(problem.diagnostics)
        ? problem.diagnostics
        : [];
  return rows.filter(isRecord).map(row => {
    const span =
      isRecord(row.span) &&
      ['line', 'column', 'end_line', 'end_column'].every(
        key => typeof (row.span as Record<string, unknown>)[key] === 'number'
      )
        ? (row.span as unknown as CompositionDiagnosticView['span'])
        : null;
    const severity = SEVERITIES.find(item => item === row.severity) ?? 'error';
    return {
      code: textOf(row.code) || 'composition_invalid',
      message: textOf(row.message) || textOf(row.code),
      severity,
      path: textOf(row.path),
      pointer: textOf(row.pointer),
      span,
    };
  });
}

/** One finding per code and pointer: the lint and the check report some findings alike. */
function merged(lists: readonly Located[][]): Located[] {
  const seen = new Set<string>();
  const out: Located[] = [];
  for (const diagnostic of lists.flat()) {
    const key = `${diagnostic.code}|${diagnostic.pointer ?? diagnostic.path ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(diagnostic);
  }
  return out;
}

const located = (diagnostics: readonly CompositionDiagnosticView[], text: string) =>
  diagnostics.map(item => fromC2y(item, text, COMPOSITION_FILE));

/** What a seal came to. */
export type SealOutcome =
  | { kind: 'created'; result: SealResult }
  | { kind: 'exists'; result: SealResult }
  | { kind: 'labelTaken'; message: string }
  | { kind: 'invalid'; message: string }
  | { kind: 'refused'; status: number; message: string };

/** Text brought in from elsewhere (an uploaded file, a share link), waiting for a decision over unsaved changes. */
export interface Incoming {
  text: string;
  source: 'upload' | 'link';
}

export interface CompositionEditorOptions {
  org: string;
  composition: Pick<CompositionView, 'slug' | 'kind'>;
  /** The version the editor starts from (its text); null for a composition with no version (the starter). */
  version: Pick<CompositionVersionView, 'id' | 'label'> | null;
  /** Whose drafts these are. */
  userId: string | null | undefined;
  /** Delays of the live checks, in milliseconds (tests shorten them). */
  delays?: { validate?: number; check?: number };
  /** The visual editor is on screen: the document is parsed as the text changes. */
  visual?: boolean;
}

interface Answer<T> {
  text: string;
  result: T;
}

/**
 * The Composition2Yaml editor of a composition, without its screens: the text and its 40-step history in the draft store
 * (`kind: composition`, per version it started from), the gateway's lint (validate, 600 ms) merged with the seal's assessment
 * (check, 1500 ms, only for a valid text that links a problem), completion from the schema and the linked problem's facts, the
 * visual editor's round trip through parse and serialise, share links, uploads and the seal.
 */
export function useCompositionEditor({
  org,
  composition,
  version,
  userId,
  delays,
  visual = false,
}: CompositionEditorOptions) {
  const slug = composition.slug;
  const validateDelay = delays?.validate ?? VALIDATE_DELAY_MS;
  const checkDelay = delays?.check ?? CHECK_DELAY_MS;
  const scope = draftScope({
    user: userId,
    kind: 'composition',
    org,
    entity: slug,
    base: version?.id ?? 'new',
  });
  const draft = useDraftStore<DraftFiles>({ scope, initial: { [COMPOSITION_FILE]: '' } });
  const text = draft.files[COMPOSITION_FILE] ?? '';

  const [load, setLoad] = useState<{
    scope: string;
    status: 'loading' | 'ready' | 'error';
    message?: string;
  }>({ scope, status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [incoming, setIncoming] = useState<Incoming | null>(null);
  const [linkIssue, setLinkIssue] = useState<string | null>(null);
  const fragment = useRef<CompositionFragment | null>(null);

  // -- Starting: the kept draft over the version's text (or the starter), then a share link the address carried

  const bringIn = useCallback(
    (next: string, source: Incoming['source']) => {
      if (draft.dirty) setIncoming({ text: next, source });
      else draft.commit({ [COMPOSITION_FILE]: next });
    },
    [draft]
  );

  const hydrate = useEffectEvent((origin: string, kept: DraftFiles | null) => {
    draft.start({ [COMPOSITION_FILE]: origin });
    const restored = kept?.[COMPOSITION_FILE];
    if (restored !== undefined && restored !== origin)
      draft.commit({ [COMPOSITION_FILE]: restored });
    setLoad({ scope, status: 'ready' });
    const link = fragment.current;
    fragment.current = null;
    if (link?.status === 'invalid') setLinkIssue(link.error);
    if (link?.status === 'ok') {
      if (restored !== undefined && restored !== origin)
        setIncoming({ text: link.yaml, source: 'link' });
      else draft.commit({ [COMPOSITION_FILE]: link.yaml });
    }
  });

  const fail = useEffectEvent((reason: unknown) => {
    setLoad({ scope, status: 'error', message: readApiError(reason).message });
  });

  const taken = useRef(false);
  useEffect(() => {
    if (!taken.current) {
      taken.current = true;
      fragment.current = takeCompositionFragment(window.location, window.history);
    }
    let active = true;
    void (async () => {
      const kept = await draft.restore();
      const origin = version
        ? await compositionsApi.content(org, slug, version.id)
        : starterFor(composition);
      if (active) hydrate(origin, kept);
    })().catch((reason: unknown) => {
      if (active) fail(reason);
    });
    return () => {
      active = false;
    };
    // The scope names the organization, the composition and the version; `attempt` reads them again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, attempt]);

  const ready = load.scope === scope && load.status === 'ready' && draft.hydrated;

  // -- The live checks

  const [validated, setValidated] = useState<Answer<ValidateResult> | null>(null);
  const [checked, setChecked] = useState<Answer<CheckResult> | null>(null);
  const [sealFindings, setSealFindings] = useState<{ text: string; findings: Located[] } | null>(
    null
  );
  const [lintIssue, setLintIssue] = useState<string | null>(null);
  const [statuses, setStatuses] = useState<{ validate: SchedulerStatus; check: SchedulerStatus }>({
    validate: { state: 'idle' },
    check: { state: 'idle' },
  });
  const validator = useRef<Scheduler<string> | null>(null);
  const checker = useRef<Scheduler<string> | null>(null);
  const lastValidation = useRef<{ text: string; valid: boolean } | null>(null);
  const waitingCheck = useRef<string | null>(null);

  useEffect(() => {
    const checks = createScheduler<string, CheckResult | null>({
      delay: checkDelay,
      run: async (input, signal) => {
        const lint = lastValidation.current;
        if (!lint || lint.text !== input) {
          // The lint of this text has not answered yet: the check waits for it.
          waitingCheck.current = input;
          return null;
        }
        return lint.valid ? compositionsApi.check(org, slug, input, signal) : null;
      },
      onResult: (result, input) => {
        if (result) setChecked({ text: input, result });
      },
      onError: reason => setLintIssue(readApiError(reason).message || 'The check couldn’t be run.'),
      onStatus: status => setStatuses(now => ({ ...now, check: status })),
    });
    const lints = createScheduler<string, ValidateResult>({
      delay: validateDelay,
      run: (input, signal) => languageApi.validate(input, signal),
      onResult: (result, input) => {
        lastValidation.current = { text: input, valid: result.valid };
        setValidated({ text: input, result });
        setLintIssue(null);
        if (waitingCheck.current === input) {
          waitingCheck.current = null;
          if (result.valid) checks.schedule(input);
        }
      },
      onError: reason =>
        setLintIssue(readApiError(reason).message || 'The text couldn’t be checked.'),
      onStatus: status => setStatuses(now => ({ ...now, validate: status })),
    });
    validator.current = lints;
    checker.current = checks;
    return () => {
      lints.dispose();
      checks.dispose();
    };
  }, [org, slug, validateDelay, checkDelay]);

  useEffect(() => {
    if (!ready) return;
    validator.current?.schedule(text);
    if (linksProblem(text)) {
      checker.current?.schedule(text);
    } else {
      checker.current?.cancel();
      waitingCheck.current = null;
    }
  }, [text, ready]);

  // While a check is paused the notice counts down.
  const paused = [statuses.validate, statuses.check].flatMap(status =>
    status.state === 'paused' ? [status.until] : []
  );
  const pausedUntil = paused.length ? Math.max(...paused) : null;
  const [, tick] = useState(0);
  useEffect(() => {
    if (pausedUntil === null) return undefined;
    const timer = window.setInterval(() => tick(value => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [pausedUntil]);

  const checkCurrent =
    checked && validated && checked.text === validated.text && linksProblem(checked.text)
      ? checked
      : null;
  const diagnostics = useMemo(
    () =>
      merged([
        validated ? located(validated.result.diagnostics, validated.text) : [],
        checkCurrent ? located(checkCurrent.result.diagnostics, checkCurrent.text) : [],
        sealFindings && sealFindings.text === text ? sealFindings.findings : [],
      ]),
    [validated, checkCurrent, sealFindings, text]
  );

  // -- Completion: the schema, and the facts of the problem the last linted text links

  const [schema, setSchema] = useState<JsonSchema | null>(null);
  useEffect(() => {
    let active = true;
    compositionSchema().then(
      value => {
        if (active) setSchema(value);
      },
      () => undefined
    );
    return () => {
      active = false;
    };
  }, []);

  const link = validated ? linkedProblemOf(validated.text, org) : null;
  const factsKey = link ? `${link.problem}@${link.revision}/${link.compilation}` : null;
  const [facts, setFacts] = useState<{ key: string; facts: ProblemFacts } | null>(null);
  useEffect(() => {
    if (!link || !factsKey) return undefined;
    let active = true;
    problemFactsApi.get(org, link.problem, link.revision, link.compilation).then(
      value => {
        if (active) setFacts({ key: factsKey, facts: value });
      },
      () => undefined
    );
    return () => {
      active = false;
    };
    // The key names the link.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [org, factsKey]);
  const linkedFacts = facts && facts.key === factsKey ? facts.facts : null;
  const completions = useMemo(
    () => compositionCompletions({ schema, facts: linkedFacts }),
    [schema, linkedFacts]
  );

  // -- The visual editor: the document as the gateway parses it, and changes written back as canonical text

  const [parsed, setParsed] = useState<{
    text: string;
    document: DocumentModel | null;
    message: string | null;
  } | null>(null);
  const parser = useRef<Scheduler<string> | null>(null);
  useEffect(() => {
    const parses = createScheduler<string, DocumentModel>({
      delay: validateDelay,
      run: async (input, signal) => (await languageApi.parse(input, signal)).document,
      onResult: (document, input) => setParsed({ text: input, document, message: null }),
      onError: (reason, input) => {
        const refusal = readApiError(reason);
        setParsed({
          text: input,
          document: null,
          message:
            refusal.status === 422 ? null : refusal.message || 'The document couldn’t be read.',
        });
      },
    });
    parser.current = parses;
    return () => parses.dispose();
  }, [validateDelay]);

  useEffect(() => {
    if (ready && visual) parser.current?.schedule(text);
  }, [text, ready, visual]);

  const [mutating, setMutating] = useState(false);
  /** Apply a change to the document: parse, change, serialise; the canonical text replaces the draft as one undo step. */
  const mutate = useCallback(
    async (
      change: (document: DocumentModel) => DocumentModel
    ): Promise<{ ok: true } | { ok: false; message: string }> => {
      setMutating(true);
      try {
        const before = draft.current()[COMPOSITION_FILE] ?? '';
        const document = (await languageApi.parse(before)).document;
        const next = change(document);
        const written = await languageApi.serialise(next);
        draft.commit({ [COMPOSITION_FILE]: written });
        setParsed({ text: written, document: next, message: null });
        return { ok: true };
      } catch (reason: unknown) {
        const refusal = readApiError(reason);
        return {
          ok: false,
          message:
            refusal.status === 422
              ? 'The visual editor changes a valid document: fix the problems in the code first.'
              : refusal.message || 'The change couldn’t be made.',
        };
      } finally {
        setMutating(false);
      }
    },
    [draft]
  );

  // -- The label, the share link and the seal

  const label = useMemo(() => scalarAt(text, ['version'])?.value ?? '', [text]);
  const setLabel = useCallback(
    (next: string) => {
      const now = draft.current()[COMPOSITION_FILE] ?? '';
      if ((scalarAt(now, ['version'])?.value ?? '') !== next)
        draft.commit({ [COMPOSITION_FILE]: withTopLevelScalar(now, 'version', next) });
    },
    [draft]
  );

  /** The address of this editor with the text in its fragment. */
  const shareLink = useCallback(() => {
    const { origin, pathname, search } = window.location;
    return `${origin}${pathname}${search}${compositionFragment(draft.current()[COMPOSITION_FILE] ?? '')}`;
  }, [draft]);

  const [sealing, setSealing] = useState(false);
  const seal = useCallback(async (): Promise<SealOutcome> => {
    const sent = draft.current()[COMPOSITION_FILE] ?? '';
    setSealing(true);
    try {
      const sealed = await compositionsApi.seal(org, slug, sent);
      if (!sealed.created) return { kind: 'exists', result: sealed.result };
      await draft.forget();
      return { kind: 'created', result: sealed.result };
    } catch (reason: unknown) {
      const refusal = readApiError(reason);
      if (refusal.status === 409 && refusal.code === 'version_label_taken') {
        const place = scalarAt(sent, ['version']);
        const where: Located['where'] = place
          ? {
              kind: 'text',
              file: COMPOSITION_FILE,
              from: place.from,
              to: place.to,
              line: sent.slice(0, place.from).split('\n').length,
              column: place.from - (sent.lastIndexOf('\n', place.from - 1) + 1) + 1,
            }
          : { kind: 'file', file: COMPOSITION_FILE };
        setSealFindings({
          text: sent,
          findings: [
            {
              code: refusal.code,
              message: refusal.message,
              severity: 'error',
              where,
              path: 'version',
              pointer: '/version',
            },
          ],
        });
        return { kind: 'labelTaken', message: refusal.message };
      }
      if (refusal.status === 422) {
        setSealFindings({ text: sent, findings: located(refusalFindings(reason), sent) });
        return { kind: 'invalid', message: refusal.message };
      }
      return { kind: 'refused', status: refusal.status, message: refusal.message };
    } finally {
      setSealing(false);
    }
  }, [draft, org, slug]);

  const checkStatus = checkCurrent && checkCurrent.text === text ? checkCurrent.result : null;
  const busy = [statuses.validate, statuses.check].some(
    status => status.state === 'waiting' || status.state === 'running'
  );

  return {
    scope,
    text,
    ready,
    loading: load.scope !== scope || load.status === 'loading',
    loadError: load.scope === scope && load.status === 'error' ? (load.message ?? '') : null,
    retry: () => {
      setLoad({ scope, status: 'loading' });
      setAttempt(value => value + 1);
    },
    /** Replace the text as one undo step (what the code editor types). */
    setText: (next: string) => {
      if (next !== text) draft.commit({ [COMPOSITION_FILE]: next });
    },
    dirty: draft.dirty,
    canUndo: draft.canUndo,
    canRedo: draft.canRedo,
    undo: draft.undo,
    redo: draft.redo,
    /** Back to the text the editor started from, as one undo step. */
    discard: draft.reset,
    /** Why the draft is not being kept in this browser, if it is not. */
    draftIssue: draft.issue,
    diagnostics,
    /** The last lint or check could not be made (not a finding about the text). */
    lintIssue,
    checking: busy,
    pausedMessage: pausedUntil !== null ? pausedMessage(pausedUntil) : null,
    /** The seal's assessment of the text on screen: its values and status, and its canonical form. */
    check: checkStatus,
    errors: diagnostics.filter(item => item.severity === 'error').length,
    completions,
    facts: linkedFacts,
    document: parsed && parsed.text === text ? parsed.document : null,
    documentIssue: parsed && parsed.text === text ? parsed.message : null,
    mutate,
    mutating,
    label,
    setLabel,
    shareLink,
    bringIn,
    incoming,
    acceptIncoming: () => {
      if (incoming) draft.commit({ [COMPOSITION_FILE]: incoming.text });
      setIncoming(null);
    },
    declineIncoming: () => setIncoming(null),
    linkIssue,
    dismissLinkIssue: () => setLinkIssue(null),
    seal,
    sealing,
  };
}

export type CompositionEditorState = ReturnType<typeof useCompositionEditor>;
