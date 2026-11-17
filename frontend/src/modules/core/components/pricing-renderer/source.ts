// Adapted from SPHERE frontend/src/modules/core/components/pricing-renderer/source.ts (feat/pricing-renderer, revision
// 694f292b03), https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: the parsed form is pricing-renderer's own `IPricingLike` (OpenBinding has no pricing4ts: the gateway serves the
// published pricing as JSON, `GET /v1/pricing/catalog`); SPHERE's upgrade through `PUT /api/v1/pricings` and the folding of
// upgraded values are not brought, since OpenBinding has no such endpoint and hands the renderer documents as they are.

import type { IPricingLike } from 'pricing-renderer';

/**
 * The input `pricing-renderer` takes: exactly one of a YAML document or an already-parsed pricing. The package's own props are
 * a discriminated union, so the two can never both be set.
 */
export type SpherePricingSource =
  { yaml: string; pricing?: never } | { pricing: IPricingLike; yaml?: never };

/** Top-level `syntaxVersion` of a Pricing2Yaml document, e.g. `'2.1'`. */
export function readSyntaxVersion(yaml: string): string | undefined {
  // Top-level keys sit at column 0, so anchoring there avoids matching a nested or quoted occurrence further down the document.
  return /^syntaxVersion\s*:\s*['"]?([0-9]+(?:\.[0-9]+)?)/m.exec(yaml)?.[1];
}

/**
 * Whether `pricing-renderer` can parse this document itself: it normalizes Pricing2Yaml 3.1 fully and any other 3.x as a
 * best-effort subset; a major below 3 is a blocking `PR_VERSION_UNSUPPORTED_MAJOR` error.
 */
export function rendererCanParse(yaml: string): boolean {
  const version = readSyntaxVersion(yaml);
  return version !== undefined && version.split('.')[0] === '3';
}

/**
 * Picks what to hand the renderer: the YAML when the renderer can read it (it keeps the author's labels and any
 * `custom.pricingRenderer` block), otherwise the parsed pricing. `undefined` while neither is available.
 */
export function pricingRendererSource(
  yaml: string | null | undefined,
  parsed: IPricingLike | null | undefined
): SpherePricingSource | undefined {
  if (yaml && rendererCanParse(yaml)) return { yaml };
  if (parsed) return { pricing: parsed };
  return undefined;
}
