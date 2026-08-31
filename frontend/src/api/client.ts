import { config } from '../config';
import { PricingUnavailableError, QuotaError } from './auth';
import type {
  AdminUserPage,
  AdminUserView,
  ApiKeySummary,
  CreateApiKeyRequest,
  CreatedApiKey,
  PlanName,
  RoleName,
  TokenPair,
  UsageResyncResult,
  UsageView,
  UserProfile,
} from './auth';

/** One solve in an account's history. */
export type Termination = 'OPTIMAL' | 'FEASIBLE' | 'INFEASIBLE' | 'UNKNOWN';

export interface JobSummary {
  id: string;
  engine_id: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  termination?: Termination | null;
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

export interface BimResourceRef {
  namespace: string;
  name: string;
  version: string;
  digest: string;
}

export interface BimMetadata {
  namespace: string;
  name: string;
  version: string;
  description?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, unknown>;
}

export interface BimAdapter {
  id: string;
  version: string;
  binaryDigest: string;
}

export interface BimProfileResourceType {
  apiVersion: string;
  kind: string;
  minimum: number;
  maximum?: number;
}

export interface BimProfileRole {
  resourceTypes: BimProfileResourceType[];
  extensionTypes: 'none' | 'installed';
}

export interface BimProfileOutput {
  apiVersion: string;
  kind: string;
  schemaDigest: string;
  engineProtocol: string;
}

export interface BimCapabilityDimension {
  values: string[];
  openValues: boolean;
}

/** One Profile that is backed by an adapter installed in this gateway. */
export interface BimProfile {
  apiVersion: 'bim/v1';
  kind: 'Profile';
  metadata: BimMetadata;
  spec: {
    deterministic: boolean;
    roles: Record<string, BimProfileRole>;
    output: BimProfileOutput;
    capabilityVocabulary: { dimensions: Record<string, BimCapabilityDimension> };
    limitVocabulary: string[];
    adapter: BimAdapter;
    extensions?: Record<string, unknown>;
  };
  id: string;
  digest: string;
  output: BimProfileOutput;
  protocol: string;
  protocolDigest: string;
}

export interface BimDialectResourceType {
  apiVersion: string;
  kind: string;
  roles: string[];
  mediaType: string;
  schemaDigest: string;
  xmlRoot?: { namespace: string; localName: string };
}

export interface BimDialectExtensionPoint {
  target: { apiVersion: string; kind: string };
  pointer: string;
  schemaDigest: string;
}

export interface BimIrFeature {
  dimension: string;
  value: string;
}

/** One independently versioned source Dialect installed in this gateway. */
export interface BimDialect {
  apiVersion: 'bim/v1';
  kind: 'Dialect';
  metadata: BimMetadata;
  spec: {
    compatibleProfiles: string[];
    resourceTypes: BimDialectResourceType[];
    extensionPoints: BimDialectExtensionPoint[];
    irFeatures: BimIrFeature[];
    adapter: BimAdapter;
    extensions?: Record<string, unknown>;
  };
  digest: string;
}

export interface CapabilitySelector {
  selector: 'none' | 'all' | 'only';
  values?: string[];
}

export interface EngineCapabilities {
  workflowNodes: CapabilitySelector;
  metricScopes: CapabilitySelector;
  aggregations: CapabilitySelector;
  constraints: CapabilitySelector;
  optimization: CapabilitySelector;
  objectiveTypes: CapabilitySelector;
  expressions: CapabilitySelector;
  placement: CapabilitySelector;
  irExtensions: CapabilitySelector;
}

export interface EngineMode {
  id: string;
  profile: string;
  ir: { apiVersion: string; kind: string };
  algorithm: string;
  capabilities: EngineCapabilities;
  optionsSchema: {
    type: 'object';
    properties: Record<string, Record<string, unknown>>;
    required?: string[];
    additionalProperties: false;
  };
  limits: Record<string, number>;
  guarantees: { termination: Termination[]; exact: boolean; [key: string]: unknown };
}

/** One immutable Engine revision advertised by the BIM v1 catalogue. */
export interface EngineCatalogEntry extends BimResourceRef {
  id: string;
  ref: BimResourceRef;
  modes: EngineMode[];
}

export interface EngineManifest {
  apiVersion: 'bim/v1';
  kind: 'Engine';
  metadata: BimMetadata;
  spec: {
    modes: EngineMode[];
    extensions?: Record<string, unknown>;
  };
}

export interface EngineRegistrationManifest {
  apiVersion: 'bim/v1';
  kind: 'EngineRegistration';
  metadata: BimMetadata;
  spec: {
    engine: BimResourceRef;
    endpoint: string;
    protocol: {
      id: 'bim-engine/v1';
      mediaType: 'application/json';
      digest: string;
    };
    mappings: {
      request: string;
      job?: string;
      health: string;
      openapi: string;
    };
    auth: { scheme: 'none' | 'bearer' | 'basic' };
    /** Exact OpenAPI 3.1 document served by the deployment and pinned for review. */
    openapi: Record<string, unknown>;
    extensions?: Record<string, unknown>;
  };
}

export type EngineRevisionState = 'private' | 'published';
export type EngineRegistrationState = 'private' | 'pending_review' | 'published' | 'rejected';

/** Identity and lifecycle state returned after publishing an immutable Engine. */
export interface EngineRevision extends BimResourceRef {
  status: EngineRevisionState;
}

/** Identity and lifecycle state of an immutable EngineRegistration revision. */
export interface EngineRegistrationRevision extends BimResourceRef {
  status: EngineRegistrationState;
  /** Whether this deployment is enabled for its owner's account. */
  active: boolean;
}

export interface EngineRegistrationReport extends EngineRegistrationRevision {
  openapiDigest: string | null;
  openapi: Record<string, unknown> | null;
  engine: EngineManifest | null;
  report: Record<string, unknown> | null;
}

export const BIM_SCHEMA_KINDS = [
  'Instance',
  'Profile',
  'Application',
  'CandidateCatalog',
  'ConstraintSet',
  'Optimization',
  'Placement',
  'RoutingOverlay',
  'BindingProblem',
  'Engine',
  'Dialect',
  'EngineRegistration',
  'engine-contract',
] as const;

export type BimSchemaKind = (typeof BIM_SCHEMA_KINDS)[number];

export function bimResourceKey(ref: BimResourceRef): string {
  return `${ref.namespace}/${ref.name}@${ref.version}#${ref.digest}`;
}

export interface ValidationViolation {
  code: string;
  message: string;
  path?: string;
  constraint_id?: string;
  details?: unknown;
  stage?: number;
}

export interface Warning {
  code: string;
  message: string;
  details?: unknown;
}

export interface ValidationError {
  error?: string;
  violations?: ValidationViolation[];
  warnings?: Warning[];
}

/** Where an engine's own account of its answer differs from the canonical one. */
export interface EngineDivergence {
  solutions_compared: number;
  termination_mismatches: number;
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
  id: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  provenance?: Record<string, unknown>;
  result?: {
    termination: Termination;
    solutions: Array<{
      decision: {
        kind: 'binding';
        binding: Record<string, { resource: string; id: string }>;
      };
      metrics: Record<string, number>;
      objectives: {
        mode: 'satisfy' | 'weighted' | 'lexicographic' | 'pareto';
        components: Array<Record<string, unknown>>;
        penalty: number;
        score: number | number[];
      };
      penalties: number[];
      violations: Array<Record<string, unknown>>;
    }>;
    provenance?: Record<string, unknown>;
    error?: string;
  };
}

export interface BimAnalysisResponse extends Record<string, unknown> {
  valid: boolean;
  diagnostics?: Array<Record<string, unknown>>;
  compatibleModes?: BimCompatibleMode[];
}

export interface BimCompatibleMode {
  engine: BimResourceRef;
  registration: BimResourceRef;
  mode: string;
  compatible: boolean;
  diagnostics?: Array<Record<string, unknown>>;
}

export interface V1JobStatus extends JobStatus {
  error?: string;
}

export class HttpError extends Error {
  status: number;
  code?: string;
  problem?: unknown;
  diagnostics?: unknown[];

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAbortError(error: unknown): boolean {
  return isRecord(error) && error.name === 'AbortError';
}

function quotaFromProblem(value: unknown): NonNullable<QuotaError['quota']> | undefined {
  if (!isRecord(value) || typeof value.limit_id !== 'string' || typeof value.limit !== 'number') {
    return undefined;
  }
  return {
    limit_id: value.limit_id,
    limit: value.limit,
    ...(typeof value.used === 'number' ? { used: value.used } : {}),
    ...(typeof value.actual === 'number' ? { actual: value.actual } : {}),
    ...(typeof value.unit === 'string' ? { unit: value.unit } : {}),
    ...(typeof value.renews_at === 'string' || value.renews_at === null
      ? { renews_at: value.renews_at }
      : {}),
  };
}

export class ApiClient {
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
    let problem: unknown = null;
    try {
      problem = await response.json();
    } catch {
      /* not JSON; fall through to the status-only error */
    }

