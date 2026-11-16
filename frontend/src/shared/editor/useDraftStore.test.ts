import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadDraft, saveDraft, type DraftFiles } from './drafts';
import { DRAFTS_UNAVAILABLE, HISTORY_LIMIT, SAVE_DELAY_MS, useDraftStore } from './useDraftStore';

const SCOPE = 'user-1:composition:isa:order-desk:new';
const OTHER = 'user-1:composition:isa:order-desk:v2';
const START: DraftFiles = { 'composition.yaml': 'start' };
const text = (value: string): DraftFiles => ({ 'composition.yaml': value });

function store(scope = SCOPE, initial: DraftFiles = START) {
  return renderHook(({ scope: current }) => useDraftStore({ scope: current, initial }), {
    initialProps: { scope },
  });
}

describe('the history of a draft', () => {
  it('commits, undoes, redoes and resets to the baseline as undo steps', () => {
    const { result } = store();
    act(() => result.current.start(text('base')));
    expect(result.current).toMatchObject({
      files: text('base'),
      baseline: text('base'),
      dirty: false,
      canUndo: false,
      canRedo: false,
    });

    act(() => {
      result.current.commit(text('one'));
    });
    act(() => {
      result.current.commit(now => ({
        ...now,
        'composition.yaml': `${now['composition.yaml']}+two`,
      }));
    });
    expect(result.current.files).toEqual(text('one+two'));
    expect(result.current.dirty).toBe(true);

    act(() => {
      expect(result.current.undo()).toEqual(text('one'));
    });
    expect(result.current).toMatchObject({ files: text('one'), canUndo: true, canRedo: true });
    act(() => {
      expect(result.current.redo()).toEqual(text('one+two'));
    });
    expect(result.current.canRedo).toBe(false);

    act(() => {
      result.current.undo();
    });
    act(() => {
      result.current.commit(text('three'));
    });
    expect(result.current.canRedo).toBe(false);
    act(() => {
      expect(result.current.redo()).toBeNull();
    });

    act(() => {
      expect(result.current.reset()).toEqual(text('base'));
    });
    expect(result.current).toMatchObject({ files: text('base'), dirty: false });
    act(() => {
      result.current.undo();
    });
    expect(result.current.files).toEqual(text('three'));
  });

  it('keeps at most 40 earlier states', () => {
    const { result } = store();
    act(() => result.current.start(text('0')));
    for (let step = 1; step <= HISTORY_LIMIT + 5; step += 1)
      act(() => {
        result.current.commit(text(String(step)));
      });

    let undone = 0;
    act(() => {
      while (result.current.undo()) undone += 1;
    });
    expect(HISTORY_LIMIT).toBe(40);
    expect(undone).toBe(40);
    expect(result.current.files).toEqual(text('5'));
    expect(result.current.canUndo).toBe(false);
  });

  it('reads the files of the last call before the screen draws them', () => {
    const { result } = store();
    act(() => result.current.start(text('base')));
    act(() => {
      const editor = result.current;
      editor.commit(text('first'));
      expect(editor.current()).toEqual(text('first'));
      editor.commit(now => ({ ...now, 'extra.yaml': 'second' }));
      expect(editor.current()).toEqual({ 'composition.yaml': 'first', 'extra.yaml': 'second' });
      // The screen still shows what it drew before this act.
      expect(editor.files).toEqual(text('base'));
    });
    expect(result.current.files).toEqual({ 'composition.yaml': 'first', 'extra.yaml': 'second' });
  });

  it('replaces the files as one step, and as the new baseline when asked', () => {
    const { result } = store();
    act(() => result.current.start(text('base')));
    act(() => {
      result.current.replace(text('uploaded'));
    });
    expect(result.current).toMatchObject({
      files: text('uploaded'),
      baseline: text('base'),
      dirty: true,
    });
    act(() => {
      result.current.replace(text('template'), { asBaseline: true });
    });
    expect(result.current).toMatchObject({
      files: text('template'),
      baseline: text('template'),
      dirty: false,
      canUndo: true,
    });
    act(() => {
      result.current.undo();
    });
    expect(result.current.files).toEqual(text('uploaded'));
  });

  it('forgets the history when a scope is hydrated', () => {
    const { result } = store();
    act(() => result.current.start(text('base')));
    act(() => {
      result.current.commit(text('edit'));
    });
    act(() => result.current.start(text('again')));
    expect(result.current).toMatchObject({
      files: text('again'),
      baseline: text('again'),
      canUndo: false,
      canRedo: false,
    });
    act(() => result.current.start());
    expect(result.current.files).toEqual(text('again'));
  });
});

