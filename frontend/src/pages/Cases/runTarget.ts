import { launchPath } from '../../routes/paths/runs';

/** The launcher of a run of a problem version: runs belong to the organization (`/app/<org>/runs/new?problem=&revision=`). */
export function runLaunchOf(org: string, problem: string, revision?: number | string): string {
  return launchPath(org, { problem, revision });
}
