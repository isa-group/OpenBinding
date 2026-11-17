import { describe, expect, it } from 'vitest';
import {
  isProblemTabSegment,
  PROBLEMS_SEGMENT,
  problemPath,
  problemsPath,
  problemEditorPath,
} from './problems';

describe('the address builders of the problems area', () => {
  it('names the tab segments of the problem page', () => {
    for (const segment of ['candidates', 'versions', 'runs', 'compositions', 'source', 'settings'])
      expect(isProblemTabSegment(segment), segment).toBe(true);
    for (const segment of ['overview', 'history', 'compare', ''])
      expect(isProblemTabSegment(segment), segment).toBe(false);
  });

  it('builds the list, the problem, its tab and the version or pair it shows', () => {
    expect(problemsPath('acme')).toBe('/orgs/acme/problems');
    expect(problemsPath('acme', { origin: 'editor', composition: 'fleet routing' })).toBe(
      '/orgs/acme/problems?origin=editor&composition=fleet+routing'
    );
    expect(
      problemPath('acme', 'routing', 'candidates', {
        version: 1,
        composition: 'fleet',
        compositionVersion: '1.2.0',
      })
    ).toBe(
      '/problems/acme/routing/candidates?version=1&composition=fleet&compositionVersion=1.2.0'
    );
    expect(problemPath('acme', 'routing')).toBe('/problems/acme/routing');
    expect(problemPath('acme', 'routing', 'source', { version: 2 })).toBe(
      '/problems/acme/routing/source?version=2'
    );
    expect(problemPath('acme', 'routing', 'versions', { from: 1, to: 3 })).toBe(
      '/problems/acme/routing/versions?from=1&to=3'
    );
    expect(problemPath('acme', 'routing', undefined, { version: '' })).toBe(
      '/problems/acme/routing'
    );
    expect(problemPath('acme', 'a b/c', undefined, { version: 'sha256-x' })).toBe(
      '/problems/acme/a%20b%2Fc?version=sha256-x'
    );
  });

  it('builds the standalone problem editor, what it opens and what it highlights', () => {
    expect(problemEditorPath(null)).toBe('/problem-editor');
    expect(problemEditorPath('acme')).toBe('/problem-editor?org=acme');
    expect(problemEditorPath('acme', { problem: 'routing', revision: 2 })).toBe(
      '/problem-editor?org=acme&problem=routing&revision=2'
    );
    expect(problemEditorPath(null, { template: 'demo/01_simple_seq' })).toBe(
      '/problem-editor?template=demo%2F01_simple_seq'
    );
    expect(
      problemEditorPath('acme', {
        problem: 'routing',
        revision: 2,
        composition: 'checkout',
        compositionVersion: '1.1.0',
      })
    ).toBe(
      '/problem-editor?org=acme&problem=routing&revision=2&composition=checkout&compositionVersion=1.1.0'
    );
  });

  it('names the segment once', () => {
    expect(PROBLEMS_SEGMENT).toBe('problems');
  });
});
