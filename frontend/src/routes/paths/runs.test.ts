import { describe, expect, it } from 'vitest';
import { RUNS_SEGMENT, launchPath, runPath, runsPath } from './runs';

describe('the addresses of the runs', () => {
  it('lists the runs in the organization’s Runs tab and opens a run on its own page', () => {
    expect(runsPath('acme')).toBe('/orgs/acme/runs');
    expect(runPath('acme', 'r 1')).toBe('/runs/acme/r%201');
  });

  it('opens the launcher on the organization, and on a problem version, an engine or a preset', () => {
    expect(launchPath('acme')).toBe('/runs/new?org=acme');
    expect(launchPath('acme', { problem: 'routing', revision: 2 })).toBe(
      '/runs/new?org=acme&problem=routing&revision=2'
    );
    expect(launchPath('acme', { engine: 'bim.builtin/random-search' })).toBe(
      '/runs/new?org=acme&engine=bim.builtin%2Frandom-search'
    );
    expect(launchPath('acme', { problem: 'routing', revision: 2, preset: 'fast-sampling' })).toBe(
      '/runs/new?org=acme&problem=routing&revision=2&preset=fast-sampling'
    );
    expect(launchPath(null)).toBe('/runs/new');
  });

  it('names the segment once', () => {
    expect(RUNS_SEGMENT).toBe('runs');
  });
});
