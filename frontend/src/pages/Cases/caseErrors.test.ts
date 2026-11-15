import { describe, expect, it } from 'vitest';
import { HttpError } from '../../api/client';
import { deleteRefusal, isMissing, sourceFailureKind, updateRefusal, uploadRefusal } from './caseErrors';
import { classifyAuthError } from '../../shared/api/errors';

const http = (status: number, code?: string) => Object.assign(new HttpError(status, 'refused'), code ? { code } : {});

describe('the refusals of the problem screens', () => {
  it('words a refused upload', () => {
    expect(uploadRefusal(http(409, 'slug_conflict')).kind).toBe('address');
    expect(uploadRefusal(http(413)).kind).toBe('size');
    expect(uploadRefusal(http(415)).kind).toBe('invalid');
    expect(uploadRefusal(http(403)).kind).toBe('forbidden');
    expect(uploadRefusal(http(404)).kind).toBe('gone');
    const refused = Object.assign(http(422, 'invalid_instance'), { diagnostics: [{ code: 'missing_role', message: 'No application', resource: 'instance.json' }] });
    expect(uploadRefusal(refused, 'version')).toMatchObject({ kind: 'invalid', diagnostics: [expect.objectContaining({ code: 'missing_role' })] });
    expect(uploadRefusal(refused, 'version').text).toContain('no version was saved');
  });

  it('words a refused update', () => {
    expect(updateRefusal(http(403)).kind).toBe('forbidden');
    expect(updateRefusal(http(404)).kind).toBe('gone');
  });

  it('words a refused delete, a problem that runs used apart', () => {
    expect(deleteRefusal(http(409)).kind).toBe('sealed');
    expect(deleteRefusal(http(403)).text).toMatch(/ADMIN/);
    expect(deleteRefusal(http(404)).kind).toBe('gone');
  });

  it('tells a missing problem and a source that cannot be shown', () => {
    expect(isMissing(null)).toBe(false);
    expect(isMissing(classifyAuthError(http(404)))).toBe(true);
    expect(sourceFailureKind(classifyAuthError(http(403)))).toBe('key');
    expect(sourceFailureKind(classifyAuthError(http(404)))).toBe('missing');
    expect(sourceFailureKind(classifyAuthError(http(422, 'revision_not_recompilable')))).toBe('recompile');
  });
});
