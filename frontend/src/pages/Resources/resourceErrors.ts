import { HttpError } from '../../api/client';
import { formatByteSize } from '../../utils/format';
import { quotaOf } from '../Organization/orgErrors';
import { classifyAuthError, generalFailure, marker, type AuthFailure } from '../Project/projectErrors';

export { classifyAuthError, marker };
export type { AuthFailure };

export interface Refusal {
  kind: string;
  text: string;
}

/** The page can't read what it shows: a 404 is a different message from a failure to reach the gateway. */
export function isMissing(failure: AuthFailure | null): boolean {
  return failure?.status === 404 || failure?.kind === 'not-found';
}

/** The reason phrase of a 422 says nothing a person needs; anything else the gateway wrote is kept. */
const GENERIC_REASONS = new Set(['', 'Unprocessable Entity', 'Unprocessable Content']);

/** The gateway’s own sentence, with a leading space, when it adds something to what the screen already says. */
function gatewayNote(failure: AuthFailure): string {
  return failure.message && !GENERIC_REASONS.has(failure.message) ? ` ${failure.message}` : '';
}

/** What the gateway wrote about a refused submission, flattened to lower-case text so a refusal without a machine code can still be told apart. */
function detailText(caught: unknown): string {
  if (!(caught instanceof HttpError)) return '';
  try {
    return JSON.stringify(caught.problem ?? '').toLowerCase();
  } catch {
    return '';
  }
}

// --- files

/** The list of files can't be read. */
export function filesListRefusal(failure: AuthFailure): Refusal {
  if (failure.status === 403) {
    return { kind: 'forbidden', text: `This account or API key can’t list this project’s files${marker(failure)}.` };
  }
  return { kind: 'other', text: `The files couldn’t be loaded${marker(failure)}.` };
}

/** Uploading: 402 is the sponsor’s storage, 413 the actor’s per-request ceiling, 403 a key that can’t write. */
export function uploadRefusal(caught: unknown, context: { ceiling?: number | null; plan?: string }): Refusal {
  const failure = classifyAuthError(caught);
  if (failure.status === 402) {
    const quota = quotaOf(caught);
    const room = quota ? ` ${formatByteSize(quota.used ?? quota.limit)} of ${formatByteSize(quota.limit)} used.` : '';
    return {
      kind: 'quota',
      text: `No storage left for the sponsor${marker(failure)}.${room} This limit doesn’t renew; delete files or ask for more room. Nothing was stored.`,
    };
  }
  if (failure.status === 413) {
    const ceiling = context.ceiling ? ` (${formatByteSize(context.ceiling)}${context.plan ? ` on the ${context.plan} plan` : ''})` : '';
    return { kind: 'too-large', text: `That file is bigger than your plan allows per upload${ceiling}${marker(failure)}. Nothing was stored.` };
  }
  if (failure.status === 403) {
    return { kind: 'key', text: `This account or API key can’t write files${marker(failure)}. You can still list and download.` };
  }
  if (failure.status === 503 && failure.code === 'pricing_unavailable') {
    return { kind: 'pricing', text: `Limits can’t be checked right now${marker(failure)}. Nothing was stored.` };
  }
  if (failure.kind === 'not-found') return { kind: 'gone', text: `The project no longer exists, or you’re not in its organization${marker(failure)}. Nothing was stored.` };
  if (failure.kind === 'invalid') return { kind: 'invalid', text: `The gateway refused that file${marker(failure)}. Nothing was stored.` };
  return { kind: 'other', text: generalFailure(failure, 'nothing was stored') };
}

/** A file the plan’s ceiling rules out before anything is sent. The gateway would answer 413; asking it to is a waste of the upload. */
export function oversizeRefusal(fileName: string, size: number, ceiling: number, plan?: string): Refusal {
  return {
    kind: 'too-large',
    text: `“${fileName}” is ${formatByteSize(size)}, more than your plan allows per upload (${formatByteSize(ceiling)}${plan ? ` on the ${plan} plan` : ''}). Nothing was stored.`,
  };
}

/** Deleting a file. The prototype also shows a 409 for a file a sealed version refers to; the gateway checks only the role and the file. */
export function deleteFileRefusal(caught: unknown, name: string): Refusal {
  const failure = classifyAuthError(caught);
  if (failure.status === 409) {
    return { kind: 'in-use', text: `“${name}” is used by a sealed version, so it can’t be deleted${marker(failure)}.` };
  }
  if (failure.status === 403) {
    return { kind: 'forbidden', text: `You need ADMIN in the organization to delete files${marker(failure)}. Nothing was deleted.` };
  }
  if (failure.kind === 'not-found') return { kind: 'gone', text: `“${name}” is no longer here${marker(failure)}. It may have been deleted already.` };
  return { kind: 'other', text: generalFailure(failure, 'nothing was deleted') };
}

