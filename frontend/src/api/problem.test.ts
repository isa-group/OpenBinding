import { describe, expect, it } from 'vitest';
import { HttpError } from './client';
import { diagnosticLines, diagnosticsByField, diagnosticsByPointer, diagnosticsOf, fieldOf, pointerOf, problemField, readDiagnostics } from './problem';

const DIAGNOSTICS = [
  { code: 'greater_than', message: 'Input should be greater than 0', in: 'body', pointer: '/spec/limits/maxTasks', loc: ['body', 'spec', 'limits', 'maxTasks'], context: { gt: 0 } },
  { code: 'missing', message: 'Field required', in: 'query', parameter: 'limit', loc: ['query', 'limit'] },
  { code: 'string_type', message: 'Input should be a string', loc: ['body', 'features', 0] },
  { code: 'invalid_pricing', message: 'The document is invalid' },
];

describe('reading the diagnostics of a 422', () => {
  it('keeps what a screen needs and drops what is not a diagnostic', () => {
    expect(readDiagnostics([...DIAGNOSTICS, 'x', null, { foo: 1 }])).toEqual(DIAGNOSTICS);
    expect(readDiagnostics(undefined)).toEqual([]);
    expect(readDiagnostics({ message: 'not a list' })).toEqual([]);
  });

  it('completes a finding that has only a code or only a message', () => {
    expect(readDiagnostics([{ code: 'json_invalid' }, { message: 'Expecting a value' }])).toEqual([
      { code: 'json_invalid', message: 'json_invalid' },
      { code: 'validation_error', message: 'Expecting a value' },
    ]);
  });

  it('gives a finding without a code the code of its problem', () => {
    expect(readDiagnostics([{ message: 'open interval' }, { code: 'schema', message: 'bad' }], 'engine_mode_incompatible')).toEqual([
      { code: 'engine_mode_incompatible', message: 'open interval' },
      { code: 'schema', message: 'bad' },
    ]);
    const error = Object.assign(new HttpError(422, 'refused'), { code: 'invalid_instance', diagnostics: [{ message: 'no code' }] });
    expect(diagnosticsOf(error)).toEqual([{ code: 'invalid_instance', message: 'no code' }]);
    const wrapped = Object.assign(new HttpError(422, 'refused'), { problem: { code: 'invalid_pricing', diagnostics: [{ message: 'no code' }] } });
    expect(diagnosticsOf(wrapped)).toEqual([{ code: 'invalid_pricing', message: 'no code' }]);
  });

  it('keeps the compiler and engine-mode fields of a finding', () => {
    const finding = {
      code: 'unsupported_capability_value',
      message: 'mode does not support requested featureValues values',
      resource: 'candidates.json',
      pointer: '/spec/candidates/c1a/features/latency',
      irPath: '/spec/candidates/catalog/candidates/c1a/features/latency',
      span: { line: 3, column: 5 },
      related: [{ resource: 'application.json', pointer: '/spec/features/latency' }],
      bpmnElement: 'Task_1',
      category: 'featureValues',
      unsupported: ['interval'],
      allowed: ['scalar'],
    };
    expect(readDiagnostics([finding])).toEqual([finding]);
    expect(readDiagnostics([{ ...finding, span: 'x', related: 'y', unsupported: [1], allowed: [], bpmnElement: '' }])).toEqual([
      { code: finding.code, message: finding.message, resource: finding.resource, pointer: finding.pointer, irPath: finding.irPath, category: 'featureValues' },
    ]);
  });

  it('names the pointer and the field of each finding', () => {
    const [nested, query, listed, whole] = readDiagnostics(DIAGNOSTICS);
    expect(pointerOf(nested)).toBe('/spec/limits/maxTasks');
    expect(fieldOf(nested)).toBe('maxTasks');
    expect(pointerOf(query)).toBeUndefined();
    expect(fieldOf(query)).toBe('limit');
    expect(pointerOf(listed)).toBe('/features/0');
    expect(pointerOf(whole)).toBeUndefined();
    expect(fieldOf(whole)).toBeUndefined();
  });

  it('unescapes JSON Pointer segments', () => {
    expect(fieldOf({ code: 'x', message: 'm', pointer: '/plans/a~1b' })).toBe('a/b');
    expect(fieldOf({ code: 'x', message: 'm', pointer: '/a~0b' })).toBe('a~b');
  });

  it('paints one message per pointer, the first one winning', () => {
    const byPointer = diagnosticsByPointer([...readDiagnostics(DIAGNOSTICS), { code: 'x', message: 'again', pointer: '/spec/limits/maxTasks' }]);
    expect(byPointer).toEqual({
      '/spec/limits/maxTasks': 'Input should be greater than 0',
      limit: 'Field required',
      '/features/0': 'Input should be a string',
    });
  });

  it('keys a flat form by the field name', () => {
    expect(diagnosticsByField(readDiagnostics(DIAGNOSTICS))).toEqual({ maxTasks: 'Input should be greater than 0', limit: 'Field required', 0: 'Input should be a string' });
  });

  it('lists the findings of a refusal, leaving out the one that only restates its own sentence', () => {
    const restating = Object.assign(new HttpError(422, 'The mode cannot run it.'), { diagnostics: [{ code: 'engine_mode_incompatible', message: 'The mode cannot run it.' }] });
    expect(diagnosticLines(restating)).toEqual([]);
    const specific = Object.assign(new HttpError(422, 'Request validation failed'), {
      diagnostics: [{ code: 'missing', message: 'Field required' }, { code: 'json_invalid' }, { foo: 1 }, { message: 'Request validation failed' }],
    });
    expect(diagnosticLines(specific)).toEqual(['Field required', 'json_invalid']);
    expect(diagnosticLines(specific, 1)).toEqual(['Field required']);
    expect(diagnosticLines(new Error('nothing'))).toEqual([]);
  });

  it('reads the diagnostics from a thrown error and from its problem', () => {
    const error = Object.assign(new HttpError(409, 'refused'), {
      diagnostics: [{ code: 'x', message: 'where' }],
      problem: { code: 'cell_job_mismatch', detail: { code: 'cell_job_mismatch', fields: ['seed'] }, extra: 1 },
    });
    expect(diagnosticsOf(error)).toEqual([{ code: 'x', message: 'where' }]);
    expect(diagnosticsOf(new Error('nope'))).toEqual([]);
    expect(problemField(error, 'fields')).toEqual(['seed']);
    expect(problemField(error, 'extra')).toBe(1);
    expect(problemField(error, 'missing')).toBeUndefined();
    expect(problemField(new Error('x'), 'fields')).toBeUndefined();
  });
});
