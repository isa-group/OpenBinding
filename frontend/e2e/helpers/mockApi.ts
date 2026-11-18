import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import JSZip from 'jszip';
import type { Page, Route } from '@playwright/test';
import type { AdminUserView } from '../../src/modules/core/api/account';
import type { Job } from '../../src/modules/run/api/runsClient';
import type { Study, StudyCell, StudyRun } from '../../src/modules/study/api/studiesApi';
import type { Problem, ProblemRevision } from '../../src/modules/problem/api/problemsClient';
import { digestOf as caseDigest, compiledDocument } from '../../src/modules/problem/utils/fixtures';
import { PLANS_PRICING_FIXTURE } from '../../src/test/fixtures/plansPricing';
import {
  AUDIT,
  ERROR_EVENTS,
  ERROR_OVERVIEW,
  MODERATION,
  OVERVIEW,
  USERS,
  queuesAt,
  subscriptionOf,
  usageOf as adminUsageOf,
  userPage,
} from '../../src/test/fixtures/admin';
import {
  EDGE_SOLVER,
  EDGE_SOLVER_OLD,
  OPENAPI_DOCUMENT,
  PAUSED_SOLVER,
  QOS_PROFILE,
  REPORT_FAILED,
  REPORT_PENDING,
  REPORT_VERIFIED,
  SHARED_SOLVER,
  SOLVER_IN_REVIEW,
  reportOf as registrationReport,
} from '../../src/test/fixtures/engines';
import {
  NEIGHBORHOOD,
  REGISTRATION,
  RESULT,
  RUN_REFS,
  SOLUTION,
  detailOf as jobDetailOf,
  jobOf,
} from '../../src/test/fixtures/jobs';
import {
  RANDOM_SEARCH,
  REVISION_2,
  analyticsFixture,
  cellsFixture,
  revisionFixture,
  runFixture,
  studyFixture,
} from '../../src/test/fixtures/studies';
import { presetPage } from '../../src/test/fixtures/presets';
import { compositionStore, type CompositionSeed, type CompositionStore } from './mockCompositions';
import { snapshotRoutes, sphereProblemRoutes, sphereRoutes, tomatometerListed } from './sphereMock';

// One mock of the gateway for the whole QA gallery: a platform administrator of a RESEARCH (institutional) account, one organization
// with compositions, problems, runs and studies, and everything the public screens read.
// Every date is fixed, so two runs of the gallery draw the same pictures. A request nobody answers is a 404 and is recorded.

export const API = 'http://localhost:8000';

/** The instant every page of the gallery believes it is. */
export const NOW = '2026-10-09T12:00:00Z';
const hoursAgo = (hours: number) => new Date(Date.parse(NOW) - hours * 3_600_000).toISOString();

/**
 * Who the page is: the administrator from the start, nobody, or a visitor whom `POST /v1/auth/login` signs in as the administrator
 * (a request is signed in when it carries the access token).
 */
export type Session = 'admin' | 'none' | 'visitor';

export interface MockHandle {
  /** Requests the mock did not recognise, as `METHOD /path`. */
  unmocked: string[];
}

// -- People and organizations

const ME_ID = '00000000-0000-4000-8000-000000000005';
const ME = {
  id: ME_ID,
  username: 'alex.rivera',
  email: 'alex.rivera@example.org',
  role: 'admin',
  is_active: true,
  plan: 'RESEARCH',
  created_at: '2026-01-10T00:00:00Z',
  cas_verified: true,
};

/** The accounts of the administration screens: the ids the audit and overview fixtures point at, on example.org like the rest of the gallery. */
const ACCOUNTS: AdminUserView[] = USERS.map(user => ({
  ...user,
  email: user.id === ME_ID ? ME.email : `${user.username.replace('.', '-')}@example.org`,
  plan: user.id === ME_ID ? 'RESEARCH' : user.plan,
}));
const accountOf = (id: string) => ACCOUNTS.find(account => account.id === id);

const org = (
  id: string,
  slug: string,
  name: string,
  role: 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER',
  over: Record<string, unknown> = {}
) => ({
  id,
  slug,
  name,
  parent_id: null as string | null,
  effective_role: role,
  description: '',
  avatar: { url: null, kind: null, bg_color: null, fg_color: null },
  stats: { members: 3, sub_organizations: 0, compositions: 2, problems: 1, runs: 4, studies: 1 },
  created_at: '2026-03-03T00:00:00Z',
  ...over,
});
const ORGANIZATIONS = [
  org('org-isa-demo', 'isa-demo', 'ISA Demo Group', 'OWNER'),
  org('org-qos-lab', 'qos-lab', 'QoS Lab', 'OWNER', {
    parent_id: 'org-isa-demo',
    created_at: '2026-03-10T00:00:00Z',
  }),
  org('org-partner-lab', 'partner-lab', 'Partner Lab', 'ADMIN', {
    created_at: '2026-07-01T00:00:00Z',
  }),
  org('org-read-lab', 'read-lab', 'Read Lab', 'VIEWER', { created_at: '2026-05-01T00:00:00Z' }),
];

const member = (
  orgId: string,
  key: string,
  userId: string,
  role: string,
  created = '2026-03-04T00:00:00Z'
) => ({
  id: `${orgId}-${key}`,
  organization_id: orgId,
  user_id: userId,
  username: key,
  email: `${key.replace('.', '-')}@example.org`,
  role,
  created_at: created,
});
const MEMBERS: Record<string, ReturnType<typeof member>[]> = {
  'isa-demo': [
    member('org-isa-demo', 'alex.rivera', ME_ID, 'OWNER'),
    member(
      'org-isa-demo',
      'sam.okafor',
      '00000000-0000-4000-8000-000000000002',
      'MEMBER',
      '2026-04-12T00:00:00Z'
    ),
    member(
      'org-isa-demo',
      'jordan.lee',
      '00000000-0000-4000-8000-000000000003',
      'VIEWER',
      '2026-05-20T00:00:00Z'
    ),
  ],
  'qos-lab': [
    member(
      'org-qos-lab',
      'sam.okafor',
      '00000000-0000-4000-8000-000000000002',
      'ADMIN',
      '2026-04-15T00:00:00Z'
    ),
  ],
};

const ORG_AUDIT = [
  {
    id: 'e0000000-0000-0000-0000-0000000000e5',
    organizationId: 'org-isa-demo',
    actorId: ME_ID,
    action: 'organization.invitation.created',
    targetType: 'OrganizationInvitation',
    targetId: 'inv-1',
    detail: {},
    createdAt: '2026-10-08T09:15:00Z',
  },
  {
    id: 'e0000000-0000-0000-0000-0000000000e4',
    organizationId: 'org-isa-demo',
    actorId: ME_ID,
    action: 'organization.members.batch_updated',
    targetType: 'Organization',
    targetId: 'org-isa-demo',
    detail: { changes: [{ user_id: '00000000-0000-4000-8000-000000000002', role: 'ADMIN' }] },
    createdAt: '2026-09-25T10:00:00Z',
  },
  {
    id: 'e0000000-0000-0000-0000-0000000000e3',
    organizationId: 'org-isa-demo',
    actorId: ME_ID,
    action: 'problem.created',
    targetType: 'BindingCase',
    targetId: 'case-flujo-checkout',
    detail: {},
    createdAt: '2026-04-01T08:30:00Z',
  },
  {
    id: 'e0000000-0000-0000-0000-0000000000e2',
    organizationId: 'org-isa-demo',
    actorId: ME_ID,
    action: 'organization.created',
    targetType: 'Organization',
    targetId: 'org-isa-demo',
    detail: {},
    createdAt: '2026-03-03T08:00:00Z',
  },
];

// -- What the plan allows (nothing is counted per account)

const USAGE = {
  plan: 'RESEARCH',
  contract_pending: false,
  features: {
    repository: true,
    runs: true,
    studies: true,
    generator: true,
    federatedEngines: true,
    collaboration: true,
    apiAccess: true,
  },
  capabilities: {
    maxProblems: null,
    maxCollections: null,
    maxRepositoryStorage: null,
    solverHours: 100,
    maxRunMinutes: 30,
    maxConcurrentRuns: 4,
    maxStudyCells: 5000,
    generatedInstances: 100_000,
    maxInstancesPerGeneration: 10_000,
    maxFederatedEngines: 3,
    maxPrivateProjects: 10,
    maxApiKeys: 10,
  },
};

