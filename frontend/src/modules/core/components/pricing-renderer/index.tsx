// Adapted from SPHERE frontend/src/modules/core/components/pricing-renderer/index.tsx (feat/pricing-renderer, revision
// 694f292b03), https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: the package's stylesheet is imported here, so only the screens that draw a pricing load it; the source helpers are
// imported from `./source` rather than re-exported (a component module exports components only, for fast refresh); the theme
// note speaks of OpenBinding, which is light only; `String` is registered as the one expression function beyond the package's own,
// as the gateway's normaliser evaluates it (SPHERE pricings write prices such as `#priceByTier[String(#tier)]`).

import { forwardRef } from 'react';
import type { ExpressionOptions } from 'pricing-renderer';
import {
  PricingRenderer,
  type PricingRendererElement,
  type PricingRendererProps,
  type PricingRendererStyle,
} from 'pricing-renderer/react';
import 'pricing-renderer/styles.css';

import { SPHERE_PRICING_TOKENS } from './tokens';
import type { SpherePricingSource } from './source';

export type { SpherePricingSource } from './source';

/**
 * The expression functions a price may call: `String`, the one the Pricing2Yaml documents in SPHERE use beyond the package's own
 * operators, and the one the gateway's normaliser allows. One object for the module, so the element never sees a new option.
 */
const EXPRESSION_OPTIONS: ExpressionOptions = {
  functions: { String: (value: unknown) => String(value) },
};

/** Everything the package accepts except the source, which `source` carries instead. */
type RendererOverrides = Omit<
  PricingRendererProps,
  'pricing' | 'yaml' | 'src' | 'request' | 'loadPricing' | 'style'
>;

/**
 * OpenBinding shows pricings in two quite different situations, and they want opposite defaults.
 *
 * - `catalog` is the plan a composition's candidate comes from (the PricingCard of the composition renderer): a document
 *   someone is studying. Diagnostics belong on the page, private plans must be visible or the model is misrepresented, the
 *   technical metadata is the point, and there is nothing to buy.
 * - `commercial` is OpenBinding's own pricing page at `/pricing`: a storefront, where a warning about a `.inf` usage limit is
 *   the reader's problem to not have.
 */
export type SpherePricingPreset = 'catalog' | 'commercial';

const PRESETS: Record<SpherePricingPreset, RendererOverrides> = {
  catalog: {
    diagnostics: 'verbose',
    visibility: 'all',
    mode: 'catalog',
    ctaEnabled: false,
  },
  commercial: {
    diagnostics: 'auto',
    visibility: 'public-only',
    mode: 'commercial',
    ctaEnabled: true,
  },
};

export interface SpherePricingRendererProps extends RendererOverrides {
  /** Exactly one of a YAML document or a parsed pricing. Build it with `pricingRendererSource`. */
  source: SpherePricingSource;
  /** Which situation this is. Defaults to `catalog`. */
  preset?: SpherePricingPreset;
  /** Extra CSS custom properties or styles, merged over the tokens. */
  style?: PricingRendererStyle;
  /** Wrapper class, for layout only. */
  className?: string;
}

/**
 * A pricing drawn by `pricing-renderer`, in the platform's tokens.
 *
 * `theme` is pinned to `"light"`: OpenBinding is light only, and under `"auto"` the renderer would follow the operating
 * system's dark preference inside a light page.
 */
export const SpherePricingRenderer = forwardRef<PricingRendererElement, SpherePricingRendererProps>(
  function SpherePricingRenderer(
    { source, preset = 'catalog', style, className, ...overrides },
    ref
  ) {
    // `source` is already the package's own discriminated union, so this assembles a valid PricingRendererProps; TypeScript
    // cannot see that through a spread of a union, hence the single assertion here rather than a branch that repeats every
    // prop.
    //
    // A fresh object per render is deliberate: the element compares `yaml` and `src` by identity and `pricing`, `request` and
    // `normalizeOptions` by content, so nothing here starts a reload as long as the caller holds its source stable.
    const props = {
      ...source,
      ...PRESETS[preset],
      theme: 'light',
      locale: 'en-US',
      expressionOptions: EXPRESSION_OPTIONS,
      ...overrides,
      style: { ...SPHERE_PRICING_TOKENS, ...style },
    } as PricingRendererProps;

    // The renderer is a CSS container and sizes itself from its own inline width, so it must not be given a fixed width.
    // `min-w-0` keeps it from forcing a flex or grid parent wider than the track, which is what its docs ask of an
    // embedding host.
    return (
      <div className={`w-full min-w-0 ${className ?? ''}`}>
        <PricingRenderer ref={ref} {...props} />
      </div>
    );
  }
);

export default SpherePricingRenderer;
