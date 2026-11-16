import { describe, expect, it } from 'vitest';
import type { CompositionVersionDiff } from '../../modules/core/api/types';
import fms from '../../test/fixtures/core/fms.diff.json';
import { fieldPath, formatDiffValue, notComparableShort, versionChanges } from './changes';

const diff = () => structuredClone(fms) as CompositionVersionDiff;

describe('versionChanges', () => {
  it('reads candidate and value changes of a comparable diff', () => {
    const changes = versionChanges(diff());
    expect(changes.notComparable).toBeNull();
    expect(changes.candidateChanges).toEqual([
      { task: 'T1', before: 'cand_t1_aws', after: 'cand_t1_google_cloud' },
    ]);
    expect(changes.valueChanges.map(change => change.name)).toEqual([
      'availability',
      'cost',
      'execution_time',
      'reliability',
    ]);
    expect(changes.valueChanges[1]).toEqual({ name: 'cost', before: 3060, after: 3080 });
    expect(changes.sections.map(section => section.key)).toEqual(['binding', 'values']);
  });

  it('says why values are not compared, and lists none', () => {
    const declared = diff();
    declared.comparison = {
      comparable: false,
      problemRefChanged: false,
      compilationChanged: false,
      valueStatus: { before: 'verified', after: 'declared' },
    };
    const changes = versionChanges(declared);
    expect(changes.valueChanges).toEqual([]);
    expect(changes.notComparable).toBe(
      'Values are not compared: the values of 1.0.0 are verified and those of 1.1.0 are declared.'
    );

    const moved = diff();
    moved.comparison = {
      comparable: false,
      problemRefChanged: true,
      compilationChanged: true,
      valueStatus: { before: 'verified', after: 'verified' },
    };
    expect(versionChanges(moved).notComparable).toBe(
      'Values are not compared: the two versions link different problems.'
    );

    const recompiled = diff();
    recompiled.comparison = { ...moved.comparison, problemRefChanged: false };
    expect(versionChanges(recompiled).notComparable).toBe(
      'Values are not compared: the two versions were judged on different compilations.'
    );
  });

  it('names the reason in a few words for a summary line', () => {
    const base = diff().comparison;
    expect(notComparableShort(base)).toBeNull();
    expect(
      notComparableShort({
        ...base,
        comparable: false,
        problemRefChanged: true,
        compilationChanged: true,
      })
    ).toBe('problem changed');
    expect(notComparableShort({ ...base, comparable: false, compilationChanged: true })).toBe(
      'compilation changed'
    );
    expect(
      notComparableShort({
        ...base,
        comparable: false,
        valueStatus: { before: 'verified', after: 'declared' },
      })
    ).toBe('verified vs declared');
  });

  it('carries the comparison as the gateway gave it', () => {
    const value = diff();
    expect(versionChanges(value).comparison).toEqual(value.comparison);
  });
});

describe('formatDiffValue', () => {
  it('reads null as the absence of the field, on the side where it is absent', () => {
    expect(formatDiffValue(null, 'before')).toBe('not set');
    expect(formatDiffValue(null, 'after')).toBe('removed');
    expect(formatDiffValue(undefined, 'after')).toBe('removed');
  });

  it('reads an added entry as not set before and a removed one as removed after', () => {
    const added = {
      kind: 'added',
      name: 'T7',
      changes: [{ path: 'candidate', before: null, after: 'cand_t7' }],
    };
    const removed = {
      kind: 'removed',
      name: 'T7',
      changes: [{ path: 'candidate', before: 'cand_t7', after: null }],
    };
    expect(
      added.changes.map(change => [
        formatDiffValue(change.before, 'before'),
        formatDiffValue(change.after, 'after'),
      ])
    ).toEqual([['not set', 'cand_t7']]);
    expect(
      removed.changes.map(change => [
        formatDiffValue(change.before, 'before'),
        formatDiffValue(change.after, 'after'),
      ])
    ).toEqual([['cand_t7', 'removed']]);
  });

  it('writes present values as they are: numbers formatted, falsy ones kept, blocks as JSON', () => {
    expect(formatDiffValue(3080, 'after')).toBe('3,080');
    expect(formatDiffValue(0, 'before')).toBe('0');
    expect(formatDiffValue('', 'after')).toBe('');
    expect(formatDiffValue(false, 'after')).toBe('false');
    expect(formatDiffValue({ seq: ['a', 'b'] }, 'after')).toBe('{"seq":["a","b"]}');
  });
});

describe('fieldPath', () => {
  it('splits a dotted path and keeps its last field apart', () => {
    expect(fieldPath('from.version')).toEqual({
      parents: ['from'],
      leaf: 'version',
      text: 'from › version',
    });
    expect(fieldPath('candidate')).toEqual({ parents: [], leaf: 'candidate', text: 'candidate' });
  });
});
