import { describe, expect, it } from 'vitest';
import type { BimDiagnostic } from '../../api/bim';
import files from '../../test/fixtures/core/refused.package.json';
import refused from '../../test/fixtures/core/refused.validate.json';
import { fromBim, fromBimAll, resourcePaths } from './bim';
import { byLocation } from './located';

// On the gateway's own refusal of a package (dump_frontend_fixtures.py): every finding lands where the compiler meant it.
const texts = files as Record<string, string>;
const diagnostics = refused.diagnostics as BimDiagnostic[];
const of = (code: string) => diagnostics.filter((item) => item.code === code);
const textAt = (located: ReturnType<typeof fromBim>) => {
  if (located.where.kind !== 'text') throw new Error(`${located.code} is not on a text range: ${located.where.kind}`);
  return texts[located.where.file].slice(located.where.from, located.where.to);
};

describe('fromBim on the refused package', () => {
  it('reads the resource ids the Instance declares', () => {
    expect(resourcePaths(texts)).toMatchObject({ application: 'application.json', workflow: 'workflow.bpmn', placement: 'placement.json', catalog: 'candidates.json' });
  });

  it('places an out-of-domain value on the value, with its line and column', () => {
    const located = fromBim(of('feature_value_domain')[0], texts);
    expect(located).toMatchObject({
      code: 'feature_value_domain', severity: 'error', pointer: '/spec/candidates/auth-edge/features/latency', path: '/spec/candidates/auth-edge/features/latency',
      where: { kind: 'text', file: 'candidates.json' },
    });
    expect(textAt(located)).toBe('900');
    const where = located.where as Extract<typeof located.where, { kind: 'text' }>;
    const before = texts['candidates.json'].slice(0, where.from).split('\n');
    expect(where.line).toBe(before.length);
    expect(where.column).toBe(before[before.length - 1].length + 1);
  });

  it('places a bad expression on the span the compiler named inside the expression', () => {
    const [diagnostic] = of('expression');
    const located = fromBim(diagnostic, texts);
    const expression = 'features.latency <= ';
    expect(texts['constraints.json']).toContain(JSON.stringify(expression));
    expect(textAt(located)).toBe(expression.slice(diagnostic.span!.start, diagnostic.span!.end));
  });

  it('shows a BPMN element in the diagram, and a finding about the whole process at its file', () => {
    expect(fromBim(of('bpmn_task_ref')[0], texts).where).toEqual({ kind: 'bpmn', file: 'workflow.bpmn', element: 'orphan' });
    expect(fromBim(of('bpmn_unreachable')[0], texts).where).toEqual({ kind: 'file', file: 'workflow.bpmn' });
  });

  it('places a finding that names its resource by id in the file the Instance declares for it', () => {
    const [first] = of('placement_capacity_dimension');
    expect(first.resource).toBe('placement');
    const located = fromBim(first, texts);
    expect(located.where).toMatchObject({ kind: 'text', file: 'placement.json' });
    expect(Object.keys(JSON.parse(textAt(located)))).toEqual(['edge', 'fog', 'cloud']);
  });

  it('places pointers through and into arrays', () => {
    expect(JSON.parse(textAt(fromBim(of('placement_event_pool')[0], texts)))).toEqual({ resource: 'placement', id: 'nowhere' });
    expect(JSON.parse(textAt(fromBim(of('placement_capacity_rule')[0], texts)))).toEqual(['cpu', 'gpu']);
  });

  it('locates every finding of the body, and the panel orders them by file', () => {
    const located = fromBimAll(diagnostics, texts);
    expect(located).toHaveLength(diagnostics.length);
    expect(located.every((item) => item.where.kind !== 'package')).toBe(true);
    const files = byLocation(located).map((item) => (item.where.kind === 'package' ? 'Package' : item.where.file));
    expect([...new Set(files)]).toEqual(['candidates.json', 'constraints.json', 'placement.json', 'workflow.bpmn']);
  });
});

describe('fromBim', () => {
  it('gives the package a finding whose resource is not a file of the package, a registered resource or none', () => {
    // The shape the compiler answers for an Instance that names a file the package lacks.
    const missing: BimDiagnostic = { code: 'resource_missing', message: 'resource is not valid UTF-8 JSON: missing.json', resource: 'missing.json', pointer: '/' };
    expect(fromBim(missing, texts)).toMatchObject({ where: { kind: 'package' }, path: 'missing.json /' });
    expect(fromBim({ code: 'registry', message: 'not found', resource: 'acme/catalog@1.0.0' }, texts).where).toEqual({ kind: 'package' });
    expect(fromBim({ code: 'archive', message: 'unreadable' }, texts)).toMatchObject({ where: { kind: 'package' } });
  });

  it('keeps related locations as notes about the same finding, and lists them after it', () => {
    // The shape the compiler answers for a BPMN id written twice (it cannot share a body with the semantic findings above).
    const duplicate: BimDiagnostic = {
      code: 'resource_missing', message: 'duplicate id audit', resource: 'workflow.bpmn', pointer: '/process/audit', bpmnElement: 'audit',
      related: [{ resource: 'workflow.bpmn', pointer: '/process/audit', bpmnElement: 'audit' }, { resource: 'instance.json', pointer: '/spec/resources/application/workflow' }],
    };
    const located = fromBim(duplicate, texts);
    expect(located.related).toHaveLength(2);
    expect(located.related?.[0]).toMatchObject({ severity: 'info', message: 'Related to: duplicate id audit', where: { kind: 'bpmn', element: 'audit' } });
    expect(located.related?.[1].where).toMatchObject({ kind: 'text', file: 'instance.json' });
    expect(fromBimAll([duplicate], texts).map((item) => item.severity)).toEqual(['error', 'info', 'info']);
  });

  it('takes the gateway’s severity, else the fallback, and places a malformed JSON offset', () => {
    const text = { 'instance.json': texts['instance.json'], 'broken.json': '{"a": 1,, }' };
    const located = fromBim({ code: 'json', message: 'Expecting value', resource: 'broken.json', span: { offset: 8 } }, text, { fallback: 'warning' });
    expect(located).toMatchObject({ severity: 'warning', where: { kind: 'text', file: 'broken.json', from: 8, to: 9, line: 1, column: 9 } });
    expect(fromBim({ code: 'x', message: 'y', severity: 'info' }, text).severity).toBe('info');
  });

  it('places a pointer the document stops short of on the deepest value it reaches', () => {
    const located = fromBim({ code: 'placement_candidate_ref', message: 'unknown candidate ref', resource: 'placement.json', pointer: '/spec/groups/edge-runtime/candidate' }, texts);
    expect(Object.keys(JSON.parse(textAt(located)))).toContain('candidates');
  });
});
