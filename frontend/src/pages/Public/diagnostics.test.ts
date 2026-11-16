import { describe, expect, it } from 'vitest';
import { groupDiagnostics, pointerInWords, readDiagnostics } from './diagnostics';
import type { PackageFile } from './packageModel';

const files: PackageFile[] = [
  { path: 'candidates.json', bytes: 100, role: 'candidateCatalog', logicalId: 'catalog', kind: 'CandidateCatalog' },
  { path: 'workflow.bpmn', bytes: 100, role: 'application', logicalId: 'workflow', kind: 'BPMN' },
  { path: 'notes.json', bytes: 10, role: null, logicalId: null, kind: null },
];

describe('diagnostics in plain language', () => {
  it('words a JSON Pointer the way a person would say it', () => {
    expect(pointerInWords('/spec/providers/3/metrics/latency')).toBe('providers › item 4 › metrics › latency');
    expect(pointerInWords('/spec')).toBe('spec');
    expect(pointerInWords('/spec/a~1b/c~0d')).toBe('a/b › c~d');
    expect(pointerInWords('')).toBe('');
  });

  it('places a problem in its file by path, by logical id or by role, and keeps the location to copy', () => {
    const [byRole, byPath, wholePackage] = readDiagnostics([
      { code: 'missing_metric', message: 'Candidate 4 does not declare latency.', resource: 'candidateCatalog', pointer: '/spec/candidates/3/features/latency', fix: 'Add a finite value in ms.' },
      { message: 'Unsupported gateway.', path: 'workflow.bpmn', bpmnElement: 'Gateway_2' },
      { message: 'The package selects an unknown profile.' },
    ], files);

    expect(byRole).toMatchObject({
      code: 'missing_metric',
      file: 'candidates.json',
      fileLabel: 'Candidate catalog · candidates.json',
      where: 'candidates › item 4 › features › latency',
      location: '/spec/candidates/3/features/latency',
      fix: 'Add a finite value in ms.',
    });
    expect(byPath).toMatchObject({ file: 'workflow.bpmn', fileLabel: 'Application · workflow.bpmn', where: 'BPMN element “Gateway_2”', location: 'Gateway_2', fix: null });
    expect(wholePackage).toMatchObject({ file: null, fileLabel: 'Package', where: 'Whole file', location: null, code: null });
  });

  it('keeps what the gateway named when it matches no file of the package', () => {
    const [unknown] = readDiagnostics([{ message: 'Missing resource.', resource: 'ghost.json' }], files);
    expect(unknown).toMatchObject({ file: null, fileLabel: 'ghost.json' });
  });

  it('groups problems by file, package-wide problems first', () => {
    const items = readDiagnostics([
      { message: 'a', resource: 'candidateCatalog', pointer: '/spec/x' },
      { message: 'b' },
      { message: 'c', path: 'candidates.json', pointer: '/spec/y' },
    ], files);
    const groups = groupDiagnostics(items);
    expect(groups.map((group) => [group.file, group.label, group.items.map((item) => item.message)])).toEqual([
      ['', 'Package', ['b']],
      ['candidates.json', 'Candidate catalog · candidates.json', ['a', 'c']],
    ]);
  });
});
