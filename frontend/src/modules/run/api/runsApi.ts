// Pattern only, after SPHERE frontend/src/modules/pricing/api/pricingsApi.ts (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: SPHERE's `use<Domain>Api()` hook over `useAuth().fetchWithInterceptor`, for OpenBinding's
// runs of an organization (`/v1/organizations/{org}/runs/…`); refusals throw the typed error `readApiError` and `refusalOf`
// read, and a launch carries its one-time Idempotency-Key.

import { useMemo } from 'react';
import type {
  Job,
  JobCompilationRef,
  JobOrganizationRef,
  JobProblemRef,
  JobRevisionRef,
} from './runsClient';
import { useAuth } from '../../auth/hooks/useAuth';
import { readResponse } from '../../core/api/http';
import type { ImmutableResourceRef, NeighborhoodResponse } from '../../core/api/types';

export type { Job } from './runsClient';

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

/** The filters of `listRuns`: a state, a problem (slug or id), a revision id, an engine name, and the page. */
export interface RunFilters {
  state?: JobState | '';
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
export const runsRoute = (org: string): string => `/v1/organizations/${enc(org)}/runs`;

/** One run of an organization: `/v1/organizations/{org}/runs/{run}`. */
export const runRoute = (org: string, run: string): string => `${runsRoute(org)}/${enc(run)}`;

function query(values: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

/** The fetchers of {@link useRunsApi}. */
export interface RunsApi {
  /** The organization's runs, newest first (at most 200 a page), with how many match in all. */
  list: (org: string, filters?: RunFilters, signal?: AbortSignal) => Promise<RunList>;
  /** 404 for anyone outside the organization, platform administrators included. */
  get: (org: string, run: string, signal?: AbortSignal) => Promise<JobDetail>;
  /** Needs MEMBER. 402, 403, 404, 409, 422, 429 and 503 each say why nothing started. */
  create: (org: string, request: LaunchRequest, idempotencyKey: string) => Promise<JobReceipt>;
  /** 409 `terminal_job` when it had already finished. */
  cancel: (org: string, run: string) => Promise<Job>;
  /** Only failed or cancelled runs; a new attempt launched by the caller (402, 429, 403 and 503 as for a launch). */
  retry: (org: string, run: string) => Promise<Job>;
  /** The bounded single-task swaps of one solution, checked without running the engine again. */
  neighborhood: (
    org: string,
    run: string,
    solutionIndex: number,
    task: string,
    limit: number,
    signal?: AbortSignal
  ) => Promise<NeighborhoodResponse>;
  /** The problems of the organization a run list can be narrowed to (`listProblems`, the first 200). */
  problemOptions: (org: string, signal?: AbortSignal) => Promise<FilterOption[]>;
  /** The engine names a run list can be narrowed to, from the engines this account may see (`listEngines`). */
  engineOptions: (signal?: AbortSignal) => Promise<FilterOption[]>;
}

/** One choice of a filter: the value the gateway takes and its words. */
export interface FilterOption {
  value: string;
  label: string;
}

/**
 * The runs of an organization. A run belongs to its organization: every member reads it (redacted below MEMBER), MEMBER and above
 * launch, cancel and retry it, and everyone else gets a 404. A refusal throws (a 422 is a refused submission, never a result), and
 * `create` carries the one-time key that makes sending twice by accident start one run.
 */
export function useRunsApi(): RunsApi {
  const { fetchWithInterceptor } = useAuth();
  return useMemo<RunsApi>(() => {
    const post = async <T>(path: string, init: RequestInit = {}) =>
      readResponse<T>(await fetchWithInterceptor(path, { ...init, method: 'POST' }));
    return {
      list: async (org, filters = {}, signal) =>
        readResponse<RunList>(
          await fetchWithInterceptor(`${runsRoute(org)}${query({ ...filters })}`, { signal })
        ),
      get: async (org, run, signal) =>
        readResponse<JobDetail>(await fetchWithInterceptor(runRoute(org, run), { signal })),
      create: (org, request, idempotencyKey) =>
        post<JobReceipt>(runsRoute(org), {
          headers: { 'Idempotency-Key': idempotencyKey },
          body: JSON.stringify(request),
        }),
      cancel: (org, run) => post<Job>(`${runRoute(org, run)}/cancel`),
      retry: (org, run) => post<Job>(`${runRoute(org, run)}/retry`),
      neighborhood: async (org, run, solutionIndex, task, limit, signal) => {
        const result = await readResponse<
          NeighborhoodResponse & { detail?: string; title?: string }
        >(
          await fetchWithInterceptor(
            `${runRoute(org, run)}/neighborhood${query({ solution_index: solutionIndex, limit, task })}`,
            { signal }
          )
        );
        // A 422 throws; this guards a 200 whose body is not an evaluation.
        if (!result.coverage || !Array.isArray(result.moves))
          throw new Error(
            typeof result.detail === 'string'
              ? result.detail
              : result.title || 'Neighborhood evaluation could not be completed'
          );
        return result;
      },
      problemOptions: async (org, signal) => {
        const page = await readResponse<{ problems: Array<{ slug: string; name: string }> }>(
          await fetchWithInterceptor(
            `/v1/organizations/${enc(org)}/problems${query({ limit: 200 })}`,
            { signal }
          )
        );
        return page.problems.map(problem => ({ value: problem.slug, label: problem.name }));
      },
      engineOptions: async signal => {
        const page = await readResponse<{ engines: Array<{ name: string }> }>(
          await fetchWithInterceptor('/v1/engines', { signal })
        );
        return [...new Set(page.engines.map(engine => engine.name))]
          .sort()
          .map(name => ({ value: name, label: name }));
      },
    };
  }, [fetchWithInterceptor]);
}
