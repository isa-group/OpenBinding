import { describe, expect, it } from 'vitest';
import { PricingUnavailableError, QuotaError } from '../../api/auth';
import { HttpError } from '../../api/client';
import { studyRefusal } from './studyErrors';

const refused = (status: number, code?: string, message = 'refused', extra: Partial<HttpError> = {}) => Object.assign(new HttpError(status, message), { code }, extra);

describe('why the gateway refuses a study', () => {
  it('says the sponsor has no study definitions left on a 402 for a new study', () => {
    const refusal = studyRefusal(new QuotaError('quota_exceeded', 'full', { limit_id: 'studies', limit: 25, used: 25 }), 'create');
    expect(refusal.kind).toBe('quota');
    expect(refusal.title).toBe('The sponsor has no study definitions left (402 · quota_exceeded)');
    expect(refusal.text).toContain('25 of 25 used');
    expect(refusal.text).toContain('Nothing was created.');
    expect(refusal.limitId).toBe('studies');
  });

  it('says the month’s study runs are used up, and when they renew', () => {
    const refusal = studyRefusal(new QuotaError('quota_exceeded', 'full', { limit_id: 'studyRuns', limit: 3, used: 3, renews_at: '2026-11-01T00:00:00Z' }), 'run');
    expect(refusal.title).toBe('No study runs left this month (402 · quota_exceeded)');
    expect(refusal.text).toBe('You’ve used 3 of 3 study runs. They renew on Nov 1, 2026. Nothing was started.');
  });

  it('keeps the slots a 429 names and how long to wait', () => {
    const refusal = studyRefusal(refused(429, 'concurrency_limit_exceeded', 'busy', { concurrency: { limit_id: 'concurrentJobs', limit: 3, used: 3 }, retryAfter: 15 }), 'run');
    expect(refusal.kind).toBe('busy');
    expect(refusal.retryAfter).toBe(15);
    expect(refusal.text).toContain('You can run 3 jobs at once.');
  });

  it('tells a plan without studies from a key that lacks an engine or a permission', () => {
    expect(studyRefusal(refused(403, 'feature_not_entitled', 'No studies in this plan.'), 'run').kind).toBe('plan');
    const key = studyRefusal(refused(403, 'api_key_engine_forbidden', 'The key does not grant Evolutionary.'), 'run');
    expect(key.kind).toBe('key');
    expect(key.title).toBe('This API key isn’t allowed to use one of the study’s engines (403 · api_key_engine_forbidden)');
    const permission = studyRefusal(refused(403, 'api_key_forbidden', 'The API key does not include studies:write.'), 'create');
    expect(permission.permission).toBe('studies:write');
    expect(studyRefusal(refused(403, 'forbidden', 'Needs ADMIN.'), 'delete').text).toContain('Deleting needs ADMIN');
  });

  it('words each 409 by what it protects', () => {
    expect(studyRefusal(refused(409, 'slug_conflict'), 'create').title).toBe('That address is already used (409 · slug_conflict)');
    expect(studyRefusal(refused(409, 'study_archived'), 'run').title).toBe('This study is archived (409 · study_archived)');
    expect(studyRefusal(refused(409, 'evidence_only_study'), 'run').title).toBe('This study only holds stored evidence (409 · evidence_only_study)');
    const sealed = studyRefusal(refused(409, 'sealed_evidence'), 'cancel');
    expect(sealed.kind).toBe('terminal');
    expect(sealed.title).toBe('A sealed report cites this run (409 · sealed_evidence)');
    expect(studyRefusal(refused(409, 'terminal_run'), 'cancel').title).toBe('This run already finished (409 · terminal_run)');
    expect(studyRefusal(refused(409, 'cell_not_retryable'), 'retry').title).toBe('This cell can’t be retried (409 · cell_not_retryable)');
    expect(studyRefusal(refused(409, 'job_not_finished'), 'attach').title).toBe('That job hasn’t finished (409 · job_not_finished)');
    expect(studyRefusal(refused(409, 'study_history_retained'), 'delete').title).toBe('This study has runs (409 · study_history_retained)');
  });

  it('words each 422 by what the study asked for', () => {
    expect(studyRefusal(refused(422, 'study_matrix_too_large'), 'create')).toMatchObject({ kind: 'too-big', title: 'The matrix is too large (422 · study_matrix_too_large)' });
    expect(studyRefusal(refused(422, 'empty_study_cases'), 'create').title).toBe('The study needs a case (422 · empty_study_cases)');
    expect(studyRefusal(refused(422, 'foreign_case_revision'), 'create').title).toBe('A case revision isn’t in this organization (422 · foreign_case_revision)');
    expect(studyRefusal(refused(422, 'unavailable_collection'), 'create').title).toBe('That collection isn’t available (422 · unavailable_collection)');
    const mode = studyRefusal(refused(422, 'engine_mode_incompatible', 'MiniZinc has no mode for this goal.'), 'create');
    expect(mode.kind).toBe('incompatible');
    expect(mode.text).toContain('MiniZinc has no mode for this goal.');
    expect(studyRefusal(refused(422, 'weird', 'Odd.'), 'create').kind).toBe('other');
  });

  it('separates a missing cell or job, a pricing outage and a service that did not answer', () => {
    expect(studyRefusal(refused(404, 'not_found'), 'attach').text).toContain('only a finished job you launched can be attached');
    expect(studyRefusal(new PricingUnavailableError('pricing down'), 'run')).toMatchObject({ kind: 'pricing', title: 'Limits can’t be checked right now (503 · pricing_unavailable)' });
    expect(studyRefusal(refused(503, 'upstream'), 'run').kind).toBe('unavailable');
    expect(studyRefusal(refused(401), 'run').kind).toBe('session');
    expect(studyRefusal(new TypeError('fetch failed'), 'run')).toMatchObject({ kind: 'unavailable', title: 'OpenBinding couldn’t be reached' });
    expect(studyRefusal(new Error('odd'), 'update').kind).toBe('other');
  });
});
