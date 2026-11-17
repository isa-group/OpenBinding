// The gateway transport, taken out of api/client.ts so that SPHERE-style module APIs (`use<Domain>Api()` over
// `useAuth().fetchWithInterceptor`) and the legacy client share one session: the bearer token, the single-flight refresh
// rotation, the typed refusals and the session-ended event. api/client.ts extends it until the client is emptied (D8).

import { config } from '../../../config';
import { PricingUnavailableError, QuotaError } from './account';
import {
  bindingSpaceFrom,
  limitNoticeFrom,
  type BindingSpaceReport,
  type LimitNotice,
} from './limitNotice';

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
  /** The current `ETag` a 412 names (docs/ERRORS.md, "Conditional writes"): the revision to re-read before retrying. */
  etag?: string;
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
export const REFRESH_TOKEN_KEY = 'openbinding-refresh-token';
export const PRICING_TOKEN_KEY = 'pricingToken';

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

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isAbortError(error: unknown): boolean {
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

/** The typed error a refused answer stands for (see `HttpTransport.errorFor`); module APIs over `fetchWithInterceptor` throw it. */
export async function errorFromResponse(response: Response): Promise<Error> {
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
    const quotaError = new QuotaError(
      code ?? 'quota_exceeded',
      message,
      quotaFromProblem(rawQuota)
    );
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
    if (
      isRecord(rawConcurrency) &&
      typeof rawConcurrency.limit_id === 'string' &&
      typeof rawConcurrency.limit === 'number'
    ) {
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
  const retryAfter = parseInt(response.headers.get('Retry-After') ?? '', 10);
  if (!isNaN(retryAfter)) error.retryAfter = retryAfter;
  const etag = response.status === 412 ? response.headers.get('ETag') : null;
  if (etag) error.etag = etag;
  error.notice = notice;
  error.bindingSpace = bindingSpace;
  error.diagnostics = Array.isArray(problemObject?.diagnostics)
    ? problemObject.diagnostics
    : Array.isArray(detail?.diagnostics)
      ? detail.diagnostics
      : [];
  return error;
}

/**
 * The body of an answer `fetchWithInterceptor` returned, as SPHERE's module APIs read it: JSON when it is a success (nothing for a
 * 204), the typed error of `errorFromResponse` otherwise, so `readApiError` reads the refusal.
 */
export async function readResponse<T>(response: Response): Promise<T> {
  if (!response.ok) throw await errorFromResponse(response);
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export class HttpTransport {
  readonly baseUrl: string;
  /** In flight refresh, so that ten simultaneous 401s cause one refresh. */
  protected refreshing: Promise<boolean> | null = null;

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

  protected authHeaders(): Record<string, string> {
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
  protected async refreshSession(): Promise<boolean> {
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

  protected endSession(): void {
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
  async errorFor(response: Response): Promise<Error> {
    return errorFromResponse(response);
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
    read: (response: Response) => Promise<T> = response => response.json()
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
        return (await response.json()) as T;
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
  protected revised<T>(
    endpoint: string,
    ifMatch: string | null,
    init: Omit<RequestInit, 'headers'> = {}
  ): Promise<Revised<T>> {
    return this.request<Revised<T>>(
      endpoint,
      ifMatch ? { ...init, headers: { 'If-Match': ifMatch } } : init,
      undefined,
      true,
      true,
      async response => ({
        value: (await response.json()) as T,
        etag: response.headers.get('ETag'),
      })
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
    retryOnUnauthorized = true
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

  /**
   * SPHERE's `fetchWithInterceptor`, over this transport: a `fetch` against the gateway with the bearer token, one silent
   * refresh on a 401 (shared by every caller: the gateway rotates refresh tokens, so two refreshes would race), and the
   * session ended when that fails. It answers the raw `Response`, as SPHERE's does; `errorFor` reads a refusal.
   */
  fetchWithInterceptor = async (
    path: string,
    init: RequestInit = {},
    retryOnUnauthorized = true
  ): Promise<Response> => {
    const url = /^https?:\/\//.test(path) ? path : `${this.baseUrl}${path}`;
    const headers = new Headers(init.headers);
    for (const [name, value] of Object.entries(this.authHeaders())) {
      if (!headers.has(name)) headers.set(name, value);
    }
    if (typeof init.body === 'string' && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }
    const response = await fetch(url, { ...init, headers });
    if (response.status === 401 && retryOnUnauthorized && this.getAccessToken()) {
      if (await this.refreshSession()) return this.fetchWithInterceptor(path, init, false);
      this.endSession();
    }
    return response;
  };
}

/**
 * The one transport of the application. Every module's client sends through it, so the session, its single refresh and the
 * session-ended event are shared; `useAuth().fetchWithInterceptor` is its `fetchWithInterceptor`.
 */
export const apiClient = new HttpTransport();
