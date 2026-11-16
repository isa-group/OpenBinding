import { afterEach, describe, expect, it } from 'vitest';
import {
  clearDraft,
  clearUserDrafts,
  draftScope,
  draftsAvailable,
  loadDraft,
  saveDraft,
} from './drafts';

// The setup file gives every test an empty IndexedDB (fake-indexeddb).

describe('the scope of a draft', () => {
  it('names the person, the editor, the organization, the thing edited and the version it started from', () => {
    expect(
      draftScope({ user: 'user-1', kind: 'problem', org: 'isa', entity: 'checkout', base: '2' })
    ).toBe('user-1:problem:isa:checkout:2');
    expect(
      draftScope({
        user: 'user-1',
        kind: 'composition',
        org: 'isa',
        entity: 'order-desk',
        base: 'new',
      })
    ).toBe('user-1:composition:isa:order-desk:new');
    expect(
      draftScope({ user: undefined, kind: 'problem', org: 'isa', entity: 'new', base: 'none' })
    ).toBe('anonymous:problem:isa:new:none');
  });
});

describe('drafts in the browser', () => {
  it('keeps a draft per scope, reads it back and forgets it', async () => {
    expect(draftsAvailable()).toBe(true);
    await saveDraft('user-1:problem:isa:new:none', { 'instance.json': '{}' });
    await saveDraft('user-1:composition:isa:order-desk:new', {
      'composition.yaml': 'name: order-desk\n',
    });

    expect(await loadDraft('user-1:problem:isa:new:none')).toEqual({ 'instance.json': '{}' });
    expect(await loadDraft('user-1:composition:isa:order-desk:new')).toEqual({
      'composition.yaml': 'name: order-desk\n',
    });
    expect(await loadDraft('user-2:problem:isa:new:none')).toBeNull();

    await saveDraft('user-1:problem:isa:new:none', { 'instance.json': '{"a":1}' });
    expect(await loadDraft('user-1:problem:isa:new:none')).toEqual({ 'instance.json': '{"a":1}' });

    await clearDraft('user-1:problem:isa:new:none');
    expect(await loadDraft('user-1:problem:isa:new:none')).toBeNull();
    expect(await loadDraft('user-1:composition:isa:order-desk:new')).not.toBeNull();
  });

  it('forgets every draft of one person, and only theirs', async () => {
    await saveDraft('user-1:problem:isa:new:none', { 'a.json': '1' });
    await saveDraft('user-1:composition:other:checkout:v3', { 'composition.yaml': '2' });
    await saveDraft('user-10:problem:isa:new:none', { 'b.json': '3' });
    await saveDraft('user-2:problem:isa:new:none', { 'c.json': '4' });
    await saveDraft('anonymous:problem:isa:new:none', { 'd.json': '5' });

    await clearUserDrafts('user-1');

    expect(await loadDraft('user-1:problem:isa:new:none')).toBeNull();
    expect(await loadDraft('user-1:composition:other:checkout:v3')).toBeNull();
    expect(await loadDraft('user-10:problem:isa:new:none')).toEqual({ 'b.json': '3' });
    expect(await loadDraft('user-2:problem:isa:new:none')).toEqual({ 'c.json': '4' });
    expect(await loadDraft('anonymous:problem:isa:new:none')).toEqual({ 'd.json': '5' });
  });

  it('reads nothing that is not a draft', async () => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('openbinding-drafts', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('drafts');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const transaction = request.result.transaction('drafts', 'readwrite');
        transaction
          .objectStore('drafts')
          .put({ 'instance.json': 3 }, 'user-1:problem:isa:new:none');
        transaction.oncomplete = () => {
          request.result.close();
          resolve();
        };
      };
    });

    expect(await loadDraft('user-1:problem:isa:new:none')).toBeNull();
  });

  describe('where this browser has no IndexedDB', () => {
    const indexedDb = globalThis.indexedDB;
    afterEach(() => {
      globalThis.indexedDB = indexedDb;
    });

    it('keeps nothing and says so: saves do nothing and loads give nothing', async () => {
      await saveDraft('user-1:problem:isa:new:none', { 'instance.json': 'kept before' });
      const factory = globalThis.indexedDB;
      // @ts-expect-error -- a browser without IndexedDB
      delete globalThis.indexedDB;

      expect(draftsAvailable()).toBe(false);
      await expect(
        saveDraft('user-1:problem:isa:new:none', { 'instance.json': '{}' })
      ).resolves.toBeUndefined();
      expect(await loadDraft('user-1:problem:isa:new:none')).toBeNull();
      await expect(clearUserDrafts('user-1')).resolves.toBeUndefined();
      await expect(clearDraft('user-1:problem:isa:new:none')).resolves.toBeUndefined();
      expect(localStorage.length).toBe(0);

      globalThis.indexedDB = factory;
      expect(await loadDraft('user-1:problem:isa:new:none')).toEqual({
        'instance.json': 'kept before',
      });
    });
  });
});
