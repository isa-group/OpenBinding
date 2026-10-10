import type { WorkspaceFiles } from '../../utils/workspaceDraft';
import {
  isRecord, parseJson, pretty,
  type BimDocument, type BimSpecDocument, type CandidateDocument, type InternalReference, type NormalizeDocument, type OptimizationCriterionDocument,
  type ResourceEntry,
} from './bimDocuments';

/**
 * What a form needs to know about the other documents of the package so that what it writes compiles with them. The compiler checks several
 * rules across documents (a candidate's provider is declared in its catalog, a binding names a feature of the Application, a rule that
 * should hold has a penalty in the Optimization, criteria in different units are normalized); this is where the forms read the facts those
 * rules are about, and where the pieces they ask for are built. Nothing here repeats the compiler: it only offers what exists and builds what is
 * missing, and the compiler stays the judge.
 */

/** A feature the Application declares, as another document can point to it. */
export interface FeatureOption {
  resource: string;
  id: string;
  unit: string;
  /** Bounds of the declared domain; a `ratio` domain is `[0, 1]`. */
  minimum?: number;
  maximum?: number;
  ratio: boolean;
}

/** A rule that should hold (`enforcement: soft`) in a ConstraintSet of the package. */
export interface SoftRule {
  resource: string;
  id: string;
  path: string;
}

export interface PackageContext {
  /** The id the selected document has in the Instance: what the other documents call it in a reference. */
  selfId: string;
  /** Is there an Application in the package to read the features from? Without one nothing can be offered, and forms fall back to typing. */
  featuresKnown: boolean;
  /** The file of the Application, to send people to when it has to declare what a form needs. */
  applicationPath: string | null;
  features: FeatureOption[];
  softRules: SoftRule[];
  /** The soft rules the Optimization has no entry for under its penalties. */
  unlinkedRules: SoftRule[];
  optimizationPath: string | null;
  /** The features the Optimization looks at. */
  criteriaFeatures: InternalReference[];
  /** The smallest and largest finite value the candidates of the catalogs give to each feature (by feature id). */
  observed: Record<string, [number, number]>;
  /** Opens a file of the package in the editor. */
  open: (path: string) => void;
  /** Writes the files of the package through the editor (one undoable step). */
  update: (change: (files: WorkspaceFiles) => WorkspaceFiles) => void;
}

/** The context of a document that is edited alone, with no package around it. */
export function standaloneContext(selfId = 'catalog'): PackageContext {
  return { selfId, featuresKnown: false, applicationPath: null, features: [], softRules: [], unlinkedRules: [], optimizationPath: null, criteriaFeatures: [], observed: {}, open: () => undefined, update: () => undefined };
}

const asNumber = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

function featureOptions(resource: string, document: BimDocument | null): FeatureOption[] {
  const features = document?.spec?.features;
  if (!isRecord(features)) return [];
  return Object.entries(features).flatMap(([id, feature]) => {
    if (!isRecord(feature)) return [];
    const domain: Record<string, unknown> = typeof feature.domain === 'string' ? { kind: feature.domain } : isRecord(feature.domain) ? feature.domain : {};
    const ratio = domain.kind === 'ratio';
    return [{
      resource,
      id,
      unit: typeof feature.unit === 'string' ? feature.unit : '1',
      minimum: ratio ? asNumber(domain.minimum) ?? 0 : asNumber(domain.minimum),
      maximum: ratio ? asNumber(domain.maximum) ?? 1 : asNumber(domain.maximum),
      ratio,
    }];
  });
}

function observedValues(files: WorkspaceFiles, resources: ResourceEntry[], applicationIds: string[]): Record<string, [number, number]> {
  const observed: Record<string, [number, number]> = {};
  const note = (feature: string, value: number) => {
    const current = observed[feature];
    observed[feature] = current ? [Math.min(current[0], value), Math.max(current[1], value)] : [value, value];
  };
  for (const resource of resources) {
    if (resource.kind !== 'CandidateCatalog' || !resource.path) continue;
    const spec = parseJson(files[resource.path])?.spec;
    if (!spec) continue;
    for (const candidate of Object.values(spec.candidates ?? {})) {
      for (const [alias, value] of Object.entries(candidate.features ?? {})) {
        const binding = spec.featureBindings?.[alias];
        if (!binding || !binding.id || !binding.resource || !applicationIds.includes(binding.resource)) continue;
        const ends = typeof value === 'number' ? [value] : [value.min, value.max];
        for (const end of ends) if (typeof end === 'number' && Number.isFinite(end)) note(binding.id, end);
      }
    }
  }
  return observed;
}

