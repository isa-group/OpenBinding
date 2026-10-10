import type { PricingRelease } from '../../api/platform';
import { readDiagnostics } from '../../api/problem';
import { describeLimit, limitInfo, LIMIT_ORDER } from '../../utils/limits';
import {
  emitYamlMap, isYamlMap, parseYaml, replaceYamlSection, replaceYamlVersion, YamlError, type YamlMap, type YamlValue,
} from '../../utils/pricingYaml';
import { describeAdminFailure, humanize, type ChipTone, type Failure } from './adminModel';

/**
 * What the three pricing screens share: a pricing document read as plans, limits and add-ons; the editing of a draft as
 * plain values; what changed between two documents; the server’s verdict in words; and what each stage of a version’s life allows.
 *
 * The documents are Pricing2Yaml. A version is “LIVE” when new contracts use it. That is not a certification of its content:
 * the API records states and fingerprints, and nothing here says a draft has been certified.
 */

// -- Reading a document ----------------------------------------------------------------------------------

export interface FeatureDef {
  id: string;
  description: string;
  valueType: string;
  defaultValue: YamlValue;
}

export interface LimitDef {
  id: string;
  description: string;
  unit: string;
  type: string;
  /** `null` is “no limit”. */
  defaultValue: number | null;
}

export interface PlanDoc {
  id: string;
  description: string;
  price: string | number;
  unit: string;
  /** Per feature: what the plan gets (the feature’s default when the plan doesn’t say). */
  features: Record<string, YamlValue>;
  /** Per limit: the figure; `null` is “no limit”. */
  limits: Record<string, number | null>;
  raw: YamlMap;
}

export interface AddOnDoc {
  id: string;
  description: string;
  price: string | number;
  unit: string;
  availableFor: string[];
  min: number;
  max: number;
  step: number;
  /** What one unit adds to each limit. */
  extensions: Record<string, number | null>;
  raw: YamlMap;
}

export interface PricingDoc {
  version: string;
  currency: string;
  features: FeatureDef[];
  limits: LimitDef[];
  plans: PlanDoc[];
  addOns: AddOnDoc[];
  source: string;
}

const mapOf = (value: YamlValue | undefined): YamlMap => (value !== undefined && isYamlMap(value) ? value : {});
const pick = <T,>(value: T | undefined, fallback: T): T => (value === undefined ? fallback : value);
const textOf = (value: YamlValue | undefined): string => (typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '');
const listOf = (value: YamlValue | undefined): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);

function figure(value: YamlValue | undefined): number | null | undefined {
  if (typeof value !== 'number' || Number.isNaN(value)) return undefined;
  return Number.isFinite(value) ? value : null;
}

/** Plans, add-ons, features and limits of a Pricing2Yaml document. Throws a {@link YamlError} when it can’t be read. */
export function readPricing(source: string): PricingDoc {
  const root = parseYaml(source);
  if (!isYamlMap(root)) throw new YamlError('The document isn’t a mapping of settings.');
  const features: FeatureDef[] = Object.entries(mapOf(root.features)).map(([id, value]) => {
    const feature = mapOf(value);
    return { id, description: textOf(feature.description), valueType: textOf(feature.valueType), defaultValue: feature.defaultValue ?? null };
  });
  const limits: LimitDef[] = Object.entries(mapOf(root.usageLimits)).map(([id, value]) => {
    const limit = mapOf(value);
    return { id, description: textOf(limit.description), unit: textOf(limit.unit), type: textOf(limit.type), defaultValue: pick(figure(limit.defaultValue), 0) };
  });
  const plans: PlanDoc[] = Object.entries(mapOf(root.plans)).map(([id, value]) => {
    const raw = mapOf(value);
    const own = mapOf(raw.features);
    const ownLimits = mapOf(raw.usageLimits);
    return {
      id,
      description: textOf(raw.description),
      price: typeof raw.price === 'number' ? raw.price : textOf(raw.price),
      unit: textOf(raw.unit),
      features: Object.fromEntries(features.map((def) => [def.id, def.id in own && 'value' in mapOf(own[def.id]) ? mapOf(own[def.id]).value : def.defaultValue])),
      limits: Object.fromEntries(limits.map((def) => [def.id, pick(figure(mapOf(ownLimits[def.id]).value), def.defaultValue)])),
      raw,
    };
  });
  const addOns: AddOnDoc[] = Object.entries(mapOf(root.addOns)).map(([id, value]) => {
    const raw = mapOf(value);
    const constraints = mapOf(raw.subscriptionConstraints);
    const quantity = (field: string, fallback: number) => (typeof constraints[field] === 'number' ? constraints[field] as number : fallback);
    return {
      id,
      description: textOf(raw.description),
      price: typeof raw.price === 'number' ? raw.price : textOf(raw.price),
      unit: textOf(raw.unit),
      availableFor: listOf(raw.availableFor),
      min: quantity('minQuantity', 1),
      max: quantity('maxQuantity', 1),
      step: quantity('quantityStep', 1),
      extensions: Object.fromEntries(Object.entries(mapOf(raw.usageLimitsExtensions)).flatMap(([limitId, extension]) => {
        const amount = figure(mapOf(extension).value);
        return amount === undefined ? [] : [[limitId, amount] as const];
      })),
      raw,
    };
  });
  return { version: textOf(root.version), currency: textOf(root.currency), features, limits, plans, addOns, source };
}

