import { expect, test, type Page, type Route, type TestInfo } from '@playwright/test';
import { CURRENT_FIXTURE, catalogFixture } from '../src/pages/Pricing/pricingFixture';
import { zipStore } from '../src/utils/bimZip';

// S1b · public screens, part 2: eng-catalog, eng-detail, lang-profiles, lang-schemas, lang-examples, pub-workbench.
// There is no backend: the API origin is answered by page.route(). Screenshots go to testInfo.outputPath()
// (test-results/, ignored by git) so they can be looked at after a run.

const API = 'http://localhost:8000';
// A full-page capture stitches the page, so the fixed header and skip link would be painted over the content.
const HIDE_FLOATING = '.site-header, .skip-link { visibility: hidden !important; }';

const DIGEST = (seed: string) => `sha256-${seed.repeat(8)}`;
const RS_DIGEST = DIGEST('b2c3d4e5');
const EDGE_DIGEST = DIGEST('f1f2f3f4');

const lucia = {
  id: 'research-user-id', username: 'lucia', email: 'lucia@example.org', role: 'user', is_active: true, plan: 'RESEARCH', created_at: '2026-09-01T00:00:00Z',
};

function mode(id: string, algorithm: string, options: Record<string, unknown>, extra: { exact?: boolean; ir?: string } = {}) {
  const all = { selector: 'all' };
  return {
    id,
    profile: 'qos-binding/v1',
    ir: { apiVersion: 'bim/v1', kind: 'BindingProblem' },
    algorithm,
    capabilities: {
      workflowNodes: all,
      metricScopes: { selector: 'only', values: ['invocation', 'selectedCandidate'] },
      aggregations: all,
      constraints: all,
      optimization: { selector: 'only', values: ['satisfy', 'weighted'] },
      objectiveTypes: all,
      expressions: all,
      placement: extra.ir ? all : { selector: 'none' },
      irExtensions: extra.ir ? { selector: 'only', values: [extra.ir] } : { selector: 'none' },
    },
    optionsSchema: { type: 'object', additionalProperties: false, properties: options, required: [] },
    limits: { maxTasks: 500, maxCandidates: 5000 },
    guarantees: { termination: extra.exact ? ['OPTIMAL', 'INFEASIBLE'] : ['FEASIBLE', 'UNKNOWN'], exact: Boolean(extra.exact) },
  };
}

function engine(namespace: string, name: string, version: string, digest: string, modes: unknown[]) {
  const ref = { namespace, name, version, digest };
  return { id: name, ...ref, ref, modes };
}

const timeBudget = (value: number) => ({ type: 'integer', default: value, unit: 'ms' });
const randomSearch = engine('bim.builtin', 'random-search', '1.0.0', RS_DIGEST, [
  mode('sampling', 'random sampling', { time_budget_ms: timeBudget(30000), iterations: { type: 'integer', default: 100000 } }, { ir: 'qos-binding-placement/v1' }),
]);
const evolutionary = engine('bim.builtin', 'evolutionary', '1.0.0', DIGEST('c3d4e5f6'), [
  mode('genetic', 'genetic algorithm', { max_evaluations: { type: 'integer', default: 50000 }, population: { type: 'integer', default: 64 } }),
]);
const minizinc = engine('bim.builtin', 'minizinc', '1.0.0', DIGEST('d4e5f607'), [
  mode('cp', 'constraint programming', { time_budget_ms: timeBudget(60000) }, { exact: true }),
]);
const edgeSolver = engine('lucia', 'edge-solver', '0.3.1', EDGE_DIGEST, [mode('sampling', 'edge sampling', { time_budget_ms: timeBudget(20000) })]);

const registration = { namespace: 'lucia', name: 'edge-solver', version: '0.3.1', digest: DIGEST('a9b8c7d6'), status: 'private', active: true };

const edgeReport = {
  ...registration,
  openapiDigest: DIGEST('0a1b2c3d'),
  openapi: null,
  engine: null,
  report: {
    protocol: 'bim-engine/v1',
    protocolDigest: DIGEST('9f8e7d6c'),
    status: 'verified',
    verifiedAt: '2026-09-24T09:30:00Z',
    durationMs: 842,
    checks: [
      { id: 'health', status: 'passed', message: 'GET /health answered 200' },
      { id: 'openapi', status: 'passed', message: 'The pinned OpenAPI document matches the deployment' },
      { id: 'request-contract', status: 'passed', message: 'A compiled BindingProblem was accepted' },
    ],
  },
};

const profile = {
  apiVersion: 'bim/v1',
  kind: 'Profile',
  metadata: { namespace: 'bim.builtin', name: 'qos-binding', version: '1.0.0', description: 'Deterministic scalar-QoS service composition and binding' },
  spec: {
    deterministic: true,
    roles: {
      application: {
        resourceTypes: [
          { apiVersion: 'qos-binding/v1', kind: 'Application', minimum: 1, maximum: 1 },
          { apiVersion: 'qos-binding/v1', kind: 'RoutingOverlay', minimum: 0, maximum: 1 },
        ],
        extensionTypes: 'installed',
      },
      candidateCatalog: { resourceTypes: [{ apiVersion: 'qos-binding/v1', kind: 'CandidateCatalog', minimum: 1 }], extensionTypes: 'installed' },
      constraintSet: { resourceTypes: [{ apiVersion: 'qos-binding/v1', kind: 'ConstraintSet', minimum: 0 }], extensionTypes: 'installed' },
      optimization: { resourceTypes: [{ apiVersion: 'qos-binding/v1', kind: 'Optimization', minimum: 1, maximum: 1 }], extensionTypes: 'installed' },
    },
    output: { apiVersion: 'bim/v1', kind: 'BindingProblem', schemaDigest: DIGEST('11aa22bb'), engineProtocol: 'bim-engine/v1' },
    capabilityVocabulary: {
      dimensions: {
        workflowNodes: { values: ['sequence', 'parallel'], openValues: false },
        aggregations: { values: ['sum', 'max'], openValues: false },
        irExtensions: { values: [], openValues: true },
      },
    },
    limitVocabulary: ['maxTasks', 'maxCandidates', 'maxIterations', 'maxTimeBudgetMs'],
    adapter: { id: 'qos-binding-profile', version: '1.0.0', binaryDigest: DIGEST('33cc44dd') },
  },
  id: 'qos-binding/v1',
  digest: DIGEST('55ee66ff'),
  output: { apiVersion: 'bim/v1', kind: 'BindingProblem', schemaDigest: DIGEST('11aa22bb'), engineProtocol: 'bim-engine/v1' },
  protocol: 'bim-engine/v1',
  protocolDigest: DIGEST('77aa88bb'),
};

