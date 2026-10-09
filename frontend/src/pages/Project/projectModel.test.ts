import { describe, expect, it } from 'vitest';
import { PricingUnavailableError, QuotaError } from '../../api/auth';
import { HttpError } from '../../api/client';
import {
  accessIn, cellBreakdown, countWord, GATEWAY_PACKAGE_LIMIT, importCeiling, integrityOf, jobStatus, latestRun, planLimit, reportStanding,
  sealedShare, visibilityEffects,
} from './projectModel';
import { createRefusal, deleteRefusal, exportFailure, importRefusal, updateRefusal } from './projectErrors';
import { caseOf, org, reportOf, revisionOf, runOf, studyOf, usageWithProjects } from './testKit';

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
});

describe('what is sealed and what is a draft', () => {
  const first = caseOf('flujo');
  const study = studyOf('engines');

  it('counts case revisions, study runs and frozen reports as sealed, and report drafts as drafts', () => {
    const items = integrityOf({
      cases: [{ item: first, revisions: [revisionOf(first, 1), revisionOf(first, 2)] }],
      studies: [{ study, runs: [runOf(study, 1)] }],
      reports: [reportOf('a', 'frozen'), reportOf('b', 'draft'), reportOf('c', 'draft')],
    });

    expect(items.map((item) => [item.id, item.kind, item.count])).toEqual([['revisions', 'sealed', 2], ['runs', 'sealed', 1], ['frozen', 'sealed', 1], ['drafts', 'draft', 2]]);
    expect(sealedShare(items)).toEqual({ sealed: 4, drafts: 2, sealedPct: 67, draftPct: 33 });
    expect(countWord(items[0])).toBe('case revisions');
    expect(countWord(items[1])).toBe('study run');
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

describe('jobs and reports in words', () => {
  it('says how a job ended, not only that it finished', () => {
    expect(jobStatus('running')).toEqual({ label: 'Running', tone: 'running' });
    expect(jobStatus('queued')).toEqual({ label: 'Queued', tone: 'queued' });
    expect(jobStatus('completed', 'INFEASIBLE')).toEqual({ label: 'No feasible binding', tone: 'warn' });
    expect(jobStatus('completed', 'OPTIMAL')).toEqual({ label: 'Optimal', tone: 'ok' });
    expect(jobStatus('completed', 'FEASIBLE')).toEqual({ label: 'Feasible', tone: 'ok' });
    expect(jobStatus('completed')).toEqual({ label: 'Completed', tone: 'ok' });
    expect(jobStatus('failed')).toEqual({ label: 'Failed', tone: 'bad' });
    expect(jobStatus('cancelled')).toEqual({ label: 'Cancelled', tone: 'off' });
    expect(jobStatus('mystery')).toEqual({ label: 'mystery', tone: 'off' });
  });

  it('tells a draft, a frozen and a published report apart', () => {
    const frozen = reportOf('a', 'frozen');
    expect(reportStanding(reportOf('b', 'draft'), [])).toBe('draft');
    expect(reportStanding(frozen, [])).toBe('frozen');
    expect(reportStanding(frozen, [{ report_id: frozen.id, withdrawn: false } as never])).toBe('published');
    expect(reportStanding(frozen, [{ report_id: frozen.id, withdrawn: true } as never])).toBe('frozen');
  });

  it('words what a visibility change does', () => {
    expect(visibilityEffects('public').changes).toContain('Its card (name, description) appears in Explore');
    expect(visibilityEffects('private').changes).toContain('It counts as a private project for the sponsor');
    expect(visibilityEffects('private').stays).toHaveLength(3);
  });
});

describe('the import ceiling', () => {
  it('takes the plan’s value from the account’s own usage', () => {
    expect(importCeiling(usageWithProjects(), null, 'RESEARCH')).toEqual({ plan: 134_217_728, effective: 134_217_728, clamped: false });
  });

  it('falls back to the pricing document, with the plan’s own value over the default', () => {
    const catalog = { usageLimits: { maxPayloadBytes: { defaultValue: 8_388_608 } }, plans: { BASIC: {}, ADVANCED: { usageLimits: { maxPayloadBytes: { value: 67_108_864 } } } } };
    expect(planLimit(catalog, 'ADVANCED', 'maxPayloadBytes')).toBe(67_108_864);
    expect(planLimit(catalog, 'BASIC', 'maxPayloadBytes')).toBe(8_388_608);
    expect(planLimit(catalog, 'NOPE', 'maxPayloadBytes')).toBe(8_388_608);
    expect(planLimit(null, 'BASIC', 'maxPayloadBytes')).toBeNull();
    expect(importCeiling(null, catalog, 'BASIC')).toEqual({ plan: 8_388_608, effective: 8_388_608, clamped: false });
  });

  it('never promises more than the gateway takes', () => {
    const catalog = { plans: { PRO: { usageLimits: { maxPayloadBytes: { value: 536_870_912 } } } } };
    expect(importCeiling(null, catalog, 'PRO')).toEqual({ plan: 536_870_912, effective: GATEWAY_PACKAGE_LIMIT, clamped: true });
    expect(importCeiling(null, null, 'PRO')).toEqual({ plan: null, effective: GATEWAY_PACKAGE_LIMIT, clamped: false });
  });
});

describe('the gateway’s refusals in words', () => {
  const refusal = (status: number, code: string, message = 'refused') => Object.assign(new HttpError(status, message), { code });

  it('creating', () => {
    const context = { organization: 'ISA', isPrivate: true };
    expect(createRefusal(refusal(409, 'slug_conflict'), context)).toMatchObject({ kind: 'slug', text: 'That address is already used in ISA (409 · slug_conflict).' });
    expect(createRefusal(new QuotaError('sponsor_quota_exceeded', 'x', { limit_id: 'privateProjects', limit: 30, used: 30 }), context))
      .toMatchObject({ kind: 'quota', limitId: 'privateProjects' });
    expect(createRefusal(new QuotaError('sponsor_quota_exceeded', 'x'), { ...context, isPrivate: false })).toMatchObject({ kind: 'quota', limitId: 'projects' });
    expect(createRefusal(new PricingUnavailableError('x'), context).kind).toBe('pricing');
    expect(createRefusal(refusal(403, 'organization_forbidden'), context).kind).toBe('forbidden');
    expect(createRefusal(refusal(404, 'not_found'), context).kind).toBe('gone');
    expect(createRefusal(refusal(422, 'invalid'), context).kind).toBe('invalid');
    expect(createRefusal(new TypeError('Failed to fetch'), context)).toMatchObject({ kind: 'other', text: expect.stringContaining('couldn’t be reached') });
  });

  it('updating', () => {
    expect(updateRefusal(new QuotaError('sponsor_quota_exceeded', 'x'), 'visibility').text).toContain('Nothing changed.');
    expect(updateRefusal(new PricingUnavailableError('x'), 'details').kind).toBe('pricing');
    expect(updateRefusal(refusal(403, 'forbidden'), 'details').kind).toBe('forbidden');
    expect(updateRefusal(refusal(422, 'invalid'), 'visibility').text).toContain('visibility');
  });

  it('deleting', () => {
    expect(deleteRefusal(refusal(409, 'historical_references')).text).toContain('sealed history');
    expect(deleteRefusal(refusal(403, 'forbidden')).kind).toBe('forbidden');
    expect(deleteRefusal(refusal(503, 'unavailable')).text).toContain('nothing was deleted');
  });

  it('importing', () => {
    expect(importRefusal(refusal(413, 'package_too_large')).kind).toBe('too-large');
    expect(importRefusal(refusal(403, 'forbidden')).kind).toBe('forbidden');
    expect(importRefusal(refusal(404, 'not_found')).kind).toBe('gone');
    expect(importRefusal(refusal(409, 'publication_withdrawn')).kind).toBe('unpublished');
    expect(importRefusal(refusal(409, 'run_identity_conflict')).kind).toBe('collision');
    expect(importRefusal(refusal(409, 'toolchain_mismatch')).kind).toBe('engine');
    expect(importRefusal(refusal(422, 'checksum_mismatch')).kind).toBe('fingerprint');
    expect(importRefusal(refusal(422, 'incomplete_artifact_closure', 'The package is missing exact case revisions.')).text).toContain('The package is missing exact case revisions.');
    expect(importRefusal(refusal(503, 'unavailable')).kind).toBe('unavailable');
  });

  it('exporting', () => {
    expect(exportFailure(refusal(403, 'forbidden'))).toContain('can’t read this project');
    expect(exportFailure(refusal(404, 'not_found'))).toContain('no longer exists');
    expect(exportFailure(refusal(409, 'snapshot_integrity', 'Cannot export incomplete or corrupt historical inputs.'))).toContain('Cannot export incomplete');
  });
});
