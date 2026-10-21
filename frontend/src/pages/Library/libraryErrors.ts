import { classifyAuthError, generalFailure, marker, type AuthFailure } from '../Project/projectErrors';
import { kindLabel } from './libraryModel';

export { classifyAuthError, marker };
export type { AuthFailure };

export interface Refusal {
  kind: string;
  text: string;
}

const KEY_BOUNDARY = 'api_key_boundary';

/** A 403 is either the key's boundary or the role; the gateway names the first and says nothing special about the second. */
const isBoundary = (failure: AuthFailure) => failure.status === 403 && failure.code === KEY_BOUNDARY;

/** The library can't be listed. */
export function listRefusal(failure: AuthFailure): Refusal {
  if (failure.status === 403) {
    return {
      kind: 'forbidden',
      text: isBoundary(failure)
        ? `This API key is limited to other organizations or kinds${marker(failure)}, so this library can’t be listed with it.`
        : `This account or API key can’t list this library${marker(failure)}.`,
    };
  }
  return { kind: 'other', text: `The library couldn’t be loaded${marker(failure)}.` };
}

/** The words for each way the gateway can refuse a new library item. */
export function createRefusal(caught: unknown, made: { kind: string; name: string }): Refusal {
  const failure = classifyAuthError(caught);
  if (failure.status === 409) {
    return { kind: 'exists', text: `There’s already a ${kindLabel(made.kind)} called “${made.name}” here${marker(failure)}. Pick another fixed name.` };
  }
  if (failure.status === 422 && failure.code === 'operational_pricing_only') {
    return {
      kind: 'pricing',
      text: `Pricing documents can’t live in the library${marker(failure)}. Plans and prices are managed by the platform’s pricing tools.`,
    };
  }
  if (failure.kind === 'invalid') return { kind: 'invalid', text: `Choose a kind and a valid fixed name${marker(failure)}: letters, numbers, dots, hyphens and underscores.` };
  if (failure.status === 403) {
    return {
      kind: 'forbidden',
      text: isBoundary(failure)
        ? `This API key is limited to other organizations or kinds${marker(failure)}, so it can’t create this item. Nothing was created.`
        : `You need MEMBER in the organization to create a library item${marker(failure)}. Nothing was created.`,
    };
  }
  if (failure.kind === 'not-found') return { kind: 'gone', text: `The organization no longer exists, or you’re not in it${marker(failure)}. Nothing was created.` };
  return { kind: 'other', text: generalFailure(failure, 'nothing was created') };
}

export function renameRefusal(caught: unknown): Refusal {
  const failure = classifyAuthError(caught);
  if (failure.kind === 'invalid') return { kind: 'invalid', text: `The gateway refused that display name${marker(failure)}. Use 1 to 160 characters.` };
  if (failure.status === 403) return { kind: 'forbidden', text: `You need MEMBER in the owning organization to rename it${marker(failure)}. Nothing changed.` };
  if (failure.kind === 'not-found') return { kind: 'gone', text: `The item no longer exists, or you can’t read it${marker(failure)}. Nothing changed.` };
  return { kind: 'other', text: generalFailure(failure, 'nothing changed') };
}

/** Making a draft, blank or from a version. */
export function draftRefusal(caught: unknown): Refusal {
  const failure = classifyAuthError(caught);
  if (failure.kind === 'invalid') return { kind: 'invalid', text: `The gateway refused that starting point${marker(failure)}.${failure.message ? ` ${failure.message}` : ''} No draft was made.` };
  if (failure.status === 403) {
    return { kind: 'forbidden', text: `Drafts need MEMBER in the owning organization${isBoundary(failure) ? ' and a key that can write the library' : ''}${marker(failure)}. No draft was made.` };
  }
  if (failure.kind === 'not-found') return { kind: 'gone', text: `The item or the version to start from can’t be read${marker(failure)}. No draft was made.` };
  return { kind: 'other', text: generalFailure(failure, 'no draft was made') };
}

/** Saving a draft: a 409 is somebody else's save (or a seal) winning the race. */
export function saveRefusal(caught: unknown): Refusal {
  const failure = classifyAuthError(caught);
  if (failure.status === 409) return { kind: 'conflict', text: `Someone saved this draft while you were editing${marker(failure)}.` };
  if (failure.kind === 'invalid') return { kind: 'invalid', text: `The gateway refused this content${marker(failure)}.${failure.message ? ` ${failure.message}` : ''} Nothing was saved.` };
  if (failure.status === 403) return { kind: 'forbidden', text: `This API key can’t write library items${marker(failure)}, so the editor is read-only.` };
  if (failure.kind === 'not-found') return { kind: 'gone', text: `The draft no longer exists${marker(failure)}. It may have been sealed.` };
  return { kind: 'other', text: generalFailure(failure, 'nothing was saved') };
}

const VERSION_CODES = new Set(['version_conflict', 'immutable_version', 'draft_sealed']);

