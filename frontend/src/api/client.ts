import { config } from '../config';
import { PricingUnavailableError, QuotaError } from './auth';
import type {
  AdminUserPage,
  AdminUserView,
  ApiKeySummary,
  CreatedApiKey,
  PlanName,
  RoleName,
  TokenPair,
  UsageResyncResult,
  UsageView,
  UserProfile,
} from './auth';

/** One solve in an account's history. */
export interface JobSummary {
  id: string;
  engine_id: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  feasibility?: 'FEASIBLE' | 'INFEASIBLE' | 'UNKNOWN' | null;
  solutions?: number | null;
  created_at: string;
  finished_at?: string | null;
}

export interface JobHistory {
  jobs: JobSummary[];
  total: number;
  /** How far back this plan keeps them: jobHistoryRetentionLimit. */
  retention_days: number;
}

export interface Engine {
  id: string;
  capabilities: any;
  active?: boolean;
  /** Whether somebody registered this engine rather than it shipping here. */
  federated?: boolean;
  owner?: string;
  visibility?: 'private' | 'pending_review' | 'public';
  status?: 'draft' | 'verifying' | 'active' | 'failed' | 'disabled';
  verified_at?: string | null;
}

/** One thing wrong with a registration, and which manifest field to change. */
export interface ConformanceFinding {
  code: string;
  message: string;
  field?: string | null;
}

export interface ConformanceReport {
  passed: boolean;
  findings: ConformanceFinding[];
  steps: string[];
}

/** A registration as its owner sees it. Never carries the credential. */
export interface RegisteredEngine {
  id: string;
  engine_id: string;
  display_name: string;
  owner: string;
  visibility: 'private' | 'pending_review' | 'public';
  status: 'draft' | 'verifying' | 'active' | 'failed' | 'disabled';
  verified_at?: string | null;
  health_failures: number;
  manifest: Record<string, any>;
  conformance_report?: ConformanceReport | null;
  has_credential: boolean;
  created_at: string;
  updated_at: string;
}

/**
 * What the gateway made of somebody's OpenAPI document.
 *
 * `notes` is why each guess was made and `unresolved` is what the document
 * could not answer - both are meant to be read, which is the difference
 * between a proposal and a black box.
 */
export interface ManifestDraft {
  manifest: Record<string, any>;
  notes: string[];
  unresolved: string[];
  ready: boolean;
}

export type EngineDefaultOptions = Record<string, unknown>;

export interface ValidationViolation {
  code: string;
  message: string;
  path?: string;
  constraint_id?: string;
  details?: any;
  stage?: number;
}

export interface Warning {
  code: string;
  message: string;
  details?: any;
}

export interface ValidationError {
  error?: string;
  violations?: ValidationViolation[];
  warnings?: Warning[];
}

/** Where an engine's own account of its answer differs from the canonical one. */
export interface EngineDivergence {
  solutions_compared: number;
  feasibility_mismatches: number;
  max_objective_delta?: number | null;
  notes: string[];
  agrees: boolean;
}

/** What the engine said, kept beside what the reference evaluator computed. */
export interface EngineReport {
  solutions: Array<Record<string, unknown>>;
  provenance?: Record<string, unknown> | null;
  raw?: Record<string, unknown> | null;
  raw_truncated: boolean;
  divergence: EngineDivergence;
}

export interface JobStatus {
  job_id: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  result?: {
    feasibility?: 'FEASIBLE' | 'INFEASIBLE' | 'UNKNOWN';
    solutions?: Array<Record<string, unknown>>;
    provenance?: Record<string, unknown>;
    diagnostics?: Record<string, unknown>;
    engine_report?: EngineReport | null;
  };
  error?: string;
}

export interface SolveRequest {
  engine_id: string;
  instance: any;
  options?: any;
  verbose?: boolean;
  /**
   * Also return what the engine itself reported, before the reference
   * evaluator recomputed it, plus a summary of where the two disagree.
   * Independent of `verbose`: different purpose, different size.
   */
  include_engine_report?: boolean;
}

