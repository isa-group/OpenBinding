/**
 * The brand palette: SPHERE's orange or OpenBinding's blue, two value sets over the same `--color-tp-*` names
 * (styles/tailwind.css). The palette is chosen with `data-brand` on <html>; the deployment sets the default with
 * `VITE_DEFAULT_BRAND`, and a person's own choice is kept in this browser. Light only: this is the one theming switch.
 */
export const BRANDS = ['sphere', 'openbinding'] as const;
export type Brand = (typeof BRANDS)[number];

export const BRAND_STORAGE_KEY = 'openbinding:brand';

export function isBrand(value: unknown): value is Brand {
  return typeof value === 'string' && (BRANDS as readonly string[]).includes(value);
}

/** The deployment's default: `VITE_DEFAULT_BRAND` when it names a palette, otherwise SPHERE's. */
export function defaultBrand(env: Record<string, unknown> = import.meta.env): Brand {
  const configured =
    typeof env.VITE_DEFAULT_BRAND === 'string' ? env.VITE_DEFAULT_BRAND.trim().toLowerCase() : '';
  return isBrand(configured) ? configured : 'sphere';
}

/** The palette chosen in this browser, if any. Storage can be missing or refuse access (a private window). */
export function storedBrand(): Brand | null {
  try {
    const value = window.localStorage.getItem(BRAND_STORAGE_KEY);
    return isBrand(value) ? value : null;
  } catch {
    return null;
  }
}

export function initialBrand(): Brand {
  return storedBrand() ?? defaultBrand();
}

export function currentBrand(): Brand {
  const value = document.documentElement.dataset.brand;
  return isBrand(value) ? value : defaultBrand();
}

export function applyBrand(brand: Brand): void {
  document.documentElement.dataset.brand = brand;
}

/** Chooses a palette for this browser and applies it at once. */
export function setBrand(brand: Brand): void {
  try {
    window.localStorage.setItem(BRAND_STORAGE_KEY, brand);
  } catch {
    // Not kept, but still applied for this visit.
  }
  applyBrand(brand);
}