const dialect = (name: string, kinds: string[], features: Array<{ dimension: string; value: string }>) => ({
  apiVersion: 'bim/v1',
  kind: 'Dialect',
  metadata: { namespace: 'bim.builtin', name, version: '1.0.0' },
  spec: {
    compatibleProfiles: ['qos-binding/v1'],
    resourceTypes: kinds.map((kind) => ({ apiVersion: `${name}/v1`, kind, roles: ['application'], mediaType: 'application/json', schemaDigest: DIGEST('99aabbcc') })),
    extensionPoints: [],
    irFeatures: features,
    adapter: { id: `bim-${name}`, version: '1.0.0', binaryDigest: DIGEST('ddeeff00') },
  },
  digest: DIGEST('12345678'),
});

const dialects = [
  dialect('bpmn-workflow', ['BPMN'], []),
  dialect('placement', ['Placement', 'RoutingOverlay'], [{ dimension: 'irExtensions', value: 'qos-binding-placement/v1' }]),
];

const resource = {
  namespace: 'isa-demo', name: 'checkout-catalog', version: '2.0.0', digest: DIGEST('abcdef01'), role: 'candidateCatalog',
  apiVersion: 'qos-binding/v1', kind: 'CandidateCatalog', dialect: 'qos-binding/v1', mediaType: 'application/json', status: 'published',
};

const applicationSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://bim.dev/schemas/qos-binding/v1/application.schema.json',
  required: ['apiVersion', 'kind', 'spec'],
  properties: {
    apiVersion: { const: 'qos-binding/v1' },
    kind: { const: 'Application' },
    metadata: { type: 'object', properties: { name: { type: 'string', description: 'Name of the resource within the package' } }, required: ['name'] },
    spec: {
      type: 'object',
      required: ['tasks', 'workflow'],
      properties: {
        tasks: { type: 'object', description: 'Each task id and the capability a candidate must provide', additionalProperties: { type: 'string' } },
        features: {
          type: 'object',
          description: 'The QoS features the optimization can read',
          additionalProperties: {
            type: 'object',
            properties: {
              unit: { type: 'string', description: 'Unit of the feature values, such as ms or EUR/request' },
              direction: { enum: ['minimize', 'maximize'], description: 'Which way is better' },
            },
          },
        },
        workflow: {
          type: 'object',
          description: 'Root workflow node',
          properties: {
            kind: { enum: ['sequence', 'parallel', 'exclusive', 'repeat'], description: 'How the children run' },
            children: { type: 'array', minItems: 1, items: { type: 'object', description: 'A child node' }, description: 'Child nodes' },
            probability: { type: 'number', minimum: 0, maximum: 1, description: 'Branch probability (exclusive)' },
            count: { type: 'integer', minimum: 1, description: 'Repetitions (repeat)' },
          },
        },
      },
    },
  },
};

const engineContract = {
  protocol: 'bim-engine/v1',
  digest: DIGEST('c0ffee11'),
  openapi: {
    openapi: '3.1.0',
    paths: {
      '/internal/v1/binding-problems': { post: { summary: 'Solve a compiled BindingProblem' } },
      '/internal/v1/jobs/{id}': { get: { summary: 'Read a running job' } },
      '/health': { get: { summary: 'Report whether the engine is ready' } },
    },
    components: {
      schemas: {
        SolveRequest: { type: 'object', required: ['problem'], properties: { problem: { type: 'object', description: 'The compiled BindingProblem' }, options: { type: 'object', description: 'Caller options of the mode' } } },
        Solution: { type: 'object', required: ['termination'], properties: { termination: { enum: ['OPTIMAL', 'FEASIBLE', 'INFEASIBLE', 'UNKNOWN'] } } },
      },
    },
  },
};

const genericSchema = (kind: string) => ({
  $id: `https://bim.dev/schemas/${kind}.schema.json`,
  required: ['spec'],
  properties: { apiVersion: { const: 'bim/v1' }, spec: { type: 'object', description: `The body of a ${kind}`, properties: {} } },
});

const EXAMPLES = ['demo/01_simple_seq', 'demo/02_parallel', 'demo/03_xor_choice', 'placement/01_small_placement', 'literature/zhang'];

// A small package the workbench can read and draw.
const packageFiles: Record<string, unknown> = {
  'instance.json': {
    apiVersion: 'bim/v1', kind: 'Instance', metadata: { name: 'checkout-flow', description: 'Flujo de checkout' },
    spec: { profile: 'qos-binding/v1', resources: { application: { application: 'application.json' }, candidateCatalog: { catalog: 'candidates.json' }, constraintSet: { rules: 'constraints.json' }, optimization: { optimization: 'optimization.json' } } },
  },
  'application.json': {
    kind: 'Application',
    spec: {
      tasks: { autenticar: 'service/auth', inventario: 'service/stock', 'calcular-envio': 'service/shipping', 'pago-tarjeta': 'service/payment', 'pago-transferencia': 'service/transfer' },
      features: { latency: { unit: 'ms' }, cost: { unit: 'EUR/request' } },
      workflow: {
        sequence: [
          { task: { resource: 'application', id: 'autenticar' } },
          { parallel: [{ task: { resource: 'application', id: 'inventario' } }, { task: { resource: 'application', id: 'calcular-envio' } }], aggregation: 'max' },
          { exclusive: [{ branch: { task: { resource: 'application', id: 'pago-tarjeta' } }, probability: 0.7 }, { branch: { task: { resource: 'application', id: 'pago-transferencia' } }, probability: 0.3 }] },
        ],
      },
    },
  },
  'candidates.json': {
    kind: 'CandidateCatalog',
    spec: {
      candidates: {
        a1: { provides: 'service/auth', features: { latency: 40, cost: 0.002 } },
        a2: { provides: 'service/auth', features: { latency: 55, cost: 0.001 } },
        s1: { provides: 'service/stock', features: { latency: 90, cost: 0.004 } },
        s2: { provides: 'service/stock', features: { latency: 120, cost: 0.002 } },
        s3: { provides: 'service/stock', features: { latency: 60, cost: 0.006 } },
        h1: { provides: 'service/shipping', features: { latency: 200, cost: 0.01 } },
        h2: { provides: 'service/shipping', features: { latency: 150, cost: 0.02 } },
        p1: { provides: 'service/payment', features: { latency: 180, cost: 0.021 } },
        p2: { provides: 'service/payment', features: { latency: 95, cost: 0.034 } },
        t1: { provides: 'service/transfer', features: { latency: 400, cost: 0.005 } },
      },
    },
  },
  'constraints.json': {
    kind: 'ConstraintSet',
    spec: { constraints: [{ id: 'sla-latencia', enforcement: 'hard', description: 'Total latency ≤ 600 ms' }, { id: 'sla-disponibilidad', penalty: 5, description: 'Availability ≥ 99.9 %' }] },
  },
  'optimization.json': {
    kind: 'Optimization',
    spec: { mode: 'weighted', criteria: [{ id: 'cost', weight: 0.6, direction: 'minimize' }, { id: 'latency', weight: 0.4, direction: 'minimize' }] },
  },
};