const NOTIFICATIONS = [
  {
    id: 'n1',
    kind: 'contract.changed',
    subject: 'Your OpenBinding agreement changed',
    body: 'Plan: FREE → RESEARCH. Add-ons: {} → {}. Reason: institutional_agreement.',
    payload: {
      reason: 'institutional_agreement',
      previous: { plan: 'FREE', addOns: {} },
      current: { plan: 'RESEARCH', addOns: {} },
      pricingVersion: '0.2.0',
    },
    read_at: null as string | null,
    created_at: hoursAgo(5),
  },
  {
    id: 'n2',
    kind: 'job.finished',
    subject: 'Job completed',
    body: 'Job 0000…a1 finished with FEASIBLE.',
    payload: {},
    read_at: hoursAgo(20),
    created_at: hoursAgo(26),
  },
  {
    id: 'n3',
    kind: 'organization.invitation',
    subject: 'You were invited to Partner Lab',
    body: 'Priya invited you as ADMIN.',
    payload: {},
    read_at: null,
    created_at: hoursAgo(2),
  },
];

/** A pricing token shaped like the gateway's: three dot-separated parts, the middle one a JSON payload that does not expire in our lifetime. */
const PRICING_TOKEN = [
  'header',
  Buffer.from(JSON.stringify({ sub: ME_ID, exp: 4_102_444_800 })).toString('base64'),
  'signature',
].join('.');

const ENGINE_DIGEST = `sha256-${'b2c3d4e5'.repeat(8)}`;
const API_KEYS = [
  {
    id: 'k1',
    name: 'ci-read-results',
    prefix: 'obk_demo0001',
    created_at: '2026-09-01T00:00:00Z',
    last_used_at: '2026-10-08T00:00:00Z',
    expires_at: '2099-12-31T00:00:00Z',
    permissions: ['jobs:read', 'problems:read', 'studies:read'],
    engine_access: { all: true, engines: [] },
    boundary: {
      methods: ['GET'],
      organizations: ['isa-demo'],
      resource_kinds: ['runs', 'studies'],
      slugs: null,
    },
  },
  {
    id: 'k2',
    name: 'run-fixed-engine',
    prefix: 'obk_demo0002',
    created_at: '2026-09-10T00:00:00Z',
    last_used_at: null,
    expires_at: null,
    permissions: ['engines:execute', 'engines:read', 'problems:read', 'jobs:read'],
    engine_access: {
      all: false,
      engines: [
        {
          namespace: 'bim.builtin',
          name: 'random-search',
          version: '1.0.0',
          digest: ENGINE_DIGEST,
        },
      ],
    },
    boundary: {},
  },
];

// -- The language: the profile with the roles it asks for and the installed dialects

const roleOf = (
  kind: string,
  minimum: number,
  maximum?: number,
  extensionTypes: 'none' | 'installed' = 'none'
) => ({
  resourceTypes: [
    { apiVersion: 'qos-binding/v1', kind, minimum, ...(maximum === undefined ? {} : { maximum }) },
  ],
  extensionTypes,
});
const PROFILE = {
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
};

// -- Engines

const engineMode = (id: string, algorithm: string, exact: boolean) => ({
  id,
  profile: 'qos-binding/v1',
  ir: { apiVersion: 'bim/v1', kind: 'BindingProblem' },
  algorithm,
  capabilities: {
    workflowNodes: { selector: 'all' },
    metricScopes: { selector: 'all' },
    aggregations: { selector: 'all' },
    constraints: { selector: 'all' },
    optimization: { selector: 'all' },
    objectiveTypes: { selector: 'all' },
    expressions: { selector: 'all' },
    placement: { selector: 'none' },
    irExtensions: { selector: 'none' },
  },
  optionsSchema: {
    type: 'object',
    properties: {
      time_budget_ms: { type: 'integer', default: 30000, minimum: 1, maximum: 900000, unit: 'ms' },
      iterations: { type: 'integer', default: 100000 },
      seed: { type: 'integer', default: 0 },
    },
    additionalProperties: false,
  },
  limits: { maxTimeBudgetMs: 900000 },
  guarantees: {
    termination: exact ? ['OPTIMAL', 'FEASIBLE', 'INFEASIBLE'] : ['FEASIBLE', 'UNKNOWN'],
    exact,
  },
});
const engineEntry = (
  name: string,
  namespace: string,
  version: string,
  digest: string,
  modes: ReturnType<typeof engineMode>[]
) => {
  const ref = { namespace, name, version, digest };
  return { ...ref, id: `${namespace}/${name}`, ref, modes };
};
export const PUBLIC_ENGINES = [
  engineEntry('random-search', 'bim.builtin', '1.0.0', ENGINE_DIGEST, [
    engineMode('sampling', 'random-search', false),
  ]),
  engineEntry('evolutionary', 'bim.builtin', '1.0.0', `sha256-${'c3d4e5f6'.repeat(8)}`, [
    engineMode('genetic', 'evolutionary', false),
  ]),
  engineEntry('minizinc', 'bim.builtin', '1.0.0', `sha256-${'d4e5f607'.repeat(8)}`, [
    engineMode('cp', 'minizinc', true),
  ]),
];
const EDGE_ENGINE = engineEntry(
  'edge-solver',
  'alex.rivera',
  '0.3.1',
  `sha256-${'f1f2f3f4'.repeat(8)}`,
  [engineMode('tabu', 'tabu-search', false)]
);
const OWN_ENGINES = [...PUBLIC_ENGINES, EDGE_ENGINE];

// -- Problems, their versions and compilations

const PROBLEM = {
  id: 'case-checkout-flow',
  organization_id: 'org-isa-demo',
  slug: 'checkout-flow',
  name: 'Checkout flow',
  description: 'Payments with authentication, stock and shipping in parallel.',
  created_by_id: ME_ID,
  created_at: '2026-04-02T00:00:00Z',
  updated_at: '2026-08-20T10:05:00Z',
};
const DRAFT_PROBLEM = {
  ...PROBLEM,
  id: 'case-placement-draft',
  slug: 'placement-draft',
  name: 'Placement draft',
  description: 'Where the services may run: no version yet.',
  created_at: '2026-09-28T00:00:00Z',
  updated_at: '2026-09-28T00:00:00Z',
};
const PROBLEM_REVISIONS = [
  revisionFixture(2, { package_size: 48_213 }),
  revisionFixture(1, { package_size: 46_100 }),
];
const latestOf = (problem: typeof PROBLEM) =>
  problem.id === PROBLEM.id
    ? {
        id: PROBLEM_REVISIONS[0].id,
        revision: 2,
        package_digest: PROBLEM_REVISIONS[0].package_digest,
        created_at: PROBLEM_REVISIONS[0].created_at,
        origin: 'upload' as const,
      }
    : null;
/** A gateway-produced fixture of src/test/fixtures/core (dump_frontend_fixtures.py), read as JSON. */
const coreFixture = (file: string): Record<string, unknown> =>
  JSON.parse(
    readFileSync(new URL(`../../src/test/fixtures/core/${file}`, import.meta.url), 'utf8')
  );
/** The facts of each version's compilation: what the problem page, the run result and the launcher read. Version 1 and 2 differ. */
const FACTS_OF: Record<string, string> = { 1: 'fms', 2: 'json-complete' };
const factsOf = (revision: number | string) =>
  coreFixture(`${FACTS_OF[String(revision)] ?? 'json-complete'}.facts.json`);
/** The compilation the linked compositions of mockCompositions.ts were evaluated on (core/fms.version.json): its facts are FMS's. */
const FLEET_COMPILATION = (
  coreFixture('fms.version.json').evaluations as Array<{ compilation: { id: string } }>
)[0].compilation.id;
/** The facts of a compilation of a problem version: the fleet's compilation has its own, any other its version's. */
const factsOfCompilation = (compilation: string, revision: number | string) =>
  compilation === FLEET_COMPILATION ? coreFixture('fms.facts.json') : factsOf(revision);
