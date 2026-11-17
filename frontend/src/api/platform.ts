import type { AnalyticsView } from '../modules/core/api/types';
import { apiClient, type Revised } from './client';

export type RunState = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'partial';

export interface Organization {
  id: string;
  slug: string;
  name: string;
  parent_id: string | null;
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
 * One exact engine of a study: the pinned revision, the mode and the optimization the gateway requires of each, the options every cell
 * of it runs with, and the run preset it came from (`{id, slug}`, set by a run that expanded one; `null` otherwise).
 */
export interface ExactStudyEngine {
  namespace?: string;
  name?: string;
  version?: string;
  digest?: string;
  mode?: string;
  optimization?: {
    type: string;
    scalarization: string;
    weights?: Array<{ criteria: string; value: number }>;
  };
  options?: Record<string, unknown>;
  preset?: { id: string; slug: string } | null;
}

/** An engine of a study named by a run preset of the organization (its slug or id): each run expands it into an exact engine. */
export interface PresetStudyEngine {
  preset: string;
}

/** One engine of a study definition (`StudyDefinition.engines[]`): an exact engine, or a run preset each run expands. */
export type StudyEngine = ExactStudyEngine | PresetStudyEngine;

/** The editable matrix of a study: problem revisions of its organization, engines (exact or from a preset), parameter sets and seeds. */
export interface StudyDefinition {
  revision_ids: string[];
  engines: StudyEngine[];
  parameter_sets: Array<Record<string, unknown>>;
  seeds: number[];
}

export interface Study {
  archived: boolean;
  id: string;
  organization_id: string;
  slug: string;
  name: string;
  description: string;
  /** The current matrix. Edit it with `updateStudy`; every run keeps the copy it froze. */
  definition: StudyDefinition;
  definition_digest: string;
  state: string;
  created_by_id: string;
  created_at: string;
}

/** One problem revision of a study run, with the compilation every cell of it runs. */
export interface StudyRunProblem {
  revisionId: string;
  problemId: string;
  revision: number;
  packageDigest: string;
  compilationId: string;
  compilationDigest: string;
  irDigest: string;
}

/** The definition a study run froze when it started (`openbinding/study-run/v1`): every engine exact, with its options and the preset it came from. */
export interface StudyRunDefinition {
  apiVersion: string;
  problems: StudyRunProblem[];
  engines: ExactStudyEngine[];
  parameterSets: Array<Record<string, unknown>>;
  seeds: number[];
}

export interface StudyRun {
  id: string;
  study_id: string;
  run_number: number;
  state: RunState;
  matrix_digest: string;
  definition: StudyRunDefinition;
  definition_digest: string;
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
  compilation_id: string;
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

/** How repeatable one engine was across the seeds of a study run. */
export interface EngineStability {
  samples: number;
  distinct: number;
  repeatability: number;
}

/**
 * The analytics of a study run: the generated `AnalyticsView` (its `pareto` fronts included), with the two members the schema
 * leaves open (`stability`, `binding_space`) read as the gateway writes them.
 */
export type Analytics = Omit<AnalyticsView, 'stability' | 'binding_space'> & {
  stability: Record<string, EngineStability>;
  binding_space?: BindingSpaceAnalytics | null;
};

/** The formats a study run is exported in (`exportStudyRun`). */
export type StudyRunExportFormat = 'csv' | 'json';

/** A study run exported by the gateway: the bytes, the file name its `Content-Disposition` gives and their media type. */
export interface StudyRunFile {
  bytes: ArrayBuffer;
  fileName: string;
  mediaType: string;
}

/** The file name a `Content-Disposition` header names (`filename*=UTF-8''…` or `filename="…"`), or `fallback`. */
export function attachmentName(header: string | null, fallback: string): string {
  if (!header) return fallback;
  const encoded = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(header);
  if (encoded) {
    try {
      return decodeURIComponent(encoded[1].trim());
    } catch {
      // A malformed escape falls through to the plain name.
    }
  }
  const plain = /filename\s*=\s*(?:"([^"]*)"|([^;\s]+))/.exec(header);
  const name = plain ? (plain[1] ?? plain[2] ?? '').trim() : '';
  return name || fallback;
}

export interface JobOrganizationRef {
  id: string;
  slug: string;
}
export interface JobProblemRef {
  id: string;
  slug: string;
  name: string;
}
export interface JobRevisionRef {
  id: string;
  revision: number;
}
export interface JobCompilationRef {
  id: string;
  compilation_digest: string;
  ir_digest: string;
}
/** The member who launched (or retried) a run. */
export interface JobCreatorRef {
  id: string;
  username: string;
}

export interface Job {
  id: string;
  engine_id: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | string;
  cancellation_requested: boolean;
  retry_of_id: string | null;
  organization_id: string;
  /** What the run is of: the organization, problem, revision and compilation it names. */
  organization?: JobOrganizationRef | null;
  problem?: JobProblemRef | null;
  revision?: JobRevisionRef | null;
  compilation?: JobCompilationRef | null;
  /** Who launched it. */
  created_by?: JobCreatorRef | null;
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

const root = (org: string) => `/v1/organizations/${encodeURIComponent(org)}`;

// The mutations of an organization throw on a 422 (a refused submission) instead of handing its body back as if it were the result.
// The report editor and the resource writes are not bound since M9.6.
export const platformApi = {
  organizations: () => apiClient.request<Organization[]>('/v1/organizations'),
  /** One organization by slug or id. 403 for an account that is not in it, platform administrators included. */
  organization: (org: string) => apiClient.request<Organization>(root(org)),
  createOrganization: (value: { slug: string; name: string; parent_id?: string | null }) =>
    apiClient.request<Organization>(
      '/v1/organizations',
      {
        method: 'POST',
        body: JSON.stringify(value),
      },
      undefined,
      true,
      true
    ),
  /** Renaming and moving need ADMIN. The answer is always the organization (200). */
  updateOrganization: (
    org: string,
    value: {
      name?: string;
      parent_id?: string | null;
      move_to_root?: boolean;
    }
  ) =>
    apiClient.request<Organization>(
      root(org),
      {
        method: 'PATCH',
        body: JSON.stringify(value),
      },
      undefined,
      true,
      true
    ),
  deleteOrganization: (org: string) =>
    apiClient.request<void>(root(org), { method: 'DELETE' }, undefined, true, true),
  /** The audit log needs ADMIN. `action` is an exact action name (`organization.member.removed`), filtered by the server. */
  organizationAudit: (
    org: string,
    params: { action?: string; offset?: number; limit?: number } = {}
  ) => {
    const query = new URLSearchParams();
    if (params.action) query.set('action', params.action);
    if (params.offset) query.set('offset', String(params.offset));
    if (params.limit) query.set('limit', String(params.limit));
    const suffix = query.toString() ? `?${query}` : '';
    return apiClient.request<OrganizationAuditPage>(
      `${root(org)}/audit${suffix}`,
      {},
      undefined,
      true,
      true
    );
  },
  members: (org: string) => apiClient.request<OrganizationMember[]>(`${root(org)}/members`),
  updateMember: (org: string, userId: string, role: OrganizationRole) =>
    apiClient.request<OrganizationMember>(
      `${root(org)}/members/${encodeURIComponent(userId)}`,
      {
        method: 'PUT',
        body: JSON.stringify({ user_id: userId, role }),
      },
      undefined,
      true,
      true
    ),
  /** `POST …/members/batch`: up to {@link MEMBER_BATCH_LIMIT} staged changes, applied together or not at all. Answers with the whole member list. */
  updateMembersBatch: (org: string, changes: MemberChange[]) =>
    apiClient.request<OrganizationMember[]>(
      `${root(org)}/members/batch`,
      {
        method: 'POST',
        body: JSON.stringify({ changes }),
      },
      undefined,
      true,
      true
    ),
  removeMember: (org: string, userId: string) =>
    apiClient.request<void>(
      `${root(org)}/members/${encodeURIComponent(userId)}`,
      { method: 'DELETE' },
      undefined,
      true,
      true
    ),
  studies: (org: string, includeArchived = false) =>
    apiClient.request<Study[]>(`${root(org)}/studies?include_archived=${includeArchived}`),
  /** One study with its ETag: the revision an edit names as `If-Match`. 404 for a study of another organization. */
  study: (org: string, study: string) =>
    apiClient.request<Revised<Study>>(
      `${root(org)}/studies/${encodeURIComponent(study)}`,
      {},
      undefined,
      true,
      true,
      async response => ({
        value: (await response.json()) as Study,
        etag: response.headers.get('ETag'),
      })
    ),
  /**
   * Needs MEMBER. 403 `api_key_engine_forbidden`, 409 `slug_conflict`,
   * 422 for a revision of another organization (`foreign_case_revision`) or a matrix over 10,000 cells (`study_matrix_too_large`).
   */
  createStudy: (org: string, value: Pick<Study, 'slug' | 'name' | 'description' | 'definition'>) =>
    apiClient.request<Study>(
      `${root(org)}/studies`,
      {
        method: 'POST',
        body: JSON.stringify(value),
      },
      undefined,
      true,
      true
    ),
  /**
   * Needs MEMBER. `definition` replaces the current matrix (runs keep the copy they froze). With `ifMatch` the edit is
   * refused with 412 `precondition_failed` when the study changed since it was read; the answer carries the new ETag.
   */
  updateStudy: (
    org: string,
    study: string,
    value: {
      name?: string;
      description?: string;
      archived?: boolean;
      definition?: StudyDefinition;
    },
    ifMatch: string | null = null
  ) =>
    apiClient.request<Revised<Study>>(
      `${root(org)}/studies/${encodeURIComponent(study)}`,
      {
        method: 'PATCH',
        body: JSON.stringify(value),
        ...(ifMatch ? { headers: { 'If-Match': ifMatch } } : {}),
      },
      undefined,
      true,
      true,
      async response => ({
        value: (await response.json()) as Study,
        etag: response.headers.get('ETag'),
      })
    ),
  /** Needs ADMIN. 409 `study_history_retained` once the study has runs: archive it instead. */
  deleteStudy: (org: string, study: string) =>
    apiClient.request<void>(
      `${root(org)}/studies/${encodeURIComponent(study)}`,
      { method: 'DELETE' },
      undefined,
      true,
      true
    ),
  engineRevisions: () =>
    apiClient.request<{ revisions: EngineRevision[] }>('/v1/engines/revisions'),
  engineRevision: (namespace: string, name: string, version: string) =>
    apiClient.request<EngineRevision>(
      `/v1/engines/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/revisions/${encodeURIComponent(version)}`
    ),
  studyRuns: (org: string, study: string) =>
    apiClient.request<StudyRun[]>(`${root(org)}/studies/${encodeURIComponent(study)}/runs`),
  /** One run with the definition it froze and that definition's digest. */
  studyRun: (org: string, study: string, run: string) =>
    apiClient.request<StudyRun>(
      `${root(org)}/studies/${encodeURIComponent(study)}/runs/${encodeURIComponent(run)}`,
      {},
      undefined,
      true,
      true
    ),
  studyCells: (org: string, study: string, run: string) =>
    apiClient.request<StudyCell[]>(
      `${root(org)}/studies/${encodeURIComponent(study)}/runs/${encodeURIComponent(run)}/cells`
    ),
  /** One cell of a run. 404 whether the cell is missing or belongs to another run. */
  studyCell: (org: string, study: string, run: string, cell: string) =>
    apiClient.request<StudyCell>(
      `${root(org)}/studies/${encodeURIComponent(study)}/runs/${encodeURIComponent(run)}/cells/${encodeURIComponent(cell)}`,
      {},
      undefined,
      true,
      true
    ),
  analytics: (org: string, study: string, run: string) =>
    apiClient.request<Analytics>(
      `${root(org)}/studies/${encodeURIComponent(study)}/runs/${encodeURIComponent(run)}/analytics`
    ),
  /**
   * The whole study run as one file (VIEWER): CSV with one row per cell, or JSON with the frozen definition and every cell. It is
   * fetched with the session's credentials and handed back as bytes, named as the gateway's `Content-Disposition` names it.
   */
  exportStudyRun: (org: string, study: string, run: string, format: StudyRunExportFormat) =>
    apiClient.request<StudyRunFile>(
      `${root(org)}/studies/${encodeURIComponent(study)}/runs/${encodeURIComponent(run)}/export?format=${format}`,
      {},
      undefined,
      true,
      true,
      async response => ({
        bytes: await response.arrayBuffer(),
        fileName: attachmentName(
          response.headers.get('Content-Disposition'),
          `${study}-run.${format}`
        ),
        mediaType:
          response.headers.get('Content-Type') ??
          (format === 'csv' ? 'text/csv' : 'application/json'),
      })
    ),
  /**
   * Needs MEMBER. Freezes the study's current definition into a new run: 202 with it. 402 `quota_exceeded`,
   * 429 `concurrency_limit_exceeded`, 403 `feature_not_entitled` or `api_key_engine_forbidden`, 409 `study_archived`,
   * 422 `foreign_case_revision` or `revision_not_recompilable`, 503 `pricing_unavailable`.
   */
  runStudy: (org: string, study: string) =>
    apiClient.request<StudyRun>(
      `${root(org)}/studies/${encodeURIComponent(study)}/runs`,
      { method: 'POST' },
      undefined,
      true,
      true
    ),
  /** Needs MEMBER. 409 `terminal_run` once it ended. */
  cancelStudyRun: (org: string, study: string, run: string) =>
    apiClient.request<StudyRun>(
      `${root(org)}/studies/${encodeURIComponent(study)}/runs/${encodeURIComponent(run)}/cancel`,
      { method: 'POST' },
      undefined,
      true,
      true
    ),
  /** Needs MEMBER. Only failed or cancelled cells: 409 `cell_not_retryable` otherwise, 422 when the cell can't be launched again. */
  retryStudyCell: (org: string, study: string, run: string, cell: string) =>
    apiClient.request<StudyCellRetry>(
      `${root(org)}/studies/${encodeURIComponent(study)}/runs/${encodeURIComponent(run)}/cells/${encodeURIComponent(cell)}/retry`,
      { method: 'POST' },
      undefined,
      true,
      true
    ),
  /** Needs MEMBER. Attaches a finished run of the organization as the cell's result: 404 for a run of another organization, 409 `job_not_finished`. */
  attachStudyCellResult: (org: string, study: string, run: string, cell: string, jobId: string) =>
    apiClient.request<StudyCellAttached>(
      `${root(org)}/studies/${encodeURIComponent(study)}/runs/${encodeURIComponent(run)}/cells/${encodeURIComponent(cell)}/result`,
      { method: 'POST', body: JSON.stringify({ job_id: jobId }) },
      undefined,
      true,
      true
    ),
};