export interface AnalyzeRequest {
  engine_id: string;
  instance: any;
  options?: any;
  verbose?: boolean;
}

/**
 * An instance taken apart, one entry per component of I' = (M_A, M'_C, Delta, O),
 * plus which model each part belongs to.
 */
export interface InstanceParts {
  parts: Record<string, any>;
  groups: Record<string, string[]>;
}

export interface BindingSpaceRequest {
  engine_id: string;
  instance: any;
  offset?: number;
  limit?: number;
}

export interface BindingSpacePage {
  total_combinations: string;
  offset: number;
  limit: number;
  bindings: Array<Record<string, string>>;
}

export class HttpError extends Error {
  status: number;

  constructor(status: number, statusText: string) {
    super(`HTTP ${status}: ${statusText}`);
    this.status = status;
  }
}

/** Where the session lives. Header-based rather than cookies: see AuthContext. */
const ACCESS_TOKEN_KEY = 'openbinding-access-token';
const REFRESH_TOKEN_KEY = 'openbinding-refresh-token';

/**
 * Fired when a session ends without the user asking - a refresh token that was
 * spent, revoked or expired. AuthContext listens and clears the user, so that
 * every tab notices rather than only the one that made the request.
 */
export const SESSION_ENDED_EVENT = 'openbinding:session-ended';

class ApiClient {
  private baseUrl: string;
  /** In flight refresh, so that ten simultaneous 401s cause one refresh. */
  private refreshing: Promise<boolean> | null = null;

  constructor(baseUrl: string = config.apiBaseUrl) {
    this.baseUrl = baseUrl;
  }

  // -- Session ---------------------------------------------------------

  getAccessToken(): string | null {
    return localStorage.getItem(ACCESS_TOKEN_KEY);
  }

  setTokens(tokens: { access_token: string; refresh_token: string }): void {
    localStorage.setItem(ACCESS_TOKEN_KEY, tokens.access_token);
    localStorage.setItem(REFRESH_TOKEN_KEY, tokens.refresh_token);
  }

  clearTokens(): void {
    localStorage.removeItem(ACCESS_TOKEN_KEY);
    localStorage.removeItem(REFRESH_TOKEN_KEY);
  }

