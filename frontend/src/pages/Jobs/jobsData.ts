import type { JobDetail } from '../../api/jobs';
import type { Origin } from './JobResult';

/** What a run is of, from the references it names: its organization, problem, version and compilation. `null` when it names none. */
export function originOf(detail: Pick<JobDetail, 'organization' | 'problem' | 'revision' | 'compilation'> | undefined): Origin | null {
  if (!detail?.organization || !detail.problem || !detail.revision) return null;
  return {
    org: detail.organization.slug,
    caseSlug: detail.problem.slug,
    caseName: detail.problem.name,
    revision: detail.revision.revision,
    compilationId: detail.compilation?.id ?? null,
  };
}
