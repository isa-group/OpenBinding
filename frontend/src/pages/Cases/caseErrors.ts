import { classifyAuthError, generalFailure, marker, type AuthFailure } from '../Project/projectErrors';

export { classifyAuthError, marker };
export type { AuthFailure };

export interface Refusal {
  kind: 'address' | 'invalid' | 'forbidden' | 'gone' | 'sealed' | 'other';
  text: string;
}

/** The words for each way the gateway can refuse a new case. */
export function createRefusal(caught: unknown): Refusal {
  const failure = classifyAuthError(caught);
  if (failure.status === 409) return { kind: 'address', text: `That address is already used by another case in this project${marker(failure)}.` };
  if (failure.kind === 'invalid') return { kind: 'invalid', text: `Give it a name and a valid address${marker(failure)}: lowercase letters, numbers and hyphens.` };
  if (failure.status === 403) return { kind: 'forbidden', text: `You need MEMBER in the organization to create a case${marker(failure)}. Nothing was created.` };
  if (failure.kind === 'not-found') return { kind: 'gone', text: `The project no longer exists, or you’re not in its organization${marker(failure)}. Nothing was created.` };
  return { kind: 'other', text: generalFailure(failure, 'nothing was created') };
}

/** Saving the description (or the name) of a case. */
export function updateRefusal(caught: unknown): Refusal {
  const failure = classifyAuthError(caught);
  if (failure.kind === 'invalid') return { kind: 'invalid', text: `The gateway refused that text${marker(failure)}. A description can have up to 2,000 characters.` };
  if (failure.status === 403) return { kind: 'forbidden', text: `You need MEMBER in the organization to edit a case${marker(failure)}. Nothing changed.` };
  if (failure.kind === 'not-found') return { kind: 'gone', text: `The case no longer exists${marker(failure)}. Nothing changed.` };
  return { kind: 'other', text: generalFailure(failure, 'nothing changed') };
}

/** Deleting: a case that holds sealed revisions is a 409 with its own explanation. */
export function deleteRefusal(caught: unknown): Refusal {
  const failure = classifyAuthError(caught);
  if (failure.status === 409) {
    return {
      kind: 'sealed',
      text: `This case has sealed revisions, so it can’t be deleted${marker(failure)}. Sealed history stays reachable so people can still verify it.`,
    };
  }
  if (failure.status === 403) return { kind: 'forbidden', text: `You need ADMIN in the organization to delete a case${marker(failure)}. Nothing was deleted.` };
  if (failure.kind === 'not-found') return { kind: 'gone', text: `The case no longer exists${marker(failure)}.` };
  return { kind: 'other', text: generalFailure(failure, 'nothing was deleted') };
}

/** A page that can't read its case: a 404 is a different message from a failure to reach the gateway. */
export function isMissing(failure: AuthFailure | null): boolean {
  return failure?.status === 404 || failure?.kind === 'not-found';
}

// --- a snapshot

/** Why a snapshot can't be shown; the gateway answers 404 the same for a snapshot that doesn't exist and one that isn't yours. */
export function snapshotFailureKind(failure: AuthFailure): 'missing' | 'key' | 'other' {
  if (failure.kind === 'not-found') return 'missing';
  if (failure.status === 403) return 'key';
  return 'other';
}
