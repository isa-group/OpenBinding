import { apiClient } from './client';

export interface ArtifactRef { namespace: string; name: string; version: string; versionDigest: string }
export interface Artifact {
  id: string; organization_id: string; namespace: string; name: string; display_name: string;
  kind: string; description: string; labels: Record<string, string>; archived: boolean;
}
export interface ArtifactVersion {
  id: string; artifact_id: string; ordinal: number; ref: ArtifactRef; contentDigest: string;
  manifest: { mediaType: string; contracts: Record<string, string>[]; dependencies: ArtifactRef[] };
  based_on_id: string | null; public: boolean; withdrawn: boolean;
}
export interface DraftContent {
  content: Record<string, unknown> | string; media_type: string;
  contracts: Record<string, string>[]; dependencies: ArtifactRef[];
}
export interface ArtifactDraft { id: string; revision: number; payload: DraftContent; based_on_id: string | null }
export interface ArtifactUse { role: string; alias: string; artifact: ArtifactRef; bindings: Record<string, string> }
const root = (id: string) => `/v1/artifacts/${encodeURIComponent(id)}`;
const post = (body: unknown) => ({ method: 'POST', body: JSON.stringify(body) });
export const libraryApi = {
  projectArtifacts: (org: string, project: string) => apiClient.request<Artifact[]>(`/v1/organizations/${encodeURIComponent(org)}/projects/${encodeURIComponent(project)}/library`),
  dissociate: (org: string, project: string, id: string) => apiClient.request<void>(`/v1/organizations/${encodeURIComponent(org)}/projects/${encodeURIComponent(project)}/library/${id}`, { method: 'DELETE' }),
  list: (org: string, includePublic = false) => apiClient.request<Artifact[]>(`/v1/organizations/${encodeURIComponent(org)}/library?include_public=${includePublic}`),
  create: (org: string, value: Pick<Artifact, 'name' | 'display_name' | 'kind' | 'description'>) => apiClient.request<Artifact>(`/v1/organizations/${encodeURIComponent(org)}/library`, post(value)),
  versions: (id: string) => apiClient.request<ArtifactVersion[]>(`${root(id)}/versions`),
  content: (id: string, version: string) => apiClient.requestText(`${root(id)}/versions/${version}/content`),
  drafts: (id: string) => apiClient.request<ArtifactDraft[]>(`${root(id)}/drafts`),
  draft: (id: string, value: DraftContent, basedOn: string | null = null) => apiClient.request<ArtifactDraft>(`${root(id)}/drafts`, post({ ...value, based_on_id: basedOn })),
  editDraft: (id: string, draft: ArtifactDraft, value: DraftContent) => apiClient.request<{ id: string; revision: number }>(`${root(id)}/drafts/${draft.id}`, { method: 'PUT', body: JSON.stringify({ ...value, revision: draft.revision }) }),
  seal: (id: string, draft: ArtifactDraft, version?: string) => apiClient.request<ArtifactVersion>(`${root(id)}/drafts/${draft.id}/seal`, post({ revision: draft.revision, version: version || null })),
  publish: (id: string, version: string) => apiClient.request<ArtifactVersion>(`${root(id)}/versions/${version}/publish`, post({})),
  withdraw: (id: string, version: string) => apiClient.request<ArtifactVersion>(`${root(id)}/versions/${version}/withdraw`, post({})),
  associate: (org: string, project: string, id: string) => apiClient.request(`/v1/organizations/${encodeURIComponent(org)}/projects/${encodeURIComponent(project)}/library/${id}`, { method: 'PUT' }),
};
