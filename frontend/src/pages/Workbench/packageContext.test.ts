import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_FILES, instanceResources, parseJson, pretty, type BimDocument, type BimSpecDocument } from './bimDocuments';
import {
  bindingIsDeclared, candidatesMissingValues, chooseProvider, criteriaNeedingScale, declareProvider, declaredProviders, normalizedCriteria,
  packageContext, providerIsDeclared, removeProvider, scaleFor, standaloneContext, unboundFeatures, withPenaltyFor, type PackageContext,
} from './packageContext';

const actions = { open: vi.fn(), update: vi.fn() };

const files = (over: Record<string, unknown> = {}) => ({
  ...DEFAULT_FILES,
  ...Object.fromEntries(Object.entries(over).map(([path, value]) => [path, typeof value === 'string' ? value : pretty(value)])),
});

const contextOf = (packageFiles: Record<string, string>, selected = 'candidates.json'): PackageContext => {
  const root = parseJson(packageFiles['instance.json']);
  return packageContext(packageFiles, instanceResources(root, packageFiles), selected, actions);
};

const application = (features: Record<string, unknown>) => ({
  apiVersion: 'qos-binding/v1', kind: 'Application', metadata: { name: 'app' },
  spec: { tasks: { hello: 'http' }, features, workflow: { task: { resource: 'application', id: 'hello' } } },
});

const withRules = (extra: Record<string, unknown> = {}) => files({
  'instance.json': {
    apiVersion: 'bim/v1', kind: 'Instance', metadata: { name: 'x' },
    spec: {
      profile: 'qos-binding/v1',
      resources: {
        application: { application: 'application.json' },
        candidateCatalog: { catalog: 'candidates.json' },
        constraintSet: { rules: 'constraints.json' },
        optimization: { optimization: 'optimization.json' },
      },
    },
  },
  'constraints.json': {
    apiVersion: 'qos-binding/v1', kind: 'ConstraintSet', metadata: { name: 'c' },
    spec: { constraints: { hard1: { assert: 'features.latency >= 0', enforcement: 'hard' }, soft1: { assert: 'features.latency >= 0', enforcement: 'soft', penalty: 1 } } },
  },
  ...extra,
});

describe('what the forms read from the package', () => {
  it('reads the features of the Application, the soft rules and the id the selected file has in the Instance', () => {
    const context = contextOf(withRules({
      'application.json': application({ latency: { unit: 'ms' }, cost: { unit: 'eur', domain: { kind: 'real', minimum: 0, maximum: 5 } }, share: { domain: 'ratio' } }),
    }));
    expect(context.selfId).toBe('catalog');
    expect(context.featuresKnown).toBe(true);
    expect(context.applicationPath).toBe('application.json');
    expect(context.features).toEqual([
      { resource: 'application', id: 'latency', unit: 'ms', ratio: false },
      { resource: 'application', id: 'cost', unit: 'eur', minimum: 0, maximum: 5, ratio: false },
      { resource: 'application', id: 'share', unit: '1', minimum: 0, maximum: 1, ratio: true },
    ]);
    expect(context.softRules).toEqual([{ resource: 'rules', id: 'soft1', path: 'constraints.json' }]);
    expect(context.unlinkedRules).toEqual(context.softRules);
    expect(context.optimizationPath).toBe('optimization.json');
    expect(contextOf(withRules(), 'constraints.json').selfId).toBe('rules');
  });

  it('knows nothing of the features when the package has no Application of its own', () => {
    const context = contextOf(files({
      'instance.json': { apiVersion: 'bim/v1', kind: 'Instance', metadata: { name: 'x' }, spec: { profile: 'qos-binding/v1', resources: { candidateCatalog: { catalog: 'candidates.json' } } } },
    }));
    expect(context.featuresKnown).toBe(false);
    expect(context.features).toEqual([]);
    expect(context.optimizationPath).toBeNull();
    expect(bindingIsDeclared({ resource: 'application', id: 'anything' }, context)).toBe(true);
    expect(standaloneContext().selfId).toBe('catalog');
  });

  it('reads the range of values the candidates give to each feature, through their aliases', () => {
    const context = contextOf(files({
      'candidates.json': {
        apiVersion: 'qos-binding/v1', kind: 'CandidateCatalog', metadata: { name: 'c' },
        spec: {
          featureBindings: { delay: { resource: 'application', id: 'latency' }, loose: { resource: 'elsewhere', id: 'latency' } },
          candidates: {
            a: { provides: 'http', features: { delay: 12, loose: 900 } },
            b: { provides: 'http', features: { delay: { min: 5, max: null } } },
          },
        },
      },
    }));
    expect(context.observed).toEqual({ latency: [5, 12] });
  });
});

