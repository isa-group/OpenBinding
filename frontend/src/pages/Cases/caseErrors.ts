import { HttpError } from '../../api/client';
import { diagnosticLines } from '../../api/problem';
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

// --- composing a revision

export type IssueAction = 'dialects' | 'revisions' | 'role';

export interface Issue {
  /** Where the problem comes from: the screen's own checks or the gateway's answer. */
  source: 'check' | 'gateway';
  title: string;
  text: string;
  action?: { kind: IssueAction; label: string; role?: string };
  details?: string[];
}

const DIALECT_CODES = new Set(['profile_selection_required', 'dialect_selection_required', 'contract_not_installed', 'contract_mismatch', 'invalid_contract']);
const MISSING_CODES = new Set(['instance_required', 'missing_dependency']);
/** A snapshot whose stored package the installed compiler refuses: unlike a missing dialect, compiling it again can't work. */
export const NOT_RECOMPILABLE_CODE = 'snapshot_not_recompilable';

/** The messages inside a 422's diagnostics, so the person sees where the composition is wrong. */
function diagnosticsOf(caught: unknown): string[] {
  if (!(caught instanceof HttpError)) return [];
  // A refusal with nothing finer to say carries one diagnostic that restates its own sentence: the notice already says it.
  const said = diagnosticLines(caught, 100);
  return (caught.diagnostics ?? []).flatMap((item) => {
    if (typeof item !== 'object' || item === null) return [];
    const { message, path, pointer } = item as { message?: unknown; path?: unknown; pointer?: unknown };
    if (typeof message !== 'string' || !said.includes(message)) return [];
    const where = typeof path === 'string' && path ? path : typeof pointer === 'string' && pointer ? pointer : '';
    return [where ? `${message} (${where})` : message];
  }).slice(0, 6);
}

/** What the gateway's refusal of "create revision" means, with the way to fix it. */
export function composeRefusal(caught: unknown): Issue {
  const failure = classifyAuthError(caught);
  const code = failure.code ?? '';
  const gateway = failure.message ? ` ${failure.message}` : '';
  if (failure.kind === 'invalid' && code === NOT_RECOMPILABLE_CODE) {
    return {
      source: 'gateway',
      title: `This snapshot can’t be run${marker(failure)}`,
      text: 'The installed compiler no longer accepts the package this snapshot was made from, so it can’t be recompiled or run. The snapshot and the revisions that use it are kept unchanged as evidence. Correct the source and upload it again to get a snapshot that can run. Nothing was created.',
      details: diagnosticsOf(caught),
    };
  }
  if (failure.kind === 'invalid' && DIALECT_CODES.has(code)) {
    return {
      source: 'gateway',
      title: `A dialect isn’t installed${marker(failure)}`,
      text: `One of the picked versions was written with a dialect or profile this deployment doesn’t have.${gateway}`,
      action: { kind: 'dialects', label: 'See installed dialects' },
    };
  }
  if (failure.kind === 'invalid' && MISSING_CODES.has(code)) {
    return { source: 'gateway', title: `A part is missing${marker(failure)}`, text: `The composition lacks something the profile requires.${gateway}`, action: { kind: 'role', label: 'Check the four parts' } };
  }
  if (failure.kind === 'invalid') {
    return { source: 'gateway', title: `The composition was refused${marker(failure)}`, text: `The gateway could not build a valid problem from these parts.${gateway}`, details: diagnosticsOf(caught) };
  }
  if (failure.kind === 'not-found') {
    return { source: 'gateway', title: `A version can’t be reached${marker(failure)}`, text: `One of the picked versions isn’t visible to you any more, or never was. Nothing was created.` };
  }
  if (failure.kind === 'conflict') {
    return {
      source: 'gateway',
      title: `A version failed its integrity check${marker(failure)}`,
      text: `The stored content of a picked version doesn’t match its seal, or isn’t available right now.${gateway} Nothing was created; your choices are kept.`,
    };
  }
  if (failure.status === 403) {
    return {
      source: 'gateway',
      title: `This credential can’t create revisions here${marker(failure)}`,
      text: 'Creating a revision needs MEMBER in the organization and, for an API key, the projects:write permission on this project. Use a session or a key that includes this project.',
    };
  }
  return { source: 'gateway', title: 'The revision couldn’t be created', text: generalFailure(failure, 'nothing was created') };
}

/** A library version that can't be looked up while checking the composition. */
export function resolveRefusal(caught: unknown, label: string): Issue {
  const failure = classifyAuthError(caught);
  if (failure.kind === 'not-found') {
    return {
      source: 'gateway',
      title: `A version can’t be reached${marker(failure)}`,
      text: `${label} isn’t visible to you any more, or never was.`,
    };
  }
  if (failure.status === 403) {
    return { source: 'gateway', title: `The library can’t be read with this credential${marker(failure)}`, text: `${label} could not be checked. Use a session or a key that includes the library.` };
  }
  return { source: 'gateway', title: `${label} could not be checked`, text: generalFailure(failure, 'nothing was checked') };
}

// --- a snapshot

/** Why a snapshot can't be shown; the gateway answers 404 the same for a snapshot that doesn't exist and one that isn't yours. */
export function snapshotFailureKind(failure: AuthFailure): 'missing' | 'key' | 'other' {
  if (failure.kind === 'not-found') return 'missing';
  if (failure.status === 403) return 'key';
  return 'other';
}
