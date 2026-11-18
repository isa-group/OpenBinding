import type { SphereImportRecipe } from '../../api/sphereApi';

/**
 * The SPHERE wizard's form, and the import recipe it writes (`problems/resources/sphere-recipe/1`, the OpenAPI component
 * `SphereImportRecipe`). This file holds names, numbers and choices only: which pricings and versions, which plans and add-ons,
 * how each problem feature is read, the demand and the requirements. Prices, limits and eligibility are the gateway's (the
 * version summary and the preview); nothing here evaluates a pricing.
 */

type Recipe = SphereImportRecipe;
type Defs = Recipe['$defs'];
export type RecipeTask = Defs['task'];
type RecipeSource = Defs['source'];
type SphereSource = Extract<RecipeSource, { sphere: unknown }>;
type HandMadeSource = Extract<RecipeSource, { candidate: unknown }>;

/** How a problem feature is read from each pricing. */
export type SpecKind = 'price' | 'limit' | 'feature' | 'guarantee' | 'constant' | 'manual';

/** Values set by hand, by key: `*` for every candidate, a provider (`mailgun`), or a provider's plan (`mailgun.FOUNDATION`). */
export type ManualMap = Record<string, number>;

export interface PropertyForm {
  kind: SpecKind;
  /** The limit, feature or guarantee, by the name the recipe uses (a source may alias it in `names`). */
  name: string;
  /** A boolean guarantee's table. */
  map: { true: number | null; false: number | null };
  /** A numeric guarantee's factor (`useScale`), instead of the table. */
  useScale: boolean;
  scale: number | null;
  /** The number an unlimited limit becomes when it is a problem feature. */
  unlimitedAs: number | null;
  constant: number | null;
  /** Values by hand (the whole spec when `kind` is `manual`). */
  manual: ManualMap;
  /** A provider whose values are all set by hand, whatever `kind` says (`{sendgrid: {manual: {'*': 0.999}}}`). */
  overrides: Record<string, ManualMap>;
}

export interface FeatureForm {
  id: string;
  direction: 'minimize' | 'maximize';
  unit: string;
  domain: 'real' | 'ratio';
}

export interface SourceForm {
  pricingId: string;
  versionId: string;
  registry: string | null;
  /** The pricing's name and owner and the version's name, as shown (never written into the recipe). */
  title: string;
  owner: string | null;
  versionLabel: string;
  provider: string;
  plans: string[];
  addons: string[];
  /** This pricing's own billing period, when it differs from the recipe's. */
  billing: string | null;
  seats: number | null;
  /** The recipe's name → this pricing's name, for a limit or guarantee it calls otherwise. */
  names: Record<string, string>;
  /** A limit this pricing does not declare: `unlimited` or a number, recorded as a value set by hand. */
  assume: Record<string, 'unlimited' | number>;
}

export interface DemandForm {
  name: string;
  value: number | null;
  unit: string;
}

export interface RequiredLimit {
  limit: string;
  /** A demand's name, or a number written as text. */
  atLeast: string;
}

export interface WizardForm {
  /** A new problem's name and slug; null when the import adds to an existing problem. */
  problem: { name: string; slug: string } | null;
  task: string;
  capability: string;
  service: string;
  currency: string;
  billing: string;
  sources: SourceForm[];
  /** Hand-made candidates of the task, kept as the recipe writes them. */
  handMade: HandMadeSource[];
  features: FeatureForm[];
  properties: Record<string, PropertyForm>;
  demand: DemandForm[];
  requireLimits: RequiredLimit[];
  requireFeatures: string[];
  prune: 'none' | 'dominated';
  /** The recipe's other tasks, which this wizard does not edit, kept as they are. */
  others: RecipeTask[];
  /** Where the edited task stands among them. */
  position: number;
}

export const emptyProperty = (kind: SpecKind = 'manual'): PropertyForm => ({
  kind,
  name: '',
  map: { true: null, false: null },
  useScale: false,
  scale: null,
  unlimitedAs: null,
  constant: null,
  manual: {},
  overrides: {},
});

export function emptyForm(): WizardForm {
  return {
    problem: null,
    task: '',
    capability: '',
    service: '',
    currency: 'USD',
    billing: 'monthly',
    sources: [],
    handMade: [],
    features: [],
    properties: {},
    demand: [],
    requireLimits: [],
    requireFeatures: [],
    prune: 'none',
    others: [],
    position: 0,
  };
}

/** The provider key a pricing's name suggests: its letters and digits, lower-case (`Twilio SendGrid` → `twiliosendgrid`). */
export function providerKey(name: string): string {
  const key = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '');
  return key || 'provider';
}

/** A problem slug from its name, as the problems tab writes one. */
export const slugOf = (name: string): string =>
  name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);

