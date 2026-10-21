import JSZip from 'jszip';
import type { Page, Route } from '@playwright/test';
import type { ArchiveQuery, ArchiveResponse, ArchiveRow } from '../../src/analysis/archive';
import type { AdminUserView } from '../../src/api/auth';
import type { Job } from '../../src/api/platform';
import { digestOf as caseDigest, irDocument, refOf, revisionDocument, sourceContents } from '../../src/pages/Cases/fixtures';
import { LESSONS } from '../../src/pages/Examples/lessons';
import { templateFor } from '../../src/pages/Library/contentModel';
import { bpmnContent, catalogContent, catalogRangesContent, draftOf, goalContent, itemOf, rulesContent, versionOf } from '../../src/pages/Library/fixtures';
import { CURRENT_FIXTURE, catalogFixture } from '../../src/pages/Pricing/pricingFixture';
import {
  AUDIT, ERROR_EVENTS, ERROR_OVERVIEW, MODERATION, OVERVIEW, USERS, queuesAt, subscriptionOf, usageOf as adminUsageOf, userPage,
} from '../../src/test/fixtures/admin';
import { ID_FASTPAY, ROWS, SOURCES, archiveOf, detailOf as candidateOf } from '../../src/test/fixtures/analysis';
import {
  COMMUNITY_DIALECT, EDGE_SOLVER, EDGE_SOLVER_OLD, OPENAPI_DOCUMENT, PAUSED_SOLVER, PLACEMENT_DIALECT, QOS_PROFILE, REGISTERED_RESOURCES,
  REPORT_FAILED, REPORT_PENDING, REPORT_VERIFIED, SHARED_SOLVER, SOLVER_IN_REVIEW, reportOf as registrationReport,
} from '../../src/test/fixtures/engines';
import { INSTANCE, NEIGHBORHOOD, REGISTRATION, REPORT as JOB_REPORT, SOLUTION, detailOf as jobDetailOf, jobOf } from '../../src/test/fixtures/jobs';
import { DRAFT, EDITION, FROZEN, LEGACY, publicationOf } from '../../src/test/fixtures/reports';
import {
  blobOf, caseItem, collectionOf, collectionRevisionOf, resourceItem, resourceOf, resourceRevisionOf,
} from '../../src/test/fixtures/resources';
import {
  RANDOM_SEARCH, REVISION_2, VERSION_ID, analyticsFixture, cellsFixture, revisionFixture, runFixture, studyFixture,
} from '../../src/test/fixtures/studies';
import { EXAMPLE } from './galleryRoutes';

// One mock of the gateway for the whole QA gallery: a platform administrator of a RESEARCH (institutional) account, one organization
// with a project that has cases, runs, studies, reports and a library behind it, and everything the public screens read.
// Every date is fixed, so two runs of the gallery draw the same pictures. A request nobody answers is a 404 and is recorded.

export const API = 'http://localhost:8000';

/** The instant every page of the gallery believes it is. */
export const NOW = '2026-10-09T12:00:00Z';
const hoursAgo = (hours: number) => new Date(Date.parse(NOW) - hours * 3_600_000).toISOString();

export type Session = 'admin' | 'none';

export interface MockHandle {
  /** Requests the mock did not recognise, as `METHOD /path`. */
  unmocked: string[];
}

// -- The shared fixtures are already English and name neutral people (src/test/fixtures); the gallery only places the resource
// fixtures, which belong to a project of their own in the unit tests, in the project it shows.

const RENAMES: Array<[string, string]> = [
  ['"project-qos"', '"project-qos-benchmarks"'],
];

/** The fixture placed in the gallery's project. */
function localize<T>(value: T): T {
  let text = JSON.stringify(value);
  for (const [from, to] of RENAMES) text = text.split(from).join(to);
  return JSON.parse(text) as T;
}

// -- People and organizations

const ME_ID = '00000000-0000-4000-8000-000000000005';
const ME = {
  id: ME_ID, username: 'alex.rivera', email: 'alex.rivera@example.org', role: 'admin', is_active: true, plan: 'RESEARCH',
  created_at: '2026-01-10T00:00:00Z', cas_verified: true, institutional_branding: true,
};

/** The accounts of the administration screens: the ids the audit and overview fixtures point at, on example.org like the rest of the gallery. */
const ACCOUNTS: AdminUserView[] = USERS.map((user) => ({
  ...user, email: user.id === ME_ID ? ME.email : `${user.username.replace('.', '-')}@example.org`, plan: user.id === ME_ID ? 'RESEARCH' : user.plan,
}));
const accountOf = (id: string) => ACCOUNTS.find((account) => account.id === id);

const org = (id: string, slug: string, name: string, role: 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER', over: Record<string, unknown> = {}) => ({
  id, slug, name, parent_id: null, billing_sponsor_user_id: ME_ID, effective_role: role, created_at: '2026-03-03T00:00:00Z', ...over,
});
const ORGANIZATIONS = [
  org('org-isa-demo', 'isa-demo', 'ISA Demo Group', 'OWNER'),
  org('org-qos-lab', 'qos-lab', 'QoS Lab', 'OWNER', { parent_id: 'org-isa-demo', created_at: '2026-03-10T00:00:00Z' }),
  org('org-partner-lab', 'partner-lab', 'Partner Lab', 'ADMIN', { billing_sponsor_user_id: '00000000-0000-4000-8000-000000000004', created_at: '2026-07-01T00:00:00Z' }),
  org('org-read-lab', 'read-lab', 'Read Lab', 'VIEWER', { billing_sponsor_user_id: '00000000-0000-4000-8000-000000000004', created_at: '2026-05-01T00:00:00Z' }),
];

/** A `ProjectView`: the caller reaches every project of the gallery as a member (`access`), with the role of the organization. */
const project = (slug: string, orgId: string, name: string, description: string, visibility: 'public' | 'private', role: 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER' = 'OWNER') => ({
  id: `project-${slug}`, organization_id: orgId, slug, name, description, visibility, created_by_id: ME_ID,
  created_at: '2026-04-01T00:00:00Z', updated_at: '2026-10-08T00:00:00Z',
  access: 'member' as const, effective_role: role,
});
const PROJECTS: Record<string, ReturnType<typeof project>[]> = {
  'isa-demo': [
    project('qos-benchmarks', 'org-isa-demo', 'QoS Benchmarks', 'Reference binding cases with workflow and placement.', 'public'),
    project('payments-checkout', 'org-isa-demo', 'Payments checkout', 'Internal payments case with proprietary candidates.', 'private'),
  ],
  'qos-lab': [project('edge-placement', 'org-qos-lab', 'Edge placement', 'Exploration with pools and latencies.', 'private')],
  'partner-lab': [project('shared-corpus', 'org-partner-lab', 'Shared corpus', 'Cases the partner lab contributes.', 'private', 'ADMIN')],
  'read-lab': [],
};

