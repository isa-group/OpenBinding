// Adapted from SPHERE frontend/src/modules/core/components/pricing-renderer/tokens.ts (feat/pricing-renderer, revision
// 694f292b03), https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: the accent, the link and the focus ring take `--color-tp-accent`, the primary colour small text may be set in, so
// both of OpenBinding's palettes reach 4.5:1 inside the renderer; the comments follow.

import type { PricingRendererStyle } from 'pricing-renderer/react';

/**
 * The design language of `styles/tailwind.css` expressed as `pricing-renderer`'s public CSS custom properties.
 *
 * Every value points at a token rather than repeating a colour, so the renderer follows the palette chosen with `data-brand`
 * (SPHERE's orange or OpenBinding's blue) and any retuning of it.
 *
 * Theming goes through tokens on purpose. The package's own rules live in `@layer pricing-renderer` and
 * `@layer pricing-renderer.theme`, and an unlayered selector written here would outrank all of them -- it would work today and
 * break on the next release of the package.
 *
 * On the accent: SPHERE's orange `--color-tp-primary` against white is about 3.35:1, below the 4.5:1 that the renderer's
 * small text on an accent fill needs. `--color-tp-accent` is the deeper shade of the same hue each palette defines for exactly
 * that use, so it is the renderer's accent here.
 */
export const SPHERE_PRICING_TOKENS: PricingRendererStyle = {
  // Brand
  '--pr-color-accent': 'var(--color-tp-accent)',
  '--pr-color-on-accent': 'var(--color-tp-on-primary)',
  '--pr-color-link': 'var(--color-tp-link)',
  '--pr-color-focus': 'var(--color-tp-accent)',

  // Surfaces
  '--pr-color-surface': 'var(--color-tp-canvas)',
  '--pr-color-surface-raised': 'var(--color-tp-canvas)',
  '--pr-color-surface-subtle': 'var(--color-tp-surface)',

  // Text
  '--pr-color-text': 'var(--color-tp-ink)',
  '--pr-color-muted': 'var(--color-tp-steel)',

  // Lines
  '--pr-color-border': 'var(--color-tp-hairline-soft)',
  '--pr-color-border-strong': 'var(--color-tp-hairline)',

  // Status
  '--pr-color-success': 'var(--color-tp-severity-success)',
  '--pr-color-warning': 'var(--color-tp-severity-warning)',
  '--pr-color-warning-surface': 'var(--color-tp-severity-warning-bg)',

  // Shape. DESIGN.md: 8px for buttons and inputs, 12px for cards and panels, and no pills.
  '--pr-radius-sm': 'var(--radius-sm)',
  '--pr-radius-md': 'var(--radius-md)',
  '--pr-radius-lg': 'var(--radius-lg)',

  // Type. The body face is Inter and the display face is the editorial serif the rest of the site uses for headings, which
  // is what `--pr-font-family-display` is for.
  '--pr-font-family': 'var(--font-body)',
  '--pr-font-family-display': 'var(--font-display)',
};
