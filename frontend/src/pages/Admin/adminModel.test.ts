import { describe, expect, it } from 'vitest';
import { PricingUnavailableError, QuotaError } from '../../api/auth';
import { HttpError } from '../../api/client';
import { catalogFixture } from '../Pricing/pricingFixture';
import {
  ageLabel, agreementIssues, auditFamily, compareLimits, describeAdminFailure, describeAuditEvent, errorMeaning, groupErrors, limitsOf,
  planTone, readContractCatalog, readErrorEvent, shortId, statusTone, type ContractCatalog,
} from './adminModel';
import { AUDIT, ERROR_EVENTS, SAM } from '../../test/fixtures/admin';

function catalog(): ContractCatalog {
  const read = readContractCatalog(catalogFixture);
  if (!read) throw new Error('the fixture has plans');
  return read;
}

describe('describeAdminFailure', () => {
  it('says a key without the administration permission is a 403 and not worth retrying', () => {
    const failure = describeAdminFailure(new HttpError(403, 'nope'), 'ignored');
    expect(failure.status).toBe(403);
    expect(failure.title).toBe('This key can’t use administration (403)');
    expect(failure.text).toMatch(/admin:accounts:read or admin:accounts:write/);
  });

  it('keeps the gateway’s error code next to the status', () => {
    const error = new HttpError(409, 'An administrator cannot deactivate or demote their own account.');
    error.code = 'cannot_demote_self';
    const failure = describeAdminFailure(error, 'ignored');
    expect(failure.title).toBe('The gateway refused the change (409 · cannot_demote_self)');
    expect(failure.text).toBe('An administrator cannot deactivate or demote their own account.');
    expect(failure.code).toBe('cannot_demote_self');
  });

  it('reads a quota refusal as a 402 with the quota that was named', () => {
    const failure = describeAdminFailure(new QuotaError('sponsor_quota_exceeded', 'over', { limit_id: 'members', limit: 15, used: 18 }), 'ignored');
    expect(failure.status).toBe(402);
    expect(failure.quota).toEqual({ limit_id: 'members', limit: 15, used: 18 });
    expect(failure.title).toBe('Over a limit (402 · sponsor_quota_exceeded)');
  });

  it('reads an unreachable pricing service as a 503 that is only a warning', () => {
    const failure = describeAdminFailure(new PricingUnavailableError('SPACE did not answer'), 'ignored');
    expect(failure.status).toBe(503);
    expect(failure.tone).toBe('warning');
    expect(failure.code).toBe('pricing_unavailable');
    expect(failure.text).toMatch(/Nothing was changed/);
  });

  it('falls back to what was being done for anything else', () => {
    const failure = describeAdminFailure(new Error('boom'), 'The accounts couldn’t be loaded');
    expect(failure.status).toBeNull();
    expect(failure.title).toBe('The accounts couldn’t be loaded');
    expect(failure.text).toBe('boom');
  });
});

