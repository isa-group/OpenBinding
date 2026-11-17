import { describe, expect, it } from 'vitest';
import type { CompositionDiagnosticView } from '../api/types';
import { fromC2y, type Located } from '../diagnostics/located';
import { MARKER_SEVERITY, locatedMarkers, positionAt } from './located-markers';

const TEXT = 'syntaxVersion: "1.0"\ncomposition: shop\nworkflow: {seq: [pick, ship]}\n';

const c2y = (overrides: Partial<CompositionDiagnosticView> = {}): Located =>
  fromC2y(
    {
      code: 'c2y_task_unbound',
      message: 'Task ship has no binding entry.',
      severity: 'error',
      path: 'workflow',
      pointer: '/workflow',
      span: { line: 3, column: 24, end_line: 3, end_column: 28 },
      ...overrides,
    },
    TEXT,
    'composition.yaml'
  );

describe('positionAt', () => {
  it('counts lines and columns from one', () => {
    expect(positionAt(TEXT, 0)).toEqual({ lineNumber: 1, column: 1 });
    expect(positionAt(TEXT, 21)).toEqual({ lineNumber: 2, column: 1 });
    expect(positionAt(TEXT, 62)).toEqual({ lineNumber: 3, column: 24 });
  });

  it('clamps an offset outside the text', () => {
    expect(positionAt('ab', 9)).toEqual({ lineNumber: 1, column: 3 });
    expect(positionAt('ab', -1)).toEqual({ lineNumber: 1, column: 1 });
  });
});

describe('locatedMarkers', () => {
  it('places a finding where the gateway placed it', () => {
    expect(locatedMarkers([c2y()], TEXT, 'composition.yaml', 'Composition2Yaml')).toEqual([
      {
        severity: MARKER_SEVERITY.error,
        message: 'Task ship has no binding entry.',
        code: 'c2y_task_unbound',
        source: 'Composition2Yaml',
        startLineNumber: 3,
        startColumn: 24,
        endLineNumber: 3,
        endColumn: 28,
      },
    ]);
  });

  it('maps warnings and notes to their severities', () => {
    const markers = locatedMarkers(
      [c2y({ severity: 'warning' }), c2y({ severity: 'info' })],
      TEXT,
      'composition.yaml',
      'Composition2Yaml'
    );
    expect(markers.map(marker => marker.severity)).toEqual([
      MARKER_SEVERITY.warning,
      MARKER_SEVERITY.info,
    ]);
  });

  it('widens an empty span so the squiggle shows', () => {
    const [marker] = locatedMarkers(
      [c2y({ span: { line: 2, column: 14, end_line: 2, end_column: 14 } })],
      TEXT,
      'composition.yaml',
      'Composition2Yaml'
    );
    expect(marker).toMatchObject({ startColumn: 14, endColumn: 15, startLineNumber: 2 });
  });

  it('leaves out findings about another file or with no place in the text', () => {
    const elsewhere = { ...c2y(), where: { ...c2y().where, file: 'values.yaml' } } as Located;
    const whole = c2y({ span: null });
    expect(
      locatedMarkers([elsewhere, whole], TEXT, 'composition.yaml', 'Composition2Yaml')
    ).toEqual([]);
  });
});