/** Sealing: the version label can be taken, the draft can have moved, or the content can be invalid. */
export function sealRefusal(caught: unknown, label: string): Refusal {
  const failure = classifyAuthError(caught);
  const code = failure.code ?? '';
  if (failure.status === 409 && VERSION_CODES.has(code)) {
    return { kind: 'version', text: `${label ? `Version ${label} already exists` : 'That version already exists'}${marker(failure)}. Choose another label.` };
  }
  if (failure.status === 409 && code === 'artifact_archived') return { kind: 'archived', text: `This item is archived, so it can’t receive new versions${marker(failure)}.` };
  if (failure.status === 409) return { kind: 'conflict', text: `The draft changed before it could be sealed${marker(failure)}.` };
  if (failure.kind === 'invalid') return { kind: 'invalid', text: `Fix the checks first${marker(failure)}.${failure.message ? ` ${failure.message}` : ''}` };
  if (failure.status === 403) return { kind: 'forbidden', text: `This credential can’t seal versions${marker(failure)}. Nothing was sealed.` };
  if (failure.kind === 'not-found') return { kind: 'gone', text: `The draft or something it depends on can’t be read${marker(failure)}. Nothing was sealed.` };
  return { kind: 'other', text: generalFailure(failure, 'nothing was sealed') };
}

export type PublishKind = 'dependency' | 'engine' | 'evidence' | 'case' | 'withdrawn' | 'integrity' | 'forbidden' | 'gone' | 'other';

export interface PublishRefusal extends Refusal {
  kind: PublishKind;
  /** The gateway's own explanation, kept beside the check it belongs to. */
  detail?: string;
}

/** Publishing: each 422 names what is still private; a 409 is a withdrawn edition or content that no longer matches its seal. */
export function publishRefusal(caught: unknown): PublishRefusal {
  const failure = classifyAuthError(caught);
  const code = failure.code ?? '';
  const detail = failure.message;
  if (failure.status === 422 && code === 'private_dependency') {
    return { kind: 'dependency', detail, text: `Can’t publish yet${marker(failure)}: something it depends on isn’t published.` };
  }
  if (failure.status === 422 && code === 'private_engine_dependency') {
    return { kind: 'engine', detail, text: `Can’t publish yet${marker(failure)}: the exact engine contract it names isn’t published.` };
  }
  if (failure.status === 422 && code === 'private_evidence') {
    return { kind: 'evidence', detail, text: `Can’t publish yet${marker(failure)}: the evidence behind it isn’t public.` };
  }
  if (failure.status === 422 && code === 'private_case_dependency') {
    return { kind: 'case', detail, text: `Can’t publish yet${marker(failure)}: a case that uses it lives in a private project or uses unpublished versions.` };
  }
  if (failure.status === 409 && code === 'publication_withdrawn') {
    return { kind: 'withdrawn', detail, text: `This version was withdrawn${marker(failure)} and can’t be published again. Seal a new version to supersede it.` };
  }
  if (failure.status === 409) {
    return { kind: 'integrity', detail, text: `The stored content doesn’t match this version’s fingerprint${marker(failure)}, so it can’t be published until an administrator checks it.` };
  }
  if (failure.status === 403) return { kind: 'forbidden', text: `You need ADMIN in the owning organization to publish${marker(failure)}. Nothing was published.` };
  if (failure.kind === 'not-found') return { kind: 'gone', text: `The version no longer exists, or you can’t read it${marker(failure)}. Nothing was published.` };
  if (failure.kind === 'invalid') return { kind: 'other', detail, text: `The gateway refused to publish it${marker(failure)}.${detail ? ` ${detail}` : ''}` };
  return { kind: 'other', text: generalFailure(failure, 'nothing was published') };
}

export function withdrawRefusal(caught: unknown): Refusal {
  const failure = classifyAuthError(caught);
  if (failure.status === 409) return { kind: 'withdrawn', text: `It was already withdrawn by someone else${marker(failure)}.` };
  if (failure.status === 403) return { kind: 'forbidden', text: `You need ADMIN in the owning organization to withdraw it${marker(failure)}. Nothing changed.` };
  if (failure.kind === 'not-found') return { kind: 'gone', text: `This version isn’t published, or no longer exists${marker(failure)}. Nothing changed.` };
  return { kind: 'other', text: generalFailure(failure, 'nothing changed') };
}

/** Adding an item to a project. */
export function associateRefusal(caught: unknown, name: string): Refusal {
  const failure = classifyAuthError(caught);
  if (failure.status === 422) {
    return {
      kind: 'private',
      text: `“${name}” belongs to another organization and isn’t published${marker(failure)}. Ask its owners to publish a version first.`,
    };
  }
  if (failure.status === 403) return { kind: 'forbidden', text: `You need MEMBER in the organization to change a project’s library${marker(failure)}. Nothing changed.` };
  if (failure.kind === 'not-found') return { kind: 'gone', text: `The project or the item can’t be found any more${marker(failure)}. Nothing changed.` };
  return { kind: 'other', text: generalFailure(failure, 'nothing changed') };
}

export function dissociateRefusal(caught: unknown): Refusal {
  const failure = classifyAuthError(caught);
  if (failure.status === 403) return { kind: 'forbidden', text: `You need MEMBER in the organization to change a project’s library${marker(failure)}. Nothing changed.` };
  if (failure.kind === 'not-found') return { kind: 'gone', text: `The project can’t be found any more${marker(failure)}. Nothing changed.` };
  return { kind: 'other', text: generalFailure(failure, 'nothing changed') };
}

/** The content of a version can't be read: a 409 means the stored bytes no longer match the seal. */
export function contentFailure(failure: AuthFailure): 'integrity' | 'missing' | 'other' {
  if (failure.status === 409) return 'integrity';
  if (failure.kind === 'not-found') return 'missing';
  return 'other';
}

export function isMissing(failure: AuthFailure | null): boolean {
  return failure?.status === 404 || failure?.kind === 'not-found';
}