describe('the pricing catalog, read for contracts', () => {
  it('lists the plans, their limits and the add-ons that apply to them', () => {
    const read = catalog();
    expect(read.version).toBe('0.1.0');
    expect(read.plans.map((plan) => plan.id)).toEqual(['BASIC', 'ADVANCED', 'RESEARCH', 'PRO']);
    expect(read.plans.find((plan) => plan.id === 'BASIC')?.byAgreement).toBe(false);
    expect(read.plans.find((plan) => plan.id === 'PRO')?.byAgreement).toBe(true);
    expect(read.plans.find((plan) => plan.id === 'BASIC')?.limits.taskStarts).toBe(10);
    expect(read.plans.find((plan) => plan.id === 'PRO')?.limits.taskStarts).toBeNull();
    const compute = read.addOns.find((addOn) => addOn.id === 'COMPUTE_PACK');
    expect(compute).toMatchObject({ name: 'Compute pack', plans: ['ADVANCED', 'PRO'], min: 1, max: 10, step: 1 });
    expect(compute?.extensions.taskStarts).toBe(100);
    expect(read.limitIds[0]).toBe('taskStarts');
  });

  it('is nothing when the document has no plans', () => {
    expect(readContractCatalog({})).toBeNull();
  });

  it('adds what each add-on brings to the plan’s limits, and leaves an unlimited one unlimited', () => {
    const read = catalog();
    expect(limitsOf(read, 'ADVANCED', {}).taskStarts).toBe(25);
    expect(limitsOf(read, 'ADVANCED', { COMPUTE_PACK: 2 }).taskStarts).toBe(225);
    expect(limitsOf(read, 'ADVANCED', { COMPUTE_PACK: 2 }).solverSeconds).toBe(18000 + 2 * 7200);
    expect(limitsOf(read, 'PRO', { COMPUTE_PACK: 2 }).taskStarts).toBeNull();
  });

  it('finds what is wrong with an agreement before the gateway does', () => {
    const read = catalog();
    expect(agreementIssues(read, 'ADVANCED', { COMPUTE_PACK: 3 })).toEqual([]);
    expect(agreementIssues(read, 'BASIC', { COMPUTE_PACK: 1 })).toEqual(['Compute pack isn’t available for BASIC.']);
    expect(agreementIssues(read, 'ADVANCED', { COMPUTE_PACK: 11 })).toEqual(['Compute pack must be 1–10 in steps of 1.']);
    expect(agreementIssues(read, 'NOPE', {})).toEqual(['Choose a plan from the active pricing.']);
    expect(agreementIssues(read, 'ADVANCED', { COMPUTE_PACK: 0 })).toEqual([]);
  });

  it('compares limits before and after, with the direction each one moves', () => {
    const read = catalog();
    const up = compareLimits(read, limitsOf(read, 'BASIC', {}), limitsOf(read, 'PRO', {}));
    const solves = up.find((row) => row.id === 'taskStarts');
    expect(solves).toMatchObject({ label: 'Solves', direction: 'up' });
    expect(solves?.before.text).toBe('10');
    expect(solves?.after.text).toBe('Unlimited');
    const down = compareLimits(read, limitsOf(read, 'ADVANCED', {}), limitsOf(read, 'BASIC', {}));
    expect(down.find((row) => row.id === 'taskStarts')?.direction).toBe('down');
    expect(compareLimits(read, limitsOf(read, 'BASIC', {}), limitsOf(read, 'BASIC', {})).every((row) => row.direction === 'same')).toBe(true);
  });
});

describe('audit events in words', () => {
  it('groups actions into the kinds an administrator looks for', () => {
    expect(auditFamily('contract.subscription.changed')).toBe('contract');
    expect(auditFamily('pricing.live.activated')).toBe('pricing');
    expect(auditFamily('maintenance.expired.purged')).toBe('maintenance');
    expect(auditFamily('organization.sponsor_transferred')).toBe('other');
  });

  it('describes a contract change with its before and after', () => {
    const view = describeAuditEvent(AUDIT.events[2]);
    expect(view.text).toBe('Agreement changed from BASIC to RESEARCH (no add-ons).');
    expect(view.before).toBe('BASIC · no add-ons');
    expect(view.after).toBe('RESEARCH · no add-ons');
    expect(view.facts).toEqual([['Reason', 'Institutional agreement'], ['Detail', 'Agreement 2026-14'], ['Pricing version', '0.1.0']]);
  });

  it('describes add-ons in a contract change', () => {
    const view = describeAuditEvent({
      ...AUDIT.events[2],
      detail: { previous: { plan: 'ADVANCED', addOns: {} }, current: { plan: 'ADVANCED', addOns: { COMPUTE_PACK: 2 } } },
    });
    expect(view.after).toBe('ADVANCED · compute pack ×2');
  });

  it('describes the maintenance and pricing events the gateway writes', () => {
    expect(describeAuditEvent(AUDIT.events[0]).text).toBe('2 abandoned jobs were reconciled.');
    expect(describeAuditEvent({ ...AUDIT.events[0], detail: { settled: 1 } }).text).toBe('1 abandoned job was reconciled.');
    expect(describeAuditEvent({ ...AUDIT.events[0], action: 'maintenance.expired.purged', detail: { terminalJobs: 4, expiredApiKeys: 1 } }).facts)
      .toEqual([['Expired api keys', '1'], ['Terminal jobs', '4']]);
    expect(describeAuditEvent(AUDIT.events[1]).text).toBe('Pricing live activated: 0.1.0.');
  });

  it('copes with an event it has never seen and with a detail that is not what it expects', () => {
    const view = describeAuditEvent({ ...AUDIT.events[0], action: 'something.new_happened', detail: { previous: 'nonsense' } });
    expect(view.text).toBe('Something new happened.');
    expect(describeAuditEvent({ ...AUDIT.events[2], detail: { previous: 4, current: [] } }).text).toBe('Agreement changed from an earlier plan to a new plan (no add-ons).');
  });
});