describe('the copy of a draft in the browser', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps nothing before the scope is hydrated, then keeps the files 500 ms after the last change', async () => {
    // IndexedDB answers on setImmediate, which stays real.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { result } = store();
    act(() => {
      result.current.commit(text('before hydration'));
    });
    await act(async () => {
      vi.advanceTimersByTime(SAVE_DELAY_MS * 2);
    });
    expect(result.current.hydrated).toBe(false);
    expect(await loadDraft(SCOPE)).toBeNull();

    act(() => result.current.start(text('base')));
    expect(result.current.hydrated).toBe(true);
    act(() => {
      result.current.commit(text('one'));
    });
    await act(async () => {
      vi.advanceTimersByTime(SAVE_DELAY_MS - 100);
    });
    act(() => {
      result.current.commit(text('two'));
    });
    await act(async () => {
      vi.advanceTimersByTime(SAVE_DELAY_MS - 100);
    });
    expect(await loadDraft(SCOPE)).toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(100);
    });
    await vi.waitFor(async () => expect(await loadDraft(SCOPE)).toEqual(text('two')));
    expect(result.current.issue).toBeNull();
  });

  it('restores by scope, and keeps a change still waiting for its delay when the scope changes or the editor goes away', async () => {
    await saveDraft(SCOPE, text('kept earlier'));
    const { result, rerender, unmount } = store();
    const restored = await act(() => result.current.restore());
    expect(restored).toEqual(text('kept earlier'));
    act(() => result.current.start(restored ?? undefined));

    act(() => {
      result.current.commit(text('edited just now'));
    });
    rerender({ scope: OTHER });
    expect(result.current.hydrated).toBe(false);
    await act(async () => {
      expect(await result.current.restore()).toBeNull();
    });
    await vi.waitFor(async () => expect(await loadDraft(SCOPE)).toEqual(text('edited just now')));

    act(() => result.current.start(text('other start')));
    act(() => {
      result.current.commit(text('other edit'));
    });
    unmount();
    await vi.waitFor(async () => expect(await loadDraft(OTHER)).toEqual(text('other edit')));

    const again = store(SCOPE);
    await act(async () => {
      expect(await again.result.current.restore()).toEqual(text('edited just now'));
    });
  });

  it('forgets the kept draft, and drops a change still waiting so it is not written back', async () => {
    await saveDraft(SCOPE, text('kept earlier'));
    const { result, unmount } = store();
    act(() => result.current.start(text('base')));
    act(() => {
      result.current.commit(text('sealed just now'));
    });
    await act(() => result.current.forget());
    unmount();
    await new Promise(resolve => setTimeout(resolve, SAVE_DELAY_MS + 50));
    expect(await loadDraft(SCOPE)).toBeNull();
  });

  describe('where this browser has no IndexedDB', () => {
    const indexedDb = globalThis.indexedDB;
    afterEach(() => {
      globalThis.indexedDB = indexedDb;
    });

    it('says the draft is not kept', () => {
      // @ts-expect-error -- a browser without IndexedDB
      delete globalThis.indexedDB;
      const { result } = store();
      act(() => result.current.start(text('base')));
      expect(result.current.issue).toBe(DRAFTS_UNAVAILABLE);
    });
  });
});
