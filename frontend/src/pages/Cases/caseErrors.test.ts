import { describe, expect, it } from 'vitest';
import { HttpError } from '../../api/client';
import { composeRefusal } from './caseErrors';

const refused = (status: number, code: string, message = 'refused', extra: Partial<HttpError> = {}) => Object.assign(new HttpError(status, message), { code }, extra);

describe('why the gateway refuses to compose a revision', () => {
  it('422 snapshot_not_recompilable says the snapshot is kept as evidence, can’t run, and the source must be corrected and uploaded again', () => {
    const issue = composeRefusal(refused(422, 'snapshot_not_recompilable', 'This snapshot was compiled by another bim-toolchain release'));

    expect(issue.source).toBe('gateway');
    expect(issue.title).toBe('This snapshot can’t be run (422 · snapshot_not_recompilable)');
    expect(issue.text).toContain('kept unchanged as evidence');
    expect(issue.text).toContain('can’t be recompiled or run');
    expect(issue.text).toContain('Correct the source and upload it again');
    expect(issue.text).toContain('Nothing was created.');
    expect(issue.action).toBeUndefined();
  });

  it('is not told as a missing dialect: installing one would not help', () => {
    const issue = composeRefusal(refused(422, 'snapshot_not_recompilable'));
    expect(issue.title).not.toMatch(/dialect/i);
    expect(issue.action).toBeUndefined();
    expect(composeRefusal(refused(422, 'contract_not_installed')).action).toEqual({ kind: 'dialects', label: 'See installed dialects' });
  });

  it('lists the findings the gateway attached, without repeating its own sentence', () => {
    const issue = composeRefusal(refused(422, 'snapshot_not_recompilable', 'not recompilable', {
      diagnostics: [
        { code: 'invalid_instance', message: 'not recompilable', pointer: '/spec' },
        { code: 'invalid_instance', message: 'Instance is not valid', pointer: '/spec/candidates' },
      ],
    }));
    expect(issue.details).toEqual(['Instance is not valid (/spec/candidates)']);
  });

  it('keeps the other refusals as they were', () => {
    expect(composeRefusal(refused(422, 'missing_dependency')).title).toBe('A part is missing (422 · missing_dependency)');
    expect(composeRefusal(refused(404, 'not_found')).title).toBe('A version can’t be reached (404 · not_found)');
    expect(composeRefusal(refused(403, 'forbidden')).title).toBe('This credential can’t create revisions here (403 · forbidden)');
  });
});
