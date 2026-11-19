// What the Operation tab says about environments, shared by its cards, its detail and the adopt dialog.

import { formatDistanceToNow, parseISO } from 'date-fns';
import type { ApiError } from '../../core/api/errors';
import type { CompositionEnvironmentView } from '../../core/api/types';
import type { OrgRole } from '../../organization/api/organizationsApi';
import { compositionPath } from '../../../routes/paths/compositions';
import { roleAtLeast } from '../hooks/useCompositionRole';

/** Whether a role may adopt in an environment: its adoption role or above. */
export const mayAdopt = (role: OrgRole | null, environment: CompositionEnvironmentView) =>
  roleAtLeast(role, environment.adoptRole);

/** "adopted 3 days ago by Lab Owner". */
export function adoptedText(inEffect: NonNullable<CompositionEnvironmentView['inEffect']>): string {
  const when = `adopted ${formatDistanceToNow(parseISO(inEffect.adoptedAt))} ago`;
  return inEffect.adoptedBy ? `${when} by ${inEffect.adoptedBy.displayName}` : when;
}

export interface AdoptionRefusal {
  text: string;
  /** A way out the refusal offers. */
  link?: { label: string; to: string };
  /** The environment changed: read it again. */
  reload?: boolean;
}

const codeOf = (refusal: ApiError) => (refusal.code ? ` (${refusal.code})` : '');

/** The sentence and the way out of a refused adoption. */
export function adoptionRefusal(
  refusal: ApiError,
  context: { org: string; composition: string; label: string; environment: string }
): AdoptionRefusal {
  const versionsTab = compositionPath(context.org, context.composition, 'versions', {
    version: context.label,
  });
  switch (refusal.code) {
    case 'precondition_failed':
      return {
        text: `Someone adopted in ${context.environment} or changed it since you opened it. Read it again to see what is in effect now, then adopt.`,
        reload: true,
      };
    case 'already_in_effect':
      return { text: `Version ${context.label} is already in effect in ${context.environment}.` };
    case 'evaluation_stale':
      return {
        text: `Version ${context.label} was evaluated with another toolchain. Re-evaluate it with the installed one first.`,
        link: { label: 'Re-evaluate', to: versionsTab },
      };
    case 'binding_invalid':
      return {
        text: `The binding of version ${context.label} is not valid for its problem, so it can’t be adopted.`,
        link: { label: 'Open the version', to: versionsTab },
      };
    case 'evaluation_semantics_changed':
      return {
        text: `The installed toolchain reads the problem of version ${context.label} differently: derive it again and adopt the new version.`,
        link: {
          label: 'Derive again',
          to: compositionPath(context.org, context.composition, 'configuration', {
            version: context.label,
          }),
        },
      };
    case 'composition_archived':
      return { text: 'This composition is archived: restore it before adopting a version.' };
    case 'version_not_found':
      return { text: `Version ${context.label} is not a version of this composition any more.` };
    default:
      if (refusal.status === 403)
        return {
          text: `Your role may not adopt in ${context.environment}${codeOf(refusal)}. Nothing changed.`,
        };
      return {
        text: `The version couldn’t be adopted${codeOf(refusal)}${refusal.message ? `: ${refusal.message}` : '.'} Nothing changed.`,
      };
  }
}
