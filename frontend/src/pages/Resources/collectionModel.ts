import type { Collection, CollectionItem, CollectionRevision, ProjectResource, ProjectResourceRevision } from '../../api/platform';
import { shortDigest } from '../../utils/digest';
import type { CaseContent } from '../Project/projectModel';
import { plural } from './resourceModel';

/** What a collection can hold: the gateway pins `case` and `resource` items only (`unsupported_collection_target` for the rest). */
export type EntryKind = 'case' | 'resource';

/** A thing that can be pinned, with the exact reference the gateway wants. */
export interface Pin {
  kind: EntryKind;
  /** The identity of the target inside a collection: the gateway refuses a repeated (kind, fingerprint). */
  key: string;
  label: string;
  /** What kind of revision it is, for the picker (`Case revision`, `Resource revision`). */
  sub: string;
  digest: string;
  href: string;
  item: CollectionItem;
  /** Of a resource: its address and the number of the revision, which is how the gateway names it when it lists a collection. */
  slug?: string;
  ordinal?: number;
}

/** One line of a collection’s list. `pin` is `null` when the stored reference can’t be turned back into something the gateway accepts. */
export interface Entry {
  kind: string;
  key: string;
  label: string;
  sub: string;
  digest: string;
  href?: string;
  pin: CollectionItem | null;
}

export interface ResourceContent {
  resource: ProjectResource;
  revisions: ProjectResourceRevision[];
  /** The revisions could be read; `false` shows “—” where the count would be, never a made-up zero. */
  known?: boolean;
}

export const pinKey = (kind: string, digest: string) => `${kind}:${digest}`;

/** Every case revision and resource revision of the project, as things a collection can point at. */
export function buildPins(cases: readonly CaseContent[], resources: readonly ResourceContent[], root: string): Pin[] {
  const pins: Pin[] = [];
  for (const { item, revisions } of cases) {
    for (const revision of [...revisions].sort((a, b) => b.revision - a.revision)) {
      pins.push({
        kind: 'case',
        key: pinKey('case', revision.digest),
        label: `${item.name} · revision ${revision.revision}`,
        sub: 'Case revision',
        digest: revision.digest,
        href: `${root}/cases/${encodeURIComponent(item.slug)}/revisions/${revision.revision}`,
        item: { target_kind: 'case', target_digest: revision.digest, target_ref: { caseRevisionId: revision.id } },
      });
    }
  }
  for (const { resource, revisions } of resources) {
    for (const revision of [...revisions].sort((a, b) => b.revision - a.revision)) {
      pins.push({
        kind: 'resource',
        key: pinKey('resource', revision.digest),
        label: `${resource.name} · revision ${revision.revision}`,
        sub: 'Resource revision',
        digest: revision.digest,
        href: `${root}/resources/${encodeURIComponent(resource.slug)}`,
        item: { target_kind: 'resource', target_digest: revision.digest, target_ref: { resourceRevisionId: revision.id } },
        slug: resource.slug,
        ordinal: revision.revision,
      });
    }
  }
  return pins;
}

