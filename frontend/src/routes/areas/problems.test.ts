import { matchRoutes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { routeDefinitions, routesByArea } from '../registry';

// One pair per line: screenBudget.test.ts counts them.
const PROTOTYPE: Array<[string, string]> = [
  ['case-list', '/app/:org/:project/cases'],
  ['case-detail', '/app/:org/:project/cases/:case'],
  ['case-revision', '/app/:org/:project/cases/:case/revisions/:revision'],
  ['case-compare', '/app/:org/:project/cases/:case/compare'],
  ['wb-workbench', '/app/:org/:project/workbench'],
  ['snap-detail', '/app/:org/:project/snapshots/:snapshot'],
];

describe('area problems', () => {
  // [utest->req~frontend-nav-route-areas~1]
  it('has 6 screens, with the ids and routes of the prototype', () => {
    expect(routesByArea.problems).toHaveLength(6);
    expect(routesByArea.problems.map((definition) => [definition.id, definition.path])).toEqual(PROTOTYPE);
  });

  // [utest->req~frontend-retire-composer-screen-not-routed~1]
  // [utest->req~frontend-retire-composer-screen-count~1]
  it('declares no composer screen, and keeps the case screens and the workbench', () => {
    const ids = routeDefinitions.map((definition) => definition.id);
    const paths = routeDefinitions.map((definition) => definition.path);
    expect(ids).not.toContain('case-composer');
    expect(paths.filter((path) => /\/compose(\/|$)/.test(path))).toEqual([]);
    for (const id of ['case-list', 'case-detail', 'case-revision', 'case-compare', 'wb-workbench']) expect(ids, id).toContain(id);
    const config = routeDefinitions.map((definition) => ({ id: definition.id, path: definition.path }));
    expect(matchRoutes(config, '/app/acme/atlas/cases/flujo/compose')).toBeNull();
  });

  // [utest->req~frontend-retire-library-screens-not-routed~1]
  it('keeps the case list, the workbench and the snapshots', () => {
    const ids = routeDefinitions.map((definition) => definition.id);
    for (const id of ['case-list', 'wb-workbench', 'snap-detail']) expect(ids, id).toContain(id);
  });

  it('has the workbench at the address of the prototype', () => {
    expect(routeDefinitions.find((definition) => definition.id === 'wb-workbench')?.path).toBe('/app/:org/:project/workbench');
  });
});
