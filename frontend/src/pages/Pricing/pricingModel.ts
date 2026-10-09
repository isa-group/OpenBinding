import type { PricingCatalog } from '../../api/auth';
import { describeLimit, limitInfo, LIMIT_GROUPS, type LimitGroup } from '../../utils/limits';

/**
 * The pricing document, read for display.
 *
 * Everything shown on the Pricing screen is derived from the catalog the gateway serves
 * (`GET /v1/pricing/catalog`): plan names and order, which features and limits exist, what each plan gets,
 * the add-ons and which features need room before they start. The few words this file adds are display
 * names for identifiers the document does not name (`apiAccess`), never values.
 */

export type Cell =
  | { kind: 'yes' }
  | { kind: 'no' }
  | { kind: 'addon' }
  | { kind: 'value'; text: string; exact?: string };

export interface PlanColumn {
  id: string;
  /** The sentence under the plan name, without the "Contact us" lead-in some descriptions carry. */
  description: string;
  priceLabel: string;
  unitLabel: string;
  /** Paid plans are arranged by agreement: there is no checkout and no price. */
  byAgreement: boolean;
}

export interface Row {
  id: string;
  name: string;
  description: string;
  cells: Cell[];
  /** Names of the features whose use this limit bounds. Empty for features. */
  appliesTo: string[];
  toConfirm: boolean;
}

export interface RowGroup {
  id: string;
  title: string;
  note: string;
  rows: Row[];
}

export interface Gate {
  /** What starts: “a solve”. */
  starts: string;
  /** Everything that must have room, as sentences. */
  needs: string[];
}

export interface AddOn {
  id: string;
  initial: string;
  effect: string;
  plans: string[];
  quantity: string;
  per: string;
}

export interface FeatureEntry {
  id: string;
  name: string;
  description: string;
}