function textOf(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

/**
 * A stored item as a line of the list. The gateway answers a case item with its revision id and a resource item with the library
 * reference (`name`, `version`, `versionDigest`); the second is matched with the project’s resources by address and revision number.
 */
export function entryOf(item: CollectionItem, pins: readonly Pin[]): Entry {
  const ref = item.target_ref as Record<string, unknown>;
  if (item.target_kind === 'case') {
    const id = textOf(ref.caseRevisionId);
    const found = pins.find((pin) => pin.kind === 'case' && (pin.item.target_ref.caseRevisionId === id || pin.digest === item.target_digest));
    if (found) return { kind: 'case', key: found.key, label: found.label, sub: found.sub, digest: found.digest, href: found.href, pin: found.item };
    return {
      kind: 'case', key: pinKey('case', item.target_digest), label: `Case revision ${id ? id.slice(0, 8) : shortDigest(item.target_digest)}`,
      sub: 'Case revision', digest: item.target_digest, pin: id ? { target_kind: 'case', target_digest: item.target_digest, target_ref: { caseRevisionId: id } } : null,
    };
  }
  if (item.target_kind === 'resource') {
    const name = textOf(ref.name);
    const version = textOf(ref.version);
    const found = pins.find((pin) => pin.kind === 'resource' && name !== undefined && pin.slug === name && String(pin.ordinal) === version);
    if (found) return { kind: 'resource', key: found.key, label: found.label, sub: found.sub, digest: found.digest, href: found.href, pin: found.item };
    return {
      kind: 'resource', key: `resource:${item.target_digest}`, label: name ? `${name} · ${/^\d/.test(version ?? '') ? 'revision ' : ''}${version ?? ''}`.trim() : 'Library version',
      sub: 'Pinned from the library', digest: item.target_digest, pin: null,
    };
  }
  return {
    kind: item.target_kind, key: pinKey(item.target_kind, item.target_digest), label: `${item.target_kind} ${shortDigest(item.target_digest)}`,
    sub: 'Not supported', digest: item.target_digest, pin: null,
  };
}

export function entriesOf(revision: Pick<CollectionRevision, 'items'> | undefined, pins: readonly Pin[]): Entry[] {
  return (revision?.items ?? []).map((item) => entryOf(item, pins));
}

export function entryFromPin(pin: Pin): Entry {
  return { kind: pin.kind, key: pin.key, label: pin.label, sub: pin.sub, digest: pin.digest, href: pin.href, pin: pin.item };
}

export const newestFirst = (revisions: readonly CollectionRevision[]): CollectionRevision[] => [...revisions].sort((a, b) => b.revision - a.revision);

/** The same entries in another position. Out-of-range moves leave the list as it was. */
export function move<T>(list: readonly T[], index: number, delta: -1 | 1): T[] {
  const target = index + delta;
  if (index < 0 || index >= list.length || target < 0 || target >= list.length) return [...list];
  const copy = [...list];
  [copy[index], copy[target]] = [copy[target], copy[index]];
  return copy;
}

export const sameList = (a: readonly Entry[], b: readonly Entry[]): boolean => a.length === b.length && a.every((entry, index) => entry.key === b[index].key);

export interface Difference {
  kind: 'added' | 'removed' | 'moved';
  label: string;
  /** For a moved item: where it was and where it is, counting from 1. */
  from?: number;
  to?: number;
}

/** What changed from `before` to `after`: items that came, left, or changed position among those that stayed. */
export function differences(before: readonly Entry[], after: readonly Entry[]): Difference[] {
  const was = new Map(before.map((entry, index) => [entry.key, index]));
  const is = new Map(after.map((entry, index) => [entry.key, index]));
  const added = after.filter((entry) => !was.has(entry.key)).map((entry): Difference => ({ kind: 'added', label: entry.label }));
  const removed = before.filter((entry) => !is.has(entry.key)).map((entry): Difference => ({ kind: 'removed', label: entry.label }));
  const kept = before.filter((entry) => is.has(entry.key));
  const order = after.filter((entry) => was.has(entry.key));
  const moved = order.flatMap((entry, index): Difference[] => {
    const from = kept.findIndex((item) => item.key === entry.key);
    return from === index ? [] : [{ kind: 'moved', label: entry.label, from: (was.get(entry.key) ?? 0) + 1, to: (is.get(entry.key) ?? 0) + 1 }];
  });
  return [...added, ...removed, ...moved];
}

/** The chips of a collection card: how many of each thing it points to. */
export function typeSummary(items: readonly CollectionItem[]): string[] {
  const count = (kind: string) => items.filter((item) => item.target_kind === kind).length;
  const chips: string[] = [];
  if (count('case')) chips.push(plural(count('case'), 'case revision'));
  if (count('resource')) chips.push(plural(count('resource'), 'resource version'));
  const others = items.length - count('case') - count('resource');
  if (others) chips.push(plural(others, 'other item'));
  return chips;
}

export interface CollectionContent {
  collection: Collection;
  revisions: CollectionRevision[];
}
