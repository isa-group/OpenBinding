import { PricingUnavailableError, QuotaError } from '../../api/auth';
import { HttpError } from '../../api/client';

/**
 * What went wrong with an authentication request, in the terms the screens speak.
 *
 * The gateway answers errors in two shapes (RFC 9457 problem+json, and `{ detail: { code, error } }`);
 * the client has already folded both into an HttpError, so this only looks at status and code.
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
  if (error instanceof QuotaError) return { kind: 'quota', status: 402, code: error.code, message: error.message };
  if (error instanceof PricingUnavailableError) return { kind: 'unavailable', status: 503, code: 'pricing_unavailable', message: error.message };
  if (error instanceof HttpError) {
    const base = { status: error.status, code: error.code, message: error.message.replace(/^HTTP \d+: /, ''), retryAfter: error.retryAfter };
    switch (error.status) {
      case 401: return { kind: 'rejected', ...base };
      case 404: return { kind: 'not-found', ...base };
      case 409: return { kind: 'conflict', ...base };
      case 422: return { kind: 'invalid', ...base };
      case 429: return { kind: 'busy', ...base };
      default: return { kind: error.status >= 500 ? 'unavailable' : 'unknown', ...base };
    }
  }
  if (error instanceof TypeError) return { kind: 'network' };
  return { kind: 'unknown' };
}

export type FieldErrors = Partial<Record<string, string>>;

/** Per-field messages out of a FastAPI validation body (`detail: [{ loc: ['body', 'email'], msg }]`). */
export function fieldErrorsFrom(error: unknown): FieldErrors {
  if (!(error instanceof HttpError)) return {};
  const body = error.problem;
  const detail = typeof body === 'object' && body !== null ? (body as { detail?: unknown }).detail : undefined;
  if (!Array.isArray(detail)) return {};
  const fields: FieldErrors = {};
  for (const item of detail) {
    if (typeof item !== 'object' || item === null) continue;
    const { loc, msg } = item as { loc?: unknown; msg?: unknown };
    const field = Array.isArray(loc) ? loc[loc.length - 1] : undefined;
    if (typeof field === 'string' && typeof msg === 'string' && !(field in fields)) fields[field] = msg;
  }
  return fields;
}
