// Address builders of the compositions area. Code that links to a composition list, a composition, its tabs or its public
// page builds the address here, so the segments are named once. The lists are SPHERE's: `/compositions` (public),
// `/me/compositions` (the account's) and an organization's Compositions tab (`/orgs/:org/compositions`).

import type { Kind } from '../../modules/core/utils/composition/document';
import { orgPath } from '../../modules/organization/types/paths';
import { organizationPath } from './problems';

/** The segment of the composition list and the composition page. */
export const COMPOSITIONS_SEGMENT = 'compositions';

/** The segments of the composition page after the composition: no segment is the Overview tab. */
export const COMPOSITION_TAB_SEGMENTS = ['editor', 'versions', 'analysis', 'settings'] as const;

export type CompositionTabSegment = (typeof COMPOSITION_TAB_SEGMENTS)[number];

export const isCompositionTabSegment = (value: string): value is CompositionTabSegment =>
  (COMPOSITION_TAB_SEGMENTS as readonly string[]).includes(value);

/** What a composition list shows: some kinds, the archived ones instead of the active ones, and a search text. */
export interface CompositionsFilter {
  kind?: Kind;
  archived?: boolean;
  q?: string;
}

/** How the Versions tab shows a pair of versions. */
export type VersionsView = 'table' | 'compare' | 'file' | 'evolution';

/** The query of a composition page: the version shown (`version`), the pair the Versions tab compares (`from`, `to`) and its view. */
export interface CompositionQuery {
  version?: number | string;
  from?: number | string;
  to?: number | string;
  view?: VersionsView;
}

function withQuery(
  path: string,
  values: Record<string, string | number | boolean | undefined>
): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== '' && value !== false) query.set(key, String(value));
  }
  const search = query.toString();
  return search ? `${path}?${search}` : path;
}

/** The compositions of an organization: its Compositions tab, `/orgs/<org>/compositions`, with its filters. */
export function compositionsPath(org: string, filter: CompositionsFilter = {}): string {
  return withQuery(orgPath(org, COMPOSITIONS_SEGMENT), {
    kinds: filter.kind,
    archived: filter.archived,
    q: filter.q?.trim(),
  });
}

/** A composition of an organization, with its tab and the version or pair it shows. */
export function compositionPath(
  org: string,
  composition: string,
  tab?: CompositionTabSegment,
  query: CompositionQuery = {}
): string {
  const base = `${organizationPath(org)}/${COMPOSITIONS_SEGMENT}/${encodeURIComponent(composition)}`;
  return withQuery(tab ? `${base}/${tab}` : base, { ...query });
}

/** The query of a public page: the version shown, and whether the fork dialog opens once the caller is signed in. */
export interface ShowcaseQuery {
  version?: number | string;
  /** `?fork=1`: the page opens the fork dialog for a signed-in caller, then drops the parameter. */
  fork?: boolean;
}

/** The public page of a public composition: `/c/<org>/<composition>`, at a version (an id, a label or an ordinal). */
export function showcasePath(org: string, composition: string, query: ShowcaseQuery = {}): string {
  return withQuery(`/c/${encodeURIComponent(org)}/${encodeURIComponent(composition)}`, {
    version: query.version,
    fork: query.fork ? 1 : undefined,
  });
}

/** What the public list shows: some kinds, a search text and a page (1 is the first, and is left out of the address). */
export interface PublicCompositionsFilter {
  kind?: Kind;
  q?: string;
  page?: number;
}

/** The public compositions of every organization: `/compositions`, with its filters. */
export function publicCompositionsPath(filter: PublicCompositionsFilter = {}): string {
  return withQuery(`/${COMPOSITIONS_SEGMENT}`, {
    q: filter.q?.trim(),
    kinds: filter.kind,
    page: filter.page && filter.page > 1 ? filter.page : undefined,
  });
}

/** The compositions the account reads as a member: `/me/compositions`. */
export function myCompositionsPath(): string {
  return `/me/${COMPOSITIONS_SEGMENT}`;
}
