import JSZip from 'jszip';
import type { Page, Route } from '@playwright/test';
import type { AdminUserView } from '../../src/api/auth';
import type { Job } from '../../src/api/platform';
import { digestOf as caseDigest, irDocument, sourceContents } from '../../src/pages/Cases/fixtures';
import { CURRENT_FIXTURE, catalogFixture } from '../../src/pages/Pricing/pricingFixture';
import {
  AUDIT, ERROR_EVENTS, ERROR_OVERVIEW, MODERATION, OVERVIEW, USERS, queuesAt, subscriptionOf, usageOf as adminUsageOf, userPage,
} from '../../src/test/fixtures/admin';
import {
  EDGE_SOLVER, EDGE_SOLVER_OLD, OPENAPI_DOCUMENT, PAUSED_SOLVER, QOS_PROFILE,
  REPORT_FAILED, REPORT_PENDING, REPORT_VERIFIED, SHARED_SOLVER, SOLVER_IN_REVIEW, reportOf as registrationReport,
} from '../../src/test/fixtures/engines';
import { NEIGHBORHOOD, REGISTRATION, RUN_REFS, SOLUTION, detailOf as jobDetailOf, jobOf } from '../../src/test/fixtures/jobs';
import { resourceOf, resourceRevisionOf } from '../../src/test/fixtures/resources';
import {
  RANDOM_SEARCH, REVISION_2, VERSION_ID, analyticsFixture, cellsFixture, revisionFixture, runFixture, studyFixture,
} from '../../src/test/fixtures/studies';
import {
  bpmnContent, catalogContent, catalogRangesContent, goalContent, itemOf, rulesContent, versionOf,
} from './libraryFixtures';

// One mock of the gateway for the whole QA gallery: a platform administrator of a RESEARCH (institutional) account, one organization
// with problems and a project that has runs, studies and a library behind it, and everything the public screens read.
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
  created_at: '2026-01-10T00:00:00Z', cas_verified: true,
};

/** The accounts of the administration screens: the ids the audit and overview fixtures point at, on example.org like the rest of the gallery. */
const ACCOUNTS: AdminUserView[] = USERS.map((user) => ({
  ...user, email: user.id === ME_ID ? ME.email : `${user.username.replace('.', '-')}@example.org`, plan: user.id === ME_ID ? 'RESEARCH' : user.plan,
}));
const accountOf = (id: string) => ACCOUNTS.find((account) => account.id === id);

const org = (id: string, slug: string, name: string, role: 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER', over: Record<string, unknown> = {}) => ({
  id, slug, name, parent_id: null, effective_role: role, created_at: '2026-03-03T00:00:00Z', ...over,
});
const ORGANIZATIONS = [
  org('org-isa-demo', 'isa-demo', 'ISA Demo Group', 'OWNER'),
  org('org-qos-lab', 'qos-lab', 'QoS Lab', 'OWNER', { parent_id: 'org-isa-demo', created_at: '2026-03-10T00:00:00Z' }),
  org('org-partner-lab', 'partner-lab', 'Partner Lab', 'ADMIN', { created_at: '2026-07-01T00:00:00Z' }),
  org('org-read-lab', 'read-lab', 'Read Lab', 'VIEWER', { created_at: '2026-05-01T00:00:00Z' }),
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
  features: { repository: true, runs: true, studies: true, generator: true, federatedEngines: true, collaboration: true, apiAccess: true },
  capabilities: {
    maxProblems: null, maxCollections: null, maxRepositoryStorage: null, solverHours: 100, maxRunMinutes: 30, maxConcurrentRuns: 4,
    maxStudyCells: 5000, generatedInstances: 100_000, maxInstancesPerGeneration: 10_000, maxFederatedEngines: 3, maxPrivateProjects: 10, maxApiKeys: 10,
  },
};

const NOTIFICATIONS = [
  {
    id: 'n1', kind: 'contract.changed', subject: 'Your OpenBinding agreement changed', body: 'Plan: FREE → RESEARCH. Add-ons: {} → {}. Reason: institutional_agreement.',
    payload: { reason: 'institutional_agreement', previous: { plan: 'FREE', addOns: {} }, current: { plan: 'RESEARCH', addOns: {} }, pricingVersion: '0.2.0' },
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
    permissions: ['jobs:read', 'projects:read', 'studies:read'], engine_access: { all: true, engines: [] },
    boundary: { methods: ['GET'], organizations: ['isa-demo'], projects: ['qos-benchmarks'], resource_kinds: ['runs', 'studies'], slugs: null },
  },
  {
    id: 'k2', name: 'run-fixed-engine', prefix: 'obk_demo0002', created_at: '2026-09-10T00:00:00Z', last_used_at: null, expires_at: null,
    permissions: ['engines:execute', 'engines:read', 'problems:read', 'jobs:read'],
    engine_access: { all: false, engines: [{ namespace: 'bim.builtin', name: 'random-search', version: '1.0.0', digest: ENGINE_DIGEST }] }, boundary: {},
  },
];

