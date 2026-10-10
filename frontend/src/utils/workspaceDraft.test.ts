import { beforeEach, describe, expect, it } from 'vitest';
import { clearUserDrafts, loadDraft, saveDraft } from './workspaceDraft';

// jsdom has no IndexedDB, so these drafts live in the localStorage copy the module keeps for that case.

describe('workbench drafts', () => {
  beforeEach(() => localStorage.clear());

  it('keeps a draft per scope and reads it back', async () => {
    await saveDraft({ 'instance.json': '{}' }, 'user-1:/app/isa/qos/workbench::');
    expect(await loadDraft('user-1:/app/isa/qos/workbench::')).toEqual({ 'instance.json': '{}' });
    expect(await loadDraft('user-2:/app/isa/qos/workbench::')).toBeNull();
  });

  it('forgets the drafts of signed-in people when the session is closed, and leaves the anonymous one alone', async () => {
    await saveDraft({ 'a.json': '1' }, 'user-1:/app/isa/qos/workbench::');
    await saveDraft({ 'b.json': '2' }, 'user-2:/app/isa/other/workbench:checkout:3');
    await saveDraft({ 'c.json': '3' }, 'anonymous:/workbench::');
    localStorage.setItem('unrelated', 'kept');

    await clearUserDrafts();

    expect(await loadDraft('user-1:/app/isa/qos/workbench::')).toBeNull();
    expect(await loadDraft('user-2:/app/isa/other/workbench:checkout:3')).toBeNull();
    expect(await loadDraft('anonymous:/workbench::')).toEqual({ 'c.json': '3' });
    expect(localStorage.getItem('unrelated')).toBe('kept');
  });
});
