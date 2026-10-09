import { platformApi } from '../../api/platform';
import { loadCases } from '../Project/projectData';
import { buildPins, type CollectionContent, type Pin, type ResourceContent } from './collectionModel';

/** The resources of a project with their revisions. A resource whose revisions can’t be read still shows, marked as not known. */
export async function loadResources(org: string, project: string): Promise<ResourceContent[]> {
  const resources = await platformApi.resources(org, project);
  return Promise.all(resources.map(async (resource) => {
    try {
      return { resource, revisions: await platformApi.resourceRevisions(org, project, resource.slug), known: true };
    } catch {
      return { resource, revisions: [], known: false };
    }
  }));
}

/** The collections of a project with their revisions. A collection whose revisions can’t be read still shows, marked as not known. */
export async function loadCollections(org: string, project: string): Promise<Array<CollectionContent & { known: boolean }>> {
  const collections = await platformApi.collections(org, project);
  return Promise.all(collections.map(async (collection) => {
    try {
      return { collection, revisions: await platformApi.collectionRevisions(org, project, collection.slug), known: true };
    } catch {
      return { collection, revisions: [], known: false };
    }
  }));
}

/** Everything a collection can point at: the project’s case revisions and resource revisions. */
export async function loadPins(org: string, project: string, root: string): Promise<Pin[]> {
  const [cases, resources] = await Promise.allSettled([loadCases(org, project), loadResources(org, project)]);
  // Either half may be out of reach (a key that can read one and not the other); only losing both is a failure.
  if (cases.status === 'rejected' && resources.status === 'rejected') throw cases.reason;
  return buildPins(cases.status === 'fulfilled' ? cases.value : [], resources.status === 'fulfilled' ? resources.value : [], root);
}
