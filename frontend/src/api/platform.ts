import { apiClient } from './client';

export type Visibility = 'private' | 'public';
export type RunState = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'partial';

export interface Organization {
  id: string;
  slug: string;
  name: string;
  parent_id: string | null;
  billing_sponsor_user_id: string;
  effective_role: 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER' | null;
  created_at: string;
}

export type OrganizationRole = 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER';

export interface OrganizationMember {
  id: string;
  organization_id: string;
  user_id: string;
  username: string | null;
  email: string | null;
  role: OrganizationRole;
  created_at: string;
}

export interface OrganizationInvitation {
  id: string;
  organization_id: string;
  email: string;
  role: OrganizationRole;
  expires_at: string;
  token: string;
}

/** One staged change of `POST /v1/organizations/{org}/members/batch`: a `null` role removes the direct membership. */
export interface MemberChange {
  user_id: string;
  role: OrganizationRole | null;
}

/** The most changes one batch may carry (`MemberBatchUpdate.maxItems`). */
export const MEMBER_BATCH_LIMIT = 100;

/**
 * One row of the organization audit log. The OpenAPI contract types the answer only as an object; this is what
 * `GET /v1/organizations/{org}/audit` sends in practice (`list_organization_audit_events`).
 */
export interface OrganizationAuditEvent {
  id: string;
  organizationId: string | null;
  actorId: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  detail: Record<string, unknown>;
  createdAt: string;
}

export interface OrganizationAuditPage {
  events: OrganizationAuditEvent[];
  total: number;
  offset: number;
  limit: number;
}

/**
 * How the caller reaches a project: `member` (a role, see `effective_role`) or `public_read` (somebody who is not a member
 * reading a public project: GET only, and never a role).
 */
export type ProjectAccessKind = 'member' | 'public_read';

export interface Project {
  id: string;
  organization_id: string;
  slug: string;
  name: string;
  description: string;
  visibility: Visibility;
  /** Null for a visitor of a public project. */
  created_by_id: string | null;
  created_at: string;
  updated_at: string;
  /** Absent in older answers, which were all `member`. */
  access?: ProjectAccessKind;
  /** The caller's membership role; null for a visitor. */
  effective_role?: OrganizationRole | null;
}

export interface BindingCase {
  id: string;
  project_id: string;
  slug: string;
  name: string;
  description: string;
  created_by_id: string;
  created_at: string;
}

export interface CaseRevision {
  id: string;
  binding_case_id: string;
  revision: number;
  digest: string;
  document: Record<string, unknown>;
  source_snapshot_id: string | null;
  created_at: string;
}

export interface ProjectResource {
  id: string;
  project_id: string;
  slug: string;
  name: string;
  description: string;
  kind: string;
  created_by_id: string;
  created_at: string;
}

export interface ProjectResourceRevision {
  id: string;
  project_resource_id: string;
  revision: number;
  digest: string;
  document: Record<string, unknown>;
  created_at: string;
}

export interface CollectionItem {
  target_kind: 'case' | 'resource' | 'result' | 'report';
  target_digest: string;
  target_ref: Record<string, unknown>;
}

export interface Collection {
  id: string;
  project_id: string;
  slug: string;
  name: string;
  description: string;
  created_by_id: string;
  created_at: string;
}

export interface CollectionRevision {
  id: string;
  collection_id: string;
  revision: number;
  digest: string;
  items: CollectionItem[];
  created_at: string;
}

export interface StoredBlob {
  id: string;
  organization_id: string;
  project_id: string;
  digest: string;
  media_type: string;
  size_bytes: number;
  public: boolean;
  expires_at: string | null;
  created_at: string;
}

export interface Report {
  artifact_id: string;
  version_id: string | null;
  draft_id: string | null;
  draft_revision: number | null;
  id: string;
  project_id: string;
  study_run_id: string | null;
  slug: string;
  title: string;
  document: Record<string, unknown>;
  digest: string;
  state: 'draft' | 'frozen';
  created_at: string;
}

