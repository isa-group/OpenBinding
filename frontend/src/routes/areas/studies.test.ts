import { matchRoutes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { routeDefinitions, routesByArea } from '../registry';

// One pair per line: screenBudget.test.ts counts them.
const PROTOTYPE: Array<[string, string]> = [
  ['study-list', '/app/:org/studies'],
  ['study-builder', '/app/:org/studies/new'],
  ['study-detail', '/app/:org/studies/:study/:tab?'],
];

const config = routeDefinitions.map(definition => ({ id: definition.id, path: definition.path }));
const resolve = (path: string) => matchRoutes(config, path)?.at(-1)?.route.id ?? null;

describe('area studies', () => {
  it('has 3 screens: the study page replaces the run, cell and analytics screens, and nothing is about reports', () => {
    expect(routesByArea.studies).toHaveLength(3);
    expect(routesByArea.studies.map(definition => [definition.id, definition.path])).toEqual(
      PROTOTYPE
    );
  });

  it('reads /studies/new as the builder and any other address below /studies as a study with an optional tab', () => {
    expect(resolve('/app/acme/studies/new')).toBe('study-builder');
    expect(resolve('/app/acme/studies/engines-vs-seeds')).toBe('study-detail');
    expect(resolve('/app/acme/studies/engines-vs-seeds/progress')).toBe('study-detail');
    expect(resolve('/app/acme/studies/engines-vs-seeds/results')).toBe('study-detail');
  });

  describe('address resolution', () => {
    it.each([
      ['/app/acme/studies', 'study-list'],
      ['/app/acme/studies/new', 'study-builder'],
      ['/app/acme/studies/s1', 'study-detail'],
      ['/app/acme/studies/s1/setup', 'study-detail'],
      ['/app/acme/studies/s1/publish', 'study-detail'],
      ['/app/acme/studies/s1/runs/r1', null],
      ['/app/acme/studies/s1/runs/r1/cells/c1', null],
      ['/app/acme/studies/s1/runs/r1/analytics', null],
      // Studies left the project (F0b B7): a project address has no studies below it.
      ['/app/acme/atlas/studies', null],
      ['/app/acme/atlas/studies/new', null],
    ])('%s -> %s', (path, id) => {
      expect(resolve(path)).toBe(id);
    });
  });
});
