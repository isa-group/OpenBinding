import { apiClient, type BimResourceRef, type JobHistory } from './client';
import type { ArtifactRef } from './library';
import type { Job } from './platform';

const enc = encodeURIComponent;

export type JobState = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

/** One solution of a result, as the gateway re-evaluated it. */
export interface JobSolution {
  decision?: { kind?: string; binding?: Record<string, { resource?: string; id?: string }> } & Record<string, unknown>;
  metrics?: Record<string, number>;
  features?: Record<string, unknown>;
  objectives?: { type?: string; scalarization?: string; components?: Array<Record<string, unknown>>; penalty?: number; score?: number | number[] } & Record<string, unknown>;
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

/** `GET /v1/jobs/{id}`: what the launcher sees. Only the account that launched a job can read it; everyone else gets a 404. */
export interface JobDetail {
  id: string;
  status: JobState | string;
  provenance: Record<string, unknown>;
  result?: JobResultView | null;
  error?: string;
}

/** `202` from `POST /v1/jobs`. `idempotent` is set when the same one-time key had already started this run. */
export interface JobReceipt {
  id: string;
  status: string;
  irDigest?: string;
  profile?: string;
  idempotent?: boolean;
}

/** `GET /v1/jobs/{id}/report`: the gateway's re-evaluation beside what the engine said about itself. */
export interface JobReport {
  id: string;
  gatewayEvaluation: { termination: string | null; solutions: Array<Record<string, unknown>> };
  remote: Record<string, unknown>;
  provenance: Record<string, unknown>;
}

/** `GET /v1/jobs/{id}/instance`: the snapshot the job ran, with its fingerprints. */
export interface JobInstanceView {
  id: string;
  instanceDigest: string;
  packageDigest: string;
  fileDigests: Record<string, string>;
  resourceDigests: Record<string, string>;
  instance: Record<string, unknown>;
}

/**
 * The optimization an execution selects (`optimization` of `POST /v1/jobs`). The gateway answers 422 `optimization_required` without it;
 * weights are left out and the toolchain fills equal ones where the scalarization needs them.
 */
export interface ExecutionOptimization {
  type: 'SINGLE' | 'MULTI' | 'MANY';
  scalarization: string;
}

/** What `POST /v1/jobs` takes: sealed settings alone, or one exact engine mode with its options and optimization. */
export type LaunchRequest =
  | { snapshot: string; configuration: ArtifactRef }
  | { snapshot: string; engine: BimResourceRef; registration?: BimResourceRef; mode: string; options: Record<string, unknown>; optimization?: ExecutionOptimization };

/**
 * The calls of the job screens. The mutations throw on a 422 (a refused submission) instead of handing its body back as if it were
 * the result, and `launch` carries the one-time key that makes sending twice by accident start one run.
 */
export const jobsApi = {
  /** 404 for everyone but the launcher, platform administrators included. */
  detail: (id: string) => apiClient.request<JobDetail>(`/v1/jobs/${enc(id)}`, {}, undefined, true, true),
  /** The jobs this account launched, newest first, with their options and provenance (`GET /v1/jobs`, at most 500). */
  mine: (limit = 500) => apiClient.request<Job[]>(`/v1/jobs?limit=${limit}`),
  /** The summary of one job of a project, whoever launched it (`GET …/jobs?job_id=`). Members only. */
  inProject: async (org: string, project: string, id: string): Promise<Job | null> => {
    const base = `/v1/organizations/${enc(org)}/projects/${enc(project)}/jobs`;
    const rows = await apiClient.request<Job[]>(`${base}?job_id=${enc(id)}&include_results=false`);
    return rows.find((row) => row.id === id) ?? null;
  },
  /** Needs the account to be allowed to run engines. 402, 403, 404, 409, 422, 429 and 503 each say why nothing started. */
  launch: (request: LaunchRequest, idempotencyKey: string) =>
    apiClient.request<JobReceipt>('/v1/jobs', {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify(request),
    }, undefined, true, true),
  /** 409 `terminal_job` when it had already finished. */
  cancel: (id: string) => apiClient.request<Job>(`/v1/jobs/${enc(id)}/cancel`, { method: 'POST' }, undefined, true, true),
  /** Only failed or cancelled jobs; a new attempt that starts a new run (402, 429, 403 and 503 as for a launch). */
  retry: (id: string) => apiClient.request<Job>(`/v1/jobs/${enc(id)}/retry`, { method: 'POST' }, undefined, true, true),
  report: (id: string) => apiClient.request<JobReport>(`/v1/jobs/${enc(id)}/report`, {}, undefined, true, true),
  ir: (id: string) => apiClient.request<Record<string, unknown>>(`/v1/jobs/${enc(id)}/ir`, {}, undefined, true, true),
  instance: (id: string) => apiClient.request<JobInstanceView>(`/v1/jobs/${enc(id)}/instance`, {}, undefined, true, true),
  /** `GET /v1/users/me/jobs`: summaries across projects, as far back as the plan keeps them, with the total and the retention. */
  history: (params: { limit?: number; offset?: number } = {}): Promise<JobHistory> => apiClient.listOwnJobs(params),
};
