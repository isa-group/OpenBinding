import { classifyAuthError, generalFailure, marker } from '../../features/workspace/errors';

export type ProjectRefusalKind = 'slug' | 'forbidden' | 'gone' | 'invalid' | 'other';

export interface ProjectRefusal {
  kind: ProjectRefusalKind;
  text: string;
}

/** The words for each way the gateway can refuse a new project. */
export function createRefusal(caught: unknown, context: { organization: string }): ProjectRefusal {
  const failure = classifyAuthError(caught);
  if (failure.status === 409) {
    return { kind: 'slug', text: `That address is already used in ${context.organization}${marker(failure)}.` };
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
      text: `This project has sealed history (study runs or problem versions), so it can’t be deleted${marker(failure)}. Sealed history must stay reachable so people can still verify it.`,
    };
  }
  if (failure.status === 403) {
    return { kind: 'forbidden', text: `You need ADMIN in the organization to delete a project${marker(failure)}. Nothing was deleted.` };
  }
  if (failure.kind === 'not-found') {
    return { kind: 'gone', text: `The project no longer exists${marker(failure)}.` };
  }
  return { kind: 'other', text: generalFailure(failure, 'nothing was deleted') };
}
