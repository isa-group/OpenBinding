// Pattern only, after SPHERE frontend/src/modules/profile/api/pricingCollectionsApi.ts (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: OpenBinding's studies (`/v1/organizations/{org}/studies/…`) instead of SPHERE's collections. The list is
// `useStudiesApi()` over `useAuth().fetchWithInterceptor`, paged by the gateway (`limit`, `offset`, `X-Total-Count`); the
// operations the study page and the create form need are the plain `studiesApi` object over the shared client, as the
// composition module keeps its own (`core/utils/composition/api.ts`). Refusals throw the typed error `readApiError` reads.

import { useCallback, useMemo } from 'react';
import { apiClient, type Revised } from '../../../api/client';
import { readResponse } from '../../core/api/http';
import type { AnalyticsView } from '../../core/api/types';
import { useAuth } from '../../auth/hooks/useAuth';

export type RunState = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'partial';

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
  /** The current matrix. Edit it with `update`; every run keeps the copy it froze. */
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

/** The formats a study run is exported in (`exportRun`). */
export type StudyRunExportFormat = 'csv' | 'json';

/** A study run exported by the gateway: the bytes, the file name its `Content-Disposition` gives and their media type. */
export interface StudyRunFile {
  bytes: ArrayBuffer;
  fileName: string;
  mediaType: string;
}

