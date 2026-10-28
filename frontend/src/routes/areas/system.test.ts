import { describe, expect, it } from 'vitest';
import { routesByArea } from '../registry';

// One pair per line: screenBudget.test.ts counts them.
const PROTOTYPE: Array<[string, string]> = [
  ['sys-states', '/app/system/states'],
];

describe('area system', () => {
  // [utest->req~frontend-nav-route-areas~1]
  it('has 1 screen, with the id and route of the prototype', () => {
    expect(routesByArea.system).toHaveLength(1);
    expect(routesByArea.system.map((definition) => [definition.id, definition.path])).toEqual(PROTOTYPE);
  });
});