export interface Publication {
  version_id: string;
  withdrawn: boolean;
  id: string;
  project_id: string;
  report_id: string;
  slug: string;
  citation: Record<string, unknown>;
  published_at: string;
}

/** One engine of a study definition: the pinned revision, the mode and the optimization the gateway requires of each. */
export interface StudyEngine {
  namespace?: string;
  name?: string;
  version?: string;
  digest?: string;
  mode?: string;
  optimization?: { type: string; scalarization: string };
}

export interface Study {
  archived: boolean;
  id: string;
  definition_version_id: string;
  definition_artifact_id: string;
  project_id: string;
  slug: string;
  name: string;
  description: string;
  definition: {
    case_revision_ids: string[];
    collection_version_id?: string;
    engines: StudyEngine[];
    parameter_sets: Array<Record<string, unknown>>;
    seeds: number[];
  };
  state: string;
  created_by_id: string;
  created_at: string;
}

export interface StudyRun {
  id: string;
  definition_version_id: string;
  study_id: string;
  run_number: number;
  state: RunState;
  matrix_digest: string;
  cells: number;
  summary: Record<string, unknown>;
  created_at: string;
  finished_at: string | null;
}

export interface StudyCell {
  id: string;
  study_run_id: string;
  ordinal: number;
  binding_case_revision_id: string;
  engine_ref: Record<string, string>;
  parameters: Record<string, unknown>;
  seed: number;
  fingerprint: string;
  job_id: string | null;
  state: RunState;
  metrics: Record<string, unknown>;
}

/** What `POST …/cells/{cell}/retry` answers: the cell queued again, and the new job when the gateway named it. */
export interface StudyCellRetry {
  id: string;
  state: RunState;
  fingerprint: string;
  jobId?: string;
  /** The cell had already been retried: nothing new was started. */
  idempotent?: boolean;
}

/** What `POST …/cells/{cell}/result` answers once a finished job is attached as the cell's result. */
export interface StudyCellAttached {
  id: string;
  state: RunState;
  metrics: Record<string, unknown>;
}

export interface CaseComplexity {
  id: string;
  slug: string;
  name: string;
  revision: number;
  cardinality: string;
  log10: number;
  tasks: number;
  breakdown?: Record<string, number>;
}

export interface BindingSpaceAnalytics {
  cardinality: string;
  log10: number;
  tasks: number;
  breakdown?: Record<string, number>;
  case_slug?: string | null;
  case_name?: string | null;
  revision?: number | null;
  cases?: CaseComplexity[];
}

export interface Analytics {
  cells: number;
  completed: number;
  failed: number;
  feasible: number;
  infeasible: number;
  objective_distributions: Record<string, number[]>;
  runtimes_s: number[];
  pareto: Array<Record<string, number>>;
  stability: Record<string, { samples: number; distinct: number; repeatability: number }>;
  binding_space?: BindingSpaceAnalytics | null;
}

export interface Job {
  id: string;
  engine_id: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | string;
  cancellation_requested: boolean;
  retry_of_id: string | null;
  organization_id: string | null;
  project_id: string | null;
  created_at: string;
  finished_at: string | null;
  result?: {
    termination?: string;
    solutions?: Array<{
      decision?: Record<string, unknown>;
      objectives?: Record<string, number>;
    }>;
    provenance?: Record<string, unknown>;
    logs?: string;
    status?: string;
    code?: string;
    error?: string;
    [key: string]: unknown;
  } | null;
  termination?: 'OPTIMAL' | 'FEASIBLE' | 'INFEASIBLE' | 'UNKNOWN' | null;
  options?: Record<string, unknown> | null;
  original_request?: Record<string, unknown> | null;
  provenance?: Record<string, unknown> | null;
}

