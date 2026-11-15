import { loadCases } from '../Project/projectData';
import type { Origin } from './JobResult';

/** The case revision of the project that was sealed from this snapshot, if there is one: what a run "used" from the project's side. */
export async function findOrigin(org: string, project: string, snapshotId: string): Promise<Origin | null> {
  try {
    for (const entry of await loadCases(org, project)) {
      const revision = entry.revisions.find((candidate) => candidate.source_snapshot_id === snapshotId);
      if (revision) return { caseSlug: entry.item.slug, caseName: entry.item.name, revision: revision.revision };
    }
  } catch {
    /* the case list is a convenience here, never a reason to hide the run */
  }
  return null;
}
