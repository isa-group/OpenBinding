import { describe, expect, it } from 'vitest';
import { followMoved } from './followMoved';
import { moved } from './moved';

const screens = [
  { id: 'home', path: '/app' },
  { id: 'org', path: '/app/:org' },
  { id: 'project', path: '/app/:org/:project' },
  { id: 'files', path: '/app/:org/:project/files' },
];

describe('followMoved', () => {
  it('leaves an address that no entry moves', () => {
    expect(followMoved('/app/acme/atlas?x=1#top', screens, [moved('m', '/app/:org/:project/old', '/app/:org')])).toBe('/app/acme/atlas?x=1#top');
  });

  it('follows one entry, carrying the params, the query and the hash', () => {
    const table = [moved('m', '/app/:org/:project/old', '/app/:org')];
    expect(followMoved('/app/acme/atlas/old?x=1#top', screens, table)).toBe('/app/acme?x=1#top');
  });

  it('follows a chain of entries', () => {
    const table = [moved('a', '/old-a', '/old-b'), moved('b', '/old-b', '/app')];
    expect(followMoved('/old-a', screens, table)).toBe('/app');
  });

  it('lets a screen win a tie of rank over an entry', () => {
    expect(followMoved('/app/acme/atlas/files', screens, [moved('m', '/app/:org/:project/files', '/app')])).toBe('/app/acme/atlas/files');
  });

  it('refuses a circle', () => {
    expect(() => followMoved('/a', screens, [moved('a', '/a', '/b'), moved('b', '/b', '/a')])).toThrow(/circle/);
  });
});
