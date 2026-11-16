import { problemsApi } from '../../api/problems';
import type { CaseContent } from '../../features/workspace/model';
import type { ProblemsFilter } from '../../routes/paths/problems';

/** How many problems one listing reads; the gateway's ceiling. */
const PAGE = 200;

/**
 * The problems of an organization with their sealed revisions, narrowed by the gateway to an origin or a linking composition when
 * the filter names one. A problem whose revisions can't be read still shows, with none.
 */
export async function loadProblems(
  org: string,
  filter: ProblemsFilter = {}
): Promise<CaseContent[]> {
  const listed = await problemsApi.list(org, {
    limit: PAGE,
    origin: filter.origin,
    composition: filter.composition,
  });
  return Promise.all(
    listed.problems.map(async item => ({
      item,
      revisions: await problemsApi.revisions(org, item.slug).catch(() => []),
    }))
  );
}
