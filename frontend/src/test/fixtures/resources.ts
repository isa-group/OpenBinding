import type { UsageView } from '../../api/auth';
import type { Collection, CollectionItem, CollectionRevision, ProjectResource, ProjectResourceRevision, StoredBlob } from '../../api/platform';

/** Shared by the tests of the files, resources and collections, and by the browser spec that mocks the same API. */

export const PROJECT_ID = 'project-qos';
export const OWNER = 'user-admin';

/** `sha256-` followed by 64 copies of one hexadecimal character. */
export const digestOf = (char: string): string => `sha256-${char.repeat(64)}`;

export function blobOf(char: string, over: Partial<StoredBlob> = {}): StoredBlob {
  return {
    id: `blob-${char}`, organization_id: 'org-isa-demo', project_id: PROJECT_ID, digest: digestOf(char), media_type: 'application/zip', size_bytes: 48_213,
    public: false, expires_at: null, created_at: '2026-08-20T10:05:00Z', ...over,
  };
}

export function resourceOf(slug: string, name = slug, over: Partial<ProjectResource> = {}): ProjectResource {
  return {
    id: `resource-${slug}`, project_id: PROJECT_ID, slug, name, description: '', kind: 'bim-resource', created_by_id: OWNER, created_at: '2026-08-01T00:00:00Z', ...over,
  };
}

export function resourceRevisionOf(resource: ProjectResource, revision: number, document: Record<string, unknown> = {}, over: Partial<ProjectResourceRevision> = {}): ProjectResourceRevision {
  return {
    id: `${resource.id}-r${revision}`, project_resource_id: resource.id, revision, digest: digestOf(String(revision + 4)), document,
    created_at: `2026-08-0${revision}T09:30:00Z`, ...over,
  };
}

export function collectionOf(slug: string, name = slug, over: Partial<Collection> = {}): Collection {
  return { id: `collection-${slug}`, project_id: PROJECT_ID, slug, name, description: '', created_by_id: OWNER, created_at: '2026-09-01T00:00:00Z', ...over };
}

export function collectionRevisionOf(collection: Collection, revision: number, items: CollectionItem[], over: Partial<CollectionRevision> = {}): CollectionRevision {
  return { id: `${collection.id}-r${revision}`, collection_id: collection.id, revision, digest: digestOf(String(revision)), items, created_at: `2026-09-0${revision}T08:00:00Z`, ...over };
}

/** A case item as the gateway lists it: the revision id and the composition fingerprint. */
export const caseItem = (revisionId: string, digest: string): CollectionItem => ({
  target_kind: 'case', target_digest: digest, target_ref: { caseRevisionId: revisionId, compositionDigest: digest },
});

/** A resource item as the gateway lists it: the library reference, with the version fingerprint (not the content one). */
export const resourceItem = (name: string, version: string, versionDigest: string): CollectionItem => ({
  target_kind: 'resource', target_digest: versionDigest, target_ref: { namespace: 'org-isa-demo', name, version, versionDigest },
});

export function usageOf(over: Partial<UsageView> = {}): UsageView {
  return {
    plan: 'RESEARCH',
    contract_pending: false,
    features: {},
    capabilities: { maxPayloadBytes: 134_217_728, storageBytes: 5_368_709_120, collections: 50 },
    limits: {},
    ...over,
  };
}
