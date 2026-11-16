// Pattern only, after SPHERE frontend/src/modules/settings/components/NotificationsSection.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: OpenBinding's own section (the owner's decision of 2026-11-16): the palette, SPHERE's orange or OpenBinding's blue,
// drawn in SPHERE's settings card; the choice applies at once and is kept in this browser (modules/core/theme/brand.ts).

import { useState } from 'react';
import { FiCheck } from 'react-icons/fi';
import {
  applyBrand,
  BRANDS,
  currentBrand,
  defaultBrand,
  setBrand,
  storedBrand,
  type Brand,
  BRAND_STORAGE_KEY,
} from '../../core/theme/brand';

const PALETTES: Record<Brand, { name: string; description: string }> = {
  sphere: {
    name: 'SPHERE orange',
    description:
      'The orange of SPHERE, the SCORE pricing platform OpenBinding is built on. Buttons, links and highlights turn orange.',
  },
  openbinding: {
    name: 'OpenBinding blue',
    description:
      'OpenBinding’s own blue. Buttons, links and highlights turn blue; everything else stays the same.',
  },
};

/** Forget this browser's choice: the deployment's default applies again. */
function forgetBrand(): Brand {
  try {
    window.localStorage.removeItem(BRAND_STORAGE_KEY);
  } catch {
    // Storage refused: nothing was kept, so there is nothing to forget.
  }
  const brand = defaultBrand();
  applyBrand(brand);
  return brand;
}

export default function AppearanceSection() {
  const [brand, setActive] = useState<Brand>(() => currentBrand());
  const [chosen, setChosen] = useState<boolean>(() => storedBrand() !== null);
  const fallback = defaultBrand();

  const choose = (next: Brand) => {
    setBrand(next);
    setActive(next);
    setChosen(true);
  };

  const useDefault = () => {
    setActive(forgetBrand());
    setChosen(false);
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-medium text-tp-ink">Appearance</h2>
        <p className="mt-0.5 text-sm text-tp-steel">
          Choose the colour palette of OpenBinding. It changes at once and is kept in this browser.
        </p>
      </div>

      <fieldset className="grid gap-4 sm:grid-cols-2">
        <legend className="sr-only">Colour palette</legend>
        {BRANDS.map(id => {
          const selected = brand === id;
          return (
            <label
              key={id}
              className={`relative flex cursor-pointer flex-col gap-3 rounded-[12px] border-2 bg-tp-canvas p-5 transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-tp-primary/40 ${
                selected
                  ? 'border-tp-primary'
                  : 'border-tp-hairline hover:border-tp-hairline-strong'
              }`}
            >
              <input
                type="radio"
                name="brand"
                value={id}
                checked={selected}
                onChange={() => choose(id)}
                className="sr-only"
              />
              <span className="flex items-center justify-between gap-3">
                <span className="text-base font-medium text-tp-ink">{PALETTES[id].name}</span>
                <span
                  aria-hidden="true"
                  className={`flex h-6 w-6 items-center justify-center rounded-full border-2 ${
                    selected
                      ? 'border-tp-primary bg-tp-primary text-tp-on-primary'
                      : 'border-tp-hairline-strong'
                  }`}
                >
                  {selected && <FiCheck className="h-3.5 w-3.5" />}
                </span>
              </span>
              <span className="text-sm text-tp-steel">{PALETTES[id].description}</span>
              <span className="flex flex-wrap gap-2 text-xs text-tp-steel">
                {selected && (
                  <span className="rounded-full bg-tp-primary/10 px-2 py-0.5 font-medium text-tp-accent">
                    In use
                  </span>
                )}
                {fallback === id && (
                  <span className="rounded-full bg-tp-surface px-2 py-0.5 font-medium">
                    Deployment default
                  </span>
                )}
              </span>
            </label>
          );
        })}
      </fieldset>

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-[12px] border border-tp-hairline bg-tp-canvas px-6 py-4">
        <p className="text-sm text-tp-steel">
          This deployment uses <strong className="text-tp-ink">{PALETTES[fallback].name}</strong> by
          default (<code>VITE_DEFAULT_BRAND</code>).{' '}
          {chosen ? 'Your choice here overrides it in this browser.' : 'You are using the default.'}
        </p>
        <button
          type="button"
          onClick={useDefault}
          disabled={!chosen}
          className="cursor-pointer rounded-[8px] border border-tp-hairline-strong bg-tp-canvas px-4 py-2 text-sm font-medium text-tp-ink transition-colors hover:bg-tp-surface disabled:cursor-not-allowed disabled:opacity-40"
        >
          Use the default
        </button>
      </div>
    </div>
  );
}
