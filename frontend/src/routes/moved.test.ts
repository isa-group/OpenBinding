import { describe, expect, it } from 'vitest';
import { fillPath, moved } from './moved';

const target = (route: ReturnType<typeof moved>, query: string, params: Record<string, string> = {}) => route.target(new URLSearchParams(query), params);

describe('moved', () => {
  // [utest->req~frontend-nav-redirects~1]
  it('describes the old address by its id and its pattern', () => {
    const route = moved('legacy-x', '/app/:org/:project/files', '/app/:org/:project');
    expect(route.id).toBe('legacy-x');
    expect(route.path).toBe('/app/:org/:project/files');
    expect(route.permanent).toBeUndefined();
    expect(route.keepQuery).toBeUndefined();
  });

  // [utest->req~frontend-nav-redirects~1]
  it('fills the :param segments of the new address from the matched params, encoded', () => {
    const route = moved('legacy-x', '/app/:org/:project/files', '/app/:org/:project');
    expect(target(route, '', { org: 'acme', project: 'atlas' })).toBe('/app/acme/atlas');
    expect(target(route, '', { org: 'a b', project: 'p/q' })).toBe('/app/a%20b/p%2Fq');
    expect(target(moved('m', '/old/:a/:b', '/new/:b/x/:a'), '', { a: '1', b: '2' })).toBe('/new/2/x/1');
    expect(target(moved('m', '/old', '/new'), '')).toBe('/new');
  });

  // [utest->req~frontend-nav-redirects~1]
  it('carries the query string unless keepQuery is false', () => {
    const route = moved('legacy-x', '/old/:id', '/new/:id');
    expect(target(route, 'a=1&b=x%20y', { id: '7' })).toBe('/new/7?a=1&b=x+y');
    expect(target(route, '', { id: '7' })).toBe('/new/7');
    const dropped = moved('legacy-y', '/old/:id', '/new/:id', { keepQuery: false });
    expect(target(dropped, 'a=1', { id: '7' })).toBe('/new/7');
    expect(dropped.keepQuery).toBe(false);
  });

  // [utest->req~frontend-nav-redirects~1]
  it('adds the carried query to a query the new address already has', () => {
    expect(target(moved('m', '/old', '/new?tab=files'), 'a=1')).toBe('/new?tab=files&a=1');
  });

  // [utest->req~frontend-nav-redirects~1]
  it('records the permanent flag', () => {
    expect(moved('m', '/old', '/new', { permanent: true }).permanent).toBe(true);
    expect(moved('m', '/old', '/new', { permanent: false }).permanent).toBe(false);
  });

  // [utest->req~frontend-nav-redirects~1]
  it('lets options.target take over, and then does not check the new address against the old', () => {
    const route = moved('m', '/old/:id', '/never-used/:other', { target: (query, params) => `/custom/${params.id}?q=${query.get('q')}` });
    expect(target(route, 'q=1', { id: '5' })).toBe('/custom/5?q=1');
  });

  // [utest->req~frontend-nav-redirects~1]
  it('refuses a new address with a parameter the old one does not have', () => {
    expect(() => moved('m', '/old/:org', '/new/:project')).toThrow(/:project/);
  });
});

describe('fillPath', () => {
  // [utest->req~frontend-nav-redirects~1]
  it('replaces only whole :param segments', () => {
    expect(fillPath('/a/:x/b/:y', { x: '1', y: '2' })).toBe('/a/1/b/2');
    expect(fillPath('/a/b?t=:x', { x: '1' })).toBe('/a/b?t=:x');
  });
});