const packageZip = () => Buffer.from(zipStore(Object.fromEntries(Object.entries(packageFiles).map(([path, value]) => [path, JSON.stringify(value)]))));

const validResult = {
  valid: true,
  instanceDigest: DIGEST('a1b2c3d4'),
  packageDigest: DIGEST('b2c3d4e5'),
  fileDigests: { 'candidates.json': DIGEST('1a2b3c4d'), 'application.json': DIGEST('2b3c4d5e') },
  resourceDigests: {},
  irDigest: DIGEST('c3d4e5f6'),
  diagnostics: [],
};

const invalidProblem = {
  type: 'https://openbinding.dev/problems/invalid_request',
  title: 'invalid_request',
  status: 422,
  detail: 'The package has 2 errors.',
  diagnostics: [
    { code: 'missing_metric', resource: 'candidateCatalog', pointer: '/spec/candidates/t1/features/latency', message: 'Candidate t1 does not declare latency, required by the optimization.', fix: 'Add a finite value in ms, or remove the candidate.' },
    { code: 'unsupported_construct', path: 'application.json', pointer: '/spec/workflow/sequence/1', message: 'This parallel block is not structured: it has no matching join.', fix: 'Restructure the flow with paired split and join.' },
  ],
};

interface Mocks {
  signedIn?: boolean;
  /** Answers POST /v1/instances/validate. */
  validate?: (route: Route) => Promise<void> | void;
  engines?: (route: Route) => Promise<void> | void;
  resourceContent?: (route: Route) => Promise<void> | void;
}

const json = (body: unknown, status = 200) => (route: Route) => route.fulfill({ status, json: body });