describe('providers', () => {
  const spec = (): BimSpecDocument => ({ candidates: { a: { provides: 'http', features: {} }, b: { provides: 'http', features: {}, provider: { resource: 'catalog', id: 'ghost' } } } });

  it('declares the provider of a candidate in the catalog and points the candidate to it', () => {
    const next = chooseProvider(spec(), 'a', 'acme', 'catalog');
    expect(next.providers).toEqual({ acme: {} });
    expect(next.candidates?.a.provider).toEqual({ resource: 'catalog', id: 'acme' });
    expect(providerIsDeclared(next, next.candidates!.a, 'catalog')).toBe(true);
    // A declaration that exists is kept as it is, and a pointer can be removed.
    const named = { ...next, providers: { acme: { name: 'Acme Ltd' } } };
    expect(declareProvider(named, 'acme').providers).toEqual({ acme: { name: 'Acme Ltd' } });
    expect(chooseProvider(named, 'a', null, 'catalog').candidates?.a).not.toHaveProperty('provider');
    expect(declaredProviders(named)).toEqual(['acme']);
  });

  it('finds a pointer to a provider that is not declared, or declared by another catalog, and repairs it by declaring it', () => {
    const broken = spec();
    expect(providerIsDeclared(broken, broken.candidates!.a, 'catalog')).toBe(true);
    expect(providerIsDeclared(broken, broken.candidates!.b, 'catalog')).toBe(false);
    const repaired = chooseProvider(broken, 'b', 'ghost', 'catalog');
    expect(providerIsDeclared(repaired, repaired.candidates!.b, 'catalog')).toBe(true);
    const renamedCatalog = chooseProvider(repaired, 'b', 'ghost', 'other');
    expect(providerIsDeclared(renamedCatalog, renamedCatalog.candidates!.b, 'catalog')).toBe(false);
  });

  it('removes a provider together with the pointers to it', () => {
    const next = removeProvider(chooseProvider(chooseProvider(spec(), 'a', 'acme', 'catalog'), 'b', 'acme', 'catalog'), 'acme');
    expect(next).not.toHaveProperty('providers');
    expect(next.candidates?.a).not.toHaveProperty('provider');
    expect(next.candidates?.b).not.toHaveProperty('provider');
  });
});

describe('feature bindings', () => {
  it('offers the features no alias is bound to, and says when a candidate lacks a value the Optimization uses', () => {
    const context = contextOf(files({
      'application.json': application({ latency: { unit: 'ms' }, cost: { unit: 'eur' } }),
      'optimization.json': { apiVersion: 'qos-binding/v1', kind: 'Optimization', metadata: { name: 'o' }, spec: { criteria: [{ id: 'l', feature: { resource: 'application', id: 'latency' } }, { id: 'c', feature: { resource: 'application', id: 'cost' } }] } },
    }));
    const spec: BimSpecDocument = {
      featureBindings: { latency: { resource: 'application', id: 'latency' } },
      candidates: { a: { provides: 'http', features: { latency: 1 } }, b: { provides: 'http', features: {} } },
    };
    expect(unboundFeatures(spec, context).map((feature) => feature.id)).toEqual(['cost']);
    expect(bindingIsDeclared({ resource: 'application', id: 'cost' }, context)).toBe(true);
    expect(bindingIsDeclared({ resource: 'application', id: 'speed' }, context)).toBe(false);
    expect(candidatesMissingValues(spec, context)).toEqual([
      { candidate: 'a', missing: ['cost (not bound)'] },
      { candidate: 'b', missing: ['latency', 'cost (not bound)'] },
    ]);
    expect(candidatesMissingValues({ ...spec, featureBindings: { ...spec.featureBindings, cost: { resource: 'application', id: 'cost' } }, candidates: { a: { provides: 'http', features: { latency: 1, cost: 2 } } } }, context)).toEqual([]);
  });
});

