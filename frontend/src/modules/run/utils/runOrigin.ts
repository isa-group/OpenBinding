import type { JobDetail } from '../api/runsApi';

/** What a run is of: the organization and problem it names, the version and the compilation it ran. */
export interface Origin {
  org: string;
  caseSlug: string;
  caseName: string;
  revision: number;
  compilationId: string | null;
}

/** What a run is of, from the references it names: its organization, problem, version and compilation. `null` when it names none. */
export function originOf(
  detail: Pick<JobDetail, 'organization' | 'problem' | 'revision' | 'compilation'> | undefined
): Origin | null {
  if (!detail?.organization || !detail.problem || !detail.revision) return null;
  return {
    org: detail.organization.slug,
    caseSlug: detail.problem.slug,
    caseName: detail.problem.name,
    revision: detail.revision.revision,
    compilationId: detail.compilation?.id ?? null,
  };
}
