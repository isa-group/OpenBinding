// What the Operation tab says about environments, shared by its cards, its detail and the adopt dialog.

import { formatDistanceToNow, parseISO } from 'date-fns';
import type { CompositionEnvironmentView } from '../../core/api/types';
import type { OrgRole } from '../../organization/api/organizationsApi';
import { roleAtLeast } from '../hooks/useCompositionRole';

/** Whether a role may adopt in an environment: its adoption role or above. */
export const mayAdopt = (role: OrgRole | null, environment: CompositionEnvironmentView) =>
  roleAtLeast(role, environment.adoptRole);

/** "adopted 3 days ago by Lab Owner". */
export function adoptedText(inEffect: NonNullable<CompositionEnvironmentView['inEffect']>): string {
  const when = `adopted ${formatDistanceToNow(parseISO(inEffect.adoptedAt))} ago`;
  return inEffect.adoptedBy ? `${when} by ${inEffect.adoptedBy.displayName}` : when;
}