describe('soft rules', () => {
  it('lists the soft rule in the Optimization once, with weight 1', () => {
    const packageFiles = withRules();
    const context = contextOf(packageFiles);
    const [rule] = context.softRules;
    const next = withPenaltyFor(packageFiles, context, rule);
    const optimization = parseJson(next['optimization.json']) as BimDocument;
    expect(optimization.spec?.penalties).toEqual([{ constraint: { resource: 'rules', id: 'soft1' }, weight: 1 }]);
    expect(contextOf(next).unlinkedRules).toEqual([]);
    expect(withPenaltyFor(next, contextOf(next), rule)).toBe(next);
    expect(withPenaltyFor(packageFiles, { ...context, optimizationPath: null }, rule)).toBe(packageFiles);
  });
});

describe('criteria in different units', () => {
  const features = application({ latency: { unit: 'ms' }, duration: { unit: 'ms' }, cost: { unit: 'eur' }, share: { unit: '1', domain: 'ratio' } });
  const context = contextOf(files({ 'application.json': features }));
  const criterion = (id: string, normalize?: { min: number; max: number }) => ({ id, feature: { resource: 'application', id }, ...(normalize ? { normalize } : {}) });

  it('needs a scale only when the units differ, and not for a feature that scales itself', () => {
    expect(criteriaNeedingScale([criterion('latency'), criterion('duration')], context)).toEqual([]);
    expect(criteriaNeedingScale([criterion('latency'), criterion('cost')], context)).toEqual([0, 1]);
    expect(criteriaNeedingScale([criterion('latency'), criterion('cost', { min: 0, max: 3 })], context)).toEqual([0]);
    expect(criteriaNeedingScale([criterion('latency'), criterion('share')], context)).toEqual([0]);
    expect(criteriaNeedingScale([criterion('latency'), { id: 'x', feature: { resource: 'application', id: 'missing' } }], context)).toEqual([]);
  });

  it('writes a valid scale from the domain, else from the values of the candidates, else 0 to 1', () => {
    const declared = { ...context, features: [{ resource: 'application', id: 'cost', unit: 'eur', minimum: 0, maximum: 5, ratio: false }] };
    expect(scaleFor(declared.features[0], declared)).toEqual({ min: 0, max: 5, clamp: false });
    const seen = { ...context, observed: { latency: [10, 40] as [number, number], cost: [3, 3] as [number, number] } };
    expect(scaleFor(context.features[0], seen)).toEqual({ min: 10, max: 40, clamp: false });
    expect(scaleFor(context.features[2], seen)).toEqual({ min: 0, max: 1, clamp: false });
    expect(scaleFor(undefined, seen)).toEqual({ min: 0, max: 1, clamp: false });
    const normalized = normalizedCriteria([criterion('latency'), criterion('cost')], seen);
    expect(normalized.map((item) => item.normalize)).toEqual([{ min: 10, max: 40, clamp: false }, { min: 0, max: 1, clamp: false }]);
    expect(normalized.every((item) => item.normalize!.max > item.normalize!.min)).toBe(true);
    expect(criteriaNeedingScale(normalized, seen)).toEqual([]);
  });
});
