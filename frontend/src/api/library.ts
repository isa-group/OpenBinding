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
/** The reads that the study screens and the version picker make; the library screens write through `libraryItemsApi`. */
export const libraryApi = {
  list: (org: string, includePublic = false) => apiClient.request<Artifact[]>(`/v1/organizations/${encodeURIComponent(org)}/library?include_public=${includePublic}`),
  versions: (id: string) => apiClient.request<ArtifactVersion[]>(`${root(id)}/versions`),
  content: (id: string, version: string) => apiClient.requestText(`${root(id)}/versions/${version}/content`),
  drafts: (id: string) => apiClient.request<ArtifactDraft[]>(`${root(id)}/drafts`),
};
