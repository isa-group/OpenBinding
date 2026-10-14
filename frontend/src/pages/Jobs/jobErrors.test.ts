import { describe, expect, it } from 'vitest';
import { PricingUnavailableError, QuotaError } from '../../api/auth';
import { HttpError } from '../../api/client';
import type { LimitNotice } from '../../api/limitNotice';
import { rangeFailureOf, refusalOf } from './jobErrors';

const refused = (status: number, code: string, extra: Partial<HttpError> = {}) => Object.assign(new HttpError(status, 'refused'), { code }, extra);

describe('refusals of a launch', () => {
  it('402 out of an allowance says what the plan allows and that nothing was started', () => {
    const refusal = refusalOf(new QuotaError('quota_exceeded', 'API keys exhausted.', { limit_id: 'apiKeys', limit: 10, used: 10 }));
    expect(refusal).toMatchObject({ kind: 'quota', limitId: 'apiKeys', title: 'Out of API keys (402 · quota_exceeded)' });
    expect(refusal.text).toBe('You’ve used 10 of 10 API keys. Nothing was started.');
  });

  it('402 never promises a renewal, even if the answer names a date: nothing renews', () => {
    const refusal = refusalOf(new QuotaError('quota_exceeded', 'API keys exhausted.', { limit_id: 'apiKeys', limit: 10, used: 10, renews_at: '2026-11-01T00:00:00Z' }));
    expect(refusal.text).not.toMatch(/renew/i);
  });

  it('402 names any other allowance by its own words', () => {
    const refusal = refusalOf(new QuotaError('quota_exceeded', 'No storage.', { limit_id: 'storageBytes', limit: 900, used: 900 }));
    expect(refusal.title).toBe('Out of storage (402 · quota_exceeded)');
  });

  it('402 without a named allowance says so in general terms', () => {
    const refusal = refusalOf(new QuotaError('quota_exceeded', 'No allowance.'));
    expect(refusal.title).toBe('Out of allowance (402 · quota_exceeded)');
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

  it('reads the real refusal: engine_mode_incompatible with the range diagnostic, located in its file, by irPath, or not at all', () => {
    const range = { code: 'unsupported_capability_value', category: 'featureValues', unsupported: ['interval'], allowed: ['scalar'], message: 'mode does not support requested featureValues values' };
    const located = refusalOf(refused(422, 'engine_mode_incompatible', {
      diagnostics: [{ ...range, resource: 'candidates.json', pointer: '/spec/candidates/c1a/features/latency', irPath: '/spec/candidates/catalog/candidates/c1a/features/latency' }],
    }));
    expect(located).toMatchObject({ kind: 'range', status: 422 });
    expect(located.details).toEqual(['mode does not support requested featureValues values (candidates.json#/spec/candidates/c1a/features/latency)']);
    const compiled = refusalOf(refused(422, 'engine_mode_incompatible', { diagnostics: [{ ...range, irPath: '/spec/candidates/catalog/candidates/c1a/features/latency' }] }));
    expect(compiled.details).toEqual(['mode does not support requested featureValues values (/spec/candidates/catalog/candidates/c1a/features/latency)']);
    const bare = refusalOf(refused(422, 'engine_mode_incompatible', { diagnostics: [range] }));
    expect(bare.kind).toBe('range');
    expect(bare.details).toEqual(['mode does not support requested featureValues values']);
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

const aNotice = (extra: Partial<LimitNotice>): LimitNotice => ({ limit_id: 'maxInstanceComplexityLog10', state: 'exhausted', unit: 'log10 combinations', ...extra });

/** Words that would turn a measurable ceiling into money or a balance: none may reach the interface. */
const MONEY = /credit|balance|capacity unit|\bCUs?\b|\bpay\b|\bprice\b/i;

describe('refusals over a limit that is exhausted, unknown, capped by the deployment or unmeasured', () => {
  it('403 binding_space_limit_unknown says the plan sets no size limit, never that the credential lacks a permission', () => {
    const refusal = refusalOf(refused(403, 'binding_space_limit_unknown', {
      notice: aNotice({ state: 'unknown', source: 'none' }),
      // The gateway's own sentence is not repeated, whatever it says.
      message: 'HTTP 403: The plan does not declare a limit for the size of the binding space (internal detail)',
    } as Partial<HttpError>));

    expect(refusal).toMatchObject({ kind: 'limit-unknown', status: 403, code: 'binding_space_limit_unknown', source: 'none', limitId: 'maxInstanceComplexityLog10' });
    expect(refusal.title).toBe('Your plan doesn’t set a problem-size limit (403 · binding_space_limit_unknown)');
    expect(refusal.text).toContain('A larger plan won’t fix it');
    expect(refusal.text).toContain('Contact the administrator.');
    expect(refusal.text).toContain('Nothing was started.');
    expect(`${refusal.title} ${refusal.text}`).not.toMatch(/credential|permission|API key|internal detail/i);
    expect(refusal.permission).toBeUndefined();
    expect(refusal.kind).not.toBe('key');
  });

  it('403 binding_space_limit_unknown on a retry does not say the retry was refused for a key either', () => {
    const refusal = refusalOf(refused(403, 'binding_space_limit_unknown'), 'retry');
    expect(refusal.kind).toBe('limit-unknown');
    expect(refusal.text).toContain('Nothing was started.');
  });

  it('422 binding_space_over_technical_limit says the deployment caps the size and a larger plan changes nothing', () => {
    const refusal = refusalOf(refused(422, 'binding_space_over_technical_limit', {
      notice: aNotice({ source: 'technical', limit: 6, used: 9.2 }),
      bindingSpace: { log10: 9.2, digits: 10 },
    }));

    expect(refusal).toMatchObject({ kind: 'technical', status: 422, source: 'technical' });
    expect(refusal.title).toBe('Over this deployment’s size limit (422 · binding_space_over_technical_limit)');
    expect(refusal.text).toContain('up to 10⁶ combinations');
    expect(refusal.text).toContain('whatever the plan, so a larger plan won’t change it');
    expect(refusal.text).toContain('about 10^9.2 combinations');
    expect(refusal.text).toContain('Reduce the candidates.');
  });

  it('422 binding_space_unmeasured is a fault of the service, not a mistake of the package', () => {
    const refusal = refusalOf(refused(422, 'binding_space_unmeasured', { notice: aNotice({ state: 'unmeasured', source: 'plan', limit: 9 }) }));

    expect(refusal.kind).toBe('unmeasured');
    expect(refusal.title).toBe('The problem’s size couldn’t be measured (422 · binding_space_unmeasured)');
    expect(refusal.text).toContain('fault on the service’s side, not a mistake in your package');
    expect(refusal.text).toContain('Try again');
    expect(refusal.kind).not.toBe('incompatible');
  });

  it('503 pricing_misconfigured is the plan’s fault and carries no details of the gateway', () => {
    const refusal = refusalOf(refused(503, 'pricing_misconfigured', { message: 'HTTP 503: SPACE entitlement does not declare a timeout' } as Partial<HttpError>));

    expect(refusal.kind).toBe('misconfigured');
    expect(refusal.title).toBe('Your plan can’t be applied (503 · pricing_misconfigured)');
    expect(refusal.text).toContain('Contact the administrator.');
    expect(refusal.text).not.toMatch(/SPACE|entitlement|timeout/);
  });

  it('402 instance_complexity_too_large says how big the problem is and what the plan allows', () => {
    const quota = { limit_id: 'maxInstanceComplexityLog10', limit: 9, used: 12.5 };
    const refusal = refusalOf(Object.assign(new QuotaError('instance_complexity_too_large', 'too big', quota), {
      notice: aNotice({ source: 'plan', limit: 9, used: 12.5 }),
      bindingSpace: { log10: 12.5, digits: 13 },
    }));

    expect(refusal).toMatchObject({ kind: 'too-big', source: 'plan', limitId: 'maxInstanceComplexityLog10' });
    expect(refusal.text).toBe('This problem has about 10^12.5 combinations; your plan allows up to 10⁹ combinations. Reduce the candidates or ask about a larger plan. Nothing was started.');
  });

  it('402 prints an exact count of combinations when the gateway sent a short one, and the digits when it sent only those', () => {
    const exact = refusalOf(Object.assign(new QuotaError('instance_complexity_too_large', 'x', { limit_id: 'maxInstanceComplexityLog10', limit: 0.1 }), {
      notice: aNotice({ source: 'plan', limit: 0.1, used: 0.30103 }), bindingSpace: { log10: 0.30103, digits: 1, cardinality: '2' },
    }));
    expect(exact.text).toContain('This problem has 2 combinations;');

    const huge = refusalOf(Object.assign(new QuotaError('instance_complexity_too_large', 'x', { limit_id: 'maxInstanceComplexityLog10', limit: 100 }), {
      bindingSpace: { digits: 4321 },
    }));
    expect(huge.text).toContain('a number of combinations with 4,321 digits');
  });

  it('402 without a measure still says the problem is over the plan and is not an unknown limit', () => {
    const refusal = refusalOf(new QuotaError('instance_complexity_too_large', 'too big'));
    expect(refusal.kind).toBe('too-big');
    expect(refusal.text).toBe('This problem has more combinations than your plan allows. Reduce the candidates or ask about a larger plan. Nothing was started.');
  });

  it('402 usage_limit_exceeded without numbers is told as a spent allowance by the counter it names', () => {
    const refusal = refusalOf(Object.assign(new QuotaError('usage_limit_exceeded', 'spent'), {
      notice: { limit_id: 'taskStarts', state: 'exhausted', source: 'space', unit: 'task' },
    }));
    expect(refusal).toMatchObject({ kind: 'quota', limitId: 'taskStarts', source: 'space' });
    expect(refusal.title).toBe('Out of task starts (402 · usage_limit_exceeded)');
    expect(refusal.text).toBe('You’ve used all your task starts. Nothing was started.');
  });

  it('503 usage_limit_unknown is a wait, not an account problem', () => {
    const refusal = refusalOf(refused(503, 'usage_limit_unknown', { retryAfter: 15, notice: { limit_id: 'taskStarts', state: 'unknown', source: 'space', unit: 'task' } }));
    expect(refusal).toMatchObject({ kind: 'pricing', limitId: 'taskStarts' });
    expect(refusal.title).toBe('Your usage can’t be read right now (503 · usage_limit_unknown)');
    expect(refusal.text).toContain('Try again in a moment.');
  });

  it('429 says whose limit it is: the plan’s, or the deployment’s whatever the plan', () => {
    const plan = refusalOf(refused(429, 'concurrency_limit_exceeded', { retryAfter: 15, concurrency: { limit_id: 'concurrentJobs', limit: 2, used: 2, source: 'plan', unit: 'job' } }));
    expect(plan).toMatchObject({ kind: 'busy', source: 'plan' });
    expect(plan.text).toContain('Your plan lets you run 2 jobs at once.');

    const technical = refusalOf(refused(429, 'concurrency_limit_exceeded', { retryAfter: 15, concurrency: { limit_id: 'concurrentJobs', limit: 1, used: 1, source: 'technical' } }));
    expect(technical).toMatchObject({ kind: 'busy', source: 'technical' });
    expect(technical.text).toContain('This deployment lets one account run 1 job at once, whatever its plan.');
  });

  it('never speaks of credits, balance or capacity units, whatever the refusal', () => {
    const all = [
      refusalOf(refused(403, 'binding_space_limit_unknown')),
      refusalOf(refused(422, 'binding_space_over_technical_limit', { notice: aNotice({ source: 'technical', limit: 6 }) })),
      refusalOf(refused(422, 'binding_space_unmeasured')),
      refusalOf(refused(503, 'pricing_misconfigured')),
      refusalOf(refused(503, 'usage_limit_unknown')),
      refusalOf(new QuotaError('usage_limit_exceeded', 'x', { limit_id: 'solverSeconds', limit: 60, used: 60 })),
      refusalOf(new QuotaError('instance_complexity_too_large', 'x')),
      refusalOf(refused(429, 'concurrency_limit_exceeded', { concurrency: { limit_id: 'concurrentJobs', limit: 1, used: 1, source: 'plan' } })),
    ];
    for (const refusal of all) expect(`${refusal.title} ${refusal.text}`).not.toMatch(MONEY);
  });
});

describe('refusals of an action on a run', () => {
  it('cancelling a finished run is a 409 with its own words', () => {
    expect(refusalOf(refused(409, 'terminal_job'), 'cancel')).toMatchObject({ kind: 'terminal', title: 'Already finished (409 · terminal_job)' });
  });

  it('retrying a run that cannot be retried, or without allowance left', () => {
    expect(refusalOf(refused(409, 'job_not_retryable'), 'retry').title).toBe('This run can’t be retried (409 · job_not_retryable)');
    const quota = refusalOf(new QuotaError('quota_exceeded', 'API keys exhausted.', { limit_id: 'apiKeys', limit: 10, used: 10 }), 'retry');
    expect(quota.title).toBe('Retry refused: Out of API keys (402 · quota_exceeded)');
  });

  it('a run that is not yours reads as missing', () => {
    expect(refusalOf(refused(404, 'not_found'), 'cancel')).toMatchObject({ kind: 'not-found', title: 'Job not found (404 · not_found)' });
  });
});
