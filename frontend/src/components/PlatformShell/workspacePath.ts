/**
 * First segment after /app that belongs to a fixed screen instead of an organization slug,
 * so `/app/:org` never claims `/app/verifier`, `/app/engines/new` and friends.
 */
export const RESERVED_SLUGS = new Set([
  // Fixed screens of the prototype
  'system', 'generator', 'language', 'organizations', 'invitations', 'jobs', 'analysis', 'verifier',
  'account', 'admin', 'engines', 'workbench',
  // Section names that earlier layouts and links used at this level
  'cases', 'resources', 'collections', 'studies', 'analytics', 'reports', 'artifacts', 'settings',
  'snapshots', 'library', 'files', 'package', 'publications',
]);

/** Second segment of an organization screen that is not a project (`/app/:org/settings`, `/app/:org/new-project`). */
const ORGANIZATION_SECTIONS = new Set(['settings', 'new-project']);

export interface WorkspaceSlugs {
  org?: string;
  project?: string;
}

/** Organization and project slugs named by the URL, when it names any. */
export function workspaceSlugs(pathname: string): WorkspaceSlugs {
  const [root, org, project] = pathname.split('/').filter(Boolean);
  if (root !== 'app' || !org || RESERVED_SLUGS.has(org)) return {};
  return { org, project: project && !ORGANIZATION_SECTIONS.has(project) ? project : undefined };
}