/** The document, or what went wrong reading it. */
export function tryReadPricing(source: string): { doc: PricingDoc } | { error: string } {
  try {
    return { doc: readPricing(source) };
  } catch (error: unknown) {
    return { error: error instanceof Error ? error.message : 'The document couldn’t be read.' };
  }
}

/** Free, a figure or the words the document uses (“Contact us / Institutional agreement”). */
export function priceLabel(price: string | number, currency: string): string {
  if (typeof price === 'number') return price === 0 ? 'Free' : `${price.toLocaleString('en-US')} ${currency || ''}`.trim();
  return price || '—';
}

export function limitLabel(doc: PricingDoc, id: string): string {
  return limitInfo(id, doc.limits.find((def) => def.id === id)).label;
}

/** A limit’s figure in words, with the unit the document gives it. */
export function limitText(doc: PricingDoc, id: string, value: number | null | undefined): string {
  const info = limitInfo(id, doc.limits.find((def) => def.id === id));
  return describeLimit(info.kind, value).text;
}

/** The limits worth showing first; the rest follow, in the document’s order. */
export const HEADLINE_LIMITS = ['taskStarts', 'solverSeconds', 'concurrentJobs', 'federatedEngines', 'apiKeys', 'studyRuns', 'jobHistoryDays'] as const;

export function orderedLimits(doc: PricingDoc): LimitDef[] {
  const rank = (id: string) => (LIMIT_ORDER.includes(id) ? LIMIT_ORDER.indexOf(id) : LIMIT_ORDER.length);
  return [...doc.limits].sort((a, b) => rank(a.id) - rank(b.id));
}

export const booleanFeatures = (doc: PricingDoc): FeatureDef[] => doc.features.filter((def) => def.valueType === 'BOOLEAN');

// -- Comparing two documents -----------------------------------------------------------------------------

export interface Change {
  id: string;
  /** What changed: a plan’s limit, a plan’s feature, an add-on or a plan. */
  scope: 'limit' | 'feature' | 'addon' | 'plan';
  plan: string | null;
  label: string;
  before: string;
  after: string;
  direction: 'up' | 'down' | 'same';
}

const rank = (value: number | null | undefined) => (value === null ? Number.POSITIVE_INFINITY : value ?? Number.NEGATIVE_INFINITY);

