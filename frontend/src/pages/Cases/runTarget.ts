import type { PlatformOutletContext } from '../../components/PlatformShell/PlatformShell';
import { launchPath } from '../../routes/paths/runs';

/**
 * Where studies of the organization's problems are built: a project of the organization (the one the workspace has open, else its
 * first). Studies still live under a project's address; `null` when the organization has none.
 */
export function projectRootOf(context: Pick<PlatformOutletContext, 'projects' | 'project'>, org: string): string | null {
  const project = context.project && context.projects.some((item) => item.id === context.project?.id) ? context.project : context.projects[0];
  return project ? `/app/${encodeURIComponent(org)}/${encodeURIComponent(project.slug)}` : null;
}

/** The launcher of a run of a problem version: runs belong to the organization (`/app/<org>/runs/new?problem=&revision=`). */
export function runLaunchOf(org: string, problem: string, revision?: number | string): string {
  return launchPath(org, { problem, revision });
}