describe('error events', () => {
  it('reads either spelling of every field', () => {
    const row = readErrorEvent(ERROR_EVENTS[0]);
    expect(row).toMatchObject({ status: 402, code: 'quota_exceeded', endpoint: '/v1/jobs', method: 'POST', userId: SAM.id, userEmail: SAM.email });
    const snake = readErrorEvent({ ...ERROR_EVENTS[0], statusCode: undefined as never, errorCode: undefined as never, httpMethod: undefined as never, userId: undefined, userEmail: undefined, createdAt: undefined as never });
    expect(snake).toMatchObject({ status: 402, code: 'quota_exceeded', method: 'POST', userId: SAM.id, userEmail: SAM.email });
  });

  it('groups events by status and code, busiest first', () => {
    const groups = groupErrors(ERROR_EVENTS.map(readErrorEvent));
    expect(groups.map((group) => [group.status, group.code, group.events.length])).toEqual([
      [402, 'quota_exceeded', 2], [429, 'concurrency_limit_exceeded', 1], [503, 'pricing_unavailable', 1],
    ]);
    expect(groups[0].lastSeen).toBe('2026-10-09T07:40:00Z');
  });

  it('explains a code, and falls back to its status for one it does not know', () => {
    expect(errorMeaning('quota_exceeded', 402)).toMatch(/allowance ran out/);
    expect(errorMeaning('mystery', 500)).toMatch(/worth a look/);
    expect(errorMeaning('mystery', 429)).toBe('Too many requests at once.');
    expect(errorMeaning('mystery', 418)).toBe('The gateway refused the request.');
  });

  it('colours a status by how much it deserves a look', () => {
    expect(statusTone(503)).toBe('error');
    expect(statusTone(402)).toBe('warning');
    expect(statusTone(404)).toBe('plain');
  });
});

describe('small formatters', () => {
  const now = Date.parse('2026-10-09T12:00:00Z');
  const before = (seconds: number) => new Date(now - seconds * 1000).toISOString();

  it('says how long ago in the nearest sensible unit', () => {
    expect(ageLabel(before(30), now)).toBe('30 s');
    expect(ageLabel(before(90), now)).toBe('2 min');
    expect(ageLabel(before(3 * 3600), now)).toBe('about 3 h');
    expect(ageLabel(before(26 * 3600), now)).toBe('about 1 day');
    expect(ageLabel(before(2 * 86400), now)).toBe('about 2 days');
    expect(ageLabel('not a date', now)).toBe('—');
    expect(ageLabel(null, now)).toBe('—');
  });

  it('shortens an id for a list and leaves a short one alone', () => {
    expect(shortId(SAM.id)).toBe('00000000…');
    expect(shortId('abc')).toBe('abc');
    expect(shortId(null)).toBe('—');
  });

  it('picks a tone for a plan', () => {
    expect(planTone('PRO')).toBe('dark');
    expect(planTone('RESEARCH')).toBe('info');
    expect(planTone('BASIC')).toBe('plain');
  });
});