    const problemObject = isRecord(problem) ? problem : undefined;
    const rawDetail = problemObject?.detail;
    const detail = isRecord(rawDetail) ? rawDetail : undefined;
    const code = typeof detail?.code === 'string' ? detail.code : undefined;
    const message =
      (typeof detail?.error === 'string' ? detail.error : undefined) ??
      (typeof rawDetail === 'string' ? rawDetail : undefined) ??
      response.statusText;

    if (response.status === 402) {
      return new QuotaError(code ?? 'quota_exceeded', message, quotaFromProblem(detail?.quota));
    }
    if (response.status === 503 && code === 'pricing_unavailable') {
      return new PricingUnavailableError(message);
    }
    const error = new HttpError(response.status, message);
    error.code = typeof problemObject?.title === 'string' ? problemObject.title : code;
    error.problem = problem;
    error.diagnostics = Array.isArray(problemObject?.diagnostics)
      ? problemObject.diagnostics
      : Array.isArray(detail?.diagnostics) ? detail.diagnostics : [];
    return error;
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
    } catch (error: unknown) {
      if (isAbortError(error)) {
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
    } catch (error: unknown) {
      if (isAbortError(error)) {
        throw new Error('Request timed out');
      }
      throw error;
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }

  private async requestBinary(endpoint: string, timeoutMs?: number): Promise<ArrayBuffer> {
    const controller = new AbortController();
    const timeoutId = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
    try {
      const response = await fetch(`${this.baseUrl}${endpoint}`, {
        headers: this.authHeaders(),
        signal: controller.signal,
      });
      if (!response.ok) throw await this.errorFor(response);
      return response.arrayBuffer();
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }

  async getEngines(): Promise<EngineCatalogEntry[]> {
    const body = await this.request<{ engines: EngineCatalogEntry[] }>('/v1/engines');
    return body.engines || [];
  }

  async getProfiles(): Promise<BimProfile[]> {
    const body = await this.request<{ profiles: BimProfile[] }>('/v1/profiles');
    return body.profiles || [];
  }

  async getDialects(): Promise<BimDialect[]> {
    const body = await this.request<{ dialects: BimDialect[] }>('/v1/dialects');
    return body.dialects || [];
  }

  async getBimSchema(kind: BimSchemaKind): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>(`/v1/schemas/${encodeURIComponent(kind)}`);
  }

  async analyzeBimPackage(archive: Uint8Array): Promise<BimAnalysisResponse> {
    return this.request<BimAnalysisResponse>('/v1/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/vnd.bim+zip' },
      body: archive as unknown as BodyInit,
    });
  }

