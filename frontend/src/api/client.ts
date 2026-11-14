import type { Neighborhood } from '../analysis/neighborhood';
import { config } from '../config';
import { PricingUnavailableError, QuotaError } from './auth';
import { bindingSpaceFrom, limitNoticeFrom, type BindingSpaceReport, type LimitNotice } from './limitNotice';
import type {
  AdminUserPage,
  AdminSubscriptionView,
  AdminUserView,
  ApiKeySummary,
  AdminAuditPage,
  AdminModerationOverview,
  AdminOverview,
  AdminQueueStatus,
  CasSession,
  PlanChange,
  CreateApiKeyRequest,
  CreatedApiKey,
  ContractChangeReason,
  ExternalIdentity,
  MaintenancePreview,
  Notification,
  NotificationPreferences,
  PricingCatalog,
  PricingCurrentView,
  RoleName,
  TokenPair,
  UsageView,
  UserProfile,
} from './auth';
import type { AdminErrorOverview, AdminErrorListResponse } from '../pages/Admin/types';
import { rememberCasFlow } from '../utils/authFlow';
import { randomUUID } from '../utils/uuid';

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
  /** How far back this contract keeps them: jobHistoryDays. */
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

/**
 * One objective scalarization an engine mode offers (`capabilities.scalarizations.values`). That dimension is the one
 * whose values are objects rather than names, so it is read from the document, not through `EngineCapabilities`.
 */
export interface ScalarizationDeclaration {
  id: string;
  objectiveTypes: Array<'SINGLE' | 'MULTI' | 'MANY'>;
  weightPolicy: 'required' | 'optional' | 'forbidden';
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
  /** `scalar`, `interval` (a range). The gateway makes this dimension mandatory for the qos-binding profile. */
  featureValues?: CapabilitySelector;
  featureScopes?: CapabilitySelector;
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

/** The engine list, and whether it is the public one because the session could not be used (401). */
export interface EngineCatalogResult {
  engines: EngineCatalogEntry[];
  fellBackToPublic: boolean;
}

/** 200 from POST /v1/instances/validate: the package compiled and is pinned by these digests. */
export interface PackageValidation {
  valid: true;
  instanceDigest: string;
  packageDigest: string;
  fileDigests: Record<string, string>;
  resourceDigests: Record<string, string>;
  irDigest: string;
  diagnostics: Array<Record<string, unknown>>;
}

/** 422 from the same endpoint: the package was read and found invalid; each diagnostic says where. */
export interface PackageRefusal {
  status: number;
  code: string;
  message: string;
  diagnostics: Array<Record<string, unknown>>;
}

export type PackageValidationOutcome =
  | { valid: true; result: PackageValidation }
  | { valid: false; refusal: PackageRefusal };

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

export interface BimAnalysisData {
  tasks: number;
  candidates: number;
  constraints: number;
  placement: boolean;
  bindingSpace: string;
}

export interface BimAnalysisResponse extends Record<string, unknown> {
  valid: boolean;
  diagnostics?: Array<Record<string, unknown>>;
  compatibleModes?: BimCompatibleMode[];
  analysis?: BimAnalysisData;
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

/**
 * An answer of the gateway with the revision it gave the resource: its `ETag`, or `null` when the answer carried none
 * (docs/ERRORS.md, "Conditional writes"). The tag is opaque: it goes back unchanged as `If-Match` and is never read.
 */
export interface Revised<T> {
  value: T;
  etag: string | null;
}

export class HttpError extends Error {
  status: number;
  code?: string;
  problem?: unknown;
  diagnostics?: unknown[];
  /** What a 429 names: the limit, how many jobs are in flight, and whose limit it is (`plan` or `technical`). */
  concurrency?: { limit_id: string; limit: number; used: number; source?: string; unit?: string };
  retryAfter?: number;
  /** The limit a refusal names (a 403 or 422 about a size limit carries one, with its state and source). */
  notice?: LimitNotice;
  /** The measured size, when the refusal is about the binding space. */
  bindingSpace?: BindingSpaceReport;