const member = (orgId: string, key: string, userId: string, role: string, created = '2026-03-04T00:00:00Z') => ({
  id: `${orgId}-${key}`, organization_id: orgId, user_id: userId, username: key, email: `${key.replace('.', '-')}@example.org`, role, created_at: created,
});
const MEMBERS: Record<string, ReturnType<typeof member>[]> = {
  'isa-demo': [
    member('org-isa-demo', 'alex.rivera', ME_ID, 'OWNER'),
    member('org-isa-demo', 'sam.okafor', '00000000-0000-4000-8000-000000000002', 'MEMBER', '2026-04-12T00:00:00Z'),
    member('org-isa-demo', 'jordan.lee', '00000000-0000-4000-8000-000000000003', 'VIEWER', '2026-05-20T00:00:00Z'),
  ],
  'qos-lab': [member('org-qos-lab', 'sam.okafor', '00000000-0000-4000-8000-000000000002', 'ADMIN', '2026-04-15T00:00:00Z')],
};

const ORG_AUDIT = [
  { id: 'e0000000-0000-0000-0000-0000000000e5', organizationId: 'org-isa-demo', actorId: ME_ID, action: 'organization.invitation.created', targetType: 'OrganizationInvitation', targetId: 'inv-1', detail: {}, createdAt: '2026-10-08T09:15:00Z' },
  { id: 'e0000000-0000-0000-0000-0000000000e4', organizationId: 'org-isa-demo', actorId: ME_ID, action: 'organization.members.batch_updated', targetType: 'Organization', targetId: 'org-isa-demo', detail: { changes: [{ user_id: '00000000-0000-4000-8000-000000000002', role: 'ADMIN' }] }, createdAt: '2026-09-25T10:00:00Z' },
  { id: 'e0000000-0000-0000-0000-0000000000e3', organizationId: 'org-isa-demo', actorId: ME_ID, action: 'project.created', targetType: 'Project', targetId: 'project-qos-benchmarks', detail: {}, createdAt: '2026-04-01T08:30:00Z' },
  { id: 'e0000000-0000-0000-0000-0000000000e2', organizationId: 'org-isa-demo', actorId: ME_ID, action: 'organization.created', targetType: 'Organization', targetId: 'org-isa-demo', detail: {}, createdAt: '2026-03-03T08:00:00Z' },
];

// -- What the plan allows (nothing is counted per account)

const USAGE = {
  plan: 'RESEARCH',
  contract_pending: false,
  features: { authoring: true, solve: true, federatedEngines: true, apiAccess: true, collaboration: true, studies: true, advancedAnalytics: true, reproducibleExport: true, publishing: true, reproducibilityArchive: false, institutionalBranding: true },
  capabilities: {
    concurrentJobs: 3, federatedEngines: 5, apiKeys: 25,
    maxTimeoutSeconds: 900, maxIterations: 1_000_000, maxPayloadBytes: 134_217_728, maxInstanceComplexityLog10: 20, jobHistoryDays: 180,
    organizations: 5, members: 15, projects: 50, privateProjects: 30, collections: 50, studies: 25, storageBytes: 5_368_709_120,
  },
};

const NOTIFICATIONS = [
  {
    id: 'n1', kind: 'contract.changed', subject: 'Your OpenBinding agreement changed', body: 'Plan: BASIC → RESEARCH. Add-ons: {} → {}. Reason: institutional_agreement.',
    payload: { reason: 'institutional_agreement', previous: { plan: 'BASIC', addOns: {} }, current: { plan: 'RESEARCH', addOns: {} }, pricingVersion: '0.1.0' },
    read_at: null as string | null, created_at: hoursAgo(5),
  },
  { id: 'n2', kind: 'job.finished', subject: 'Job completed', body: 'Job 0000…a1 finished with FEASIBLE.', payload: {}, read_at: hoursAgo(20), created_at: hoursAgo(26) },
  { id: 'n3', kind: 'organization.invitation', subject: 'You were invited to Partner Lab', body: 'Priya invited you as ADMIN.', payload: {}, read_at: null, created_at: hoursAgo(2) },
];

/** A pricing token shaped like the gateway's: three dot-separated parts, the middle one a JSON payload that does not expire in our lifetime. */
const PRICING_TOKEN = ['header', Buffer.from(JSON.stringify({ sub: ME_ID, exp: 4_102_444_800 })).toString('base64'), 'signature'].join('.');

const ENGINE_DIGEST = `sha256-${'b2c3d4e5'.repeat(8)}`;
const API_KEYS = [
  {
    id: 'k1', name: 'ci-read-results', prefix: 'obk_demo0001', created_at: '2026-09-01T00:00:00Z', last_used_at: '2026-10-08T00:00:00Z', expires_at: '2099-12-31T00:00:00Z',
    permissions: ['jobs:read', 'projects:read', 'reports:read', 'studies:read'], engine_access: { all: true, engines: [] },
    boundary: { methods: ['GET'], organizations: ['isa-demo'], projects: ['qos-benchmarks'], resource_kinds: ['jobs', 'studies', 'reports'], slugs: null },
  },
  {
    id: 'k2', name: 'run-fixed-engine', prefix: 'obk_demo0002', created_at: '2026-09-10T00:00:00Z', last_used_at: null, expires_at: null,
    permissions: ['engines:execute', 'engines:read', 'instances:validate', 'jobs:read'],
    engine_access: { all: false, engines: [{ namespace: 'bim.builtin', name: 'random-search', version: '1.0.0', digest: ENGINE_DIGEST }] }, boundary: {},
  },
];

// -- The language: the profile with the roles it asks for, the dialects and the registered resources

const roleOf = (kind: string, minimum: number, maximum?: number, extensionTypes: 'none' | 'installed' = 'none') => ({
  resourceTypes: [{ apiVersion: 'qos-binding/v1', kind, minimum, ...(maximum === undefined ? {} : { maximum }) }], extensionTypes,
});
const PROFILE = localize({
  ...QOS_PROFILE,
  spec: {
    ...QOS_PROFILE.spec,
    roles: {
      application: roleOf('Application', 1, 1, 'installed'),
      candidateCatalog: roleOf('CandidateCatalog', 1),
      constraintSet: roleOf('ConstraintSet', 0),
      optimization: roleOf('Optimization', 0, 1),
    },
  },
});
const DIALECTS = localize([PLACEMENT_DIALECT, COMMUNITY_DIALECT]);
const REGISTERED = localize(REGISTERED_RESOURCES);

// -- Engines

