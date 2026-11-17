import type { ImmutableResourceRef, NeighborhoodResponse } from '../../core/api/types';
import { apiClient } from '../../core/api/http';

const enc = encodeURIComponent;

export type JobState = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

/** One solution of a result, as the gateway re-evaluated it. */
export interface JobSolution {
  decision?: {
    kind?: string;
    binding?: Record<string, { resource?: string; id?: string }>;
  } & Record<string, unknown>;
  metrics?: Record<string, number>;
  features?: Record<string, unknown>;
  objectives?: {
    type?: string;
    scalarization?: string;
    components?: Array<Record<string, unknown>>;
    penalty?: number;
    score?: number | number[];
  } & Record<string, unknown>;
  penalties?: number[];
  violations?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

export interface JobResultView {
  termination?: string | null;
  solutions?: JobSolution[];
  provenance?: Record<string, unknown>;
  error?: string;
  code?: string;
  logs?: string;
  [key: string]: unknown;
}

/**
 * `GET /v1/organizations/{org}/runs/{run}` (`getRun`): one run of the organization, as a member reads it (redacted below MEMBER).
 * `remote` is what the engine reported about itself; `error` repeats the result's error of a failed run.
 */
export interface JobDetail extends Partial<Omit<Job, 'id' | 'status' | 'provenance' | 'result'>> {
  id: string;
  status: JobState | string;
  provenance: Record<string, unknown>;
  result?: JobResultView | null;
  error?: string | null;
  remote?: Record<string, unknown>;
  /** What the run is of: the organization, problem, revision and compilation it names. */
  organization?: JobOrganizationRef;
  problem?: JobProblemRef;
  revision?: JobRevisionRef;
  compilation?: JobCompilationRef;
}

/** `202` from `createRun`. `idempotent` is set when the same one-time key had already started this run. */
export interface JobReceipt {
  id: string;
  status: string;
  irDigest?: string;
  profile?: string;
  idempotent?: boolean;
}

/** `GET /v1/organizations/{org}/runs` (`listRuns`): a page of the organization's runs, newest first, summaries only. */
export interface RunList {
  runs: Job[];
  total: number;
}

/** The filters of `listRuns`. */
export interface RunFilters {
  state?: JobState;
  problem?: string;
  revision?: string;
  engine?: string;
  limit?: number;
  offset?: number;
}

/**
 * The optimization an execution selects (`optimization` of `createRun`). The gateway answers 422 `optimization_required` without it;
 * weights are left out and the toolchain fills equal ones where the scalarization needs them.
 */
export type ExecutionOptimization = {
  type: 'SINGLE' | 'MULTI' | 'MANY';
  scalarization: string;
};

/** What `createRun` takes for settings chosen by hand: a revision of the organization's problem and one exact engine mode with its options and optimization. */
export interface EngineLaunchRequest {
  revision: string;
  engine: ImmutableResourceRef;
  registration?: ImmutableResourceRef;
  mode: string;
  options: Record<string, unknown>;
  optimization?: ExecutionOptimization;
}

/** What `createRun` takes for a run started from a run preset of the organization: the revision and the preset, which carries every setting. */
export interface PresetLaunchRequest {
  revision: string;
  /** The preset's slug or id; the gateway refuses it beside any setting of its own (`preset_with_settings`). */
  preset: string;
}

export type LaunchRequest = EngineLaunchRequest | PresetLaunchRequest;

/** The runs of an organization: `/v1/organizations/{org}/runs`. */
export const runsPath = (org: string): string => `/v1/organizations/${enc(org)}/runs`;

/** One run of an organization: `/v1/organizations/{org}/runs/{run}`. */
export const runPath = (org: string, run: string): string => `${runsPath(org)}/${enc(run)}`;

function query(filters: RunFilters): string {
  const values = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== '') values.set(key, String(value));
  }
  const text = values.toString();
  return text ? `?${text}` : '';
}

/**
 * The calls of the run screens. A run belongs to its organization: every member reads it (redacted below MEMBER), MEMBER and above
 * launch, cancel and retry it, and everyone else gets a 404. The mutations throw on a 422 (a refused submission) instead of handing its
 * body back as if it were the result, and `create` carries the one-time key that makes sending twice by accident start one run.
 */
export const runsApi = {
  /** The organization's runs, newest first (at most 200 a page). */
  list: (org: string, filters: RunFilters = {}) =>
    apiClient.request<RunList>(`${runsPath(org)}${query(filters)}`),
  /** 404 for anyone outside the organization, platform administrators included. */
  get: (org: string, run: string) =>
    apiClient.request<JobDetail>(runPath(org, run), {}, undefined, true, true),
  /** Needs MEMBER. 402, 403, 404, 409, 422, 429 and 503 each say why nothing started. */
  create: (org: string, request: LaunchRequest, idempotencyKey: string) =>
    apiClient.request<JobReceipt>(
      runsPath(org),
      {
        method: 'POST',
        headers: { 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify(request),
      },
      undefined,
      true,
      true
    ),
  /** 409 `terminal_job` when it had already finished. */
  cancel: (org: string, run: string) =>
    apiClient.request<Job>(
      `${runPath(org, run)}/cancel`,
      { method: 'POST' },
      undefined,
      true,
      true
    ),
  /** Only failed or cancelled runs; a new attempt launched by the caller (402, 429, 403 and 503 as for a launch). */
  retry: (org: string, run: string) =>
    apiClient.request<Job>(`${runPath(org, run)}/retry`, { method: 'POST' }, undefined, true, true),
  /** Evaluate again the engine answer kept for a run that failed with `bim_evaluation_failed`. */
  reevaluate: (org: string, run: string) =>
    apiClient.request<Job>(
      `${runPath(org, run)}/reevaluate`,
      { method: 'POST' },
      undefined,
      true,
      true
    ),
  /** The server-sent events of one run (state snapshots), as a path for an `EventSource`. */
  events: (org: string, run: string) => `${runPath(org, run)}/events`,
  /** The bounded single-task swaps of one solution, checked without running the engine again. */
  neighborhood: async (
    org: string,
    run: string,
    solutionIndex: number,
    task: string,
    limit: number,
    signal?: AbortSignal
  ): Promise<NeighborhoodResponse> => {
    const params = new URLSearchParams({
      solution_index: String(solutionIndex),
      limit: String(limit),
    });
    if (task) params.set('task', task);
    const result = await apiClient.request<
      NeighborhoodResponse & { detail?: string; title?: string }
    >(`${runPath(org, run)}/neighborhood?${params}`, { signal });
    // A 422 throws; this guards a 200 whose body is not an evaluation.
    if (!result.coverage || !Array.isArray(result.moves))
      throw new Error(
        typeof result.detail === 'string'
          ? result.detail
          : result.title || 'Neighborhood evaluation could not be completed'
      );
    return result;
  },
};

/** The state of a run (and of a study run, which may also be `partial`). */
export type RunState = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'partial';

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
