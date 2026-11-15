// Address builders of the compositions area (F2). Code that links to the composition list, a composition, its tabs or its public
// page builds the address here, so the segments are named once.

import type { Kind } from '../../entities/composition/document';
import { organizationPath } from './problems';

/** The segment of the composition list and the composition page. */
export const COMPOSITIONS_SEGMENT = 'compositions';

/**
 * The segments of the composition page after the composition: no segment is the Overview tab. The Editor, Versions, Analysis
 * and Settings tabs join the list with the blocks that build them.
 */
export const COMPOSITION_TAB_SEGMENTS = [] as const;

export type CompositionTabSegment = (typeof COMPOSITION_TAB_SEGMENTS)[number];

export const isCompositionTabSegment = (value: string): value is CompositionTabSegment => (
  (COMPOSITION_TAB_SEGMENTS as readonly string[]).includes(value)
);

/** What the composition list shows: one kind, the archived ones instead of the active ones, and a search text. */
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

function withQuery(path: string, values: Record<string, string | number | boolean | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== '' && value !== false) query.set(key, String(value));
  }
  const search = query.toString();
  return search ? `${path}?${search}` : path;
}

/** The composition list of an organization: `/app/<org>/compositions`, with its filters. */
export function compositionsPath(org: string, filter: CompositionsFilter = {}): string {
  return withQuery(`${organizationPath(org)}/${COMPOSITIONS_SEGMENT}`, { kind: filter.kind, archived: filter.archived, q: filter.q?.trim() });
}

/** A composition of an organization, with its tab and the version or pair it shows. */
export function compositionPath(org: string, composition: string, tab?: CompositionTabSegment, query: CompositionQuery = {}): string {
  const base = `${organizationPath(org)}/${COMPOSITIONS_SEGMENT}/${encodeURIComponent(composition)}`;
  return withQuery(tab ? `${base}/${tab}` : base, { ...query });
}

/** The public page of a public composition: `/c/<org>/<composition>`, at a version (an id, a label or an ordinal). */
export function showcasePath(org: string, composition: string, query: { version?: number | string } = {}): string {
  return withQuery(`/c/${encodeURIComponent(org)}/${encodeURIComponent(composition)}`, { version: query.version });
}

/** The public compositions of every organization: `/compositions`. */
export const publicCompositionsPath = (): string => `/${COMPOSITIONS_SEGMENT}`;
