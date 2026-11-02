import type { Organization, Project } from '../../api/platform';

export interface NavLinkItem {
  to: string;
  label: string;
}

/** An entry of a menu or of the header: a link, or a disabled entry (no `to`) that says what it needs. */
export interface MenuEntry {
  label: string;
  /** Where the entry leads; absent when the context it needs (a project) is missing. */
  to?: string;
  hint?: string;
}

// Until the slices that rename the problem and run screens land, their addresses keep the interim segments; those slices
// switch these two constants to `problems` and `runs`.
const PROBLEMS_SEGMENT = 'cases';
const RUNS_SEGMENT = 'jobs';
const COLLECTIONS_SEGMENT = 'collections';
const STUDIES_SEGMENT = 'studies';

export const NEEDS_PROJECT = 'Needs a project';

const under = (pathname: string, root: string) => pathname === root || pathname.startsWith(`${root}/`);
const sameSegment = (segment: string | undefined, ...names: string[]) => segment !== undefined && names.includes(segment);

// [impl->req~frontend-nav-signed-in-navigation~1]
export type MainSection = 'home' | 'problems' | 'lab' | 'engines' | 'language' | 'admin' | null;
export type LabEntryId = 'runs' | 'studies' | 'generator';

/** The entries of the header that do not depend on the current project. */
export const mainLinks = {
  home: { to: '/app', label: 'Home' },
  engines: { to: '/engines', label: 'Engines' },
  language: { to: '/language', label: 'Language' },
  admin: { to: '/app/admin', label: 'Admin' },
} as const satisfies Record<string, NavLinkItem>;

export const labLinks = {
  runs: { to: `/app/${RUNS_SEGMENT}`, label: 'Runs' },
  generator: { to: '/app/generator', label: 'Generator' },
} as const satisfies Record<string, NavLinkItem>;

// [impl->req~frontend-nav-account-menu~1]
export const accountLinks: readonly NavLinkItem[] = [
  { to: '/app/account', label: 'Profile' },
  { to: '/app/account/usage', label: 'Plan' },
  { to: '/app/account/keys', label: 'API keys' },
  { to: '/app/account/identities', label: 'Identities' },
  { to: '/app/account/notifications', label: 'Notifications' },
];

export function projectRoot(organization?: Organization, project?: Project): string | undefined {
  return organization && project ? `/app/${organization.slug}/${project.slug}` : undefined;
}

/** An entry inside the current project, disabled with the hint `Needs a project` when there is none. */
function inProject(label: string, root: string | undefined, suffix: string): MenuEntry {
  return root ? { label, to: `${root}${suffix}` } : { label, hint: NEEDS_PROJECT };
}

// [impl->req~frontend-nav-signed-in-navigation~1]
export function problemsEntry(organization?: Organization, project?: Project): MenuEntry {
  return inProject('Problems', projectRoot(organization, project), `/${PROBLEMS_SEGMENT}`);
}

/** The entries of the Lab menu, in order. */
// [impl->req~frontend-nav-signed-in-navigation~1]
export function labEntries(organization?: Organization, project?: Project): Array<MenuEntry & { id: LabEntryId }> {
  return [
    { id: 'runs', label: labLinks.runs.label, to: labLinks.runs.to },
    { id: 'studies', ...inProject('Studies', projectRoot(organization, project), `/${STUDIES_SEGMENT}`) },
    { id: 'generator', label: labLinks.generator.label, to: labLinks.generator.to },
  ];
}

/** Entries of the "New" menu: always these four, in the current project. */
// [impl->req~frontend-nav-new-menu~1]
export function createItems(organization?: Organization, project?: Project): MenuEntry[] {
  const root = projectRoot(organization, project);
  return [
    inProject('Problem', root, `/${PROBLEMS_SEGMENT}?create=problem`),
    inProject('Collection', root, `/${COLLECTIONS_SEGMENT}?create=collection`),
    inProject('Study', root, `/${STUDIES_SEGMENT}/new`),
    inProject('Run', root, `/${RUNS_SEGMENT}/new`),
  ];
}

/** The first segments under `/app` that name a place of their own, not an organization. */
const APP_PLACES = new Set(['admin', 'jobs', 'generator', 'engines', 'language', 'account', 'system', 'verifier', 'analysis', 'organizations']);
/** Of those, the places that belong to no entry of the header. */
const UNMARKED_PLACES = new Set(['account', 'system', 'verifier', 'analysis']);
/** `/app/:org/…` screens that belong to the organization, not to one of its projects. */
const ORGANIZATION_SCREENS = new Set(['settings', 'new-project']);

/** The segment below a project (`/app/:org/:project/<segment>`), when the address is inside one. */
function projectSegment(pathname: string): string | undefined {
  const parts = pathname.split('/').filter(Boolean);
  return parts[0] === 'app' && !APP_PLACES.has(parts[1]) ? parts[3] : undefined;
}

/** Which entry of the Lab menu the address belongs to. */
export function labEntryOf(pathname: string): LabEntryId | null {
  if (under(pathname, labLinks.generator.to)) return 'generator';
  if (under(pathname, labLinks.runs.to) || sameSegment(projectSegment(pathname), RUNS_SEGMENT, 'runs')) return 'runs';
  if (sameSegment(projectSegment(pathname), STUDIES_SEGMENT)) return 'studies';
  return null;
}

/**
 * The workspace home is where organizations and projects are browsed: `/app`, an organization with its own screens, a project's overview.
 * The sections inside a project mark themselves in the project tabs, so the header leaves Home alone there.
 */
function isWorkspaceHome(pathname: string): boolean {
  const parts = pathname.split('/').filter(Boolean);
  if (parts[0] !== 'app') return false;
  return parts.length <= 3 || ORGANIZATION_SCREENS.has(parts[2]);
}

/** Which entry of the header the current address belongs to. */
// [impl->req~frontend-nav-signed-in-navigation~1]
export function currentSection(pathname: string): MainSection {
  if (under(pathname, mainLinks.admin.to)) return 'admin';
  if (labEntryOf(pathname)) return 'lab';
  if (under(pathname, '/app/engines') || under(pathname, mainLinks.engines.to)) return 'engines';
  if (under(pathname, '/app/language') || under(pathname, mainLinks.language.to)) return 'language';
  const [root, place] = pathname.split('/').filter(Boolean);
  if (root !== 'app' || UNMARKED_PLACES.has(place)) return null;
  if (sameSegment(projectSegment(pathname), PROBLEMS_SEGMENT, 'problems')) return 'problems';
  return isWorkspaceHome(pathname) ? 'home' : null;
}
