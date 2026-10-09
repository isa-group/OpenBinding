import { classifyAuthError, generalFailure, marker, quotaOf, type AuthFailure } from '../Organization/orgErrors';

export { classifyAuthError, generalFailure, marker };
export type { AuthFailure };

export type ProjectRefusalKind = 'slug' | 'quota' | 'pricing' | 'forbidden' | 'gone' | 'invalid' | 'other';

export interface ProjectRefusal {
  kind: ProjectRefusalKind;
  text: string;
  /** The allowance a 402 names (`projects`, `privateProjects`). */
  limitId?: string;
}

function quotaText(caught: unknown, fallback: string): string {
  const quota = quotaOf(caught);
  return quota ? ` ${quota.used ?? quota.limit} of ${quota.limit} ${fallback}.` : '';
}

/** The words for each way the gateway can refuse a new project. */
export function createRefusal(caught: unknown, context: { organization: string; isPrivate: boolean }): ProjectRefusal {
  const failure = classifyAuthError(caught);
  if (failure.status === 409) {
    return { kind: 'slug', text: `That address is already used in ${context.organization}${marker(failure)}.` };
  }
  if (failure.status === 402) {
    const limitId = quotaOf(caught)?.limit_id ?? (context.isPrivate ? 'privateProjects' : 'projects');
    const what = limitId === 'privateProjects' ? 'private projects' : 'projects';
    return { kind: 'quota', limitId, text: `The sponsor has no ${what} left${marker(failure)}.${quotaText(caught, what)}` };
  }
  if (failure.status === 503 && failure.code === 'pricing_unavailable') {
    return { kind: 'pricing', text: `Limits can’t be checked right now${marker(failure)}. Nothing was created.` };
  }
  if (failure.status === 403) {
    return { kind: 'forbidden', text: `You need MEMBER in ${context.organization} to create a project${marker(failure)}. Nothing was created.` };
  }
  if (failure.kind === 'not-found') {
    return { kind: 'gone', text: `${context.organization} no longer exists, or you’re not in it${marker(failure)}. Nothing was created.` };
  }
  if (failure.kind === 'invalid') {
    return { kind: 'invalid', text: `The gateway refused these values${marker(failure)}. Check the name, the address and the description.` };
  }
  return { kind: 'other', text: generalFailure(failure, 'nothing was created') };
}

/** Saving the name and description, or changing the visibility. */
export function updateRefusal(caught: unknown, change: 'details' | 'visibility'): ProjectRefusal {
  const failure = classifyAuthError(caught);
  if (failure.status === 402) {
    const limitId = quotaOf(caught)?.limit_id ?? 'privateProjects';
    return {
      kind: 'quota',
      limitId,
      text: `The sponsor has no private projects left${marker(failure)}.${quotaText(caught, 'private projects')} Make another project public or ask the sponsor to free one, or keep this one public. Nothing changed.`,
    };
  }
  if (failure.status === 503 && failure.code === 'pricing_unavailable') {
    return { kind: 'pricing', text: `Limits can’t be checked right now${marker(failure)}. Nothing changed.` };
  }
  if (failure.status === 403) {
    return { kind: 'forbidden', text: `You need ADMIN in the organization to change this${marker(failure)}. Nothing changed.` };
  }
  if (failure.kind === 'not-found') {
    return { kind: 'gone', text: `The project no longer exists, or you’re not in its organization${marker(failure)}. Nothing changed.` };
  }
  if (failure.kind === 'invalid') {
    return { kind: 'invalid', text: `The gateway refused that ${change === 'details' ? 'name or description' : 'visibility'}${marker(failure)}.` };
  }
  return { kind: 'other', text: generalFailure(failure, 'nothing changed') };
}

/** Deleting: sealed history is a 409 with its own explanation. */
export function deleteRefusal(caught: unknown): ProjectRefusal {
  const failure = classifyAuthError(caught);
  if (failure.status === 409) {
    return {
      kind: 'slug',
      text: `This project has sealed history (published reports, study runs or case revisions), so it can’t be deleted${marker(failure)}. Sealed history must stay reachable so people can still verify it.`,
    };
  }
  if (failure.status === 403) {
    return { kind: 'forbidden', text: `You need ADMIN in the organization to delete a project${marker(failure)}. Nothing was deleted.` };
  }
  if (failure.kind === 'not-found') {
    return { kind: 'gone', text: `The project no longer exists${marker(failure)}.` };
  }
  if (failure.status === 503 && failure.code === 'pricing_unavailable') {
    return { kind: 'pricing', text: `Limits can’t be checked right now${marker(failure)}. Nothing was deleted.` };
  }
  return { kind: 'other', text: generalFailure(failure, 'nothing was deleted') };
}

