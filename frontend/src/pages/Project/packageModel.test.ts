import JSZip from 'jszip';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  compareWithProject, countRows, detectFormat, humanizeCount, inspectPackage, packageFileName, packageImportCounts,
} from './packageModel';
import { CASE_DIGESTS, FILE_TEXT, fileDigest, samplePackage } from './packageFixture';
import { ensureSubtleCrypto } from './testKit';

beforeAll(ensureSubtleCrypto);

const jsonFile = (pkg: unknown, name = 'qos.openbinding.json') => new File([JSON.stringify(pkg)], name, { type: 'application/json' });

async function zipFile(pkg: Record<string, unknown>, files: Record<string, string> = {}, name = 'qos.openbinding.zip') {
  const zip = new JSZip();
  zip.file('package.json', JSON.stringify(pkg));
  for (const [path, text] of Object.entries(files)) zip.file(path, text);
  return new File([await zip.generateAsync({ type: 'arraybuffer' })], name, { type: 'application/zip' });
}

describe('inspecting a package before it is sent', () => {
  it('checks every fingerprint it can recompute and leaves the rest to the gateway', async () => {
    const inspection = await inspectPackage(jsonFile(await samplePackage()));

    expect(inspection.format).toBe('json');
    expect(inspection.readable).toBe(true);
    expect(inspection.problem).toBeUndefined();
    expect(inspection.rows.map((row) => [row.kind, row.outcome])).toEqual([
      ['Manifest', 'verified'],
      ['Case revision', 'later'],
      ['Case revision', 'later'],
      ['Frozen report', 'verified'],
      ['File · text/plain', 'verified'],
    ]);
    expect(countRows(inspection.rows)).toEqual({ verified: 3, reused: 0, added: 0, later: 2 });
    expect(inspection.cases).toEqual([{
      slug: 'flujo', name: 'Flujo de checkout',
      revisions: [{ revision: 1, digest: CASE_DIGESTS[0] }, { revision: 2, digest: CASE_DIGESTS[1] }],
    }]);
  });

  it('refuses a package whose manifest changed after it was sealed', async () => {
    const inspection = await inspectPackage(jsonFile(await samplePackage({ tamperAfterSealing: true })));

    expect(inspection.problem).toMatchObject({ kind: 'fingerprint', title: 'Fingerprint doesn’t match' });
    expect(inspection.problem?.text).toContain('“Package manifest” says');
    expect(inspection.rows[0].outcome).toBe('mismatch');
  });

  it('names the file whose bytes do not hash to the digest it declares', async () => {
    const inspection = await inspectPackage(jsonFile(await samplePackage({ corruptFile: true })));

    expect(inspection.rows.find((row) => row.kind.startsWith('File'))?.outcome).toBe('mismatch');
    expect(inspection.problem?.kind).toBe('fingerprint');
    expect(inspection.problem?.text).toContain(`says ${(await fileDigest()).slice(0, 11)}…`);
  });

  it('reads a ZIP, taking each file from its path', async () => {
    const digest = await fileDigest();
    const inspection = await inspectPackage(await zipFile(await samplePackage({ fileByPath: true }), { [`artifacts/${digest}`]: FILE_TEXT }));

    expect(inspection.format).toBe('zip');
    expect(inspection.problem).toBeUndefined();
    expect(inspection.rows.find((row) => row.kind.startsWith('File'))?.outcome).toBe('verified');
  });

  it('says a file is missing from a ZIP rather than calling it verified', async () => {
    const inspection = await inspectPackage(await zipFile(await samplePackage({ fileByPath: true })));

    expect(inspection.problem).toMatchObject({ kind: 'fingerprint', title: 'A file is missing' });
  });

  it('refuses what is not an OpenBinding package', async () => {
    expect((await inspectPackage(jsonFile(await samplePackage({ apiVersion: 'openbinding.dev/package/v9' })))).problem?.kind).toBe('unsupported');
    expect((await inspectPackage(new File(['{ not json'], 'x.json', { type: 'application/json' }))).problem?.kind).toBe('unreadable');
    const empty = new JSZip();
    empty.file('readme.txt', 'hello');
    const emptyZip = new File([await empty.generateAsync({ type: 'arraybuffer' })], 'x.zip', { type: 'application/zip' });
    expect((await inspectPackage(emptyZip)).problem).toMatchObject({ kind: 'unreadable', title: 'Not an OpenBinding package' });
  });

  it('leaves a YAML package to the gateway: this page has no YAML reader', async () => {
    const inspection = await inspectPackage(new File(['apiVersion: openbinding.dev/package/v1\n'], 'qos.openbinding.yaml', { type: 'application/yaml' }));

    expect(inspection).toMatchObject({ format: 'yaml', readable: false, rows: [] });
    expect(inspection.problem).toBeUndefined();
  });
});

