import { readApiError } from '../../../core/api/errors';

/** The sentence a refused batch shows. A batch applies together or not at all. */
export function batchRefusal(error: unknown): string {
  const refusal = readApiError(error);
  const code = refusal.code === 'unknown' ? '' : ` (${refusal.status} · ${refusal.code})`;
  switch (refusal.code) {
    case 'owner_role_requires_owner':
      return `Only an owner can change an owner${code}. Nothing changed: a batch applies together or not at all.`;
    case 'last_owner':
      return `The organization keeps one owner${code}. Hand it over with the crown first.`;
    case 'member_not_found':
      return `One of these people isn’t a member of this organization${code}. Refresh and try again.`;
    case 'organization_forbidden':
      return `You need ADMIN here to change members${code}. Nothing changed.`;
    default:
      return refusal.status === 422
        ? `The same person appears twice, or a change is malformed${code}. Each person can have one change.`
        : `${refusal.message || 'The changes were not saved'}${code}. Nothing changed.`;
  }
}