export type ImportRefusalKind = 'unpublished' | 'collision' | 'fingerprint' | 'engine' | 'too-large' | 'forbidden' | 'unreadable' | 'unavailable' | 'gone' | 'other';

export interface ImportRefusal {
  kind: ImportRefusalKind;
  title: string;
  text: string;
}

const COLLISION_CODES = new Set(['case_identity_conflict', 'version_conflict', 'run_identity_conflict', 'job_identity_conflict', 'evidence_identity_conflict']);
const UNPUBLISHED_CODES = new Set(['unpublished_import', 'external_namespace_unavailable', 'publication_withdrawn', 'private_dependency']);

/** What the gateway's answer to an import means, with the code a person can quote. */
export function importRefusal(caught: unknown): ImportRefusal {
  const failure = classifyAuthError(caught);
  const code = failure.code ?? '';
  const gateway = failure.message ? ` ${failure.message}` : '';
  if (failure.status === 413) {
    return { kind: 'too-large', title: `Package too large${marker(failure)}`, text: 'This package is bigger than your plan allows per request. Nothing was imported.' };
  }
  if (failure.status === 403) {
    return {
      kind: 'forbidden',
      title: `This account or API key can’t import${marker(failure)}`,
      text: 'Importing writes cases and artifacts, so it needs MEMBER in the organization and, for a key, the projects:write permission. Export still works.',
    };
  }
  if (failure.kind === 'not-found') {
    return { kind: 'gone', title: `Project not found${marker(failure)}`, text: 'It no longer exists, or you’re not a member of its organization. Nothing was imported.' };
  }
  if (failure.status === 409 && UNPUBLISHED_CODES.has(code)) {
    return {
      kind: 'unpublished',
      title: `Unpublished items from another organization${marker(failure)}`,
      text: `The package refers to library versions or reports that were never published, so they can’t be brought into a different organization. Ask the source to publish them first.${gateway}`,
    };
  }
  if (failure.status === 409 && COLLISION_CODES.has(code)) {
    return {
      kind: 'collision',
      title: `Name already used with different content${marker(failure)}`,
      text: `Something in this project has the same identity as an item in the package but a different fingerprint. Rename one of them before importing.${gateway}`,
    };
  }
  if (failure.status === 409 && code === 'toolchain_mismatch') {
    return {
      kind: 'engine',
      title: `Engine revision not available here${marker(failure)}`,
      text: `The package was made with a compilation or engine revision this deployment doesn’t have, so it can’t be imported.${gateway}`,
    };
  }
  if (failure.status === 422 && code === 'checksum_mismatch') {
    return {
      kind: 'fingerprint',
      title: `Fingerprint doesn’t match${marker(failure)}`,
      text: `Something in the package hashes to a different value than it declares. The file was changed or damaged after export; nothing was imported.${gateway}`,
    };
  }
  if (failure.kind === 'invalid' || failure.status === 409) {
    return { kind: 'unreadable', title: `The package can’t be imported${marker(failure)}`, text: `${gateway.trim() || 'The gateway refused its content.'} Nothing was imported.` };
  }
  if (failure.kind === 'unavailable' || failure.kind === 'network') {
    return { kind: 'unavailable', title: 'The import couldn’t finish', text: generalFailure(failure, 'nothing was imported') };
  }
  return { kind: 'other', title: 'The import couldn’t finish', text: generalFailure(failure, 'nothing was imported') };
}

/** What the export can say when it fails. */
export function exportFailure(caught: unknown): string {
  const failure = classifyAuthError(caught);
  if (failure.status === 403) return `Your credential can’t read this project${marker(failure)}, so nothing was exported.`;
  if (failure.kind === 'not-found') return `The project no longer exists, or you’re not in its organization${marker(failure)}.`;
  if (failure.status === 409) return `Part of the project’s history can’t be exported${marker(failure)}.${failure.message ? ` ${failure.message}` : ''}`;
  return generalFailure(failure, 'nothing was exported');
}
