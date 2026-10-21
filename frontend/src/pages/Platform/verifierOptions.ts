import type { VerifierEntity } from '../../api/platform';

export interface EntityKind {
  /** `entity_type` of a match, as the gateway writes it. */
  type: string;
  label: string;
  /** The kind the public resolver (`/resolve/:kind/:digest`) knows it by; absent when it has no public record. */
  resolve?: string;
}

/** What the verifier can find a fingerprint in (`_search_matching_entities` of the gateway), in the words of the screen. */
export const ENTITY_KINDS: readonly EntityKind[] = [
  { type: 'case', label: 'Case revision', resolve: 'case-revision' },
  { type: 'snapshot', label: 'Instance snapshot', resolve: 'instance-snapshot' },
  { type: 'collection', label: 'Collection revision', resolve: 'collection-revision' },
  { type: 'report', label: 'Report edition', resolve: 'report' },
  { type: 'artifact', label: 'File', resolve: 'artifact' },
  { type: 'engine', label: 'Engine revision', resolve: 'engine' },
  { type: 'study_run', label: 'Study run' },
];

export function entityKind(type: string): EntityKind {
  return ENTITY_KINDS.find((kind) => kind.type === type) ?? { type, label: type.replace(/_/g, ' ') };
}

/** Where a match lives in the application, built from routes this app serves; `null` when it has no screen of its own. */
export function entityHref(entity: VerifierEntity): string | null {
  const org = entity.organization_slug;
  const project = entity.project_slug;
  if (!org || !project) return null;
  const base = `/app/${org}/${project}`;
  const slug = entity.slug ? encodeURIComponent(entity.slug) : null;
  switch (entity.entity_type) {
    case 'case': return slug ? `${base}/cases/${slug}` : null;
    case 'collection': return slug ? `${base}/collections/${slug}` : null;
    case 'report': return slug ? `${base}/reports/${slug}` : null;
    case 'study_run': return slug ? `${base}/studies/${slug}/runs/${encodeURIComponent(entity.id)}` : null;
    case 'artifact': return `${base}/files`;
    default: return null;
  }
}
