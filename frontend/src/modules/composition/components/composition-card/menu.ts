// The kebab of a composition card the account may change: Archive, or Restore an archived one (MEMBER and above).

import type { MenuItem } from '.';
import type { CompositionView } from '../../api/compositionsApi';

export function archiveMenu(
  composition: Pick<CompositionView, 'organization' | 'slug' | 'name' | 'archived'>,
  canWrite: boolean,
  archive: (org: string, slug: string, name: string, archived: boolean) => void
): MenuItem[] {
  if (!canWrite) return [];
  const { organization, slug, name, archived } = composition;
  return [
    archived
      ? {
          label: 'Restore',
          icon: 'restore',
          onClick: () => archive(organization.slug, slug, name, false),
        }
      : {
          label: 'Archive',
          icon: 'archive',
          onClick: () => archive(organization.slug, slug, name, true),
        },
  ];
}
