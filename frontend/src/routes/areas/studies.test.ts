import { matchRoutes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { routeDefinitions, routesByArea } from '../registry';

// One pair per line: screenBudget.test.ts counts them.
const PROTOTYPE: Array<[string, string]> = [
  ['study-list', '/app/:org/:project/studies'],
  ['study-builder', '/app/:org/:project/studies/new'],
  ['study-detail', '/app/:org/:project/studies/:study'],
  ['study-run', '/app/:org/:project/studies/:study/runs/:run'],
  ['study-cell', '/app/:org/:project/studies/:study/runs/:run/cells/:cell'],
  ['study-analytics', '/app/:org/:project/studies/:study/runs/:run/analytics'],
];

describe('area studies', () => {
  // [utest->req~frontend-nav-route-areas~1]
  // [utest->req~frontend-retire-reports-screen-count~1]
  it('has 6 screens, with the ids and routes of the prototype, and nothing about reports', () => {
    expect(routesByArea.studies).toHaveLength(6);
    expect(routesByArea.studies.map((definition) => [definition.id, definition.path])).toEqual(PROTOTYPE);
  });

  it('reads /studies/new as the builder and any other address below /studies as a study', () => {
    const config = routeDefinitions.map((definition) => ({ id: definition.id, path: definition.path }));
    const resolve = (path: string) => matchRoutes(config, path)?.at(-1)?.route.id;

    expect(resolve('/app/acme/atlas/studies/new')).toBe('study-builder');
    expect(resolve('/app/acme/atlas/studies/engines-vs-seeds')).toBe('study-detail');
    expect(resolve('/app/acme/atlas/studies/engines-vs-seeds/runs/r1')).toBe('study-run');
    expect(resolve('/app/acme/atlas/studies/engines-vs-seeds/runs/r1/cells/c1')).toBe('study-cell');
    expect(resolve('/app/acme/atlas/studies/engines-vs-seeds/runs/r1/analytics')).toBe('study-analytics');
  });

  describe('address resolution', () => {
    const config = routeDefinitions.map((definition) => ({ id: definition.id, path: definition.path }));

    // [utest->req~frontend-nav-route-areas~1]
    it.each([
      ['/app/acme/atlas/studies', 'study-list'],
      ['/app/acme/atlas/studies/new', 'study-builder'],
      ['/app/acme/atlas/studies/s1', 'study-detail'],
      ['/app/acme/atlas/studies/s1/runs/r1', 'study-run'],
      ['/app/acme/atlas/studies/s1/runs/r1/cells/c1', 'study-cell'],
      ['/app/acme/atlas/studies/s1/runs/r1/analytics', 'study-analytics'],
    ])('%s -> %s', (path, id) => {
      expect(matchRoutes(config, path)?.at(-1)?.route.id ?? null).toBe(id);
    });
  });
});