/** What `validate?include=…` adds to the analysis: the IR bytes (shown, never read) and the facts of the package. */
const included = (include: string | null): Record<string, unknown> => {
  const parts = (include ?? '').split(',');
  return {
    ...(parts.includes('ir') ? { ir: compiledDocument(), sourceMap: {} } : {}),
    ...(parts.includes('facts') ? { facts: coreFixture('json-complete.validate.json').facts } : {}),
  };
};
const revisionDetail = (revision: (typeof PROBLEM_REVISIONS)[number]) => ({
  ...revision,
  document: { apiVersion: 'bim/v1', kind: 'Instance', metadata: { name: 'checkout' } },
  compilations: [],
  files: [
    {
      path: 'instance.json',
      role: 'root',
      digest: caseDigest('1'),
      media_type: 'application/json',
    },
    {
      path: 'application.json',
      role: 'application',
      resource_id: 'application',
      digest: caseDigest('2'),
      media_type: 'application/json',
    },
  ],
  resource_digests: { application: caseDigest('2') },
});
const COMPATIBLE_MODES = () => [
  { engine: PUBLIC_ENGINES[0].ref, registration: REGISTRATION, mode: 'sampling', compatible: true },
  {
    engine: PUBLIC_ENGINES[2].ref,
    registration: { ...REGISTRATION, name: 'minizinc-deployment' },
    mode: 'cp',
    compatible: true,
  },
  {
    engine: EDGE_ENGINE.ref,
    registration: { ...REGISTRATION, name: 'edge-solver-eu' },
    mode: 'placement',
    compatible: false,
    diagnostics: [{ message: 'It cannot read a RoutingOverlay.' }],
  },
];
const ANALYSIS = {
  tasks: 6,
  candidates: 24,
  constraints: 2,
  placement: false,
  bindingSpace: '125892',
};
const compilationOf = (revision: string) => ({
  id: `compilation-${revision}`,
  revision_id: `rev-checkout-${revision}`,
  compilation_digest: caseDigest('9'),
  compiler_digest: caseDigest('8'),
  ir_digest: caseDigest('c'),
  binding_space: ANALYSIS.bindingSpace,
  created_at: '2026-08-20T10:05:00Z',
  current: true,
  toolchain: {},
  analysis: ANALYSIS,
  resources: {
    application: {
      role: 'application',
      path: 'application.json',
      apiVersion: 'qos-binding/v1',
      kind: 'Application',
    },
  },
  compatible_modes: COMPATIBLE_MODES(),
});
const uploadOf = (problem: typeof PROBLEM, revision: number, created: boolean) => ({
  problem: { ...problem, latest_revision: latestOf(problem) },
  revision: revisionFixture(revision),
  created,
  compilation: { ...compilationOf(String(revision)), compatible_modes: undefined },
});

// -- Jobs

const JOB_ID = (n: number) => `00000000-0000-4000-8000-0000000000a${n}`;
const mine = { organization_id: 'org-isa-demo', ...RUN_REFS };
const JOBS = {
  feasible: jobOf(
    JOB_ID(1),
    'random-search',
    'completed',
    'FEASIBLE',
    '2026-09-30T09:00:00Z',
    '2026-09-30T09:01:05Z',
    mine
  ),
  running: jobOf(JOB_ID(2), 'minizinc', 'running', null, '2026-10-09T08:00:00Z', null, mine),
  queued: jobOf(JOB_ID(3), 'random-search', 'queued', null, '2026-10-09T11:40:00Z', null, mine),
  failed: jobOf(
    JOB_ID(4),
    'evolutionary',
    'failed',
    'UNKNOWN',
    '2026-10-07T15:00:00Z',
    '2026-10-07T15:00:20Z',
    mine
  ),
  cancelled: jobOf(
    JOB_ID(5),
    'random-search',
    'cancelled',
    null,
    '2026-10-06T12:00:00Z',
    '2026-10-06T12:00:03Z',
    mine
  ),
  infeasible: jobOf(
    JOB_ID(6),
    'minizinc',
    'completed',
    'INFEASIBLE',
    '2026-10-01T09:00:00Z',
    '2026-10-01T09:00:40Z',
    mine
  ),
  routed: jobOf(
    JOB_ID(7),
    'evolutionary-heuristics',
    'completed',
    'OPTIMAL',
    '2026-10-03T11:00:00Z',
    '2026-10-03T11:00:12Z',
    mine
  ),
  theirs: jobOf(
    JOB_ID(8),
    'evolutionary',
    'completed',
    'OPTIMAL',
    '2026-10-02T10:00:00Z',
    '2026-10-02T10:02:00Z',
    { ...mine, created_by: { id: 'user-ana', username: 'ana' } }
  ),
};
/** The runs of the organization `isa-demo`, newest first: every member reads them. */
const ORG_JOBS: Job[] = [
  JOBS.queued,
  JOBS.running,
  JOBS.failed,
  JOBS.cancelled,
  JOBS.routed,
  JOBS.theirs,
  JOBS.infeasible,
  JOBS.feasible,
];

const SOLUTION_EN = SOLUTION;
function jobDetail(id: string): Record<string, unknown> | null {
  const summary = ORG_JOBS.find(row => row.id === id);
  const detail = jobDetailOnly(id);
  return summary && detail ? { ...summary, ...detail } : null;
}

function jobDetailOnly(id: string): Record<string, unknown> | null {
  const completed = { termination: 'FEASIBLE', solutions: [SOLUTION_EN] };
  switch (id) {
    case JOB_ID(1):
      return { ...jobDetailOf(id, 'completed'), result: completed };
    case JOB_ID(2):
      return { ...jobDetailOf(id, 'running') };
    case JOB_ID(3):
      return { ...jobDetailOf(id, 'queued') };
    case JOB_ID(4):
      return { ...jobDetailOf(id, 'failed') };
    case JOB_ID(5):
      return { ...jobDetailOf(id, 'cancelled') };
    case JOB_ID(6):
      return {
        ...jobDetailOf(id, 'completed', {
          result: {
            termination: 'INFEASIBLE',
            solutions: [
              {
                violations: [
                  {
                    constraint: 'sla-latency',
                    message: 'Total latency is 742 ms; at most 600 ms is allowed.',
                  },
                ],
              },
            ],
          },
        }),
      };
    case JOB_ID(7):
      return { ...jobDetailOf(id, 'completed'), result: completed };
    case JOB_ID(8):
      return { ...jobDetailOf(id, 'completed'), result: completed };
    default:
      return null;
  }
}

// -- Studies and the analysis

const STUDY = studyFixture();
const OTHER_STUDY = studyFixture({
  id: 'study-placement',
  slug: 'placement-sweep',
  name: 'Placement sweep',
  description: 'Pools and latencies on the edge.',
  definition: {
    revision_ids: [REVISION_2.id],
    engines: [RANDOM_SEARCH],
    parameter_sets: [{}],
    seeds: [1, 2, 3],
  },
});
const STUDIES = [STUDY, OTHER_STUDY];
const RUN = runFixture();
const CELLS = cellsFixture();
const ANALYTICS = analyticsFixture({
  binding_space: {
    cardinality: '125892',
    log10: 5.1,
    tasks: 6,
    breakdown: {
      authenticate: 4,
      inventory: 5,
      shipping: 3,
      'pay-card': 8,
      'pay-transfer': 4,
      notify: 1,
    },
    case_slug: 'checkout-flow',
    case_name: 'Checkout flow',
    revision: 2,
    cases: [
      {
        id: PROBLEM.id,
        slug: 'checkout-flow',
        name: 'Checkout flow',
        revision: 1,
        cardinality: '15849',
        log10: 4.2,
        tasks: 6,
        breakdown: { authenticate: 4 },
      },
      {
        id: PROBLEM.id,
        slug: 'checkout-flow',
        name: 'Checkout flow',
        revision: 2,
        cardinality: '125892',
        log10: 5.1,
        tasks: 6,
        breakdown: { authenticate: 4 },
      },
    ],
  },
});

// -- Public screens

/** The template packages the gateway serves (GET /v1/bim/templates). */
const TEMPLATE_PATHS = [
  'demo/01_simple_seq',
  'demo/02_parallel',
  'demo/03_xor_choice',
  'demo/05_multi_obj',
  'demo/15_bpmn_complete',
  'placement/01_small_placement',
];

// -- Administration