const engineMode = (id: string, algorithm: string, exact: boolean) => ({
  id, profile: 'qos-binding/v1', ir: { apiVersion: 'bim/v1', kind: 'BindingProblem' }, algorithm,
  capabilities: {
    workflowNodes: { selector: 'all' }, metricScopes: { selector: 'all' }, aggregations: { selector: 'all' }, constraints: { selector: 'all' },
    optimization: { selector: 'all' }, objectiveTypes: { selector: 'all' }, expressions: { selector: 'all' }, placement: { selector: 'none' }, irExtensions: { selector: 'none' },
  },
  optionsSchema: {
    type: 'object',
    properties: { time_budget_ms: { type: 'integer', default: 30000, minimum: 1, maximum: 900000, unit: 'ms' }, iterations: { type: 'integer', default: 100000 }, seed: { type: 'integer', default: 0 } },
    additionalProperties: false,
  },
  limits: { maxTimeBudgetMs: 900000 }, guarantees: { termination: exact ? ['OPTIMAL', 'FEASIBLE', 'INFEASIBLE'] : ['FEASIBLE', 'UNKNOWN'], exact },
});
const engineEntry = (name: string, namespace: string, version: string, digest: string, modes: ReturnType<typeof engineMode>[]) => {
  const ref = { namespace, name, version, digest };
  return { ...ref, id: `${namespace}/${name}`, ref, modes };
};
export const PUBLIC_ENGINES = [
  engineEntry('random-search', 'bim.builtin', '1.0.0', ENGINE_DIGEST, [engineMode('sampling', 'random-search', false)]),
  engineEntry('evolutionary', 'bim.builtin', '1.0.0', `sha256-${'c3d4e5f6'.repeat(8)}`, [engineMode('genetic', 'evolutionary', false)]),
  engineEntry('minizinc', 'bim.builtin', '1.0.0', `sha256-${'d4e5f607'.repeat(8)}`, [engineMode('cp', 'minizinc', true)]),
];
const EDGE_ENGINE = engineEntry('edge-solver', 'alex.rivera', '0.3.1', `sha256-${'f1f2f3f4'.repeat(8)}`, [engineMode('tabu', 'tabu-search', false)]);
const OWN_ENGINES = [...PUBLIC_ENGINES, EDGE_ENGINE];

// -- The library behind the cases

const LIB_ORG = { organization_id: 'org-isa-demo', namespace: 'isa-demo' };
const app = itemOf('checkout-app', 'Application', 'Checkout app', { ...LIB_ORG, description: 'The checkout workflow: authenticate, reserve stock, ship, pay and notify.' });
const catalog = itemOf('providers-eu', 'CandidateCatalog', 'EU providers', { ...LIB_ORG, description: 'Payment, stock and shipping providers in the EU, with their measured latency, cost and availability.' });
const rules = itemOf('sla-hard', 'ConstraintSet', 'Hard SLA', { ...LIB_ORG, description: 'Latency and availability limits every binding must respect.' });
const goal = itemOf('weighted-cost-latency', 'Optimization', 'Weighted cost and latency', { ...LIB_ORG });
const workflow = itemOf('checkout-bpmn', 'Workflow', 'Checkout workflow (BPMN)', { ...LIB_ORG });
const external = itemOf('external-catalog', 'CandidateCatalog', 'External catalog', { organization_id: 'org-partner-lab', namespace: 'partner-lab', description: 'Published by Partner Lab.' });
const LIBRARY = [catalog, rules, goal, app, workflow];

const rulesV1 = versionOf(rules, '1');
const catalogV2 = versionOf(catalog, '2', { public: true });
const catalogV3 = versionOf(catalog, '3', { manifest: { mediaType: 'application/json', contracts: [], dependencies: [rulesV1.ref], kind: 'CandidateCatalog' }, based_on_id: catalogV2.id });
const VERSIONS: Record<string, ReturnType<typeof versionOf>[]> = {
  [catalog.id]: [catalogV3, catalogV2],
  [rules.id]: [rulesV1],
  [goal.id]: [versionOf(goal, '1')],
  [app.id]: [versionOf(app, '3')],
  [workflow.id]: [versionOf(workflow, '1', { manifest: { mediaType: 'application/vnd.omg.bpmn+xml', contracts: [], dependencies: [], kind: 'Workflow' } })],
  [external.id]: [versionOf(external, '1', { public: true })],
};
const CONTENT: Record<string, unknown> = {
  [catalog.id]: catalogRangesContent(), [rules.id]: rulesContent(), [goal.id]: goalContent(), [app.id]: sourceContents.application, [external.id]: catalogContent(), [workflow.id]: bpmnContent,
};
const DRAFTS: Record<string, ReturnType<typeof draftOf>[]> = {
  [catalog.id]: [draftOf('draft-providers-4', 4, catalogRangesContent(), { based_on_id: catalogV3.id })],
  [rules.id]: [draftOf('draft-sla-2', 2, rulesContent())],
  [app.id]: [draftOf('draft-app-1', 1, templateFor('Application', 'checkout-app').content as Record<string, unknown>)],
};

// -- Cases, revisions and snapshots

const REF_APP = refOf('checkout-app', '3', '4');
const REF_CATALOG_2 = refOf('providers-eu', '2', '3');
const REF_CATALOG_3 = refOf('providers-eu', '3', '4');
const REF_RULES = refOf('sla-hard', '1', '2');
const REF_GOAL = refOf('weighted-cost-latency', '1', '2');
const documentWith = (catalogRef: typeof REF_CATALOG_2) => revisionDocument([
  ['application', 'checkout', REF_APP], ['candidateCatalog', 'providers', catalogRef], ['constraintSet', 'sla', REF_RULES], ['optimization', 'goal', REF_GOAL],
]);
const S1 = '00000000-0000-4000-8000-0000000000e0';
const S2 = EXAMPLE.snapshot;
const S3 = '00000000-0000-4000-8000-0000000000e2';
const SNAPSHOT_PAY: Record<string, number> = { [S1]: 5, [S2]: 8, [S3]: 8 };

const CASE = localize({
  id: 'case-checkout-flow', project_id: 'project-qos-benchmarks', slug: 'checkout-flow', name: 'Checkout flow', description: 'Payments with authentication, stock and shipping in parallel.',
  created_by_id: ME_ID, created_at: '2026-04-02T00:00:00Z',
});
const DRAFT_CASE = { ...CASE, id: 'case-placement-draft', slug: 'placement-draft', name: 'Placement draft', description: 'Where the services may run: not sealed yet.', created_at: '2026-09-28T00:00:00Z' };
const revision = (n: number, catalogRef: typeof REF_CATALOG_2, snapshot: string) => localize(revisionFixture(n, {
  binding_case_id: CASE.id, document: documentWith(catalogRef), source_snapshot_id: snapshot,
}));
const CASE_REVISIONS = [revision(2, REF_CATALOG_3, S2), revision(1, REF_CATALOG_2, S1)];