  async createBimSnapshot(archive: Uint8Array): Promise<{ id: string; irDigest: string }> {
    return this.request<{ id: string; irDigest: string }>('/v1/instances', {
      method: 'POST',
      headers: { 'Content-Type': 'application/vnd.bim+zip' },
      body: archive as unknown as BodyInit,
    });
  }

  async createBimJob(
    snapshot: string,
    engine: BimResourceRef,
    registration: BimResourceRef,
    mode?: string,
    options: Record<string, unknown> = {},
    idempotencyKey: string = crypto.randomUUID(),
  ): Promise<{ id: string; status: string; irDigest: string }> {
    return this.request<{ id: string; status: string; irDigest: string }>('/v1/jobs', {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify({ snapshot, engine, registration, mode, options }),
    });
  }

  async getV1Job(jobId: string): Promise<V1JobStatus> {
    return this.request<V1JobStatus>(`/v1/jobs/${jobId}`);
  }

  async getBimExamples(): Promise<string[]> {
    const body = await this.request<{ examples: string[] }>('/v1/examples');
    return body.examples || [];
  }

  async getBimExamplePackage(path: string): Promise<ArrayBuffer> {
    return this.requestBinary(`/v1/examples/${path.split('/').map(encodeURIComponent).join('/')}`);
  }

