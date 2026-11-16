// Adapted from SPHERE frontend/test/change-summary.test.ts (revision 73779a8a), https://github.com/SCORELabUS/SPHERE.
// Copyright (c) 2024 Alejandro García Fernández. MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: node:test becomes vitest, and the diffs are the gateway's (src/test/fixtures/core/*.diff.json) instead of
// diffs of two pricings computed in the client; price changes become candidate and value changes.

import { describe, expect, it } from 'vitest';

import type { CompositionVersionDiff } from '../../modules/core/api/types';
import ambiguous from '../../test/fixtures/core/ambiguous.diff.json';
import fms from '../../test/fixtures/core/fms.diff.json';
import { summarizeChanges } from './change-summary';

const diffOf = (fixture: unknown) => structuredClone(fixture) as CompositionVersionDiff;

describe('summarizeChanges', () => {
  it('says what each section gained, lost and changed, and which candidates and values moved', () => {
    const summary = summarizeChanges(diffOf(fms));

    expect(summary.isEmpty).toBe(false);
    // The offering did not change, so it is not listed.
    expect(
      summary.sections.map(section => [
        section.key,
        section.added,
        section.removed,
        section.changed,
      ])
    ).toEqual([
      ['binding', [], [], ['T1']],
      ['values', [], [], ['availability', 'cost', 'execution_time', 'reliability']],
    ]);
    expect(summary.candidateChanges).toEqual([
      { task: 'T1', before: 'cand_t1_aws', after: 'cand_t1_google_cloud' },
    ]);
    expect(summary.valueChanges).toEqual([
      { name: 'availability', before: 0.9963044476255752, after: 0.9966034884802901 },
      { name: 'cost', before: 3060, after: 3080 },
      { name: 'execution_time', before: 3180, after: 3190 },
      { name: 'reliability', before: 0.97670566058688, after: 0.9771952373591039 },
    ]);
    expect(summary.otherFields).toBe(0);
    expect(summary.comparison).toEqual(fms.comparison);
  });

  it('keeps the candidate names as the documents wrote them', () => {
    const summary = summarizeChanges(diffOf(ambiguous));

    expect(summary.candidateChanges).toEqual([{ task: 't1', before: 'catalog/c1a', after: 'c1b' }]);
  });

  it('reads a first version as everything it starts with, and equal versions as no changes', () => {
    const diff = diffOf(fms);
    const added = (names: string[], path: string) =>
      names.map(name => ({
        name,
        kind: 'added' as const,
        changes: [{ path, before: null, after: name }],
      }));
    diff.sections = [
      { key: 'binding', label: 'Binding', entries: added(['T1', 'T2', 'T3'], 'candidate') },
      { key: 'values', label: 'Values', entries: added(['cost', 'availability'], 'value') },
      { key: 'offering', label: 'Offering', entries: added(['source'], 'sphere') },
    ];
    const first = summarizeChanges(diff);

    expect(first.sections.map(section => [section.key, section.added.length])).toEqual([
      ['binding', 3],
      ['values', 2],
      ['offering', 1],
    ]);
    // A task or a value that is new did not move.
    expect(first.candidateChanges).toEqual([]);
    expect(first.valueChanges).toEqual([]);

    // Only the version label differs, which a diff does not report.
    const same = diffOf(fms);
    same.sections = same.sections.map(section => ({ ...section, entries: [] }));
    same.general = [];
    const unchanged = summarizeChanges(same);

    expect(unchanged.isEmpty).toBe(true);
    expect(unchanged.sections).toEqual([]);
  });

  it('counts changed top-level fields that are not a section', () => {
    const diff = diffOf(fms);
    diff.general = [{ path: 'workflow', before: { seq: ['T1'] }, after: { seq: ['T1', 'T2'] } }];
    diff.sections = diff.sections.map(section => ({ ...section, entries: [] }));
    const summary = summarizeChanges(diff);

    expect(summary.otherFields).toBe(1);
    expect(summary.sections).toEqual([]);
    expect(summary.isEmpty).toBe(false);
  });

  it('reads no value change between sides whose values are not comparable', () => {
    const diff = diffOf(fms);
    diff.comparison = { ...diff.comparison, comparable: false, compilationChanged: true };
    const summary = summarizeChanges(diff);

    expect(summary.valueChanges).toEqual([]);
    expect(summary.comparison).toEqual(diff.comparison);
    // The candidate change is still read: it is no value.
    expect(summary.candidateChanges).toHaveLength(1);
  });

  it('reads a task that became local as a candidate change to none', () => {
    const diff = diffOf(fms);
    diff.sections[0].entries = [
      {
        name: 'T1',
        kind: 'changed',
        changes: [
          { path: 'candidate', before: 'cand_t1_aws', after: null },
          { path: 'local', before: null, after: true },
        ],
      },
    ];

    expect(summarizeChanges(diff).candidateChanges).toEqual([
      { task: 'T1', before: 'cand_t1_aws', after: null },
    ]);
  });
});
