import { describe, expect, it } from 'vitest';
import type { CompositionDiagnosticView } from '../api/types';
import { byLocation, counts, fromC2y, locatedKey, type Located } from './located';

const TEXT = 'syntaxVersion: "1.0"\ncomposition: shop\nworkflow: {seq: [pick, ship]}\n';

const diagnostic = (overrides: Partial<CompositionDiagnosticView> = {}): CompositionDiagnosticView => ({
  code: 'c2y_task_unbound',
  message: 'Task ship has no binding entry.',
  severity: 'error',
  path: 'workflow',
  pointer: '/workflow',
  span: { line: 3, column: 24, end_line: 3, end_column: 28 },
  ...overrides,
});

describe('fromC2y', () => {
  it('turns a one-based line and column into offsets, the end exclusive', () => {
    const located = fromC2y(diagnostic(), TEXT, 'composition.yaml');
    expect(located.where).toEqual({ kind: 'text', file: 'composition.yaml', from: 62, to: 66, line: 3, column: 24 });
    if (located.where.kind !== 'text') throw new Error('not in the text');
    expect(TEXT.slice(located.where.from, located.where.to)).toBe('ship');
    expect(located).toMatchObject({ code: 'c2y_task_unbound', severity: 'error', path: 'workflow', pointer: '/workflow' });
  });

  it('spans lines', () => {
    const located = fromC2y(diagnostic({ span: { line: 2, column: 1, end_line: 3, end_column: 9 } }), TEXT, 'composition.yaml');
    if (located.where.kind !== 'text') throw new Error('not in the text');
    expect(TEXT.slice(located.where.from, located.where.to)).toBe('composition: shop\nworkflow');
  });

  it('counts columns in characters, as the gateway does, and offsets in UTF-16 units, as the editor does', () => {
    const text = 'name: "\u{1F345} tomato"\n';
    const located = fromC2y(diagnostic({ span: { line: 1, column: 10, end_line: 1, end_column: 16 } }), text, 'composition.yaml');
    if (located.where.kind !== 'text') throw new Error('not in the text');
    expect(text.slice(located.where.from, located.where.to)).toBe('tomato');
  });

  it('keeps a position past the end of a line or of the text inside it', () => {
    const located = fromC2y(diagnostic({ span: { line: 4, column: 1, end_line: 9, end_column: 1 } }), TEXT, 'composition.yaml');
    expect(located.where).toMatchObject({ kind: 'text', from: TEXT.length, to: TEXT.length });
    const long = fromC2y(diagnostic({ span: { line: 2, column: 1, end_line: 2, end_column: 99 } }), TEXT, 'composition.yaml');
    if (long.where.kind !== 'text') throw new Error('not in the text');
    expect(TEXT.slice(long.where.from, long.where.to)).toBe('composition: shop');
  });

  it('locates a diagnostic without a span at the file, with its path', () => {
    const located = fromC2y(diagnostic({ span: null, path: 'binding.ship' }), TEXT, 'composition.yaml');
    expect(located.where).toEqual({ kind: 'file', file: 'composition.yaml' });
    expect(located.path).toBe('binding.ship');
  });

  it('leaves out an empty path or pointer (the document itself)', () => {
    const located = fromC2y(diagnostic({ path: '', pointer: '' }), TEXT, 'composition.yaml');
    expect(located).not.toHaveProperty('path');
    expect(located).not.toHaveProperty('pointer');
  });
});

describe('ordering, counting and keying', () => {
  const at = (from: number, severity: Located['severity'] = 'error', file = 'composition.yaml'): Located => ({
    code: `c${from}`, message: 'm', severity, where: { kind: 'text', file, from, to: from + 1, line: 1, column: from + 1 },
  });
  const whole: Located = { code: 'whole', message: 'm', severity: 'warning', where: { kind: 'file', file: 'composition.yaml' } };
  const pkg: Located = { code: 'pkg', message: 'm', severity: 'info', where: { kind: 'package' } };

  it('orders by file, then text position, then whole files, then the package; errors first at the same place', () => {
    const sorted = byLocation([pkg, whole, at(9), at(2, 'warning'), at(2, 'error'), at(0, 'error', 'a.yaml')]);
    expect(sorted.map((item) => `${item.code}:${item.severity}`)).toEqual([
      'c0:error', 'c2:error', 'c2:warning', 'c9:error', 'whole:warning', 'pkg:info',
    ]);
  });

  it('counts each severity', () => {
    expect(counts([at(1), at(2, 'warning'), whole, pkg])).toEqual({ error: 1, warning: 2, info: 1, total: 4 });
  });

  it('keys a finding by code, path, line, column and message, so the key holds while the finding does', () => {
    const located = fromC2y(diagnostic(), TEXT, 'composition.yaml');
    expect(locatedKey(located)).toBe('c2y_task_unbound:workflow:3:24:Task ship has no binding entry.');
    expect(locatedKey(fromC2y(diagnostic(), `${TEXT}# trailing\n`, 'composition.yaml'))).toBe(locatedKey(located));
    expect(locatedKey(whole)).toBe('whole:composition.yaml:0:0:m');
  });
});
