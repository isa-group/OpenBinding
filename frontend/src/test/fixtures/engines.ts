import type { UsageView } from '../../api/auth';
import type {
  BimDialect, BimProfile, EngineManifest, EngineRegistrationManifest, EngineRegistrationReport, EngineRegistrationRevision, RegisteredResource,
} from '../../api/client';

// Shared by the engine screens' tests and by the end-to-end spec: types only, so it loads in Node as well.

export const digestOf = (seed: string): string => `sha256-${seed.repeat(64).slice(0, 64)}`;

export const OWNER = 'alex.rivera';
export const PROTOCOL_DIGEST = digestOf('c3d4');
export const SCHEMA_DIGEST = digestOf('5c1e');
export const ADAPTER_DIGEST = digestOf('ad01');

export function registrationOf(
  name: string,
  status: EngineRegistrationRevision['status'] = 'private',
  active = false,
  options: { namespace?: string; version?: string; seed?: string } = {},
): EngineRegistrationRevision {
  return {
    namespace: options.namespace ?? OWNER,
    name,
    version: options.version ?? '0.3.1',
    digest: digestOf(options.seed ?? `${name.length}a${name.charCodeAt(0)}`),
    status,
    active,
  };
}

export const EDGE_SOLVER = registrationOf('edge-solver', 'private', true, { seed: 'e5f6' });
export const EDGE_SOLVER_OLD = registrationOf('edge-solver', 'published', true, { version: '0.2.0', seed: 'b2c3' });
export const SOLVER_IN_REVIEW = registrationOf('region-solver', 'pending_review', true, { version: '1.0.0', seed: 'd4e5' });
export const PAUSED_SOLVER = registrationOf('paused-solver', 'private', false, { version: '1.2.0', seed: 'a1b2' });
export const SHARED_SOLVER = registrationOf('shared-solver', 'published', true, { namespace: 'priya.nair', version: '2.0.0', seed: 'f607' });

const ALL = { selector: 'all' } as const;

export const ENGINE_DOCUMENT = {
  apiVersion: 'bim/v1',
  kind: 'Engine',
  metadata: { namespace: OWNER, name: 'edge-solver', version: '0.3.1', description: 'Tabu search over edge placements' },
  spec: {
    modes: [{
      id: 'tabu',
      profile: 'qos-binding/v1',
      ir: { apiVersion: 'bim/v1', kind: 'BindingProblem' },
      algorithm: 'tabu-search',
      capabilities: {
        workflowNodes: ALL,
        featureScopes: ALL,
        featureValues: { selector: 'only', values: ['scalar', 'interval'] },
        aggregations: { selector: 'only', values: ['sequence.sum', 'parallel.max'] },
        constraints: ALL,
        scalarizations: {
          selector: 'only',
          values: [
            { id: 'weighted-sum', objectiveTypes: ['SINGLE'], weightPolicy: 'required' },
            { id: 'pareto-front', objectiveTypes: ['MULTI', 'MANY'], weightPolicy: 'forbidden' },
          ],
        },
        expressions: ALL,
        placement: ALL,
        irExtensions: { selector: 'only', values: ['qos-binding-placement/v1'] },
      },
      optionsSchema: {
        type: 'object',
        properties: {
          time_budget_ms: { type: 'integer', minimum: 1, maximum: 3600000, default: 60000 },
          seed: { type: 'integer', default: 0 },
          algorithm: { const: 'tabu', default: 'tabu' },
        },
        required: ['time_budget_ms'],
        additionalProperties: false,
      },
      limits: { maxIterations: 100000, maxTimeBudgetMs: 3600000 },
      guarantees: { termination: ['FEASIBLE', 'UNKNOWN'], exact: false, deterministicWithoutTimeBudget: true },
    }],
  },
} satisfies Record<string, unknown>;

export const OPENAPI_DOCUMENT: Record<string, unknown> = {
  openapi: '3.1.0',
  info: { title: 'edge-solver', version: '0.3.1' },
  'x-bim-protocol': 'bim-engine/v1',
  'x-bim-protocol-digest': PROTOCOL_DIGEST,
  paths: {
    '/internal/v1/binding-problems': { post: {} },
    '/health': { get: {} },
    '/openapi.json': { get: {} },
  },
};

export const REGISTRATION_MANIFEST: EngineRegistrationManifest = {
  apiVersion: 'bim/v1',
  kind: 'EngineRegistration',
  metadata: { namespace: OWNER, name: 'edge-solver', version: '0.3.1' },
  spec: {
    engine: { namespace: OWNER, name: 'edge-solver', version: '0.3.1', digest: digestOf('e5') },
    endpoint: 'https://edge.example.org',
    protocol: { id: 'bim-engine/v1', mediaType: 'application/json', digest: PROTOCOL_DIGEST },
    mappings: { request: '/internal/v1/binding-problems', health: '/health', openapi: '/openapi.json' },
    auth: { scheme: 'bearer' },
    openapi: OPENAPI_DOCUMENT,
  },
};

export const REPORT_VERIFIED = {
  protocol: 'bim-engine/v1',
  protocolDigest: PROTOCOL_DIGEST,
  status: 'verified',
  durationMs: 1460.2,
  verifiedAt: '2026-10-08T09:30:00+00:00',
  checks: [
    { id: 'openapi', status: 'passed', deploymentDigest: digestOf('f0'), protocolDigest: PROTOCOL_DIGEST, requestPath: '/internal/v1/binding-problems', responseModes: ['synchronous'] },
    { id: 'health', status: 'passed' },
    { id: 'binding-result', status: 'passed', termination: 'FEASIBLE' },
  ],
};

