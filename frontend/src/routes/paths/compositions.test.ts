import { describe, expect, it } from 'vitest';
import {
  COMPOSITION_TAB_SEGMENTS,
  COMPOSITIONS_SEGMENT,
  compositionPath,
  compositionsPath,
  isCompositionTabSegment,
  myCompositionsPath,
  publicCompositionsPath,
  newCompositionPath,
  permalinkPath,
  editorPath,
} from './compositions';

describe('the address builders of the compositions area', () => {
  it('names the segment once', () => {
    expect(COMPOSITIONS_SEGMENT).toBe('compositions');
  });

  it('has the Analytics, Configuration, Versions, Operation and Settings tabs: Overview is the composition page itself', () => {
    expect(COMPOSITION_TAB_SEGMENTS).toEqual([
      'analytics',
      'configuration',
      'versions',
      'operation',
      'settings',
    ]);
    for (const segment of ['analytics', 'configuration', 'versions', 'operation', 'settings'])
      expect(isCompositionTabSegment(segment), segment).toBe(true);
    for (const segment of ['overview', 'operations', 'editor', ''])
      expect(isCompositionTabSegment(segment), segment).toBe(false);
  });

  it("builds an organization's Compositions tab with its filters, leaving out the empty ones", () => {
    expect(compositionsPath('acme')).toBe('/orgs/acme/compositions');
    expect(compositionsPath('acme', { kind: 'workflow' })).toBe(
      '/orgs/acme/compositions?kinds=workflow'
    );
    expect(compositionsPath('acme', { kind: 'system', archived: true, q: ' desk ' })).toBe(
      '/orgs/acme/compositions?kinds=system&archived=true&q=desk'
    );
    expect(compositionsPath('acme', { archived: false, q: '  ' })).toBe('/orgs/acme/compositions');
  });

  it('builds a composition on its card page, the version it shows and the pair and view of its versions', () => {
    expect(compositionPath('acme', 'order-desk')).toBe('/compositions/acme/order-desk');
    expect(compositionPath('acme', 'order-desk', undefined, { version: '1.2.0' })).toBe(
      '/compositions/acme/order-desk?version=1.2.0'
    );
    expect(compositionPath('acme', 'order-desk', 'versions', { from: 1, to: 3 })).toBe(
      '/compositions/acme/order-desk/versions?from=1&to=3'
    );
    expect(compositionPath('acme', 'a b/c', undefined, { version: '' })).toBe(
      '/compositions/acme/a%20b%2Fc'
    );
    expect(compositionPath('acme', 'order-desk', 'versions', { version: '1.2.0' })).toBe(
      '/compositions/acme/order-desk/versions?version=1.2.0'
    );
  });

  it('opens the standalone editor on a version, in a mode, or on nothing in an organization', () => {
    expect(editorPath()).toBe('/editor');
    expect(
      editorPath({ source: { org: 'acme', slug: 'order-desk' }, version: '1.2.0', mode: 'visual' })
    ).toBe('/editor?source=acme%2Forder-desk&version=1.2.0&mode=visual');
    expect(editorPath({ org: 'acme' })).toBe('/editor?org=acme');
  });

  it('builds the creation page and the permanent link', () => {
    expect(newCompositionPath()).toBe('/compositions/new');
    expect(newCompositionPath('acme')).toBe('/compositions/new?org=acme');
    expect(permalinkPath('c-1')).toBe('/p/c-1');
    expect(permalinkPath('c-1', '1.2.0')).toBe('/p/c-1?version=1.2.0');
  });

  it("builds the public list and the account's", () => {
    expect(publicCompositionsPath()).toBe('/compositions');
    expect(publicCompositionsPath({ kind: 'workflow', q: ' fleet ', page: 2 })).toBe(
      '/compositions?q=fleet&kinds=workflow&page=2'
    );
    expect(publicCompositionsPath({ q: '  ', page: 1 })).toBe('/compositions');
    expect(myCompositionsPath()).toBe('/me/compositions');
  });
});
