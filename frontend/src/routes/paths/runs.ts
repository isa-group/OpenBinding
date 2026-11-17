// Address builders of the runs area. Code that links to an organization's runs, the run launcher or a run builds the
// address here, so the segments are named once. The runs of an organization are a tab of its page (`/orgs/<org>/runs`); a run
// has its own card page (`/runs/<org>/<run>`) and the launcher is a form that names its organization (`/runs/new?org=`).

import { orgPath } from '../../modules/organization/types/paths';

/** The segment of the runs tab, the run launcher and the run page. */
export const RUNS_SEGMENT = 'runs';

/** The runs of an organization, its Runs tab: `/orgs/<org>/runs`. */
export const runsPath = (org: string): string => orgPath(org, RUNS_SEGMENT);

/** One run of an organization (`run-detail`): `/runs/<org>/<run>`. */
export const runPath = (org: string, run: string): string =>
  `/${RUNS_SEGMENT}/${encodeURIComponent(org)}/${encodeURIComponent(run)}`;

/** What the launcher starts from: a problem revision, an engine (`namespace/name`), a run preset of the organization (its slug), or several. */
export interface LaunchTarget {
  problem?: string;
  revision?: number | string;
  engine?: string;
  preset?: string;
}

/**
 * The launcher of a run (`run-launch`): `/runs/new?org=<org>`, with `&problem=&revision=`, `&engine=` and `&preset=`. Without an
 * organization the form asks for one first.
 */
export function launchPath(org?: string | null, target: LaunchTarget = {}): string {
  const query = new URLSearchParams();
  if (org) query.set('org', org);
  for (const [key, value] of Object.entries(target)) {
    if (value !== undefined && value !== '') query.set(key, String(value));
  }
  const search = query.toString();
  return `/${RUNS_SEGMENT}/new${search ? `?${search}` : ''}`;
}