const snapshotView = (id: string) => ({
  id, ownerId: ME_ID, instanceDigest: caseDigest('a'), packageDigest: caseDigest('b'), archiveSize: 48_213, createdAt: '2026-08-20T10:05:00Z',
  ir: { id: `ir-${id}`, digest: caseDigest('c'), document: localize(irDocument(SNAPSHOT_PAY[id] ?? 8)), sourceMap: null, compilerVersion: '1.0.0', createdAt: '2026-08-20T10:05:00Z' },
});
const snapshotPins = (id: string) => ({
  id, kind: 'InstanceSnapshot', instanceDigest: caseDigest('a'), packageDigest: caseDigest('b'), irDigest: caseDigest('c'),
  fileDigests: { 'instance.json': caseDigest('1'), 'application.json': caseDigest('2'), 'candidates.json': caseDigest('3'), 'constraints.json': caseDigest('4') },
  resourceDigests: { application: caseDigest('2'), candidateCatalog: caseDigest('3'), constraintSet: caseDigest('4') },
  instance: { apiVersion: 'bim/v1', kind: 'Instance', metadata: { name: 'checkout' } }, createdAt: '2026-08-20T10:05:00Z',
});

// -- Jobs

const JOB_ID = (n: number) => `00000000-0000-4000-8000-0000000000a${n}`;
const mine = { project_id: 'project-qos-benchmarks', organization_id: 'org-isa-demo' };
const JOBS = {
  feasible: jobOf(JOB_ID(1), 'random-search', 'completed', 'FEASIBLE', '2026-09-30T09:00:00Z', '2026-09-30T09:01:05Z', mine),
  running: jobOf(JOB_ID(2), 'minizinc', 'running', null, '2026-10-09T08:00:00Z', null, mine),
  queued: jobOf(JOB_ID(3), 'random-search', 'queued', null, '2026-10-09T11:40:00Z', null, mine),
  failed: jobOf(JOB_ID(4), 'evolutionary', 'failed', 'UNKNOWN', '2026-10-07T15:00:00Z', '2026-10-07T15:00:20Z', mine),
  cancelled: jobOf(JOB_ID(5), 'random-search', 'cancelled', null, '2026-10-06T12:00:00Z', '2026-10-06T12:00:03Z', mine),
  infeasible: jobOf(JOB_ID(6), 'minizinc', 'completed', 'INFEASIBLE', '2026-10-01T09:00:00Z', '2026-10-01T09:00:40Z', mine),
  routed: jobOf(JOB_ID(7), 'evolutionary-heuristics', 'completed', 'OPTIMAL', '2026-10-03T11:00:00Z', '2026-10-03T11:00:12Z', mine),
  theirs: jobOf(JOB_ID(8), 'evolutionary', 'completed', 'OPTIMAL', '2026-10-02T10:00:00Z', '2026-10-02T10:02:00Z', mine),
};
const OWN_JOBS: Job[] = [JOBS.running, JOBS.queued, JOBS.failed, JOBS.cancelled, JOBS.feasible, JOBS.infeasible, JOBS.routed];
const PROJECT_JOBS: Job[] = [JOBS.running, JOBS.queued, JOBS.failed, JOBS.cancelled, JOBS.feasible, JOBS.infeasible, JOBS.theirs];
const summaryOf = (row: Job) => ({
  id: row.id, engine_id: row.engine_id, status: row.status, termination: row.termination ?? null,
  solutions: row.status === 'completed' ? (row.termination === 'INFEASIBLE' ? 0 : 1) : null, created_at: row.created_at, finished_at: row.finished_at,
});

const SOLUTION_EN = localize(SOLUTION);
function jobDetail(id: string): Record<string, unknown> | null {
  const completed = { termination: 'FEASIBLE', solutions: [SOLUTION_EN] };
  switch (id) {
    case JOB_ID(1): return { ...jobDetailOf(id, 'completed'), result: completed };
    case JOB_ID(2): return { ...jobDetailOf(id, 'running') };
    case JOB_ID(3): return { ...jobDetailOf(id, 'queued') };
    case JOB_ID(4): return { ...jobDetailOf(id, 'failed') };
    case JOB_ID(5): return { ...jobDetailOf(id, 'cancelled') };
    case JOB_ID(6): return { ...jobDetailOf(id, 'completed', { result: { termination: 'INFEASIBLE', solutions: [{ violations: [{ constraint: 'sla-latency', message: 'Total latency is 742 ms; at most 600 ms is allowed.' }] }] } }) };
    case JOB_ID(7): return { ...jobDetailOf(id, 'completed'), result: completed };
    case JOB_ID(8): return { ...jobDetailOf(id, 'completed'), result: completed };
    default: return null;
  }
}

// -- Studies, reports and the analysis

const STUDY = localize(studyFixture());
const OTHER_STUDY = localize(studyFixture({
  id: 'study-placement', slug: 'placement-sweep', name: 'Placement sweep', description: 'Pools and latencies on the edge.', definition_artifact_id: 'artifact-placement',
  definition: { case_revision_ids: [REVISION_2.id], engines: [RANDOM_SEARCH], parameter_sets: [{}], seeds: [1, 2, 3] },
}));
const STUDIES = [STUDY, OTHER_STUDY];
const RUN = runFixture();
const CELLS = localize(cellsFixture());
const ANALYTICS = localize(analyticsFixture({
  binding_space: {
    cardinality: '125892', log10: 5.1, tasks: 6, breakdown: { authenticate: 4, inventory: 5, shipping: 3, 'pay-card': 8, 'pay-transfer': 4, notify: 1 },
    case_slug: 'checkout-flow', case_name: 'Checkout flow', revision: 2,
    cases: [
      { id: CASE.id, slug: 'checkout-flow', name: 'Checkout flow', revision: 1, cardinality: '15849', log10: 4.2, tasks: 6, breakdown: { authenticate: 4 } },
      { id: CASE.id, slug: 'checkout-flow', name: 'Checkout flow', revision: 2, cardinality: '125892', log10: 5.1, tasks: 6, breakdown: { authenticate: 4 } },
    ],
  },
}));

const REPORTS = localize([FROZEN, DRAFT, LEGACY]);
const PUBLICATION = localize(publicationOf(FROZEN, { citation: { title: 'Engine comparison at checkout', authors: ['Alex Rivera'], year: 2026, venue: 'ISA Demo Group / QoS Benchmarks' } }));

const ARCHIVE_SOURCES = localize(SOURCES);

