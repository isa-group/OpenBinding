import { apiClient, type BimAnalysisResponse } from './client';
import type { CaseRevision } from './platform';

const enc = encodeURIComponent;
const ZIP = { 'Content-Type': 'application/vnd.bim+zip' };

/**
 * The calls the workbench makes with a package. `apiClient.validateBimPackage` hands a 422 back as if it were the answer; the
 * workbench has to tell "this package is invalid" from "this was analysed", so every call here throws on a refusal
 * (HttpError for 401, 403, 413, 415, 422…, QuotaError for 402) and the screen words each one.
 */
export const workbenchApi = {
  /** `POST /v1/validate` with a package: compiled complexity and the exact engine deployments that can run it. */
  validate: (archive: Uint8Array) =>
    apiClient.request<BimAnalysisResponse>('/v1/validate', { method: 'POST', headers: ZIP, body: archive as unknown as BodyInit }, undefined, true, true),
  /** `POST /v1/instances`: a private, immutable snapshot of the package. */
  snapshot: (archive: Uint8Array) =>
    apiClient.request<{ id: string; irDigest: string }>('/v1/instances', { method: 'POST', headers: ZIP, body: archive as unknown as BodyInit }, undefined, true, true),
  /** `GET /v1/instances/{id}/ir`: the compiled form, as the engines read it. */
  ir: (snapshot: string) => apiClient.request<Record<string, unknown>>(`/v1/instances/${enc(snapshot)}/ir`),
  /** Needs MEMBER. `POST …/cases/{case}/revisions` with the package's instance document and the snapshot that holds its files. */
  saveRevision: (org: string, project: string, caseSlug: string, document: Record<string, unknown>, snapshot: string) =>
    apiClient.request<CaseRevision>(
      `/v1/organizations/${enc(org)}/projects/${enc(project)}/cases/${enc(caseSlug)}/revisions`,
      { method: 'POST', body: JSON.stringify({ document, source_snapshot_id: snapshot, resources: [] }) },
      undefined,
      true,
      true,
    ),
};