export interface Snapshot {
  id: string;
  ownerId: string | null;
  instanceDigest: string;
  packageDigest: string;
  archiveSize: number;
  createdAt: string | null;
  ir: {
    id: string;
    digest: string;
    document: Record<string, unknown>;
    sourceMap: Record<string, unknown> | null;
    compilerVersion: string;
    createdAt: string | null;
  } | null;
}

export interface EngineRevision {
  id: string;
  namespace: string;
  name: string;
  version: string;
  digest: string;
  state: string;
  createdAt: string | null;
  document: Record<string, unknown>;
  /**
   * The deployment registered for this revision, if any. The gateway's field names are the ones below
   * (`GET /v1/engines/{namespace}/{name}/revisions/{version}`); the list endpoint sends a shorter summary, so
   * everything but `id` is optional.
   */
  registration: {
    id: string;
    manifestDigest?: string;
    endpoint?: string | null;
    protocolDigest?: string | null;
    openapiDigest?: string | null;
    openapiDocument?: Record<string, unknown> | null;
    verificationReport?: Record<string, unknown> | null;
    verifiedAt?: string | null;
    publicationStatus?: string | null;
    isActive?: boolean;
    /** Names the earlier client used; the gateway does not send them. */
    state?: string;
  } | null;
}

export type PackageFormat = 'zip' | 'json' | 'yaml';

const PACKAGE_CONTENT_TYPES: Record<PackageFormat, string> = {
  zip: 'application/zip', json: 'application/json', yaml: 'application/yaml',
};

/**
 * What the import answers. The contract only says “an object”; the gateway sends
 * `{ imported: { cases: 1, caseRevisions: 2, … }, packageDigest }`, but a screen must not rely on it.
 */
export type PackageImportResult = Record<string, unknown>;

const root = (org: string, project?: string) =>
  `/v1/organizations/${encodeURIComponent(org)}${project ? `/projects/${encodeURIComponent(project)}` : ''}`;

