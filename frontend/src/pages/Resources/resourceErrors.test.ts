import { describe, expect, it } from 'vitest';
import { PricingUnavailableError, QuotaError } from '../../api/auth';
import { HttpError } from '../../api/client';
import {
  classifyAuthError, collectionCreateRefusal, collectionDeleteRefusal, collectionRenameRefusal, collectionSaveRefusal, deleteFileRefusal, downloadRefusal,
  filesListRefusal, isMissing, oversizeRefusal, resourceCreateRefusal, resourceDeleteRefusal, resourceRevisionRefusal, resourceUpdateRefusal, uploadRefusal,
} from './resourceErrors';

const http = (status: number, code?: string, text = 'refused', extra: Record<string, unknown> = {}) => Object.assign(new HttpError(status, text), code ? { code } : {}, extra);

describe('isMissing', () => {
  it('reads a 404 as missing and nothing else', () => {
    expect(isMissing(classifyAuthError(http(404, 'not_found')))).toBe(true);
    expect(isMissing(classifyAuthError(http(403, 'forbidden')))).toBe(false);
    expect(isMissing(null)).toBe(false);
  });
});

describe('uploading a file', () => {
  it('says the sponsor’s storage is full (402) with the figures the gateway gave', () => {
    const refusal = uploadRefusal(new QuotaError('storage_quota_exceeded', 'full', { limit_id: 'storageBytes', limit: 1_073_741_824, used: 1_073_741_824 }), {});
    expect(refusal.kind).toBe('quota');
    expect(refusal.text).toBe('No storage left for the sponsor (402 · storage_quota_exceeded). 1 GiB of 1 GiB used. This limit doesn’t renew; delete files or ask for more room. Nothing was stored.');
  });

  it('says a 402 without figures without making any up', () => {
    expect(uploadRefusal(new QuotaError('storage_quota_exceeded', 'full'), {}).text).toBe('No storage left for the sponsor (402 · storage_quota_exceeded). This limit doesn’t renew; delete files or ask for more room. Nothing was stored.');
  });

  it('says a file is over the per-request ceiling (413), with the plan when it is known', () => {
    expect(uploadRefusal(http(413, 'artifact_too_large'), { ceiling: 8_388_608, plan: 'BASIC' })).toEqual({
      kind: 'too-large', text: 'That file is bigger than your plan allows per upload (8 MiB on the BASIC plan) (413 · artifact_too_large). Nothing was stored.',
    });
    expect(uploadRefusal(http(413, 'artifact_too_large'), {}).text).toBe('That file is bigger than your plan allows per upload (413 · artifact_too_large). Nothing was stored.');
  });

  it('turns a refusal of the credential into a read-only state', () => {
    expect(uploadRefusal(http(403, 'forbidden'), {})).toEqual({ kind: 'key', text: 'This account or API key can’t write files (403 · forbidden). You can still list and download.' });
  });

  it('says when limits cannot be checked, and nothing was stored', () => {
    const refusal = uploadRefusal(new PricingUnavailableError('SPACE is down'), {});
    expect(refusal.kind).toBe('pricing');
    expect(refusal.text).toBe('Limits can’t be checked right now (503 · pricing_unavailable). Nothing was stored.');
  });

  it('tells a missing project, a refused file and a lost connection apart', () => {
    expect(uploadRefusal(http(404, 'not_found'), {}).kind).toBe('gone');
    expect(uploadRefusal(http(422), {}).kind).toBe('invalid');
    expect(uploadRefusal(new TypeError('Failed to fetch'), {}).text).toBe('OpenBinding couldn’t be reached, so nothing was stored. Check your connection and try again.');
  });

  it('rules out a file before it is sent, in the same words minus a status the gateway never gave', () => {
    expect(oversizeRefusal('big.zip', 200 * 1024 * 1024, 128 * 1024 * 1024, 'RESEARCH')).toEqual({
      kind: 'too-large', text: '“big.zip” is 200 MiB, more than your plan allows per upload (128 MiB on the RESEARCH plan). Nothing was stored.',
    });
    expect(oversizeRefusal('big.zip', 2048, 1024).text).toBe('“big.zip” is 2 KiB, more than your plan allows per upload (1 KiB). Nothing was stored.');
  });
});

describe('the other things done with a file', () => {
  it('explains a file that cannot be deleted because something sealed uses it', () => {
    expect(deleteFileRefusal(http(409, 'in_use'), 'results.csv')).toEqual({ kind: 'in-use', text: '“results.csv” is used by a sealed version, so it can’t be deleted (409 · in_use).' });
  });

  it('names the role a deletion needs, and a file that is already gone', () => {
    expect(deleteFileRefusal(http(403), 'a').text).toBe('You need ADMIN in the organization to delete files (403). Nothing was deleted.');
    expect(deleteFileRefusal(http(404, 'not_found'), 'a').kind).toBe('gone');
    expect(deleteFileRefusal(http(503, 'unavailable'), 'a').text).toBe('A service OpenBinding depends on isn’t answering (503 · unavailable), so nothing was deleted. Try again in a moment.');
  });

  it('says why a download failed', () => {
    expect(downloadRefusal(http(404, 'not_found'), 'a.zip').text).toBe('“a.zip” can’t be found any more (404 · not_found). Its bytes may have been removed.');
    expect(downloadRefusal(http(403), 'a.zip').kind).toBe('forbidden');
  });

  it('says why the list cannot be read', () => {
    expect(filesListRefusal(classifyAuthError(http(403, 'forbidden'))).text).toBe('This account or API key can’t list this project’s files (403 · forbidden).');
    expect(filesListRefusal(classifyAuthError(http(503, 'unavailable'))).text).toBe('The files couldn’t be loaded (503 · unavailable).');
  });
});

