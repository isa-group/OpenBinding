import type { ProblemOrigin } from '../shared/api/types';
import type { BimEngineCompatibility } from './bim';
import { apiClient } from './client';

const enc = encodeURIComponent;
const ZIP = { 'Content-Type': 'application/vnd.bim+zip' };
const problemsRoot = (org: string) => `/v1/organizations/${enc(org)}/problems`;
const problemRoot = (org: string, problem: string) => `${problemsRoot(org)}/${enc(problem)}`;
const revisionRoot = (org: string, problem: string, revision: number | string) =>
  `${problemRoot(org, problem)}/revisions/${enc(String(revision))}`;

/** The newest revision of a problem, as the list and the problem itself show it. */
export interface LatestRevision {
  id: string;
  revision: number;
  package_digest: string;
  created_at: string;
  /** Where it came from: the gateway reads it from the producer the upload named. */
  origin: ProblemOrigin;
}

/** A problem of an organization (`BindingCase`): its address, its words and its newest revision. */
export interface Problem {
  id: string;
  organization_id: string;
  slug: string;
  name: string;
  description: string;
  created_by_id: string;
  created_at: string;
  updated_at: string;
  latest_revision?: LatestRevision | null;
}

export interface ProblemList {
  problems: Problem[];
  total: number;
  limit: number;
  offset: number;
}

/** A sealed revision: the uploaded `.bim.zip`, identified by the toolchain's package digest. */
export interface ProblemRevision {
  id: string;
  problem_id: string;
  revision: number;
  package_digest: string;
  instance_digest?: string | null;
  package_size: number;
  provenance?: Record<string, unknown> | null;
  created_by_id: string;
  created_at: string;
}

export interface PackageFile {
  path: string;
  role: string;
  resource_id?: string | null;
  digest: string;
  media_type: string;
}

/** A compilation as an upload or a list shows it. */
export interface CompilationSummary {
  id: string;
  compilation_digest: string;
  compiler_digest: string;
  ir_digest: string;
  binding_space: string;
  created_at: string;
  /** Whether the installed toolchain made this compilation. */
  current: boolean;
}

/** One revision with its root document, its file list and the compilations made of it. */
export interface ProblemRevisionDetail extends ProblemRevision {
  document: Record<string, unknown>;
  files: PackageFile[];
  resource_digests: Record<string, string>;
  compilations: CompilationSummary[];
}

export interface ResourceContract {
  role?: string | null;
  path?: string | null;
  apiVersion?: string | null;
  kind?: string | null;
  dialect?: unknown;
}

export interface ProblemAnalysis {
  tasks: number;
  candidates: number;
  constraints: number;
  placement: boolean;
  bindingSpace: string;
}

/** The compilation of a revision by the installed toolchain, with what a run needs to know of it. */
export interface ProblemCompilation extends CompilationSummary {
  revision_id: string;
  toolchain: Record<string, unknown>;
  analysis: ProblemAnalysis;
  resources: Record<string, ResourceContract>;
  compatible_modes: BimEngineCompatibility[];
}

export interface CompilationIr {
  id: string;
  ir_digest: string;
  ir: Record<string, unknown>;
  source_map: Record<string, unknown>;
}

/** What an upload made: the problem, the revision (new, or the one the package already is) and its compilation. */
export interface ProblemUpload {
  problem: Problem;
  revision: ProblemRevision;
  compilation: CompilationSummary;
  /** False when the package was already a revision of the problem (200). */
  created: boolean;
}

export interface ProblemCreate {
  slug?: string;
  name?: string;
  description?: string;
  /** Who made the package (`openbinding-upload`, `openbinding-problem-editor`): the gateway records the version's origin from it. */
  producer?: string;
}

/** What the problem list asks the gateway for: a page, and the problems whose latest version came from `origin` or a version of `composition` links. */
export interface ProblemListQuery {
  limit?: number;
  offset?: number;
  origin?: ProblemOrigin;
  composition?: string;
}

function query(values: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== '') params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : '';
}

const zipBody = (archive: Uint8Array | Blob): RequestInit => ({
  method: 'POST',
  headers: ZIP,
  body: archive as unknown as BodyInit,
});

/**
 * The problems of an organization (`/v1/organizations/{org}/problems`). Reading needs VIEWER; uploading and editing need MEMBER,
 * deleting ADMIN. The writes throw on a refusal (HttpError for 409, 413, 415, 422…, QuotaError for 402) so the screens word each one.
 */
export const problemsApi = {
  list: (org: string, params: ProblemListQuery = {}) =>
    apiClient.request<ProblemList>(`${problemsRoot(org)}${query({ ...params })}`),
  get: (org: string, problem: string) => apiClient.request<Problem>(problemRoot(org, problem)),
  /**
   * Upload a `.bim.zip` as a new problem: 201 with its first revision and compilation. 409 `slug_conflict`, 402 `quota_exceeded`,
   * 422 `invalid_instance` with diagnostics.
   */
  create: (org: string, archive: Uint8Array | Blob, value: ProblemCreate = {}) =>
    apiClient.request<ProblemUpload>(
      `${problemsRoot(org)}${query({ slug: value.slug, name: value.name, description: value.description, producer: value.producer })}`,
      zipBody(archive),
      undefined,
      true,
      true
    ),
  update: (org: string, problem: string, value: { name?: string; description?: string }) =>
    apiClient.request<Problem>(
      problemRoot(org, problem),
      { method: 'PATCH', body: JSON.stringify(value) },
      undefined,
      true,
      true
    ),
  /** 409 `problem_has_runs` while a run or a study names one of its revisions. */
  remove: (org: string, problem: string) =>
    apiClient.request<void>(problemRoot(org, problem), { method: 'DELETE' }, undefined, true, true),
  /** Newest first. */
  revisions: (org: string, problem: string) =>
    apiClient.request<ProblemRevision[]>(`${problemRoot(org, problem)}/revisions`),
  /** Upload a package as a revision: `created` is false (200) when the package already is a revision of the problem. */
  createRevision: (
    org: string,
    problem: string,
    archive: Uint8Array | Blob,
    value: { producer?: string } = {}
  ) =>
    apiClient.request<ProblemUpload>(
      `${problemRoot(org, problem)}/revisions${query({ producer: value.producer })}`,
      zipBody(archive),
      undefined,
      true,
      true
    ),
  /** One revision by its number, id or package digest. */
  revision: (org: string, problem: string, revision: number | string) =>
    apiClient.request<ProblemRevisionDetail>(revisionRoot(org, problem, revision)),
  /** The package exactly as it was uploaded. */
  source: (org: string, problem: string, revision: number | string) =>
    apiClient.requestBinary(`${revisionRoot(org, problem, revision)}/source`),
  /** The compilation by the installed toolchain (compiled again after a toolchain release): analysis, resources and modes. */
  compilation: (org: string, problem: string, revision: number | string) =>
    apiClient.request<ProblemCompilation>(`${revisionRoot(org, problem, revision)}/compilation`),
  /** The IR of one compilation, as the engines read it, with its source map. */
  ir: (org: string, problem: string, revision: number | string, compilation: string) =>
    apiClient.request<CompilationIr>(
      `${revisionRoot(org, problem, revision)}/compilations/${enc(compilation)}/ir`
    ),
};
