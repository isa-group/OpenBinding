import type { PricingControlRoom, PricingRelease } from '../../api/platform';

/**
 * Stand-ins for what the pricing administration reads, for its tests: a small Pricing2Yaml document written the way the real one is
 * (anchors, merges, flow collections, `.inf`, a 20 GiB limit that pricing4ts would clamp), and the control room around it.
 */

export const PRICING_SOURCE = `# OpenBinding platform pricing, version 0.1.0.
syntaxVersion: '3.1'
saasName: openbinding
version: 0.1.0
createdAt: '2026-09-01'
currency: EUR
billing:
  monthly: 1
tags: [Solving, Analysis]

features:
  solve:
    description: Execute local and evolutionary OpenBinding engines.
    tag: Solving
    type: DOMAIN
    valueType: BOOLEAN
    defaultValue: true
    expression: pricingContext['features']['solve'] && subscriptionContext['taskStarts'] < pricingContext['usageLimits']['taskStarts']
  advancedAnalytics:
    description: Pareto, convergence, stability and engine comparisons.
    tag: Analysis
    type: INFORMATION
    valueType: BOOLEAN
    defaultValue: false
    expression: pricingContext['features']['advancedAnalytics']

usageLimits:
  taskStarts:
    description: Local solves started per actor and month.
    tag: Solving
    type: RENEWABLE
    period: { value: 1, unit: MONTH }
    valueType: NUMERIC
    defaultValue: 10
    unit: solve/month
    linkedFeatures: [solve]
  concurrentJobs:
    description: Jobs running at the same time for one actor.
    tag: Solving
    type: NON_RENEWABLE
    trackable: true
    valueType: NUMERIC
    defaultValue: 1
    unit: job
    linkedFeatures: [solve]
  storageBytes:
    description: Content-addressed artifact storage.
    tag: Solving
    type: NON_RENEWABLE
    trackable: true
    valueType: NUMERIC
    defaultValue: 104857600
    unit: byte
    linkedFeatures: [solve]

plans:
  BASIC:
    description: Free default plan for individual evaluation and small experiments.
    price: 0.0
    unit: user/month
    features: &basicFeatures
      solve: { value: true }
    usageLimits:
      taskStarts: { value: 10 }
      concurrentJobs: { value: 1 }
      storageBytes: { value: 104857600 }
  ADVANCED:
    description: Contact us / Institutional agreement. Advanced analytics and larger capacity.
    price: Contact us / Institutional agreement
    unit: user/month
    features:
      <<: *basicFeatures
      advancedAnalytics: { value: true }
    usageLimits:
      taskStarts: { value: 25 }
      concurrentJobs: { value: 2 }
      storageBytes: { value: 1073741824 }
  PRO:
    description: Contact us / Institutional agreement. High-capacity operation.
    price: Contact us / Institutional agreement
    unit: user/month
    features:
      <<: *basicFeatures
      advancedAnalytics: { value: true }
    usageLimits:
      taskStarts: { value: .inf }
      concurrentJobs: { value: 8 }
      storageBytes: { value: 21474836480 }

addOns:
  COMPUTE_PACK:
    description: Adds 100 local solves.
    availableFor: [ADVANCED, PRO]
    price: Contact us
    unit: pack/month
    subscriptionConstraints: { minQuantity: 1, maxQuantity: 10, quantityStep: 1 }
    usageLimitsExtensions:
      taskStarts: { value: 100 }
`;

/** The same document as another version, with a larger PRO allowance of concurrent jobs. */
export function previewOf(version: string): string {
  const source = PRICING_SOURCE.replace(/^version: .*$/m, `version: ${version}`);
  return version === '0.1.0' ? source : source.replace('concurrentJobs: { value: 8 }', 'concurrentJobs: { value: 10 }');
}

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const digest = (letter: string) => `sha256-${letter.repeat(64)}`;

function release(n: number, version: string, extra: Partial<PricingRelease>): PricingRelease {
  return {
    id: id(1100 + n),
    version,
    digest: digest('abcdef'[n % 6]),
    sphere_organization: 'OpenBinding',
    sphere_organization_id: 'org-openbinding',
    sphere_slug: 'openbinding',
    sphere_state: 'PUBLIC_RELEASE',
    space_state: 'NOT_DEPLOYED',
    is_live: false,
    public_url: null,
    changelog: '',
    migration_manifest: {},
    created_at: '2026-09-01T00:00:00Z',
    updated_at: '2026-09-01T00:00:00Z',
    ...extra,
  };
}

export const LIVE_RELEASE = release(1, '0.1.0', { space_state: 'ACTIVE', is_live: true, changelog: 'First release.', migration_manifest: { reason: 'first release' }, public_url: 'https://sphere.example.test/openbinding/0.1.0' });
export const DRAFT_RELEASE = release(2, '0.2.0-draft.1', { sphere_state: 'PRIVATE_DRAFT', created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-02T00:00:00Z', changelog: 'More concurrent jobs on PRO.' });
export const DRAINING_RELEASE = release(3, '0.0.9', { space_state: 'DRAINING', created_at: '2026-08-01T00:00:00Z' });

/** SPHERE and SPACE both answer; a draft waits next to the LIVE release and an older one is draining. */
export const PRICING_ROOM: PricingControlRoom = {
  identity: { organization: 'OpenBinding', slug: 'openbinding' },
  sphere: { enabled: true, reachable: true },
  space: { enabled: true, reachable: true },
  live: '0.1.0',
  releases: [DRAFT_RELEASE, LIVE_RELEASE, DRAINING_RELEASE],
  remoteVersions: [
    { version: '0.2.0-draft.1', private: true }, { version: '0.1.0', private: false }, { version: '0.0.9', private: false },
  ],
  spaceVersions: { active: [], archived: [] },
  divergence: { onlyInSphere: [], onlyLocal: [] },
};
