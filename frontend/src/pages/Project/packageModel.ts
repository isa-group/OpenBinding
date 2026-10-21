import JSZip from 'jszip';
import type { PackageFormat, PackageImportResult } from '../../api/platform';
import { computeCanonicalDigest, computeRawSha256 } from '../../utils/canonicalDigest';
import { shortDigest } from '../../utils/digest';

/** The only package version the gateway reads (`import_project_package`). */
export const PACKAGE_API_VERSION = 'openbinding.dev/package/v1';

export const FORMATS: ReadonlyArray<{ id: PackageFormat; label: string; detail: string; extension: string }> = [
  { id: 'zip', label: 'ZIP archive (recommended)', detail: 'Everything in one compressed file', extension: 'zip' },
  { id: 'json', label: 'Single JSON file', detail: 'For tools that read one document', extension: 'json' },
  { id: 'yaml', label: 'Single YAML file', detail: 'Same content, easier to diff in text tools', extension: 'yaml' },
];

/** `qos-benchmarks.openbinding.zip`: the name the gateway gives the ZIP, and the same for the other two types. */
export function packageFileName(slug: string, format: PackageFormat): string {
  return `${slug}.openbinding.${format}`;
}

export type RowOutcome = 'verified' | 'mismatch' | 'later' | 'reuse' | 'new' | 'collision' | 'missing';

export interface VerificationRow {
  id: string;
  name: string;
  kind: string;
  /** The fingerprint the package declares for it. */
  fingerprint: string | null;
  outcome: RowOutcome;
}

export interface PackageProblem {
  kind: 'unreadable' | 'unsupported' | 'fingerprint' | 'collision';
  title: string;
  text: string;
}

export interface DeclaredCase {
  slug: string;
  name: string;
  revisions: Array<{ revision: number; digest: string }>;
}

export interface PackageInspection {
  fileName: string;
  size: number;
  format: PackageFormat;
  /** The page could open the package and check what it can check. A YAML file is checked by the gateway alone. */
  readable: boolean;
  rows: VerificationRow[];
  cases: DeclaredCase[];
  problem?: PackageProblem;
}

type Dict = Record<string, unknown>;
const isDict = (value: unknown): value is Dict => typeof value === 'object' && value !== null && !Array.isArray(value);
const list = (value: unknown): Dict[] => (Array.isArray(value) ? value.filter(isDict) : []);
const text = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);

async function bytesOf(file: Blob): Promise<ArrayBuffer> {
  if (typeof file.arrayBuffer === 'function') return file.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });
}

