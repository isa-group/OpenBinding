import type { Organization } from '../../../organization/api/organizationClient';
import { compositionsPath, newCompositionPath } from '../../../../routes/paths/compositions';
import { problemEditorPath, problemsPath } from '../../../../routes/paths/problems';
import { launchPath, runsPath } from '../../../../routes/paths/runs';
import { newStudyPath, studiesPath } from '../../../../routes/paths/studies';

export interface NavLinkItem {
  to: string;
  label: string;
}

/** An entry of a menu or of the header: a link, or a disabled entry (no `to`) that says what it needs. */
export interface MenuEntry {
  label: string;
  /** Where the entry leads; absent when the context it needs (an organization) is missing. */
  to?: string;
  hint?: string;
}

export const NEEDS_ORGANIZATION = 'Needs an organization';

/** The sections of the organization that have an entry of their own in the header. */
export type OrganizationSectionId = 'compositions' | 'problems' | 'runs' | 'studies';

/** The entries of the header that do not depend on the organization. */
export const mainLinks = {
  home: { to: '/', label: 'Home' },
  engines: { to: '/engines', label: 'Engines' },
  admin: { to: '/admin', label: 'Admin' },
} as const satisfies Record<string, NavLinkItem>;

/** The person's own places: the settings page and its sections (`/me/settings?section=`), and the API keys. */
export const accountLinks: readonly NavLinkItem[] = [
  { to: '/me/settings', label: 'Settings' },
  { to: '/me/settings?section=plan', label: 'Plan' },
  { to: '/me/api-keys', label: 'API keys' },
  { to: '/me/settings?section=integrations', label: 'Sign-in & Security' },
  { to: '/me/settings?section=notifications', label: 'Notifications' },
  { to: '/me/settings?section=appearance', label: 'Appearance' },
];

/** The entries of the header that lead into the organization, in order: its compositions, problems, runs and studies. */
export function organizationEntries(
  organization?: Organization
): Array<MenuEntry & { id: OrganizationSectionId }> {
  return [
    {
      id: 'compositions',
      ...(organization
        ? { label: 'Compositions', to: compositionsPath(organization.slug) }
        : { label: 'Compositions', hint: NEEDS_ORGANIZATION }),
    },
    {
      id: 'problems',
      ...(organization
        ? { label: 'Problems', to: problemsPath(organization.slug) }
        : { label: 'Problems', hint: NEEDS_ORGANIZATION }),
    },
    {
      id: 'runs',
      ...(organization
        ? { label: 'Runs', to: runsPath(organization.slug) }
        : { label: 'Runs', hint: NEEDS_ORGANIZATION }),
    },
    {
      id: 'studies',
      ...(organization
        ? { label: 'Studies', to: studiesPath(organization.slug) }
        : { label: 'Studies', hint: NEEDS_ORGANIZATION }),
    },
  ];
}

/** Entries of the "New" menu: always these four, each in the organization. */
export function createItems(organization?: Organization): MenuEntry[] {
  return [
    organization
      ? { label: 'Composition', to: newCompositionPath(organization.slug) }
      : { label: 'Composition', hint: NEEDS_ORGANIZATION },
    organization
      ? { label: 'Problem', to: problemEditorPath(organization.slug) }
      : { label: 'Problem', hint: NEEDS_ORGANIZATION },
    organization
      ? { label: 'Study', to: newStudyPath(organization.slug) }
      : { label: 'Study', hint: NEEDS_ORGANIZATION },
    organization
      ? { label: 'Run', to: launchPath(organization.slug) }
      : { label: 'Run', hint: NEEDS_ORGANIZATION },
  ];
}
