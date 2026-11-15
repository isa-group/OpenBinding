import type { PlatformOutletContext } from '../../components/PlatformShell/PlatformShell';
import { launchPath } from '../../routes/paths/problems';

/**
 * Where runs of the organization's problems are launched and followed: a project of the organization (the one the workspace has open,
 * else its first). Runs still live under a project's address; `null` when the organization has none.
 */
export function runRootOf(context: Pick<PlatformOutletContext, 'projects' | 'project'>, org: string): string | null {
  const project = context.project && context.projects.some((item) => item.id === context.project?.id) ? context.project : context.projects[0];
  return project ? `/app/${encodeURIComponent(org)}/${encodeURIComponent(project.slug)}` : null;
}

/** The launcher of a run of a problem version, or `null` when the organization has no project to run in. */
export function runLaunchOf(context: Pick<PlatformOutletContext, 'projects' | 'project'>, org: string, problem: string, revision?: number | string): string | null {
  const root = runRootOf(context, org);
  return root ? launchPath(root, problem, revision) : null;
}