function fromBase64(value: string): ArrayBuffer {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

async function digestOfBase64(value: unknown): Promise<string | null> {
  if (typeof value !== 'string') return null;
  try {
    return await computeRawSha256(fromBase64(value));
  } catch {
    return null;
  }
}

/** ZIP, YAML or JSON: by the bytes first (`PK`), then by the name and the type the browser reports. */
export function detectFormat(file: Pick<File, 'name' | 'type'>, head: Uint8Array): PackageFormat {
  if (head[0] === 0x50 && head[1] === 0x4b) return 'zip';
  const name = file.name.toLowerCase();
  if (name.endsWith('.yaml') || name.endsWith('.yml') || file.type.includes('yaml')) return 'yaml';
  return 'json';
}

const row = (id: string, name: string, kind: string, fingerprint: string | null, outcome: RowOutcome): VerificationRow => ({ id, name, kind, fingerprint, outcome });

/** Every fingerprint the package declares that can be recomputed here, and the declarations the gateway alone can check. */
async function rowsOf(pkg: Dict, archive: JSZip | null): Promise<VerificationRow[]> {
  const rows: VerificationRow[] = [];

  const { packageDigest, ...unsigned } = pkg;
  const declared = text(packageDigest);
  let actual: string | null = null;
  try {
    actual = await computeCanonicalDigest(unsigned);
  } catch {
    actual = null;
  }
  rows.push(row('manifest', 'Package manifest', 'Manifest', declared, declared && declared === actual ? 'verified' : 'mismatch'));

  for (const [id, entry] of Object.entries(isDict(pkg.snapshots) ? pkg.snapshots : {})) {
    const snapshot = isDict(entry) ? entry : {};
    const fingerprint = text(snapshot.packageDigest);
    const actualSnapshot = await digestOfBase64(snapshot.archive);
    rows.push(row(`snapshot:${id}`, `Snapshot ${id.slice(0, 8)}`, 'Snapshot', fingerprint, fingerprint && fingerprint === actualSnapshot ? 'verified' : 'mismatch'));
  }

  for (const [index, entry] of list(pkg.library).entries()) {
    const ref = isDict(entry.ref) ? entry.ref : {};
    const manifest = isDict(entry.manifest) ? entry.manifest : {};
    const fingerprint = text(ref.versionDigest);
    let manifestOk = false;
    try {
      manifestOk = Boolean(fingerprint) && (await computeCanonicalDigest(manifest)) === fingerprint;
    } catch {
      manifestOk = false;
    }
    const contentOk = (await digestOfBase64(entry.contentBase64)) === text(manifest.contentDigest);
    const name = text(entry.displayName) ?? text(ref.name) ?? `Library version ${index + 1}`;
    rows.push(row(`library:${index}`, name, 'Library version', fingerprint, manifestOk && contentOk ? 'verified' : 'mismatch'));
  }

  for (const entry of list(pkg.cases)) {
    const caseName = text(entry.name) ?? text(entry.slug) ?? 'Case';
    for (const revision of list(entry.revisions)) {
      rows.push(row(`case:${text(entry.slug)}:${String(revision.revision)}`, `${caseName} · revision ${String(revision.revision ?? '?')}`, 'Case revision', text(revision.digest), 'later'));
    }
  }

  for (const entry of list(pkg.studies)) {
    const studyName = text(entry.name) ?? text(entry.slug) ?? 'Study';
    for (const run of list(entry.runs)) {
      rows.push(row(`run:${text(run.id)}`, `${studyName} · run ${String(run.number ?? '?')}`, 'Study run', text(run.matrixDigest), 'later'));
    }
  }

  // The gateway checks a report's declared digest against the canonical digest of its document: so can this page.
  for (const entry of list(pkg.reports)) {
    const fingerprint = text(entry.digest);
    let matches = false;
    try {
      matches = Boolean(fingerprint) && isDict(entry.document) && (await computeCanonicalDigest(entry.document)) === fingerprint;
    } catch {
      matches = false;
    }
    rows.push(row(`report:${text(entry.slug)}`, text(entry.title) ?? text(entry.slug) ?? 'Report', entry.state === 'frozen' ? 'Frozen report' : 'Report draft', fingerprint, matches ? 'verified' : 'mismatch'));
  }

  for (const entry of list(pkg.publications)) {
    rows.push(row(`publication:${text(entry.slug)}`, text(entry.slug) ?? 'Publication', 'Publication', null, 'later'));
  }

  for (const entry of list(pkg.artifacts)) {
    const fingerprint = text(entry.digest);
    let actualFile: string | null = null;
    let present = true;
    if (typeof entry.contentBase64 === 'string') {
      actualFile = await digestOfBase64(entry.contentBase64);
    } else if (archive && typeof entry.path === 'string') {
      const file = archive.file(entry.path);
      if (file) actualFile = await computeRawSha256(await file.async('arraybuffer'));
      else present = false;
    } else {
      present = false;
    }
    rows.push(row(`file:${fingerprint}`, fingerprint ? shortDigest(fingerprint) : 'File', `File${text(entry.mediaType) ? ` · ${text(entry.mediaType)}` : ''}`, fingerprint, !present ? 'missing' : fingerprint && fingerprint === actualFile ? 'verified' : 'mismatch'));
  }
  return rows;
}

function casesOf(pkg: Dict): DeclaredCase[] {
  return list(pkg.cases).map((entry) => ({
    slug: text(entry.slug) ?? '',
    name: text(entry.name) ?? text(entry.slug) ?? 'Case',
    revisions: list(entry.revisions).flatMap((revision) => (typeof revision.revision === 'number' && text(revision.digest) ? [{ revision: revision.revision, digest: text(revision.digest)! }] : [])),
  }));
}

function failed(base: Omit<PackageInspection, 'rows' | 'cases' | 'readable'>, problem: PackageProblem): PackageInspection {
  return { ...base, readable: true, rows: [], cases: [], problem };
}

/**
 * Open a package on this device and check every fingerprint that can be recomputed, before anything is sent. Nothing is
 * written. A YAML package can't be opened here (the app has no YAML reader), so it is checked by the gateway when it is imported.
 */
export async function inspectPackage(file: File): Promise<PackageInspection> {
  const buffer = await bytesOf(file);
  const format = detectFormat(file, new Uint8Array(buffer, 0, Math.min(2, buffer.byteLength)));
  const base = { fileName: file.name, size: file.size, format };
  if (format === 'yaml') return { ...base, readable: false, rows: [], cases: [] };

  let pkg: unknown;
  let archive: JSZip | null = null;
  try {
    if (format === 'zip') {
      archive = await JSZip.loadAsync(buffer);
      const entry = archive.file('package.json') ?? archive.file('manifest.json');
      if (!entry) return failed(base, { kind: 'unreadable', title: 'Not an OpenBinding package', text: 'The ZIP has no package.json or manifest.json, so there is nothing to check. Nothing was imported.' });
      pkg = JSON.parse(await entry.async('string'));
    } else {
      pkg = JSON.parse(new TextDecoder().decode(buffer));
    }
  } catch {
    return failed(base, { kind: 'unreadable', title: 'The file can’t be read', text: 'It is not a ZIP, JSON or YAML package this page can open. Nothing was imported.' });
  }
  if (!isDict(pkg) || pkg.apiVersion !== PACKAGE_API_VERSION) {
    return failed(base, { kind: 'unsupported', title: 'Unsupported package version', text: `Only ${PACKAGE_API_VERSION} packages can be imported. Nothing was imported.` });
  }

  const rows = await rowsOf(pkg, archive);
  const bad = rows.find((item) => item.outcome === 'mismatch' || item.outcome === 'missing');
  const problem: PackageProblem | undefined = bad
    ? {
      kind: 'fingerprint',
      title: bad.outcome === 'missing' ? 'A file is missing' : 'Fingerprint doesn’t match',
      text: bad.outcome === 'missing'
        ? `“${bad.name}” is listed in the package but its bytes are not in the file. The file was changed or damaged after export; nothing was imported.`
        : `“${bad.name}” says ${bad.fingerprint ? shortDigest(bad.fingerprint) : 'a fingerprint'}, but its content hashes to something else. The file was changed or damaged after export; nothing was imported.`,
    }
    : undefined;
  return { ...base, readable: true, rows, cases: casesOf(pkg), problem };
}

export interface ExistingCase {
  slug: string;
  revisions: Array<{ revision: number; digest: string }>;
}

/**
 * Put the case revisions of the package next to what the project already holds: the same fingerprint is reused, a revision
 * that exists with other content is a collision (the gateway answers 409 for it), anything else is new.
 */
export function compareWithProject(inspection: PackageInspection, existing: readonly ExistingCase[]): PackageInspection {
  if (!inspection.readable || inspection.problem) return inspection;
  const outcomes = new Map<string, RowOutcome>();
  for (const declared of inspection.cases) {
    const held = existing.find((item) => item.slug === declared.slug);
    for (const revision of declared.revisions) {
      let outcome: RowOutcome = 'new';
      if (held?.revisions.some((item) => item.digest === revision.digest)) outcome = 'reuse';
      else if (held?.revisions.some((item) => item.revision === revision.revision)) outcome = 'collision';
      outcomes.set(`case:${declared.slug}:${revision.revision}`, outcome);
    }
  }
  const rows = inspection.rows.map((item) => ({ ...item, outcome: outcomes.get(item.id) ?? item.outcome }));
  const clash = rows.find((item) => item.outcome === 'collision');
  const problem: PackageProblem | undefined = clash
    ? {
      kind: 'collision',
      title: 'Name already used with different content',
      text: `“${clash.name}” exists in this project with a different fingerprint. Rename one of them before importing.`,
    }
    : undefined;
  return { ...inspection, rows, problem };
}

export interface ReportCounts {
  verified: number;
  reused: number;
  added: number;
  later: number;
}

export function countRows(rows: readonly VerificationRow[]): ReportCounts {
  const count = (outcome: RowOutcome) => rows.filter((item) => item.outcome === outcome).length;
  return { verified: count('verified'), reused: count('reuse'), added: count('new'), later: count('later') };
}

/** What a finished import added, read defensively: the contract only says “an object”. */
export function packageImportCounts(result: PackageImportResult | null | undefined): { total: number; parts: Array<{ id: string; count: number }> } {
  const source = isDict(result) && isDict(result.imported) ? result.imported : isDict(result) ? result : {};
  const parts = Object.entries(source).flatMap(([id, value]) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? [{ id, count: value }] : []));
  return { total: parts.reduce((sum, part) => sum + part.count, 0), parts };
}

/** `caseRevisions` → `case revisions`. */
export function humanizeCount(id: string): string {
  return id.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
}
