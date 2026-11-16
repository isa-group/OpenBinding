// Adapted from SPHERE frontend/src/modules/pricing/utils/change-summary.ts (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: the input is the gateway's version diff (CompositionVersionDiff), whose sections are binding, values and
// offering; `priceChanges` becomes `candidateChanges` and `valueChanges`, and the diff's `comparison` is carried.

import type { CompositionVersionDiff } from '../../api/types';

type SectionKey = CompositionVersionDiff['sections'][number]['key'];

/** What changed in one section of a composition (binding, values, offering), by name. */
export interface SectionChanges {
  key: SectionKey;
  label: string;
  added: string[];
  removed: string[];
  changed: string[];
}

/** A task that stayed bound and whose candidate changed; `null` where the task had no candidate (a local task). */
export interface CandidateChange {
  task: string;
  before: string | null;
  after: string | null;
}

/** A value that stayed and whose number changed, as the gateway reported both numbers. */
export interface ValueChange {
  name: string;
  before: number | null;
  after: number | null;
}

/** A short, composition-minded reading of a diff: what a glance at a version should tell. */
export interface ChangeSummary {
  /** Only the sections with changes, in the diff's order. */
  sections: SectionChanges[];
  /** Tasks that stayed but whose candidate changed. */
  candidateChanges: CandidateChange[];
  /** Values that stayed but whose number changed; empty when the two sides' values are not comparable. */
  valueChanges: ValueChange[];
  /** Whether the two sides' values can be compared, and what tells them apart if not, as the gateway said. */
  comparison: CompositionVersionDiff['comparison'];
  /** Changed top-level fields that are not a section (kind, problem, workflow…). */
  otherFields: number;
  isEmpty: boolean;
}

const asText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const asNumber = (value: unknown): number | null => (typeof value === 'number' ? value : null);

const changedEntries = (diff: CompositionVersionDiff, key: SectionKey) =>
  diff.sections
    .filter(section => section.key === key)
    .flatMap(section => section.entries)
    .filter(entry => entry.kind === 'changed');

export function summarizeChanges(diff: CompositionVersionDiff): ChangeSummary {
  const sections = diff.sections
    .map(section => ({
      key: section.key,
      label: section.label,
      added: section.entries.filter(entry => entry.kind === 'added').map(entry => entry.name),
      removed: section.entries.filter(entry => entry.kind === 'removed').map(entry => entry.name),
      changed: section.entries.filter(entry => entry.kind === 'changed').map(entry => entry.name),
    }))
    .filter(section => section.added.length + section.removed.length + section.changed.length > 0);

  const candidateChanges = changedEntries(diff, 'binding').flatMap(entry =>
    entry.changes
      .filter(change => change.path === 'candidate')
      .map(change => ({
        task: entry.name,
        before: asText(change.before),
        after: asText(change.after),
      }))
  );

  const valueChanges = diff.comparison.comparable
    ? changedEntries(diff, 'values').flatMap(entry =>
        entry.changes
          .filter(change => change.path === 'value')
          .map(change => ({
            name: entry.name,
            before: asNumber(change.before),
            after: asNumber(change.after),
          }))
      )
    : [];

  return {
    sections,
    candidateChanges,
    valueChanges,
    comparison: diff.comparison,
    otherFields: diff.general.length,
    isEmpty: sections.length === 0 && diff.general.length === 0,
  };
}