/** The two stored bindings, ranked as the archive would under equal priorities. */
function archiveAnswer(query: ArchiveQuery): ArchiveResponse {
  // Lower is better: the binding ranked first has the lower score (the shared fixture lists them the other way round).
  const rows: ArchiveRow[] = [{ ...ROWS.payco, score: [0.265] }, { ...ROWS.fastpay, score: [0.285] }];
  const chosen = ARCHIVE_SOURCES.filter((source) => (query.sources ?? []).includes(source.id));
  return archiveOf({
    sources: chosen.length ? chosen : [ARCHIVE_SOURCES[0]],
    rows, winners: [rows[0]], next: [rows[1]],
    plot: {
      axes: [0, 1], bounds: [0, 0, 1, 1], count: 2, aggregated: false, bins: [],
      points: rows.map((row) => ({ id: row.id, x: row.normalized?.[0] ?? 0, y: row.normalized?.[1] ?? 0, feasible: true, eligible: true, paretoRank: null })),
    },
  });
}

// -- Public screens

const PUBLIC_PROJECTS = [
  { organization: { slug: 'isa-demo', name: 'ISA Demo Group' }, project: { slug: 'qos-benchmarks', name: 'QoS Benchmarks', description: 'Reference binding cases with workflow and placement.' } },
  { organization: { slug: 'partner-lab', name: 'Partner Lab' }, project: { slug: 'service-corpus', name: 'Service corpus', description: 'Cases derived from published service-composition papers.' } },
];
const PUBLIC_PUBLICATIONS = [
  {
    slug: 'checkout-engines', citation: { title: 'Engine comparison at checkout', authors: ['Alex Rivera'], year: 2026 },
    report: { title: 'Engine comparison at checkout', digest: EDITION, version_id: 'version-1' }, project: 'qos-benchmarks', organization: 'isa-demo', publishedAt: '2026-09-25T11:55:00Z',
  },
  {
    slug: 'corpus-baseline', citation: { title: 'Baseline results on the service corpus', authors: ['Sam Okafor', 'Jordan Lee'], year: 2026 },
    report: { title: 'Baseline results on the service corpus', digest: `sha256-${'12ab34cd'.repeat(8)}`, version_id: 'version-2' }, project: 'service-corpus', organization: 'partner-lab', publishedAt: '2026-09-12T08:00:00Z',
  },
];
const RESOLVED = {
  verified: true, kind: 'report', digest: EDITION, canonical_name: 'Engine comparison at checkout', media_type: 'application/json', size_bytes: 20480, created_at: '2026-09-25T11:55:00Z',
  author: { id: 'author-1', username: 'alex.rivera', email: null },
  document: { title: 'Engine comparison at checkout', sections: [{ id: 's1' }, { id: 's2' }, { id: 's3' }], schemaVersion: 1, evidence: { runs: 12 } },
  content_url: `/v1/resolve/report/${EDITION}/content`,
  locations: [{
    organization: { id: 'org-isa-demo', slug: 'isa-demo', name: 'ISA Demo Group' },
    project: { id: 'project-qos-benchmarks', slug: 'qos-benchmarks', name: 'QoS Benchmarks', visibility: 'public' },
    element_id: 'element-1', slug: 'checkout-engines', version_or_revision: 1, created_at: '2026-09-25T11:55:00Z', web_url: '/app/isa-demo/library',
  }],
  pagination: { total: 1, limit: 20, offset: 0, has_more: false },
  citation: {
    title: 'Engine comparison at checkout', authors: ['Alex Rivera'], year: 2026, doi: null, venue: 'ISA Demo Group / QoS Benchmarks', url: null,
    bibtex: '@misc{checkout_engines_2026,\n  title = {Engine comparison at checkout},\n  author = {Rivera, Alex},\n  year = {2026}\n}',
    markdown_badge: `[![OpenBinding](https://openbinding.example/badge/${EDITION})](https://openbinding.example/resolve/report/${EDITION})`,
    uri: `https://openbinding.example/resolve/report/${EDITION}`,
  },
};

/** A JSON Schema with enough structure to read: nested groups, a list, required fields and allowed values. */
function schemaOf(kind: string) {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema', $id: `https://openbinding.example/schemas/bim-v1-${kind.toLowerCase()}.json`, title: kind, type: 'object',
    required: ['apiVersion', 'kind', 'metadata', 'spec'],
    properties: {
      apiVersion: { type: 'string', const: 'bim/v1', description: 'The version of the language the document is written in.' },
      kind: { type: 'string', const: kind, description: `Always ${kind}.` },
      metadata: {
        type: 'object', required: ['name'], description: 'Who the document is.',
        properties: {
          name: { type: 'string', description: 'A fixed name, unique in its namespace.', pattern: '^[a-z0-9-]+$' },
          namespace: { type: 'string', description: 'Where the name lives.' },
          labels: { type: 'object', additionalProperties: { type: 'string' }, description: 'Free labels for finding it again.' },
        },
      },
      spec: {
        type: 'object', required: ['profile'], description: 'What the document says.',
        properties: {
          profile: { type: 'string', description: 'The Profile that directs the reading of the package.', enum: ['qos-binding/v1'] },
          resources: {
            type: 'array', description: 'The parts the package is made of.',
            items: {
              type: 'object', required: ['role', 'alias'],
              properties: {
                role: { type: 'string', enum: ['application', 'candidateCatalog', 'constraintSet', 'optimization'], description: 'What the part is for.' },
                alias: { type: 'string', description: 'How other parts name it.' },
                timeout: { type: 'number', description: 'Longest time one evaluation may take.', 'x-unit': 'ms' },
              },
            },
          },
        },
      },
    },
    $defs: { Metric: { type: 'object', properties: { unit: { type: 'string' }, direction: { enum: ['minimize', 'maximize'] } } } },
  };
}

// -- Administration

/** The platform in numbers, counted from the same accounts, organizations and projects the other screens list. */
const ADMIN_OVERVIEW = {
  ...OVERVIEW,
  counts: { users: ACCOUNTS.length, apiKeys: 9, identities: 3, organizations: ORGANIZATIONS.length, projects: 4, cases: 2, studies: 2, studyRuns: 1, artifacts: 12 },
  contracts: { BASIC: 3, ADVANCED: 1, RESEARCH: 2 },
};
const PENDING_REGISTRATION = { ...SOLVER_IN_REVIEW, namespace: 'sam.okafor' };
const emailOfAccount = (id: string | null | undefined) => (id ? `${(accountOf(id)?.username ?? 'sam.okafor').replace('.', '-')}@example.org` : null);
const ERRORS = ERROR_EVENTS.map((event) => ({ ...event, user_email: emailOfAccount(event.user_id), userEmail: emailOfAccount(event.user_id) }));

// -- The router

interface Reply {
  status?: number;
  json?: unknown;
  text?: string;
  bytes?: Buffer;
  type?: string;
}

