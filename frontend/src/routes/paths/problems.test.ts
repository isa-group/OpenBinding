import { describe, expect, it } from 'vitest';
import {
  isProblemTabSegment,
  PROBLEMS_SEGMENT,
  problemPath,
  problemsPath,
  problemEditorPath,
} from './problems';
import { launchPath, runPath, runsPath } from './runs';

describe('the address builders of the problems area', () => {
  it('names the tab segments of the problem page', () => {
    for (const segment of ['candidates', 'versions', 'runs', 'compositions', 'source', 'settings'])
      expect(isProblemTabSegment(segment), segment).toBe(true);
    for (const segment of ['overview', 'history', 'compare', ''])
      expect(isProblemTabSegment(segment), segment).toBe(false);
  });

  it('builds the list, the problem, its tab and the version or pair it shows', () => {
    expect(problemsPath('acme')).toBe('/app/acme/problems');
    expect(problemsPath('acme', { origin: 'editor', composition: 'fleet routing' })).toBe(
      '/app/acme/problems?origin=editor&composition=fleet+routing'
    );
    expect(
      problemPath('acme', 'routing', 'candidates', {
        version: 1,
        composition: 'fleet',
        compositionVersion: '1.2.0',
      })
    ).toBe(
      '/app/acme/problems/routing/candidates?version=1&composition=fleet&compositionVersion=1.2.0'
    );
    expect(problemPath('acme', 'routing')).toBe('/app/acme/problems/routing');
    expect(problemPath('acme', 'routing', 'source', { version: 2 })).toBe(
      '/app/acme/problems/routing/source?version=2'
    );
    expect(problemPath('acme', 'routing', 'versions', { from: 1, to: 3 })).toBe(
      '/app/acme/problems/routing/versions?from=1&to=3'
    );
    expect(problemPath('acme', 'routing', undefined, { version: '' })).toBe(
      '/app/acme/problems/routing'
    );
    expect(problemPath('acme', 'a b/c', undefined, { version: 'sha256-x' })).toBe(
      '/app/acme/problems/a%20b%2Fc?version=sha256-x'
    );
  });

  it('builds the problem editor of the organization, what it opens and what it highlights', () => {
    expect(problemEditorPath('acme')).toBe('/app/acme/problem-editor');
    expect(problemEditorPath('acme', { problem: 'routing', revision: 2 })).toBe(
      '/app/acme/problem-editor?problem=routing&revision=2'
    );
    expect(problemEditorPath('acme', { template: 'demo/01_simple_seq' })).toBe(
      '/app/acme/problem-editor?template=demo%2F01_simple_seq'
    );
    expect(
      problemEditorPath('acme', {
        problem: 'routing',
        revision: 2,
        composition: 'checkout',
        compositionVersion: '1.1.0',
      })
    ).toBe(
      '/app/acme/problem-editor?problem=routing&revision=2&composition=checkout&compositionVersion=1.1.0'
    );
  });

  it('builds the runs of the organization and the launcher of a run of a problem version or with an engine', () => {
    expect(runsPath('acme')).toBe('/app/acme/runs');
    expect(runPath('acme', 'r 1')).toBe('/app/acme/runs/r%201');
    expect(launchPath('acme', { problem: 'routing', revision: 2 })).toBe(
      '/app/acme/runs/new?problem=routing&revision=2'
    );
    expect(launchPath('acme', { engine: 'bim.builtin/random-search' })).toBe(
      '/app/acme/runs/new?engine=bim.builtin%2Frandom-search'
    );
    expect(launchPath('acme', { problem: 'routing', revision: 2, preset: 'fast-sampling' })).toBe(
      '/app/acme/runs/new?problem=routing&revision=2&preset=fast-sampling'
    );
    expect(launchPath('acme')).toBe('/app/acme/runs/new');
  });

  it('names the segment once', () => {
    expect(PROBLEMS_SEGMENT).toBe('problems');
  });
});
