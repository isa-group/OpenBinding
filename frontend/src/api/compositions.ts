import { apiClient } from './client';

/** One section of a composition, in the order a reader wants them. Mirrors the model, not the screen. */
export const COMPOSITION_SECTIONS = [
  'identity',
  'properties',
  'tasks',
  'workflow',
  'candidates',
  'rules',
  'goals',
  'studio',
] as const;

export type CompositionSection = (typeof COMPOSITION_SECTIONS)[number];

/**
 * What kind of change it is.
 *
 * `renamed` and `moved` are why the other three mean something: without them every rename is a removal plus an
 * addition, which is what a diff over the compiled package degrades to.
 */
export type CompositionChangeKind = 'added' | 'removed' | 'changed' | 'renamed' | 'moved';

/** One difference, in the terms the author wrote rather than the ones the compiled package has. */
export interface CompositionChange {
  section: CompositionSection;
  /** An id, or an id and the field under it (`cost.aggregation.exclusive`). */
  subject: string;
  kind: CompositionChangeKind;
  was: unknown;
  now: unknown;
}

export interface CompositionDiff {
  /**
   * True when the two compositions are the same model. An empty change list means that and not that the comparison
   * was shallow: the diff of any package in the phase F1 gate against itself is empty.
   */
  identical: boolean;
  changes: CompositionChange[];
  /** How many changes each section holds, including the sections with none. */
  counts: Record<CompositionSection, number>;
}

/**
 * Comparing two compositions.
 *
 * It takes the two sources rather than naming two stored versions because nothing stores a composition yet. When that
 * storage arrives the stored-version form is an addition and this response shape does not change.
 */
export const compositionsApi = {
  /** `POST /v1/compositions/diff`: what changed between two Composition2Yaml documents. */
  diff: (before: string, after: string) =>
    apiClient.request<CompositionDiff>('/v1/compositions/diff', {
      method: 'POST',
      body: JSON.stringify({ before, after }),
    }),
};