/** Every difference between two documents, in plan order: limits, features, add-ons. */
export function diffPricing(base: PricingDoc, next: PricingDoc): Change[] {
  const changes: Change[] = [];
  const planIds = [...new Set([...base.plans.map((plan) => plan.id), ...next.plans.map((plan) => plan.id)])];
  for (const planId of planIds) {
    const was = base.plans.find((plan) => plan.id === planId);
    const will = next.plans.find((plan) => plan.id === planId);
    if (!was || !will) {
      changes.push({ id: `plan:${planId}`, scope: 'plan', plan: planId, label: 'Plan', before: was ? 'Offered' : 'Not offered', after: will ? 'Offered' : 'Not offered', direction: will ? 'up' : 'down' });
      continue;
    }
    const limitIds = [...new Set([...Object.keys(was.limits), ...Object.keys(will.limits)])];
    for (const limitId of limitIds) {
      const before = was.limits[limitId];
      const after = will.limits[limitId];
      if (before === after) continue;
      changes.push({
        id: `limit:${planId}:${limitId}`, scope: 'limit', plan: planId, label: limitLabel(next, limitId),
        before: limitText(base, limitId, before), after: limitText(next, limitId, after),
        direction: rank(after) > rank(before) ? 'up' : 'down',
      });
    }
    const featureIds = [...new Set([...Object.keys(was.features), ...Object.keys(will.features)])];
    for (const featureId of featureIds) {
      const before = was.features[featureId];
      const after = will.features[featureId];
      if (before === after) continue;
      const word = (value: YamlValue | undefined) => (value === true ? 'Included' : value === false ? 'Not included' : String(value ?? '—'));
      changes.push({ id: `feature:${planId}:${featureId}`, scope: 'feature', plan: planId, label: humanize(featureId), before: word(before), after: word(after), direction: after === true ? 'up' : 'down' });
    }
    if (was.price !== will.price) {
      changes.push({ id: `price:${planId}`, scope: 'plan', plan: planId, label: 'Price', before: priceLabel(was.price, base.currency), after: priceLabel(will.price, next.currency), direction: 'same' });
    }
  }
  const addOnIds = [...new Set([...base.addOns.map((item) => item.id), ...next.addOns.map((item) => item.id)])];
  for (const addOnId of addOnIds) {
    const was = base.addOns.find((item) => item.id === addOnId);
    const will = next.addOns.find((item) => item.id === addOnId);
    if (!was || !will) {
      changes.push({ id: `addon:${addOnId}`, scope: 'addon', plan: null, label: humanize(addOnId), before: was ? 'Offered' : 'Not offered', after: will ? 'Offered' : 'Not offered', direction: will ? 'up' : 'down' });
      continue;
    }
    const facts: Array<[string, string, string]> = [
      ['Available for', was.availableFor.join(', ') || 'no plan', will.availableFor.join(', ') || 'no plan'],
      ['Quantity', `${was.min}–${was.max} step ${was.step}`, `${will.min}–${will.max} step ${will.step}`],
      ['Price', priceLabel(was.price, base.currency), priceLabel(will.price, next.currency)],
    ];
    for (const [label, before, after] of facts) {
      if (before !== after) changes.push({ id: `addon:${addOnId}:${label}`, scope: 'addon', plan: null, label: `${humanize(addOnId)} · ${label.toLowerCase()}`, before, after, direction: 'same' });
    }
    const limitIds = [...new Set([...Object.keys(was.extensions), ...Object.keys(will.extensions)])];
    for (const limitId of limitIds) {
      const before = was.extensions[limitId];
      const after = will.extensions[limitId];
      if (before === after) continue;
      changes.push({
        id: `addon:${addOnId}:ext:${limitId}`, scope: 'addon', plan: null, label: `${humanize(addOnId)} adds ${limitLabel(next, limitId).toLowerCase()}`,
        before: before === undefined ? 'Nothing' : limitText(base, limitId, before), after: after === undefined ? 'Nothing' : limitText(next, limitId, after),
        direction: rank(after) > rank(before) ? 'up' : 'down',
      });
    }
  }
  return changes;
}

// -- Editing a draft as plain values ------------------------------------------------------------------------

export interface PlanEdit {
  id: string;
  features: Record<string, boolean>;
  /** What was typed: a whole number, or “unlimited”. */
  limits: Record<string, string>;
}

export interface AddOnEdit {
  /** Where the add-on stands in the document it came from; `null` for one made here. */
  from: string | null;
  id: string;
  description: string;
  price: string;
  unit: string;
  availableFor: string[];
  min: string;
  max: string;
  step: string;
  extensions: Record<string, string>;
}

export interface DraftEdit {
  plans: PlanEdit[];
  addOns: AddOnEdit[];
}

const UNLIMITED = 'unlimited';

export function limitInput(value: number | null | undefined): string {
  return value === null ? UNLIMITED : value === undefined ? '' : String(value);
}

/** The figure a typed limit means: a number, `null` for no limit, `undefined` when it isn’t a figure. */
export function parseLimitInput(text: string): number | null | undefined {
  const value = text.trim();
  if (/^(unlimited|inf|∞|no limit)$/i.test(value)) return null;
  if (/^\d+(\.\d+)?$/.test(value)) return Number(value);
  return undefined;
}