/** The platform in numbers, counted from the same accounts, organizations and problems the other screens list. */
const ADMIN_OVERVIEW = {
  ...OVERVIEW,
  counts: {
    users: ACCOUNTS.length,
    apiKeys: 9,
    identities: 3,
    organizations: ORGANIZATIONS.length,
    problems: 2,
    problemRevisions: 2,
    runs: 3,
    studies: 2,
    studyRuns: 1,
  },
  contracts: { FREE: 3, RESEARCH: 2, LAB: 1 },
};
const PENDING_REGISTRATION = { ...SOLVER_IN_REVIEW, namespace: 'sam.okafor' };
const emailOfAccount = (id: string | null | undefined) =>
  id ? `${(accountOf(id)?.username ?? 'sam.okafor').replace('.', '-')}@example.org` : null;
const ERRORS = ERROR_EVENTS.map(event => ({
  ...event,
  user_email: emailOfAccount(event.user_id),
  userEmail: emailOfAccount(event.user_id),
}));

// -- The router

interface Reply {
  status?: number;
  json?: unknown;
  text?: string;
  bytes?: Buffer;
  type?: string;
}

const ok = (body: unknown, status = 200): Reply => ({ status, json: body });
const notFound = (message = 'Not found.'): Reply => ({
  status: 404,
  json: { detail: { code: 'not_found', error: message } },
});

interface Request {
  method: string;
  /** `/v1/organizations/…` split at the slashes: `['v1', 'organizations', …]`. */
  parts: string[];
  query: URLSearchParams;
  body: () => Record<string, unknown>;
  /** The body as text (a Composition2Yaml document). */
  text: () => string;
  /** A small package, for every download. */
  archive: Buffer;
  /** The compositions of this page (e2e/helpers/mockCompositions.ts): the seeded ones and what the page creates. */
  compositions: CompositionStore;
  /** The request carries a session. */
  signedIn: boolean;
}

/** `/v1/organizations/{org}/studies/…`: the studies of `isa-demo`, the one run of the first and its cells; another organization has none. */
function studyRoutes(request: Request, orgSlug: string): Reply {
  const { parts } = request;
  const [, , , , subId, action, actionId, tail, tailId] = parts;
  const studies = orgSlug === 'isa-demo' ? STUDIES : [];
  if (!subId) return ok(studies);
  const study = studies.find(item => item.slug === subId);
  if (!study) return notFound('Study not found.');
  if (action === 'runs') {
    if (subId !== STUDY.slug) return actionId ? notFound('Study run not found.') : ok([]);
    if (!actionId) return ok([RUN]);
    if (actionId !== RUN.id) return notFound('Study run not found.');
    if (tail === 'cells' && tailId) {
      const cell = CELLS.find(item => item.id === tailId);
      return cell ? ok(cell) : notFound('Study cell not found.');
    }
    if (tail === 'cells') return ok(CELLS);
    if (tail === 'analytics') return ok(ANALYTICS);
    return ok(RUN);
  }
  return ok(study);
}

/** `/v1/organizations/{org}/problems/…`: the problems of `isa-demo`, their versions, sources and compilations. */
function problemRoutes(request: Request, orgSlug: string): Reply {
  const { method, parts } = request;
  const [, , , , problemSlug, sub, revisionRef, tail, compilationId, last] = parts;
  const problems = orgSlug === 'isa-demo' ? [PROBLEM, DRAFT_PROBLEM] : [];
  if (!problemSlug) {
    if (method === 'POST')
      return ok(
        uploadOf(
          { ...DRAFT_PROBLEM, id: 'case-uploaded', slug: 'uploaded', name: 'Uploaded problem' },
          1,
          true
        ),
        201
      );
    const origin = request.query.get('origin');
    const listed = [
      ...problems.map(item => ({
        ...item,
        latest_revision: latestOf(item),
        revision_count: item.id === PROBLEM.id ? PROBLEM_REVISIONS.length : 0,
      })),
      ...(orgSlug === 'isa-demo' ? [tomatometerListed()] : []),
    ].filter(item => !origin || item.latest_revision?.origin === origin);
    return ok({ problems: listed, total: listed.length, limit: 200, offset: 0 });
  }
  // tomatometer-email (its version 2 imported from SPHERE), storage (J1's) and the SPHERE routes of a problem
  // (e2e/helpers/sphereMock.ts).
  const sphere = orgSlug === 'isa-demo' ? sphereProblemRoutes(method, parts) : null;
  if (sphere) return sphere;
  const problem = problems.find(item => item.slug === problemSlug || item.id === problemSlug);
  if (!problem) return notFound('Problem not found.');
  const revisions = problem.id === PROBLEM.id ? PROBLEM_REVISIONS : [];
  if (!sub)
    return ok({
      ...problem,
      latest_revision: latestOf(problem),
      revision_count: revisions.length,
    });
  if (sub !== 'revisions') return notFound('Not mocked.');
  if (!revisionRef) {
    if (method === 'POST') return ok(uploadOf(problem, revisions.length + 1, true), 201);
    return ok(revisions);
  }
  const revision = revisions.find(
    item =>
      String(item.revision) === revisionRef ||
      item.id === revisionRef ||
      item.package_digest === revisionRef
  );
  if (!revision) return notFound('Problem revision not found.');
  if (!tail) return ok(revisionDetail(revision));
  if (tail === 'source')
    return { status: 200, bytes: request.archive, type: 'application/vnd.bim+zip' };
  if (tail === 'compilation') return ok(compilationOf(String(revision.revision)));
  if (tail === 'compilations' && compilationId && last === 'ir') {
    return ok({
      id: compilationId,
      ir_digest: caseDigest('c'),
      ir: compiledDocument(),
      source_map: {},
    });
  }
  if (tail === 'compilations' && compilationId && last === 'facts')
    return ok(factsOfCompilation(compilationId, revision.revision));
  return notFound('Not mocked.');
}

type MockOrganization = (typeof ORGANIZATIONS)[number];

/** `GET /v1/organizations?tree=true`: the top-level organizations, each with its `children` and the source of its role. */
function organizationTree(): unknown[] {
  const ids = new Set(ORGANIZATIONS.map(item => item.id));
  const node = (item: MockOrganization, inherited: MockOrganization | null): unknown => ({
    ...item,
    role_source: inherited
      ? { id: inherited.id, slug: inherited.slug, name: inherited.name }
      : null,
    children: ORGANIZATIONS.filter(child => child.parent_id === item.id).map(child =>
      node(child, child.effective_role === item.effective_role ? (inherited ?? item) : null)
    ),
  });
  return ORGANIZATIONS.filter(item => !item.parent_id || !ids.has(item.parent_id)).map(item =>
    node(item, null)
  );
}

/** The organizations that publish: what `GET /v1/organizations/public` lists to anybody. */
const PUBLIC_ORGANIZATIONS = [
  {
    id: 'org-isa-demo',
    slug: 'isa-demo',
    name: 'ISA Demo Group',
    description: 'Compositions and studies of the ISA research group.',
    avatar: { url: null, kind: null, bg_color: null, fg_color: null },
    public_compositions: 2,
  },
  {
    id: 'org-lab-other',
    slug: 'lab-other',
    name: 'Lab Other',
    description: '',
    avatar: { url: null, kind: null, bg_color: null, fg_color: null },
    public_compositions: 1,
  },
];

function organizationRoutes(request: Request): Reply {
  const { parts, query } = request;
  const [, , orgSlug, section] = parts;
  if (!orgSlug) {
    if (request.method === 'POST') {
      const body = request.body();
      const name = String(body.name ?? 'New organization');
      const slug = name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
      return ok(
        org(`org-${slug}`, slug, name, 'OWNER', { parent_id: body.parent_id ?? null }),
        201
      );
    }
    return ok(query.get('tree') === 'true' ? organizationTree() : ORGANIZATIONS);
  }
  if (orgSlug === 'public') {
    const q = (query.get('q') ?? '').toLowerCase();
    const items = PUBLIC_ORGANIZATIONS.filter(item =>
      `${item.slug} ${item.name}`.toLowerCase().includes(q)
    );
    return ok({ items, total: items.length });
  }
  const found = ORGANIZATIONS.find(item => item.slug === orgSlug || item.id === orgSlug);
  if (!found)
    return {
      status: 403,
      json: {
        detail: {
          code: 'organization_forbidden',
          error: 'This action requires viewer access to the organization.',
        },
      },
    };
  if (!section) return ok(found);
  switch (section) {
    case 'members':
      return ok(MEMBERS[found.slug] ?? []);
    case 'audit':
      return ok({ events: ORG_AUDIT, total: ORG_AUDIT.length, offset: 0, limit: 50 });
    case 'problems':
      return problemRoutes(request, found.slug);
    case 'runs':
      return runRoutes(request, found.slug);
    case 'studies':
      return studyRoutes(request, found.slug);
    case 'presets':
      return parts[4]
        ? notFound('Run preset not found.')
        : ok(presetPage(found.slug === 'isa-demo' ? undefined : []));
    case 'compositions':
      return request.compositions.route(request, found.slug, ORGANIZATIONS);
    case 'sphere':
      return sphereRoutes(parts, query) ?? notFound('Not mocked.');
    default:
      return notFound('Not mocked.');
  }
}

