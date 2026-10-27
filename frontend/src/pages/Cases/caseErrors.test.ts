import { describe, expect, it } from 'vitest';
import { HttpError } from '../../api/client';
import { classifyAuthError, createRefusal, deleteRefusal, isMissing, snapshotFailureKind, updateRefusal } from './caseErrors';

const http = (status: number) => new HttpError(status, 'refused');

// [utest->req~frontend-retire-composer-entry-points-repointed~1]
describe('the refusals of the case screens that remain', () => {
  it('words a refused create', () => {
    expect(createRefusal(http(409)).kind).toBe('address');
    expect(createRefusal(http(403)).kind).toBe('forbidden');
    expect(createRefusal(http(404)).kind).toBe('gone');
  });

  it('words a refused update', () => {
    expect(updateRefusal(http(403)).kind).toBe('forbidden');
    expect(updateRefusal(http(404)).kind).toBe('gone');
  });

  it('words a refused delete, a sealed case apart', () => {
    expect(deleteRefusal(http(409)).kind).toBe('sealed');
    expect(deleteRefusal(http(403)).text).toMatch(/ADMIN/);
    expect(deleteRefusal(http(404)).kind).toBe('gone');
  });

  it('tells a missing case and a snapshot that cannot be shown', () => {
    expect(isMissing(null)).toBe(false);
    expect(isMissing(classifyAuthError(http(404)))).toBe(true);
    expect(snapshotFailureKind(classifyAuthError(http(403)))).toBe('key');
    expect(snapshotFailureKind(classifyAuthError(http(404)))).toBe('missing');
  });
});
