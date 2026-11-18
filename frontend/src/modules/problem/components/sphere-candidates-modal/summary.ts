import type { SphereVersionView } from '../../api/sphereApi';

/**
 * The normalised summary of a pricing version as the gateway answers it (`summary` of `GET …/sphere/pricings/{id}/versions/{v}`,
 * written by the gateway's Pricing2Yaml normaliser). The OpenAPI document declares it as an object; this names the fields the
 * wizard reads. Prices, limits and eligibility come from here and from the preview, never from the browser.
 */

export interface SummaryPrice {
  kind: 'fixed' | 'expression' | 'label';
  /** A fixed price per period. */
  amount?: number | null;
  /** An expression price as the gateway evaluated it (null when it could not). */
  value?: number | null;
  /** The expression, as the pricing writes it. */
  source?: string | null;
  /** Why an expression price could not be evaluated. */
  error?: string | null;
  /** A label price's words ("Contact sales"). */
  text?: string | null;
}

/** The number a price stands for, when the gateway read one. */
export function priceAmount(price: SummaryPrice): number | null {
  if (price.kind === 'fixed' && typeof price.amount === 'number') return price.amount;
  if (price.kind === 'expression' && typeof price.value === 'number') return price.value;
  return null;
}

export interface SummaryPlan {
  id: string;
  name: string;
  private: boolean;
  price: SummaryPrice;
  period?: string | null;
  unit?: string | null;
  perSeat?: boolean;
  features: Record<string, unknown>;
  usageLimits: Record<string, unknown>;
}

export interface SummaryAddOn {
  id: string;
  name: string;
  private: boolean;
  price: SummaryPrice;
  period?: string | null;
  unit?: string | null;
  availableFor: string[];
}

export interface SummaryFeature {
  id: string;
  name: string;
  type: string;
  valueType: string;
  docUrl?: string | null;
}

export interface SummaryLimit {
  id: string;
  name: string;
  unit?: string | null;
  valueType: string;
}

export interface VersionSummary {
  title: string;
  version: string;
  currency: string;
  syntaxVersion?: string;
  billing: Array<{ id: string; multiplier: number; synthesized?: boolean }>;
  plans: SummaryPlan[];
  addOns: SummaryAddOn[];
  /** Add-ons charged per use (a unit with no period): never imported (they are not a monthly price). */
  meteredAddOns: SummaryAddOn[];
  features: SummaryFeature[];
  usageLimits: SummaryLimit[];
}

const list = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);

/** The summary of a version view, with every list present. */
export function readSummary(view: SphereVersionView): VersionSummary {
  const raw = view.summary as Record<string, unknown>;
  return {
    title: typeof raw.title === 'string' ? raw.title : view.snapshot.title,
    version: typeof raw.version === 'string' ? raw.version : (view.snapshot.versionLabel ?? ''),
    currency: typeof raw.currency === 'string' ? raw.currency : (view.snapshot.currency ?? ''),
    syntaxVersion: typeof raw.syntaxVersion === 'string' ? raw.syntaxVersion : undefined,
    billing: list(raw.billing),
    plans: list(raw.plans),
    addOns: list(raw.addOns),
    meteredAddOns: list(raw.meteredAddOns),
    features: list(raw.features),
    usageLimits: list(raw.usageLimits),
  };
}

/** Why a plan cannot be imported, in the summary's terms, or null when it can. */
export function planRefusal(plan: SummaryPlan): string | null {
  if (plan.private) return 'Private in this pricing';
  if (plan.price.kind === 'label')
    return `Priced by agreement${plan.price.text ? ` (“${plan.price.text}”)` : ''}`;
  if (priceAmount(plan.price) === null)
    return plan.price.error
      ? `Its price can’t be read: ${plan.price.error}`
      : 'Its price can’t be read';
  return null;
}

/** A price as words: `35 USD/month`, `Free`, or the label. */
export function priceText(price: SummaryPrice, currency: string, period?: string | null): string {
  if (price.kind === 'label') return price.text ?? 'By agreement';
  const value = priceAmount(price);
  if (value === null) return 'Not readable';
  if (value === 0) return 'Free';
  const amount = value.toLocaleString('en', { maximumFractionDigits: 2 });
  return `${amount} ${currency}${period ? `/${period}` : ''}`;
}

/** The plans a summary lets the wizard import (public, with a readable price), in its order. */
export function importablePlans(summary: VersionSummary): string[] {
  return summary.plans.filter(plan => planRefusal(plan) === null).map(plan => plan.id);
}
