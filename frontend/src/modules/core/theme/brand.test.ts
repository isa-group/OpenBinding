import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyBrand,
  BRAND_STORAGE_KEY,
  currentBrand,
  defaultBrand,
  initialBrand,
  setBrand,
  storedBrand,
} from './brand';

afterEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.brand;
  vi.restoreAllMocks();
});

describe('the brand palette', () => {
  it('defaults to SPHERE unless the deployment names another palette', () => {
    expect(defaultBrand({})).toBe('sphere');
    expect(defaultBrand({ VITE_DEFAULT_BRAND: 'openbinding' })).toBe('openbinding');
    expect(defaultBrand({ VITE_DEFAULT_BRAND: ' OpenBinding ' })).toBe('openbinding');
    expect(defaultBrand({ VITE_DEFAULT_BRAND: 'dark' })).toBe('sphere');
  });

  it('applies the palette as data-brand on <html>', () => {
    applyBrand('openbinding');
    expect(document.documentElement.getAttribute('data-brand')).toBe('openbinding');
    expect(currentBrand()).toBe('openbinding');
    applyBrand('sphere');
    expect(document.documentElement.getAttribute('data-brand')).toBe('sphere');
  });

  it('keeps a chosen palette in this browser and prefers it to the default', () => {
    expect(initialBrand()).toBe(defaultBrand());
    setBrand('openbinding');
    expect(localStorage.getItem(BRAND_STORAGE_KEY)).toBe('openbinding');
    expect(document.documentElement.dataset.brand).toBe('openbinding');
    expect(initialBrand()).toBe('openbinding');
  });

  it('ignores a stored value that names no palette', () => {
    localStorage.setItem(BRAND_STORAGE_KEY, 'neon');
    expect(storedBrand()).toBeNull();
  });

  it('still applies the palette when storage refuses access', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    setBrand('openbinding');
    expect(document.documentElement.dataset.brand).toBe('openbinding');
    expect(storedBrand()).toBeNull();
  });
});