describe('resources', () => {
  it('says the address is taken anywhere in the organization (409)', () => {
    expect(resourceCreateRefusal(http(409, 'slug_conflict'))).toEqual({ kind: 'address', text: 'That address is already used by another item in this organization (409 · slug_conflict).' });
  });

  it('names the role, the missing project and the invalid input for a new resource', () => {
    expect(resourceCreateRefusal(http(422)).kind).toBe('invalid');
    expect(resourceCreateRefusal(http(403)).text).toBe('You need MEMBER in the organization to create a resource (403). Nothing was created.');
    expect(resourceCreateRefusal(http(404, 'not_found')).kind).toBe('gone');
  });

  it('names what editing and deleting need', () => {
    expect(resourceUpdateRefusal(http(403)).text).toBe('You need MEMBER in the organization to edit a resource (403). Nothing changed.');
    expect(resourceUpdateRefusal(http(404)).kind).toBe('gone');
    expect(resourceDeleteRefusal(http(403)).text).toBe('You need ADMIN in the organization to delete a resource (403). Nothing was deleted.');
    expect(resourceDeleteRefusal(http(409, 'x')).kind).toBe('in-use');
  });

  it('says what went wrong with a revision', () => {
    expect(resourceRevisionRefusal(http(422, undefined, 'Unprocessable Entity')).text).toBe('The gateway refused this content (422). Nothing was saved.');
    expect(resourceRevisionRefusal(http(422, 'bad', 'Document must be an object.')).text).toBe('The gateway refused this content (422 · bad). Nothing was saved. Document must be an object.');
    expect(resourceRevisionRefusal(http(404, 'not_found')).text).toBe('The resource no longer exists in this project (404 · not_found). Nothing was saved.');
    expect(resourceRevisionRefusal(http(403)).kind).toBe('forbidden');
  });
});

describe('collections', () => {
  it('says the sponsor has no collections left (402), with the figures', () => {
    const refusal = collectionCreateRefusal(new QuotaError('sponsor_quota_exceeded', 'full', { limit_id: 'collections', limit: 50, used: 51 }));
    expect(refusal.kind).toBe('quota');
    expect(refusal.text).toBe('The sponsor has no collections left (402 · sponsor_quota_exceeded). 51 of 50 collections are used. Delete one you don’t need, or ask for more room. Nothing was created.');
  });

  it('says the address is taken (409), and that limits cannot be checked', () => {
    expect(collectionCreateRefusal(http(409, 'slug_conflict')).text).toBe('That address is already used by another collection in this organization (409 · slug_conflict).');
    expect(collectionCreateRefusal(new PricingUnavailableError('down')).kind).toBe('pricing');
    expect(collectionCreateRefusal(http(422)).kind).toBe('invalid');
    expect(collectionCreateRefusal(http(403)).kind).toBe('forbidden');
  });

  it('names what renaming and deleting need', () => {
    expect(collectionRenameRefusal(http(403)).text).toBe('You need MEMBER in the organization to edit a collection (403). Nothing changed.');
    expect(collectionRenameRefusal(http(404)).kind).toBe('gone');
    expect(collectionDeleteRefusal(http(403)).text).toBe('You need ADMIN in the organization to delete a collection (403). Nothing was deleted.');
  });

  describe('saving a revision', () => {
    it('tells a fingerprint that no longer matches (422)', () => {
      const refusal = collectionSaveRefusal(http(422, 'collection_target_mismatch'));
      expect(refusal.kind).toBe('fingerprint');
      expect(refusal.text).toContain('An item’s fingerprint isn’t valid any more (422 · collection_target_mismatch)');
    });

    it('tells an item that names no exact revision, and one the gateway cannot pin', () => {
      expect(collectionSaveRefusal(http(422, 'invalid_collection_target')).kind).toBe('target');
      expect(collectionSaveRefusal(http(422, 'unsupported_collection_target')).text).toContain('Only case revisions and resource versions can be pinned');
    });

    it('tells a repeated item from the validation body, which has no machine code', () => {
      const refusal = collectionSaveRefusal(http(422, undefined, 'Unprocessable Entity', { problem: { detail: [{ msg: 'Value error, a collection revision cannot repeat a target' }] } }));
      expect(refusal).toEqual({ kind: 'duplicate', text: 'An item appears twice (422): a revision can’t repeat a target. Remove the duplicate. Nothing was saved.' });
    });

    it('keeps the gateway’s own words for a refusal it does not know', () => {
      expect(collectionSaveRefusal(http(422, undefined, 'Too many items.')).text).toBe('The gateway refused this list (422). Too many items. Nothing was saved.');
      expect(collectionSaveRefusal(http(422, undefined, 'Unprocessable Entity')).text).toBe('The gateway refused this list (422). Nothing was saved.');
    });

    it('names a credential that cannot write, a collection that is gone and a service that is down', () => {
      expect(collectionSaveRefusal(http(403, 'forbidden')).text).toBe('This account or API key can’t write collections (403 · forbidden). Nothing was saved.');
      expect(collectionSaveRefusal(http(404, 'not_found')).text).toBe('The collection no longer exists in this project (404 · not_found). Nothing was saved.');
      expect(collectionSaveRefusal(http(503, 'unavailable')).text).toBe('A service OpenBinding depends on isn’t answering (503 · unavailable), so nothing was saved. Try again in a moment.');
    });
  });
});
