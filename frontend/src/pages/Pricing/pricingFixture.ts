import type { PricingCatalog } from '../../api/auth';

/**
 * TEST FIXTURE, NOT A REAL PRICING. A minimal synthetic `GET /v1/pricing/catalog` answer, for the unit and browser tests
 * that stand in for the API: the document as JSON, with `.inf` as `null`. Its plans carry functional limits only
 * (concurrent jobs, API keys, ceilings per request, sponsored counts); the real pricings, versions, plans and contracts
 * live in the SPACE and SPHERE consoles, and nothing here is read from or must match them.
 */

const feature = (tag: string, description: string, defaultValue: boolean, expression?: string) => ({
  description, tag, type: 'DOMAIN', valueType: 'BOOLEAN', defaultValue,
  expression: expression ?? '',
});

const limit = (
  tag: string, description: string, defaultValue: number, unit: string, linkedFeatures: string[],
  kind: 'monthly' | 'tracked' | 'ceiling',
) => ({
  description, tag,
  type: kind === 'monthly' ? 'RENEWABLE' : 'NON_RENEWABLE',
  ...(kind === 'monthly' ? { period: { value: 1, unit: 'MONTH' } } : { trackable: kind === 'tracked' }),
  valueType: 'NUMERIC', defaultValue, unit, linkedFeatures,
});

/** Per plan, in the order of `LIMIT_IDS`; `null` is `.inf`. */
const LIMIT_IDS = [
  'concurrentJobs', 'federatedEngines', 'apiKeys',
  'maxTimeoutSeconds', 'maxIterations', 'maxPayloadBytes', 'maxInstanceComplexityLog10', 'jobHistoryDays', 'studyRuns',
  'organizations', 'members', 'projects', 'privateProjects', 'collections', 'studies', 'storageBytes',
] as const;

const VALUES: Record<string, Array<number | null>> = {
  BASIC: [1, 1, 1, 60, 10000, 8388608, 9, 7, 3, 1, 2, 3, 1, 2, 1, 104857600],
  ADVANCED: [2, 3, 10, 600, 500000, 67108864, 15, 90, 50, 2, 10, 25, 15, 25, 10, 1073741824],
  RESEARCH: [3, 5, 25, 900, 1000000, 134217728, 20, 180, 100, 5, 15, 50, 30, 50, 25, 5368709120],
  PRO: [8, 20, null, 1800, 10000000, 536870912, null, 365, 1000, 10, 100, 500, 500, 500, 250, 21474836480],
};

const usageLimitsOf = (plan: string) => Object.fromEntries(LIMIT_IDS.map((id, index) => [id, { value: VALUES[plan][index] }]));

const BASIC_FEATURES = {
  authoring: { value: true }, solve: { value: true }, federatedEngines: { value: true }, apiAccess: { value: true },
  collaboration: { value: true }, studies: { value: true }, reproducibleExport: { value: true }, publishing: { value: true },
};