  constructor(status: number, statusText: string) {
    super(`HTTP ${status}: ${statusText}`);
    this.status = status;
  }
}

/** Where the session lives. Header-based rather than cookies: see AuthContext. */
export const ACCESS_TOKEN_KEY = 'openbinding-access-token';
const REFRESH_TOKEN_KEY = 'openbinding-refresh-token';
const PRICING_TOKEN_KEY = 'pricingToken';

/**
 * Fired when a new pricing token is retrieved from the gateway so that
 * SpaceTokenSync immediately updates TokenService across the UI.
 */
export const PRICING_TOKEN_UPDATED_EVENT = 'openbinding:pricing-token-updated';

/** Helper to retrieve the active pricing token from localStorage safely. */
export function getStoredPricingToken(): string | null {
  const raw = localStorage.getItem(PRICING_TOKEN_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'string' ? parsed : raw;
  } catch {
    return raw;
  }
}

/**
 * Fired when a session ends without the user asking - a refresh token that was
 * spent, revoked or expired. AuthContext listens and clears the user. The event is local
 * to the tab that made the request; the other tabs learn of it from the `storage` event
 * that clearing the tokens raises (see AuthContext).
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
    localStorage.removeItem(PRICING_TOKEN_KEY);
    // Whoever shows the state of the pricing token (the usage screen) learns that there is none.
    window.dispatchEvent(new CustomEvent(PRICING_TOKEN_UPDATED_EVENT));
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
    // The canonical `code` sits at the top of every coded failure (and a 422 has nothing else); the old
    // `detail.code` and the BIM routes' `title` (always equal to `code`) are what older bodies carry.
    const code =
      (typeof problemObject?.code === 'string' ? problemObject.code : undefined) ??
      (typeof detail?.code === 'string' ? detail.code : undefined) ??
      (typeof problemObject?.title === 'string' ? problemObject.title : undefined);
    const message =
      (typeof detail?.error === 'string' ? detail.error : undefined) ??
      (typeof detail?.message === 'string' ? detail.message : undefined) ??
      (typeof rawDetail === 'string' ? rawDetail : undefined) ??
      response.statusText;

    const rawQuota = detail?.quota ?? problemObject?.quota;
    // Where the limit stands, and for a binding space how big it is: top level or inside `detail`, like the quota.
    const notice = limitNoticeFrom(rawQuota);
    const bindingSpace = bindingSpaceFrom(detail?.binding_space ?? problemObject?.binding_space);
    if (response.status === 402) {
      const quotaError = new QuotaError(code ?? 'quota_exceeded', message, quotaFromProblem(rawQuota));
      quotaError.notice = notice;
      quotaError.bindingSpace = bindingSpace;
      return quotaError;
    }
    if (response.status === 429) {
      const rawConcurrency = detail?.concurrency ?? problemObject?.concurrency;
      const retryAfterHeader = response.headers.get('Retry-After');
      const err = new HttpError(429, message);
      err.code = code ?? 'concurrency_limit_exceeded';
      err.problem = problem;
      if (isRecord(rawConcurrency) && typeof rawConcurrency.limit_id === 'string' && typeof rawConcurrency.limit === 'number') {
        err.concurrency = {
          limit_id: rawConcurrency.limit_id,
          limit: rawConcurrency.limit,
          used: typeof rawConcurrency.used === 'number' ? rawConcurrency.used : 0,
          ...(typeof rawConcurrency.source === 'string' ? { source: rawConcurrency.source } : {}),
          ...(typeof rawConcurrency.unit === 'string' ? { unit: rawConcurrency.unit } : {}),
        };
      }
      if (retryAfterHeader) {
        const parsed = parseInt(retryAfterHeader, 10);
        if (!isNaN(parsed)) err.retryAfter = parsed;
      }
      return err;
    }
    if (response.status === 503 && code === 'pricing_unavailable') {
      return new PricingUnavailableError(message);
    }
    const error = new HttpError(response.status, message);
    error.code = code;
    error.problem = problem;
    error.notice = notice;
    error.bindingSpace = bindingSpace;
    error.diagnostics = Array.isArray(problemObject?.diagnostics)
      ? problemObject.diagnostics
      : Array.isArray(detail?.diagnostics) ? detail.diagnostics : [];
    return error;
  }

  /**
   * `retryOnUnauthorized` turns off the silent refresh (a login form has no session to renew);
   * `throwOnValidation` (on unless a caller turns it off) makes a 422 an HttpError with the gateway's code and diagnostics;
   * pass `false` only where a 422 is a result the caller reads from the body (a package found invalid, a pricing document refused).
   * `read` turns a successful answer into the result: its body, unless the caller needs a header too (see `revised`).
   */
  async request<T>(
    endpoint: string,
    options: RequestInit = {},
    timeoutMs?: number,
    retryOnUnauthorized = true,
    throwOnValidation = true,
    read: (response: Response) => Promise<T> = (response) => response.json(),
  ): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;
    const controller = new AbortController();
    const timeoutId = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
    const abortFromCaller = () => controller.abort();
    if (options.signal?.aborted) controller.abort();
    options.signal?.addEventListener('abort', abortFromCaller, { once: true });

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
          return this.request<T>(endpoint, options, timeoutMs, false, throwOnValidation, read);
        }
        this.endSession();
      }

      // A 422 is an error unless the caller asked for its body as a result.
      if (response.status === 422 && throwOnValidation) {
        throw await this.errorFor(response);
      }
      if (response.status === 422) {
        return await response.json() as T;
      }

      if (!response.ok) {
        throw await this.errorFor(response);
      }

      if (response.status === 204) {
        return undefined as T;
      }

      return read(response);
    } catch (error: unknown) {
      if (isAbortError(error)) {
        if (options.signal?.aborted) throw error;
        throw new Error('Request timed out');
      }
      throw error;
    } finally {
      options.signal?.removeEventListener('abort', abortFromCaller);
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }

  /**
   * A conditional write, or the read it is decided on. `ifMatch` is the revision the change was decided on, sent as `If-Match`; with
   * none nothing is sent, and the gateway behaves as it does without one. The answer comes back with its `ETag`.
   */
  private revised<T>(endpoint: string, ifMatch: string | null, init: Omit<RequestInit, 'headers'> = {}): Promise<Revised<T>> {
    return this.request<Revised<T>>(
      endpoint,
      ifMatch ? { ...init, headers: { 'If-Match': ifMatch } } : init,
      undefined,
      true,
      true,
      async (response) => ({ value: await response.json() as T, etag: response.headers.get('ETag') }),
    );
  }

  async requestText(
    endpoint: string,
    options: RequestInit = {},
    timeoutMs?: number,
    retryOnUnauthorized = true
  ): Promise<string> {
    const url = `${this.baseUrl}${endpoint}`;
    const controller = new AbortController();
    const timeoutId = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : undefined;

    try {
      const response = await fetch(url, {
        ...options,
        headers: {
          ...this.authHeaders(),
          ...options.headers,
        },
        signal: controller.signal,
      });

      if (response.status === 401 && retryOnUnauthorized && this.getAccessToken()) {
        if (await this.refreshSession()) {
          return this.requestText(endpoint, options, timeoutMs, false);
        }
        this.endSession();
      }

      if (!response.ok) {
        throw await this.errorFor(response);
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

  async requestBinary(
    endpoint: string,
    timeoutMs?: number,
    retryOnUnauthorized = true,
  ): Promise<ArrayBuffer> {
    const controller = new AbortController();
    const timeoutId = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
    try {
      const response = await fetch(`${this.baseUrl}${endpoint}`, {
        headers: this.authHeaders(),
        signal: controller.signal,
      });
      if (response.status === 401 && retryOnUnauthorized && this.getAccessToken()) {
        if (await this.refreshSession()) return this.requestBinary(endpoint, timeoutMs, false);
        this.endSession();
      }
      if (!response.ok) throw await this.errorFor(response);
      return response.arrayBuffer();
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }

  /** The public engine catalogue (GET /v1/engines): a visitor gets the built-in and published engines. */
  async getPublicEngines(): Promise<EngineCatalogEntry[]> {
    const body = await this.request<{ engines: EngineCatalogEntry[] }>('/v1/engines');
    return body.engines || [];
  }

  async getEngines(): Promise<EngineCatalogEntry[]> {
    try {
      const body = await this.request<{ engines: EngineCatalogEntry[] }>('/v1/engines');
      return body.engines || [];
    } catch (error) {
      if (error instanceof HttpError && error.status === 401) {
        return this.getPublicEngines();
      }
      throw error;
    }
  }

  /**
   * The engines this caller may see. A rejected session (401) falls back to the public list, as `getEngines` does,
   * but says so: the catalog screen tells the reader that their private engines are hidden.
   */
  async getCatalogEngines(): Promise<EngineCatalogResult> {
    try {
      const body = await this.request<{ engines: EngineCatalogEntry[] }>('/v1/engines');
      return { engines: body.engines || [], fellBackToPublic: false };
    } catch (error) {
      if (error instanceof HttpError && error.status === 401) {
        return { engines: await this.getPublicEngines(), fellBackToPublic: true };
      }
      throw error;
    }
  }

  async getProfiles(): Promise<BimProfile[]> {
    const body = await this.request<{ profiles: BimProfile[] }>('/v1/profiles');
    return body.profiles || [];
  }

  async getDialects(): Promise<BimDialect[]> {
    const body = await this.request<{ dialects: BimDialect[] }>('/v1/dialects');
    return body.dialects || [];
  }

  /**
   * Validate a package without an account and without running an engine (POST /v1/instances/validate).
   *
   * A package the gateway reads and rejects answers 422 with diagnostics; that is a result, not a failure, so it
   * comes back as `{ valid: false }`. Too large (413), wrong media type (415) and rate limits (429) throw HttpError.
   */
  async validatePackage(archive: Uint8Array, signal?: AbortSignal): Promise<PackageValidationOutcome> {
    const body = await this.request<Record<string, unknown>>('/v1/instances/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/vnd.bim+zip' },
      body: archive as unknown as BodyInit,
      signal,
    }, undefined, true, false);
    if (isRecord(body) && body.valid === true) {
      return {
        valid: true,
        result: {
          valid: true,
          instanceDigest: String(body.instanceDigest ?? ''),
          packageDigest: String(body.packageDigest ?? ''),
          fileDigests: isRecord(body.fileDigests) ? body.fileDigests as Record<string, string> : {},
          resourceDigests: isRecord(body.resourceDigests) ? body.resourceDigests as Record<string, string> : {},
          irDigest: String(body.irDigest ?? ''),
          diagnostics: Array.isArray(body.diagnostics) ? body.diagnostics.filter(isRecord) : [],
        },
      };
    }
    const detail = isRecord(body) ? body.detail : undefined;
    const detailRecord = isRecord(detail) ? detail : undefined;
    const diagnostics = isRecord(body) && Array.isArray(body.diagnostics)
      ? body.diagnostics
      : Array.isArray(detailRecord?.diagnostics) ? detailRecord.diagnostics : [];
    return {
      valid: false,
      refusal: {
        status: typeof body?.status === 'number' ? body.status : 422,
        code: (typeof body?.code === 'string' ? body.code : undefined)
          ?? (typeof body?.title === 'string' ? body.title : undefined)
          ?? (typeof detailRecord?.code === 'string' ? detailRecord.code : undefined) ?? 'invalid_request',
        message: (typeof detail === 'string' ? detail : undefined)
          ?? (typeof detailRecord?.message === 'string' ? detailRecord.message : undefined)
          ?? (typeof detailRecord?.error === 'string' ? detailRecord.error : undefined)
          ?? 'The package could not be validated.',
        diagnostics: diagnostics.filter(isRecord),
      },
    };
  }

  async getBimSnapshotIr(snapshot: string): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>(`/v1/instances/${encodeURIComponent(snapshot)}/ir`);
  }

  async createBimJob(
    snapshot: string,
    engine: BimResourceRef,
    registration: BimResourceRef,
    mode?: string,
    options: Record<string, unknown> = {},
    idempotencyKey: string = randomUUID(),
  ): Promise<{ id: string; status: string; irDigest: string }> {
    return this.request<{ id: string; status: string; irDigest: string }>('/v1/jobs', {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify({ snapshot, engine, registration, mode, options }),
    });
  }

  async getV1Job(jobId: string, signal?: AbortSignal): Promise<V1JobStatus> {
    return this.request<V1JobStatus>(`/v1/jobs/${encodeURIComponent(jobId)}`, signal ? { signal } : {});
  }

  async createConfiguredBimJob(snapshot: string, configuration: import('./library').ArtifactRef): Promise<{ id: string; status: string; irDigest: string }> {
    return this.request('/v1/jobs', {
      method: 'POST', headers: { 'Idempotency-Key': randomUUID() },
      body: JSON.stringify({ snapshot, configuration }),
    });
  }

  async getBimExamples(): Promise<string[]> {
    const body = await this.request<{ examples: string[] }>('/v1/examples');
    return body.examples || [];
  }

  async getBimExamplePackage(path: string): Promise<ArrayBuffer> {
    return this.requestBinary(`/v1/examples/${path.split('/').map(encodeURIComponent).join('/')}`);
  }

  async getBindingNeighborhood(jobId: string, solutionIndex: number, task: string, limit: number, signal?: AbortSignal): Promise<Neighborhood> {
    const query = new URLSearchParams({ solution_index: String(solutionIndex), limit: String(limit) });
    if (task) query.set('task', task);
    const result = await this.request<Neighborhood & { detail?: string; title?: string }>(`/v1/jobs/${encodeURIComponent(jobId)}/analysis/neighborhood?${query}`, { signal });
    // A 422 throws; this guards a 200 whose body is not an evaluation.
    if (!result.coverage || !Array.isArray(result.moves)) throw new Error(typeof result.detail === 'string' ? result.detail : result.title || 'Neighborhood evaluation could not be completed');
    return result;
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
            reject(new Error(status.result?.error || 'Run failed'));
          } else {
            setTimeout(poll, interval);
          }
        } catch (error: unknown) {
          consecutiveErrors++;

          // If the job is not found (404), it likely completed synchronously
          // or the engine restarted. Don't retry indefinitely.
          if (error instanceof HttpError && error.status === 404) {
            reject(new Error(
              'The run could not be found on the server. ' +
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
    }, undefined, false, true);
  }

  async login(usernameOrEmail: string, password: string): Promise<TokenPair> {
    const tokens = await this.request<TokenPair>('/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username_or_email: usernameOrEmail, password }),
    }, undefined, false, true);
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

  /** A refused submission (422 weak password) throws instead of being read as the new profile. */
  async updateOwnProfile(changes: {
    email?: string;
    current_password?: string;
    new_password?: string;
  }): Promise<UserProfile> {
    return this.request<UserProfile>('/v1/users/me', {
      method: 'PATCH',
      body: JSON.stringify(changes),
    }, undefined, true, true);
  }

  async requestPasswordReset(email: string): Promise<{ accepted: boolean; delivery: string; token?: string }> {
    return this.request('/v1/auth/password-reset/request', {
      method: 'POST', body: JSON.stringify({ email }),
    }, undefined, false, true);
  }

  async completePasswordReset(token: string, newPassword: string): Promise<void> {
    await this.request('/v1/auth/password-reset/complete', {
      method: 'POST', body: JSON.stringify({ token, new_password: newPassword }),
    }, undefined, false, true);
  }

  casStartUrl(mode: 'login' | 'link' = 'login'): string {
    return `${this.baseUrl}/v1/auth/cas/start?mode=${mode}`;
  }

  async createCasLinkIntent(): Promise<string> {
    const response = await this.request<{ url: string }>('/v1/auth/cas/link-intent', { method: 'POST' });
    // The caller navigates to this URL next; the callback page needs to know it is a link, not a login.
    rememberCasFlow('link');
    return response.url;
  }

  /**
   * Trade the one-time code of the CAS redirect for a session. Answers the plan change that signing in caused (linking CAS raises
   * BASIC to RESEARCH, at no extra cost), or `null` when the plan did not change.
   */
  async exchangeCasCode(code: string): Promise<PlanChange | null> {
    const session = await this.request<CasSession>('/v1/auth/cas/exchange', {
      method: 'POST', body: JSON.stringify({ code }),
    }, undefined, false, true);
    this.setTokens(session);
    const change = session.plan_changed;
    return change && typeof change.to === 'string' ? change : null;
  }

  async listOwnIdentities(): Promise<ExternalIdentity[]> {
    return this.request('/v1/users/me/identities');
  }

  async unlinkOwnIdentity(identityId: string, confirmation?: string): Promise<void> {
    const query = confirmation ? `?confirmation=${encodeURIComponent(confirmation)}` : '';
    await this.request(`/v1/users/me/identities/${encodeURIComponent(identityId)}${query}`, { method: 'DELETE' });
  }

  async deleteOwnAccount(confirmation: string, currentPassword?: string): Promise<void> {
    await this.request('/v1/users/me', {
      method: 'DELETE', body: JSON.stringify({ confirmation, current_password: currentPassword || null }),
    }, undefined, true, true);
  }

  async listNotifications(unreadOnly = false): Promise<Notification[]> {
    const list = await this.request<Notification[]>(`/v1/notifications${unreadOnly ? '?unread_only=true' : ''}`);
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    return list.filter((item) => new Date(item.created_at).getTime() >= cutoff);
  }

  async markAllNotificationsRead(): Promise<Notification[]> {
    return this.request('/v1/notifications/read-all', { method: 'POST' });
  }

  async markNotificationRead(notificationId: string): Promise<Notification> {
    return this.request(`/v1/notifications/${encodeURIComponent(notificationId)}/read`, { method: 'POST' });
  }

  async getNotificationPreferences(): Promise<NotificationPreferences> {
    return this.request('/v1/notifications/preferences');
  }

  async updateNotificationPreferences(value: NotificationPreferences): Promise<NotificationPreferences> {
    return this.request('/v1/notifications/preferences', { method: 'PUT', body: JSON.stringify(value) }, undefined, true, true);
  }

  async listApiKeys(): Promise<ApiKeySummary[]> {
    const body = await this.request<{ api_keys: ApiKeySummary[] }>('/v1/users/me/api-keys');
    return body.api_keys;
  }

  /** The response carries the secret. It is the only one that ever will. */
  async createApiKey(payload: CreateApiKeyRequest): Promise<CreatedApiKey> {
    // A 422 (engines missing for the chosen permissions, past expiry) throws: its body is not a key.
    return this.request<CreatedApiKey>('/v1/users/me/api-keys', {
      method: 'POST',
      body: JSON.stringify(payload),
    }, undefined, true, true);
  }

  async revokeApiKey(keyId: string): Promise<void> {
    await this.request<void>(`/v1/users/me/api-keys/${keyId}`, { method: 'DELETE' });
  }

  async rotateApiKey(keyId: string): Promise<CreatedApiKey> {
    return this.request<CreatedApiKey>(`/v1/users/me/api-keys/${keyId}/rotate`, { method: 'POST' });
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
   * The active Pricing2Yaml document, digest-verified by the gateway and served as JSON.
   *
   * Fetched rather than bundled, so the plans page cannot drift from the
   * document SPACE was actually given. Public: a pricing nobody can read
   * before signing up is not much of a pricing.
   */
  async getPricingCatalog(): Promise<PricingCatalog> {
    return this.request<PricingCatalog>('/v1/pricing/catalog');
  }

  /** The live public release: version, content digest and where SPHERE publishes it. 404 when none is live. */
  async getCurrentPricing(): Promise<PricingCurrentView> {
    return this.request<PricingCurrentView>('/v1/pricing/current');
  }

  /** What the interface gates features with; the browser never sees SPACE. */
  async getPricingToken(): Promise<string> {
    const body = await this.request<{ pricing_token: string }>('/v1/users/me/pricing-token');
    localStorage.setItem(PRICING_TOKEN_KEY, body.pricing_token);
    window.dispatchEvent(
      new CustomEvent(PRICING_TOKEN_UPDATED_EVENT, { detail: body.pricing_token })
    );
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
    }, undefined, true, true);
  }

  /**
   * Apply an administrator-authorized SPACE contract novation, keeping the add-ons the account already has.
   * A 422 (`invalid_subscription`) throws instead of coming back as if it were the answer.
   * `ifMatch` is the revision of the subscription the change was decided on (from `adminGetSubscription`): a subscription that has
   * moved since is refused with 412 `precondition_failed` and nothing is written. The answer carries the new revision.
   */
  async adminChangePlan(userId: string, plan: string, ifMatch: string | null): Promise<Revised<AdminUserView>> {
    return this.revised<AdminUserView>(`/v1/admin/users/${userId}/plan`, ifMatch, {
      method: 'POST',
      body: JSON.stringify({ plan }),
    });
  }

  /** The contract of an account, with its revision: the tag a change decided on this reading sends back. */
  async adminGetSubscription(userId: string): Promise<Revised<AdminSubscriptionView>> {
    return this.revised<AdminSubscriptionView>(`/v1/admin/users/${userId}/subscription`, null);
  }

  /** An audited agreement. `ifMatch` and the revision of the answer work as in `adminChangePlan`. */
  async adminUpdateSubscription(
    userId: string,
    value: {
      plan: string;
      add_ons: Record<string, number>;
      reason: ContractChangeReason;
      detail?: string;
    },
    ifMatch: string | null,
  ): Promise<Revised<AdminSubscriptionView>> {
    return this.revised<AdminSubscriptionView>(`/v1/admin/users/${userId}/subscription`, ifMatch, {
      method: 'POST',
      body: JSON.stringify(value),
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

  async adminOverview(): Promise<AdminOverview> {
    return this.request('/v1/admin/overview');
  }

  /**
   * The platform audit log, newest first: platform events and the events recorded inside an organization (`organizationId`,
   * `organizationSlug`). `action` is an exact action name and `organizationId` keeps one organization's events;
   * the gateway's page is 100 events unless `limit` (at most 500) says otherwise.
   */
  async adminAudit(filter?: string | { action?: string; organizationId?: string; offset?: number; limit?: number }): Promise<AdminAuditPage> {
    const { action, organizationId, offset, limit } = typeof filter === 'string'
      ? { action: filter, organizationId: undefined, offset: undefined, limit: undefined }
      : filter ?? {};
    const query = new URLSearchParams();
    if (action) query.set('action', action);
    if (organizationId) query.set('organization_id', organizationId);
    if (offset) query.set('offset', String(offset));
    if (limit) query.set('limit', String(limit));
    const suffix = query.toString() ? `?${query}` : '';
    return this.request(`/v1/admin/audit${suffix}`);
  }

  async adminQueues(): Promise<AdminQueueStatus> {
    return this.request('/v1/admin/queues');
  }

  /** How many engines, dialects and engine registrations sit in each publication state. */
  async adminModeration(): Promise<AdminModerationOverview> {
    return this.request('/v1/admin/moderation');
  }

  async adminMaintenancePreview(retentionDays = 365): Promise<MaintenancePreview> {
    return this.request(`/v1/admin/maintenance/preview?terminal_job_retention_days=${retentionDays}`);
  }

  async adminReconcileJobs(): Promise<{ settled: number }> {
    return this.request('/v1/admin/maintenance/reconcile-jobs', { method: 'POST' });
  }

  /** `errorRetentionDays` is how long error events are kept (1–3650, the gateway defaults to 90); it isn't part of the preview. */
  async adminPurgeExpired(confirmation: string, retentionDays = 365, errorRetentionDays?: number): Promise<Record<string, number>> {
    return this.request('/v1/admin/maintenance/purge', {
      method: 'POST',
      body: JSON.stringify({
        confirmation,
        terminal_job_retention_days: retentionDays,
        ...(errorRetentionDays === undefined ? {} : { error_retention_days: errorRetentionDays }),
      }),
    });
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

  /**
   * Publish a portable bim/v1 Engine document without inventing UI-only fields.
   * A refused document (422 `invalid_engine`) throws an HttpError whose `diagnostics` say where.
   */
  async createEngine(manifest: EngineManifest): Promise<EngineRevision> {
    return this.requireExactResourceRef(
      await this.request<EngineRevision>('/v1/engines', {
        method: 'POST',
        body: JSON.stringify(manifest),
      })
    );
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
    return this.requireExactResourceRef(
      await this.request<EngineRegistrationRevision>('/v1/engine-registrations', {
        method: 'POST',
        body: JSON.stringify(manifest),
      })
    );
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

  async deleteEngineRegistration(ref: BimResourceRef): Promise<void> {
    await this.request<void>(this.engineRegistrationEndpoint(ref), {
      method: 'DELETE',
    });
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
    }, undefined, true, true));
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

  async adminErrorOverview(): Promise<AdminErrorOverview> {
    return this.request<AdminErrorOverview>('/v1/admin/errors/overview');
  }

  async adminListErrors(params?: {
    category?: string;
    user_id?: string;
    status_code?: number;
    search?: string;
    from_date?: string;
    to_date?: string;
    limit?: number;
    offset?: number;
  }): Promise<AdminErrorListResponse> {
    const query = new URLSearchParams();
    if (params?.category) query.set('category', params.category);
    if (params?.user_id) query.set('user_id', params.user_id);
    if (params?.status_code) query.set('status_code', String(params.status_code));
    if (params?.search) query.set('search', params.search);
    if (params?.from_date) query.set('from_date', params.from_date);
    if (params?.to_date) query.set('to_date', params.to_date);
    if (params?.limit !== undefined) query.set('limit', String(params.limit));
    if (params?.offset !== undefined) query.set('offset', String(params.offset));
    const qs = query.toString();
    return this.request<AdminErrorListResponse>(`/v1/admin/errors${qs ? `?${qs}` : ''}`);
  }
}

// ==========================================
// Generator & Legacy Conversion Types
// ==========================================

type GeneratorDistributionBounds = {
  minimum: number;
  maximum: number;
};

export type GeneratorDistribution = GeneratorDistributionBounds & (
  { kind: 'uniform'; mean?: never; stddev?: never } |
  { kind: 'normal'; mean: number; stddev: number }
);

type GeneratorFeatureBase = {
  id?: string;
  count?: number;
  unit: string;
  direction: 'minimize' | 'maximize';
  distribution: GeneratorDistribution;
  objective?: boolean;
};

export type GeneratorFeature = GeneratorFeatureBase & (
  { scope: 'selectedCandidate'; aggregation: { selection: 'sum' | 'product' | 'min' | 'max' } } |
  { scope: 'invocation'; aggregation: {
    sequence: 'sum' | 'product' | 'min' | 'max';
    parallel: 'sum' | 'product' | 'min' | 'max';
    exclusive: 'weightedSum' | 'weightedProduct' | 'min' | 'max';
    repeat: 'scale' | 'power' | 'identity';
  } }
);

export interface GenerateInstanceParams {
  tasks?: number;
  candidates?: number;
  control_flow?: number;
  loops?: number;
  branches?: number;
  parallel?: number;
  max_nesting?: number;
  iterations_per_loop?: number;
  features: GeneratorFeature[];
  distributions?: {
    candidate_count?: GeneratorDistribution;
    loop_iterations?: GeneratorDistribution;
    branches_per_decision?: GeneratorDistribution;
    constraint_optimality_percent?: GeneratorDistribution;
  };
  constraints?: number;
  constraint_count_mode?: 'exact' | 'expected';
  target_engines?: string[];
  optimization_mode?: 'weighted' | 'pareto' | null;
  guarantee_feasibility?: boolean;
  tension?: number;
  name?: string;
  profile?: string;
  dialects?: string[];
  seed?: number | null;
  persist?: boolean;
  project_id?: string | null;
  case_name?: string | null;
  use_legacy_engine?: boolean;
}

export interface InstanceGeneratedResponse {
  name: string;
  package_digest: string;
  instance_digest: string;
  ir_digest: string;
  compilation_digest: string;
  snapshot_id?: string | null;
  case_id?: string | null;
  target_engines: string[];
  workload_features: Record<string, unknown>;
  files: Record<string, unknown>;
  actual_constraint_count?: number | null;
}

export interface GenerateCorpusParams {
  count?: number;
  base_config: GenerateInstanceParams;
  name?: string;
  persist?: boolean;
  as_archive?: boolean;
}

export interface CorpusGeneratedResponse {
  name: string;
  count: number;
  instances: Array<{
    name: string;
    package_digest: string;
    ir_digest: string;
    compilation_digest: string;
    snapshot_id?: string | null;
    workload_features: Record<string, unknown>;
    actual_constraint_count: number;
  }>;
}

export interface ConvertLegacyParams {
  raw_text: string;
  name?: string;
  profile?: string;
  dialects?: string[];
  repair_empty_branches?: boolean;
  guarantee_feasibility?: boolean;
  tension?: number;
  persist?: boolean;
  project_id?: string | null;
  case_name?: string | null;
}

export const apiClient = new ApiClient();