/** The service segment a capability suggests (`service/email` → `email`). */
export const serviceOf = (capability: string): string =>
  (capability.split('/').pop() ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '') || 'service';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const numbers = (value: unknown): ManualMap =>
  isRecord(value)
    ? Object.fromEntries(
        Object.entries(value).filter(
          (entry): entry is [string, number] => typeof entry[1] === 'number'
        )
      )
    : {};

const SPEC_KEYS = new Set([
  'feature',
  'guarantee',
  'limit',
  'manual',
  'map',
  'scale',
  'unlimitedAs',
]);

/** A recipe's property spec read back into the form. */
export function readSpec(spec: Defs['spec'] | undefined): PropertyForm {
  if (spec === undefined) return emptyProperty();
  if (typeof spec === 'number') return { ...emptyProperty('constant'), constant: spec };
  if (spec === 'price') return emptyProperty('price');
  if (typeof spec === 'string') return emptyProperty();
  const raw = spec as Record<string, unknown>;
  const overrides: Record<string, ManualMap> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!SPEC_KEYS.has(key) && isRecord(value) && 'manual' in value)
      overrides[key] = numbers(value.manual);
  }
  const base = { ...emptyProperty(), overrides, manual: numbers(raw.manual) };
  if (typeof raw.limit === 'string')
    return {
      ...base,
      kind: 'limit',
      name: raw.limit,
      unlimitedAs: typeof raw.unlimitedAs === 'number' ? raw.unlimitedAs : null,
    };
  if (typeof raw.feature === 'string') return { ...base, kind: 'feature', name: raw.feature };
  if (typeof raw.guarantee === 'string') {
    const map = numbers(raw.map);
    return {
      ...base,
      kind: 'guarantee',
      name: raw.guarantee,
      map: { true: map.true ?? null, false: map.false ?? null },
      useScale: typeof raw.scale === 'number',
      scale: typeof raw.scale === 'number' ? raw.scale : null,
    };
  }
  return { ...base, kind: 'manual' };
}

/** A property of the form as the recipe writes it. */
export function writeSpec(form: PropertyForm): Defs['spec'] {
  if (form.kind === 'price') return 'price';
  if (form.kind === 'constant') return form.constant ?? 0;
  const spec: Record<string, unknown> = {};
  if (form.kind === 'limit') {
    spec.limit = form.name;
    if (form.unlimitedAs !== null) spec.unlimitedAs = form.unlimitedAs;
  } else if (form.kind === 'feature') {
    spec.feature = form.name;
  } else if (form.kind === 'guarantee') {
    spec.guarantee = form.name;
    if (form.useScale) spec.scale = form.scale ?? 1;
    else {
      const map: ManualMap = {};
      if (form.map.false !== null) map.false = form.map.false;
      if (form.map.true !== null) map.true = form.map.true;
      spec.map = map;
    }
  }
  if (form.kind === 'manual' || Object.keys(form.manual).length > 0)
    spec.manual = { ...form.manual };
  for (const [provider, manual] of Object.entries(form.overrides)) {
    if (Object.keys(manual).length > 0) spec[provider] = { manual: { ...manual } };
  }
  return spec as Defs['spec'];
}

function writeSource(source: SourceForm): SphereSource {
  const out: SphereSource = {
    provider: source.provider,
    sphere: {
      pricing: source.pricingId,
      version: source.versionId,
      ...(source.registry ? { registry: source.registry } : {}),
    },
    addons: [...source.addons],
  };
  if (source.plans.length > 0) out.plans = [...source.plans];
  if (source.billing) out.billing = source.billing;
  if (source.seats !== null) out.seats = source.seats;
  if (Object.keys(source.names).length > 0) out.names = { ...source.names };
  if (Object.keys(source.assume).length > 0) out.assume = { ...source.assume };
  return out;
}

/** The task this wizard edits, as the recipe writes it. */
function writeTask(form: WizardForm): RecipeTask {
  const limits = Object.fromEntries(
    form.requireLimits
      .filter(entry => entry.limit && entry.atLeast !== '')
      .map(entry => {
        const number = Number(entry.atLeast);
        return [
          entry.limit,
          {
            atLeast:
              entry.atLeast.trim() !== '' && Number.isFinite(number) ? number : entry.atLeast,
          },
        ];
      })
  );
  const require: RecipeTask['require'] = {};
  if (Object.keys(limits).length > 0) require.limits = limits;
  if (form.requireFeatures.length > 0) require.features = [...form.requireFeatures];
  return {
    task: form.task,
    capability: form.capability,
    service: form.service || serviceOf(form.capability),
    expand: 'plans',
    from: [...form.sources.map(writeSource), ...form.handMade],
    properties: Object.fromEntries(
      form.features.map(feature => [
        feature.id,
        writeSpec(form.properties[feature.id] ?? emptyProperty()),
      ])
    ),
    prune: form.prune,
    ...(Object.keys(require).length > 0 ? { require } : {}),
  };
}

