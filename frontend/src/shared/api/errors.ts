import { PricingUnavailableError, QuotaError } from '../../api/auth';
import { HttpError } from '../../api/client';
import { diagnosticsOf, type Diagnostic } from '../../api/problem';

// How the frontend reads a refusal of the gateway. The gateway answers in two envelopes (docs/ERRORS.md): the flat problem
// document `{type, title, status, code, detail, diagnostics}` on every 422 and under the language prefixes, and
// `{detail: {code, error}}` beside `type/title/status/code` elsewhere. The client folds both into an HttpError; these read it.

/** A refusal, whichever envelope it came in. */
export interface ApiError {
  /** The HTTP status, or 0 when the request never got an answer. */
  status: number;
  /** The machine code the gateway sent (`precondition_failed`, `rate_limited`, …), or `network` / `unknown`. */
  code: string;
  /** The gateway's own sentence, without the `HTTP nnn:` prefix. */
  message: string;
  /** The findings of a 422 (and of any refusal that carries them), completed by `readDiagnostics`. */
  diagnostics: Diagnostic[];
  /** The resource's current `ETag`, on a 412: re-read, merge and retry with it. */
  etag?: string;
  /** Seconds to wait before trying again, on a 429 (or a 503 that says when). */
  retryAfter?: number;
}

const sentence = (error: Error) => error.message.replace(/^HTTP \d+:\s*/, '').trim();

/** Read any thrown value as an `ApiError`. */
export function readApiError(error: unknown): ApiError {
  if (error instanceof HttpError) {
    return {
      status: error.status,
      code: error.code ?? 'unknown',
      message: sentence(error),
      diagnostics: diagnosticsOf(error),
      ...(error.etag !== undefined ? { etag: error.etag } : {}),
      ...(error.retryAfter !== undefined ? { retryAfter: error.retryAfter } : {}),
    };
  }
  if (error instanceof QuotaError)
    return { status: 402, code: error.code, message: error.message, diagnostics: [] };
  if (error instanceof PricingUnavailableError)
    return { status: 503, code: 'pricing_unavailable', message: error.message, diagnostics: [] };
  if (error instanceof TypeError)
    return { status: 0, code: 'network', message: error.message, diagnostics: [] };
  return {
    status: 0,
    code: 'unknown',
    message: error instanceof Error ? error.message : '',
    diagnostics: [],
  };
}

/**
 * What went wrong with a request, in the terms the screens speak. The client has already folded both envelopes into an
 * HttpError, so this only looks at status and code.
 */
export type AuthFailureKind =
  | 'rejected' // 401: wrong credentials, spent token, bad code
  | 'conflict' // 409
  | 'invalid' // 422
  | 'quota' // 402
  | 'not-found' // 404
  | 'busy' // 429
  | 'unavailable' // 503, or pricing/accounts down
  | 'network' // the request never got an answer
  | 'unknown';

export interface AuthFailure {
  kind: AuthFailureKind;
  status?: number;
  /** The machine code the gateway sent (`invalid_credentials`, `weak_password`, …), if any. */
  code?: string;
  /** The gateway's own sentence, for places where it is safe and useful to show it. */
  message?: string;
  retryAfter?: number;
}

export function classifyAuthError(error: unknown): AuthFailure {
  if (error instanceof QuotaError)
    return { kind: 'quota', status: 402, code: error.code, message: error.message };
  if (error instanceof PricingUnavailableError)
    return {
      kind: 'unavailable',
      status: 503,
      code: 'pricing_unavailable',
      message: error.message,
    };
  if (error instanceof HttpError) {
    const base = {
      status: error.status,
      code: error.code,
      message: error.message.replace(/^HTTP \d+: /, ''),
      retryAfter: error.retryAfter,
    };
    switch (error.status) {
      case 401:
        return { kind: 'rejected', ...base };
      case 404:
        return { kind: 'not-found', ...base };
      case 409:
        return { kind: 'conflict', ...base };
      case 422:
        return { kind: 'invalid', ...base };
      case 429:
        return { kind: 'busy', ...base };
      default:
        return { kind: error.status >= 500 ? 'unavailable' : 'unknown', ...base };
    }
  }
  if (error instanceof TypeError) return { kind: 'network' };
  return { kind: 'unknown' };
}

/** `(409 · last_owner)`: the status and the machine code the gateway sent, for people who need to quote them. */
export function marker(failure: AuthFailure): string {
  const parts = [failure.status, failure.code].filter(part => part !== undefined && part !== '');
  return parts.length ? ` (${parts.join(' · ')})` : '';
}
