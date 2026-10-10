import { describe, expect, it } from 'vitest';
import { PricingUnavailableError, QuotaError } from '../../api/auth';
import { HttpError } from '../../api/client';
import { rangeFailureOf, refusalOf } from './jobErrors';

const refused = (status: number, code: string, extra: Partial<HttpError> = {}) => Object.assign(new HttpError(status, 'refused'), { code }, extra);

describe('refusals of a launch', () => {
  it('402 out of solves says how many were used and when they renew', () => {
    const refusal = refusalOf(new QuotaError('quota_exceeded', 'Solve quota exhausted.', { limit_id: 'taskStarts', limit: 10, used: 10, renews_at: '2026-11-01T00:00:00Z' }));
    expect(refusal).toMatchObject({ kind: 'quota', limitId: 'taskStarts', title: 'Out of solves this month (402 · quota_exceeded)' });
    expect(refusal.text).toBe('You’ve used 10 of 10 solves. They renew on Nov 1, 2026. Nothing was started.');
  });

  it('402 names any other allowance by its own words', () => {
    const refusal = refusalOf(new QuotaError('quota_exceeded', 'No solver time.', { limit_id: 'solverSeconds', limit: 900, used: 900 }));
    expect(refusal.title).toBe('Out of solver time (402 · quota_exceeded)');
  });

  it('402 for a problem beyond the plan is a different refusal', () => {
    const refusal = refusalOf(new QuotaError('instance_complexity_too_large', 'too big', { limit_id: 'maxInstanceComplexityLog10', limit: 9 }));
    expect(refusal.kind).toBe('too-big');
    expect(refusal.title).toBe('Too big for your plan (402 · instance_complexity_too_large)');
  });

  it('429 gives the slots and how long to wait', () => {
    const refusal = refusalOf(refused(429, 'concurrency_limit_exceeded', { retryAfter: 15, concurrency: { limit_id: 'concurrentJobs', limit: 1, used: 1 } }));
    expect(refusal).toMatchObject({ kind: 'busy', retryAfter: 15, title: 'All your job slots are busy (429 · concurrency_limit_exceeded)' });
    expect(refusal.text).toContain('You can run 1 job at once.');
  });

  it('403 tells a plan that does not include the feature from a credential without the permission', () => {
    expect(refusalOf(refused(403, 'feature_not_entitled')).kind).toBe('plan');
    const key = refusalOf(new HttpError(403, 'The API key does not include engines:execute'));
    expect(key).toMatchObject({ kind: 'key', permission: 'engines:execute' });
    expect(key.title).toBe('This credential can’t start runs (403)');
  });

  it('422 for a mode that cannot run the problem lists what the gateway said', () => {
    const refusal = refusalOf(refused(422, 'engine_mode_incompatible', { diagnostics: [{ message: 'It cannot read a RoutingOverlay.' }] }));
    expect(refusal).toMatchObject({ kind: 'incompatible', details: ['It cannot read a RoutingOverlay.'] });
    expect(refusal.title).toBe('This engine can’t run this problem (422 · engine_mode_incompatible)');
  });

  it('422 unsupported_capability_value says the engine takes single values only and points at the candidates', () => {
    const refusal = refusalOf(refused(422, 'unsupported_capability_value', {
      diagnostics: [
        { code: 'unsupported_capability_value', message: 'featureValues interval is not declared', pointer: '/spec/candidates/providers/candidates/fastpay/features/latency' },
        { code: 'unsupported_capability_value', message: 'featureValues interval is not declared' },
      ],
    }));

    expect(refusal).toMatchObject({ kind: 'range', status: 422, code: 'unsupported_capability_value', title: 'This engine only accepts single values (422 · unsupported_capability_value)' });
    expect(refusal.text).toContain('range features');
    expect(refusal.text).toContain('Nothing was started.');
    expect(refusal.details).toEqual([
      'featureValues interval is not declared (/spec/candidates/providers/candidates/fastpay/features/latency)',
      'featureValues interval is not declared',
    ]);
  });

  it('recognises the refusal by its diagnostics when the top-level code is another', () => {
    const refusal = refusalOf(refused(422, 'engine_mode_incompatible', { diagnostics: [{ code: 'unsupported_capability_value', message: 'open interval', pointer: '/spec/x' }] }));
    expect(refusal.kind).toBe('range');
    expect(refusal.details).toEqual(['open interval (/spec/x)']);
  });

  it('a job that failed for ranges says the same, without claiming nothing started', () => {
    expect(rangeFailureOf({ result: { code: 'unsupported_capability_value', diagnostics: [{ message: 'no interval', pointer: '/spec/a' }] } })).toMatchObject({
      kind: 'range', details: ['no interval (/spec/a)'],
    });
    expect(rangeFailureOf({ error: 'Failed: unsupported_capability_value (unsupported: ["interval"])' })?.kind).toBe('range');
    expect(rangeFailureOf({ error: 'Failed: unsupported_capability_value' })?.text).not.toContain('Nothing was started.');
    expect(rangeFailureOf({ error: 'The engine crashed' })).toBeNull();
    expect(rangeFailureOf({ result: null })).toBeNull();
  });

  it('404, 409 and 503 each keep their meaning', () => {
    expect(refusalOf(refused(404, 'not_found')).title).toBe('Engine not available with this key (404 · not_found)');
    expect(refusalOf(refused(409, 'idempotency_conflict')).kind).toBe('conflict');
    expect(refusalOf(new PricingUnavailableError('SPACE is down'))).toMatchObject({ kind: 'pricing', title: 'Limits can’t be checked right now (503 · pricing_unavailable)' });
    expect(refusalOf(refused(503, 'unavailable')).kind).toBe('unavailable');
    expect(refusalOf(refused(401, 'unauthorized')).kind).toBe('session');
  });

  it('a request that never got an answer is not blamed on the account', () => {
    expect(refusalOf(new TypeError('Failed to fetch')).kind).toBe('unavailable');
  });
});

describe('refusals of an action on a run', () => {
  it('cancelling a finished run is a 409 with its own words', () => {
    expect(refusalOf(refused(409, 'terminal_job'), 'cancel')).toMatchObject({ kind: 'terminal', title: 'Already finished (409 · terminal_job)' });
  });

  it('retrying a run that cannot be retried, or without solves left', () => {
    expect(refusalOf(refused(409, 'job_not_retryable'), 'retry').title).toBe('This run can’t be retried (409 · job_not_retryable)');
    const quota = refusalOf(new QuotaError('quota_exceeded', 'Solve quota exhausted.', { limit_id: 'taskStarts', limit: 10, used: 10 }), 'retry');
    expect(quota.title).toBe('Retry refused: Out of solves this month (402 · quota_exceeded)');
  });

  it('a run that is not yours reads as missing', () => {
    expect(refusalOf(refused(404, 'not_found'), 'cancel')).toMatchObject({ kind: 'not-found', title: 'Job not found (404 · not_found)' });
  });
});