const ok = (body: unknown, status = 200): Reply => ({ status, json: body });
const notFound = (message = 'Not found.'): Reply => ({ status: 404, json: { detail: { code: 'not_found', error: message } } });

interface Request {
  method: string;
  /** `/v1/organizations/…` split at the slashes: `['v1', 'organizations', …]`. */
  parts: string[];
  query: URLSearchParams;
  body: () => Record<string, unknown>;
  /** A small package, for every download. */
  archive: Buffer;
}

function projectRoutes(request: Request, orgSlug: string, projectSlug: string): Reply {
  const { method, parts, query } = request;
  const [, , , , , sub, subId, action, actionId, tail, tailId] = parts;
  const current = (PROJECTS[orgSlug] ?? []).find((item) => item.slug === projectSlug);
  if (!current) return notFound('Project not found.');
  if (!sub) return ok(current);
  const filled = projectSlug === 'qos-benchmarks';

  switch (sub) {
    case 'cases': {
      if (!filled) return ok([]);
      if (!subId) return ok([CASE, DRAFT_CASE]);
      if (subId === DRAFT_CASE.slug) return action === 'revisions' ? ok([]) : ok(DRAFT_CASE);
      if (subId !== CASE.slug) return notFound('Binding case not found.');
      if (!action) return ok(CASE);
      if (actionId) {
        const found = CASE_REVISIONS.find((item) => String(item.revision) === actionId || item.id === actionId || item.digest === actionId);
        return found ? ok(found) : notFound('Binding case revision not found.');
      }
      return ok(CASE_REVISIONS);
    }
    case 'jobs':
      if (!filled) return ok([]);
      return ok(query.get('job_id') ? PROJECT_JOBS.filter((row) => row.id === query.get('job_id')) : PROJECT_JOBS);
    case 'studies': {
      if (!filled) return ok([]);
      if (!subId) return ok(STUDIES);
      if (!STUDIES.some((item) => item.slug === subId)) return notFound('Study not found.');
      if (action === 'runs') {
        if (subId !== STUDY.slug) return ok([]);
        if (!actionId) return ok([RUN]);
        if (tail === 'cells' && tailId) {
          const cell = CELLS.find((item) => item.id === tailId);
          return cell ? ok(cell) : notFound('Study cell not found.');
        }
        if (tail === 'cells') return ok(CELLS);
        if (tail === 'analytics') return ok(ANALYTICS);
        return ok(RUN);
      }
      return ok(STUDIES.find((item) => item.slug === subId));
    }
    case 'reports': {
      if (!filled) return ok([]);
      if (!subId) return ok(REPORTS);
      const found = REPORTS.find((item) => item.slug === subId);
      return found ? ok(found) : notFound('Report not found.');
    }
    case 'publications':
      return ok(filled ? [PUBLICATION] : []);
    case 'blobs':
      return ok(filled ? localize([blobOf('a'), blobOf('b', { media_type: 'text/csv', size_bytes: 18_432, public: true, created_at: '2026-09-30T09:00:00Z' })]) : []);
    case 'resources': {
      if (!filled) return ok([]);
      const resources = localize([
        resourceOf('latency-probes', 'Latency probes', { kind: 'Dataset', description: 'Latency probe results used by the checkout benchmarks.' }),
        resourceOf('weighted-goal', 'Weighted goal', { kind: 'Optimization' }),
        resourceOf('notes', 'Notes'),
      ]);
      if (!subId) return ok(resources);
      const found = resources.find((item) => item.slug === subId);
      if (!found) return notFound('Resource not found.');
      if (action !== 'revisions') return ok(found);
      return ok(localize(subId === 'notes' ? [] : [
        resourceRevisionOf(found, 2, { title: 'Latency probes', samples: 5 }),
        resourceRevisionOf(found, 1, { title: 'Latency probes', samples: 3 }),
      ]));
    }
    case 'collections': {
      if (!filled) return ok([]);
      const references = collectionOf('checkout-references', 'Checkout references', { description: 'What a reviewer needs to reproduce the published comparison.' });
      const empty = collectionOf('empty-list', 'Empty list', { description: 'A list that has not got its first revision yet.' });
      const items = (...picked: Array<'c1' | 'c2' | 'w1'>) => picked.map((part) => (part === 'w1'
        ? resourceItem('latency-probes', '1', caseDigest('a'))
        : caseItem(`rev-checkout-${part.slice(1)}`, caseDigest(part.slice(1)))));
      const collections = localize([references, empty]);
      if (!subId) return ok(collections);
      const found = collections.find((item) => item.slug === subId);
      if (!found) return notFound('Collection not found.');
      if (action !== 'revisions') return ok(found);
      return ok(localize(subId === 'empty-list' ? [] : [
        collectionRevisionOf(references, 2, items('c1', 'c2', 'w1')), collectionRevisionOf(references, 1, items('c1', 'w1')),
      ]));
    }
    case 'library':
      if (!subId) return ok(filled ? [catalog, rules, goal, app] : []);
      return method === 'DELETE' ? { status: 204 } : ok({ project_id: current.id, artifact_id: subId });
    case 'package':
      return { status: 200, bytes: request.archive, type: 'application/zip' };
    default:
      return notFound('Not mocked.');
  }
}

function organizationRoutes(request: Request): Reply {
  const { parts, query } = request;
  const [, , orgSlug, section, projectSlug] = parts;
  if (!orgSlug) return ok(ORGANIZATIONS);
  const found = ORGANIZATIONS.find((item) => item.slug === orgSlug || item.id === orgSlug);
  if (!found) return { status: 403, json: { detail: { code: 'organization_forbidden', error: 'This action requires viewer access to the organization.' } } };
  if (!section) return ok(found);
  switch (section) {
    case 'members': return ok(MEMBERS[found.slug] ?? []);
    case 'audit': return ok({ events: ORG_AUDIT, total: ORG_AUDIT.length, offset: 0, limit: 50 });
    // No sponsor request is open in the gallery: the sponsor is who it always was.
    case 'sponsor-proposals': return ok([]);
    case 'library': {
      const own = found.slug === 'isa-demo' ? LIBRARY : [];
      return ok(query.get('include_public') === 'true' ? [...own, external] : own);
    }
    case 'projects':
      if (!projectSlug) return ok(PROJECTS[found.slug] ?? []);
      return projectRoutes(request, found.slug, projectSlug);
    default: return notFound('Not mocked.');
  }
}