// The mutations of an organization throw on a 422 (a refused submission) instead of handing its body back as if it were the result.
// The report editor, the resource writes and the sponsor proposals are not bound since M9.6.
// [impl->req~frontend-workspace-no-removed-operation-binding~1]
export const platformApi = {
  organizations: () => apiClient.request<Organization[]>('/v1/organizations'),
  /** One organization by slug or id. 403 for an account that is not in it, platform administrators included. */
  organization: (org: string) => apiClient.request<Organization>(root(org)),
  /** `billing_sponsor_user_id` omitted: the parent's sponsor, or the caller for a top-level organization. */
  createOrganization: (value: { slug: string; name: string; parent_id?: string | null; billing_sponsor_user_id?: string | null }) =>
    apiClient.request<Organization>('/v1/organizations', {
      method: 'POST', body: JSON.stringify(value),
    }, undefined, true, true),
  /**
   * Renaming and moving need ADMIN; naming a sponsor needs OWNER, and a user may only name themselves: naming somebody else is a
   * 422 `sponsor_must_be_caller`. The answer is always the organization (200).
   */
  updateOrganization: (org: string, value: {
    name?: string; parent_id?: string | null; move_to_root?: boolean; billing_sponsor_user_id?: string | null;
  }) =>
    apiClient.request<Organization>(root(org), {
      method: 'PATCH', body: JSON.stringify(value),
    }, undefined, true, true),
  deleteOrganization: (org: string) =>
    apiClient.request<void>(root(org), { method: 'DELETE' }, undefined, true, true),
  /** The audit log needs ADMIN. `action` is an exact action name (`organization.member.removed`), filtered by the server. */
  organizationAudit: (org: string, params: { action?: string; offset?: number; limit?: number } = {}) => {
    const query = new URLSearchParams();
    if (params.action) query.set('action', params.action);
    if (params.offset) query.set('offset', String(params.offset));
    if (params.limit) query.set('limit', String(params.limit));
    const suffix = query.toString() ? `?${query}` : '';
    return apiClient.request<OrganizationAuditPage>(`${root(org)}/audit${suffix}`, {}, undefined, true, true);
  },
  members: (org: string) =>
    apiClient.request<OrganizationMember[]>(`${root(org)}/members`),
  updateMember: (org: string, userId: string, role: OrganizationRole) =>
    apiClient.request<OrganizationMember>(`${root(org)}/members/${encodeURIComponent(userId)}`, {
      method: 'PUT', body: JSON.stringify({ user_id: userId, role }),
    }, undefined, true, true),
  /** `POST …/members/batch`: up to {@link MEMBER_BATCH_LIMIT} staged changes, applied together or not at all. Answers with the whole member list. */
  updateMembersBatch: (org: string, changes: MemberChange[]) =>
    apiClient.request<OrganizationMember[]>(`${root(org)}/members/batch`, {
      method: 'POST', body: JSON.stringify({ changes }),
    }, undefined, true, true),
  removeMember: (org: string, userId: string) =>
    apiClient.request<void>(`${root(org)}/members/${encodeURIComponent(userId)}`, { method: 'DELETE' }, undefined, true, true),
  inviteMember: (org: string, value: { email: string; role: OrganizationRole }) =>
    apiClient.request<OrganizationInvitation>(`${root(org)}/invitations`, {
      method: 'POST', body: JSON.stringify(value),
    }, undefined, true, true),
  /**
   * POST /v1/invitations/accept. The token is a secret: it goes in the body only, never in a URL, a log or an error.
   * Answers with the new (or existing) membership; the organization's name is not part of it.
   */
  acceptInvitation: (token: string) =>
    apiClient.request<OrganizationMember>('/v1/invitations/accept', {
      method: 'POST', body: JSON.stringify({ token }),
    }, undefined, true, true),
  projects: (org: string) => apiClient.request<Project[]>(`${root(org)}/projects`),
  /** One project. 404 whether it does not exist or the account is not in its organization. */
  project: (org: string, project: string) => apiClient.request<Project>(root(org, project)),
  /** Needs MEMBER. 409 `slug_conflict`, 402 when the sponsor has no (private) project left, 503 when limits can't be checked. */
  createProject: (org: string, value: { slug: string; name: string; description: string; visibility: Visibility }) =>
    apiClient.request<Project>(`${root(org)}/projects`, {
      method: 'POST', body: JSON.stringify(value),
    }, undefined, true, true),
  /** Needs ADMIN. Making a public project private is a 402 when the sponsor has no private project left. */
  updateProject: (org: string, project: string, value: { name?: string; description?: string; visibility?: Visibility }) =>
    apiClient.request<Project>(root(org, project), {
      method: 'PATCH', body: JSON.stringify(value),
    }, undefined, true, true),
  /** Needs ADMIN. 409 `historical_references` while the project has sealed history. */
  deleteProject: (org: string, project: string) =>
    apiClient.request<void>(root(org, project), { method: 'DELETE' }, undefined, true, true),
  cases: (org: string, project: string) =>
    apiClient.request<BindingCase[]>(`${root(org, project)}/cases`),
  deleteCase: (org: string, project: string, caseSlug: string) =>
    apiClient.request<void>(`${root(org, project)}/cases/${encodeURIComponent(caseSlug)}`, { method: 'DELETE' }),
  case: (org: string, project: string, caseSlug: string) =>
    apiClient.request<BindingCase>(`${root(org, project)}/cases/${encodeURIComponent(caseSlug)}`),
  revisions: (org: string, project: string, bindingCase: string) =>
    apiClient.request<CaseRevision[]>(
      `${root(org, project)}/cases/${encodeURIComponent(bindingCase)}/revisions`,
    ),
  caseRevisions: (org: string, project: string, bindingCase: string) =>
    apiClient.request<CaseRevision[]>(
      `${root(org, project)}/cases/${encodeURIComponent(bindingCase)}/revisions`,
    ),
  /** The project's older resources: library items of kinds the library screens don't own. VIEWER can read. */
  resources: (org: string, project: string) =>
    apiClient.request<ProjectResource[]>(`${root(org, project)}/resources`),
  resourceRevisions: (org: string, project: string, resource: string) =>
    apiClient.request<ProjectResourceRevision[]>(
      `${root(org, project)}/resources/${encodeURIComponent(resource)}/revisions`,
    ),
  collections: (org: string, project: string) =>
    apiClient.request<Collection[]>(`${root(org, project)}/collections`),
  /** One collection by its address. 404 whether it is missing or not in this project. */
  collection: (org: string, project: string, collection: string) =>
    apiClient.request<Collection>(`${root(org, project)}/collections/${encodeURIComponent(collection)}`, {}, undefined, true, true),
  /** Needs MEMBER. 402 when the sponsor has no collection left, 409 `slug_conflict`, 422 for an invalid address or name. */
  createCollection: (org: string, project: string, value: { slug: string; name: string; description: string }) =>
    apiClient.request<Collection>(`${root(org, project)}/collections`, {
      method: 'POST', body: JSON.stringify(value),
    }, undefined, true, true),
  /** Needs MEMBER. */
  updateCollection: (org: string, project: string, collection: string, value: { name?: string; description?: string }) =>
    apiClient.request<Collection>(`${root(org, project)}/collections/${encodeURIComponent(collection)}`, {
      method: 'PATCH', body: JSON.stringify(value),
    }, undefined, true, true),
  /** Needs ADMIN. Takes the collection out of the project; what it pointed to is untouched. */
  deleteCollection: (org: string, project: string, collection: string) =>
    apiClient.request<void>(`${root(org, project)}/collections/${encodeURIComponent(collection)}`, { method: 'DELETE' }, undefined, true, true),
  collectionRevisions: (org: string, project: string, collection: string) =>
    apiClient.request<CollectionRevision[]>(`${root(org, project)}/collections/${encodeURIComponent(collection)}/revisions`),
  /**
   * Needs MEMBER. Only `case` and `resource` items are accepted. 422 for a repeated target (`a collection revision cannot repeat a target`),
   * `invalid_collection_target`, `collection_target_mismatch` (the pinned fingerprint is not the target's) and `unsupported_collection_target`.
   */
  createCollectionRevision: (org: string, project: string, collection: string, items: CollectionItem[]) =>
    apiClient.request<CollectionRevision>(`${root(org, project)}/collections/${encodeURIComponent(collection)}/revisions`, {
      method: 'POST', body: JSON.stringify({ items }),
    }, undefined, true, true),
  studies: (org: string, project: string, includeArchived = false) =>
    apiClient.request<Study[]>(`${root(org, project)}/studies?include_archived=${includeArchived}`),
  /**
   * Needs MEMBER. 402 `quota_exceeded` when the sponsor has no study definition left, 403 `api_key_engine_forbidden`, 409 `slug_conflict`,
   * 422 for an empty or foreign selection (`empty_study_cases`, `foreign_case_revision`, `unavailable_collection`) or a matrix over 10,000 cells (`study_matrix_too_large`).
   */
  createStudy: (org: string, project: string, value: Pick<Study, 'slug' | 'name' | 'description'> & ({ definition: Study['definition'] } | { definition_version_id: string })) =>
    apiClient.request<Study>(`${root(org, project)}/studies`, {
      method: 'POST', body: JSON.stringify(value),
    }, undefined, true, true),
  /** Needs MEMBER. Changing `definition_version_id` picks another sealed version of the same Study artifact. */
  updateStudy: (org: string, project: string, study: string, value: { name?: string; description?: string; definition_version_id?: string; archived?: boolean }) =>
    apiClient.request<Study>(`${root(org, project)}/studies/${encodeURIComponent(study)}`, {
      method: 'PATCH', body: JSON.stringify(value),
    }, undefined, true, true),
  /** Needs ADMIN. 409 `study_history_retained` once the study has runs: archive it instead. */
  deleteStudy: (org: string, project: string, study: string) =>
    apiClient.request<void>(`${root(org, project)}/studies/${encodeURIComponent(study)}`, { method: 'DELETE' }, undefined, true, true),
  reports: (org: string, project: string) =>
    apiClient.request<Report[]>(`${root(org, project)}/reports`),
  /** Withdrawn publications are listed too: `withdrawn` says which. */
  publications: (org: string, project: string) =>
    apiClient.request<Publication[]>(`${root(org, project)}/publications`),
  /** Needs ADMIN. This withdraws: the publication, its link, citation and fingerprint stay; it only leaves the listings. */
  deletePublication: (org: string, project: string, publication: string) =>
    apiClient.request<void>(`${root(org, project)}/publications/${encodeURIComponent(publication)}`, { method: 'DELETE' }, undefined, true, true),
  /** The project's files (content-addressed blobs), newest first. VIEWER can read. */
  artifacts: (org: string, project: string) =>
    apiClient.request<StoredBlob[]>(`${root(org, project)}/blobs`),
  /**
   * Needs MEMBER and, for a key, `artifacts:write`. Uploading the same bytes twice keeps one copy. 402 `storage_quota_exceeded`
   * when the sponsor's storage would run out, 413 `artifact_too_large` above the actor's per-request ceiling.
   */
  uploadArtifact: (org: string, project: string, file: File, makePublic: boolean) =>
    apiClient.request<StoredBlob>(`${root(org, project)}/blobs?public=${makePublic}`, {
      method: 'POST',
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
      body: file,
    }, undefined, true, true),
  downloadArtifact: (org: string, project: string, digest: string) =>
    apiClient.requestBinary(`${root(org, project)}/blobs/${encodeURIComponent(digest)}`),
  /** Needs ADMIN. */
  deleteArtifact: (org: string, project: string, digest: string) =>
    apiClient.request<void>(`${root(org, project)}/blobs/${encodeURIComponent(digest)}`, { method: 'DELETE' }, undefined, true, true),
  projectJobs: (org: string, project: string, jobId?: string) =>
    apiClient.request<Job[]>(`${root(org, project)}/jobs?${jobId ? `job_id=${encodeURIComponent(jobId)}` : 'include_results=false'}`),
  snapshot: (id: string) =>
    apiClient.request<Snapshot>(`/v1/snapshots/${encodeURIComponent(id)}`),
  snapshotArchive: (id: string) =>
    apiClient.requestBinary(`/v1/snapshots/${encodeURIComponent(id)}/archive`),
  engineRevisions: () =>
    apiClient.request<{ revisions: EngineRevision[] }>('/v1/engines/revisions'),
  engineRevision: (namespace: string, name: string, version: string) =>
    apiClient.request<EngineRevision>(`/v1/engines/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/revisions/${encodeURIComponent(version)}`),
  /** `GET …/package?format=`: the bytes of a ZIP, JSON or YAML package (the content is for a file, never for the page). */
  exportPackage: (org: string, project: string, format: PackageFormat = 'zip') =>
    apiClient.requestBinary(`${root(org, project)}/package?format=${format}`),
  /**
   * `POST …/package`: the raw bytes of a ZIP, JSON or YAML package, checked digest by digest by the gateway. Needs MEMBER
   * and `projects:write`. The answer is untyped in the contract; read it with `packageImportCounts`.
   */
  importPackage: (org: string, project: string, file: Blob, format: PackageFormat = 'zip') =>
    apiClient.request<PackageImportResult>(`${root(org, project)}/package`, {
      method: 'POST',
      headers: { 'Content-Type': PACKAGE_CONTENT_TYPES[format] },
      body: file,
    }, undefined, true, true),
  studyRuns: (org: string, project: string, study: string) =>
    apiClient.request<StudyRun[]>(`${root(org, project)}/studies/${encodeURIComponent(study)}/runs`),
  studyCells: (org: string, project: string, study: string, run: string) =>
    apiClient.request<StudyCell[]>(
      `${root(org, project)}/studies/${encodeURIComponent(study)}/runs/${encodeURIComponent(run)}/cells`,
    ),
  /** One cell of a run. 404 whether the cell is missing or belongs to another run. */
  studyCell: (org: string, project: string, study: string, run: string, cell: string) =>
    apiClient.request<StudyCell>(
      `${root(org, project)}/studies/${encodeURIComponent(study)}/runs/${encodeURIComponent(run)}/cells/${encodeURIComponent(cell)}`,
      {}, undefined, true, true,
    ),
  analytics: (org: string, project: string, study: string, run: string) =>
    apiClient.request<Analytics>(
      `${root(org, project)}/studies/${encodeURIComponent(study)}/runs/${encodeURIComponent(run)}/analytics`,
    ),
  /**
   * Needs MEMBER. 202 with the new run. 402 `quota_exceeded`, 429 `concurrency_limit_exceeded`, 403 `feature_not_entitled`
   * or `api_key_engine_forbidden`, 409 `study_archived` or `evidence_only_study`, 503 `pricing_unavailable`.
   */
  runStudy: (org: string, project: string, study: string, version: string) =>
    apiClient.request<StudyRun>(
      `${root(org, project)}/studies/${encodeURIComponent(study)}/runs?definition_version_id=${encodeURIComponent(version)}`,
      { method: 'POST' }, undefined, true, true,
    ),
  /** Needs MEMBER. 409 `sealed_evidence` when a sealed report cites the run, 409 `terminal_run` once it ended. */
  cancelStudyRun: (org: string, project: string, study: string, run: string) =>
    apiClient.request<StudyRun>(
      `${root(org, project)}/studies/${encodeURIComponent(study)}/runs/${encodeURIComponent(run)}/cancel`,
      { method: 'POST' }, undefined, true, true,
    ),
  /** Needs MEMBER. Only failed or cancelled cells: 409 `cell_not_retryable` otherwise, 409 `sealed_evidence`, 422 when the cell can't be launched again. */
  retryStudyCell: (org: string, project: string, study: string, run: string, cell: string) =>
    apiClient.request<StudyCellRetry>(
      `${root(org, project)}/studies/${encodeURIComponent(study)}/runs/${encodeURIComponent(run)}/cells/${encodeURIComponent(cell)}/retry`,
      { method: 'POST' }, undefined, true, true,
    ),
  /** Needs MEMBER. Attaches a finished job of the caller as the cell's result: 404 for a job that isn't theirs, 409 `job_not_finished`, 409 `sealed_evidence`. */
  attachStudyCellResult: (org: string, project: string, study: string, run: string, cell: string, jobId: string) =>
    apiClient.request<StudyCellAttached>(
      `${root(org, project)}/studies/${encodeURIComponent(study)}/runs/${encodeURIComponent(run)}/cells/${encodeURIComponent(cell)}/result`,
      { method: 'POST', body: JSON.stringify({ job_id: jobId }) }, undefined, true, true,
    ),
  publicProjects: () => apiClient.request<Array<{
    organization: { slug: string; name: string };
    project: { slug: string; name: string; description: string };
  }>>('/v1/explore/projects'),
  publicPublications: () => apiClient.request<PublicPublication[]>('/v1/explore/publications'),
  /** `POST /v1/verifier/inspect` with the request the contract defines (`digest`, `document`). A 422 throws; 401 ends the session. */
  verifierCheck: (payload: VerifierCheckRequest) =>
    apiClient.request<VerifierVerdict>('/v1/verifier/inspect', {
      method: 'POST', body: JSON.stringify(payload),
    }, undefined, true, true),
  /** `POST /v1/verifier/inspect-file`: the raw bytes of a file, hashed by the gateway. 413 when the file is too large, 422 for a refused body. */
  verifierCheckFile: (file: Blob, filename: string) =>
    apiClient.request<VerifierVerdict>('/v1/verifier/inspect-file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(filename) },
      body: file,
    }, undefined, true, true),
  /** A 422 (a fingerprint that is not one) is a result here: the screen words it from the body ({@link asResolved}). */
  resolveElement: (kind: string, digest: string, limit = 20, offset = 0) =>
    apiClient.request<ResolveResponse>(
      `/v1/resolve/${encodeURIComponent(kind)}/${encodeURIComponent(digest)}?limit=${limit}&offset=${offset}`,
      { method: 'GET' }, undefined, true, false,
    ),
  resolveContentUrl: (kind: string, digest: string) =>
    `/v1/resolve/${encodeURIComponent(kind)}/${encodeURIComponent(digest)}/content`,
  /** The raw bytes of a resolved element, fetched with the caller's session so private content stays private. */
  resolveContent: (kind: string, digest: string) =>
    apiClient.requestBinary(`/v1/resolve/${encodeURIComponent(kind)}/${encodeURIComponent(digest)}/content`),
};