/** `/v1/organizations/{org}/runs*`: the runs of `isa-demo`; another organization has none. */
function runRoutes(request: Request, orgSlug: string): Reply {
  const { method, parts, query } = request;
  const [, , , , runId, action] = parts;
  const rows = orgSlug === 'isa-demo' ? ORG_JOBS : [];
  if (!runId) {
    if (method === 'POST')
      return ok({ id: JOB_ID(9), status: 'queued', irDigest: caseDigest('c') }, 202);
    const filtered = rows.filter(
      row =>
        (!query.get('revision') || row.revision?.id === query.get('revision')) &&
        (!query.get('problem') || row.problem?.slug === query.get('problem'))
    );
    const limit = Number(query.get('limit') ?? 50);
    return ok({ runs: filtered.slice(0, limit), total: filtered.length });
  }
  if (action === 'neighborhood') return ok({ ...NEIGHBORHOOD, jobId: runId });
  const detail = orgSlug === 'isa-demo' ? jobDetail(runId) : null;
  return detail ? ok(detail) : notFound('Run not found.');
}

function userRoutes(request: Request): Reply {
  const { method, parts } = request;
  const [, , , sub, subId] = parts;
  if (!sub) return ok(ME);
  switch (sub) {
    case 'pricing-token':
      return ok({ pricing_token: PRICING_TOKEN });
    case 'usage':
      return ok(USAGE);
    case 'api-keys':
      return subId ? { status: 204 } : ok({ api_keys: API_KEYS });
    case 'settings':
      return subId === 'beta-features' ? ok({ enabled: false }) : notFound();
    case 'compositions':
      return request.compositions.mineList(request);
    case 'identities':
      return ok([
        { id: 'i1', provider: 'us-cas', subject: 'arivera1', verifiedAt: '2026-09-01T00:00:00Z' },
      ]);
    default:
      return method === 'GET' ? notFound() : { status: 204 };
  }
}

function engineRegistrationRoutes(request: Request): Reply {
  const { method, parts, query } = request;
  const [, , rawName, action] = parts;
  const all = [
    EDGE_SOLVER,
    PAUSED_SOLVER,
    PENDING_REGISTRATION,
    SHARED_SOLVER,
    EDGE_SOLVER_OLD,
  ].map(registration => registration);
  if (!rawName)
    return ok({
      registrations:
        query.get('review') === 'true' ? all.filter(item => item.status === 'pending_review') : all,
    });
  const name = decodeURIComponent(rawName);
  const found =
    all.find(
      item =>
        item.name === name &&
        item.version === query.get('version') &&
        item.namespace === query.get('namespace')
    ) ?? all.find(item => item.name === name);
  if (!found) return notFound('Engine registration not found');
  if (action === 'report') {
    const probe =
      name === 'paused-solver'
        ? REPORT_FAILED
        : name === 'region-solver'
          ? REPORT_PENDING
          : REPORT_VERIFIED;
    return ok(registrationReport(found, probe));
  }
  if (!action && method === 'GET') {
    return ok({
      apiVersion: 'bim/v1',
      kind: 'EngineRegistration',
      metadata: { namespace: found.namespace, name: found.name, version: found.version },
      spec: {
        engine: {
          namespace: found.namespace,
          name: found.name,
          version: found.version,
          digest: found.digest,
        },
        endpoint: 'https://edge.example.org',
        protocol: {
          id: 'bim-engine/v1',
          mediaType: 'application/json',
          digest: QOS_PROFILE.protocolDigest,
        },
        mappings: {
          request: '/internal/v1/binding-problems',
          health: '/health',
          openapi: '/openapi.json',
        },
        auth: { scheme: 'bearer' },
        openapi: OPENAPI_DOCUMENT,
      },
    });
  }
  return ok(found);
}

