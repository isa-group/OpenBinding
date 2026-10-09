import { classifyAuthError, type AuthFailure } from '../Auth/authErrors';

export { classifyAuthError };
export type { AuthFailure };

/** `(409 · last_owner)`: the status and the machine code the gateway sent, for people who need to quote them. */
export function marker(failure: AuthFailure): string {
  const parts = [failure.status, failure.code].filter((part) => part !== undefined && part !== '');
  return parts.length ? ` (${parts.join(' · ')})` : '';
}

/**
 * What to say about a failure that has no sentence of its own. `doing` completes “… couldn’t be {doing}”:
 * the account is never described as changed when it was not.
 */
export function fallbackMessage(failure: AuthFailure, doing: string): string {
  if (failure.kind === 'network') return `OpenBinding couldn’t be reached, so nothing was ${doing}. Check your connection and try again.`;
  if (failure.kind === 'unavailable') return `A service OpenBinding depends on isn’t answering${marker(failure)}. Nothing was ${doing}; try again in a moment.`;
  if (failure.kind === 'busy') return `Too many requests${marker(failure)}. Wait a moment and try again.`;
  return `That couldn’t be done${marker(failure)}. Nothing was ${doing}.`;
}
