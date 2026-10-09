import { apiClient } from './client';
import type { Artifact, ArtifactDraft, ArtifactRef, ArtifactVersion, DraftContent } from './library';

const enc = encodeURIComponent;
const root = (id: string) => `/v1/artifacts/${enc(id)}`;
const orgRoot = (org: string) => `/v1/organizations/${enc(org)}`;
const projectLibrary = (org: string, project: string) => `${orgRoot(org)}/projects/${enc(project)}/library`;
const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

/** `ArtifactView` carries its creation time; the older `Artifact` type of the library page leaves it out. */
export type LibraryItem = Artifact & { created_at?: string };

/** `ArtifactVersionView`: the manifest also names the kind and the evidence the version was sealed with. */
export type LibraryVersion = ArtifactVersion & {
  created_at?: string;
  contentDigest: string;
  manifest: ArtifactVersion['manifest'] & { kind?: string };
};

/**
 * The library calls of the library screens. Unlike `libraryApi`, every call throws on a refusal (a 422 is an error here, not a body
 * to read as the result), so a screen can tell "the gateway said no" from "here is the answer".
 */
const strict = <T>(endpoint: string, init?: RequestInit) => apiClient.request<T>(endpoint, init, undefined, true, true);

export const libraryItemsApi = {
  /** `GET …/library`: the organization's items and, with `includePublic`, other organizations' published ones. Needs VIEWER. */
  list: (org: string, includePublic = false) => strict<LibraryItem[]>(`${orgRoot(org)}/library?include_public=${includePublic}`),
  /** Needs MEMBER. 409 `artifact_exists`; 422 `operational_pricing_only`; 403 `api_key_boundary`. */
  create: (org: string, value: { name: string; display_name: string; kind: string; description?: string }) =>
    strict<LibraryItem>(`${orgRoot(org)}/library`, json('POST', { description: '', ...value })),
  /** One item by id. 404 when it doesn't exist or can't be read. */
  item: (id: string) => strict<LibraryItem>(root(id)),
  /** Needs MEMBER of the owning organization. Only the display name changes; the fixed name and the versions never do. */
  rename: (id: string, displayName: string) => strict<LibraryItem>(root(id), json('PATCH', { display_name: displayName })),
  /** Every version the caller may read, newest first. Visitors get only the published ones. */
  versions: (id: string) => strict<LibraryVersion[]>(`${root(id)}/versions`),
  /** The verified bytes of a version. 409 `version_integrity` / `content_integrity` when the stored content no longer matches its seal. */
  content: (id: string, version: string) => apiClient.requestText(`${root(id)}/versions/${enc(version)}/content`),
  /** `POST /v1/artifacts/resolve`: the exact version a reference names. */
  resolve: (ref: ArtifactRef) => strict<LibraryVersion>('/v1/artifacts/resolve', json('POST', ref)),
  /** The open drafts of an item. Needs MEMBER. */
  drafts: (id: string) => strict<ArtifactDraft[]>(`${root(id)}/drafts`),
  createDraft: (id: string, value: DraftContent, basedOn: string | null = null) =>
    strict<ArtifactDraft>(`${root(id)}/drafts`, json('POST', { ...value, based_on_id: basedOn })),
  /** Optimistic: sends the revision the editor started from. 409 `draft_conflict` when somebody saved first or the draft was sealed. */
  saveDraft: (id: string, draftId: string, value: DraftContent, revision: number) =>
    strict<{ id: string; revision: number }>(`${root(id)}/drafts/${enc(draftId)}`, json('PUT', { ...value, revision })),
  /** Freezes the draft as a version. 409 `draft_conflict` / `version_conflict` / `immutable_version`; 422 when the content is invalid. */
  seal: (id: string, draftId: string, revision: number, version?: string) =>
    strict<LibraryVersion>(`${root(id)}/drafts/${enc(draftId)}/seal`, json('POST', { revision, version: version || null })),
  /** Needs ADMIN. 422 `private_dependency` and friends when something it stands on is not published; 409 `publication_withdrawn`. */
  publish: (id: string, version: string, citation: Record<string, unknown>) =>
    strict<LibraryVersion>(`${root(id)}/versions/${enc(version)}/publish`, json('POST', { citation })),
  /** Needs ADMIN. */
  withdraw: (id: string, version: string) => strict<LibraryVersion>(`${root(id)}/versions/${enc(version)}/withdraw`, json('POST', {})),
  /** The items a project works with. */
  projectItems: (org: string, project: string) => strict<LibraryItem[]>(projectLibrary(org, project)),
  /** Needs MEMBER. 422 `private_dependency` for another organization's unpublished item. */
  associate: (org: string, project: string, id: string) => strict<{ project_id: string; artifact_id: string }>(`${projectLibrary(org, project)}/${enc(id)}`, { method: 'PUT' }),
  dissociate: (org: string, project: string, id: string) => strict<void>(`${projectLibrary(org, project)}/${enc(id)}`, { method: 'DELETE' }),
};
