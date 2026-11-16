import { afterEach, describe, expect, it } from 'vitest';
import {
  addRecentComposition,
  addRecentOrganization,
  addRecentProblem,
  getRecentCompositions,
  getRecentOrganizations,
  getRecentProblems,
} from './recentItems';

afterEach(() => localStorage.clear());

describe('recent items', () => {
  it('keeps compositions, problems and organizations under OpenBinding keys, newest first, without repeats', () => {
    addRecentComposition({ id: 'c1', name: 'One', orgId: 'o', orgName: 'Org' });
    addRecentComposition({ id: 'c2', name: 'Two', orgId: 'o', orgName: 'Org' });
    addRecentComposition({ id: 'c1', name: 'One', orgId: 'o', orgName: 'Org' });
    addRecentProblem({ id: 'p1', name: 'Problem', orgId: 'o', orgName: 'Org' });
    addRecentOrganization({ id: 'o', name: 'Org', orgId: 'o', orgName: 'Org' });
    expect(getRecentCompositions().map(item => item.id)).toEqual(['c1', 'c2']);
    expect(getRecentProblems().map(item => item.id)).toEqual(['p1']);
    expect(getRecentOrganizations().map(item => item.id)).toEqual(['o']);
    expect(Object.keys(localStorage).sort()).toEqual([
      'openbinding:recentCompositions',
      'openbinding:recentOrganizations',
      'openbinding:recentProblems',
    ]);
  });

  it('reads a damaged list as empty', () => {
    localStorage.setItem('openbinding:recentCompositions', '{not json');
    expect(getRecentCompositions()).toEqual([]);
  });
});
