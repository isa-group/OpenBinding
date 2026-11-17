import { describe, expect, it } from 'vitest';
import examples from '../../../../content/composition2yaml-examples.json';
import { planBlockInsertion } from './insert';
import { stripPlaceholders } from './monaco';
import { COMPOSITION2YAML_SNIPPETS } from './templates';
import { resolveSnippetBody } from './types';

/** The document a placement leaves. */
function apply(document: string, placement: ReturnType<typeof planBlockInsertion>): string {
  const lines = document.split('\n');
  const offset = (line: number, column: number) =>
    lines.slice(0, line - 1).reduce((sum, text) => sum + text.length + 1, 0) + column - 1;
  const from = offset(placement.startLineNumber, placement.startColumn);
  const to = offset(placement.endLineNumber, placement.endColumn);
  return document.slice(0, from) + placement.text + document.slice(to);
}

const DOC =
  'syntaxVersion: "1.0"\ncomposition: shop\nversion: 1.0.0\nkind: application\nworkflow: {seq: [a, b]}\nbinding:\n  a: {local: true}\nvalues: {}\n';

describe('the Composition2Yaml templates', () => {
  it('put a binding entry under binding, indented as its siblings', () => {
    const next = apply(DOC, planBlockInsertion(DOC, 'binding', 'b: {candidate: c_b}'));
    expect(next).toContain('binding:\n  a: {local: true}\n  b: {candidate: c_b}\nvalues: {}');
  });

  it('rewrite an empty flow mapping before nesting a value under it', () => {
    const next = apply(
      DOC,
      planBlockInsertion(DOC, 'values', 'cost: {value: 10, unit: EUR/month}')
    );
    expect(next).toContain('values:\n  cost: {value: 10, unit: EUR/month}');
    expect(next).not.toContain('values: {}');
  });

  it('place a missing key where the language orders it: the problem before the workflow', () => {
    const next = apply(
      DOC,
      planBlockInsertion(DOC, 'problem', 'ref: acme/problems/p@1\ncompilation: sha256-x')
    );
    expect(next.indexOf('problem:')).toBeLessThan(next.indexOf('workflow:'));
    expect(next).toContain(
      'problem:\n  ref: acme/problems/p@1\n  compilation: sha256-x\nworkflow:'
    );
  });

  it('offer the starter and every valid example of the reference as whole documents, with unique prefixes', () => {
    const documents = COMPOSITION2YAML_SNIPPETS.filter(snippet => snippet.kind === 'document');
    expect(documents.map(snippet => stripPlaceholders(resolveSnippetBody(snippet)))).toEqual([
      examples.starter,
      ...examples.sections
        .filter(section => section.expect === 'valid')
        .map(section => section.yaml),
    ]);
    const prefixes = COMPOSITION2YAML_SNIPPETS.map(snippet => snippet.prefix);
    expect(new Set(prefixes).size).toBe(prefixes.length);
    for (const block of COMPOSITION2YAML_SNIPPETS.filter(snippet => snippet.kind === 'block'))
      expect(block.section, block.id).toBeDefined();
  });
});
