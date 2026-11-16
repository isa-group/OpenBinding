import { readFileSync } from 'node:fs';
import { expect as baseExpect, test, type Page, type Route, type TestInfo } from '@playwright/test';

// The dev server compiles each route on first use, so the first assertion of a test can wait for a cold page.
const expect = baseExpect.configure({ timeout: 15_000 });
import { CURRENT_FIXTURE, catalogFixture } from '../src/pages/Pricing/pricingFixture';
import { zipStore } from '../src/utils/bimZip';

// S1b · public screens, part 2: eng-catalog, eng-detail, pub-language (its smoke; J6 walks it in f2a-language.spec.ts), pub-workbench.
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

const EXAMPLES = ['demo/01_simple_seq', 'demo/02_parallel', 'demo/03_xor_choice', 'placement/01_small_placement', 'literature/zhang'];

// A small package to upload: the page only unzips it to place findings, and the gateway's answer is mocked.
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

// The gateway's own answers (dump_frontend_fixtures.py): `validate?include=facts` of a complete package, and the 422 of a refused
// package with the files it checked.
const core = (file: string) => JSON.parse(readFileSync(new URL(`../src/test/fixtures/core/${file}`, import.meta.url), 'utf8')) as Record<string, unknown>;
const validResult = core('json-complete.validate.json');
const refusedBody = core('refused.validate.json');
const refusedZip = () => Buffer.from(zipStore(core('refused.package.json') as Record<string, string>));

interface Mocks {
  signedIn?: boolean;
  /** Answers POST /v1/bim/validate. */
  validate?: (route: Route) => Promise<void> | void;
  engines?: (route: Route) => Promise<void> | void;
}

const json = (body: unknown, status = 200) => (route: Route) => route.fulfill({ status, json: body });