export function packageContext(
  files: WorkspaceFiles,
  resources: ResourceEntry[],
  selectedPath: string,
  actions: Pick<PackageContext, 'open' | 'update'>,
): PackageContext {
  const applications = resources.filter((resource) => resource.kind === 'Application' && resource.path);
  const features = applications.flatMap((resource) => featureOptions(resource.id, parseJson(files[resource.path!])));
  const softRules = resources.filter((resource) => resource.kind === 'ConstraintSet' && resource.path).flatMap((resource) => {
    const constraints = parseJson(files[resource.path!])?.spec?.constraints;
    return isRecord(constraints)
      ? Object.entries(constraints).filter(([, rule]) => isRecord(rule) && rule.enforcement === 'soft').map(([id]) => ({ resource: resource.id, id, path: resource.path! }))
      : [];
  });
  const optimization = resources.find((resource) => resource.kind === 'Optimization' && resource.path);
  const optimizationSpec = optimization?.path ? parseJson(files[optimization.path])?.spec : undefined;
  const criteria = optimizationSpec?.criteria;
  const listed = new Set((optimizationSpec?.penalties ?? []).map((penalty) => featureKey(penalty.constraint)));
  return {
    selfId: resources.find((resource) => resource.path === selectedPath)?.id ?? 'catalog',
    featuresKnown: applications.length > 0,
    applicationPath: applications[0]?.path ?? null,
    features,
    softRules,
    unlinkedRules: softRules.filter((rule) => !listed.has(featureKey(rule))),
    optimizationPath: optimization?.path ?? null,
    criteriaFeatures: Array.isArray(criteria)
      ? criteria.flatMap((criterion) => (criterion.feature?.resource && criterion.feature.id ? [{ resource: criterion.feature.resource, id: criterion.feature.id }] : []))
      : [],
    observed: observedValues(files, resources, applications.map((resource) => resource.id)),
    ...actions,
  };
}

/** `resource/id`, the way a reference to a feature or a rule reads; two references are the same thing when their keys are equal. */
export const featureKey = (reference: { resource?: string; id?: string } | undefined): string => `${reference?.resource ?? ''}/${reference?.id ?? ''}`;

export const findFeature = (context: PackageContext, reference: InternalReference | undefined): FeatureOption | undefined => context.features.find((feature) => featureKey(feature) === featureKey(reference));

// --- providers: a candidate points to a declaration of its own catalog

/** The providers the catalog declares. */
export const declaredProviders = (spec: BimSpecDocument): string[] => Object.keys(isRecord(spec.providers) ? spec.providers : {});

/** Is the provider a candidate points to one this catalog declares, under the name the package gives the catalog? */
export function providerIsDeclared(spec: BimSpecDocument, candidate: CandidateDocument, catalogId: string): boolean {
  if (!candidate.provider) return true;
  return candidate.provider.resource === catalogId && Boolean(candidate.provider.id) && declaredProviders(spec).includes(candidate.provider.id!);
}

/** The catalog with the provider declared (an existing declaration is kept as it is). */
export function declareProvider(spec: BimSpecDocument, provider: string): BimSpecDocument {
  return declaredProviders(spec).includes(provider) ? spec : { ...spec, providers: { ...spec.providers, [provider]: {} } };
}

/** The catalog with a candidate pointing to the provider, declaring it if it was not. A `null` provider removes the pointer. */
export function chooseProvider(spec: BimSpecDocument, candidateId: string, provider: string | null, catalogId: string): BimSpecDocument {
  const candidates = spec.candidates ?? {};
  const candidate = candidates[candidateId];
  if (!candidate) return spec;
  const { provider: previous, ...rest } = candidate;
  void previous;
  if (provider === null) return { ...spec, candidates: { ...candidates, [candidateId]: rest } };
  return { ...declareProvider(spec, provider), candidates: { ...candidates, [candidateId]: { ...rest, provider: { resource: catalogId, id: provider } } } };
}