  private authHeaders(): Record<string, string> {
    const token = this.getAccessToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  /**
   * Exchange the refresh token for a new pair, once however many callers ask.
   *
   * The gateway rotates refresh tokens: presenting one spends it. Two
   * concurrent refreshes would therefore race, and the loser would be holding
   * a token that has just been invalidated - so they share one attempt.
   */
  private async refreshSession(): Promise<boolean> {
    if (this.refreshing) return this.refreshing;

    const refreshToken = localStorage.getItem(REFRESH_TOKEN_KEY);
    if (!refreshToken) return false;

    this.refreshing = (async () => {
      try {
        const response = await fetch(`${this.baseUrl}/v1/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refresh_token: refreshToken }),
        });
        if (!response.ok) return false;
        this.setTokens(await response.json());
        return true;
      } catch {
        return false;
      } finally {
        this.refreshing = null;
      }
    })();

    return this.refreshing;
  }

  private endSession(): void {
    this.clearTokens();
    window.dispatchEvent(new CustomEvent(SESSION_ENDED_EVENT));
  }

  /**
   * Turn a failed response into the most specific error available.
   *
   * A caller needs to tell "your instance is invalid" from "your allowance is
   * spent" from "we could not find out", because only one of those is worth
   * offering an upgrade for and only one is worth retrying.
   */
  private async errorFor(response: Response): Promise<Error> {
    let detail: any = null;
    try {
      detail = (await response.json())?.detail;
    } catch {
      /* not JSON; fall through to the status-only error */
    }

    const code = typeof detail === 'object' ? detail?.code : undefined;
    const message =
      (typeof detail === 'object' ? detail?.error : undefined) ??
      (typeof detail === 'string' ? detail : undefined) ??
      response.statusText;

    if (response.status === 402) {
      return new QuotaError(code ?? 'quota_exceeded', message, detail?.quota);
    }
    if (response.status === 503 && code === 'pricing_unavailable') {
      return new PricingUnavailableError(message);
    }
    return new HttpError(response.status, message);
  }

  private async request<T>(
    endpoint: string,
    options: RequestInit = {},
    timeoutMs?: number,
    retryOnUnauthorized = true
  ): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;
    const controller = new AbortController();
    const timeoutId = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : undefined;

    try {
      const response = await fetch(url, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          ...this.authHeaders(),
          ...options.headers,
        },
        signal: controller.signal,
      });

      // An expired access token is ordinary rather than exceptional: refresh
      // once and try again. A second 401 means the session is genuinely over.
      if (response.status === 401 && retryOnUnauthorized && this.getAccessToken()) {
        if (await this.refreshSession()) {
          return this.request<T>(endpoint, options, timeoutMs, false);
        }
        this.endSession();
      }

      // Handle validation errors (422) specially
      if (response.status === 422) {
        const errorData = await response.json();
        // Return the error data as-is so the caller can handle violations
        return errorData as T;
      }

      if (!response.ok) {
        throw await this.errorFor(response);
      }

      if (response.status === 204) {
        return undefined as T;
      }

      return response.json();
    } catch (error: any) {
      if (error?.name === 'AbortError') {
        throw new Error('Request timed out');
      }
      throw error;
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }

  private async requestText(
    endpoint: string,
    options: RequestInit = {},
    timeoutMs?: number
  ): Promise<string> {
    const url = `${this.baseUrl}${endpoint}`;
    const controller = new AbortController();
    const timeoutId = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : undefined;

    try {
      const response = await fetch(url, {
        ...options,
        headers: {
          ...options.headers,
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new HttpError(response.status, response.statusText);
      }

      return response.text();
    } catch (error: any) {
      if (error?.name === 'AbortError') {
        throw new Error('Request timed out');
      }
      throw error;
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }

  private async requestWithRetry<T>(
    endpoint: string,
    options: RequestInit,
    timeoutMs: number,
    retries: number
  ): Promise<T> {
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        return await this.request<T>(endpoint, options, timeoutMs);
      } catch (error) {
        const isHttpError = error instanceof HttpError;
        const shouldRetry = isHttpError
          ? [502, 503, 504].includes(error.status)
          : true;

        if (attempt >= retries || !shouldRetry) {
          throw error;
        }

        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    throw new Error('Request failed after retries');
  }

  async getEngines(): Promise<Engine[]> {
    return this.request<Engine[]>('/v1/engines');
  }

  async getEngineDefaultOptions(engineId: string): Promise<EngineDefaultOptions> {
    return this.request<EngineDefaultOptions>(`/v1/engines/${engineId}/options/defaults`);
  }

  async getGeneralSchema(): Promise<any> {
    return this.request<any>('/v1/schemas/general');
  }

  async getEngineSchema(engineId: string): Promise<any> {
    return this.request<any>(`/v1/schemas/${engineId}`);
  }

  async solve(request: SolveRequest): Promise<JobStatus> {
    return this.requestWithRetry<JobStatus>(
      '/v1/solve',
      {
        method: 'POST',
        body: JSON.stringify(request),
      },
      900000,
      2
    );
  }

  async analyze(request: AnalyzeRequest): Promise<any> {
    return this.request<any>('/v1/analyze', {
      method: 'POST',
      body: JSON.stringify(request),
    }, 900000);
  }

  async getJobStatus(jobId: string, timeoutMs: number = 30000): Promise<JobStatus> {
    return this.request<JobStatus>(`/v1/jobs/${jobId}`, {}, timeoutMs);
  }

  async pollJob(
    jobId: string,
    onUpdate?: (status: JobStatus) => void,
    interval: number = 2000
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      let consecutiveErrors = 0;
      const MAX_CONSECUTIVE_ERRORS = 3;

      const poll = async () => {
        try {
          if (Date.now() - start > 7200000) {
            reject(new Error('Polling timed out'));
            return;
          }

          const status = await this.getJobStatus(jobId, 30000);
          consecutiveErrors = 0; // Reset on success
          
          if (onUpdate) {
            onUpdate(status);
          }

          if (status.status === 'completed') {
            resolve(status.result);
          } else if (status.status === 'failed') {
            reject(new Error(status.error || 'Job failed'));
          } else {
            setTimeout(poll, interval);
          }
        } catch (error: any) {
          consecutiveErrors++;

          // If the job is not found (404), it likely completed synchronously
          // or the engine restarted. Don't retry indefinitely.
          if (error instanceof HttpError && error.status === 404) {
            reject(new Error(
              'The job could not be found on the server. ' +
              'It may have completed synchronously or the engine may have restarted.'
            ));
            return;
          }

          // For transient errors, allow a few retries before giving up
          if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
            reject(error);
            return;
          }

          // Retry with a longer backoff
          setTimeout(poll, interval * 2);
        }
      };

      poll();
    });
  }

  async exploreBindingSpace(request: BindingSpaceRequest): Promise<BindingSpacePage> {
    return this.request<BindingSpacePage>('/v1/analyze/binding-space', {
      method: 'POST',
      body: JSON.stringify(request),
    });
  }

  /** Take an instance apart, one document per component of the tuple. */
  async splitInstance(instance: any): Promise<InstanceParts> {
    return this.request<InstanceParts>('/v1/instance/split', {
      method: 'POST',
      body: JSON.stringify({ instance }),
    });
  }

  /** Merge parts back into the instance they describe. */
  async composeInstance(parts: Record<string, any>): Promise<{ instance: any }> {
    return this.request<{ instance: any }>('/v1/instance/compose', {
      method: 'POST',
      body: JSON.stringify({ parts }),
    });
  }

  // -- Accounts --------------------------------------------------------
  //
  // Every one of these is a documented gateway endpoint. The interface is a
  // client of the API rather than a privileged path into it, so anything the
  // account page can do, a script with an API key can do too.

  async register(details: {
    username: string;
    email: string;
    password: string;
  }): Promise<UserProfile> {
    return this.request<UserProfile>('/v1/auth/register', {
      method: 'POST',
      body: JSON.stringify(details),
    });
  }

  async login(usernameOrEmail: string, password: string): Promise<TokenPair> {
    const tokens = await this.request<TokenPair>('/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username_or_email: usernameOrEmail, password }),
    });
    this.setTokens(tokens);
    return tokens;
  }

  /** End this session on the server, then locally whatever the server said. */
  async logout(): Promise<void> {
    const refreshToken = localStorage.getItem(REFRESH_TOKEN_KEY);
    try {
      if (refreshToken) {
        await this.request<void>('/v1/auth/logout', {
          method: 'POST',
          body: JSON.stringify({ refresh_token: refreshToken }),
        });
      }
    } finally {
      this.clearTokens();
    }
  }

  async getOwnProfile(): Promise<UserProfile> {
    return this.request<UserProfile>('/v1/users/me');
  }

  async updateOwnProfile(changes: {
    email?: string;
    current_password?: string;
    new_password?: string;
  }): Promise<UserProfile> {
    return this.request<UserProfile>('/v1/users/me', {
      method: 'PATCH',
      body: JSON.stringify(changes),
    });
  }

  async listApiKeys(): Promise<ApiKeySummary[]> {
    const body = await this.request<{ api_keys: ApiKeySummary[] }>('/v1/users/me/api-keys');
    return body.api_keys;
  }

  /** The response carries the secret. It is the only one that ever will. */
  async createApiKey(name: string): Promise<CreatedApiKey> {
    return this.request<CreatedApiKey>('/v1/users/me/api-keys', {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
  }

  async revokeApiKey(keyId: string): Promise<void> {
    await this.request<void>(`/v1/users/me/api-keys/${keyId}`, { method: 'DELETE' });
  }

  async getOwnUsage(): Promise<UsageView> {
    return this.request<UsageView>('/v1/users/me/usage');
  }

  /**
   * Your own solves, as far back as the plan keeps them.
   *
   * Summaries only - a result can be hundreds of megabytes, and this is for
   * finding the one you want. `getJobStatus` returns the answer itself.
   */
  async listOwnJobs(params: { limit?: number; offset?: number } = {}): Promise<JobHistory> {
    const query = new URLSearchParams();
    if (params.limit != null) query.set('limit', String(params.limit));
    if (params.offset != null) query.set('offset', String(params.offset));
    const suffix = query.toString() ? `?${query}` : '';
    return this.request<JobHistory>(`/v1/users/me/jobs${suffix}`);
  }

  /**
   * The Pricing2Yaml document this gateway is sold under.
   *
   * Fetched rather than bundled, so the plans page cannot drift from the
   * document SPACE was actually given. Public: a pricing nobody can read
   * before signing up is not much of a pricing.
   */
  async getPricingDocument(): Promise<string> {
    return this.requestText('/v1/schemas/pricing');
  }

  /** What the interface gates features with; the browser never sees SPACE. */
  async getPricingToken(): Promise<string> {
    const body = await this.request<{ pricing_token: string }>('/v1/users/me/pricing-token');
    return body.pricing_token;
  }

  // -- Administration --------------------------------------------------

  async adminListUsers(params: {
    search?: string;
    offset?: number;
    limit?: number;
  } = {}): Promise<AdminUserPage> {
    const query = new URLSearchParams();
    if (params.search) query.set('search', params.search);
    if (params.offset != null) query.set('offset', String(params.offset));
    if (params.limit != null) query.set('limit', String(params.limit));
    const suffix = query.toString() ? `?${query}` : '';
    return this.request<AdminUserPage>(`/v1/admin/users${suffix}`);
  }

  async adminUpdateUser(
    userId: string,
    changes: { is_active?: boolean; role?: RoleName }
  ): Promise<AdminUserView> {
    return this.request<AdminUserView>(`/v1/admin/users/${userId}`, {
      method: 'PATCH',
      body: JSON.stringify(changes),
    });
  }

  /** The novation. With no payment gateway, this is how anybody reaches PRO. */
  async adminChangePlan(userId: string, plan: PlanName): Promise<AdminUserView> {
    return this.request<AdminUserView>(`/v1/admin/users/${userId}/plan`, {
      method: 'POST',
      body: JSON.stringify({ plan }),
    });
  }

  async adminGetUserUsage(userId: string): Promise<UsageView> {
    return this.request<UsageView>(`/v1/admin/users/${userId}/usage`);
  }

  async adminRevokeApiKey(userId: string, keyId: string): Promise<void> {
    await this.request<void>(`/v1/admin/users/${userId}/api-keys/${keyId}`, {
      method: 'DELETE',
    });
  }

  async adminResyncUsage(userId: string): Promise<UsageResyncResult> {
    return this.request<UsageResyncResult>(`/v1/admin/users/${userId}/usage/resync`, {
      method: 'POST',
    });
  }

  /**
   * A 422 body, turned into something a caller can throw.
   *
   * `request()` returns validation errors instead of throwing, because for
   * `/solve` a list of violations is a normal result worth rendering. For the
   * engine endpoints it is not: a registration either happened or it did not,
   * and a caller that cannot tell the two apart shows an empty success page.
   */
  private orThrow<T extends object>(body: T): T {
    const detail = (body as any)?.detail;
    if (detail && typeof detail === 'object' && (detail.code || detail.error)) {
      const error: any = new Error(detail.error || 'The request was refused.');
      error.code = detail.code;
      error.violations = detail.violations;
      error.detail = detail;
      throw error;
    }
    return body;
  }

  // -- Registering your own engine -------------------------------------

  /**
   * Ask the gateway to read an engine's OpenAPI document and propose a manifest.
   *
   * The whole reason registering is feasible for anyone who has not read the
   * manifest reference: the hard parts - which operation solves, where the
   * instance goes, which field is the binding - are worked out here.
   */
  async draftEngineManifest(source: {
    openapi_url?: string;
    openapi_document?: Record<string, any>;
    engine_id?: string;
    display_name?: string;
  }): Promise<ManifestDraft> {
    return this.orThrow(
      await this.request<ManifestDraft>('/v1/engines/draft', {
        method: 'POST',
        body: JSON.stringify(source),
      })
    );
  }

  /** Submit a manifest. Answers with the conformance report either way. */
  async registerEngine(payload: {
    manifest: Record<string, any>;
    credential?: string;
    publish?: boolean;
  }): Promise<RegisteredEngine> {
    return this.orThrow(
      await this.request<RegisteredEngine>('/v1/engines', {
        method: 'POST',
        body: JSON.stringify(payload),
      })
    );
  }

  async listOwnEngines(): Promise<RegisteredEngine[]> {
    return this.request<RegisteredEngine[]>('/v1/engines/registered');
  }

  async getRegisteredEngine(engineId: string): Promise<RegisteredEngine> {
    return this.request<RegisteredEngine>(`/v1/engines/registered/${engineId}`);
  }

  async updateRegisteredEngine(
    engineId: string,
    payload: { manifest: Record<string, any>; credential?: string }
  ): Promise<RegisteredEngine> {
    return this.orThrow(
      await this.request<RegisteredEngine>(`/v1/engines/registered/${engineId}`, {
        method: 'PUT',
        body: JSON.stringify(payload),
      })
    );
  }

  /** Ask again, unchanged - for the case where the engine was simply not up. */
  async verifyRegisteredEngine(engineId: string): Promise<RegisteredEngine> {
    return this.request<RegisteredEngine>(`/v1/engines/registered/${engineId}/verify`, {
      method: 'POST',
    });
  }

  async publishRegisteredEngine(engineId: string): Promise<RegisteredEngine> {
    return this.request<RegisteredEngine>(`/v1/engines/registered/${engineId}/publish`, {
      method: 'POST',
    });
  }

  async replaceEngineCredential(engineId: string, credential: string): Promise<RegisteredEngine> {
    return this.request<RegisteredEngine>(`/v1/engines/registered/${engineId}/credential`, {
      method: 'POST',
      body: JSON.stringify({ credential }),
    });
  }

  async deleteRegisteredEngine(engineId: string): Promise<void> {
    await this.request<void>(`/v1/engines/registered/${engineId}`, { method: 'DELETE' });
  }

  async adminListEngines(pending = false): Promise<RegisteredEngine[]> {
    return this.request<RegisteredEngine[]>(`/v1/admin/engines${pending ? '?pending=true' : ''}`);
  }

  async adminApproveEngine(engineId: string): Promise<RegisteredEngine> {
    return this.request<RegisteredEngine>(`/v1/admin/engines/${engineId}/approve`, {
      method: 'POST',
    });
  }

  async adminRejectEngine(engineId: string): Promise<RegisteredEngine> {
    return this.request<RegisteredEngine>(`/v1/admin/engines/${engineId}/reject`, {
      method: 'POST',
    });
  }

  async adminDisableEngine(engineId: string): Promise<RegisteredEngine> {
    return this.request<RegisteredEngine>(`/v1/admin/engines/${engineId}/disable`, {
      method: 'POST',
    });
  }
}

export const apiClient = new ApiClient();
