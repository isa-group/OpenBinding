import { HttpError } from '../../api/client';
import { libraryItemsApi, type LibraryItem, type LibraryVersion } from '../../api/libraryItems';
import type { Project } from '../../api/platform';
import { useResource } from '../../utils/useResource';
import { classifyAuthError, type AuthFailure } from './libraryErrors';
import { UUID_PATTERN } from './libraryModel';

/**
 * The item an address names. An id always works; a fixed name works only inside an organization the account is in, because the
 * library of any other organization can't be listed (and a name means nothing outside its owner).
 */
export async function resolveItem(orgSlug: string, param: string, member: boolean): Promise<LibraryItem> {
  if (UUID_PATTERN.test(param)) return libraryItemsApi.item(param);
  if (!member) throw new HttpError(404, 'Library item not found.');
  const found = (await libraryItemsApi.list(orgSlug, false)).find((item) => item.name === param);
  if (!found) throw new HttpError(404, 'Library item not found.');
  return found;
}

export interface LoadedItem {
  waiting: boolean;
  item?: LibraryItem;
  failure: AuthFailure | null;
  reload: () => void;
}

export function useLibraryItem(orgSlug: string, param: string, member: boolean, enabled = true): LoadedItem {
  const resource = useResource<LibraryItem | null>(
    `library-item:${orgSlug}/${param}:${member ? 'member' : 'outside'}`,
    () => (enabled ? resolveItem(orgSlug, param, member) : Promise.resolve(null)),
  );
  const item = resource.data ?? (resource.status === 'error' ? undefined : resource.stale ?? undefined);
  return {
    waiting: enabled && resource.status === 'loading' && !item,
    item,
    failure: resource.status === 'error' ? classifyAuthError(resource.error) : null,
    reload: resource.reload,
  };
}

/** The versions of an item the account may read, newest first. */
export function useVersions(itemId: string | undefined) {
  return useResource<LibraryVersion[]>(`library-versions:${itemId ?? ''}`, () => (itemId ? libraryItemsApi.versions(itemId) : Promise.resolve([])));
}

/** How many projects are read to find where an item is used: one call each, so a very large organization is read in part. */
export const USAGE_PROJECT_LIMIT = 25;

export interface Usage {
  /** Item id to the projects that have it associated. */
  byItem: Map<string, Project[]>;
  /** Projects that couldn't be read, or weren't because of the limit. */
  unread: number;
}

/** Where the items of an organization are used: the projects that have each one associated. */
export function useUsage(orgSlug: string, projects: Project[], enabled: boolean) {
  const key = projects.map((project) => project.slug).join(',');
  return useResource<Usage>(`library-usage:${orgSlug}:${enabled}:${key}`, async () => {
    const byItem = new Map<string, Project[]>();
    if (!enabled) return { byItem, unread: 0 };
    const read = projects.slice(0, USAGE_PROJECT_LIMIT);
    const results = await Promise.allSettled(read.map((project) => libraryItemsApi.projectItems(orgSlug, project.slug)));
    let unread = projects.length - read.length;
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        unread += 1;
        return;
      }
      for (const item of result.value) byItem.set(item.id, [...(byItem.get(item.id) ?? []), read[index]]);
    });
    return { byItem, unread };
  });
}
