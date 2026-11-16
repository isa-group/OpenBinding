import { describe, expect, it } from 'vitest';
import { engineRows, refusesRanges, whyNot, type CompatibleMode } from './engines';

describe('ranges in a package', () => {
  const ENGINE = {
    namespace: 'bim.builtin',
    name: 'random-search',
    version: '1.0.0',
    digest: 'sha256-a',
  };
  const REGISTRATION = {
    namespace: 'bim.builtin',
    name: 'deployment',
    version: '1',
    digest: 'sha256-r',
  };
  const mode = (over: Partial<CompatibleMode>): CompatibleMode => ({
    engine: ENGINE,
    registration: REGISTRATION,
    mode: 'seeded',
    compatible: false,
    ...over,
  });

  it('gives the one sentence for a mode the gateway turned down because of ranges', () => {
    const byCode = mode({
      diagnostics: [{ code: 'unsupported_capability_value', message: 'whatever' }],
    });
    const byWords = mode({
      diagnostics: [{ message: 'The package carries an interval the mode does not declare.' }],
    });
    for (const refused of [byCode, byWords]) {
      expect(refusesRanges(refused)).toBe(true);
      expect(whyNot(refused)).toBe(
        'This package has range features; this engine only accepts single values'
      );
    }
    expect(engineRows([byCode])[0]).toMatchObject({
      runnable: false,
      why: 'This package has range features; this engine only accepts single values',
    });
  });

  it('keeps any other reason as the gateway sent it, and never calls a runnable mode a refusal', () => {
    const other = mode({ diagnostics: [{ message: 'It cannot read a RoutingOverlay.' }] });
    expect(refusesRanges(other)).toBe(false);
    expect(whyNot(other)).toBe('It cannot read a RoutingOverlay.');
    expect(
      refusesRanges(
        mode({ compatible: true, diagnostics: [{ code: 'unsupported_capability_value' }] })
      )
    ).toBe(false);
    expect(whyNot(mode({}))).toBe('Its declared capabilities don’t cover this package.');
  });
});

describe('the engines of an analysis', () => {
  const engine = {
    namespace: 'bim.builtin',
    name: 'random-search',
    version: '1.0.0',
    digest: 'sha256-a',
  };
  const registration = {
    namespace: 'bim.builtin',
    name: 'random-search-deployment',
    version: '1',
    digest: 'sha256-r',
  };

  it('gives a row to every mode with the reason it can or cannot run the package', () => {
    const modes: CompatibleMode[] = [
      { engine, registration, mode: 'seeded', compatible: true },
      {
        engine: { ...engine, namespace: 'edge-lab', name: 'edge-solver' },
        registration,
        mode: 'placement',
        compatible: false,
        diagnostics: [{ message: 'No placement.' }, { detail: 'Needs pools.' }],
      },
      { engine, registration, mode: 'exact', compatible: false },
    ];
    const rows = engineRows(modes);
    expect(rows.map(row => [row.name, row.mode, row.runnable, row.registered])).toEqual([
      ['random-search 1.0.0', 'seeded', true, false],
      ['edge-solver 1.0.0', 'placement', false, true],
      ['random-search 1.0.0', 'exact', false, false],
    ]);
    expect(rows[0].why).toBe('Runs through bim.builtin/random-search-deployment@1.');
    expect(rows[1].why).toBe('No placement. Needs pools.');
    expect(rows[2].why).toBe('Its declared capabilities don’t cover this package.');
  });
});
