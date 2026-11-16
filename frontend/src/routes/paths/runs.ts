// Address builders of the runs area (M2.6; organization-level since F0b B6). Code that links to the run list, the run launcher or a run
// builds the address here, so the segment is named once.

/** The segment of the run list, the run launcher and the run page. */
export const RUNS_SEGMENT = 'runs';

/** The run list of an organization: `/app/<org>/runs`. */
export const runsPath = (org: string): string => `/app/${encodeURIComponent(org)}/${RUNS_SEGMENT}`;

/** One run of an organization: `/app/<org>/runs/<run>`. */
export const runPath = (org: string, run: string): string =>
  `${runsPath(org)}/${encodeURIComponent(run)}`;

/** What the launcher starts from: a problem revision, an engine (`namespace/name`), a run preset of the organization (its slug), or several. */
export interface LaunchTarget {
  problem?: string;
  revision?: number | string;
  engine?: string;
  preset?: string;
}

/** The launcher of a run of an organization (`run-launch`): `/app/<org>/runs/new`, with `?problem=&revision=`, `?engine=` and `?preset=`. */
export function launchPath(org: string, target: LaunchTarget = {}): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(target)) {
    if (value !== undefined && value !== '') query.set(key, String(value));
  }
  const search = query.toString();
  return `${runsPath(org)}/new${search ? `?${search}` : ''}`;
}
