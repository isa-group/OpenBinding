import { COMPOSITION_SECTIONS, type CompositionChange, type CompositionDiff, type CompositionSection } from '../../api/compositions';

/**
 * The composition diff as rows the compare table already knows how to draw.
 *
 * This is the projection, and it is deliberately NOT the binding-case diff's five categories. Those were measured
 * against this job and refused it: `Resources` cannot hold a row for a composition — its rows come from library
 * `ArtifactRef`s and a composition's manifest names files — while four of its five categories have no row for a
 * property, which is where 205 of the 320 properties in the phase F1 gate carry a direction or an aggregation that is
 * not its template's default. Swapping `Resources` for `Properties` on the case screen would have been the obvious
 * move and the wrong one: `resourceUses` yields four rows for a library-assembled revision, so that category is empty
 * for compositions and full for the cases that screen actually serves.
 *
 * So the categories here are the composition's own sections, and the row shape is the table's. The two diffs stay
 * apart because they compare different things: one compares two assemblies of versioned library artifacts, the other
 * two versions of one self-contained composition.
 *
 * One difference worth knowing when reading the table: `changed` arrives as the server's verdict about the model,
 * rather than being inferred from whether two cells print differently. That inference is what made a goal whose
 * normalization range moved render as `Same`.
 */

/** A category button, one per section of the model. */
export const COMPOSITION_DIFF_CATEGORIES = COMPOSITION_SECTIONS;

export type CompositionDiffCategory = CompositionSection;

export interface CompositionDiffRow {
  category: CompositionDiffCategory;
  /** What the change is about: an id, or an id and the field under it. */
  what: string;
  /** The earlier value, rendered. An em dash when there was none. */
  a: string;
  b: string;
  /** Always true: the server sends only what changed. Kept so the table's column needs no special case. */
  changed: true;
  /** `added`, `removed`, `changed`, `renamed` or `moved` -- a verdict, not a string comparison. */
  kind: CompositionChange['kind'];
}

const EMPTY = '—';

/** One value as a cell. Lists and objects are flattened rather than stringified as `[object Object]`. */
export function cell(value: unknown): string {
  if (value === null || value === undefined) return EMPTY;
  if (typeof value === 'string') return value || EMPTY;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.length ? value.map(cell).join(', ') : EMPTY;
  if (typeof value === 'object') {
    const parts = Object.entries(value as Record<string, unknown>).map(([key, item]) => `${key} ${cell(item)}`);
    return parts.length ? parts.join(', ') : EMPTY;
  }
  return String(value);
}

/** The change list as table rows, in the order the server sent them. */
export function compositionRows(changes: readonly CompositionChange[]): CompositionDiffRow[] {
  return changes.map((change) => ({
    category: change.section,
    what: change.subject,
    a: cell(change.was),
    b: cell(change.now),
    changed: true as const,
    kind: change.kind,
  }));
}

/** How many rows each category holds, so a button can show a count without filtering twice. */
export function countsByCategory(rows: readonly CompositionDiffRow[]): Record<CompositionDiffCategory, number> {
  const counts = Object.fromEntries(COMPOSITION_DIFF_CATEGORIES.map((name) => [name, 0])) as Record<CompositionDiffCategory, number>;
  for (const row of rows) counts[row.category] += 1;
  return counts;
}

/**
 * A sentence for a reader who wants the shape of the change before the table.
 *
 * It names the verdicts rather than counting rows, because "27 changes" and "six services replaced, two renamed" are
 * different answers to the same question and only one of them is useful.
 */
export function compositionSummary(diff: CompositionDiff): string {
  if (diff.identical) return 'No changes.';
  const byKind = new Map<CompositionChange['kind'], number>();
  for (const change of diff.changes) byKind.set(change.kind, (byKind.get(change.kind) ?? 0) + 1);
  const order: CompositionChange['kind'][] = ['added', 'removed', 'renamed', 'moved', 'changed'];
  const parts = order.filter((kind) => byKind.has(kind)).map((kind) => `${byKind.get(kind)} ${kind}`);
  return parts.join(', ') + '.';
}
