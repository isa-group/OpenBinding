import { problemsApi } from '../../../api/problems';
import type { CaseContent } from '../../../features/workspace/model';

/** How many problems the launcher reads; the gateway's ceiling. */
const PAGE = 200;

/**
 * The problems of an organization with their sealed revisions, the versions a run can start from. A problem whose revisions
 * can't be read still shows, with none.
 */
export async function loadProblemVersions(org: string): Promise<CaseContent[]> {
  const listed = await problemsApi.list(org, { limit: PAGE });
  return Promise.all(
    listed.problems.map(async item => ({
      item,
      revisions: await problemsApi.revisions(org, item.slug).catch(() => []),
    }))
  );
}