export function downloadRefusal(caught: unknown, name: string): Refusal {
  const failure = classifyAuthError(caught);
  if (failure.status === 403) return { kind: 'forbidden', text: `This account or API key can’t download files${marker(failure)}.` };
  if (failure.kind === 'not-found') return { kind: 'gone', text: `“${name}” can’t be found any more${marker(failure)}. Its bytes may have been removed.` };
  return { kind: 'other', text: generalFailure(failure, 'nothing was downloaded') };
}

// --- project resources

export function resourcesListRefusal(failure: AuthFailure): Refusal {
  if (failure.status === 403) {
    return { kind: 'forbidden', text: `This account or API key can’t read this project’s resources${marker(failure)}.` };
  }
  return { kind: 'other', text: `The resources couldn’t be loaded${marker(failure)}.` };
}

/** Creating a resource: the address is shared with every item of the organization, so a 409 is common. */
export function resourceCreateRefusal(caught: unknown): Refusal {
  const failure = classifyAuthError(caught);
  if (failure.status === 409) return { kind: 'address', text: `That address is already used by another item in this organization${marker(failure)}.` };
  if (failure.kind === 'invalid') return { kind: 'invalid', text: `Use lowercase letters, numbers and hyphens for the address${marker(failure)}, and give it a name.` };
  if (failure.status === 403) return { kind: 'forbidden', text: `You need MEMBER in the organization to create a resource${marker(failure)}. Nothing was created.` };
  if (failure.kind === 'not-found') return { kind: 'gone', text: `The project no longer exists, or you’re not in its organization${marker(failure)}. Nothing was created.` };
  return { kind: 'other', text: generalFailure(failure, 'nothing was created') };
}

export function resourceUpdateRefusal(caught: unknown): Refusal {
  const failure = classifyAuthError(caught);
  if (failure.kind === 'invalid') return { kind: 'invalid', text: `The gateway refused those details${marker(failure)}. A name has 1 to 160 characters and a kind up to 128. Nothing changed.` };
  if (failure.status === 403) return { kind: 'forbidden', text: `You need MEMBER in the organization to edit a resource${marker(failure)}. Nothing changed.` };
  if (failure.kind === 'not-found') return { kind: 'gone', text: `The resource no longer exists${marker(failure)}. Nothing changed.` };
  return { kind: 'other', text: generalFailure(failure, 'nothing changed') };
}

export function resourceDeleteRefusal(caught: unknown): Refusal {
  const failure = classifyAuthError(caught);
  if (failure.status === 409) return { kind: 'in-use', text: `Something sealed refers to this resource, so it can’t be deleted${marker(failure)}.` };
  if (failure.status === 403) return { kind: 'forbidden', text: `You need ADMIN in the organization to delete a resource${marker(failure)}. Nothing was deleted.` };
  if (failure.kind === 'not-found') return { kind: 'gone', text: `The resource no longer exists${marker(failure)}.` };
  return { kind: 'other', text: generalFailure(failure, 'nothing was deleted') };
}

/** Saving a new revision of a resource: a 422 is a document the gateway can’t store. */
export function resourceRevisionRefusal(caught: unknown): Refusal {
  const failure = classifyAuthError(caught);
  if (failure.kind === 'invalid') return { kind: 'invalid', text: `The gateway refused this content${marker(failure)}. Nothing was saved.${gatewayNote(failure)}` };
  if (failure.status === 403) return { kind: 'forbidden', text: `You need MEMBER in the organization to add a revision${marker(failure)}. Nothing was saved.` };
  if (failure.kind === 'not-found') return { kind: 'gone', text: `The resource no longer exists in this project${marker(failure)}. Nothing was saved.` };
  return { kind: 'other', text: generalFailure(failure, 'nothing was saved') };
}

// --- collections

export function collectionsListRefusal(failure: AuthFailure): Refusal {
  if (failure.status === 403) {
    return { kind: 'forbidden', text: `This account or API key can’t read this project’s collections${marker(failure)}.` };
  }
  return { kind: 'other', text: `The collections couldn’t be loaded${marker(failure)}.` };
}