function artifactRoutes(request: Request): Reply {
  const { parts } = request;
  const [, , id, sub, subId, action] = parts;
  if (id === 'resolve') {
    const wanted = request.body() as { name?: string; version?: string };
    const hit = Object.values(VERSIONS).flat().find((version) => version.ref.name === wanted.name && version.ref.version === wanted.version);
    return hit ? ok(hit) : notFound('Artifact version not found.');
  }
  // The artifact behind a study's definition: one sealed version, the one the study points at.
  if (id.startsWith('artifact-') && sub === 'versions') {
    if (action === 'content') return { status: 200, type: 'text/plain', text: JSON.stringify(STUDY.definition) };
    return ok([{
      id: VERSION_ID, artifact_id: id, ordinal: 1, ref: { namespace: 'isa-demo', name: id, version: '1', versionDigest: caseDigest('9') }, contentDigest: caseDigest('8'),
      manifest: { mediaType: 'application/json', contracts: [], dependencies: [], kind: 'Study' }, based_on_id: null, public: false, withdrawn: false, created_at: '2026-09-20T08:00:00Z',
    }]);
  }
  const item = [...LIBRARY, external].find((candidate) => candidate.id === id || candidate.name === id);
  if (!item) return notFound('Artifact not found.');
  if (!sub) return ok(item);
  if (sub === 'drafts') return ok(DRAFTS[item.id] ?? []);
  if (sub === 'versions') {
    const versions = VERSIONS[item.id] ?? [];
    if (!subId) return ok(versions);
    if (action === 'content') {
      const content = CONTENT[item.id];
      return { status: 200, type: 'text/plain', text: typeof content === 'string' ? content : JSON.stringify(content) };
    }
    const found = versions.find((candidate) => candidate.id === subId || candidate.ref.version === subId);
    return found ? ok(found) : notFound('Artifact version not found.');
  }
  return notFound('Not mocked.');
}

function userRoutes(request: Request): Reply {
  const { method, parts } = request;
  const [, , , sub, subId] = parts;
  if (!sub) return ok(ME);
  switch (sub) {
    case 'pricing-token': return ok({ pricing_token: PRICING_TOKEN });
    case 'usage': return ok(USAGE);
    case 'jobs': return ok({ jobs: OWN_JOBS.map(summaryOf), total: OWN_JOBS.length, retention_days: 180 });
    case 'api-keys': return subId ? { status: 204 } : ok({ api_keys: API_KEYS });
    case 'identities': return ok([{ id: 'i1', provider: 'us-cas', subject: 'arivera1', verifiedAt: '2026-09-01T00:00:00Z' }]);
    case 'sponsor-proposals': return ok([]);
    default: return method === 'GET' ? notFound() : { status: 204 };
  }
}

function engineRegistrationRoutes(request: Request): Reply {
  const { method, parts, query } = request;
  const [, , rawName, action] = parts;
  const all = [EDGE_SOLVER, PAUSED_SOLVER, PENDING_REGISTRATION, SHARED_SOLVER, EDGE_SOLVER_OLD].map((registration) => localize(registration));
  if (!rawName) return ok({ registrations: query.get('review') === 'true' ? all.filter((item) => item.status === 'pending_review') : all });
  const name = decodeURIComponent(rawName);
  const found = all.find((item) => item.name === name && item.version === query.get('version') && item.namespace === query.get('namespace'))
    ?? all.find((item) => item.name === name);
  if (!found) return notFound('Engine registration not found');
  if (action === 'report') {
    const probe = name === 'paused-solver' ? REPORT_FAILED : name === 'region-solver' ? REPORT_PENDING : REPORT_VERIFIED;
    return ok(localize(registrationReport(found, probe)));
  }
  if (!action && method === 'GET') {
    return ok(localize({
      apiVersion: 'bim/v1', kind: 'EngineRegistration', metadata: { namespace: found.namespace, name: found.name, version: found.version },
      spec: {
        engine: { namespace: found.namespace, name: found.name, version: found.version, digest: found.digest }, endpoint: 'https://edge.example.org',
        protocol: { id: 'bim-engine/v1', mediaType: 'application/json', digest: QOS_PROFILE.protocolDigest },
        mappings: { request: '/internal/v1/binding-problems', health: '/health', openapi: '/openapi.json' }, auth: { scheme: 'bearer' }, openapi: OPENAPI_DOCUMENT,
      },
    }));
  }
  return ok(found);
}

function adminRoutes(request: Request): Reply {
  const { parts, query } = request;
  const path = parts.slice(2).join('/');
  const [head, id] = parts.slice(2);
  switch (path) {
    case 'overview': return ok(ADMIN_OVERVIEW);
    case 'queues': return ok(queuesAt(Date.parse(NOW)));
    case 'moderation': return ok(MODERATION);
    case 'errors/overview': return ok(localize(ERROR_OVERVIEW));
    case 'maintenance/preview': return ok({ expiredArtifacts: 2, expiredApiKeys: 1, terminalJobs: 14, abandonedJobs: 1, terminalJobCutoff: '2025-10-09T00:00:00Z' });
    case 'errors': return ok({ items: ERRORS, total: ERRORS.length, limit: 50, offset: 0 });
    case 'audit': return ok({ ...AUDIT, total: AUDIT.events.length });
    case 'users': {
      const search = (query.get('search') ?? '').toLowerCase();
      const matching = ACCOUNTS.filter((account) => !search || account.username.includes(search) || account.email.includes(search) || account.id === query.get('search'));
      return ok(userPage(matching, { total: matching.length, offset: 0, limit: 50 }));
    }
    default: break;
  }
  if (head === 'users' && id) {
    const account = accountOf(id);
    if (!account) return notFound('No such account.');
    const tail = parts.slice(4).join('/');
    if (!tail) return ok(account);
    if (tail === 'subscription') return ok(subscriptionOf(account, {}));
    if (tail === 'usage') return ok(adminUsageOf(account.plan));
  }
  return notFound('not mocked');
}

/** The first path segments the gateway only answers to a session. */
const SESSION_ONLY = new Set(['users', 'admin', 'notifications', 'organizations', 'jobs', 'engines', 'engine-registrations', 'artifacts', 'snapshots', 'instances', 'analysis', 'verifier']);