export function editFrom(doc: PricingDoc): DraftEdit {
  return {
    plans: doc.plans.map((plan) => ({
      id: plan.id,
      features: Object.fromEntries(booleanFeatures(doc).map((def) => [def.id, plan.features[def.id] === true])),
      limits: Object.fromEntries(doc.limits.map((def) => [def.id, limitInput(plan.limits[def.id])])),
    })),
    addOns: doc.addOns.map((addOn) => ({
      from: addOn.id,
      id: addOn.id,
      description: addOn.description,
      price: String(addOn.price),
      unit: addOn.unit,
      availableFor: [...addOn.availableFor],
      min: String(addOn.min),
      max: String(addOn.max),
      step: String(addOn.step),
      extensions: Object.fromEntries(Object.entries(addOn.extensions).map(([id, value]) => [id, limitInput(value)])),
    })),
  };
}

export function blankAddOn(doc: PricingDoc): AddOnEdit {
  const first = doc.limits[0]?.id;
  return {
    from: null, id: '', description: '', price: 'Contact us', unit: 'pack/month', availableFor: doc.plans.slice(-1).map((plan) => plan.id),
    min: '1', max: '10', step: '1', extensions: first ? { [first]: '' } : {},
  };
}

export interface Issue {
  /** What to look at: “BASIC · Solves”, “Add-on COMPUTE_PACK”. */
  where: string;
  text: string;
}

export const DRAFT_VERSION = /^\d+\.\d+\.\d+-draft\.[1-9]\d*$/;
export const RELEASE_VERSION = /^\d+\.\d+\.\d+$/;
const ADDON_ID = /^[A-Za-z][A-Za-z0-9_-]*$/;

const wholeNumber = (text: string) => /^\d+$/.test(text.trim());

/** What is wrong with the edit before the gateway is asked. Empty when nothing is. */
export function issuesOf(doc: PricingDoc, edit: DraftEdit): Issue[] {
  const issues: Issue[] = [];
  for (const plan of edit.plans) {
    for (const [limitId, text] of Object.entries(plan.limits)) {
      if (parseLimitInput(text) === undefined) issues.push({ where: `${plan.id} · ${limitLabel(doc, limitId)}`, text: 'Use a whole number or “unlimited”.' });
    }
  }
  const seen = new Set<string>();
  for (const addOn of edit.addOns) {
    const where = `Add-on ${addOn.id || '(unnamed)'}`;
    if (!ADDON_ID.test(addOn.id)) issues.push({ where, text: 'Give it an id of letters, digits, “_” or “-”, starting with a letter.' });
    if (seen.has(addOn.id)) issues.push({ where, text: 'Another add-on has this id.' });
    seen.add(addOn.id);
    if (addOn.availableFor.length === 0) issues.push({ where, text: 'Choose at least one plan it is available for.' });
    if (![addOn.min, addOn.max, addOn.step].every(wholeNumber) || Number(addOn.min) < 1 || Number(addOn.step) < 1 || Number(addOn.max) < Number(addOn.min)) {
      issues.push({ where, text: 'Quantities are whole numbers: a minimum of at least 1, a maximum that isn’t below it, and a step of at least 1.' });
    }
    const filled = Object.entries(addOn.extensions).filter(([, text]) => text.trim() !== '');
    if (filled.length === 0) issues.push({ where, text: 'Say what one unit adds to at least one limit.' });
    for (const [limitId, text] of filled) {
      if (typeof parseLimitInput(text) !== 'number') issues.push({ where: `${where} · ${limitLabel(doc, limitId)}`, text: 'Use a whole number.' });
    }
  }
  return issues;
}

