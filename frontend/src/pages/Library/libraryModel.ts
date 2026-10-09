import type { LibraryItem, LibraryVersion } from '../../api/libraryItems';
import { buildCitation, type Citation } from '../../utils/citation';
import { yearOf } from '../../utils/format';

/** The kinds the library knows, in the order the dialog offers them: the ones people reach for first, then the rest. */
export const KIND_CHOICES: ReadonlyArray<{ id: string; label: string; hint?: string }> = [
  { id: 'Application', label: 'Application', hint: 'tasks and flow' },
  { id: 'CandidateCatalog', label: 'Candidate catalog', hint: 'providers' },
  { id: 'ConstraintSet', label: 'Rules' },
  { id: 'Optimization', label: 'Goal' },
  { id: 'Placement', label: 'Placement' },
  { id: 'Study', label: 'Study' },
  { id: 'Collection', label: 'Collection' },
  { id: 'ExecutionConfiguration', label: 'Run settings' },
  { id: 'Report', label: 'Report' },
  { id: 'Dataset', label: 'Dataset' },
  { id: 'BPMN', label: 'BPMN workflow' },
  { id: 'RoutingOverlay', label: 'Routing overlay' },
  { id: 'AnalysisConfiguration', label: 'Analysis settings' },
  { id: 'BindingDecision', label: 'Binding decision' },
];

export const OTHER_KIND = '__other';

/** What a reader calls a kind; a kind nobody named yet reads as it is written. */
export function kindLabel(kind: string): string {
  return KIND_CHOICES.find((choice) => choice.id === kind)?.label ?? kind;
}

export const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const DISPLAY_MAX = 160;

/** What typing into the fixed-name field leaves: lower case, with anything the address can't hold turned into a hyphen. */
export function fixedName(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9._-]/g, '-');
}

// --- addresses

export const libraryPath = (org: string) => `/app/${org}/library`;

/**
 * How an item is named in an address: by its fixed name when that is unambiguous inside the organization that owns it, otherwise by
 * its id. Another organization's published item is always addressed by id, since a name only means something inside its owner.
 */
export function itemKey(item: LibraryItem, ownerOrganizationId: string | undefined, all: readonly LibraryItem[]): string {
  const own = item.organization_id === ownerOrganizationId;
  const unique = all.filter((other) => other.organization_id === item.organization_id && other.name === item.name).length === 1;
  return own && unique ? item.name : item.id;
}

export const itemPath = (org: string, key: string) => `${libraryPath(org)}/${encodeURIComponent(key)}`;
export const versionPath = (org: string, key: string, version: string) => `${itemPath(org, key)}/versions/${encodeURIComponent(version)}`;
export const draftPath = (org: string, key: string, draft: string) => `${itemPath(org, key)}/drafts/${encodeURIComponent(draft)}`;

// --- versions

export type Publication = 'members' | 'published' | 'withdrawn';

export function publicationOf(version: Pick<LibraryVersion, 'public' | 'withdrawn'>): Publication {
  if (version.withdrawn) return 'withdrawn';
  return version.public ? 'published' : 'members';
}

export const PUBLICATION_LABELS: Record<Publication, string> = {
  members: 'Members only',
  published: 'Published · public',
  withdrawn: 'Withdrawn · not listed',
};

/** Newest first: by ordinal, which the gateway assigns in the order versions were sealed. */
export function newestFirst(versions: readonly LibraryVersion[]): LibraryVersion[] {
  return [...versions].sort((a, b) => b.ordinal - a.ordinal);
}

/** The version an address names: its label (`3`) or its id. */
export function findVersion(versions: readonly LibraryVersion[], param: string): LibraryVersion | undefined {
  return versions.find((version) => version.ref.version === param) ?? versions.find((version) => version.id === param);
}

export type MediaKind = 'json' | 'xml' | 'text';

export function mediaKindOf(mediaType: string | undefined): MediaKind {
  const type = (mediaType ?? 'application/json').toLowerCase();
  if (type.includes('json')) return 'json';
  if (type.includes('xml')) return 'xml';
  return 'text';
}

/** The exact reference as one line a person can paste into a bug report or a case: `namespace/name@version digest`. */
export function exactReference(version: Pick<LibraryVersion, 'ref'>): string {
  const { namespace, name, version: label, versionDigest } = version.ref;
  return `${namespace}/${name}@${label} ${versionDigest}`;
}

/** How to cite a published version, from what the gateway returned: it carries no DOI or venue, and none is invented. */
export function citationOf(item: LibraryItem, version: LibraryVersion, owner: string | null, title: string | null, origin: string): Citation {
  return buildCitation({
    title: `${title?.trim() || item.display_name}, version ${version.ref.version}`,
    author: owner,
    year: yearOf(version.created_at),
    kindLabel: kindLabel(item.kind).toLowerCase(),
    digest: version.ref.versionDigest,
    url: `${origin}/resolve/artifact/${version.ref.versionDigest}`,
  });
}

export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}
