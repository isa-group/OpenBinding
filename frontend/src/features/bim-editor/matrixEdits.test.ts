import { describe, expect, it } from 'vitest';
import type { BimDiagnostic } from '../../api/bim';
import { fromBimAll } from '../../shared/diagnostics/bim';
import refusedPackage from '../../test/fixtures/core/refused.package.json';
import refusedValidate from '../../test/fixtures/core/refused.validate.json';
import { DEFAULT_FILES, pretty, type WorkspaceFiles } from './documents';
import {
  cellFindings,
  isPending,
  parsedDocuments,
  sameValue,
  sourceValue,
  writeAtOrigin,
} from './matrixEdits';

const ORIGIN = { path: 'candidates.json', pointer: '/spec/candidates/service-a/features/latency' };
const catalog = (files: Record<string, string>) => JSON.parse(files['candidates.json']);

describe('writeAtOrigin', () => {
  it('writes a number in place of the number at the origin, and leaves the rest of the text as it was', () => {
    const files: WorkspaceFiles = {
      ...DEFAULT_FILES,
      'candidates.json': DEFAULT_FILES['candidates.json'].replace(
        '"latency": 10',
        '"latency":   10'
      ),
    };
    const next = writeAtOrigin(files, ORIGIN, 900)!;
    expect(next['candidates.json']).toBe(
      files['candidates.json'].replace('"latency":   10', '"latency":   900')
    );
    expect(next['instance.json']).toBe(files['instance.json']);
    expect(files['candidates.json']).toContain('"latency":   10');
  });

  it('writes a range, an open range and a range still being typed at the origin', () => {
    const range = writeAtOrigin(DEFAULT_FILES, ORIGIN, { min: 5, max: 20 })!;
    expect(catalog(range).spec.candidates['service-a'].features.latency).toEqual({
      min: 5,
      max: 20,
    });
    expect(range['candidates.json']).toBe(pretty(catalog(range)));

    const open = writeAtOrigin(range, ORIGIN, { min: 5, max: null })!;
    expect(catalog(open).spec.candidates['service-a'].features.latency).toEqual({
      min: 5,
      max: null,
    });

    const typing = writeAtOrigin(open, ORIGIN, { min: 5 })!;
    expect(catalog(typing).spec.candidates['service-a'].features.latency).toEqual({ min: 5 });

    const back = writeAtOrigin(typing, ORIGIN, 12)!;
    expect(catalog(back).spec.candidates['service-a'].features.latency).toBe(12);
  });

  it('removes the value for null, and writes it again where it was removed', () => {
    const removed = writeAtOrigin(DEFAULT_FILES, ORIGIN, null)!;
    expect(catalog(removed).spec.candidates['service-a'].features).toEqual({});
    expect(writeAtOrigin(removed, ORIGIN, null)).toBe(removed);
    expect(
      catalog(writeAtOrigin(removed, ORIGIN, 30)!).spec.candidates['service-a'].features
    ).toEqual({ latency: 30 });
  });

  it('writes nothing where the file is missing or broken, or the candidate is gone', () => {
    expect(writeAtOrigin(DEFAULT_FILES, { ...ORIGIN, path: 'other.json' }, 1)).toBeNull();
    expect(
      writeAtOrigin({ ...DEFAULT_FILES, 'candidates.json': '{"spec": ' }, ORIGIN, 1)
    ).toBeNull();
    expect(
      writeAtOrigin(
        DEFAULT_FILES,
        { ...ORIGIN, pointer: '/spec/candidates/service-b/features/latency' },
        1
      )
    ).toBeNull();
    expect(writeAtOrigin(DEFAULT_FILES, { ...ORIGIN, pointer: '' }, 1)).toBeNull();
  });

  it('follows an escaped member name of the pointer', () => {
    const files = {
      'c.json': pretty({ spec: { candidates: { 'eu/a~b': { features: { latency: 1 } } } } }),
    };
    const next = writeAtOrigin(
      files,
      { path: 'c.json', pointer: '/spec/candidates/eu~1a~0b/features/latency' },
      2
    )!;
    expect(JSON.parse(next['c.json']).spec.candidates['eu/a~b'].features.latency).toBe(2);
  });
});

describe('sourceValue and isPending', () => {
  it('reads what the source writes at the origin', () => {
    expect(sourceValue(parsedDocuments(DEFAULT_FILES), ORIGIN)).toEqual({
      kind: 'value',
      value: 10,
    });
    expect(
      sourceValue(parsedDocuments(writeAtOrigin(DEFAULT_FILES, ORIGIN, null)!), ORIGIN)
    ).toEqual({ kind: 'absent' });
    expect(
      sourceValue(parsedDocuments({ ...DEFAULT_FILES, 'candidates.json': '{' }), ORIGIN)
    ).toEqual({ kind: 'unreadable' });
    expect(
      sourceValue(parsedDocuments(DEFAULT_FILES), { ...ORIGIN, pointer: '/metadata/name' })
    ).toEqual({ kind: 'other' });
  });

  it('is pending while the source and the last check disagree, and not once they agree again', () => {
    const value = (files: Record<string, string>) => sourceValue(parsedDocuments(files), ORIGIN);
    expect(isPending(10, value(DEFAULT_FILES))).toBe(false);
    expect(isPending(10, value(writeAtOrigin(DEFAULT_FILES, ORIGIN, 900)!))).toBe(true);
    expect(isPending(900, value(writeAtOrigin(DEFAULT_FILES, ORIGIN, 900)!))).toBe(false);
    expect(
      isPending(
        { min: 5, max: null },
        value(writeAtOrigin(DEFAULT_FILES, ORIGIN, { min: 5, max: null })!)
      )
    ).toBe(false);
    expect(
      isPending({ min: 5, max: null }, value(writeAtOrigin(DEFAULT_FILES, ORIGIN, { min: 5 })!))
    ).toBe(true);
    expect(isPending(10, value(writeAtOrigin(DEFAULT_FILES, ORIGIN, null)!))).toBe(true);
    expect(isPending(10, value({ ...DEFAULT_FILES, 'candidates.json': '{' }))).toBe(false);
    expect(sameValue(null, { kind: 'absent' })).toBe(true);
    expect(sameValue(10, { kind: 'value', value: { min: 10, max: 10 } })).toBe(false);
  });
});

describe('cellFindings', () => {
  it('keeps the findings of a check about the value at the origin, from the real refusal of a package', () => {
    const files = refusedPackage as Record<string, string>;
    const located = fromBimAll(refusedValidate.diagnostics as BimDiagnostic[], files);
    const origin = {
      path: 'candidates.json',
      pointer: '/spec/candidates/auth-edge/features/latency',
    };

    const found = cellFindings(located, origin);
    expect(found.map(finding => finding.code)).toEqual(['feature_value_domain']);
    expect(
      cellFindings(located, { ...origin, pointer: '/spec/candidates/auth-edge/features/cost' })
    ).toEqual([]);
    expect(cellFindings(located, { ...origin, path: 'application.json' })).toEqual([]);
  });

  it('keeps a finding about an end of a range, and not one about a sibling whose name starts the same', () => {
    const at = (pointer: string) => ({
      code: 'c',
      message: 'm',
      severity: 'error' as const,
      where: { kind: 'file' as const, file: 'candidates.json' },
      pointer,
    });
    expect(
      cellFindings([at(`${ORIGIN.pointer}/min`), at(`${ORIGIN.pointer}2`)], ORIGIN).map(
        finding => finding.pointer
      )
    ).toEqual([`${ORIGIN.pointer}/min`]);
  });
});
