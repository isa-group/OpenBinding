import { apiClient } from './client';
import type { ArtifactRef, ArtifactUse, ArtifactVersion } from './library';
import type { BindingCase, CaseRevision } from './platform';

const enc = encodeURIComponent;
const projectRoot = (org: string, project: string) => `/v1/organizations/${enc(org)}/projects/${enc(project)}`;
const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

/** `GET /v1/instances/{id}`: what a snapshot pins, file by file and resource by resource. */
export interface SnapshotPins {
  id: string;
  kind: 'InstanceSnapshot';
  instanceDigest: string;
  packageDigest: string;
  irDigest: string | null;
  fileDigests: Record<string, string>;
  resourceDigests: Record<string, string>;
  instance: Record<string, unknown>;
  createdAt: string;
}

/** `POST /v1/validate` with `{ snapshot }`: the gateway's own reading of a snapshot. */
export interface SnapshotAnalysis {
  valid: boolean;
  instanceDigest: string;
  packageDigest: string;
  irDigest: string;
  analysis: { tasks: number; candidates: number; constraints: number; placement: boolean; bindingSpace: string };
  compatibleModes?: unknown[];
}

/**
 * The calls of the case screens that `platformApi` doesn't have. The mutations throw on a 422 (a refused submission)
 * instead of handing its body back as if it were the result.
 */
export const casesApi = {
  /** Needs MEMBER. 409 `slug_conflict` when the address is taken. */
  createCase: (org: string, project: string, value: { slug: string; name: string; description: string }) =>
    apiClient.request<BindingCase>(`${projectRoot(org, project)}/cases`, json('POST', value), undefined, true, true),
  /** Needs MEMBER. */
  updateCase: (org: string, project: string, caseSlug: string, value: { name?: string; description?: string }) =>
    apiClient.request<BindingCase>(`${projectRoot(org, project)}/cases/${enc(caseSlug)}`, json('PATCH', value), undefined, true, true),
  /** One revision by its number (an id or a digest also work). 404 when it doesn't exist. */
  revision: (org: string, project: string, caseSlug: string, revision: number | string) =>
    apiClient.request<CaseRevision>(`${projectRoot(org, project)}/cases/${enc(caseSlug)}/revisions/${enc(String(revision))}`),
  /**
   * Needs MEMBER. The gateway builds the package from the exact library versions, compiles it and seals the revision.
   * Answers with the existing revision when the same inputs were sealed before.
   */
  createRevision: (org: string, project: string, caseSlug: string, document: Record<string, unknown>, resources: ArtifactUse[]) =>
    apiClient.request<CaseRevision>(`${projectRoot(org, project)}/cases/${enc(caseSlug)}/revisions`, json('POST', { document, resources }), undefined, true, true),
  /** `POST /v1/artifacts/resolve`: the exact version a reference names, if the account may read it (404 otherwise). */
  resolveVersion: (ref: ArtifactRef) =>
    apiClient.request<ArtifactVersion>('/v1/artifacts/resolve', json('POST', ref), undefined, true, true),
  /** `POST /v1/validate` for a snapshot: 402 when it is bigger than the plan allows, 409 when it can't be analysed. */
  analyseSnapshot: (snapshot: string) =>
    apiClient.request<SnapshotAnalysis>('/v1/validate', json('POST', { snapshot }), undefined, true, true),
  instance: (snapshot: string) => apiClient.request<SnapshotPins>(`/v1/instances/${enc(snapshot)}`),
  /** The package exactly as it was uploaded, before compiling. */
  instanceSource: (snapshot: string) => apiClient.requestBinary(`/v1/instances/${enc(snapshot)}/source`),
  /** The compiled form, as the engines read it. */
  instanceIr: (snapshot: string) => apiClient.request<Record<string, unknown>>(`/v1/instances/${enc(snapshot)}/ir`),
};
