import { classifyAuthError, marker, quotaOf } from './orgErrors';

function limitText(caught: unknown): string {
  const quota = quotaOf(caught);
  return quota ? ` ${quota.limit_id}: ${quota.used ?? '?'} of ${quota.limit} used.` : '';
}

/** The words for each way the gateway can refuse making the caller the sponsor of an organization. */
export function sponsorRefusal(caught: unknown): string {
  const failure = classifyAuthError(caught);
  const mark = marker(failure);
  switch (failure.code) {
    case 'sponsor_must_be_caller':
      return `Only you can make yourself the sponsor${mark}. Nothing changed.`;
    case 'sponsor_quota_exceeded':
      return `The new sponsor’s plan has no room for this organization and everything under it${mark}.${limitText(caught)} Nothing changed.`;
    case 'pricing_unavailable':
      return `Limits can’t be checked right now${mark}. Nothing changed. Try again in a moment.`;
    case 'invalid_sponsor':
      return `That account can’t be a sponsor${mark}: sponsors must be active accounts.`;
    default:
      if (failure.kind === 'unavailable') return `A service OpenBinding depends on isn’t answering${mark}. Nothing changed. Try again in a moment.`;
      if (failure.kind === 'network') return 'OpenBinding couldn’t be reached. Nothing changed. Check your connection and try again.';
      if (failure.kind === 'rejected') return `Your session has ended${mark}. Log in again to continue.`;
      return `That couldn’t be done${mark}. Nothing changed.`;
  }
}
