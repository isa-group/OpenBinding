import type { Organization } from '../../api/platform';
import { COMPOSITIONS_SEGMENT } from '../../routes/paths/compositions';
import { organizationPath, PROBLEMS_SEGMENT } from '../../routes/paths/problems';
import { RUNS_SEGMENT } from '../../routes/paths/runs';
import { STUDIES_SEGMENT } from '../../routes/paths/studies';

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

const under = (pathname: string, root: string) =>
  pathname === root || pathname.startsWith(`${root}/`);

export type MainSection = 'home' | OrganizationSectionId | 'engines' | 'admin' | null;
/** The sections of the organization that have an entry of their own in the header. */
export type OrganizationSectionId = 'compositions' | 'problems' | 'runs' | 'studies';

/** The entries of the header that do not depend on the organization. */
export const mainLinks = {
  home: { to: '/', label: 'Home' },
  engines: { to: '/engines', label: 'Engines' },
  admin: { to: '/app/admin', label: 'Admin' },
} as const satisfies Record<string, NavLinkItem>;

export const accountLinks: readonly NavLinkItem[] = [
  { to: '/app/account', label: 'Profile' },
  { to: '/app/account/usage', label: 'Plan' },
  { to: '/app/account/keys', label: 'API keys' },
  { to: '/app/account/identities', label: 'Identities' },
  { to: '/app/account/notifications', label: 'Notifications' },
];

/** An entry of the organization (the one the address names, else the first), disabled with `Needs an organization` when there is none. */
function inOrganization(
  label: string,
  organization: Organization | undefined,
  suffix: string
): MenuEntry {
  return organization
    ? { label, to: `${organizationPath(organization.slug)}${suffix}` }
    : { label, hint: NEEDS_ORGANIZATION };
}

/** The entries of the header that lead into the organization, in order: its compositions, problems, runs and studies. */
export function organizationEntries(
  organization?: Organization
): Array<MenuEntry & { id: OrganizationSectionId }> {
  return [
    {
      id: 'compositions',
      ...inOrganization('Compositions', organization, `/${COMPOSITIONS_SEGMENT}`),
    },
    { id: 'problems', ...inOrganization('Problems', organization, `/${PROBLEMS_SEGMENT}`) },
    { id: 'runs', ...inOrganization('Runs', organization, `/${RUNS_SEGMENT}`) },
    { id: 'studies', ...inOrganization('Studies', organization, `/${STUDIES_SEGMENT}`) },
  ];
}

/** Entries of the "New" menu: always these four, each in the organization. */
export function createItems(organization?: Organization): MenuEntry[] {
  return [
    inOrganization('Composition', organization, `/${COMPOSITIONS_SEGMENT}?create=composition`),
    inOrganization('Problem', organization, `/${PROBLEMS_SEGMENT}?create=problem`),
    inOrganization('Study', organization, `/${STUDIES_SEGMENT}/new`),
    inOrganization('Run', organization, `/${RUNS_SEGMENT}/new`),
  ];
}

/** The first segments under `/app` that name a place of their own, not an organization. */
const APP_PLACES = new Set(['admin', 'engines', 'account']);
/** Of those, the places that belong to no entry of the header. */
const UNMARKED_PLACES = new Set(['account']);
/** `/app/:org/…` screens of the organization itself, which Home marks. */
const ORGANIZATION_SCREENS = new Set(['settings']);
/** The second segment of each organization section, and the entry it belongs to (the problem editor edits problems). */
const SECTION_OF: Record<string, OrganizationSectionId> = {
  [COMPOSITIONS_SEGMENT]: 'compositions',
  [PROBLEMS_SEGMENT]: 'problems',
  'problem-editor': 'problems',
  [RUNS_SEGMENT]: 'runs',
  [STUDIES_SEGMENT]: 'studies',
};

/** The section of the organization the address is in (`/app/:org/compositions/…`, `/app/:org/problems/…`, `/app/:org/problem-editor`, `/app/:org/runs/…`, `/app/:org/studies/…`). */
export function organizationSectionOf(pathname: string): OrganizationSectionId | null {
  const parts = pathname.split('/').filter(Boolean);
  if (parts[0] !== 'app' || APP_PLACES.has(parts[1])) return null;
  return SECTION_OF[parts[2]] ?? null;
}

/** The workspace home is where organizations are browsed: `/app`, an organization's overview and its settings. */
function isWorkspaceHome(pathname: string): boolean {
  const parts = pathname.split('/').filter(Boolean);
  if (parts[0] !== 'app') return false;
  return parts.length <= 2 || ORGANIZATION_SCREENS.has(parts[2]);
}

/** Which entry of the header the current address belongs to. */
export function currentSection(pathname: string): MainSection {
  if (pathname === mainLinks.home.to) return 'home';
  if (under(pathname, mainLinks.admin.to)) return 'admin';
  if (under(pathname, '/app/engines') || under(pathname, mainLinks.engines.to)) return 'engines';
  const [root, place] = pathname.split('/').filter(Boolean);
  if (root !== 'app' || UNMARKED_PLACES.has(place)) return null;
  return organizationSectionOf(pathname) ?? (isWorkspaceHome(pathname) ? 'home' : null);
}