// -- The language: the profile with the roles it asks for and the installed dialects

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

// -- Problems, their versions and compilations

const PROBLEM = {
  id: 'case-checkout-flow', organization_id: 'org-isa-demo', slug: 'checkout-flow', name: 'Checkout flow', description: 'Payments with authentication, stock and shipping in parallel.',
  created_by_id: ME_ID, created_at: '2026-04-02T00:00:00Z', updated_at: '2026-08-20T10:05:00Z',
};
const DRAFT_PROBLEM = {
  ...PROBLEM, id: 'case-placement-draft', slug: 'placement-draft', name: 'Placement draft', description: 'Where the services may run: no version yet.',
  created_at: '2026-09-28T00:00:00Z', updated_at: '2026-09-28T00:00:00Z',
};
const PROBLEM_REVISIONS = [revisionFixture(2, { package_size: 48_213 }), revisionFixture(1, { package_size: 46_100 })];
const latestOf = (problem: typeof PROBLEM) => (problem.id === PROBLEM.id
  ? { id: PROBLEM_REVISIONS[0].id, revision: 2, package_digest: PROBLEM_REVISIONS[0].package_digest, created_at: PROBLEM_REVISIONS[0].created_at }
  : null);
/** How many candidates the payment task has in each version: what their compiled forms differ in. */
const PAY_OF: Record<string, number> = { 1: 5, 2: 8 };
const revisionDetail = (revision: typeof PROBLEM_REVISIONS[number]) => ({
  ...revision, document: { apiVersion: 'bim/v1', kind: 'Instance', metadata: { name: 'checkout' } }, compilations: [],
  files: [
    { path: 'instance.json', role: 'root', digest: caseDigest('1'), media_type: 'application/json' },
    { path: 'application.json', role: 'application', resource_id: 'application', digest: caseDigest('2'), media_type: 'application/json' },
  ],
  resource_digests: { application: caseDigest('2') },
});
const COMPATIBLE_MODES = () => [
  { engine: PUBLIC_ENGINES[0].ref, registration: REGISTRATION, mode: 'sampling', compatible: true },
  { engine: PUBLIC_ENGINES[2].ref, registration: { ...REGISTRATION, name: 'minizinc-deployment' }, mode: 'cp', compatible: true },
  { engine: EDGE_ENGINE.ref, registration: { ...REGISTRATION, name: 'edge-solver-eu' }, mode: 'placement', compatible: false, diagnostics: [{ message: 'It cannot read a RoutingOverlay.' }] },
];
const ANALYSIS = { tasks: 6, candidates: 24, constraints: 2, placement: false, bindingSpace: '125892' };
const compilationOf = (revision: string) => ({
  id: `compilation-${revision}`, revision_id: `rev-checkout-${revision}`, compilation_digest: caseDigest('9'), compiler_digest: caseDigest('8'), ir_digest: caseDigest('c'),
  binding_space: ANALYSIS.bindingSpace, created_at: '2026-08-20T10:05:00Z', current: true, toolchain: {}, analysis: ANALYSIS,
  resources: { application: { role: 'application', path: 'application.json', apiVersion: 'qos-binding/v1', kind: 'Application' } },
  compatible_modes: COMPATIBLE_MODES(),
});
const uploadOf = (problem: typeof PROBLEM, revision: number, created: boolean) => ({
  problem: { ...problem, latest_revision: latestOf(problem) }, revision: revisionFixture(revision), created,
  compilation: { ...compilationOf(String(revision)), compatible_modes: undefined },
});

// -- Jobs

