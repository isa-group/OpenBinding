// Address builders of the compositions area. Code that links to a composition list, a composition, its tabs or its public
// page builds the address here, so the segments are named once. The lists are SPHERE's: `/compositions` (public),
// `/me/compositions` (the account's) and an organization's Compositions tab (`/orgs/:org/compositions`).

import type { Kind } from '../../modules/core/utils/composition/document';
import { orgPath } from '../../modules/organization/types/paths';

/** The segment of the composition list and the composition page. */
export const COMPOSITIONS_SEGMENT = 'compositions';

/** The segments of the composition page after the composition: no segment is the Overview tab. */
export const COMPOSITION_TAB_SEGMENTS = [
  'analytics',
  'analysis',
  'versions',
  'editor',
  'settings',
] as const;

export type CompositionTabSegment = (typeof COMPOSITION_TAB_SEGMENTS)[number];

export const isCompositionTabSegment = (value: string): value is CompositionTabSegment =>
  (COMPOSITION_TAB_SEGMENTS as readonly string[]).includes(value);

/** What a composition list shows: some kinds, the archived ones instead of the active ones, and a search text. */
export interface CompositionsFilter {
  kind?: Kind;
  archived?: boolean;
  q?: string;
}

/** The query of a composition page: the version shown (`version`), and the pair the Versions tab compares (`from`, `to`). */
export interface CompositionQuery {
  version?: number | string;
  from?: number | string;
  to?: number | string;
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

/** A composition, with its tab and the version or pair it shows: `/compositions/<org>/<composition>/<tab>`, SPHERE's card page. */
export function compositionPath(
  org: string,
  composition: string,
  tab?: CompositionTabSegment,
  query: CompositionQuery = {}
): string {
  const base = `/${COMPOSITIONS_SEGMENT}/${encodeURIComponent(org)}/${encodeURIComponent(composition)}`;
  return withQuery(tab ? `${base}/${tab}` : base, { ...query });
}

/** Where a composition is created: `/compositions/new`, in the organization `?org=` names. */
export function newCompositionPath(org?: string): string {
  return withQuery(`/${COMPOSITIONS_SEGMENT}/new`, { org });
}

/** The permanent link of a composition (`/p/<id>`), at a version when one is named. */
export function permalinkPath(id: string, version?: string): string {
  return withQuery(`/p/${encodeURIComponent(id)}`, { version });
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
