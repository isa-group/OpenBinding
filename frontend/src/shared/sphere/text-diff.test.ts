import { describe, expect, it } from 'vitest';

import { diffSequences, diffText, foldUnchanged, type DiffBlock } from './text-diff';

const lines = (count: number, changedAt: number[] = []) =>
  Array.from({ length: count }, (_, i) =>
    changedAt.includes(i) ? `changed ${i}` : `line ${i}`
  ).join('\n');

const shape = (blocks: DiffBlock[]) =>
  blocks.map(block =>
    block.type === 'collapsed'
      ? ['collapsed', block.id, block.rows.length]
      : ['rows', block.rows.length]
  );

describe('diffText', () => {
  it('reads equal texts as equal rows, whatever their line endings', () => {
    const diff = diffText('a\nb\n', 'a\r\nb');

    expect(diff.additions).toBe(0);
    expect(diff.removals).toBe(0);
    expect(diff.rows).toEqual([
      { kind: 'equal', left: { lineNumber: 1, text: 'a' }, right: { lineNumber: 1, text: 'a' } },
      { kind: 'equal', left: { lineNumber: 2, text: 'b' }, right: { lineNumber: 2, text: 'b' } },
    ]);
  });

  it('reads an inserted line as an addition on the right', () => {
    const diff = diffText('a\nc\n', 'a\nb\nc\n');

    expect(diff.additions).toBe(1);
    expect(diff.removals).toBe(0);
    expect(diff.rows).toEqual([
      { kind: 'equal', left: { lineNumber: 1, text: 'a' }, right: { lineNumber: 1, text: 'a' } },
      { kind: 'add', left: null, right: { lineNumber: 2, text: 'b' } },
      { kind: 'equal', left: { lineNumber: 2, text: 'c' }, right: { lineNumber: 3, text: 'c' } },
    ]);
  });

  it('reads a deleted line as a removal on the left', () => {
    const diff = diffText('a\nb\nc', 'a\nc');

    expect(diff.additions).toBe(0);
    expect(diff.removals).toBe(1);
    expect(diff.rows).toEqual([
      { kind: 'equal', left: { lineNumber: 1, text: 'a' }, right: { lineNumber: 1, text: 'a' } },
      { kind: 'remove', left: { lineNumber: 2, text: 'b' }, right: null },
      { kind: 'equal', left: { lineNumber: 3, text: 'c' }, right: { lineNumber: 2, text: 'c' } },
    ]);
  });

  it('pairs a replaced line into one change row, with the changed words marked', () => {
    const diff = diffText('a\ncost: 30 ms\nc', 'a\ncost: 40 ms\nc');

    expect(diff.additions).toBe(1);
    expect(diff.removals).toBe(1);
    expect(diff.rows[1]).toEqual({
      kind: 'change',
      left: {
        lineNumber: 2,
        text: 'cost: 30 ms',
        segments: [
          { text: 'cost: ', changed: false },
          { text: '30', changed: true },
          { text: ' ms', changed: false },
        ],
      },
      right: {
        lineNumber: 2,
        text: 'cost: 40 ms',
        segments: [
          { text: 'cost: ', changed: false },
          { text: '40', changed: true },
          { text: ' ms', changed: false },
        ],
      },
    });
  });

  it('pairs as many lines as both sides have and lists the rest as removed or added', () => {
    const diff = diffText('x\na\nb\ny', 'x\nc\ny');

    expect(
      diff.rows.map(row => [row.kind, row.left?.lineNumber ?? null, row.right?.lineNumber ?? null])
    ).toEqual([
      ['equal', 1, 1],
      ['change', 2, 2],
      ['remove', 3, null],
      ['equal', 4, 3],
    ]);
    expect(diff.rows[1].left?.segments).toEqual([{ text: 'a', changed: true }]);
    expect(diff.rows[1].right?.segments).toEqual([{ text: 'c', changed: true }]);
    expect(diff.rows[2].left?.segments).toBeUndefined();
    expect([diff.removals, diff.additions]).toEqual([2, 1]);
  });
});

describe('diffSequences', () => {
  it('reports a changed region too large for the table as a plain replacement', () => {
    // A shared element in the middle of two otherwise different sequences: the table finds it, the fallback does not.
    const sequence = (prefix: string, length: number) =>
      Array.from({ length }, (_, i) => (i === Math.floor(length / 2) ? 'common' : `${prefix}${i}`));

    // 1999 × 1999 cells are under the 4,000,000 the table allows.
    const small = diffSequences(sequence('a', 1999), sequence('b', 1999));
    expect(small.filter(op => op.kind === 'equal').map(op => op.value)).toEqual(['common']);

    // 2001 × 2001 cells are over it.
    const large = diffSequences(sequence('a', 2001), sequence('b', 2001));
    expect(large).toHaveLength(4002);
    expect(large.slice(0, 2001).every(op => op.kind === 'remove')).toBe(true);
    expect(large.slice(2001).every(op => op.kind === 'add')).toBe(true);
  });

  it('keeps unchanged ends out of the table', () => {
    const ends = Array.from({ length: 3000 }, (_, i) => `same ${i}`);
    const ops = diffSequences([...ends, 'old', ...ends], [...ends, 'new', ...ends]);

    expect(ops.filter(op => op.kind !== 'equal')).toEqual([
      { kind: 'remove', value: 'old' },
      { kind: 'add', value: 'new' },
    ]);
  });
});

describe('foldUnchanged', () => {
  it('folds long unchanged stretches and keeps the context lines around a difference', () => {
    const { rows } = diffText(lines(20), lines(20, [10]));

    expect(shape(foldUnchanged(rows))).toEqual([
      ['collapsed', 0, 7],
      ['rows', 7],
      ['collapsed', 1, 6],
    ]);
    expect(shape(foldUnchanged(rows, 1))).toEqual([
      ['collapsed', 0, 9],
      ['rows', 3],
      ['collapsed', 1, 8],
    ]);

    const [first, kept] = foldUnchanged(rows);
    expect(first.rows[0].left?.lineNumber).toBe(1);
    expect(kept.rows.map(row => row.kind)).toEqual([
      'equal',
      'equal',
      'equal',
      'change',
      'equal',
      'equal',
      'equal',
    ]);
  });

  it('leaves a stretch shorter than the minimum unfolded', () => {
    const { rows } = diffText(lines(10), lines(10, [0, 8]));

    expect(shape(foldUnchanged(rows))).toEqual([['rows', 10]]);
    expect(shape(foldUnchanged(rows, 3, 1))).toEqual([
      ['rows', 4],
      ['collapsed', 0, 1],
      ['rows', 5],
    ]);
  });

  it('folds a text with no difference into one block, unless it is short', () => {
    expect(shape(foldUnchanged(diffText(lines(10), lines(10)).rows))).toEqual([
      ['collapsed', 0, 10],
    ]);
    expect(shape(foldUnchanged(diffText(lines(3), lines(3)).rows))).toEqual([['rows', 3]]);
  });
});
