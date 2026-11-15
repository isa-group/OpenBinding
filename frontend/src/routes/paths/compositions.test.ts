import { describe, expect, it } from 'vitest';
import {
  COMPOSITION_TAB_SEGMENTS, COMPOSITIONS_SEGMENT, compositionPath, compositionsPath, isCompositionTabSegment, publicCompositionsPath, showcasePath,
} from './compositions';

describe('the address builders of the compositions area', () => {
  it('names the segment once', () => {
    expect(COMPOSITIONS_SEGMENT).toBe('compositions');
  });

  it('has the Editor, Versions and Analysis tabs so far: Overview is the composition page itself', () => {
    expect(COMPOSITION_TAB_SEGMENTS).toEqual(['editor', 'versions', 'analysis', 'settings']);
    for (const segment of ['editor', 'versions', 'analysis', 'settings']) expect(isCompositionTabSegment(segment), segment).toBe(true);
    for (const segment of ['overview', 'operations', '']) expect(isCompositionTabSegment(segment), segment).toBe(false);
  });

  it('builds the list with its filters, leaving out the empty ones', () => {
    expect(compositionsPath('acme')).toBe('/app/acme/compositions');
    expect(compositionsPath('acme', { kind: 'workflow' })).toBe('/app/acme/compositions?kind=workflow');
    expect(compositionsPath('acme', { kind: 'system', archived: true, q: ' desk ' })).toBe('/app/acme/compositions?kind=system&archived=true&q=desk');
    expect(compositionsPath('acme', { archived: false, q: '  ' })).toBe('/app/acme/compositions');
  });

  it('builds a composition, the version it shows and the pair and view of its versions', () => {
    expect(compositionPath('acme', 'order-desk')).toBe('/app/acme/compositions/order-desk');
    expect(compositionPath('acme', 'order-desk', undefined, { version: '1.2.0' })).toBe('/app/acme/compositions/order-desk?version=1.2.0');
    expect(compositionPath('acme', 'order-desk', undefined, { from: 1, to: 3, view: 'compare' })).toBe('/app/acme/compositions/order-desk?from=1&to=3&view=compare');
    expect(compositionPath('acme', 'a b/c', undefined, { version: '' })).toBe('/app/acme/compositions/a%20b%2Fc');
    expect(compositionPath('acme', 'order-desk', 'editor', { version: '1.2.0' })).toBe('/app/acme/compositions/order-desk/editor?version=1.2.0');
    expect(compositionPath('acme', 'order-desk', 'versions', { from: '1.0.0', to: '1.1.0', view: 'file' })).toBe('/app/acme/compositions/order-desk/versions?from=1.0.0&to=1.1.0&view=file');
  });

  it('builds the public page of a composition and the public list', () => {
    expect(showcasePath('lab-other', 'order-desk')).toBe('/c/lab-other/order-desk');
    expect(showcasePath('lab-other', 'order-desk', { version: 2 })).toBe('/c/lab-other/order-desk?version=2');
    expect(publicCompositionsPath()).toBe('/compositions');
  });
});
