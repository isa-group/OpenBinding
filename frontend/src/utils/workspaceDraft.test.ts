import { afterEach, expect, it, vi } from 'vitest';
import { loadDraft, saveDraft } from './workspaceDraft';

afterEach(() => { localStorage.clear(); vi.unstubAllGlobals(); });

it('isolates drafts by user, project, case and revision', async () => {
  vi.stubGlobal('indexedDB', undefined);
  const first = { 'instance.json': '{"version":1}' };
  const second = { 'instance.json': '{"version":2}' };
  await saveDraft(first, 'alice:project-a:case:r1');
  await saveDraft(second, 'alice:project-b:case:r2');
  expect(await loadDraft('alice:project-a:case:r1')).toEqual(first);
  expect(await loadDraft('alice:project-b:case:r2')).toEqual(second);
  expect(await loadDraft('bob:project-a:case:r1')).toBeNull();
});