/** Everything the six screens read, answered; anything else on the API origin is an empty 404. */
async function mockApi(page: Page, mocks: Mocks = {}) {
  await page.route(`${API}/**`, (route) => route.fulfill({ status: 404, json: { detail: 'not mocked' } }));
  if (mocks.signedIn) {
    await page.addInitScript(() => localStorage.setItem('openbinding-access-token', 's1b-token'));
    await page.route(`${API}/v1/users/me`, json(lucia));
    await page.route(`${API}/v1/users/me/pricing-token`, json({ pricing_token: 's1b-pricing' }));
    await page.route(`${API}/v1/engines`, mocks.engines ?? json({ engines: [randomSearch, evolutionary, minizinc, edgeSolver] }));
    await page.route(`${API}/v1/engines/revisions`, json({
      revisions: [
        ...[randomSearch, evolutionary, minizinc].map((item) => ({ id: item.name, namespace: item.namespace, name: item.name, version: item.version, digest: item.digest, state: 'published', createdAt: null, document: {}, registration: null })),
        { id: 'edge', namespace: 'lucia', name: 'edge-solver', version: '0.3.1', digest: EDGE_DIGEST, state: 'private', createdAt: null, document: {}, registration: { id: 'reg-1', verificationReport: { status: 'verified' } } },
      ],
    }));
    await page.route(`${API}/v1/engines/lucia/edge-solver/revisions/0.3.1`, json({
      id: 'edge', namespace: 'lucia', name: 'edge-solver', version: '0.3.1', digest: EDGE_DIGEST, state: 'private', createdAt: '2026-09-20T10:00:00Z', document: {}, registration: null,
    }));
    await page.route(`${API}/v1/engines/bim.builtin/random-search/revisions/1.0.0`, json({
      id: 'rs', namespace: 'bim.builtin', name: 'random-search', version: '1.0.0', digest: RS_DIGEST, state: 'published', createdAt: null, document: {}, registration: null,
    }));
    await page.route(`${API}/v1/engine-registrations`, json({ registrations: [registration] }));
    await page.route(`${API}/v1/engine-registrations/edge-solver/report**`, json(edgeReport));
    await page.route(`${API}/v1/organizations`, json([{ id: 'org-1', slug: 'isa-demo', name: 'ISA Demo Group', parent_id: null, billing_sponsor_user_id: lucia.id, effective_role: 'OWNER', created_at: '2026-09-01T00:00:00Z' }]));
    await page.route(`${API}/v1/organizations/isa-demo/projects`, json([{ id: 'p1', organization_id: 'org-1', slug: 'qos-benchmarks', name: 'QoS Benchmarks', description: '', visibility: 'private', created_by_id: lucia.id, created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z', access: 'member', effective_role: 'OWNER' }]));
  }
  await page.route(`${API}/v1/explore/engines`, mocks.engines ?? json({ engines: [randomSearch, evolutionary, minizinc] }));
  // EngineDetail reads the live catalog (the deprecated YAML at /v1/pricing is no longer requested).
  await page.route(`${API}/v1/pricing/catalog`, json(catalogFixture));
  await page.route(`${API}/v1/pricing/current`, json(CURRENT_FIXTURE));
  await page.route(`${API}/v1/profiles`, json({ profiles: [profile] }));
  await page.route(`${API}/v1/dialects`, json({ dialects }));
  await page.route(`${API}/v1/resources`, json({ resources: [resource] }));
  await page.route(`${API}/v1/resources/checkout-catalog**`, mocks.resourceContent ?? json({ detail: 'Registered BIM resource not found' }, 404));
  await page.route(`${API}/v1/schemas/**`, (route) => {
    const kind = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-1) ?? '');
    return route.fulfill({ status: 200, json: kind === 'Application' ? applicationSchema : kind === 'engine-contract' ? engineContract : genericSchema(kind) });
  });
  await page.route(`${API}/v1/examples`, json({ examples: EXAMPLES }));
  await page.route(`${API}/v1/examples/**`, (route) => route.fulfill({
    status: 200, contentType: 'application/vnd.bim+zip', body: packageZip(), headers: { 'Content-Disposition': 'attachment; filename="01_simple_seq.bim.zip"' },
  }));
  await page.route(`${API}/v1/instances/validate`, mocks.validate ?? json(validResult));
}

function watchCriticalErrors(page: Page) {
  const critical: string[] = [];
  page.on('pageerror', (error) => critical.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    const text = message.text();
    if (message.type() === 'error' && /The above error occurred|Minified React error|Maximum update depth|Uncaught/i.test(text)) critical.push(`console: ${text}`);
  });
  return critical;
}

async function ready(page: Page) {
  await page.evaluate(() => document.fonts.ready);
}

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

test.setTimeout(120_000);

const viewports = [
  { name: 'desktop', viewport: { width: 1440, height: 900 }, isMobile: false, deviceScaleFactor: 1 },
  { name: 'mobile', viewport: { width: 390, height: 844 }, isMobile: true, deviceScaleFactor: 2 },
] as const;

for (const { name, viewport, isMobile, deviceScaleFactor } of viewports) {
  test.describe(`${name} · S1b language and engines`, () => {
    test.use({ viewport, isMobile, deviceScaleFactor });

    const shot = (page: Page, testInfo: TestInfo, label: string) => (
      page.screenshot({ path: testInfo.outputPath(`${label}-${name}.png`), fullPage: true, animations: 'disabled', style: HIDE_FLOATING })
    );

    test('eng-catalog /engines for a visitor', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      await mockApi(page);
      await page.goto('/engines');
      const main = page.locator('main');

      await expect(main.getByRole('heading', { level: 1, name: 'Engine catalog' })).toBeVisible();
      await expect(main.getByText('Showing public engines. Log in to also see private engines you own.')).toBeVisible();
      await expect(main.getByRole('link', { name: 'Log in' })).toHaveAttribute('href', '/login');
      const list = main.getByRole('region', { name: 'Engines' });
      await expect(list.getByRole('link')).toHaveCount(3);
      await expect(list.getByRole('link').first()).toHaveAttribute('href', '/engines/bim.builtin/random-search/1.0.0');
      await expect(list.getByRole('link').first()).toContainText('mode · sampling');
      await expect(main.getByText('3 engine revisions')).toBeVisible();
      await expect(main.getByRole('link', { name: 'Register engine' })).toHaveCount(0);
      await expect(main.getByRole('heading', { name: 'My deployments' })).toHaveCount(0);
      await ready(page);

      // Two modes side by side.
      await main.getByRole('checkbox', { name: 'Compare random-search · sampling' }).check();
      await main.getByRole('checkbox', { name: 'Compare minizinc · cp' }).check();
      const comparison = main.getByLabel('Comparison');
      await expect(comparison).toContainText('qos-binding-placement/v1');
      await expect(comparison).toContainText('time_budget_ms (ms, 60,000)');
      const revisions = main.getByRole('region', { name: 'Engine revisions' });
      await expect(revisions.getByRole('row', { name: /evolutionary/ })).toContainText('Published');
      await shot(page, testInfo, 'engines-visitor');

      await main.getByRole('button', { name: 'Minizinc' }).click();
      await expect(main.getByText('1 engine revision', { exact: true })).toBeVisible();
      await main.getByRole('searchbox', { name: 'Search engines' }).fill('zzz');
      await expect(main.getByText('No revision matches “zzz”.')).toBeVisible();

      await expectNoHorizontalOverflow(page);
      expect(critical).toEqual([]);
    });

    test('eng-catalog /engines for a signed-in account', async ({ page }, testInfo) => {
      await mockApi(page, { signedIn: true });
      await page.goto('/engines');
      const main = page.locator('main');

      await expect(main.getByText(/Showing engines visible to your account/)).toBeVisible();
      const edge = main.getByRole('region', { name: 'Engines' }).getByRole('link', { name: /edge-solver/ });
      for (const chip of ['Private · yours', 'Registration active', 'Conformance passed', 'Publication not requested']) await expect(edge.getByText(chip)).toBeVisible();
      await expect(main.getByRole('link', { name: 'My registrations' })).toHaveAttribute('href', '/app/engines/registrations');
      await expect(main.getByRole('link', { name: 'Register engine' })).toHaveAttribute('href', '/app/engines/new');
      await expect(main.getByRole('heading', { name: 'My deployments' })).toBeVisible();
      await expect(main.getByRole('heading', { name: 'edge-solver' })).toBeVisible();
      await expect(main.getByRole('button', { name: 'Deactivate edge-solver' })).toBeVisible();
      await ready(page);
      await shot(page, testInfo, 'engines-signed-in');
      await expectNoHorizontalOverflow(page);
    });

    test('eng-catalog /engines when the gateway fails, and recovers on Retry', async ({ page }, testInfo) => {
      await mockApi(page, { engines: json({ detail: 'service unavailable' }, 503) });
      await page.goto('/engines');
      const main = page.locator('main');
      await expect(main.getByRole('alert')).toContainText('The catalog couldn’t be loaded (HTTP 503).');
      await ready(page);
      await shot(page, testInfo, 'engines-error');
      await page.route(`${API}/v1/explore/engines`, json({ engines: [randomSearch] }));
      await main.getByRole('button', { name: 'Retry' }).click();
      await expect(main.getByRole('region', { name: 'Engines' })).toBeVisible();
      await expect(main.getByRole('alert')).toHaveCount(0);
    });

    test('eng-detail /engines/:namespace/:name/:version for a visitor', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      await mockApi(page);
      await page.goto('/engines/bim.builtin/random-search/1.0.0');
      const main = page.locator('main');

      await expect(main.getByRole('heading', { level: 1, name: 'bim.builtin/random-search@1.0.0' })).toBeVisible();
      await expect(main.getByText(RS_DIGEST, { exact: true })).toBeVisible();
      await expect(main.getByRole('link', { name: 'Log in to run' })).toHaveAttribute('href', '/login');
      const options = main.getByRole('region', { name: 'Options of mode sampling' });
      await expect(main.getByLabel('Plan to preview')).toHaveValue('BASIC');
      await expect(options.getByRole('row', { name: /iterations/ })).toContainText('OPTION_CLAMPED → 10,000');
      await expect(options.getByRole('row', { name: /time_budget_ms/ })).toContainText('60,000 ms (60 s)');
      await expect(options.getByRole('row', { name: /time_budget_ms/ })).toContainText('Within the ceiling');
      await expect(main.getByText(/BASIC allows 60 s and 10,000 iterations per request\. Figures from pricing 0\.1\.0\./)).toBeVisible();
      await expect(main.getByRole('region', { name: 'Mode contract' })).toContainText('Heuristic mode');
      await expect(main.getByRole('region', { name: 'How a run can end' })).toContainText('Declared by this mode');
      await ready(page);
      await shot(page, testInfo, 'engine-detail-modes-basic');

      // The same engine under a larger plan: nothing is reduced.
      await main.getByLabel('Plan to preview').selectOption('RESEARCH');
      await expect(options.getByText(/OPTION_CLAMPED/)).toHaveCount(0);
      await expect(options.getByRole('row', { name: /iterations/ })).toContainText('1,000,000 iterations');

      await main.getByRole('tab', { name: /Capabilities/ }).click();
      await expect(page).toHaveURL(/\/engines\/bim\.builtin\/random-search\/1\.0\.0\?tab=caps$/);
      const capabilities = main.getByRole('region', { name: 'Capabilities by dimension' });
      await expect(capabilities.getByRole('row', { name: /IR extensions/ })).toContainText('qos-binding-placement/v1');
      await expect(capabilities.getByRole('row', { name: /Metric scopes/ })).toContainText('invocation, selectedCandidate');
      await shot(page, testInfo, 'engine-detail-capabilities');

      await main.getByRole('tab', { name: /Registrations/ }).click();
      await expect(main.getByText(/No deployment registrations are listed for this revision/)).toBeVisible();
      await shot(page, testInfo, 'engine-detail-registrations-visitor');

      await expectNoHorizontalOverflow(page);
      expect(critical).toEqual([]);
    });

    test('eng-detail for a signed-in owner shows the registration and its conformance report', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      await mockApi(page, { signedIn: true });
      await page.goto('/engines/lucia/edge-solver/0.3.1?tab=regs');
      const main = page.locator('main');

      await expect(main.getByRole('heading', { level: 1, name: 'lucia/edge-solver@0.3.1' })).toBeVisible();
      await expect(main.getByRole('button', { name: 'Run with this engine' })).toBeVisible();
      await expect(main.getByRole('button', { name: 'Add to a study' })).toBeVisible();
      const item = main.getByRole('region', { name: 'Registration edge-solver' });
      await expect(item.getByText('active for you')).toBeVisible();
      await item.getByRole('button', { name: 'Show conformance report' }).click();
      await expect(item.getByText('Conformance passed')).toBeVisible();
      await expect(item.getByRole('row', { name: /request-contract passed A compiled BindingProblem was accepted/ })).toBeVisible();
      await expect(item).toContainText('3 checks · 842 ms');
      await ready(page);
      await shot(page, testInfo, 'engine-detail-registrations-owner');

      // The run action asks which project.
      await main.getByRole('button', { name: 'Run with this engine' }).click();
      await expect(main.getByRole('link', { name: 'ISA Demo Group / QoS Benchmarks' }))
        .toHaveAttribute('href', `/app/isa-demo/qos-benchmarks/jobs/new?engine=${encodeURIComponent(`lucia/edge-solver@0.3.1#${EDGE_DIGEST}`)}`);

      await main.getByRole('tab', { name: /Modes/ }).click();
      await expect(main.getByLabel('Plan to preview')).toHaveValue('RESEARCH');
      await expect(main.getByRole('columnheader', { name: 'Your plan’s ceiling' })).toBeVisible();
      await expectNoHorizontalOverflow(page);
      expect(critical).toEqual([]);
    });

    test('eng-detail answers a neutral 404 and a digest mismatch', async ({ page }, testInfo) => {
      await mockApi(page);
      await page.goto('/engines/bim.builtin/ghost/9.9.9');
      const main = page.locator('main');
      await expect(main.getByRole('heading', { name: 'Engine revision not found' })).toBeVisible();
      await expect(main.getByRole('link', { name: 'Back to the catalog' })).toHaveAttribute('href', '/engines');
      await ready(page);
      await shot(page, testInfo, 'engine-detail-not-found');

      await page.goto(`/engines/bim.builtin/random-search/1.0.0?digest=sha256-${'0'.repeat(64)}`);
      await expect(main.getByText('This reference points to a different digest (409).')).toBeVisible();
      await expect(main.getByText('Digest mismatch')).toBeVisible();
      await shot(page, testInfo, 'engine-detail-digest-mismatch');
    });

    test('lang-profiles /language', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      await mockApi(page);
      await page.goto('/language');
      const main = page.locator('main');

      await expect(main.getByRole('heading', { level: 1, name: 'The BIM language' })).toBeVisible();
      const chain = main.getByRole('region', { name: 'How the pieces connect' });
      await expect(chain.getByRole('link')).toHaveCount(6);
      await expect(chain).toContainText('Instance');
      await expect(chain).toContainText('Placement');
      const profiles = main.getByRole('region', { name: 'Profiles' });
      await expect(profiles.getByRole('row', { name: /^qos-binding\/v1/ })).toContainText('qos-binding-profile@1.0.0');
      await expect(profiles.getByRole('link', { name: 'application', exact: true })).toHaveAttribute('href', '/language/schemas/Application');
      await expect(profiles.getByRole('article', { name: 'Contract of qos-binding/v1' })).toContainText('Application exactly 1');
      const dialectsTable = main.getByRole('region', { name: 'Dialects' });
      await expect(dialectsTable.getByRole('row', { name: /placement\/v1/ })).toContainText('irExtensions=qos-binding-placement/v1');
      await expect(main.getByRole('link', { name: 'Submit a dialect or resource' })).toHaveCount(0);
      const resources = main.getByRole('region', { name: 'Registered resources' });
      await expect(resources).toContainText('isa-demo/checkout-catalog@2.0.0');
      await ready(page);
      await shot(page, testInfo, 'language-profiles');

      // The resource is fetched by all four pins; the gateway answers 404.
      await resources.getByRole('button', { name: 'Download isa-demo/checkout-catalog@2.0.0' }).click();
      await expect(main.getByText('Resource not found (404).')).toBeVisible();
      await shot(page, testInfo, 'language-profiles-resource-404');

      await main.locator('.profiles-controls select').selectOption('qos-binding/v1');
      await expect(dialectsTable.getByRole('row')).toHaveCount(3);
      await expectNoHorizontalOverflow(page);
      expect(critical).toEqual([]);
    });

    test('lang-profiles shows the extensions link to a signed-in account and the failed-list state', async ({ page }, testInfo) => {
      await mockApi(page, { signedIn: true });
      await page.route(`${API}/v1/dialects`, json({ detail: 'down' }, 503));
      await page.goto('/language');
      const main = page.locator('main');
      await expect(main.getByRole('link', { name: 'Submit a dialect or resource' })).toHaveAttribute('href', '/language/extensions');
      await expect(main.getByRole('alert')).toContainText('The language catalog couldn’t be loaded (HTTP 503). The diagram above still works.');
      await ready(page);
      await shot(page, testInfo, 'language-profiles-error');
    });

    test('lang-schemas /language/schemas/:kind draws the fields, not the JSON', async ({ page, context }, testInfo) => {
      const critical = watchCriticalErrors(page);
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
      await mockApi(page);
      // The menu links to `application`, in lower case.
      await page.goto('/language/schemas/application');
      const main = page.locator('main');

      await expect(main.getByRole('heading', { level: 2, name: 'Application' })).toBeVisible();
      const tree = main.getByRole('tree', { name: 'Application fields' });
      await expect(tree.getByRole('treeitem').first()).toBeVisible();
      await expect(tree.getByText('REQUIRED').first()).toBeVisible();
      await expect(tree.getByText('at least 1', { exact: true })).toBeVisible();
      await expect(main.getByText('Schema identity').locator('..')).toContainText('application.schema.json');
      await expect(page.locator('body')).not.toContainText('"properties"');
      const kinds = main.getByRole('navigation', { name: 'Kinds' });
      await expect(kinds.getByRole('link')).toHaveCount(13);
      await expect(kinds.getByRole('link', { name: /^Application/ })).toHaveAttribute('aria-current', 'page');
      await ready(page);
      await shot(page, testInfo, 'schemas-application');

      await main.getByRole('button', { name: 'Collapse all' }).click();
      await expect(tree.getByRole('treeitem')).toHaveCount(4);
      await main.getByRole('button', { name: 'Expand all' }).click();
      await expect(tree.getByText('minimize', { exact: true })).toBeVisible();
      await main.getByRole('searchbox', { name: 'Find a field' }).fill('probability');
      const hit = tree.getByRole('treeitem').filter({ hasText: 'Branch probability (exclusive)' });
      await expect(hit).toBeVisible();
      await hit.getByRole('button', { name: 'Copy path' }).click();
      await expect(hit.getByRole('button', { name: 'Copied' })).toBeVisible();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('/spec/workflow/probability');
      await shot(page, testInfo, 'schemas-application-search');

      // Another kind through the list, and the engine protocol with its calls.
      await kinds.getByRole('link', { name: /^Engine protocol/ }).click();
      await expect(page).toHaveURL(/\/language\/schemas\/engine-contract$/);
      await expect(main.getByRole('heading', { level: 2, name: 'engine-contract' })).toBeVisible();
      await expect(main.getByRole('region', { name: 'Calls of the engine protocol' })).toContainText('/internal/v1/binding-problems');
      await expect(main.getByText(DIGEST('c0ffee11'), { exact: true })).toBeVisible();
      await shot(page, testInfo, 'schemas-engine-contract');

      await expectNoHorizontalOverflow(page);
      expect(critical).toEqual([]);
    });

    test('lang-schemas answers 404 for an unknown kind', async ({ page }, testInfo) => {
      await mockApi(page);
      await page.goto('/language/schemas/Placment');
      const main = page.locator('main');
      const alert = main.getByRole('alert');
      await expect(alert).toContainText('Unknown kind “Placment” (404)');
      await expect(alert.getByRole('link')).toHaveCount(13);
      await ready(page);
      await shot(page, testInfo, 'schemas-unknown-kind');
      await alert.getByRole('link', { name: 'Placement', exact: true }).click();
      await expect(main.getByRole('heading', { level: 2, name: 'Placement' })).toBeVisible();
    });

    // [utest->req~frontend-nav-language-hub~1]
    test('lang-profiles hub switches between Profiles, Schemas and Extensions at /language/:section?/:item?', async ({ page }) => {
      await mockApi(page, { signedIn: true });
      await page.goto('/language');
      const main = page.locator('main');
      const sections = main.getByRole('navigation', { name: 'Language sections' });
      await expect(main.getByRole('heading', { level: 1, name: 'The BIM language' })).toBeVisible();

      await sections.getByRole('link', { name: 'Schemas' }).click();
      await expect(page).toHaveURL(/\/language\/schemas$/);
      await expect(main.getByRole('heading', { level: 2, name: 'Application' })).toBeVisible();

      await sections.getByRole('link', { name: 'Extensions' }).click();
      await expect(page).toHaveURL(/\/language\/extensions$/);
      await expect(main.getByRole('heading', { level: 1, name: 'Language extensions' })).toBeVisible();
    });

    // [utest->req~frontend-nav-language-hub~1]
    test('lang-profiles hub: signed out, Extensions explains and offers the login', async ({ page }) => {
      await mockApi(page);
      await page.goto('/language/extensions');
      const main = page.locator('main');
      await expect(main.getByRole('link', { name: 'Log in to see and manage language extensions' })).toHaveAttribute('href', '/login');
    });

    // [utest->req~frontend-nav-language-hub~1]
    test('lang-profiles hub: an unknown section answers 404 and the old extensions address moves', async ({ page }) => {
      await mockApi(page, { signedIn: true });
      await page.goto('/language/nowhere');
      await expect(page.locator('main').getByText(/no “nowhere” section \(404\)/)).toBeVisible();

      await page.goto('/app/language/extensions?tab=resources');
      await expect(page).toHaveURL(/\/language\/extensions\?tab=resources$/);
    });

    test('lang-examples /examples', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      await mockApi(page);
      await page.goto('/examples');
      const main = page.locator('main');

      await expect(main.getByRole('heading', { level: 1, name: 'Example packages' })).toBeVisible();
      await expect(main.getByRole('heading', { name: 'Demo · 3 packages' })).toBeVisible();
      await expect(main.getByRole('heading', { name: 'Placement · 1 package' })).toBeVisible();
      await expect(main.getByRole('heading', { name: 'Literature · 1 package' })).toBeVisible();
      const first = main.locator('article').filter({ hasText: 'demo/01_simple_seq' });
      await expect(first).toContainText('A first binding · Basic sequence');
      await expect(first.getByRole('link', { name: 'Open in workbench' })).toHaveAttribute('href', '/workbench?example=demo%2F01_simple_seq');
      await expect(first.getByRole('link', { name: 'Log in to import' })).toHaveAttribute('href', '/login');
      await ready(page);

      const [download] = await Promise.all([page.waitForEvent('download'), first.getByRole('button', { name: 'Download .bim.zip' }).click()]);
      expect(download.suggestedFilename()).toBe('01_simple_seq.bim.zip');
      await expect(first.getByRole('status')).toContainText(/^sha256-[0-9a-f]{64}Copy digest$/);
      await shot(page, testInfo, 'examples-visitor');

      await main.getByRole('button', { name: 'Placement', exact: true }).click();
      await expect(main.getByRole('heading', { name: /^Demo/ })).toHaveCount(0);
      await main.getByRole('button', { name: 'All', exact: true }).click();
      await main.getByRole('searchbox', { name: 'Search examples' }).fill('xor');
      await expect(main.locator('article')).toHaveCount(1);

      await expectNoHorizontalOverflow(page);
      expect(critical).toEqual([]);
    });

    test('lang-examples for a signed-in account imports into a chosen project', async ({ page }, testInfo) => {
      await mockApi(page, { signedIn: true });
      await page.goto('/examples');
      const main = page.locator('main');
      const first = main.locator('article').filter({ hasText: 'demo/01_simple_seq' });

      await expect(main.getByRole('link', { name: 'Log in to import' })).toHaveCount(0);
      await first.getByRole('button', { name: 'Import as case' }).click();
      await expect(first.getByRole('link', { name: 'ISA Demo Group / QoS Benchmarks' }))
        .toHaveAttribute('href', '/app/isa-demo/qos-benchmarks/workbench?example=demo%2F01_simple_seq');
      await ready(page);
      await shot(page, testInfo, 'examples-signed-in');
    });

    test('lang-examples names a corrupt example (422) and survives a failed list', async ({ page }, testInfo) => {
      await mockApi(page);
      await page.route(`${API}/v1/examples/**`, json({ title: 'invalid_example', detail: 'corrupt package' }, 422));
      await page.goto('/examples');
      const main = page.locator('main');
      const second = main.locator('article').filter({ hasText: 'demo/02_parallel' });
      await second.getByRole('button', { name: 'Download .bim.zip' }).click();
      await expect(second.getByRole('alert')).toContainText('This example package is corrupt (422 · invalid_example). The download stopped; other examples are unaffected.');
      await ready(page);
      await shot(page, testInfo, 'examples-corrupt');

      await page.route(`${API}/v1/examples`, json({ detail: 'down' }, 503));
      await page.goto('/examples');
      await expect(main.getByText('Live catalogue unavailable')).toBeVisible();
      await expect(main.getByRole('heading', { name: /^Demo · \d+ packages$/ })).toBeVisible();
    });

    test('pub-workbench /workbench validates an uploaded package', async ({ page, context }, testInfo) => {
      const critical = watchCriticalErrors(page);
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
      await mockApi(page);
      await page.goto('/workbench');
      const main = page.locator('main');

      await expect(main.getByRole('heading', { level: 1, name: 'Workbench' })).toBeVisible();
      await expect(main.getByLabel('Package limits')).toContainText('≤ 16 MiB compressed');
      await expect(main.getByText('No package yet')).toBeVisible();
      await expect(main.getByRole('link', { name: 'Log in to run' })).toHaveAttribute('href', '/login');
      await ready(page);
      await shot(page, testInfo, 'workbench-idle');

      await main.getByLabel('Package file', { exact: true }).setInputFiles({ name: 'checkout-flow.bim.zip', mimeType: 'application/zip', buffer: packageZip() });
      await expect(main.getByText('Ready to validate')).toBeVisible();
      await main.getByRole('button', { name: 'Validate package' }).click();

      await expect(main.getByText('Valid package')).toBeVisible();
      await expect(main.getByText('checkout-flow.bim.zip · profile qos-binding/v1 · 5 tasks')).toBeVisible();
      await expect(main.locator('.workbench-digests')).toContainText('Instance digest');
      await main.getByRole('button', { name: 'Copy package digest' }).click();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(DIGEST('b2c3d4e5'));

      const workflow = main.getByRole('region', { name: 'Workflow' });
      await expect(workflow).toContainText('SEQUENCE');
      await expect(workflow).toContainText('PARALLEL');
      await expect(workflow).toContainText('EXCLUSIVE');
      await expect(workflow).toContainText('autenticar');
      await expect(workflow).toContainText('p 0.7');
      const filesCard = main.getByRole('region', { name: 'Package files' });
      await expect(filesCard).toContainText('Candidate catalog');
      await expect(filesCard).toContainText('sha256-1a2b…3c4d');
      await expect(main.getByRole('region', { name: 'Constraints' })).toContainText('HARD');
      await expect(main.getByRole('region', { name: 'Constraints' })).toContainText('penalty 5');
      await expect(main.getByRole('region', { name: 'Objective' })).toContainText('weighted');
      await expect(main.getByRole('region', { name: 'Choices per task' }).getByRole('row', { name: /inventario service\/stock 3/ })).toBeVisible();
      await ready(page);
      await shot(page, testInfo, 'workbench-valid');

      await main.getByRole('tab', { name: 'Diagnostics (0)' }).click();
      await expect(main.getByText('No diagnostics. Every resource passed validation.')).toBeVisible();

      await expectNoHorizontalOverflow(page);
      expect(critical).toEqual([]);
    });

    test('pub-workbench shows 422 diagnostics grouped by file, and leads back to the file', async ({ page, context }, testInfo) => {
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
      await mockApi(page, { validate: json(invalidProblem, 422) });
      await page.goto('/workbench');
      const main = page.locator('main');

      await main.getByLabel('Package file', { exact: true }).setInputFiles({ name: 'checkout-flow.bim.zip', mimeType: 'application/zip', buffer: packageZip() });
      await main.getByRole('button', { name: 'Validate package' }).click();

      await expect(main.getByText('Not valid · 2 errors')).toBeVisible();
      await expect(main.getByRole('tab', { name: 'Diagnostics (2)' })).toHaveAttribute('aria-selected', 'true');
      const catalog = main.getByRole('region', { name: 'Problems in Candidate catalog · candidates.json' });
      await expect(catalog).toContainText('candidates › t1 › features › latency');
      await expect(catalog).toContainText('Fix: Add a finite value in ms, or remove the candidate.');
      const application = main.getByRole('region', { name: 'Problems in Application · application.json' });
      await expect(application).toContainText('workflow › sequence › item 2');
      await expect(application).toContainText('not structured');
      await catalog.getByRole('button', { name: 'Copy location' }).click();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('candidates.json /spec/candidates/t1/features/latency');
      await ready(page);
      await shot(page, testInfo, 'workbench-invalid');

      await application.getByRole('button', { name: 'Show in package' }).click();
      await expect(main.getByRole('tab', { name: 'Structure' })).toHaveAttribute('aria-selected', 'true');
      await expect(page.locator('[id="wb-file-application.json"]')).toBeFocused();
      await expect(main.getByRole('button', { name: '1 problem' })).toHaveCount(2);
      await shot(page, testInfo, 'workbench-invalid-structure');
      await expectNoHorizontalOverflow(page);
    });

    test('pub-workbench names too large (413), rate limit (429) and an unreadable file', async ({ page }, testInfo) => {
      let calls = 0;
      await mockApi(page, {
        validate: (route) => {
          calls += 1;
          return calls === 1
            ? route.fulfill({ status: 413, contentType: 'application/problem+json', json: { title: 'payload_too_large', status: 413, detail: 'request body exceeds 16777216 bytes' } })
            : calls === 2
              // Retry-After is only readable across origins when the gateway exposes it.
              ? route.fulfill({ status: 429, contentType: 'application/problem+json', headers: { 'Retry-After': '9', 'Access-Control-Expose-Headers': 'Retry-After' }, json: { title: 'rate_limited', status: 429, detail: 'slow down' } })
              : route.fulfill({ status: 200, json: validResult });
        },
      });
      await page.goto('/workbench');
      const main = page.locator('main');
      await main.getByLabel('Package file', { exact: true }).setInputFiles({ name: 'checkout-flow.bim.zip', mimeType: 'application/zip', buffer: packageZip() });

      await main.getByRole('button', { name: 'Validate package' }).click();
      await expect(main.getByRole('alert')).toContainText('The package is too large (413 · payload_too_large)');
      await expect(main.getByRole('alert')).toContainText('your plan sets its own payload ceiling');
      await ready(page);
      await shot(page, testInfo, 'workbench-413');

      await main.getByRole('button', { name: 'Validate package' }).click();
      await expect(main.getByText('Too many validations right now (429).')).toBeVisible();
      await expect(main.getByText(/Try again in 9 s\. Your file is still selected\./)).toBeVisible();
      await shot(page, testInfo, 'workbench-429');
      await main.getByRole('button', { name: 'Try again' }).click();
      await expect(main.getByText('Valid package')).toBeVisible();

      await main.getByRole('button', { name: 'Remove file' }).click();
      await main.getByLabel('Package file', { exact: true }).setInputFiles({ name: 'notes.bim.zip', mimeType: 'application/zip', buffer: Buffer.from('this is not a zip archive') });
      await main.getByRole('button', { name: 'Validate package' }).click();
      await expect(main.getByText('This file can’t be read as a BIM package')).toBeVisible();
      expect(calls).toBe(3);
    });

    test('pub-workbench opens an example from the address, and a signed-in account can save it to a project', async ({ page }, testInfo) => {
      await mockApi(page, { signedIn: true });
      await page.goto('/workbench?example=demo%2F01_simple_seq');
      const main = page.locator('main');

      await expect(main.getByText('Valid package')).toBeVisible();
      await expect(main.getByText('Signed in as lucia')).toBeVisible();
      await expect(main.getByRole('link', { name: 'Log in to run' })).toHaveCount(0);
      await main.getByRole('button', { name: 'Save to a project' }).click();
      await expect(main.getByRole('link', { name: 'ISA Demo Group / QoS Benchmarks' }))
        .toHaveAttribute('href', '/app/isa-demo/qos-benchmarks/workbench?example=demo%2F01_simple_seq');
      await ready(page);
      await shot(page, testInfo, 'workbench-signed-in');
      await expectNoHorizontalOverflow(page);
    });
  });
}