/** Creating a collection: 402 is the sponsor’s allowance of collections, 409 an address already used. */
export function collectionCreateRefusal(caught: unknown): Refusal {
  const failure = classifyAuthError(caught);
  if (failure.status === 402) {
    const quota = quotaOf(caught);
    const room = quota ? ` ${quota.used ?? quota.limit} of ${quota.limit} collections are used.` : '';
    return { kind: 'quota', text: `The sponsor has no collections left${marker(failure)}.${room} Delete one you don’t need, or ask for more room. Nothing was created.` };
  }
  if (failure.status === 409) return { kind: 'address', text: `That address is already used by another collection in this organization${marker(failure)}.` };
  if (failure.status === 503 && failure.code === 'pricing_unavailable') return { kind: 'pricing', text: `Limits can’t be checked right now${marker(failure)}. Nothing was created.` };
  if (failure.kind === 'invalid') return { kind: 'invalid', text: `Give it a name and a valid address${marker(failure)}: lowercase letters, numbers and hyphens.` };
  if (failure.status === 403) return { kind: 'forbidden', text: `You need MEMBER in the organization to create a collection${marker(failure)}. Nothing was created.` };
  if (failure.kind === 'not-found') return { kind: 'gone', text: `The project no longer exists, or you’re not in its organization${marker(failure)}. Nothing was created.` };
  return { kind: 'other', text: generalFailure(failure, 'nothing was created') };
}

export function collectionDeleteRefusal(caught: unknown): Refusal {
  const failure = classifyAuthError(caught);
  if (failure.status === 403) return { kind: 'forbidden', text: `You need ADMIN in the organization to delete a collection${marker(failure)}. Nothing was deleted.` };
  if (failure.kind === 'not-found') return { kind: 'gone', text: `The collection no longer exists${marker(failure)}.` };
  return { kind: 'other', text: generalFailure(failure, 'nothing was deleted') };
}

export function collectionRenameRefusal(caught: unknown): Refusal {
  const failure = classifyAuthError(caught);
  if (failure.kind === 'invalid') return { kind: 'invalid', text: `The gateway refused that text${marker(failure)}. A name has 1 to 160 characters and a description up to 2,000. Nothing changed.` };
  if (failure.status === 403) return { kind: 'forbidden', text: `You need MEMBER in the organization to edit a collection${marker(failure)}. Nothing changed.` };
  if (failure.kind === 'not-found') return { kind: 'gone', text: `The collection no longer exists${marker(failure)}. Nothing changed.` };
  return { kind: 'other', text: generalFailure(failure, 'nothing changed') };
}

const TARGET_CODES = new Set(['invalid_collection_target']);

/**
 * Saving a revision: each 422 names what is wrong with the list. A repeated item, an item whose pinned fingerprint is no longer the
 * target’s, and one the gateway can’t pin are told apart; the list on the screen is kept in every case.
 */
export function collectionSaveRefusal(caught: unknown): Refusal {
  const failure = classifyAuthError(caught);
  const code = failure.code ?? '';
  if (failure.status === 422 && code === 'collection_target_mismatch') {
    return { kind: 'fingerprint', text: `An item’s fingerprint isn’t valid any more${marker(failure)}: it doesn’t belong to this project or its content changed. Remove it and add it again from its page. Nothing was saved.` };
  }
  if (failure.status === 422 && TARGET_CODES.has(code)) {
    return { kind: 'target', text: `An item doesn’t point to an exact revision${marker(failure)}. Remove it and add it again from the picker. Nothing was saved.` };
  }
  if (failure.status === 422 && code === 'unsupported_collection_target') {
    return { kind: 'unsupported', text: `Only case revisions and resource versions can be pinned in a collection${marker(failure)}. Nothing was saved.` };
  }
  if (failure.status === 422 && /repeat/.test(detailText(caught))) {
    return { kind: 'duplicate', text: `An item appears twice${marker(failure)}: a revision can’t repeat a target. Remove the duplicate. Nothing was saved.` };
  }
  if (failure.kind === 'invalid') return { kind: 'invalid', text: `The gateway refused this list${marker(failure)}.${gatewayNote(failure)} Nothing was saved.` };
  if (failure.status === 403) return { kind: 'forbidden', text: `This account or API key can’t write collections${marker(failure)}. Nothing was saved.` };
  if (failure.kind === 'not-found') return { kind: 'gone', text: `The collection no longer exists in this project${marker(failure)}. Nothing was saved.` };
  return { kind: 'other', text: generalFailure(failure, 'nothing was saved') };
}