/** The catalog without the provider and without any pointer to it. */
export function removeProvider(spec: BimSpecDocument, provider: string): BimSpecDocument {
  const providers = { ...spec.providers };
  delete providers[provider];
  const candidates = Object.fromEntries(Object.entries(spec.candidates ?? {}).map(([id, candidate]) => {
    if (candidate.provider?.id !== provider) return [id, candidate];
    const { provider: removed, ...rest } = candidate;
    void removed;
    return [id, rest];
  }));
  const next: BimSpecDocument = { ...spec, candidates };
  if (Object.keys(providers).length) next.providers = providers;
  else delete next.providers;
  return next;
}

// --- feature bindings: an alias names a feature the Application declares

/** The features of the Application that no alias of the catalog is bound to yet. */
export function unboundFeatures(spec: BimSpecDocument, context: PackageContext): FeatureOption[] {
  const bound = new Set(Object.values(spec.featureBindings ?? {}).map(featureKey));
  return context.features.filter((feature) => !bound.has(featureKey(feature)));
}

/** Does the binding point to a feature the Application declares? Without an Application in the package nothing can be said. */
export const bindingIsDeclared = (reference: InternalReference, context: PackageContext): boolean => !context.featuresKnown || Boolean(findFeature(context, reference));

/** The candidates that give no value to a feature the Optimization looks at, with the features they miss. */
export function candidatesMissingValues(spec: BimSpecDocument, context: PackageContext): Array<{ candidate: string; missing: string[] }> {
  if (!context.featuresKnown) return [];
  const bindings = spec.featureBindings ?? {};
  return Object.entries(spec.candidates ?? {}).flatMap(([candidate, document]) => {
    const missing = context.criteriaFeatures.flatMap((feature) => {
      const alias = Object.keys(bindings).find((name) => featureKey(bindings[name]) === featureKey(feature));
      return alias !== undefined && document.features?.[alias] !== undefined ? [] : [alias ?? `${feature.id} (not bound)`];
    });
    return missing.length ? [{ candidate, missing: [...new Set(missing)] }] : [];
  });
}

// --- soft rules: the Optimization lists each one under its penalties

/** The package with the Optimization listing the rule under its penalties (weight 1), unless it already does. */
export function withPenaltyFor(files: WorkspaceFiles, context: PackageContext, rule: SoftRule): WorkspaceFiles {
  if (!context.optimizationPath) return files;
  const document = parseJson(files[context.optimizationPath]);
  if (!document) return files;
  const penalties = document.spec?.penalties ?? [];
  if (penalties.some((penalty) => featureKey(penalty.constraint) === featureKey(rule))) return files;
  const next: BimDocument = { ...document, spec: { ...document.spec, penalties: [...penalties, { constraint: { resource: rule.resource, id: rule.id }, weight: 1 }] } };
  return { ...files, [context.optimizationPath]: pretty(next) };
}

// --- criteria: different units need an explicit scale

/** The criteria that have to be normalized because the criteria do not share a unit and nothing scales them (a `ratio` feature scales itself). */
export function criteriaNeedingScale(criteria: OptimizationCriterionDocument[], context: PackageContext): number[] {
  const resolved = criteria.map((criterion) => findFeature(context, criterion.feature));
  const units = new Set(resolved.flatMap((feature) => (feature ? [feature.unit] : [])));
  if (units.size < 2) return [];
  return criteria.flatMap((criterion, index) => (resolved[index] && !criterion.normalize && !resolved[index]!.ratio ? [index] : []));
}

/** A scale for a feature: its declared domain, else the values its candidates give, else 0 to 1. The person can change it afterwards. */
export function scaleFor(feature: FeatureOption | undefined, context: PackageContext): NormalizeDocument {
  if (feature?.minimum !== undefined && feature.maximum !== undefined && feature.maximum > feature.minimum) return { min: feature.minimum, max: feature.maximum, clamp: false };
  const seen = feature ? context.observed[feature.id] : undefined;
  if (seen && seen[1] > seen[0]) return { min: seen[0], max: seen[1], clamp: false };
  return { min: 0, max: 1, clamp: false };
}

/** The criteria with a scale on every one that needed it. */
export function normalizedCriteria(criteria: OptimizationCriterionDocument[], context: PackageContext): OptimizationCriterionDocument[] {
  const needing = new Set(criteriaNeedingScale(criteria, context));
  return criteria.map((criterion, index) => (needing.has(index) ? { ...criterion, normalize: scaleFor(findFeature(context, criterion.feature), context) } : criterion));
}