export const catalogFixture: PricingCatalog = {
  syntaxVersion: '3.1',
  saasName: 'openbinding',
  version: '0.1.0',
  createdAt: '2026-09-01',
  currency: 'EUR',
  billing: { monthly: 1 },
  tags: ['Authoring', 'Solving', 'Analysis', 'Collaboration', 'Federation', 'Reproducibility', 'Institutional'],
  features: {
    authoring: feature('Authoring', 'Author and validate BIM v1 and qos-binding/v1 packages.', true),
    solve: feature('Solving', 'Execute local and evolutionary OpenBinding engines.', true,
      "pricingContext['features']['solve'] && subscriptionContext['concurrentJobs'] < pricingContext['usageLimits']['concurrentJobs']"),
    federatedEngines: feature('Federation', 'Register exact federated engine revisions and execute them.', true,
      "pricingContext['features']['federatedEngines'] && subscriptionContext['concurrentJobs'] < pricingContext['usageLimits']['concurrentJobs']"),
    apiAccess: feature('Collaboration', 'Use API keys with granular capabilities and boundaries.', true),
    collaboration: feature('Collaboration', 'Work in organizations, projects, collections and reports.', true),
    studies: feature('Analysis', 'Define and execute reproducible comparative binding studies.', true,
      "pricingContext['features']['studies'] && subscriptionContext['studyRuns'] < pricingContext['usageLimits']['studyRuns']"),
    advancedAnalytics: feature('Analysis', 'Pareto, convergence, stability, feasibility and engine comparisons.', false),
    reproducibleExport: feature('Reproducibility', 'Export content-addressed packages with checksums and provenance.', true),
    publishing: feature('Reproducibility', 'Freeze reports and publish reproducible binding results.', true),
    reproducibilityArchive: feature('Reproducibility', 'Extended immutable archive and audit retention.', false),
    institutionalBranding: feature('Institutional', 'Compact Universidad de Sevilla identity in authenticated surfaces.', false),
  },
  usageLimits: {
    concurrentJobs: limit('Solving', 'Jobs running at the same time for one actor.', 1, 'job', ['solve', 'federatedEngines', 'studies'], 'tracked'),
    federatedEngines: limit('Federation', 'Federated engine revisions available to one actor.', 1, 'engine', ['federatedEngines'], 'tracked'),
    apiKeys: limit('Collaboration', 'Active API keys owned by one actor.', 1, 'key', ['apiAccess'], 'tracked'),
    maxTimeoutSeconds: limit('Solving', 'Maximum wall-clock budget for one job.', 60, 'second', ['solve', 'federatedEngines'], 'ceiling'),
    maxIterations: limit('Solving', 'Maximum search iterations or evaluations for one job.', 10000, 'iteration', ['solve'], 'ceiling'),
    maxPayloadBytes: limit('Authoring', 'Maximum BIM package size for one request.', 8388608, 'byte', ['authoring', 'solve'], 'ceiling'),
    maxInstanceComplexityLog10: limit('Solving', 'Maximum base-10 logarithm of the eligible binding search space.', 9, 'log10 combinations', ['solve'], 'ceiling'),
    jobHistoryDays: limit('Reproducibility', 'Retention of finished jobs and results.', 7, 'day', ['reproducibleExport'], 'ceiling'),
    studyRuns: limit('Analysis', 'Comparative study executions per actor and month.', 3, 'run/month', ['studies'], 'monthly'),
    organizations: limit('Collaboration', 'Organizations sponsored across assigned subtrees.', 1, 'organization', ['collaboration'], 'tracked'),
    members: limit('Collaboration', 'Unique members across sponsored organization subtrees.', 2, 'member', ['collaboration'], 'tracked'),
    projects: limit('Collaboration', 'Projects across sponsored organization subtrees.', 3, 'project', ['collaboration'], 'tracked'),
    privateProjects: limit('Collaboration', 'Private projects across sponsored organization subtrees.', 1, 'project', ['collaboration'], 'tracked'),
    collections: limit('Collaboration', 'Curated collections across sponsored organization subtrees.', 2, 'collection', ['collaboration'], 'tracked'),
    studies: limit('Analysis', 'Comparative study definitions across sponsored subtrees.', 1, 'study', ['studies'], 'tracked'),
    storageBytes: limit('Reproducibility', 'Content-addressed artifact storage across sponsored subtrees.', 104857600, 'byte', ['reproducibleExport'], 'tracked'),
  },
  plans: {
    BASIC: {
      description: 'Free default plan for individual evaluation and small experiments.', price: 0, unit: 'user/month',
      features: BASIC_FEATURES, usageLimits: usageLimitsOf('BASIC'),
    },
    ADVANCED: {
      description: 'Contact us / Institutional agreement. Advanced analytics and larger capacity.',
      price: 'Contact us / Institutional agreement', unit: 'user/month',
      features: { ...BASIC_FEATURES, advancedAnalytics: { value: true } }, usageLimits: usageLimitsOf('ADVANCED'),
    },
    RESEARCH: {
      description: 'Free for verified Universidad de Sevilla CAS accounts, with institutional identity.', price: 0, unit: 'user/month',
      features: { ...BASIC_FEATURES, advancedAnalytics: { value: true }, institutionalBranding: { value: true } },
      usageLimits: usageLimitsOf('RESEARCH'),
    },
    PRO: {
      description: 'Contact us / Institutional agreement. High-capacity operation and federation.',
      price: 'Contact us / Institutional agreement', unit: 'user/month',
      features: { ...BASIC_FEATURES, advancedAnalytics: { value: true }, reproducibilityArchive: { value: true } },
      usageLimits: usageLimitsOf('PRO'),
    },
  },
  addOns: {
    COLLABORATION_PACK: {
      description: 'Adds 5 members, 10 projects, 5 private projects and 5 API keys.', availableFor: ['ADVANCED', 'PRO'], price: 'Contact us',
      unit: 'pack/month', subscriptionConstraints: { minQuantity: 1, maxQuantity: 10, quantityStep: 1 },
      usageLimitsExtensions: { members: { value: 5 }, projects: { value: 10 }, privateProjects: { value: 5 }, apiKeys: { value: 5 } },
    },
    STORAGE_PACK: {
      description: 'Adds 5 GB of artifact storage.', availableFor: ['ADVANCED', 'PRO'], price: 'Contact us',
      unit: 'pack/month', subscriptionConstraints: { minQuantity: 1, maxQuantity: 20, quantityStep: 1 },
      usageLimitsExtensions: { storageBytes: { value: 5368709120 } },
    },
    FEDERATION_PACK: {
      description: 'Adds 2 federated engines.', availableFor: ['PRO'], price: 'Contact us',
      unit: 'pack/month', subscriptionConstraints: { minQuantity: 1, maxQuantity: 10, quantityStep: 1 },
      usageLimitsExtensions: { federatedEngines: { value: 2 } },
    },
    CONCURRENCY_PACK: {
      description: 'Adds one concurrent job.', availableFor: ['PRO'], price: 'Contact us',
      unit: 'pack/month', subscriptionConstraints: { minQuantity: 1, maxQuantity: 4, quantityStep: 1 },
      usageLimitsExtensions: { concurrentJobs: { value: 1 } },
    },
    REPRODUCIBILITY_ARCHIVE: {
      description: 'Enables archive/audit and 365-day retention.', availableFor: ['ADVANCED'], price: 'Contact us',
      unit: 'account', subscriptionConstraints: { minQuantity: 1, maxQuantity: 1, quantityStep: 1 },
      features: { reproducibilityArchive: { value: true } }, usageLimitsExtensions: { jobHistoryDays: { value: 275 } },
    },
  },
};

export const CURRENT_FIXTURE = {
  version: '0.1.0',
  digest: `sha256-${'a1b2c3d4'.repeat(8)}`,
  url: 'https://sphere.example.test/pricings/openbinding/0.1.0',
};