/** What a study edit may change. */
export interface StudyUpdate {
  name?: string;
  description?: string;
  archived?: boolean;
  definition?: StudyDefinition;
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

const enc = encodeURIComponent;
const studiesRoot = (org: string) => `/v1/organizations/${enc(org)}/studies`;
const studyRoot = (org: string, study: string) => `${studiesRoot(org)}/${enc(study)}`;
const runRoot = (org: string, study: string, run: string) =>
  `${studyRoot(org, study)}/runs/${enc(run)}`;

const revised = async (response: Response): Promise<Revised<Study>> => ({
  value: (await response.json()) as Study,
  etag: response.headers.get('ETag'),
});

/** The operations on one study, its runs and its cells. */
export const studiesApi = {
  /** One study with its ETag: the revision an edit names as `If-Match`. 404 for a study of another organization. */
  get: (org: string, study: string) =>
    apiClient.request<Revised<Study>>(studyRoot(org, study), {}, undefined, true, true, revised),
  /**
   * Needs MEMBER. 403 `api_key_engine_forbidden`, 409 `slug_conflict`,
   * 422 for a revision of another organization (`foreign_case_revision`) or a matrix over 10,000 cells (`study_matrix_too_large`).
   */
  create: (org: string, value: Pick<Study, 'slug' | 'name' | 'description' | 'definition'>) =>
    apiClient.request<Study>(studiesRoot(org), { method: 'POST', body: JSON.stringify(value) }),
  /**
   * Needs MEMBER. `definition` replaces the current matrix (runs keep the copy they froze). With `ifMatch` the edit is
   * refused with 412 `precondition_failed` when the study changed since it was read; the answer carries the new ETag.
   */
  update: (org: string, study: string, value: StudyUpdate, ifMatch: string | null = null) =>
    apiClient.request<Revised<Study>>(
      studyRoot(org, study),
      {
        method: 'PATCH',
        body: JSON.stringify(value),
        ...(ifMatch ? { headers: { 'If-Match': ifMatch } } : {}),
      },
      undefined,
      true,
      true,
      revised
    ),
  /** Needs ADMIN. 409 `study_history_retained` once the study has runs: archive it instead. */
  remove: (org: string, study: string) =>
    apiClient.request<void>(studyRoot(org, study), { method: 'DELETE' }),
  runs: (org: string, study: string) =>
    apiClient.request<StudyRun[]>(`${studyRoot(org, study)}/runs`),
  /** One run with the definition it froze and that definition's digest. */
  run: (org: string, study: string, run: string) =>
    apiClient.request<StudyRun>(runRoot(org, study, run)),
  cells: (org: string, study: string, run: string) =>
    apiClient.request<StudyCell[]>(`${runRoot(org, study, run)}/cells`),
  /** One cell of a run. 404 whether the cell is missing or belongs to another run. */
  cell: (org: string, study: string, run: string, cell: string) =>
    apiClient.request<StudyCell>(`${runRoot(org, study, run)}/cells/${enc(cell)}`),
  analytics: (org: string, study: string, run: string) =>
    apiClient.request<Analytics>(`${runRoot(org, study, run)}/analytics`),
  /**
   * The whole study run as one file (VIEWER): CSV with one row per cell, or JSON with the frozen definition and every cell,
   * named as the gateway's `Content-Disposition` names it.
   */
  exportRun: (org: string, study: string, run: string, format: StudyRunExportFormat) =>
    apiClient.request<StudyRunFile>(
      `${runRoot(org, study, run)}/export?format=${format}`,
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
  start: (org: string, study: string) =>
    apiClient.request<StudyRun>(`${studyRoot(org, study)}/runs`, { method: 'POST' }),
  /** Needs MEMBER. 409 `terminal_run` once it ended. */
  cancel: (org: string, study: string, run: string) =>
    apiClient.request<StudyRun>(`${runRoot(org, study, run)}/cancel`, { method: 'POST' }),
  /** Needs MEMBER. Only failed or cancelled cells: 409 `cell_not_retryable` otherwise, 422 when the cell can't be launched again. */
  retryCell: (org: string, study: string, run: string, cell: string) =>
    apiClient.request<StudyCellRetry>(`${runRoot(org, study, run)}/cells/${enc(cell)}/retry`, {
      method: 'POST',
    }),
  /** Needs MEMBER. Attaches a finished run of the organization as the cell's result: 404 for a run of another organization, 409 `job_not_finished`. */
  attachResult: (org: string, study: string, run: string, cell: string, jobId: string) =>
    apiClient.request<StudyCellAttached>(`${runRoot(org, study, run)}/cells/${enc(cell)}/result`, {
      method: 'POST',
      body: JSON.stringify({ job_id: jobId }),
    }),
};

/** One page of an organization's studies, and how many there are in all. */
export interface StudyPage {
  studies: Study[];
  total: number;
}

export function useStudiesApi() {
  const { fetchWithInterceptor } = useAuth();

  /**
   * An organization's studies, newest first, a page at a time (`GET …/studies?include_archived=&limit=&offset=`); the
   * gateway says how many there are in all in `X-Total-Count`.
   */
  const getOrganizationStudies = useCallback(
    async (
      org: string,
      params: { archived: boolean; limit: number; offset: number },
      signal?: AbortSignal
    ): Promise<StudyPage> => {
      const search = new URLSearchParams({
        include_archived: String(params.archived),
        limit: String(params.limit),
        offset: String(params.offset),
      });
      const response = await fetchWithInterceptor(`${studiesRoot(org)}?${search}`, { signal });
      const studies = await readResponse<Study[]>(response);
      const header = Number(response.headers.get('X-Total-Count'));
      return {
        studies,
        total: Number.isFinite(header) && header > 0 ? header : studies.length + params.offset,
      };
    },
    [fetchWithInterceptor]
  );

  /** The runs of a study (`GET …/runs`), for the run pill and the cell bar of a card. */
  const getStudyRuns = useCallback(
    async (org: string, study: string, signal?: AbortSignal) =>
      readResponse<StudyRun[]>(
        await fetchWithInterceptor(`${studyRoot(org, study)}/runs`, { signal })
      ),
    [fetchWithInterceptor]
  );

  /** The cells of one run (`GET …/runs/{run}/cells`). */
  const getRunCells = useCallback(
    async (org: string, study: string, run: string, signal?: AbortSignal) =>
      readResponse<StudyCell[]>(
        await fetchWithInterceptor(`${runRoot(org, study, run)}/cells`, { signal })
      ),
    [fetchWithInterceptor]
  );

  return useMemo(
    () => ({ getOrganizationStudies, getStudyRuns, getRunCells }),
    [getOrganizationStudies, getStudyRuns, getRunCells]
  );
}