/** The base document with the edit applied, as YAML under `version`. The parts the form doesn’t edit stay as they were written. */
export function buildYaml(doc: PricingDoc, edit: DraftEdit, version: string): string {
  const plans: YamlMap = {};
  for (const plan of doc.plans) {
    const changes = edit.plans.find((item) => item.id === plan.id);
    if (!changes) continue;
    const features: YamlMap = { ...mapOf(plan.raw.features) };
    for (const def of booleanFeatures(doc)) {
      const on = changes.features[def.id] === true;
      if (on !== def.defaultValue || def.id in features) features[def.id] = { ...mapOf(features[def.id]), value: on };
    }
    const usageLimits: YamlMap = { ...mapOf(plan.raw.usageLimits) };
    for (const def of doc.limits) {
      const parsed = parseLimitInput(changes.limits[def.id] ?? '');
      if (parsed === undefined) continue;
      const value = parsed === null ? Number.POSITIVE_INFINITY : parsed;
      const fallback = def.defaultValue === null ? Number.POSITIVE_INFINITY : def.defaultValue;
      if (value !== fallback || def.id in usageLimits) usageLimits[def.id] = { ...mapOf(usageLimits[def.id]), value };
    }
    plans[plan.id] = { ...plan.raw, features, usageLimits };
  }

  const addOns: YamlMap = {};
  for (const addOn of edit.addOns) {
    const before = doc.addOns.find((item) => item.id === addOn.from)?.raw ?? {};
    const extensions: YamlMap = {};
    for (const [limitId, text] of Object.entries(addOn.extensions)) {
      const parsed = parseLimitInput(text);
      if (typeof parsed === 'number') extensions[limitId] = { ...mapOf(mapOf(before.usageLimitsExtensions)[limitId]), value: parsed };
    }
    const price = /^\d+(\.\d+)?$/.test(addOn.price.trim()) ? Number(addOn.price) : addOn.price.trim();
    const known = new Set(['description', 'availableFor', 'dependsOn', 'excludes', 'price', 'unit', 'subscriptionConstraints', 'features', 'usageLimits', 'usageLimitsExtensions']);
    addOns[addOn.id] = {
      description: addOn.description.trim(),
      availableFor: addOn.availableFor,
      ...(before.dependsOn === undefined ? {} : { dependsOn: before.dependsOn }),
      ...(before.excludes === undefined ? {} : { excludes: before.excludes }),
      price,
      unit: addOn.unit.trim(),
      subscriptionConstraints: { minQuantity: Number(addOn.min), maxQuantity: Number(addOn.max), quantityStep: Number(addOn.step) },
      ...(before.features === undefined ? {} : { features: before.features }),
      ...(before.usageLimits === undefined ? {} : { usageLimits: before.usageLimits }),
      usageLimitsExtensions: extensions,
      ...Object.fromEntries(Object.entries(before).filter(([name]) => !known.has(name))),
    };
  }

  let yaml = replaceYamlVersion(doc.source, version);
  yaml = replaceYamlSection(yaml, 'plans', emitYamlMap(plans, 2));
  yaml = replaceYamlSection(yaml, 'addOns', Object.keys(addOns).length > 0 ? emitYamlMap(addOns, 2) : '');
  return yaml.endsWith('\n') ? yaml : `${yaml}\n`;
}

// -- What the gateway says of a document -----------------------------------------------------------------------

export interface ServerValidation {
  valid: boolean;
  version: string | null;
  digest: string | null;
  plans: string[];
  addOns: string[];
  errors: string[];
  warnings: string[];
  /** The gateway answered 422: the request itself wasn’t valid, rather than the document failing its checks. */
  refused: boolean;
}

/**
 * `POST …/pricing/validate` answers its verdict as a body: `200` with `valid: true`, or a `422` (`invalid_pricing`) that
 * keeps the same view (`valid: false`, `errors`, `warnings`…) beside the problem's `diagnostics`. A 422 without a verdict
 * (the request itself was malformed) is read from its diagnostics.
 */
export function readValidation(answer: unknown): ServerValidation {
  const body = (typeof answer === 'object' && answer !== null ? answer : {}) as Record<string, unknown>;
  const strings = (value: unknown) => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);
  if (typeof body.valid === 'boolean') {
    const errors = strings(body.errors);
    return {
      valid: body.valid,
      version: typeof body.version === 'string' ? body.version : null,
      digest: typeof body.digest === 'string' ? body.digest : null,
      plans: strings(body.plans),
      addOns: strings(body.add_ons),
      errors: !body.valid && errors.length === 0 ? messagesOf(body) : errors,
      warnings: strings(body.warnings),
      refused: false,
    };
  }
  const detail = messagesOf(body);
  return { valid: false, version: null, digest: null, plans: [], addOns: [], errors: detail.length > 0 ? detail : ['The gateway refused the document (422).'], warnings: [], refused: true };
}

/** What a problem body says: the message of each diagnostic, or its `detail` sentence. */
function messagesOf(body: Record<string, unknown>): string[] {
  const messages = readDiagnostics(body.diagnostics).map((diagnostic) => diagnostic.message);
  if (messages.length > 0) return messages;
  return typeof body.detail === 'string' && body.detail !== '' ? [body.detail] : [];
}