/** The recipe the form says. Versions are always pinned: the wizard never sends `latest`. */
export function toRecipe(form: WizardForm): Recipe {
  const demand = Object.fromEntries(
    form.demand
      .filter(entry => entry.name && entry.value !== null)
      .map(entry => [
        entry.name,
        { value: entry.value as number, ...(entry.unit ? { unit: entry.unit } : {}) },
      ])
  );
  return {
    recipeVersion: '1',
    currency: form.currency,
    billing: form.billing,
    features: Object.fromEntries(
      form.features.map(feature => [
        feature.id,
        {
          direction: feature.direction,
          ...(feature.domain === 'ratio' ? { domain: 'ratio' } : {}),
          unit: feature.unit,
        },
      ])
    ),
    ...(Object.keys(demand).length > 0 ? { demand } : {}),
    tasks: [
      ...form.others.slice(0, form.position),
      writeTask(form),
      ...form.others.slice(form.position),
    ],
  } as Recipe;
}

/** Read a recipe back into the form, editing `taskId` (else its first task). Shown names come from the pricings later. */
export function fromRecipe(recipe: Recipe, taskId?: string): WizardForm {
  const tasks = recipe.tasks ?? [];
  const index = Math.max(
    0,
    tasks.findIndex(task => task.task === taskId)
  );
  const task = tasks[index];
  const form = emptyForm();
  if (!task) return form;
  const sources: SourceForm[] = [];
  const handMade: HandMadeSource[] = [];
  for (const source of task.from) {
    if ('candidate' in source) {
      handMade.push(source);
      continue;
    }
    sources.push({
      pricingId: source.sphere.pricing,
      versionId: source.sphere.version,
      registry: source.sphere.registry ?? null,
      title: source.provider,
      owner: null,
      versionLabel: '',
      provider: source.provider,
      plans: [...(source.plans ?? [])],
      addons: [...(source.addons ?? [])],
      billing: source.billing ?? null,
      seats: source.seats ?? null,
      names: { ...(source.names ?? {}) },
      assume: { ...(source.assume ?? {}) },
    });
  }
  const features: FeatureForm[] = Object.entries(recipe.features ?? {}).map(([id, feature]) => ({
    id,
    direction: feature.direction,
    unit: feature.unit ?? '',
    domain: feature.domain ?? 'real',
  }));
  return {
    ...form,
    task: task.task,
    capability: task.capability,
    service: task.service ?? '',
    currency: recipe.currency,
    billing: recipe.billing ?? 'monthly',
    sources,
    handMade,
    features,
    properties: Object.fromEntries(
      features.map(feature => [feature.id, readSpec(task.properties?.[feature.id])])
    ),
    demand: Object.entries(recipe.demand ?? {}).map(([name, entry]) => ({
      name,
      value: entry.value,
      unit: entry.unit ?? '',
    })),
    requireLimits: Object.entries(task.require?.limits ?? {}).map(([limit, entry]) => ({
      limit,
      atLeast: String(entry.atLeast),
    })),
    requireFeatures: [...(task.require?.features ?? [])],
    prune: task.prune ?? 'none',
    others: tasks.filter((_, at) => at !== index),
    position: index,
  };
}

/** pricing4ts's sentinel for unlimited: no demand may exceed it (the gateway refuses `sphere_demand_too_large`). */
export const MAX_DEMAND = 1e8;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** What keeps the demand and requirements from being sent, in words; empty when nothing does. */
export function demandProblems(form: WizardForm): string[] {
  const problems: string[] = [];
  const names = new Set<string>();
  for (const entry of form.demand) {
    if (!IDENTIFIER.test(entry.name))
      problems.push(
        `The demand “${entry.name || '(no name)'}” needs a name of letters, digits and _.`
      );
    else if (names.has(entry.name)) problems.push(`The demand ${entry.name} is named twice.`);
    names.add(entry.name);
    if (entry.value === null || !Number.isFinite(entry.value) || entry.value < 0)
      problems.push(`The demand ${entry.name || '(no name)'} needs a number of at least 0.`);
    else if (entry.value > MAX_DEMAND)
      problems.push(
        `The demand ${entry.name} is above ${MAX_DEMAND.toExponential()}, which counts as unlimited.`
      );
  }
  for (const entry of form.requireLimits) {
    if (!entry.limit) problems.push('A requirement names no limit.');
    else if (!names.has(entry.atLeast) && !Number.isFinite(Number(entry.atLeast)))
      problems.push(`The requirement on ${entry.limit} names no demand or number.`);
  }
  return problems;
}