/**
 * One row of GET /v1/explore/publications. Only public, non-withdrawn publications are listed; the
 * organization and project are slugs, and `citation` is whatever the publisher recorded, so every field is optional.
 */
export interface PublicPublication {
  slug?: string;
  citation?: Record<string, unknown> | null;
  report?: { title?: string; digest?: string; version_id?: string } | null;
  project?: string;
  organization?: string;
  publishedAt?: string | null;
  [key: string]: unknown;
}

export interface ResolveOrganizationRef {
  id: string;
  slug: string;
  name: string;
}

export interface ResolveProjectRef {
  id: string;
  slug: string;
  name: string;
  visibility: string;
}

export interface ResolveAuthorRef {
  id: string;
  username?: string | null;
  email?: string | null;
}

export interface ResolveLocation {
  organization?: ResolveOrganizationRef | null;
  project?: ResolveProjectRef | null;
  element_id: string;
  slug?: string | null;
  version_or_revision?: string | number | null;
  created_at?: string | null;
  web_url?: string | null;
}

export interface ResolvePagination {
  total: number;
  limit: number;
  offset: number;
  has_more: boolean;
}

export interface ResolveResponse {
  verified: boolean;
  kind: string;
  digest: string;
  canonical_name?: string | null;
  media_type: string;
  size_bytes?: number | null;
  created_at?: string | null;
  author?: ResolveAuthorRef | null;
  document?: Record<string, unknown> | unknown[] | null;
  content_url: string;
  locations: ResolveLocation[];
  pagination: ResolvePagination;
  citation?: ReplicationCitation | null;
}

