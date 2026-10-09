import { computeCanonicalDigest, computeRawSha256 } from '../../utils/canonicalDigest';

/** A small, internally consistent portable package for the tests of the package screen (never shipped to people). */
export const FILE_TEXT = 'artifact bytes of the sample package';
export const REPORT_MARKER = 'REPORT-BODY-MARKER-that-must-never-be-shown';
export const CASE_DIGESTS = [`sha256-${'1'.repeat(64)}`, `sha256-${'2'.repeat(64)}`] as const;

const utf8 = (text: string): ArrayBuffer => {
  const bytes = new TextEncoder().encode(text);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
};

export async function fileDigest(text = FILE_TEXT): Promise<string> {
  return computeRawSha256(utf8(text));
}

export interface SampleOptions {
  /** Keep the file out of the JSON (a ZIP carries it as `artifacts/<digest>`). */
  fileByPath?: boolean;
  /** Change the bytes of the file after its digest was written, and re-seal the manifest: only the file is wrong. */
  corruptFile?: boolean;
  /** Seal the package, then change something: the manifest no longer matches. */
  tamperAfterSealing?: boolean;
  apiVersion?: string;
  /** The address of the case in the package (`flujo` unless said). */
  caseSlug?: string;
  /** Revision 2 of the case carries other content than the one the sample project holds. */
  conflicting?: boolean;
}

export async function samplePackage(options: SampleOptions = {}): Promise<Record<string, unknown>> {
  const document = { title: 'Engine comparison', body: REPORT_MARKER };
  const digest = await fileDigest();
  const pkg: Record<string, unknown> = {
    apiVersion: options.apiVersion ?? 'openbinding.dev/package/v1',
    snapshots: {},
    library: [],
    projectArtifacts: [],
    organization: { slug: 'isa-demo', name: 'ISA Demo Group' },
    project: { slug: 'qos-benchmarks', name: 'QoS Benchmarks', description: 'Reference cases.', visibility: 'private' },
    cases: [{
      id: 'case-1', slug: options.caseSlug ?? 'flujo', name: 'Flujo de checkout', description: '',
      revisions: CASE_DIGESTS.map((value, index) => ({
        id: `rev-${index + 1}`, revision: index + 1, digest: options.conflicting && index === 1 ? `sha256-${'9'.repeat(64)}` : value,
        document: {}, createdAt: null, snapshotId: null, resources: [],
      })),
    }],
    resources: [],
    collections: [],
    studies: [],
    evidenceJobs: [],
    reports: [{ id: 'report-1', studyRunId: null, slug: 'comparativa', title: 'Engine comparison', document, digest: await computeCanonicalDigest(document), state: 'frozen', versionRef: null }],
    publications: [],
    artifacts: [{
      digest, mediaType: 'text/plain', size: FILE_TEXT.length, public: false, expiresAt: null,
      ...(options.fileByPath ? { path: `artifacts/${digest}` } : { contentBase64: btoa(options.corruptFile ? `${FILE_TEXT} (changed)` : FILE_TEXT) }),
    }],
  };
  pkg.packageDigest = await computeCanonicalDigest(pkg);
  if (options.tamperAfterSealing) (pkg.project as Record<string, unknown>).description = 'Changed after export.';
  return pkg;
}
