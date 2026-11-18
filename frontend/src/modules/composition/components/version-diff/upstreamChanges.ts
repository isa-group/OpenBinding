import type { UpstreamEntry } from '../../../core/api/types';
import type { RendererUpstream } from '../../../core/utils/composition/upstream';

/** A task whose binding entry pins another upstream version or plan of one provider in the later version. */
export interface UpstreamChange {
  task: string;
  before: UpstreamEntry;
  after: UpstreamEntry;
}

export const field = (entry: UpstreamEntry, name: string): string =>
  typeof entry.from?.[name] === 'string' ? (entry.from[name] as string) : '';
export const addOnsOf = (entry: UpstreamEntry): string[] =>
  Array.isArray(entry.from?.addons) ? (entry.from.addons as string[]) : [];

/** The entries whose `from` pins another version or plan of the same provider (same pricing family or `owner/name`). */
export function upstreamChanges(
  before: RendererUpstream,
  after: RendererUpstream
): UpstreamChange[] {
  const changes: UpstreamChange[] = [];
  for (const entry of after.view.entries) {
    const old = before.view.entries.find(candidate => candidate.task === entry.task);
    if (!old?.from || !entry.from) continue;
    const sameProvider =
      (old.snapshot?.pricingId && old.snapshot.pricingId === entry.snapshot?.pricingId) ||
      field(old, 'sphere') === field(entry, 'sphere');
    const moved =
      field(old, 'version') !== field(entry, 'version') ||
      field(old, 'plan') !== field(entry, 'plan') ||
      addOnsOf(old).join(',') !== addOnsOf(entry).join(',');
    if (sameProvider && moved) changes.push({ task: entry.task, before: old, after: entry });
  }
  return changes;
}
