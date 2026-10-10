import { HttpError } from '../../api/client';
import { readDiagnostics } from '../../api/problem';
import type { ResolveLocation, ResolveResponse } from '../../api/platform';

/** The kinds the gateway's resolver accepts (`VALID_KINDS` in routes/resolve.py), with how to name them to a reader. */
export const RESOLVE_KINDS = [
  { id: 'report', label: 'Report edition' },
  { id: 'artifact', label: 'Artifact' },
  { id: 'case-revision', label: 'Case revision' },
  { id: 'resource-revision', label: 'Resource revision' },
  { id: 'collection-revision', label: 'Collection revision' },
  { id: 'engine', label: 'Engine' },
  { id: 'dialect', label: 'Dialect' },
  { id: 'registered-resource', label: 'Registered resource' },
  { id: 'instance-snapshot', label: 'Instance snapshot' },
  { id: 'binding-ir', label: 'Binding problem IR' },
] as const;

export function kindLabel(kind: string): string {
  return RESOLVE_KINDS.find((item) => item.id === kind)?.label ?? kind;
}

export function isKnownKind(kind: string): boolean {
  return RESOLVE_KINDS.some((item) => item.id === kind);
}

/** What came back, in the terms the screen shows. */
export type ResolveOutcome =
  | { type: 'invalid' }
  | { type: 'malformed'; detail: string }
  | { type: 'not-found' }
  | { type: 'unavailable'; status: number | null }
  | { type: 'resolved'; element: ResolveResponse };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeValidation(body: Record<string, unknown>): string {
  const messages = readDiagnostics(body.diagnostics).map((diagnostic) => diagnostic.message);
  if (messages.length) return messages.join('; ');
  if (typeof body.detail === 'string') return body.detail;
  return 'The resolver refused the request.';
}

/** The body as a resolved element, or `null` when it is something else (`ApiClient.request` returns a 422 body as data). */
export function asResolved(body: unknown): ResolveResponse | null {
  return isRecord(body) && typeof body.verified === 'boolean' && Array.isArray(body.locations) ? body as unknown as ResolveResponse : null;
}

export function outcomeOf(result: { data?: unknown; error?: unknown; failed: boolean }): ResolveOutcome {
  if (result.failed) {
    if (result.error instanceof HttpError) {
      return result.error.status === 404 ? { type: 'not-found' } : { type: 'unavailable', status: result.error.status };
    }
    return { type: 'unavailable', status: null };
  }
  const body = result.data;
  const element = asResolved(body);
  if (element) return { type: 'resolved', element };
  return { type: 'malformed', detail: isRecord(body) ? describeValidation(body) : 'The resolver refused the request.' };
}

/**
 * Where a location lives in the application, built from routes this app serves. The gateway's own `web_url` now sends
 * the same routes (`d1`..`d8`), but it is `null` for what has no screen and depends on who is asking, so the address
 * is still built here from the slugs the location names.
 */
export function locationHref(kind: string, location: ResolveLocation): { href: string; requiresAccount: boolean } | null {
  const organization = location.organization?.slug;
  const project = location.project?.slug;
  const slug = location.slug ?? undefined;
  if (kind === 'engine' && slug && slug.includes('/') && location.version_or_revision !== null && location.version_or_revision !== undefined) {
    return { href: `/engines/${slug}/${location.version_or_revision}`, requiresAccount: false };
  }
  if (!organization || !project) return null;
  const base = `/app/${organization}/${project}`;
  const detail: Partial<Record<string, string>> = { report: 'reports', 'case-revision': 'cases', 'collection-revision': 'collections' };
  const section = detail[kind];
  if (section && slug) return { href: `${base}/${section}/${encodeURIComponent(slug)}`, requiresAccount: true };
  // Resource revisions have no detail screen keyed by this slug yet; the project's list is the closest place.
  return { href: kind === 'resource-revision' ? `${base}/resources` : base, requiresAccount: true };
}

/** How a media type reads to a person. */
export function formatOf(mediaType: string): string {
  const friendly = [
    ['json', 'JSON document'], ['zip', 'ZIP archive'], ['xml', 'XML document'], ['yaml', 'YAML document'],
    ['markdown', 'Markdown text'], ['text/plain', 'Plain text'], ['octet-stream', 'Binary file'],
  ].find(([needle]) => mediaType.toLowerCase().includes(needle));
  return friendly ? `${friendly[1]} (${mediaType})` : mediaType;
}

export function extensionOf(mediaType: string): string {
  const lower = mediaType.toLowerCase();
  if (lower.includes('json')) return 'json';
  if (lower.includes('zip')) return 'zip';
  if (lower.includes('xml')) return 'xml';
  if (lower.includes('yaml')) return 'yaml';
  if (lower.includes('markdown')) return 'md';
  if (lower.startsWith('text/')) return 'txt';
  return 'bin';
}

export interface FieldSummary {
  name: string;
  /** `text`, `number`, `flag`, `list`, `object` or `empty`. */
  type: string;
  detail: string;
}

/** The top-level shape of a document, so that structure can be read without reading JSON. */
export function summarizeDocument(document: unknown, limit = 14): { fields: FieldSummary[]; total: number } {
  if (Array.isArray(document)) {
    return { fields: [{ name: 'items', type: 'list', detail: `${document.length} item${document.length === 1 ? '' : 's'}` }], total: 1 };
  }
  if (!isRecord(document)) return { fields: [], total: 0 };
  const entries = Object.entries(document);
  const fields = entries.slice(0, limit).map(([name, value]): FieldSummary => {
    if (value === null || value === undefined) return { name, type: 'empty', detail: 'empty' };
    if (Array.isArray(value)) return { name, type: 'list', detail: `${value.length} item${value.length === 1 ? '' : 's'}` };
    if (isRecord(value)) {
      const count = Object.keys(value).length;
      return { name, type: 'object', detail: `${count} field${count === 1 ? '' : 's'}` };
    }
    if (typeof value === 'number') return { name, type: 'number', detail: String(value) };
    if (typeof value === 'boolean') return { name, type: 'flag', detail: value ? 'yes' : 'no' };
    const text = String(value);
    return { name, type: 'text', detail: text.length > 48 ? `${text.slice(0, 47)}…` : text };
  });
  return { fields, total: entries.length };
}