/** Everything the six screens read, answered; anything else on the API origin is an empty 404. */
async function mockApi(page: Page, mocks: Mocks = {}) {
  await page.route(`${API}/**`, (route) => route.fulfill({ status: 404, json: { detail: 'not mocked' } }));
  // The public engine catalogue; a signed-in account gets its own list below.
  await page.route(`${API}/v1/engines`, mocks.engines ?? json({ engines: [randomSearch, evolutionary, minizinc] }));
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
    await page.route(`${API}/v1/organizations`, json([{ id: 'org-1', slug: 'isa-demo', name: 'ISA Demo Group', parent_id: null, effective_role: 'OWNER', created_at: '2026-09-01T00:00:00Z' }]));
  }
  // EngineDetail reads the live catalog (the deprecated YAML at /v1/pricing is no longer requested).
  await page.route(`${API}/v1/pricing/catalog`, json(catalogFixture));
  await page.route(`${API}/v1/pricing/current`, json(CURRENT_FIXTURE));
  await page.route(`${API}/v1/engines/protocol`, json({ profiles: [profile] }));
  await page.route(`${API}/v1/bim/templates`, json({ templates: EXAMPLES }));
  await page.route(`${API}/v1/bim/templates/**`, (route) => route.fulfill({
    status: 200, contentType: 'application/vnd.bim+zip', body: packageZip(), headers: { 'Content-Disposition': 'attachment; filename="01_simple_seq.bim.zip"' },
  }));
  // The page asks for the facts (`?include=facts`).
  await page.route(`${API}/v1/bim/validate**`, mocks.validate ?? json(validResult));
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
  test.describe(`${name} · S1b engines and the workbench`, () => {
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
      for (const chip of ['Private · yours', 'Registration active', 'Conformance passed', 'Listing not requested']) await expect(edge.getByText(chip)).toBeVisible();
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
      await page.route(`${API}/v1/engines`, json({ engines: [randomSearch] }));
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
      await expect(main.getByRole('button', { name: 'Copy exact reference' })).toBeVisible();
      await expect(main).not.toContainText(/sha256-|[0-9a-f]{12}/);
      await expect(main.getByRole('link', { name: 'Log in to run' })).toHaveAttribute('href', '/login');
      const options = main.getByRole('region', { name: 'Options of mode sampling' });
      await expect(main.getByLabel('Plan to preview')).toHaveValue('FREE');
      await expect(options.getByRole('row', { name: /iterations/ })).toContainText('Set by the deployment');
      await expect(options.getByRole('row', { name: /time_budget_ms/ })).toContainText('300,000 ms (5 min)');
      await expect(options.getByRole('row', { name: /time_budget_ms/ })).toContainText('Within the ceiling');
      await expect(main.getByText(/FREE allows 5 min per run\. Figures from pricing 0\.2\.0\./)).toBeVisible();
      await expect(main.getByRole('region', { name: 'Mode contract' })).toContainText('Heuristic mode');
      await expect(main.getByRole('region', { name: 'How a run can end' })).toContainText('Declared by this mode');
      await ready(page);
      await shot(page, testInfo, 'engine-detail-modes-basic');

      // The same engine under a larger plan: nothing is reduced.
      await main.getByLabel('Plan to preview').selectOption('RESEARCH');
      await expect(options.getByText(/OPTION_CLAMPED/)).toHaveCount(0);
      await expect(options.getByRole('row', { name: /iterations/ })).toContainText('Not reduced by plan');

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

      // The run action asks which organization.
      await main.getByRole('button', { name: 'Run with this engine' }).click();
      await expect(main.getByRole('link', { name: 'ISA Demo Group' }))
        .toHaveAttribute('href', `/app/isa-demo/runs/new?engine=${encodeURIComponent(`lucia/edge-solver@0.3.1#${EDGE_DIGEST}`)}`);

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

    test('pub-language /language is the Composition2Yaml reference and playground; the old hub addresses answer Page not found', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      await mockApi(page);
      await page.route(`${API}/v1/compositions/validate`, json({ valid: true, diagnostics: [] }));
      await page.goto('/language');
      const main = page.locator('main');

      await expect(main.getByRole('heading', { level: 1, name: 'Composition2Yaml' })).toBeVisible();
      await expect(main.getByRole('textbox', { name: 'composition.yaml source' })).toContainText('syntaxVersion: "1.0"');
      await expect(main.getByRole('toolbar', { name: 'Playground' })).toContainText('Valid Composition2Yaml');
      await expect(main.getByRole('region', { name: 'Problems' })).toContainText('No issues');
      const examples = main.getByRole('heading', { level: 2, name: 'The language by example' }).locator('xpath=ancestor::section[1]');
      await expect(examples.getByRole('article')).toHaveCount(10);
      await expect(examples.getByRole('article').filter({ hasText: 'Presentation stays in the renderer' })).toContainText('Refused: c2y_unknown_key');
      await expect(main.getByRole('link', { name: /Download the schema/ })).toHaveAttribute('href', `${API}/v1/compositions/schema`);
      await expect(main.getByRole('heading', { level: 2, name: 'What is not in the language' })).toBeVisible();
      await ready(page);
      await shot(page, testInfo, 'language');
      await expectNoHorizontalOverflow(page);
      expect(critical).toEqual([]);

      for (const address of ['/language/schemas/Application', '/language/extensions']) {
        await page.goto(address);
        await expect(main.getByRole('heading', { name: 'Page not found' }), address).toBeVisible();
      }
    });

    test('pub-workbench /workbench validates an uploaded package and draws what the gateway compiled', async ({ page, context }, testInfo) => {
      const critical = watchCriticalErrors(page);
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
      let asked = '';
      await mockApi(page, {
        validate: (route) => {
          asked = new URL(route.request().url()).searchParams.get('include') ?? '';
          return route.fulfill({ status: 200, json: validResult });
        },
      });
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
      expect(asked).toBe('facts');
      await expect(main.getByText('checkout-flow.bim.zip · 7 tasks')).toBeVisible();
      await expect(main.locator('.workbench-digests')).toContainText('Instance digest');
      await main.getByRole('button', { name: 'Copy package digest' }).click();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(validResult.packageDigest);

      const holds = main.getByRole('region', { name: 'What the package holds' });
      await expect(holds).toContainText('7tasks');
      await expect(holds).toContainText('14candidates');
      await expect(holds.getByRole('status', { name: /Binding space size: 128 combinations/i })).toBeVisible();
      const workflow = main.getByRole('group', { name: 'Workflow of the package' });
      for (const task of ['authenticate', 'enrich', 'publish']) await expect(workflow).toContainText(task);
      // A table per task on wide screens, cards on phones: either way each candidate is named.
      for (const candidate of ['auth-cloud', 'auth-edge', 'audit-edge']) await expect(main.getByRole('region', { name: 'Candidates', exact: true })).toContainText(candidate);
      await expect(main.getByRole('heading', { level: 2, name: 'Rules and objectives' })).toBeVisible();
      await expect(main.getByRole('region', { name: 'Problems' })).toHaveCount(0);
      await expect(main).not.toContainText(/sha256-|[0-9a-f]{12}/);
      await ready(page);
      await shot(page, testInfo, 'workbench-valid');

      await expectNoHorizontalOverflow(page);
      expect(critical).toEqual([]);
    });

    test('pub-workbench places the findings of a refused package (422) in its files and draws no structure', async ({ page }, testInfo) => {
      await mockApi(page, { validate: json(refusedBody, 422) });
      await page.goto('/workbench');
      const main = page.locator('main');

      await main.getByLabel('Package file', { exact: true }).setInputFiles({ name: 'refused.bim.zip', mimeType: 'application/zip', buffer: refusedZip() });
      await main.getByRole('button', { name: 'Validate package' }).click();

      await expect(main.getByText(/^Not valid · \d+ errors$/)).toBeVisible();
      await expect(main.getByText(/^422 invalid_instance\. Each problem names the file and the place to fix\./)).toBeVisible();
      await expect(main.getByRole('group', { name: 'Workflow of the package' })).toHaveCount(0);
      await expect(main.getByRole('region', { name: 'Candidates', exact: true })).toHaveCount(0);
      const problems = main.getByRole('region', { name: 'Problems' });
      await expect(problems.locator('.pp-group-name', { hasText: 'candidates.json' })).toBeVisible();
      await expect(problems.locator('.pp-group-name', { hasText: 'workflow.bpmn' })).toBeVisible();
      const domain = problems.locator('.pp-item', { hasText: 'candidate feature value is above its declared domain' });
      await expect(domain).toContainText(/Line \d+, column \d+/);
      await expect(domain).toContainText('/spec/candidates/auth-edge/features/latency');
      await expect(problems.locator('.pp-item', { hasText: "BPMN task 'orphan' has no Application task" })).toContainText('Diagram element orphan');
      await ready(page);
      await shot(page, testInfo, 'workbench-invalid');
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

    test('pub-workbench opens a template from the address, and a signed-in account can open it in the problem editor', async ({ page }, testInfo) => {
      await mockApi(page, { signedIn: true });
      await page.goto('/workbench?template=demo%2F01_simple_seq');
      const main = page.locator('main');

      await expect(main.getByText('Valid package')).toBeVisible();
      await expect(main.getByText('Signed in as lucia')).toBeVisible();
      await expect(main.getByRole('link', { name: 'Log in to run' })).toHaveCount(0);
      await main.getByRole('button', { name: 'Open in the problem editor' }).click();
      await expect(main.getByRole('link', { name: 'ISA Demo Group' }))
        .toHaveAttribute('href', '/app/isa-demo/problem-editor?template=demo%2F01_simple_seq');
      await ready(page);
      await shot(page, testInfo, 'workbench-signed-in');
      await expectNoHorizontalOverflow(page);
    });
  });
}
