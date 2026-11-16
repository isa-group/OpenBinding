import { diagnosticsOf, type Diagnostic } from '../../api/problem';
import { generalFailure } from '../../features/workspace/errors';
import { classifyAuthError, marker, type AuthFailure } from '../../shared/api/errors';

export interface Refusal {
  kind: 'address' | 'invalid' | 'forbidden' | 'gone' | 'sealed' | 'quota' | 'size' | 'other';
  text: string;
  /** Where a refused package is wrong, file by file (422 `invalid_instance`). */
  diagnostics?: Diagnostic[];
}

/**
 * The words for each way the gateway can refuse an uploaded package, as a new problem or as a new version of one (`what` names it):
 * a taken address (409), a full plan (402), a package too large (413) or of another type (415), and a package the compiler refuses (422,
 * with its diagnostics).
 */
export function uploadRefusal(caught: unknown, what: 'problem' | 'version' = 'problem'): Refusal {
  const failure = classifyAuthError(caught);
  const nothing = what === 'problem' ? 'nothing was created' : 'no version was saved';
  if (failure.status === 409 && failure.code === 'slug_conflict')
    return {
      kind: 'address',
      text: `That address is already used by another problem in this organization${marker(failure)}. Pick another one.`,
    };
  if (failure.status === 402)
    return {
      kind: 'quota',
      text: `Your plan has no room for this${marker(failure)}: it counts your problems and the size of the packages you upload. Nothing was saved.`,
    };
  if (failure.status === 413)
    return {
      kind: 'size',
      text: `The package is larger than you can upload${marker(failure)}, so ${nothing}.`,
    };
  if (failure.status === 415)
    return {
      kind: 'invalid',
      text: `That file isn’t a .bim.zip package${marker(failure)}, so ${nothing}.`,
    };
  if (failure.kind === 'invalid') {
    const diagnostics = diagnosticsOf(caught);
    return failure.code === 'invalid_slug'
      ? {
          kind: 'invalid',
          text: `The address can only have lowercase letters, numbers and hyphens${marker(failure)}.`,
        }
      : {
          kind: 'invalid',
          text: `The package was read and refused${marker(failure)}, so ${nothing}. Fix what is listed and upload it again.`,
          diagnostics,
        };
  }
  if (failure.status === 403)
    return {
      kind: 'forbidden',
      text: `You need MEMBER in the organization to upload problems${marker(failure)}. Nothing was saved.`,
    };
  if (failure.kind === 'not-found')
    return {
      kind: 'gone',
      text: `The ${what === 'problem' ? 'organization' : 'problem'} no longer exists, or you’re not in its organization${marker(failure)}. Nothing was saved.`,
    };
  return { kind: 'other', text: generalFailure(failure, nothing) };
}

/** Saving the description (or the name) of a case. */
export function updateRefusal(caught: unknown): Refusal {
  const failure = classifyAuthError(caught);
  if (failure.kind === 'invalid')
    return {
      kind: 'invalid',
      text: `The gateway refused that text${marker(failure)}. A description can have up to 2,000 characters.`,
    };
  if (failure.status === 403)
    return {
      kind: 'forbidden',
      text: `You need MEMBER in the organization to edit a problem${marker(failure)}. Nothing changed.`,
    };
  if (failure.kind === 'not-found')
    return {
      kind: 'gone',
      text: `The problem no longer exists${marker(failure)}. Nothing changed.`,
    };
  return { kind: 'other', text: generalFailure(failure, 'nothing changed') };
}

/** Deleting: a problem whose versions runs or studies name is a 409 with its own explanation. */
export function deleteRefusal(caught: unknown): Refusal {
  const failure = classifyAuthError(caught);
  if (failure.status === 409) {
    return {
      kind: 'sealed',
      text: `Runs or studies name a version of this problem, so it can’t be deleted${marker(failure)}. It stays as their evidence.`,
    };
  }
  if (failure.status === 403)
    return {
      kind: 'forbidden',
      text: `You need ADMIN in the organization to delete a problem${marker(failure)}. Nothing was deleted.`,
    };
  if (failure.kind === 'not-found')
    return { kind: 'gone', text: `The problem no longer exists${marker(failure)}.` };
  return { kind: 'other', text: generalFailure(failure, 'nothing was deleted') };
}

/** A page that can't read its case: a 404 is a different message from a failure to reach the gateway. */
export function isMissing(failure: AuthFailure | null): boolean {
  return failure?.status === 404 || failure?.kind === 'not-found';
}

// --- the source of a revision

/** Why the source or the compilation of a revision can't be shown. */
export function sourceFailureKind(failure: AuthFailure): 'missing' | 'key' | 'recompile' | 'other' {
  if (failure.kind === 'not-found') return 'missing';
  if (failure.status === 403) return 'key';
  if (failure.code === 'revision_not_recompilable') return 'recompile';
  return 'other';
}
