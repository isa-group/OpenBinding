import { useCallback, useEffect, useRef, useState } from 'react';
import { clearDraft, draftsAvailable, loadDraft, saveDraft, type DraftFiles } from './drafts';

/** How many earlier states undo can go back to. */
export const HISTORY_LIMIT = 40;
/** How long the files must stay unchanged before they are kept in the browser. */
export const SAVE_DELAY_MS = 500;

/** What the editors say where this browser cannot keep drafts. */
export const DRAFTS_UNAVAILABLE = 'This browser does not keep drafts, so unsaved changes are lost when you leave. Export or save them to keep them.';

export interface DraftStoreOptions<F extends DraftFiles> {
  /** Where the draft is kept (`draftScope`). A new scope starts unhydrated: nothing is kept until `start` gives it its files. */
  scope: string;
  /** The files before the scope is hydrated. */
  initial: F;
  /** The debounce of the browser copy, in milliseconds. */
  delay?: number;
}

const sameFiles = (left: DraftFiles, right: DraftFiles) => {
  if (left === right) return true;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => right[key] === left[key]);
};

/**
 * The files an editor edits, with their history and their copy in the browser. It is generic over the files and knows no entity:
 * the composition editor keeps one `composition.yaml`, the problem editor a package.
 *
 * - `commit` changes the files as one undo step. The files are held in a ref as well, so a call made right after reads the files
 *   the screen has not drawn yet (`current()`).
 * - `undo`, `redo` and `reset` (back to the baseline) move through at most `HISTORY_LIMIT` earlier states.
 * - `start` hydrates the scope: its files become the files and the baseline, and the history is forgotten. Only then is the draft
 *   kept, `delay` ms after the last change, and once more right away when the scope changes or the editor goes away.
 */
export function useDraftStore<F extends DraftFiles>({ scope, initial, delay = SAVE_DELAY_MS }: DraftStoreOptions<F>) {
  const [files, setFiles] = useState<F>(initial);
  const [baseline, setBaseline] = useState<F>(initial);
  const [hydratedScope, setHydratedScope] = useState<string | null>(null);
  const [depth, setDepth] = useState({ past: 0, future: 0 });
  const [saveIssue, setSaveIssue] = useState<string | null>(null);
  const filesRef = useRef<F>(initial);
  const baselineRef = useRef<F>(initial);
  const pastRef = useRef<F[]>([]);
  const futureRef = useRef<F[]>([]);
  const scopeRef = useRef(scope);
  const pendingRef = useRef<{ scope: string; files: F } | null>(null);

  useEffect(() => { scopeRef.current = scope; }, [scope]);

  const hydrated = hydratedScope === scope;

  const show = useCallback((next: F) => {
    filesRef.current = next;
    setFiles(next);
  }, []);

  const countHistory = useCallback(() => setDepth({ past: pastRef.current.length, future: futureRef.current.length }), []);

  /** The files as they are now, including changes the screen has not drawn yet. */
  const current = useCallback(() => filesRef.current, []);

  /** Change the files as one undo step. */
  const commit = useCallback((next: F | ((now: F) => F)) => {
    const now = filesRef.current;
    const value = typeof next === 'function' ? (next as (now: F) => F)(now) : next as F;
    pastRef.current = [...pastRef.current.slice(-(HISTORY_LIMIT - 1)), now];
    futureRef.current = [];
    show(value);
    countHistory();
    return value;
  }, [show, countHistory]);

  /** Go back one step; answers the files now shown, or `null` when there is nothing to undo. */
  const undo = useCallback((): F | null => {
    const previous = pastRef.current.at(-1);
    if (!previous) return null;
    pastRef.current = pastRef.current.slice(0, -1);
    futureRef.current = [...futureRef.current, filesRef.current];
    show(previous);
    countHistory();
    return previous;
  }, [show, countHistory]);

  /** Go forward one undone step; answers the files now shown, or `null` when there is nothing to redo. */
  const redo = useCallback((): F | null => {
    const next = futureRef.current.at(-1);
    if (!next) return null;
    futureRef.current = futureRef.current.slice(0, -1);
    pastRef.current = [...pastRef.current.slice(-(HISTORY_LIMIT - 1)), filesRef.current];
    show(next);
    countHistory();
    return next;
  }, [show, countHistory]);

  /** Back to the baseline, as one undo step. */
  const reset = useCallback(() => commit(baselineRef.current), [commit]);

  /** Whole files replace the edit as one undo step; with `asBaseline` they are also what `reset` and `dirty` compare against. */
  const replace = useCallback((next: F, { asBaseline = false }: { asBaseline?: boolean } = {}) => {
    if (asBaseline) {
      baselineRef.current = next;
      setBaseline(next);
    }
    return commit(next);
  }, [commit]);

  /** Hydrate the scope: these files (or the files on screen) start it, as files and baseline, with no history. */
  const start = useCallback((next?: F) => {
    const value = next ?? filesRef.current;
    pastRef.current = [];
    futureRef.current = [];
    baselineRef.current = value;
    setBaseline(value);
    show(value);
    countHistory();
    setHydratedScope(scopeRef.current);
  }, [show, countHistory]);

  /** The draft kept for this scope, if any. */
  const restore = useCallback(() => loadDraft(scopeRef.current) as Promise<F | null>, []);

  const flush = useCallback(() => {
    const pending = pendingRef.current;
    pendingRef.current = null;
    if (!pending) return Promise.resolve();
    return saveDraft(pending.scope, pending.files)
      .then(() => setSaveIssue(null))
      .catch((reason: unknown) => setSaveIssue(reason instanceof Error ? reason.message : 'This draft could not be kept in the browser.'));
  }, []);

  /**
   * Forget the draft kept for this scope (after a seal, say): a change still waiting for its delay is dropped first, so it is not
   * written back. The files on screen stay; only a later change is kept again.
   */
  const forget = useCallback(() => {
    pendingRef.current = null;
    return clearDraft(scopeRef.current);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    pendingRef.current = { scope, files };
    const timer = setTimeout(() => void flush(), delay);
    return () => clearTimeout(timer);
  }, [files, hydrated, scope, delay, flush]);

  // A change still waiting for its delay is kept when the scope changes or the editor goes away.
  useEffect(() => () => void flush(), [scope, flush]);

  return {
    files,
    baseline,
    dirty: !sameFiles(files, baseline),
    hydrated,
    canUndo: depth.past > 0,
    canRedo: depth.future > 0,
    /** Why the draft is not being kept, if it is not. */
    issue: draftsAvailable() ? saveIssue : DRAFTS_UNAVAILABLE,
    current, commit, undo, redo, reset, replace, start, restore, forget,
  };
}

export type DraftStore<F extends DraftFiles> = ReturnType<typeof useDraftStore<F>>;