function route(request: Request): Reply | null {
  const { method, parts } = request;
  const [first, area, second, third] = parts;

  if (first === 'health') return parts[1] === 'ready'
    ? ok({ status: 'ready', dependencies: { database: 'ok', redis: 'not-required', sphere: 'configured', space: 'configured' } })
    : ok({ status: 'ok' });
  if (first !== 'v1') return null;

  switch (area) {
    case 'auth': return second === 'refresh' ? ok({ access_token: 'gallery-access-2', refresh_token: 'gallery-refresh-2', token_type: 'bearer', expires_in: 900 }) : null;
    case 'users': return second === 'me' ? userRoutes(request) : null;
    case 'notifications':
      if (!second) return ok(NOTIFICATIONS);
      if (second === 'preferences') return ok({ inbox: true, email_contract_changes: true, email_invitations: true, email_job_failures: false });
      return null;
    case 'pricing':
      if (second === 'catalog') return ok(catalogFixture);
      if (second === 'current') return ok(CURRENT_FIXTURE);
      return null;
    case 'organizations': return organizationRoutes(request);
    case 'artifacts': return artifactRoutes(request);
    case 'engine-registrations': return engineRegistrationRoutes(request);
    case 'admin': return adminRoutes(request);
    case 'explore':
      if (second === 'projects') return ok(PUBLIC_PROJECTS);
      if (second === 'publications') return ok(PUBLIC_PUBLICATIONS);
      if (second === 'engines') return ok({ engines: PUBLIC_ENGINES });
      return null;
    case 'engines':
      if (!second) return ok({ engines: OWN_ENGINES });
      if (second === 'revisions') return ok({ revisions: [] });
      return null;
    case 'profiles': return ok({ profiles: [PROFILE] });
    case 'dialects': return ok({ dialects: DIALECTS });
    case 'resources': return ok({ resources: REGISTERED });
    case 'schemas': return ok(schemaOf(decodeURIComponent(second ?? 'Instance')));
    case 'examples': return second ? { status: 200, type: 'application/zip', bytes: request.archive } : ok({ examples: Object.keys(LESSONS) });
    case 'resolve':
      if (parts[4] === 'content') return ok(RESOLVED.document);
      return ok({ ...RESOLVED, kind: second, digest: third });
    case 'verifier':
      return ok({
        status: 'verified', digest: (request.body().digest as string | undefined) ?? EDITION, matches: true, verified_at: NOW,
        detail: 'Cryptographically verified against 1 registered entity.',
        entities: [{ entity_type: 'report', id: 'report-1', slug: 'engine-comparison', title_or_name: 'Engine comparison at checkout', organization_slug: 'isa-demo', project_slug: 'qos-benchmarks', created_at: '2026-09-25T09:00:00Z' }],
      });
    case 'validate':
      return ok({
        valid: true, instanceDigest: caseDigest('a'), packageDigest: caseDigest('b'), irDigest: caseDigest('c'), fileDigests: {}, resourceDigests: {}, diagnostics: [],
        compatibleModes: [
          { engine: PUBLIC_ENGINES[0].ref, registration: REGISTRATION, mode: 'sampling', compatible: true },
          { engine: PUBLIC_ENGINES[2].ref, registration: { ...REGISTRATION, name: 'minizinc-deployment' }, mode: 'cp', compatible: true },
          { engine: EDGE_ENGINE.ref, registration: { ...REGISTRATION, name: 'edge-solver-eu' }, mode: 'placement', compatible: false, diagnostics: [{ message: 'It cannot read a RoutingOverlay.' }] },
        ],
        analysis: { tasks: 6, candidates: 24, constraints: 2, placement: false, bindingSpace: '125892' },
      });
    case 'snapshots':
      if (third === 'archive') return { status: 200, type: 'application/zip', bytes: request.archive };
      return SNAPSHOT_PAY[second] ? ok(snapshotView(second)) : notFound('Snapshot not found');
    case 'instances':
      if (!second) return ok({ id: S3, irDigest: caseDigest('c') }, 201);
      if (third === 'ir') return ok(localize(irDocument(SNAPSHOT_PAY[second] ?? 8)));
      if (third === 'source') return { status: 200, type: 'application/zip', bytes: request.archive };
      return SNAPSHOT_PAY[second] ? ok(snapshotPins(second)) : notFound('Snapshot not found');
    case 'jobs': {
      if (!second) return method === 'POST' ? ok({ id: JOB_ID(9), status: 'queued', irDigest: caseDigest('c') }, 202) : ok(OWN_JOBS);
      if (third === 'instance') return ok(INSTANCE);
      if (third === 'ir') return ok(localize(irDocument(8)));
      if (third === 'report') return ok(localize({ ...JOB_REPORT, id: second }));
      if (third === 'analysis') return ok(localize({ ...NEIGHBORHOOD, jobId: second }));
      const detail = jobDetail(second);
      return detail ? ok(localize(detail)) : notFound('Job not found.');
    }
    case 'analysis':
      if (second === 'sources') return ok({ items: ARCHIVE_SOURCES, nextCursor: null });
      if (second === 'query') return ok(archiveAnswer(request.body() as unknown as ArchiveQuery));
      if (second === 'candidate') return ok(candidateOf((request.body() as unknown as ArchiveQuery).selected === ID_FASTPAY ? ROWS.fastpay : ROWS.payco));
      return null;
    default: return null;
  }
}

/** Answers the API origin of the page: a signed-in administrator, or nobody when `session` is `none`. */
export async function installMockApi(page: Page, session: Session): Promise<MockHandle> {
  const handle: MockHandle = { unmocked: [] };
  await page.clock.setFixedTime(new Date(NOW));
  if (session === 'admin') {
    await page.addInitScript(() => {
      localStorage.setItem('openbinding-access-token', 'gallery-access');
      localStorage.setItem('openbinding-refresh-token', 'gallery-refresh');
    });
  }
  const zip = new JSZip();
  zip.file('instance.json', '{"apiVersion":"bim/v1","kind":"Instance"}');
  zip.file('application.json', '{"kind":"Application"}');
  const archive = await zip.generateAsync({ type: 'nodebuffer' });

  await page.route(`${API}/**`, async (call: Route) => {
    const request = call.request();
    const url = new URL(request.url());
    const parts = url.pathname.split('/').filter(Boolean);
    const known: Request = {
      method: request.method(), parts, query: url.searchParams, archive,
      body: () => {
        try {
          return (request.postDataJSON() ?? {}) as Record<string, unknown>;
        } catch {
          return {};
        }
      },
    };
    if (session === 'none' && parts[0] === 'v1' && SESSION_ONLY.has(parts[1])) {
      await call.fulfill({ status: 401, json: { detail: { code: 'not_authenticated', error: 'Authentication required.' } } });
      return;
    }
    const reply = route(known);
    if (!reply) {
      handle.unmocked.push(`${known.method} ${url.pathname}`);
      await call.fulfill({ status: 404, json: { detail: 'not mocked' } });
    } else if (reply.status === 204) {
      await call.fulfill({ status: 204 });
    } else if (reply.bytes) {
      await call.fulfill({ status: reply.status ?? 200, contentType: reply.type ?? 'application/octet-stream', body: reply.bytes });
    } else if (reply.text !== undefined) {
      await call.fulfill({ status: reply.status ?? 200, contentType: reply.type ?? 'text/plain', body: reply.text });
    } else {
      await call.fulfill({ status: reply.status ?? 200, json: reply.json });
    }
  });
  return handle;
}