export interface ReplicationCitation {
  title?: string;
  authors?: string[];
  year?: number;
  doi?: string | null;
  venue?: string | null;
  url?: string | null;
  bibtex: string;
  markdown_badge: string;
  uri?: string;
}

/** What `POST /v1/verifier/inspect` accepts (`VerifierInspectRequest` of the contract): a digest, a document, or both to compare them. */
export interface VerifierCheckRequest {
  digest?: string | null;
  document?: unknown;
  kind?: string | null;
  entity_id?: string | null;
}

export type VerifierStatus = 'verified' | 'computed' | 'mismatch' | 'not_found';

/** One element the gateway recorded with the fingerprint (`VerifierEntityMatch`). `entity_type` is `case`, `snapshot`, `collection`, `report`, `artifact`, `engine` or `study_run`. */
export interface VerifierEntity {
  entity_type: string;
  id: string;
  slug?: string | null;
  title_or_name?: string | null;
  organization_slug?: string | null;
  project_slug?: string | null;
  revision?: number | null;
  created_at?: string | null;
}

/** The answer of the verifier (`VerifierInspectResponse` of the contract). */
export interface VerifierVerdict {
  status: VerifierStatus;
  digest: string;
  matches: boolean;
  verified_at: string;
  detail?: string | null;
  canonical_json?: string | null;
  entities?: VerifierEntity[];
  citation?: ReplicationCitation | null;
}