describe('comparing with what the project holds', () => {
  async function inspected() {
    return inspectPackage(jsonFile(await samplePackage()));
  }

  it('reuses a revision with the same fingerprint and adds the rest', async () => {
    const result = compareWithProject(await inspected(), [{ slug: 'flujo', revisions: [{ revision: 1, digest: CASE_DIGESTS[0] }] }]);

    expect(result.problem).toBeUndefined();
    expect(countRows(result.rows)).toMatchObject({ reused: 1, added: 1, later: 0 });
  });

  it('adds everything for a case the project does not have', async () => {
    const result = compareWithProject(await inspected(), []);

    expect(countRows(result.rows)).toMatchObject({ reused: 0, added: 2 });
  });

  it('calls a revision that exists with other content a collision', async () => {
    const result = compareWithProject(await inspected(), [{ slug: 'flujo', revisions: [{ revision: 2, digest: `sha256-${'f'.repeat(64)}` }] }]);

    expect(result.problem).toMatchObject({ kind: 'collision', title: 'Name already used with different content' });
    expect(result.problem?.text).toContain('Flujo de checkout · revision 2');
    expect(result.rows.find((row) => row.outcome === 'collision')?.name).toBe('Flujo de checkout · revision 2');
  });

  it('does not compare a package that is already refused or unreadable', async () => {
    const refused = await inspectPackage(jsonFile(await samplePackage({ tamperAfterSealing: true })));
    expect(compareWithProject(refused, [])).toBe(refused);
  });
});

describe('reading what an import answers', () => {
  it('sums the counts the gateway sends', () => {
    expect(packageImportCounts({ imported: { cases: 1, caseRevisions: 2, reports: 0 }, packageDigest: 'sha256-x' })).toEqual({
      total: 3, parts: [{ id: 'cases', count: 1 }, { id: 'caseRevisions', count: 2 }],
    });
  });

  it('reads the earlier flat shape too, and survives anything else', () => {
    expect(packageImportCounts({ casesCreated: 2, revisionsCreated: 5 }).total).toBe(7);
    expect(packageImportCounts({ imported: 'many' }).total).toBe(0);
    expect(packageImportCounts(null)).toEqual({ total: 0, parts: [] });
    expect(packageImportCounts({ imported: { cases: 'two', studies: Number.NaN } }).total).toBe(0);
  });

  it('words a count', () => {
    expect(humanizeCount('caseRevisions')).toBe('case revisions');
    expect(humanizeCount('studyRuns')).toBe('study runs');
  });
});

describe('formats', () => {
  it('tells ZIP, YAML and JSON apart by the bytes first, then the name', () => {
    expect(detectFormat({ name: 'x.json', type: '' }, new Uint8Array([0x50, 0x4b]))).toBe('zip');
    expect(detectFormat({ name: 'x.YAML', type: '' }, new Uint8Array([0x61, 0x70]))).toBe('yaml');
    expect(detectFormat({ name: 'x.yml', type: '' }, new Uint8Array([0x61, 0x70]))).toBe('yaml');
    expect(detectFormat({ name: 'x', type: 'application/yaml' }, new Uint8Array([0x61, 0x70]))).toBe('yaml');
    expect(detectFormat({ name: 'x.json', type: 'application/json' }, new Uint8Array([0x7b, 0x22]))).toBe('json');
  });

  it('names the file the way the gateway names its ZIP', () => {
    expect(packageFileName('qos-benchmarks', 'zip')).toBe('qos-benchmarks.openbinding.zip');
    expect(packageFileName('qos-benchmarks', 'yaml')).toBe('qos-benchmarks.openbinding.yaml');
  });
});