const JOB_ID = (n: number) => `00000000-0000-4000-8000-0000000000a${n}`;
const mine = { organization_id: 'org-isa-demo', ...RUN_REFS };
const JOBS = {
  feasible: jobOf(JOB_ID(1), 'random-search', 'completed', 'FEASIBLE', '2026-09-30T09:00:00Z', '2026-09-30T09:01:05Z', mine),
  running: jobOf(JOB_ID(2), 'minizinc', 'running', null, '2026-10-09T08:00:00Z', null, mine),
  queued: jobOf(JOB_ID(3), 'random-search', 'queued', null, '2026-10-09T11:40:00Z', null, mine),
  failed: jobOf(JOB_ID(4), 'evolutionary', 'failed', 'UNKNOWN', '2026-10-07T15:00:00Z', '2026-10-07T15:00:20Z', mine),
  cancelled: jobOf(JOB_ID(5), 'random-search', 'cancelled', null, '2026-10-06T12:00:00Z', '2026-10-06T12:00:03Z', mine),
  infeasible: jobOf(JOB_ID(6), 'minizinc', 'completed', 'INFEASIBLE', '2026-10-01T09:00:00Z', '2026-10-01T09:00:40Z', mine),
  routed: jobOf(JOB_ID(7), 'evolutionary-heuristics', 'completed', 'OPTIMAL', '2026-10-03T11:00:00Z', '2026-10-03T11:00:12Z', mine),
  theirs: jobOf(JOB_ID(8), 'evolutionary', 'completed', 'OPTIMAL', '2026-10-02T10:00:00Z', '2026-10-02T10:02:00Z', { ...mine, created_by: { id: 'user-ana', username: 'ana' } }),
};
/** The runs of the organization `isa-demo`, newest first: every member reads them. */
const ORG_JOBS: Job[] = [JOBS.queued, JOBS.running, JOBS.failed, JOBS.cancelled, JOBS.routed, JOBS.theirs, JOBS.infeasible, JOBS.feasible];

const SOLUTION_EN = localize(SOLUTION);
function jobDetail(id: string): Record<string, unknown> | null {
  const summary = ORG_JOBS.find((row) => row.id === id);
  const detail = jobDetailOnly(id);
  return summary && detail ? { ...summary, ...detail } : null;
}

function jobDetailOnly(id: string): Record<string, unknown> | null {
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

// -- Studies and the analysis

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
      { id: PROBLEM.id, slug: 'checkout-flow', name: 'Checkout flow', revision: 1, cardinality: '15849', log10: 4.2, tasks: 6, breakdown: { authenticate: 4 } },
      { id: PROBLEM.id, slug: 'checkout-flow', name: 'Checkout flow', revision: 2, cardinality: '125892', log10: 5.1, tasks: 6, breakdown: { authenticate: 4 } },
    ],
  },
}));

// -- Public screens

/** The template packages the gateway serves (GET /v1/bim/templates). */
const TEMPLATE_PATHS = ['demo/01_simple_seq', 'demo/02_parallel', 'demo/03_xor_choice', 'demo/05_multi_obj', 'demo/15_bpmn_complete', 'placement/01_small_placement'];

// -- Administration

/** The platform in numbers, counted from the same accounts, organizations and projects the other screens list. */
const ADMIN_OVERVIEW = {
  ...OVERVIEW,
  counts: { users: ACCOUNTS.length, apiKeys: 9, identities: 3, organizations: ORGANIZATIONS.length, projects: 4, problems: 2, problemRevisions: 2, studies: 2, studyRuns: 1, artifacts: 12 },
  contracts: { FREE: 3, RESEARCH: 2, LAB: 1 },
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
  const { parts } = request;
  const [, , , , , sub, subId, action, actionId, tail, tailId] = parts;
  const current = (PROJECTS[orgSlug] ?? []).find((item) => item.slug === projectSlug);
  if (!current) return notFound('Project not found.');
  if (!sub) return ok(current);
  const filled = projectSlug === 'qos-benchmarks';

  switch (sub) {
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
      if (action !== 'revisions') return notFound('Not mocked.');
      return ok(localize(subId === 'notes' ? [] : [
        resourceRevisionOf(found, 2, { title: 'Latency probes', samples: 5 }),
        resourceRevisionOf(found, 1, { title: 'Latency probes', samples: 3 }),
      ]));
    }
    default:
      return notFound('Not mocked.');
  }
}