  async getJobStatus(jobId: string, timeoutMs: number = 30000): Promise<JobStatus> {
    return this.request<JobStatus>(`/v1/jobs/${jobId}`, {}, timeoutMs);
  }

  async pollJob(
    jobId: string,
    onUpdate?: (status: JobStatus) => void,
    interval: number = 2000
  ): Promise<JobStatus['result']> {
    return new Promise<JobStatus['result']>((resolve, reject) => {
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
            reject(new Error(status.result?.error || 'Job failed'));
          } else {
            setTimeout(poll, interval);
          }
        } catch (error: unknown) {
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

  // -- Accounts --------------------------------------------------------
  //
  // Every one of these is a documented gateway endpoint. The interface is a
  // client of the API rather than a privileged path into it. A browser session
  // has account authority; an API key reaches only the operations and Engine
  // revisions recorded in its immutable grants.

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
  async createApiKey(payload: CreateApiKeyRequest): Promise<CreatedApiKey> {
    return this.request<CreatedApiKey>('/v1/users/me/api-keys', {
      method: 'POST',
      body: JSON.stringify(payload),
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
    return this.requestText('/v1/pricing');
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
   * `request()` returns validation errors instead of throwing, because a v1
   * instance diagnosis is a normal result worth rendering. For the engine
   * endpoints it is not: a registration either happened or it did not,
   * and a caller that cannot tell the two apart shows an empty success page.
  */
  private orThrow<T extends object>(body: T): T {
    const detail = (body as { detail?: unknown }).detail;
    if (detail && typeof detail === 'object') {
      const problem = detail as Record<string, unknown>;
      if (!problem.code && !problem.error) return body;
      const error = new Error(
        typeof problem.error === 'string' ? problem.error : 'The request was refused.',
      ) as Error & { code?: unknown; violations?: unknown; detail?: unknown };
      error.code = problem.code;
      error.violations = problem.violations;
      error.detail = detail;
      throw error;
    }
    return body;
  }

  private requireExactResourceRef<T extends object>(body: T): T & BimResourceRef {
    for (const field of ['namespace', 'name', 'version', 'digest'] as const) {
      if (typeof (body as Record<string, unknown>)[field] !== 'string' || !(body as Record<string, string>)[field]) {
        throw new Error(`The gateway response omitted the immutable resource pin ${field}.`);
      }
    }
    return body as T & BimResourceRef;
  }

  // -- Immutable Engine and EngineRegistration resources ---------------

  /** Publish a portable bim/v1 Engine document without inventing UI-only fields. */
  async createEngine(manifest: EngineManifest): Promise<EngineRevision> {
    return this.requireExactResourceRef(this.orThrow(
      await this.request<EngineRevision>('/v1/engines', {
        method: 'POST',
        body: JSON.stringify(manifest),
      })
    ));
  }

  /** Read the pinned BIM engine protocol digest advertised by the gateway. */
  async getBimProfile(): Promise<{
    id: 'qos-binding/v1';
    output: { apiVersion: 'bim/v1'; kind: 'BindingProblem'; schemaDigest: string };
    protocol: 'bim-engine/v1';
    protocolDigest: string;
    digest: string;
  }> {
    const profile = (await this.getProfiles()).find((item) => item.id === 'qos-binding/v1');
    const output = profile?.output;
    if (!profile || output?.apiVersion !== 'bim/v1' || output?.kind !== 'BindingProblem'
      || profile.protocol !== 'bim-engine/v1') {
      throw new Error('The gateway does not advertise the BIM v1 binding profile.');
    }
    if (typeof output.schemaDigest !== 'string' || typeof profile.protocolDigest !== 'string'
      || typeof profile.digest !== 'string') {
      throw new Error('The gateway did not publish complete immutable BIM profile pins.');
    }
    return profile as {
      id: 'qos-binding/v1';
      output: { apiVersion: 'bim/v1'; kind: 'BindingProblem'; schemaDigest: string };
      protocol: 'bim-engine/v1';
      protocolDigest: string;
      digest: string;
    };
  }

  /** Register private deployment material separately from the portable Engine. */
  async createEngineRegistration(
    manifest: EngineRegistrationManifest,
  ): Promise<EngineRegistrationRevision> {
    return this.requireExactResourceRef(this.orThrow(
      await this.request<EngineRegistrationRevision>('/v1/engine-registrations', {
        method: 'POST',
        body: JSON.stringify(manifest),
      })
    ));
  }

  async listEngineRegistrations(): Promise<EngineRegistrationRevision[]> {
    const body = await this.request<{ registrations: EngineRegistrationRevision[] }>('/v1/engine-registrations');
    return (body.registrations || []).map((registration) => this.requireExactResourceRef(registration));
  }

  private engineRegistrationEndpoint(ref: BimResourceRef, action?: string): string {
    const query = new URLSearchParams({
      namespace: ref.namespace,
      version: ref.version,
      digest: ref.digest,
    });
    const suffix = action ? `/${action}` : '';
    return `/v1/engine-registrations/${encodeURIComponent(ref.name)}${suffix}?${query.toString()}`;
  }

  async getEngineRegistration(ref: BimResourceRef): Promise<EngineRegistrationManifest> {
    return this.request<EngineRegistrationManifest>(this.engineRegistrationEndpoint(ref));
  }

  async getEngineRegistrationReport(ref: BimResourceRef): Promise<EngineRegistrationReport> {
    return this.requireExactResourceRef(
      await this.request<EngineRegistrationReport>(this.engineRegistrationEndpoint(ref, 'report'))
    );
  }

  async activateEngineRegistration(ref: BimResourceRef): Promise<EngineRegistrationRevision> {
    return this.requireExactResourceRef(await this.request<EngineRegistrationRevision>(this.engineRegistrationEndpoint(ref, 'activate'), {
      method: 'POST',
    }));
  }

  async deactivateEngineRegistration(ref: BimResourceRef): Promise<EngineRegistrationRevision> {
    return this.requireExactResourceRef(await this.request<EngineRegistrationRevision>(this.engineRegistrationEndpoint(ref, 'deactivate'), {
      method: 'POST',
    }));
  }

  async requestEngineRegistrationPublication(ref: BimResourceRef): Promise<EngineRegistrationRevision> {
    return this.requireExactResourceRef(await this.request<EngineRegistrationRevision>(this.engineRegistrationEndpoint(ref, 'publication-request'), {
      method: 'POST',
    }));
  }

  async setEngineRegistrationCredential(
    ref: BimResourceRef,
    secret: string,
  ): Promise<EngineRegistrationRevision> {
    return this.requireExactResourceRef(await this.request<EngineRegistrationRevision>(this.engineRegistrationEndpoint(ref, 'credential'), {
      method: 'PUT',
      body: JSON.stringify({ secret }),
    }));
  }

  async adminListEngineRegistrations(): Promise<EngineRegistrationRevision[]> {
    const body = await this.request<{ registrations: EngineRegistrationRevision[] }>('/v1/engine-registrations?review=true');
    return (body.registrations || []).map((registration) => this.requireExactResourceRef(registration));
  }

  async adminApproveEngineRegistration(ref: BimResourceRef): Promise<EngineRegistrationRevision> {
    return this.requireExactResourceRef(await this.request<EngineRegistrationRevision>(this.engineRegistrationEndpoint(ref, 'approve'), {
      method: 'POST',
    }));
  }

  async adminRejectEngineRegistration(ref: BimResourceRef): Promise<EngineRegistrationRevision> {
    return this.requireExactResourceRef(await this.request<EngineRegistrationRevision>(this.engineRegistrationEndpoint(ref, 'reject'), {
      method: 'POST',
    }));
  }

}

export const apiClient = new ApiClient();
