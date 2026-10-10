import type { PricingCatalog, UsageView } from '../../api/auth';
import type { StoredBlob } from '../../api/platform';
import { digestPrefix, shortDigest } from '../../utils/digest';
import { planLimit } from '../Project/projectModel';

export { SLUG_PATTERN, slugFromName } from '../Project/projectModel';

/** The longest a name and a description may be (`ProjectResourceCreate`, `CollectionCreate` in the contract). */
export const NAME_MAX = 160;
export const DESCRIPTION_MAX = 2000;
export const KIND_MAX = 128;

export function plural(count: number, noun: string, many = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : many}`;
}

// --- what the sponsor allows

/** One sponsored allowance (`storageBytes`, `collections`) as far as this account can see it. */
export interface Allowance {
  /** The usage could be read and this account is the sponsor, so the figures are the sponsor’s own. */
  known: boolean;
  /** `null` is unlimited (or not known). */
  limit: number | null;
  /** What the sponsor has used across every organization, when the gateway tracks it. */
  used: number | null;
}

/**
 * The gateway tells an account about its own allowances only: `GET /v1/users/me/usage`. Whoever is not the sponsor of the organization
 * therefore can’t see the sponsor’s limits, and the screen says so instead of showing someone else’s numbers as theirs.
 */
export function allowanceOf(usage: UsageView | null | undefined, id: string, isSponsor: boolean): Allowance {
  if (!usage || !isSponsor) return { known: false, limit: null, used: null };
  const tracked = usage.limits?.[id];
  if (tracked) return { known: true, limit: Number.isFinite(tracked.limit) ? tracked.limit : null, used: tracked.used };
  const capability = usage.capabilities?.[id];
  return { known: true, limit: typeof capability === 'number' && Number.isFinite(capability) ? capability : null, used: null };
}

// --- files

/** What the gateway never lets one upload exceed, whatever the plan says (`_payload_limit` in `routes/artifacts.py`). */
export const GATEWAY_BLOB_LIMIT = 512 * 1024 * 1024;

export interface UploadCeiling {
  /** The plan’s `maxPayloadBytes`, when it is known. */
  plan: number | null;
  /** What one upload may really be. */
  effective: number;
  /** The plan allows more than the gateway takes. */
  clamped: boolean;
}

export function uploadCeiling(usage: UsageView | null | undefined, catalog: PricingCatalog | null | undefined, plan: string | undefined): UploadCeiling {
  const fromUsage = usage?.capabilities?.maxPayloadBytes;
  const planValue = typeof fromUsage === 'number' && Number.isFinite(fromUsage) ? fromUsage : planLimit(catalog, usage?.plan ?? plan, 'maxPayloadBytes');
  const effective = planValue === null ? GATEWAY_BLOB_LIMIT : Math.min(planValue, GATEWAY_BLOB_LIMIT);
  return { plan: planValue, effective, clamped: planValue !== null && planValue > GATEWAY_BLOB_LIMIT };
}

const TYPE_LABELS: Array<[RegExp, string]> = [
  [/zip/, 'ZIP archive'],
  [/json/, 'JSON'],
  [/yaml|yml/, 'YAML'],
  [/csv/, 'CSV'],
  [/^text\/plain/, 'Text'],
  [/xml/, 'XML'],
  [/pdf/, 'PDF'],
  [/^image\//, 'Image'],
  [/octet-stream/, 'Binary'],
];

/** What a person calls a media type: `application/zip` reads `ZIP archive`; anything unknown reads as it is written. */
export function typeLabel(mediaType: string): string {
  const type = mediaType.toLowerCase();
  return TYPE_LABELS.find(([pattern]) => pattern.test(type))?.[1] ?? mediaType;
}

const EXTENSIONS: Array<[RegExp, string]> = [
  [/zip/, '.zip'], [/json/, '.json'], [/yaml|yml/, '.yaml'], [/csv/, '.csv'], [/^text\/plain/, '.txt'], [/xml/, '.xml'], [/pdf/, '.pdf'],
];

export function isZipFile(blob: Pick<StoredBlob, 'media_type'>): boolean {
  return /zip/i.test(blob.media_type);
}

/** The names of files uploaded in this visit, by fingerprint: the gateway stores bytes, not names. */
export type SessionNames = Record<string, string>;

/** What the list calls a file: the name it had when it was uploaded here, otherwise its type and the start of its fingerprint. */
export function fileTitle(blob: Pick<StoredBlob, 'digest' | 'media_type'>, names: SessionNames): string {
  return names[blob.digest] ?? `${typeLabel(blob.media_type)} · ${shortDigest(blob.digest)}`;
}

/** The name a download is saved under. */
export function downloadName(blob: Pick<StoredBlob, 'digest' | 'media_type'>, names: SessionNames): string {
  if (names[blob.digest]) return names[blob.digest];
  const extension = EXTENSIONS.find(([pattern]) => pattern.test(blob.media_type.toLowerCase()))?.[1] ?? '';
  return `${digestPrefix(blob.digest)}${extension}`;
}

export function totalBytes(files: readonly Pick<StoredBlob, 'size_bytes'>[]): number {
  return files.reduce((sum, file) => sum + file.size_bytes, 0);
}

// --- project resources

/** The kinds the gateway’s project-resources view hides because the library screens own them (`list_project_resources`). */
const LIBRARY_KINDS = new Set(['Application', 'CandidateCatalog', 'ConstraintSet', 'ExecutionConfiguration', 'AnalysisConfiguration', 'Collection', 'Study', 'Report', 'BindingDecision']);

export function belongsInLibrary(kind: string): boolean {
  return LIBRARY_KINDS.has(kind);
}

export const DEFAULT_RESOURCE_KIND = 'bim-resource';
export const OTHER_RESOURCE_KIND = '__other';

/** The kinds the new-resource dialog offers: the ones this view lists, then a free one. */
export const RESOURCE_KIND_CHOICES: ReadonlyArray<{ id: string; label: string }> = [
  { id: DEFAULT_RESOURCE_KIND, label: 'Resource (default)' },
  { id: 'Optimization', label: 'Goal' },
  { id: 'Placement', label: 'Placement' },
  { id: 'RoutingOverlay', label: 'Routing overlay' },
  { id: 'Dataset', label: 'Dataset' },
  { id: 'BPMN', label: 'BPMN workflow' },
];

/** What a reader calls a kind; one nobody named yet reads as it is written. */
export function resourceKindLabel(kind: string): string {
  if (kind === DEFAULT_RESOURCE_KIND) return 'Resource';
  const known: Record<string, string> = {
    Application: 'Application', CandidateCatalog: 'Candidate catalog', ConstraintSet: 'Rules', Optimization: 'Goal',
    ExecutionConfiguration: 'Run settings', AnalysisConfiguration: 'Analysis settings',
  };
  return known[kind] ?? RESOURCE_KIND_CHOICES.find((choice) => choice.id === kind)?.label ?? kind;
}