/** `/v1/organizations/{org}/problems/…`: the problems of `isa-demo`, their versions, sources and compilations. */
function problemRoutes(request: Request, orgSlug: string): Reply {
  const { method, parts } = request;
  const [, , , , problemSlug, sub, revisionRef, tail, compilationId, last] = parts;
  const problems = orgSlug === 'isa-demo' ? [PROBLEM, DRAFT_PROBLEM] : [];
  if (!problemSlug) {
    if (method === 'POST') return ok(uploadOf({ ...DRAFT_PROBLEM, id: 'case-uploaded', slug: 'uploaded', name: 'Uploaded problem' }, 1, true), 201);
    return ok({ problems: problems.map((item) => ({ ...item, latest_revision: latestOf(item) })), total: problems.length, limit: 200, offset: 0 });
  }
  const problem = problems.find((item) => item.slug === problemSlug || item.id === problemSlug);
  if (!problem) return notFound('Problem not found.');
  if (!sub) return ok({ ...problem, latest_revision: latestOf(problem) });
  if (sub !== 'revisions') return notFound('Not mocked.');
  const revisions = problem.id === PROBLEM.id ? PROBLEM_REVISIONS : [];
  if (!revisionRef) {
    if (method === 'POST') return ok(uploadOf(problem, revisions.length + 1, true), 201);
    return ok(revisions);
  }
  const revision = revisions.find((item) => String(item.revision) === revisionRef || item.id === revisionRef || item.package_digest === revisionRef);
  if (!revision) return notFound('Problem revision not found.');
  if (!tail) return ok(revisionDetail(revision));
  if (tail === 'source') return { status: 200, bytes: request.archive, type: 'application/vnd.bim+zip' };
  if (tail === 'compilation') return ok(compilationOf(String(revision.revision)));
  if (tail === 'compilations' && compilationId && last === 'ir') {
    return ok({ id: compilationId, ir_digest: caseDigest('c'), ir: irDocument(PAY_OF[revision.revision] ?? 8), source_map: {} });
  }
  return notFound('Not mocked.');
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
    case 'library': {
      const own = found.slug === 'isa-demo' ? LIBRARY : [];
      return ok(query.get('include_public') === 'true' ? [...own, external] : own);
    }
    case 'projects':
      if (!projectSlug) return ok(PROJECTS[found.slug] ?? []);
      return projectRoutes(request, found.slug, projectSlug);
    case 'problems': return problemRoutes(request, found.slug);
    case 'runs': return runRoutes(request, found.slug);
    default: return notFound('Not mocked.');
  }
}

/** `/v1/organizations/{org}/runs*`: the runs of `isa-demo`; another organization has none. */
function runRoutes(request: Request, orgSlug: string): Reply {
  const { method, parts, query } = request;
  const [, , , , runId, action] = parts;
  const rows = orgSlug === 'isa-demo' ? ORG_JOBS : [];
  if (!runId) {
    if (method === 'POST') return ok({ id: JOB_ID(9), status: 'queued', irDigest: caseDigest('c') }, 202);
    const filtered = rows.filter((row) => (!query.get('revision') || row.revision?.id === query.get('revision')) && (!query.get('problem') || row.problem?.slug === query.get('problem')));
    const limit = Number(query.get('limit') ?? 50);
    return ok({ runs: filtered.slice(0, limit), total: filtered.length });
  }
  if (action === 'neighborhood') return ok(localize({ ...NEIGHBORHOOD, jobId: runId }));
  const detail = orgSlug === 'isa-demo' ? jobDetail(runId) : null;
  return detail ? ok(localize(detail)) : notFound('Run not found.');
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
  if (sub === 'versions') {
    const versions = VERSIONS[item.id] ?? [];
    if (!subId) return ok(versions);
    if (action === 'content') {
      const content = CONTENT[item.id];
      return { status: 200, type: 'text/plain', text: typeof content === 'string' ? content : JSON.stringify(content) };
    }
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
    case 'api-keys': return subId ? { status: 204 } : ok({ api_keys: API_KEYS });
    case 'identities': return ok([{ id: 'i1', provider: 'us-cas', subject: 'arivera1', verifiedAt: '2026-09-01T00:00:00Z' }]);
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
    case 'maintenance/preview': return ok({ expiredApiKeys: 1, terminalJobs: 14, abandonedJobs: 1, terminalJobCutoff: '2025-10-09T00:00:00Z' });
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
const SESSION_ONLY = new Set(['users', 'admin', 'notifications', 'organizations', 'engines', 'engine-registrations', 'artifacts']);

function route(request: Request): Reply | null {
  const { parts } = request;
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
    case 'engines':
      if (!second) return ok({ engines: OWN_ENGINES });
      if (second === 'revisions') return ok({ revisions: [] });
      if (second === 'protocol') return ok({ profiles: [PROFILE] });
      return null;
    case 'bim':
      if (second === 'templates') return third ? { status: 200, type: 'application/vnd.bim+zip', bytes: request.archive } : ok({ templates: TEMPLATE_PATHS });
      if (second === 'validate') {
        return ok({
          valid: true, instanceDigest: caseDigest('a'), packageDigest: caseDigest('b'), irDigest: caseDigest('c'), fileDigests: {}, resourceDigests: {}, diagnostics: [],
          compatibleModes: COMPATIBLE_MODES(), analysis: ANALYSIS,
          ...(request.query.get('include') === 'ir' ? { ir: localize(irDocument(8)), sourceMap: {} } : {}),
        });
      }
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
    // The engine catalogue is public: a visitor gets the public engines.
    if (session === 'none' && known.method === 'GET' && parts.join('/') === 'v1/engines') {
      await call.fulfill({ status: 200, json: { engines: PUBLIC_ENGINES } });
      return;
    }
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
