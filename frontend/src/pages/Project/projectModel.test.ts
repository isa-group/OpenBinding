import { describe, expect, it } from 'vitest';
import { HttpError } from '../../api/client';
import {
  accessIn, canOpenSection, canRead, canWrite, levelOf, cellBreakdown, countWord, integrityOf, latestRun,
  sealedShare, visibilityEffects,
} from './projectModel';
import { createRefusal, deleteRefusal, updateRefusal } from './projectErrors';
import { org, runOf, studyOf } from '../../features/workspace/testKit';

describe('who can do what in a project', () => {
  it('reads it from the role in the organization', () => {
    expect(accessIn(org('a', { effective_role: 'OWNER' }))).toMatchObject({ canCreate: true, canAdminister: true });
    expect(accessIn(org('a', { effective_role: 'ADMIN' }))).toMatchObject({ canCreate: true, canAdminister: true });
    expect(accessIn(org('a', { effective_role: 'MEMBER' }))).toMatchObject({ canCreate: true, canAdminister: false });
    expect(accessIn(org('a', { effective_role: 'VIEWER' }))).toMatchObject({ canCreate: false, canAdminister: false });
  });

  it('lets a platform administrator without a role act, and nobody else without one', () => {
    expect(accessIn({ effective_role: null })).toMatchObject({ canCreate: false, canAdminister: false });
    expect(accessIn({ effective_role: null }, true)).toMatchObject({ canCreate: true, canAdminister: true });
    expect(accessIn({ effective_role: 'VIEWER' }, true)).toMatchObject({ canCreate: false, canAdminister: false });
  });

  it('keeps the level beside the booleans: the role, ADMIN reach for a platform administrator, nothing for a stranger', () => {
    expect(accessIn(org('a', { effective_role: 'MEMBER' }), false, 'member')).toMatchObject({ level: 'MEMBER', publicRead: false, role: 'MEMBER' });
    expect(accessIn({ effective_role: null }, true)).toMatchObject({ level: 'ADMIN', publicRead: false });
    expect(accessIn({ effective_role: null })).toMatchObject({ level: null, publicRead: false });
  });

  it('never lets public reading write, whoever reads: a role-less visitor, a stray role or a platform administrator', () => {
    for (const platformAdmin of [false, true]) {
      for (const role of [null, 'VIEWER', 'MEMBER', 'ADMIN', 'OWNER'] as const) {
        expect(accessIn({ effective_role: role }, platformAdmin, 'public_read')).toMatchObject({ level: 'public_read', publicRead: true, canCreate: false, canAdminister: false });
      }
    }
  });
});

describe('access levels', () => {
  it('puts public reading below VIEWER and gives it no write', () => {
    expect(canRead('public_read')).toBe(true);
    expect(canRead('public_read', 'VIEWER')).toBe(false);
    expect(canRead('VIEWER', 'VIEWER')).toBe(true);
    expect(canRead('MEMBER', 'ADMIN')).toBe(false);
    expect(canRead(null)).toBe(false);
    expect(canWrite('public_read')).toBe(false);
    expect(canWrite('VIEWER')).toBe(false);
    expect(canWrite('MEMBER')).toBe(true);
    expect(canWrite('MEMBER', 'ADMIN')).toBe(false);
    expect(canWrite('OWNER', 'ADMIN')).toBe(true);
    expect(canWrite(null)).toBe(false);
  });

  it('reads the level from the project’s access and the role', () => {
    expect(levelOf('public_read', 'OWNER')).toBe('public_read');
    expect(levelOf('member', 'VIEWER')).toBe('VIEWER');
    expect(levelOf(undefined, null)).toBeNull();
  });

  it('keeps the settings from a visitor, and everything else open to them', () => {
    for (const section of ['settings']) {
      expect(canOpenSection('public_read', section)).toBe(false);
      expect(canOpenSection('VIEWER', section)).toBe(true);
    }
    for (const section of ['overview', 'cases', 'studies']) expect(canOpenSection('public_read', section)).toBe(true);
    expect(canOpenSection('ADMIN', 'settings')).toBe(true);
  });
});

describe('what is sealed and what is a draft', () => {
  const study = studyOf('engines');

  it('counts study runs as sealed', () => {
    const items = integrityOf({ studies: [{ study, runs: [runOf(study, 1)] }] });

    expect(items.map((item) => [item.id, item.kind, item.count])).toEqual([['runs', 'sealed', 1]]);
    expect(sealedShare(items)).toEqual({ sealed: 1, drafts: 0, sealedPct: 100, draftPct: 0 });
    expect(countWord(items[0])).toBe('study run');
  });

  it('has nothing to share when nothing exists', () => {
    expect(integrityOf({})).toEqual([]);
    expect(sealedShare([])).toEqual({ sealed: 0, drafts: 0, sealedPct: 0, draftPct: 0 });
  });

  it('finds the latest run and how its cells ended', () => {
    expect(latestRun([runOf(study, 1), runOf(study, 3), runOf(study, 2)])?.run_number).toBe(3);
    expect(latestRun([])).toBeUndefined();
    const cells = ['completed', 'completed', 'failed', 'cancelled', 'running'].map((state, index) => ({ id: String(index), state })) as never;
    expect(cellBreakdown(cells)).toEqual([
      { id: 'completed', count: 2, label: 'completed' }, { id: 'failed', count: 1, label: 'failed' },
      { id: 'cancelled', count: 1, label: 'cancelled' }, { id: 'pending', count: 1, label: 'in progress' },
    ]);
  });
});

describe('visibility in words', () => {
  it('words what a visibility change does', () => {
    expect(visibilityEffects('public').changes).toContain('Anybody can read it, without changing anything');
    expect(visibilityEffects('private').changes).toContain('Only its members can read it');
    expect(visibilityEffects('private').stays).toHaveLength(1);
  });
});

describe('the gateway’s refusals in words', () => {
  const refusal = (status: number, code: string, message = 'refused') => Object.assign(new HttpError(status, message), { code });

  it('creating', () => {
    const context = { organization: 'ISA' };
    expect(createRefusal(refusal(409, 'slug_conflict'), context)).toMatchObject({ kind: 'slug', text: 'That address is already used in ISA (409 · slug_conflict).' });
    expect(createRefusal(refusal(403, 'organization_forbidden'), context).kind).toBe('forbidden');
    expect(createRefusal(refusal(404, 'not_found'), context).kind).toBe('gone');
    expect(createRefusal(refusal(422, 'invalid'), context).kind).toBe('invalid');
    expect(createRefusal(new TypeError('Failed to fetch'), context)).toMatchObject({ kind: 'other', text: expect.stringContaining('couldn’t be reached') });
  });

  it('updating', () => {
    expect(updateRefusal(refusal(403, 'forbidden'), 'details').kind).toBe('forbidden');
    expect(updateRefusal(refusal(422, 'invalid'), 'visibility').text).toContain('visibility');
  });

  it('deleting', () => {
    expect(deleteRefusal(refusal(409, 'historical_references')).text).toContain('sealed history');
    expect(deleteRefusal(refusal(403, 'forbidden')).kind).toBe('forbidden');
    expect(deleteRefusal(refusal(503, 'unavailable')).text).toContain('nothing was deleted');
  });
});