/** The failure of a pricing request: the generic wording, with what is particular to pricing administration. */
export function describePricingFailure(error: unknown, what: string): Failure {
  const base = describeAdminFailure(error, what);
  if (base.status === 403) {
    return { ...base, title: 'This key can’t administer pricing (403)', text: 'The account is an administrator, but the API key behind this session doesn’t include the “pricing:admin” permission.' };
  }
  if (base.status === 502) {
    const mismatch = base.code === 'pricing_digest_mismatch';
    return {
      ...base,
      title: mismatch ? `The content doesn’t match its fingerprint (502 · ${base.code})` : `The pricing control plane returned an error (502${base.code ? ` · ${base.code}` : ''})`,
      text: mismatch
        ? 'SPHERE returned content that hashes differently from the recorded fingerprint. Pricing is refused until it is resolved, rather than serving something unverified.'
        : `${base.text} The states shown are the last ones recorded here. Nothing was changed.`,
    };
  }
  if (base.status === 503) {
    return { ...base, title: `SPHERE or SPACE isn’t available (503${base.code ? ` · ${base.code}` : ''})` };
  }
  return base;
}

// -- The life of a version ---------------------------------------------------------------------------------------

export const SPHERE_LABEL: Record<PricingRelease['sphere_state'], { label: string; tone: ChipTone }> = {
  PRIVATE_DRAFT: { label: 'Private draft', tone: 'plain' },
  PUBLIC_RELEASE: { label: 'Public release', tone: 'info' },
};

export const SPACE_LABEL: Record<PricingRelease['space_state'], { label: string; tone: ChipTone }> = {
  NOT_DEPLOYED: { label: 'Not deployed', tone: 'plain' },
  ACTIVE: { label: 'Active', tone: 'info' },
  DRAINING: { label: 'Draining', tone: 'warning' },
  ARCHIVED: { label: 'Archived', tone: 'plain' },
};

export interface Prerequisite {
  label: string;
  met: boolean;
  /** Checked by the gateway, not by this screen. */
  server?: boolean;
}

export type ActionId = 'deploy' | 'activate' | 'drain' | 'archive' | 'delete' | 'publish' | 'fork';

export interface LifecycleAction {
  id: ActionId;
  label: string;
  what: string;
  prerequisites: Prerequisite[];
  available: boolean;
  /** What the gateway answers when the prerequisites aren’t met. */
  refusal: string;
}

/** The stages a version passes through, with what each action needs of it. */
export function lifecycleOf(release: PricingRelease): LifecycleAction[] {
  const draft = release.sphere_state === 'PRIVATE_DRAFT';
  const space = release.space_state;
  const check = (label: string, met: boolean, server = false): Prerequisite => ({ label, met, server });
  const make = (id: ActionId, label: string, what: string, prerequisites: Prerequisite[], refusal: string): LifecycleAction => ({
    id, label, what, prerequisites, refusal, available: prerequisites.filter((item) => !item.server).every((item) => item.met),
  });
  return [
    make('deploy', 'Deploy to SPACE', draft ? 'Deploys this draft to SPACE as a preview. Contracts can’t be made on it.' : 'Makes this release runnable in SPACE.',
      [check('Not deployed yet, or archived', space === 'NOT_DEPLOYED' || space === 'ARCHIVED')], '409 · the version is already deployed'),
    make('activate', 'Make LIVE', 'New contracts and renewals use it. The current LIVE version starts draining; its contracts stay on it until they renew.',
      [check('Is a public release, not a draft', !draft), check('Isn’t LIVE already', !release.is_live)], draft ? '409 · a draft can’t be LIVE' : '409 · already LIVE'),
    make('drain', 'Drain', 'Stops new contracts on this version. Contracts already on it keep working until they renew.',
      [check('Isn’t LIVE', !release.is_live), check('Is active in SPACE', space === 'ACTIVE')], release.is_live ? '409 · LIVE can’t drain' : '409 · not active'),
    make('archive', 'Archive', 'Retires it from SPACE.',
      [check('Isn’t LIVE', !release.is_live), check('Is active or draining', space === 'ACTIVE' || space === 'DRAINING'), check('No contract is still on it', true, true)],
      release.is_live ? '409 · LIVE can’t be archived' : '409 · contracts are still pinned to it'),
    make('delete', 'Delete draft', 'Deletes this private draft from SPHERE, and its archived copy in SPACE. A release can never be deleted.',
      [check('Is a private draft', draft), check('Isn’t LIVE', !release.is_live)], draft ? '409 · deployed or LIVE' : '409 · a public release is immutable'),
  ];
}