export interface PricingView {
  saasName: string;
  version: string;
  createdAt: string | null;
  currency: string | null;
  periods: string | null;
  plans: PlanColumn[];
  groups: RowGroup[];
  features: FeatureEntry[];
  gates: Gate[];
  addOns: AddOn[];
  /** A pre-1.0 version is a development copy: its figures can still change. */
  developmentCopy: boolean;
  /** What the document says the RESEARCH plan is, when it defines one. */
  researchDescription: string | null;
}

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function dictOf(value: unknown): Dict {
  return isDict(value) ? value : {};
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** `Adds 5 GB.` → `Adds 5 GB`: the interface sets its own punctuation. */
function sentence(value: unknown): string {
  return text(value).trim().replace(/\.$/, '');
}

const DISPLAY_NAMES: Record<string, string> = {
  apiAccess: 'API access',
  institutionalBranding: 'Institutional identity',
};

function humanize(id: string): string {
  const words = id.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function featureName(id: string, feature?: unknown): string {
  const named = isDict(feature) ? text(feature.name) : '';
  return named || DISPLAY_NAMES[id] || humanize(id);
}

const CONTACT = /^contact us/i;

function planColumn(id: string, plan: Dict, index: number): PlanColumn {
  const price = plan.price;
  const byAgreement = typeof price === 'number' ? price > 0 : typeof price === 'string' && CONTACT.test(price);
  const description = sentence(plan.description).replace(/^Contact us \/ Institutional agreement\.?\s*/i, '');
  if (byAgreement) {
    return { id, description, priceLabel: 'Contact us', unitLabel: 'institutional agreement', byAgreement: true };
  }
  return {
    id,
    description,
    priceLabel: typeof price === 'number' ? 'Free' : text(price) || 'Free',
    unitLabel: id === 'RESEARCH' ? 'with verified CAS' : index === 0 ? 'default plan' : 'free plan',
    byAgreement: false,
  };
}

/** The unit part after the slash: `pack/month` → `month`; a bare unit stays itself. */
function perOf(unit: string): string {
  const slash = unit.indexOf('/');
  return slash >= 0 ? unit.slice(slash + 1) : unit;
}

function quantityOf(unit: string, constraints: Dict): string {
  const min = typeof constraints.minQuantity === 'number' ? constraints.minQuantity : 1;
  const max = typeof constraints.maxQuantity === 'number' ? constraints.maxQuantity : null;
  const noun = unit.includes('/') ? unit.slice(0, unit.indexOf('/')) : unit;
  if (max === null) return `${min}+ ${noun}s`;
  if (max === 1 && min === 1) return `1 per ${noun}`;
  return `${min}–${max} ${noun}s`;
}

/** The sentences the document's own expressions require: `subscriptionContext['x'] < pricingContext…`. */
function gateNeeds(expression: string, limits: Dict): string[] {
  const ids = [...new Set([...expression.matchAll(/subscriptionContext\['([A-Za-z0-9_]+)'\]/g)].map((match) => match[1]))];
  return ids.map((id) => {
    const definition = dictOf(limits[id]);
    const info = limitInfo(id, definition);
    if (id === 'concurrentJobs') return 'A free job slot';
    if (definition.type === 'RENEWABLE') return `${info.label} left this month`;
    return `Room in ${info.label.toLowerCase()}`;
  });
}

const STARTS: Record<string, string> = {
  solve: 'a solve',
  federatedEngines: 'a federated solve',
  studies: 'a study run',
};

/** `null` when the document is not a pricing at all (no plans), so the screen can say so. */
export function readCatalog(catalog: PricingCatalog): PricingView | null {
  const plansById = dictOf(catalog.plans);
  const planIds = Object.keys(plansById);
  if (planIds.length === 0) return null;

  const features = dictOf(catalog.features);
  const limits = dictOf(catalog.usageLimits);
  const addOnsById = dictOf(catalog.addOns);
  const plans = planIds.map((id, index) => planColumn(id, dictOf(plansById[id]), index));

  const featureCell = (featureId: string, planId: string): Cell => {
    const plan = dictOf(plansById[planId]);
    const own = dictOf(dictOf(plan.features)[featureId]);
    const fallback = dictOf(features[featureId]).defaultValue;
    const value = 'value' in own ? own.value : fallback;
    if (value === true) return { kind: 'yes' };
    const viaAddOn = Object.values(addOnsById).some((addOn) => {
      const entry = dictOf(addOn);
      const available = Array.isArray(entry.availableFor) ? entry.availableFor : [];
      return available.includes(planId) && dictOf(dictOf(entry.features)[featureId]).value === true;
    });
    return viaAddOn ? { kind: 'addon' } : { kind: 'no' };
  };

  const limitCell = (limitId: string, planId: string): Cell => {
    const definition = dictOf(limits[limitId]);
    const own = dictOf(dictOf(dictOf(plansById[planId]).usageLimits)[limitId]);
    const raw = 'value' in own ? own.value : definition.defaultValue;
    const value = raw === null ? null : typeof raw === 'number' ? raw : undefined;
    const described = describeLimit(limitInfo(limitId, definition).kind, value);
    return { kind: 'value', text: described.text, exact: described.exact };
  };

  // Features are grouped by the tags the document declares, in its order.
  const declaredTags = Array.isArray(catalog.tags) ? catalog.tags.filter((tag): tag is string => typeof tag === 'string') : [];
  const featureTags = new Map<string, string[]>();
  for (const [id, feature] of Object.entries(features)) {
    const tag = text(dictOf(feature).tag) || 'Other';
    featureTags.set(tag, [...(featureTags.get(tag) ?? []), id]);
  }
  const tagOrder = [...declaredTags.filter((tag) => featureTags.has(tag)), ...[...featureTags.keys()].filter((tag) => !declaredTags.includes(tag))];
  const featureGroups: RowGroup[] = tagOrder.map((tag) => {
    const ids = featureTags.get(tag) ?? [];
    return {
      id: `feature-${tag}`,
      title: tag,
      note: ids.length === 1 ? 'Feature' : 'Features',
      rows: ids.map((id) => ({
        id,
        name: featureName(id, features[id]),
        description: sentence(dictOf(features[id]).description),
        cells: planIds.map((planId) => featureCell(id, planId)),
        appliesTo: [],
        toConfirm: false,
      })),
    };
  });

  const limitGroups: RowGroup[] = LIMIT_GROUPS.map((group) => {
    const ids = Object.keys(limits).filter((id) => limitInfo(id, dictOf(limits[id])).group === (group.id as LimitGroup));
    return {
      id: `limit-${group.id}`,
      title: group.title,
      note: group.note,
      rows: ids.map((id) => {
        const definition = dictOf(limits[id]);
        const linked = Array.isArray(definition.linkedFeatures) ? definition.linkedFeatures.filter((item): item is string => typeof item === 'string') : [];
        return {
          id,
          name: limitInfo(id, definition).label,
          description: sentence(definition.description),
          cells: planIds.map((planId) => limitCell(id, planId)),
          appliesTo: linked.map((featureId) => featureName(featureId, features[featureId])),
          // The handoff leaves the meaning of capacity units unsettled; the document does not say either.
          toConfirm: id === 'capacityUnits',
        };
      }),
    };
  }).filter((group) => group.rows.length > 0);

  const gates: Gate[] = Object.entries(features).flatMap(([id, feature]) => {
    const needs = gateNeeds(text(dictOf(feature).expression), limits);
    return needs.length === 0 ? [] : [{ starts: STARTS[id] ?? featureName(id, feature).toLowerCase(), needs }];
  });

  const addOns: AddOn[] = Object.entries(addOnsById).map(([id, value]) => {
    const addOn = dictOf(value);
    const unit = text(addOn.unit);
    return {
      id,
      initial: id.charAt(0),
      effect: sentence(addOn.description),
      plans: Array.isArray(addOn.availableFor) ? addOn.availableFor.filter((plan): plan is string => typeof plan === 'string') : [],
      quantity: quantityOf(unit, dictOf(addOn.subscriptionConstraints)),
      per: perOf(unit),
    };
  });

  const version = text(catalog.version);
  const billing = dictOf(catalog.billing);
  const periods = Object.keys(billing)[0];
  return {
    saasName: text(catalog.saasName) || 'openbinding',
    version,
    createdAt: text(catalog.createdAt) || null,
    currency: text(catalog.currency) || null,
    periods: periods ? `${periods} periods` : null,
    plans,
    groups: [...featureGroups, ...limitGroups],
    features: Object.entries(features).map(([id, feature]) => ({ id, name: featureName(id, feature), description: sentence(dictOf(feature).description) })),
    gates,
    addOns,
    developmentCopy: /^0\./.test(version),
    researchDescription: plansById.RESEARCH ? sentence(dictOf(plansById.RESEARCH).description) : null,
  };
}

/** `.inf` in the YAML reaches the browser as `null`; the renderer expects the number it stands for. */
export function withInfiniteLimits(value: unknown, key?: string): unknown {
  if (value === null && (key === 'value' || key === 'defaultValue')) return Number.POSITIVE_INFINITY;
  if (Array.isArray(value)) return value.map((item) => withInfiniteLimits(item));
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([name, child]) => [name, withInfiniteLimits(child, name)]));
  }
  return value;
}

/** `a1b2…c3d4` for a long digest, so a fingerprint fits in a chip. */
export function shortDigest(digest: string): string {
  const bare = digest.replace(/^sha256[-:]/, '');
  return bare.length > 12 ? `${bare.slice(0, 4)}…${bare.slice(-4)}` : bare;
}
