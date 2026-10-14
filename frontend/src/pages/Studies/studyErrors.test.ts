import { describe, expect, it } from 'vitest';
import { PricingUnavailableError, QuotaError } from '../../api/auth';
import { HttpError } from '../../api/client';
import { mismatchedFields, studyRefusal } from './studyErrors';

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

  it('says which limit of the plan was reached, and promises no renewal: nothing renews', () => {
    const refusal = studyRefusal(new QuotaError('quota_exceeded', 'full', { limit_id: 'storageBytes', limit: 3, used: 3, renews_at: '2026-11-01T00:00:00Z' }), 'run');
    expect(refusal.title).toBe('Out of storage (402 · quota_exceeded)');
    expect(refusal.text).toBe('You’ve used 3 of 3 storage. Nothing was started.');
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

  it('says which of case, engine, mode and seed a job does not share with the cell (409 cell_job_mismatch)', () => {
    const perField = studyRefusal(refused(409, 'cell_job_mismatch', 'mismatch', {
      problem: { detail: { code: 'cell_job_mismatch', fields: ['engine', 'seed'], details: { engine: { cell: 'bim.builtin/evolutionary@1.0.0', job: 'bim.builtin/random-search@1.0.0' }, seed: { cell: 2, job: 7 } } } },
    }), 'attach');
    expect(perField).toMatchObject({
      kind: 'conflict',
      title: 'That job isn’t a run of this cell (409 · cell_job_mismatch)',
      details: ['Engine: the cell has bim.builtin/evolutionary@1.0.0, the job ran bim.builtin/random-search@1.0.0', 'Seed: the cell has 2, the job ran 7'],
    });
    expect(perField.text).toContain('It differs in the engine and seed.');
    expect(perField.text).toContain('Nothing changed.');

    const perSide = studyRefusal(refused(409, 'cell_job_mismatch', 'mismatch', {
      problem: { code: 'cell_job_mismatch', fields: ['case_revision', 'mode', 'seed'], details: { cell: { case_revision: 'r2', mode: 'optimize', seed: 1 }, job: { case_revision: 'r1', mode: null, seed: 1 } } },
    }), 'attach');
    expect(perSide.text).toContain('It differs in the case, mode and seed.');
    expect(perSide.details).toEqual(['Case: the cell has r2, the job ran r1', 'Mode: the cell has optimize, the job ran none', 'Seed: the cell has 1, the job ran 1']);

    expect(studyRefusal(refused(409, 'cell_job_mismatch'), 'attach')).toMatchObject({ title: 'That job isn’t a run of this cell (409 · cell_job_mismatch)', details: [] });
    expect(mismatchedFields(refused(409, 'cell_job_mismatch', 'x', { problem: { detail: { fields: ['seed'] } } }))).toEqual([{ field: 'seed', label: 'seed' }]);
  });

  it('words the other two refusals of an attached result', () => {
    expect(studyRefusal(refused(409, 'job_result_missing'), 'attach')).toMatchObject({ kind: 'terminal', title: 'That job finished without a result (409 · job_result_missing)' });
    expect(studyRefusal(refused(409, 'job_already_attached'), 'attach')).toMatchObject({ kind: 'conflict', title: 'That job is already the result of another cell (409 · job_already_attached)' });
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

  it('refuses a run whole when a case is over the plan’s size limit, and says so as a run, not as a job', () => {
    const refusal = studyRefusal(Object.assign(new QuotaError('instance_complexity_too_large', 'too big', { limit_id: 'maxInstanceComplexityLog10', limit: 9, used: 12 }), {
      notice: { limit_id: 'maxInstanceComplexityLog10', state: 'exhausted' as const, source: 'plan' as const, limit: 9, used: 12 },
      bindingSpace: { log10: 12, digits: 13 },
    }), 'run');
    expect(refusal).toMatchObject({ kind: 'too-big', source: 'plan', title: 'A case is too big for your plan (402 · instance_complexity_too_large)' });
    expect(refusal.text).toBe('This problem has about 10¹² combinations; your plan allows up to 10⁹ combinations. Reduce the candidates or ask about a larger plan. Nothing was started.');
  });

  it('a plan that sets no size limit (403) is not a key without a permission, for a run either', () => {
    const refusal = studyRefusal(refused(403, 'binding_space_limit_unknown', 'The plan does not declare a limit', { notice: { limit_id: 'maxInstanceComplexityLog10', state: 'unknown', source: 'none' } }), 'run');
    expect(refusal).toMatchObject({ kind: 'limit-unknown', title: 'Your plan doesn’t set a problem-size limit (403 · binding_space_limit_unknown)' });
    expect(refusal.permission).toBeUndefined();
    expect(refusal.text).toContain('Nothing was started.');
    expect(`${refusal.title} ${refusal.text}`).not.toMatch(/credential|permission|API key/i);
  });

  it('a run over the deployment’s size limit or cell cap says a larger plan changes nothing', () => {
    const size = studyRefusal(refused(422, 'binding_space_over_technical_limit', 'x', { notice: { limit_id: 'maxInstanceComplexityLog10', state: 'exhausted', source: 'technical', limit: 3, used: 6 } }), 'run');
    expect(size).toMatchObject({ kind: 'technical', title: 'Over this deployment’s size limit (422 · binding_space_over_technical_limit)' });

    const cells = studyRefusal(refused(422, 'study_run_too_large', 'x', { notice: { limit_id: 'maxCellsPerRun', state: 'exhausted', source: 'technical', unit: 'cell', limit: 100, used: 240 } }), 'run');
    expect(cells).toMatchObject({ kind: 'technical', limitId: 'maxCellsPerRun', source: 'technical', title: 'This run is over the deployment’s size limit (422 · study_run_too_large)' });
    expect(cells.text).toBe('This deployment limits a study run to 100 cells; this one expands to 240, whatever the plan. Remove an engine, a setting or some seeds. Nothing was started.');
  });

  it('a study runs counter that is spent or unreadable is told as such', () => {
    const spent = studyRefusal(Object.assign(new QuotaError('usage_limit_exceeded', 'x'), { notice: { limit_id: 'studyRuns', state: 'exhausted' as const, source: 'space' as const, unit: 'run' } }), 'run');
    expect(spent).toMatchObject({ kind: 'quota', limitId: 'studyRuns', title: 'Out of study runs (402 · usage_limit_exceeded)' });
    expect(spent.text).toBe('You’ve used all your study runs. Nothing was started.');

    const unread = studyRefusal(refused(503, 'usage_limit_unknown', 'x', { notice: { limit_id: 'studyRuns', state: 'unknown', source: 'space' } }), 'run');
    expect(unread).toMatchObject({ kind: 'pricing', title: 'Your usage can’t be read right now (503 · usage_limit_unknown)' });
  });

  it('a 429 for a cell says whose limit it is', () => {
    const refusal = studyRefusal(refused(429, 'concurrency_limit_exceeded', 'busy', { concurrency: { limit_id: 'concurrentJobs', limit: 1, used: 1, source: 'technical' }, retryAfter: 15 }), 'run');
    expect(refusal.text).toContain('This deployment lets one account run 1 job at once, whatever its plan.');
    expect(refusal.source).toBe('technical');
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
