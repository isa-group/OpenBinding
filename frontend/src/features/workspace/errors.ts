import { marker, type AuthFailure } from '../../modules/core/api/errors';

// How the screens of the workspace word a refusal of the gateway that none of their own cases explains.

/**
 * The sentence for a failure none of the screen's own cases explains. `nothing` completes “… so {nothing}”:
 * what was left untouched, so a person never wonders whether half of it happened.
 */
export function generalFailure(failure: AuthFailure, nothing: string): string {
  switch (failure.kind) {
    case 'network':
      return `OpenBinding couldn’t be reached, so ${nothing}. Check your connection and try again.`;
    case 'unavailable':
      return `A service OpenBinding depends on isn’t answering${marker(failure)}, so ${nothing}. Try again in a moment.`;
    case 'busy':
      return `Too many requests${marker(failure)}. Wait a moment and try again.`;
    case 'rejected':
      return `Your session has ended${marker(failure)}. Log in again to continue.`;
    default:
      return `That couldn’t be done${marker(failure)}, so ${nothing}.`;
  }
}
