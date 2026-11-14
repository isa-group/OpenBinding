import { platformApi } from '../../api/platform';
import { loadCases } from '../Project/projectData';
import type { Origin } from './JobResult';

export interface ProjectRef {
  org: string;
  orgName: string;
  slug: string;
  name: string;
}

/** Every project the account can see, by id: the history of runs lives across projects and names them. A failure leaves the index empty. */
export async function loadProjectIndex(): Promise<Map<string, ProjectRef>> {
  const index = new Map<string, ProjectRef>();
  try {
    const organizations = await platformApi.organizations();
    const lists = await Promise.all(organizations.map((organization) => platformApi.projects(organization.slug).catch(() => [])));
    organizations.forEach((organization, position) => {
      for (const project of lists[position]) {
        index.set(project.id, { org: organization.slug, orgName: organization.name, slug: project.slug, name: project.name });
      }
    });
  } catch {
    /* names are a convenience: the history still lists every run */
  }
  return index;
}

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
