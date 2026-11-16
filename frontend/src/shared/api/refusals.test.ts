import { describe, expect, it } from 'vitest';
import { QuotaError } from '../../api/auth';
import { HttpError } from '../../api/client';
import { refusalMarker, refusalOf, refusalText, saveRefusalText } from './refusals';

const failure = (status: number, code?: string, diagnostics?: unknown[]) => Object.assign(new HttpError(status, 'No'), { code, diagnostics });

describe('how a refusal is sorted', () => {
  it('reads a 402 as an allowance of the plan used up, with the allowance it names', () => {
    const refusal = refusalOf(new QuotaError('quota_exceeded', 'used up', { limit_id: 'maxRepositoryStorage', limit: 500 }));
    expect(refusal).toMatchObject({ kind: 'quota', status: 402, code: 'quota_exceeded', limitId: 'maxRepositoryStorage', limit: 500 });
    expect(refusalText(refusal, 'nothing was checked')).toBe('Your plan’s storage is used up (402 · quota_exceeded), so nothing was checked. Free some, or see your plan.');
    expect(saveRefusalText(refusal)).toBe('Your plan has no room for this (402 · quota_exceeded): it counts your problems and the storage your packages take. Nothing was saved.');
  });

  it.each([
    [401, 'session'], [403, 'key'], [413, 'too-large'], [415, 'unsupported'], [422, 'invalid'], [429, 'busy'], [503, 'unavailable'], [404, 'other'], [409, 'other'],
  ])('reads a %i as %s', (status, kind) => {
    expect(refusalOf(failure(status))).toMatchObject({ kind, status, message: 'No' });
  });

  it('keeps the diagnostics of a 422 and drops the ones that are not objects', () => {
    const refusal = refusalOf(failure(422, 'invalid_package', [{ code: 'a', message: 'one' }, 'junk', null]));
    expect(refusal.diagnostics).toEqual([{ code: 'a', message: 'one' }]);
    expect(refusal.code).toBe('invalid_package');
  });

  it('reads a request that never got an answer as the service being unreachable, and anything else by its message', () => {
    expect(refusalOf(new TypeError('Failed to fetch'))).toMatchObject({ kind: 'unavailable' });
    expect(refusalOf(new Error('Run failed'))).toEqual({ kind: 'other', message: 'Run failed', diagnostics: [] });
    expect(refusalOf('odd')).toEqual({ kind: 'other', message: 'odd', diagnostics: [] });
  });

  it('writes the status and the code the way people quote them', () => {
    expect(refusalMarker({ status: 422 })).toBe(' (422)');
    expect(refusalMarker({ status: 403, code: 'api_key_boundary' })).toBe(' (403 · api_key_boundary)');
    expect(refusalMarker({})).toBe('');
  });
});

describe('the words for a refusal', () => {
  it('says what was left undone and never blames the package for a service that did not answer', () => {
    expect(refusalText(refusalOf(failure(503)), 'nothing was checked')).toBe(
      'A service OpenBinding depends on isn’t answering (503), so nothing was checked. This says nothing about your package; try again in a moment.',
    );
    expect(refusalText(refusalOf(failure(429)), 'x')).toBe('Too many requests (429). Wait a moment and try again.');
    expect(refusalText(refusalOf(failure(415)), 'x')).toBe('The gateway doesn’t take this kind of file (415). Use a .bim.zip package.');
    expect(refusalText(refusalOf(failure(401)), 'x')).toContain('Log in again');
  });

  it('uses the message alone when the failure has no status, such as a job that failed', () => {
    expect(refusalText(refusalOf(new Error('The deployment did not answer.')), 'the run did not finish')).toBe('The deployment did not answer.');
  });

  it('words the refusals of saving a problem version, each ending in nothing being saved', () => {
    expect(saveRefusalText(refusalOf(failure(403, 'forbidden')))).toBe(
      'You need MEMBER in the organization to save, and an API key needs problems:write (403 · forbidden). Nothing was saved.',
    );
    expect(saveRefusalText(refusalOf(failure(409, 'slug_conflict')))).toBe(
      'That address is already used by another problem in this organization (409 · slug_conflict). Pick another one. Nothing was saved.',
    );
    expect(saveRefusalText(refusalOf(failure(404)))).toBe('That problem no longer exists, or you’re not in its organization (404). Nothing was saved.');
    expect(saveRefusalText(refusalOf(failure(422)))).toContain('The gateway refused to seal this package (422).');
    expect(saveRefusalText(refusalOf(new QuotaError('quota_exceeded', 'x')))).toBe('Your plan has no room for this (402 · quota_exceeded): it counts your problems and the allowance your packages take. Nothing was saved.');
    expect(saveRefusalText(refusalOf(failure(401)))).toContain('Nothing was saved.');
  });
});