export const REPORT_FAILED = {
  protocol: 'bim-engine/v1',
  protocolDigest: PROTOCOL_DIGEST,
  status: 'failed',
  durationMs: 940,
  checks: [
    { id: 'openapi', status: 'passed', requestPath: '/internal/v1/binding-problems', responseModes: ['synchronous'] },
    { id: 'health', status: 'passed' },
    { id: 'conformance', status: 'failed', message: 'engine did not solve the deterministic conformance problem' },
  ],
};

export const REPORT_PENDING = { protocol: 'bim-engine/v1', protocolDigest: PROTOCOL_DIGEST, status: 'pending', checks: [] };

/** `GET …/engine-registrations/{name}/report`: the registration, the manifest of its engine and the latest probe. */
export function reportOf(registration: EngineRegistrationRevision, report: Record<string, unknown> | null = REPORT_VERIFIED): EngineRegistrationReport {
  return {
    ...registration,
    openapiDigest: digestOf('f0'),
    openapi: OPENAPI_DOCUMENT,
    engine: ENGINE_DOCUMENT as unknown as EngineManifest,
    report,
  };
}

// -- Plan

export function usageOf(plan = 'RESEARCH', used = 1, limit: number | null = 5): UsageView {
  return {
    plan,
    contract_pending: false,
    features: { federatedEngines: true },
    capabilities: { federatedEngines: limit },
    limits: limit === null ? {} : { federatedEngines: { limit_id: 'federatedEngines', limit, used, remaining: limit - used } },
  };
}

// -- The language

const DIMENSIONS: Record<string, { values: string[]; openValues: boolean }> = {
  workflowNodes: { values: ['task', 'sequence', 'parallel'], openValues: false },
  featureScopes: { values: ['invocation', 'selectedCandidate'], openValues: false },
  featureValues: { values: ['scalar', 'interval'], openValues: false },
  scalarizations: { values: [], openValues: true },
  placement: { values: ['placement'], openValues: false },
  irExtensions: { values: [], openValues: true },
};

export const QOS_PROFILE: BimProfile = {
  apiVersion: 'bim/v1',
  kind: 'Profile',
  metadata: { namespace: 'bim.builtin', name: 'qos-binding', version: '1.0.0', description: 'Deterministic scalar-QoS service composition and binding' },
  spec: {
    deterministic: true,
    roles: {},
    output: { apiVersion: 'bim/v1', kind: 'BindingProblem', schemaDigest: digestOf('b1'), engineProtocol: 'bim-engine/v1' },
    capabilityVocabulary: { dimensions: DIMENSIONS },
    limitVocabulary: ['maxTasks', 'maxIterations', 'maxTimeBudgetMs'],
    adapter: { id: 'qos-binding-profile', version: '1.0.0', binaryDigest: ADAPTER_DIGEST },
  },
  id: 'qos-binding/v1',
  digest: digestOf('c0'),
  output: { apiVersion: 'bim/v1', kind: 'BindingProblem', schemaDigest: digestOf('b1'), engineProtocol: 'bim-engine/v1' },
  protocol: 'bim-engine/v1',
  protocolDigest: PROTOCOL_DIGEST,
};

export const PLACEMENT_DIALECT: BimDialect = {
  apiVersion: 'bim/v1',
  kind: 'Dialect',
  metadata: { namespace: 'bim.builtin', name: 'placement', version: '1.0.0', description: 'Where the tasks of a workflow may run' },
  spec: {
    compatibleProfiles: ['qos-binding/v1'],
    resourceTypes: [{ apiVersion: 'qos-binding-placement/v1', kind: 'Placement', roles: ['candidateCatalog'], mediaType: 'application/json', schemaDigest: SCHEMA_DIGEST }],
    extensionPoints: [],
    irFeatures: [{ dimension: 'placement', value: 'placement' }],
    adapter: { id: 'qos-binding-placement-dialect', version: '1.0.0', binaryDigest: digestOf('ad02') },
  },
  digest: digestOf('d1'),
};

export const COMMUNITY_DIALECT: BimDialect = {
  apiVersion: 'bim/v1',
  kind: 'Dialect',
  metadata: { namespace: OWNER, name: 'edge-annotations', version: '1.0.0', description: 'Latency tables measured at the edge' },
  spec: {
    compatibleProfiles: ['qos-binding/v1'],
    resourceTypes: [{ apiVersion: 'edge-annotations/v1', kind: 'LatencyTable', roles: ['latency-table'], mediaType: 'application/vnd.omg.bpmn+xml', schemaDigest: SCHEMA_DIGEST, xmlRoot: { namespace: 'urn:edge', localName: 'definitions' } }],
    extensionPoints: [{ target: { apiVersion: 'qos-binding/v1', kind: 'Application' }, pointer: '/spec/annotations', schemaDigest: digestOf('5c1f') }],
    irFeatures: [],
    adapter: { id: 'edge-annotations-adapter', version: '1.0.0', binaryDigest: digestOf('ad03') },
  },
  digest: digestOf('d2'),
};

export const REGISTERED_RESOURCES: RegisteredResource[] = [
  { namespace: 'bim.builtin', name: 'default-optimization', version: '1', digest: digestOf('01'), role: 'optimization', apiVersion: 'qos-binding/v1', kind: 'Optimization', dialect: 'qos-binding/v1', mediaType: 'application/json', status: 'published' },
  { namespace: OWNER, name: 'eu-edge-placement', version: '1.0.0', digest: digestOf('02'), role: 'candidateCatalog', apiVersion: 'qos-binding-placement/v1', kind: 'Placement', dialect: 'placement/v1', mediaType: 'application/json', status: 'published' },
];
