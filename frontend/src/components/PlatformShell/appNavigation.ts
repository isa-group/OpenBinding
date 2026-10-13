import type { Organization, Project } from '../../api/platform';

export interface NavLinkItem {
  to: string;
  label: string;
}

const under = (pathname: string, root: string) => pathname === root || pathname.startsWith(`${root}/`);
const isProjectJobs = (pathname: string) => /^\/app\/[^/]+\/[^/]+\/jobs(\/|$)/.test(pathname);

export type MainSection = 'home' | 'jobs' | 'analysis' | 'explore' | 'tools' | 'admin' | null;

export const mainLinks = {
  home: { to: '/app', label: 'Home' },
  jobs: { to: '/app/jobs', label: 'Jobs' },
  analysis: { to: '/app/analysis', label: 'Analysis' },
  explore: { to: '/explore', label: 'Explore' },
  admin: { to: '/app/admin', label: 'Admin' },
} as const satisfies Record<string, NavLinkItem>;

export const toolLinks: readonly NavLinkItem[] = [
  { to: '/app/verifier', label: 'Verifier' },
  { to: '/engines', label: 'Engine catalog' },
  { to: '/app/engines/registrations', label: 'My engines' },
  { to: '/app/language/extensions', label: 'Language extensions' },
  { to: '/app/generator', label: 'Generator lab' },
  { to: '/language', label: 'Language docs' },
];

export const accountLinks: readonly NavLinkItem[] = [
  { to: '/app/account', label: 'Account' },
  { to: '/app/account/usage', label: 'Plan & permissions' },
  { to: '/app/account/keys', label: 'API keys' },
  { to: '/app/account/notifications', label: 'Notifications' },
];

const isToolPath = (pathname: string) =>
  under(pathname, '/app/verifier') || under(pathname, '/app/engines') || under(pathname, '/app/language')
  || under(pathname, '/app/generator') || under(pathname, '/engines') || under(pathname, '/language');

/** `/app/:org/…` screens that belong to the organization, not to one of its projects. */
const ORGANIZATION_SCREENS = new Set(['settings', 'library', 'new-project']);

/**
 * The workspace home is where organizations and projects are browsed: `/app`, an organization with its own screens, a project's overview.
 * The sections inside a project (cases, studies, reports, files, …) mark themselves in the project tabs, so the header leaves Home alone there.
 */
function isWorkspaceHome(pathname: string): boolean {
  const parts = pathname.split('/').filter(Boolean);
  if (parts[0] !== 'app') return false;
  return parts.length <= 3 || ORGANIZATION_SCREENS.has(parts[2]);
}

/** Which entry of the main navigation the current address belongs to. */
export function currentSection(pathname: string): MainSection {
  if (under(pathname, '/app/admin')) return 'admin';
  if (under(pathname, '/app/jobs') || isProjectJobs(pathname)) return 'jobs';
  if (under(pathname, '/app/analysis')) return 'analysis';
  if (isToolPath(pathname)) return 'tools';
  if (under(pathname, '/explore')) return 'explore';
  if (under(pathname, '/app/account') || under(pathname, '/app/system')) return null;
  return isWorkspaceHome(pathname) ? 'home' : null;
}

export function isToolActive(pathname: string, link: NavLinkItem): boolean {
  return link.to === '/app/engines/registrations' ? under(pathname, '/app/engines') : under(pathname, link.to);
}

export interface CreateItem {
  label: string;
  /** Where the item leads; absent when the context it needs (a project, an organization) is missing. */
  to?: string;
  hint: string;
}

export function projectRoot(organization?: Organization, project?: Project): string | undefined {
  return organization && project ? `/app/${organization.slug}/${project.slug}` : undefined;
}

/** Entries of the "New" menu. Items that belong to the current project or organization say which one. */
export function createItems(organization?: Organization, project?: Project): CreateItem[] {
  const root = projectRoot(organization, project);
  return [
    { label: 'Organization', to: '/app/organizations/new', hint: '' },
    organization
      ? { label: 'Project', to: `/app/${organization.slug}/new-project`, hint: `in ${organization.name}` }
      : { label: 'Project', hint: 'Needs an organization' },
    root
      ? { label: 'Case', to: `${root}/cases`, hint: `in ${project?.name}` }
      : { label: 'Case', hint: 'Needs a project' },
    root
      ? { label: 'Job', to: `${root}/jobs/new`, hint: `in ${project?.name}` }
      : { label: 'Job', hint: 'Needs a project' },
    root
      ? { label: 'Study', to: `${root}/studies/new`, hint: `in ${project?.name}` }
      : { label: 'Study', hint: 'Needs a project' },
    { label: 'API key', to: '/app/account/keys/new', hint: '' },
    { label: 'Engine', to: '/app/engines/new', hint: '' },
  ];
}
