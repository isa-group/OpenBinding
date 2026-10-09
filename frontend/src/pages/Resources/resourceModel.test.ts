import { describe, expect, it } from 'vitest';
import { blobOf, digestOf, usageOf } from './fixtures';
import {
  allowanceOf, belongsInLibrary, downloadName, fileTitle, GATEWAY_BLOB_LIMIT, isZipFile, plural, resourceKindLabel, totalBytes, typeLabel, uploadCeiling,
} from './resourceModel';

const tracked = (id: string, limit: number, used: number) => ({ limit_id: id, limit, used, remaining: limit - used });

describe('allowanceOf', () => {
  it('does not show the sponsor’s figures to someone who is not the sponsor', () => {
    expect(allowanceOf(usageOf(), 'storageBytes', false)).toEqual({ known: false, limit: null, used: null });
  });

  it('knows nothing when the usage could not be read', () => {
    expect(allowanceOf(null, 'storageBytes', true)).toEqual({ known: false, limit: null, used: null });
    expect(allowanceOf(undefined, 'collections', true).known).toBe(false);
  });

  it('prefers what the gateway tracks, with what has been used', () => {
    const usage = usageOf({ limits: { collections: tracked('collections', 50, 12) } });
    expect(allowanceOf(usage, 'collections', true)).toEqual({ known: true, limit: 50, used: 12 });
  });

  it('falls back to the plan’s ceiling when nothing is tracked, without inventing a use', () => {
    expect(allowanceOf(usageOf(), 'storageBytes', true)).toEqual({ known: true, limit: 5_368_709_120, used: null });
  });

  it('reads a missing or infinite ceiling as unlimited', () => {
    const usage = usageOf({ capabilities: { collections: null } });
    expect(allowanceOf(usage, 'collections', true)).toEqual({ known: true, limit: null, used: null });
    expect(allowanceOf(usage, 'storageBytes', true)).toEqual({ known: true, limit: null, used: null });
  });
});

describe('uploadCeiling', () => {
  it('uses the plan’s per-request ceiling from the usage', () => {
    expect(uploadCeiling(usageOf({ capabilities: { maxPayloadBytes: 8 * 1024 * 1024 } }), null, 'BASIC')).toEqual({ plan: 8_388_608, effective: 8_388_608, clamped: false });
  });

  it('never goes above what the gateway takes, and says the plan allows more', () => {
    const ceiling = uploadCeiling(usageOf({ capabilities: { maxPayloadBytes: 2 * GATEWAY_BLOB_LIMIT } }), null, 'PRO');
    expect(ceiling).toEqual({ plan: 2 * GATEWAY_BLOB_LIMIT, effective: GATEWAY_BLOB_LIMIT, clamped: true });
  });

  it('reads the pricing document when the usage has no ceiling', () => {
    const catalog = { plans: { BASIC: { usageLimits: { maxPayloadBytes: { value: 4_194_304 } } } } };
    expect(uploadCeiling(usageOf({ plan: 'BASIC', capabilities: {} }), catalog, undefined).effective).toBe(4_194_304);
  });

  it('is the gateway’s own limit when the plan’s is not known', () => {
    expect(uploadCeiling(null, null, undefined)).toEqual({ plan: null, effective: GATEWAY_BLOB_LIMIT, clamped: false });
  });
});

describe('files', () => {
  it('names a media type the way a person would', () => {
    expect(typeLabel('application/zip')).toBe('ZIP archive');
    expect(typeLabel('application/x-zip-compressed')).toBe('ZIP archive');
    expect(typeLabel('text/csv')).toBe('CSV');
    expect(typeLabel('application/json')).toBe('JSON');
    expect(typeLabel('application/octet-stream')).toBe('Binary');
    expect(typeLabel('model/gltf+binary')).toBe('model/gltf+binary');
  });

  it('titles a file by the name it had here, else by its type and the start of its fingerprint', () => {
    const blob = blobOf('a');
    expect(fileTitle(blob, {})).toBe('ZIP archive · sha256-aaaa…aaaa');
    expect(fileTitle(blob, { [blob.digest]: 'results.zip' })).toBe('results.zip');
  });

  it('saves a download under its name, or under its fingerprint with a fitting extension', () => {
    expect(downloadName(blobOf('a'), { [digestOf('a')]: 'results.zip' })).toBe('results.zip');
    expect(downloadName(blobOf('a'), {})).toBe('sha256-aaaaaaaaaaaa.zip');
    expect(downloadName(blobOf('b', { media_type: 'text/csv' }), {})).toBe('sha256-bbbbbbbbbbbb.csv');
    expect(downloadName(blobOf('c', { media_type: 'application/octet-stream' }), {})).toBe('sha256-cccccccccccc');
  });

  it('recognises a ZIP and adds up sizes', () => {
    expect(isZipFile(blobOf('a'))).toBe(true);
    expect(isZipFile(blobOf('a', { media_type: 'text/csv' }))).toBe(false);
    expect(totalBytes([blobOf('a', { size_bytes: 10 }), blobOf('b', { size_bytes: 32 })])).toBe(42);
    expect(totalBytes([])).toBe(0);
  });
});

describe('resources', () => {
  it('knows which kinds the library owns', () => {
    expect(belongsInLibrary('CandidateCatalog')).toBe(true);
    expect(belongsInLibrary('Study')).toBe(true);
    expect(belongsInLibrary('Dataset')).toBe(false);
    expect(belongsInLibrary('bim-resource')).toBe(false);
  });

  it('names kinds in words and leaves unknown ones as written', () => {
    expect(resourceKindLabel('bim-resource')).toBe('Resource');
    expect(resourceKindLabel('Optimization')).toBe('Goal');
    expect(resourceKindLabel('ConstraintSet')).toBe('Rules');
    expect(resourceKindLabel('Dataset')).toBe('Dataset');
    expect(resourceKindLabel('lab-notes')).toBe('lab-notes');
  });

  it('counts with the right noun', () => {
    expect(plural(1, 'item')).toBe('1 item');
    expect(plural(0, 'item')).toBe('0 items');
    expect(plural(2, 'case revision')).toBe('2 case revisions');
  });
});
