import { describe, expect, it } from 'vitest';
import { QuotaError } from '../../api/auth';
import { HttpError } from '../../api/client';
import { reportRefusal } from './reportErrors';

const refused = (status: number, code: string, message = 'refused') => Object.assign(new HttpError(status, message), { code });

describe('what a refusal of the report endpoints means', () => {
  it('tells apart why a save, a freeze or a publication was refused (409)', () => {
    expect(reportRefusal(refused(409, 'draft_conflict'), 'save')).toMatchObject({ kind: 'conflict', title: 'Someone saved a newer draft revision (409 · draft_conflict)' });
    expect(reportRefusal(refused(409, 'report_frozen'), 'save')).toMatchObject({ kind: 'terminal', title: 'This edition is frozen (409 · report_frozen)' });
    expect(reportRefusal(refused(409, 'report_not_frozen'), 'publish').title).toBe('Only frozen editions can be published (409 · report_not_frozen)');
    expect(reportRefusal(refused(409, 'publication_conflict'), 'publish').kind).toBe('conflict');
    expect(reportRefusal(refused(409, 'report_history_retained'), 'delete')).toMatchObject({ kind: 'terminal', text: expect.stringContaining('Editions stay citable') });
    expect(reportRefusal(refused(409, 'slug_conflict'), 'create').text).toContain('Nothing was created.');
  });

  it('says what a frozen report is missing (422)', () => {
    const incomplete = reportRefusal(refused(422, 'incomplete_provenance'), 'freeze');
    expect(incomplete.title).toBe('The provenance isn’t complete (422 · incomplete_provenance)');
    expect(incomplete.text).toContain('study, datasets, software, BIM version, engine revisions and parameters');
    expect(incomplete.text).toContain('Nothing was frozen.');
    expect(reportRefusal(refused(422, 'nonterminal_evidence'), 'freeze').kind).toBe('terminal');
    expect(reportRefusal(refused(422, 'evidence_digest_mismatch'), 'freeze').kind).toBe('conflict');
  });

  it('says what stops a report from being public (422)', () => {
    expect(reportRefusal(refused(422, 'private_evidence', 'Job evidence must belong to a public project before report publication.'), 'publish')).toMatchObject({
      kind: 'incompatible', title: 'Some of the evidence is private (422 · private_evidence)', text: expect.stringContaining('Job evidence must belong to a public project'),
    });
    expect(reportRefusal(refused(422, 'private_engine_dependency'), 'publish').title).toContain('engine');
    expect(reportRefusal(refused(422, 'private_dependency'), 'publish').kind).toBe('incompatible');
  });

  it('names the role an action needs', () => {
    expect(reportRefusal(refused(403, 'forbidden'), 'publish').text).toContain('needs ADMIN');
    expect(reportRefusal(refused(403, 'forbidden'), 'save').text).toContain('needs MEMBER');
    expect(reportRefusal(refused(403, 'api_key_boundary', 'The API key boundary excludes this resource'), 'create')).toMatchObject({ kind: 'key', permission: 'reports:write' });
  });

  it('reads a quota, a missing report, a session and a service that does not answer', () => {
    const quota = new QuotaError('quota_exceeded', 'No storage left.', { limit_id: 'storageBytes', limit: 10, used: 10 });
    expect(reportRefusal(quota, 'create')).toMatchObject({ kind: 'quota', limitId: 'storageBytes' });
    expect(reportRefusal(refused(404, 'not_found'), 'load').kind).toBe('not-found');
    expect(reportRefusal(refused(401, 'unauthorized'), 'save').kind).toBe('session');
    expect(reportRefusal(refused(503, 'x'), 'publish').kind).toBe('unavailable');
    expect(reportRefusal(new TypeError('Failed to fetch'), 'publish')).toMatchObject({ kind: 'unavailable', title: 'OpenBinding couldn’t be reached' });
  });
});
