import { QuotaError } from '../../../../api/auth';
import type { AuthFailure } from '../../../core/api/errors';

/** The allowance a 402 names: `{ limit_id: 'members', limit: 15, used: 16 }`. */
export function quotaOf(error: unknown): QuotaError['quota'] | undefined {
  return error instanceof QuotaError ? error.quota : undefined;
}

/** A refusal that says "you are not allowed here" rather than "this failed". */
export function isForbidden(failure: AuthFailure): boolean {
  return failure.status === 403;
}