function adminRoutes(request: Request): Reply {
  const { parts, query } = request;
  const path = parts.slice(2).join('/');
  const [head, id] = parts.slice(2);
  switch (path) {
    case 'overview':
      return ok(ADMIN_OVERVIEW);
    case 'queues':
      return ok(queuesAt(Date.parse(NOW)));
    case 'moderation':
      return ok(MODERATION);
    case 'errors/overview':
      return ok(ERROR_OVERVIEW);
    case 'maintenance/preview':
      return ok({
        expiredApiKeys: 1,
        terminalJobs: 14,
        abandonedJobs: 1,
        terminalJobCutoff: '2025-10-09T00:00:00Z',
      });
    case 'errors':
      return ok({ items: ERRORS, total: ERRORS.length, limit: 50, offset: 0 });
    case 'audit':
      return ok({ ...AUDIT, total: AUDIT.events.length });
    case 'users': {
      const search = (query.get('search') ?? '').toLowerCase();
      const matching = ACCOUNTS.filter(
        account =>
          !search ||
          account.username.includes(search) ||
          account.email.includes(search) ||
          account.id === query.get('search')
      );
      return ok(userPage(matching, { total: matching.length, offset: 0, limit: 50 }));
    }
    default:
      break;
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
/** The compositions each page's account follows (`org/slug`), kept with the page's composition store. */
const FOLLOWS = new WeakMap<object, Set<string>>();
const followsOf = (store: object): Set<string> => {
  const known = FOLLOWS.get(store) ?? new Set<string>();
  FOLLOWS.set(store, known);
  return known;
};

const SESSION_ONLY = new Set([
  'composition-follows',
  'users',
  'admin',
  'notifications',
  'organizations',
  'engines',
  'engine-registrations',
]);

function route(request: Request): Reply | null {
  const { parts } = request;
  const [first, area, second, third] = parts;

  if (first === 'health')
    return parts[1] === 'ready'
      ? ok({
          status: 'ready',
          dependencies: {
            database: 'ok',
            redis: 'not-required',
            sphere: 'configured',
            space: 'configured',
          },
        })
      : ok({ status: 'ok' });
  if (first !== 'v1') return null;

  // The compositions of an organization the caller is not a member of (or of any, for a visitor): what a public reader gets.
  if (
    area === 'organizations' &&
    parts[3] === 'compositions' &&
    (!request.signedIn || !ORGANIZATIONS.some(item => item.slug === second))
  ) {
    return request.compositions.publicRoute(request, second, request.signedIn, ORGANIZATIONS);
  }

  // A stored pricing snapshot, under whichever organization its view names (e2e/helpers/sphereMock.ts).
  if (area === 'organizations' && parts[3] === 'pricing-snapshots') return snapshotRoutes(parts);

  switch (area) {
    case 'auth':
      return second === 'refresh'
        ? ok({
            access_token: 'gallery-access-2',
            refresh_token: 'gallery-refresh-2',
            token_type: 'bearer',
            expires_in: 900,
          })
        : null;
    case 'users':
      return second === 'me' ? userRoutes(request) : null;
    case 'notifications':
      if (!second) return ok(NOTIFICATIONS);
      if (second === 'unread-count')
        return ok({ count: NOTIFICATIONS.filter(item => !item.read_at).length });
      // The live stream: a ticket, then a stream that says it is connected and ends (the bell reconnects later).
      if (second === 'stream-ticket') return ok({ ticket: 'gallery-ticket', expires_in: 60 });
      if (second === 'stream')
        return { status: 200, type: 'text/event-stream', text: 'event: connected\ndata: {}\n\n' };
      if (second === 'read-all') return ok({ updated: 0 });
      if (third === 'read') return ok(NOTIFICATIONS.find(item => item.id === second) ?? {});
      if (second === 'preferences')
        return ok({
          inbox: true,
          email_contract_changes: true,
          email_invitations: true,
          email_job_failures: false,
          kinds: {
            OrganizationInvitation: { inbox: true, email: true },
            System: { inbox: true, email: true },
            CompositionUpdated: { inbox: true, email: false },
            RunFinished: { inbox: true, email: false },
            RunFailed: { inbox: true, email: true },
          },
        });
      return null;
    case 'plans':
      if (second === 'pricing') return ok(PLANS_PRICING_FIXTURE);
      return null;
    case 'organizations':
      return organizationRoutes(request);
    case 'invitations':
      // Any code the gallery opens invites to Lab Other, from Priya.
      if (third === 'preview')
        return ok({
          code: second,
          expires_at: null,
          invited_by: { id: '00000000-0000-4000-8000-0000000000aa', username: 'priya' },
          organization: PUBLIC_ORGANIZATIONS[1],
        });
      return null;
    case 'compositions':
      return second
        ? request.compositions.language(request)
        : request.compositions.publicList(request);
    case 'composition-follows': {
      // `/v1/composition-follows/{org}/{composition}`: who follows is kept for the page.
      const key = `${second}/${third}`;
      const followed = followsOf(request.compositions);
      if (request.method === 'PUT') followed.add(key);
      if (request.method === 'DELETE') followed.delete(key);
      return ok({ following: followed.has(key) });
    }
    case 'permalinks':
      return request.compositions.permalink(request);
    case 'engine-registrations':
      return engineRegistrationRoutes(request);
    case 'admin':
      return adminRoutes(request);
    case 'engines':
      if (!second) return ok({ engines: OWN_ENGINES });
      if (second === 'revisions') return ok({ revisions: [] });
      if (second === 'protocol') return ok({ profiles: [PROFILE] });
      // One revision of the catalog (`/v1/engines/{namespace}/{name}/revisions/{version}`): its state and no registration.
      if (parts[4] === 'revisions' && parts[5]) {
        const engine = OWN_ENGINES.find(
          item => item.namespace === second && item.name === third && item.version === parts[5]
        );
        return engine
          ? ok({
              id: `${engine.namespace}/${engine.name}@${engine.version}`,
              namespace: engine.namespace,
              name: engine.name,
              version: engine.version,
              digest: engine.digest,
              state: engine.namespace === 'bim.builtin' ? 'published' : 'private',
              createdAt: null,
              document: {},
              registration: null,
            })
          : notFound('Engine revision not found.');
      }
      return null;
    case 'bim':
      if (second === 'templates')
        return third
          ? { status: 200, type: 'application/vnd.bim+zip', bytes: request.archive }
          : ok({ templates: TEMPLATE_PATHS });
      if (second === 'validate') {
        return ok({
          valid: true,
          instanceDigest: caseDigest('a'),
          packageDigest: caseDigest('b'),
          irDigest: caseDigest('c'),
          fileDigests: {},
          resourceDigests: {},
          diagnostics: [],
          compatibleModes: COMPATIBLE_MODES(),
          analysis: ANALYSIS,
          ...included(request.query.get('include')),
        });
      }
      return null;
    default:
      return null;
  }
}

/**
 * Answers the API origin of the page: a signed-in administrator, nobody when `session` is `none`, or a visitor who signs in as the
 * administrator (`visitor`); `seed` adds compositions.
 */
export async function installMockApi(
  page: Page,
  session: Session,
  seed: CompositionSeed = {}
): Promise<MockHandle> {
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
  const compositions = compositionStore(seed);

  await page.route(`${API}/**`, async (call: Route) => {
    const request = call.request();
    const url = new URL(request.url());
    const parts = url.pathname.split('/').filter(Boolean);
    const signedIn =
      session === 'admin' || (session === 'visitor' && Boolean(request.headers().authorization));
    const known: Request = {
      method: request.method(),
      parts,
      query: url.searchParams,
      archive,
      compositions,
      signedIn,
      text: () => request.postData() ?? '',
      body: () => {
        try {
          return (request.postDataJSON() ?? {}) as Record<string, unknown>;
        } catch {
          return {};
        }
      },
    };
    if (session === 'visitor' && known.method === 'POST' && parts.join('/') === 'v1/auth/login') {
      await call.fulfill({
        status: 200,
        json: {
          access_token: 'gallery-access',
          refresh_token: 'gallery-refresh',
          token_type: 'bearer',
          expires_in: 900,
        },
      });
      return;
    }
    // The engine catalogue is public: a visitor gets the public engines.
    if (!signedIn && known.method === 'GET' && parts.join('/') === 'v1/engines') {
      await call.fulfill({ status: 200, json: { engines: PUBLIC_ENGINES } });
      return;
    }
    // An organization's compositions answer anybody: its public ones are read without a session.
    const compositionRead = parts[1] === 'organizations' && parts[3] === 'compositions';
    // The public organizations, an organization's profile and an invitation's preview answer anybody too.
    const openRead =
      (parts[1] === 'organizations' && (parts[2] === 'public' || parts[3] === 'profile')) ||
      (parts[1] === 'invitations' && parts[3] === 'preview');
    if (
      !signedIn &&
      parts[0] === 'v1' &&
      SESSION_ONLY.has(parts[1]) &&
      !compositionRead &&
      !openRead
    ) {
      await call.fulfill({
        status: 401,
        json: { detail: { code: 'not_authenticated', error: 'Authentication required.' } },
      });
      return;
    }
    const reply = route(known);
    if (!reply) {
      handle.unmocked.push(`${known.method} ${url.pathname}`);
      await call.fulfill({ status: 404, json: { detail: 'not mocked' } });
    } else if (reply.status === 204) {
      await call.fulfill({ status: 204 });
    } else if (reply.bytes) {
      await call.fulfill({
        status: reply.status ?? 200,
        contentType: reply.type ?? 'application/octet-stream',
        body: reply.bytes,
      });
    } else if (reply.text !== undefined) {
      await call.fulfill({
        status: reply.status ?? 200,
        contentType: reply.type ?? 'text/plain',
        body: reply.text,
      });
    } else {
      await call.fulfill({ status: reply.status ?? 200, json: reply.json });
    }
  });
  return handle;
}

// -- The F0b walk: one organization that starts with nothing and keeps what the walk writes

/** The organization of the walk (`isa-demo` of the gallery, with no problem, run or study until the walk makes them). */
export const WALK_ORG = 'isa-demo';

export interface WalkHandle extends MockHandle {
  /** What the walk wrote, in order. */
  sent: {
    /** Every package `POST /v1/bim/validate` was asked to check. */
    validated: Buffer[];
    /** The problems created (`createProblem`) and the versions added (`createProblemRevision`), with the package each carried. */
    uploads: Array<{ problem: string; revision: number; id: string; bytes: Buffer }>;
    /** The bodies of `createRun`. */
    runs: Array<Record<string, unknown>>;
    /** The bodies of `createStudy`. */
    studies: Array<Record<string, unknown>>;
  };
}

interface WalkProblem {
  item: Problem;
  revisions: Array<{ row: ProblemRevision; bytes: Buffer }>;
}

interface WalkRun {
  summary: Job;
  reads: number;
}

interface WalkStudyRun {
  run: StudyRun;
  cells: StudyCell[];
  reads: number;
}

const sha256 = (bytes: Buffer | string) =>
  `sha256-${createHash('sha256').update(bytes).digest('hex')}`;

/** How many times a run, or a study run's cells, is read before it moves on: the screens poll, so this is a few seconds. */
const READS_TO_START = 1;
const READS_TO_FINISH = 2;

/**
 * The gateway for the F0b walk (`e2e/f0b-walk.spec.ts`): nobody is signed in until `POST /v1/auth/login`; then the organization
 * `isa-demo` holds the problems, versions, runs and studies the walk creates, read back as the gateway would answer them. A version's
 * source is the package that was uploaded, byte for byte. A run is queued, then running, then completed with the fixture result; a study
 * run's cells go from queued to completed the same way. Everything else (the account, the plan, the engines, the templates list) is the
 * gallery's. A request neither answers is a 404 recorded in `unmocked`, which the walk expects to stay empty.
 */
export async function installWalkApi(page: Page, template: Buffer): Promise<WalkHandle> {
  const handle: WalkHandle = {
    unmocked: [],
    sent: { validated: [], uploads: [], runs: [], studies: [] },
  };
  const problems: WalkProblem[] = [];
  const runs = new Map<string, WalkRun>();
  const studies: Study[] = [];
  const studyRuns = new Map<string, WalkStudyRun[]>();
  const compositions = compositionStore();
  let serial = 0;
  const nextId = (prefix: string) => {
    serial += 1;
    return `${prefix}-${String(serial).padStart(4, '0')}`;
  };
  await page.clock.setFixedTime(new Date(NOW));

  const latestOfRow = (problem: WalkProblem) => {
    const newest = problem.revisions[problem.revisions.length - 1]?.row;
    return newest
      ? {
          id: newest.id,
          revision: newest.revision,
          package_digest: newest.package_digest,
          created_at: newest.created_at,
          origin: 'upload' as const,
        }
      : null;
  };
  const shown = (problem: WalkProblem) => ({
    ...problem.item,
    latest_revision: latestOfRow(problem),
    revision_count: problem.revisions.length,
  });
  const compilationFor = (row: ProblemRevision) => ({
    id: `compilation-${row.id}`,
    revision_id: row.id,
    compilation_digest: sha256(`compilation:${row.package_digest}`),
    compiler_digest: caseDigest('8'),
    ir_digest: sha256(`ir:${row.package_digest}`),
    binding_space: ANALYSIS.bindingSpace,
    created_at: NOW,
    current: true,
    toolchain: {},
    analysis: ANALYSIS,
    resources: {
      application: {
        role: 'application',
        path: 'application.json',
        apiVersion: 'qos-binding/v1',
        kind: 'Application',
      },
    },
    compatible_modes: COMPATIBLE_MODES(),
  });
  const addRevision = (problem: WalkProblem, bytes: Buffer) => {
    const row: ProblemRevision = {
      id: nextId(`rev-${problem.item.slug}`),
      problem_id: problem.item.id,
      revision: problem.revisions.length + 1,
      package_digest: sha256(bytes),
      package_size: bytes.length,
      created_by_id: ME_ID,
      created_at: NOW,
    };
    problem.revisions.push({ row, bytes });
    problem.item = { ...problem.item, updated_at: NOW };
    handle.sent.uploads.push({
      problem: problem.item.slug,
      revision: row.revision,
      id: row.id,
      bytes,
    });
    return row;
  };
  const upload = (problem: WalkProblem, row: ProblemRevision, created: boolean) => {
    return {
      problem: shown(problem),
      revision: row,
      created,
      compilation: { ...compilationFor(row), compatible_modes: undefined },
    };
  };
  const revisionOf = (problem: WalkProblem, ref: string) =>
    problem.revisions.find(
      ({ row }) => String(row.revision) === ref || row.id === ref || row.package_digest === ref
    );
  const refsOf = (revisionId: string) => {
    for (const problem of problems) {
      const found = problem.revisions.find(({ row }) => row.id === revisionId);
      if (found) {
        const compilation = compilationFor(found.row);
        return {
          problem,
          row: found.row,
          refs: {
            organization: { id: 'org-isa-demo', slug: WALK_ORG },
            problem: { id: problem.item.id, slug: problem.item.slug, name: problem.item.name },
            revision: { id: found.row.id, revision: found.row.revision },
            compilation: {
              id: compilation.id,
              compilation_digest: compilation.compilation_digest,
              ir_digest: compilation.ir_digest,
            },
          },
        };
      }
    }
    return null;
  };

  const problemRoute = (request: Request, body: Buffer | null): Reply => {
    const { method, parts, query } = request;
    const [, , , , slug, sub, ref, tail, , last] = parts;
    if (!slug) {
      if (method === 'POST') {
        const bytes = body ?? Buffer.alloc(0);
        const wanted = query.get('slug') ?? 'uploaded';
        if (problems.some(problem => problem.item.slug === wanted)) {
          return {
            status: 409,
            json: {
              detail: {
                code: 'slug_conflict',
                error: 'That problem slug is in use in this organization.',
              },
            },
          };
        }
        const problem: WalkProblem = {
          item: {
            id: nextId('problem'),
            organization_id: 'org-isa-demo',
            slug: wanted,
            name: query.get('name') ?? wanted,
            description: query.get('description') ?? '',
            created_by_id: ME_ID,
            created_at: NOW,
            updated_at: NOW,
          },
          revisions: [],
        };
        problems.push(problem);
        return ok(upload(problem, addRevision(problem, bytes), true), 201);
      }
      return ok({
        problems: problems.map(shown),
        total: problems.length,
        limit: Number(query.get('limit') ?? 50),
        offset: 0,
      });
    }
    const problem = problems.find(item => item.item.slug === slug || item.item.id === slug);
    if (!problem) return notFound('Problem not found.');
    if (!sub) return ok(shown(problem));
    if (sub !== 'revisions') return notFound('Not mocked.');
    if (!ref) {
      if (method === 'POST') {
        const bytes = body ?? Buffer.alloc(0);
        const same = problem.revisions.find(({ row }) => row.package_digest === sha256(bytes));
        return same
          ? ok(upload(problem, same.row, false), 200)
          : ok(upload(problem, addRevision(problem, bytes), true), 201);
      }
      return ok([...problem.revisions].reverse().map(({ row }) => row));
    }
    const found = revisionOf(problem, ref);
    if (!found) return notFound('Problem revision not found.');
    if (!tail)
      return ok({
        ...revisionDetail(found.row as (typeof PROBLEM_REVISIONS)[number]),
        compilations: [],
      });
    if (tail === 'source')
      return { status: 200, bytes: found.bytes, type: 'application/vnd.bim+zip' };
    if (tail === 'compilation') return ok(compilationFor(found.row));
    if (tail === 'compilations' && last === 'ir') {
      return ok({
        id: compilationFor(found.row).id,
        ir_digest: compilationFor(found.row).ir_digest,
        ir: compiledDocument(),
        source_map: {},
      });
    }
    if (tail === 'compilations' && last === 'facts') return ok(factsOf(2));
    return notFound('Not mocked.');
  };

  const runRoute = (request: Request): Reply => {
    const { method, parts, query } = request;
    const [, , , , runId, action] = parts;
    if (!runId) {
      if (method === 'POST') {
        const sent = request.body();
        handle.sent.runs.push(sent);
        const found = refsOf(String(sent.revision ?? ''));
        if (!found) return notFound('Problem revision not found.');
        const id = `00000000-0000-4000-8000-${String(1000 + runs.size).padStart(12, '0')}`;
        runs.set(id, {
          summary: jobOf(id, 'random-search', 'queued', null, NOW, null, {
            organization_id: 'org-isa-demo',
            ...found.refs,
            created_by: { id: ME_ID, username: ME.username },
          }),
          reads: 0,
        });
        return ok({ id, status: 'queued', irDigest: found.refs.compilation.ir_digest }, 202);
      }
      const rows = [...runs.values()]
        .map(({ summary }) => summary)
        .filter(
          row =>
            (!query.get('problem') || row.problem?.slug === query.get('problem')) &&
            (!query.get('revision') || row.revision?.id === query.get('revision'))
        );
      return ok({ runs: rows.slice(0, Number(query.get('limit') ?? 50)), total: rows.length });
    }
    const run = runs.get(runId);
    if (!run) return notFound('Run not found.');
    if (action === 'neighborhood') return ok({ ...NEIGHBORHOOD, jobId: runId });
    if (action) return notFound('Not mocked.');
    run.reads += 1;
    const status =
      run.reads > READS_TO_FINISH ? 'completed' : run.reads > READS_TO_START ? 'running' : 'queued';
    run.summary = {
      ...run.summary,
      status,
      termination: status === 'completed' ? 'FEASIBLE' : null,
      finished_at: status === 'completed' ? NOW : null,
    };
    const { organization, problem, revision, compilation } = run.summary as Job & typeof RUN_REFS;
    return ok({
      ...run.summary,
      ...jobDetailOf(runId, status, { organization, problem, revision, compilation }),
      ...(status === 'completed' ? { result: RESULT } : {}),
    });
  };

  const studyRoute = (request: Request): Reply => {
    const { method, parts } = request;
    const [, , , , slug, action, runId, tail, cellId] = parts;
    if (!slug) {
      if (method === 'POST') {
        const sent = request.body() as {
          slug: string;
          name: string;
          description?: string;
          definition: Study['definition'];
        };
        handle.sent.studies.push(sent);
        const study: Study = {
          archived: false,
          id: nextId('study'),
          organization_id: 'org-isa-demo',
          slug: sent.slug,
          name: sent.name,
          description: sent.description ?? '',
          definition: sent.definition,
          definition_digest: sha256(JSON.stringify(sent.definition)),
          state: 'ready',
          created_by_id: ME_ID,
          created_at: NOW,
        };
        studies.push(study);
        return ok(study, 201);
      }
      return ok(studies);
    }
    const study = studies.find(item => item.slug === slug);
    if (!study) return notFound('Study not found.');
    if (!action) return { status: 200, json: study };
    if (action !== 'runs') return notFound('Not mocked.');
    const own = studyRuns.get(study.slug) ?? [];
    if (!runId) {
      if (method === 'POST') {
        const id = `00000000-0000-4000-8000-${String(2000 + own.length).padStart(12, '0')}`;
        const definition = study.definition;
        const frozen = {
          apiVersion: 'openbinding/study-run/v1',
          problems: definition.revision_ids.map(revisionId => {
            const found = refsOf(revisionId);
            return {
              revisionId,
              problemId: found?.problem.item.id ?? '',
              revision: found?.row.revision ?? 0,
              packageDigest: found?.row.package_digest ?? '',
              compilationId: found?.refs.compilation.id ?? '',
              compilationDigest: found?.refs.compilation.compilation_digest ?? '',
              irDigest: found?.refs.compilation.ir_digest ?? '',
            };
          }),
          // The walk's study names exact engines only, so the run freezes them as they are.
          engines: definition.engines as StudyRun['definition']['engines'],
          parameterSets: definition.parameter_sets,
          seeds: definition.seeds,
        };
        const cells: StudyCell[] = [];
        for (const revisionId of definition.revision_ids) {
          for (const engine of definition.engines) {
            for (const parameters of definition.parameter_sets) {
              for (const seed of definition.seeds) {
                const ordinal = cells.length;
                cells.push({
                  id: `00000000-0000-4000-8000-${String(3000 + ordinal).padStart(12, '0')}`,
                  study_run_id: id,
                  ordinal,
                  binding_case_revision_id: revisionId,
                  compilation_id: refsOf(revisionId)?.refs.compilation.id ?? '',
                  engine_ref: { ...engine } as unknown as StudyCell['engine_ref'],
                  parameters,
                  seed,
                  fingerprint: sha256(`${id}:${ordinal}`),
                  job_id: null,
                  state: 'queued',
                  metrics: {},
                });
              }
            }
          }
        }
        const run: StudyRun = {
          id,
          study_id: study.id,
          run_number: own.length + 1,
          state: 'running',
          matrix_digest: sha256(`matrix:${id}`),
          cells: cells.length,
          summary: {},
          definition: frozen,
          definition_digest: sha256(JSON.stringify(frozen)),
          created_at: NOW,
          finished_at: null,
        };
        studyRuns.set(study.slug, [{ run, cells, reads: 0 }, ...own]);
        return ok(run, 202);
      }
      return ok(own.map(item => item.run));
    }
    const entry = own.find(item => item.run.id === runId);
    if (!entry) return notFound('Study run not found.');
    if (!tail) return ok(entry.run);
    if (tail === 'cells') {
      if (!cellId) {
        entry.reads += 1;
        const done = entry.reads > READS_TO_FINISH;
        entry.cells = entry.cells.map(cell => {
          const engine = cell.engine_ref as { namespace: string; name: string; version: string };
          const finished = done
            ? {
                state: 'completed' as const,
                job_id: `00000000-0000-4000-8000-${String(4000 + cell.ordinal).padStart(12, '0')}`,
                metrics: {
                  status: 'completed',
                  feasible: true,
                  termination: 'FEASIBLE',
                  objectives: { cost: 0.1 + cell.ordinal / 100, latency: 400 + cell.ordinal },
                  runtimeSeconds: 30 + cell.ordinal,
                  engine: `${engine.namespace}/${engine.name}@${engine.version}`,
                  seed: cell.seed,
                },
              }
            : {
                state: (entry.reads > READS_TO_START ? 'running' : 'queued') as StudyCell['state'],
              };
          return { ...cell, ...finished };
        });
        if (done) entry.run = { ...entry.run, state: 'completed', finished_at: NOW };
        return ok(entry.cells);
      }
      const cell = entry.cells.find(item => item.id === cellId);
      return cell ? ok(cell) : notFound('Study cell not found.');
    }
    if (tail === 'analytics') {
      const completed = entry.cells.filter(cell => cell.state === 'completed');
      const objective = (name: string) =>
        completed.map(cell =>
          Number((cell.metrics.objectives as Record<string, number> | undefined)?.[name] ?? 0)
        );
      return ok(
        analyticsFixture({
          cells: entry.cells.length,
          completed: completed.length,
          failed: 0,
          feasible: completed.length,
          infeasible: 0,
          objective_distributions: { cost: objective('cost'), latency: objective('latency') },
          runtimes_s: completed.map(cell => Number(cell.metrics.runtimeSeconds ?? 0)),
          // The fixture's fronts name the study fixture's cells, not the walk's: the walk's run has no front of its own.
          pareto: [],
          stability: Object.fromEntries(
            [...new Set(completed.map(cell => String(cell.metrics.engine)))].map(engine => [
              engine,
              { samples: 2, distinct: 2, repeatability: 0.5 },
            ])
          ),
        })
      );
    }
    return notFound('Not mocked.');
  };

  const walkRoute = (request: Request, body: Buffer | null, signedIn: boolean): Reply | null => {
    const { method, parts } = request;
    const [first, area, second, third] = parts;
    if (first !== 'v1') return null;
    if (area === 'auth' && second === 'login' && method === 'POST') {
      return ok({
        access_token: 'walk-access',
        refresh_token: 'walk-refresh',
        token_type: 'bearer',
        expires_in: 900,
      });
    }
    if (!signedIn && SESSION_ONLY.has(area))
      return {
        status: 401,
        json: { detail: { code: 'not_authenticated', error: 'Authentication required.' } },
      };
    if (area === 'bim' && second === 'validate' && method === 'POST') {
      handle.sent.validated.push(body ?? Buffer.alloc(0));
      return ok({
        valid: true,
        instanceDigest: sha256(`instance:${sha256(body ?? '')}`),
        packageDigest: sha256(body ?? Buffer.alloc(0)),
        irDigest: sha256(`ir:${sha256(body ?? '')}`),
        fileDigests: {},
        resourceDigests: {},
        diagnostics: [],
        compatibleModes: COMPATIBLE_MODES(),
        analysis: ANALYSIS,
        ...included(request.query.get('include')),
      });
    }
    if (area === 'bim' && second === 'templates' && third)
      return { status: 200, type: 'application/vnd.bim+zip', bytes: template };
    if (area === 'organizations' && second === WALK_ORG) {
      switch (parts[3]) {
        case 'problems':
          return problemRoute(request, body);
        case 'runs':
          return runRoute(request);
        case 'studies':
          return studyRoute(request);
        default:
          return null;
      }
    }
    return null;
  };

  await page.route(`${API}/**`, async (call: Route) => {
    const request = call.request();
    const url = new URL(request.url());
    const parts = url.pathname.split('/').filter(Boolean);
    const body = request.postDataBuffer();
    const known: Request = {
      method: request.method(),
      parts,
      query: url.searchParams,
      archive: template,
      compositions,
      signedIn: Boolean(request.headers().authorization),
      text: () => request.postData() ?? '',
      body: () => {
        try {
          return (request.postDataJSON() ?? {}) as Record<string, unknown>;
        } catch {
          return {};
        }
      },
    };
    const reply = walkRoute(known, body, known.signedIn) ?? route(known);
    if (!reply) {
      handle.unmocked.push(`${known.method} ${url.pathname}`);
      await call.fulfill({ status: 404, json: { detail: 'not mocked' } });
    } else if (reply.status === 204) {
      await call.fulfill({ status: 204 });
    } else if (reply.bytes) {
      await call.fulfill({
        status: reply.status ?? 200,
        contentType: reply.type ?? 'application/octet-stream',
        body: reply.bytes,
      });
    } else {
      await call.fulfill({ status: reply.status ?? 200, json: reply.json });
    }
  });
  return handle;
}
