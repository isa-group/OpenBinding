import { expect as baseExpect, test, type Page, type Route, type TestInfo } from '@playwright/test';
import { failureBody, validationBody } from './helpers/problems';
import type { BindingCase, CaseRevision } from '../src/api/platform';
import { irDocument, refOf, revisionDocument } from '../src/pages/Cases/fixtures';
import { CURRENT_FIXTURE, catalogFixture } from '../src/pages/Pricing/pricingFixture';
import { digestOf, usageOf } from '../src/test/fixtures/resources';
import { DEFAULT_FILES } from '../src/pages/Workbench/bimDocuments';
import { zipStore } from '../src/utils/bimZip';

// S5d · workbench and generator lab: wb-workbench and gen-lab.
// There is no backend: the API origin is answered by page.route(). Screenshots go to testInfo.outputPath() (test-results/, ignored by git)
// so they can be looked at after a run. The desktop walks the states of each screen, the phone gets its layout and its main states.

const API = 'http://localhost:8000';

// Several browsers share one development server, so a screen can take longer than the default five seconds to settle.
const expect = baseExpect.configure({ timeout: 15_000 });

type Handler = (route: Route) => Promise<void> | void;
const json = (body: unknown, status = 200): Handler => (route) => route.fulfill({ status, json: body });
const detail = (status: number, code: string, error: string, extra: Record<string, unknown> = {}): Handler => json(failureBody(status, code, error, extra), status);
const unavailable: Handler = json({ detail: 'The service is not reachable.' }, 503);

const token = (expiresInSeconds: number) => [
  'header',
  Buffer.from(JSON.stringify({ sub: 'user-1', exp: Math.floor(Date.now() / 1000) + expiresInSeconds })).toString('base64'),
  'signature',
].join('.');

const lucia = {
  id: 'user-1', username: 'lucia.vega', email: 'lucia@example.org', role: 'user', is_active: true, plan: 'RESEARCH',
  created_at: '2026-03-02T00:00:00Z', cas_verified: true, institutional_branding: true,
};

type Role = 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER';

const org = (id: string, slug: string, name: string, role: Role, sponsor = 'user-1') => ({
  id, slug, name, parent_id: null, billing_sponsor_user_id: sponsor, effective_role: role, created_at: '2026-03-03T00:00:00Z',
});

const project = (n: number, orgId: string, slug: string, name: string) => ({
  id: `project-${n}`, organization_id: orgId, slug, name, description: '', visibility: 'private', created_by_id: 'user-1',
  created_at: '2026-04-01T00:00:00Z', updated_at: '2026-10-08T00:00:00Z',
  // The contract's `ProjectView.access`: these specs reach every project as a member.
  access: 'member' as const, effective_role: 'OWNER' as Role,
});

const projectsOf: Record<string, ReturnType<typeof project>[]> = {
  'isa-demo': [project(1, 'org-isa-demo', 'qos-benchmarks', 'QoS Benchmarks'), project(2, 'org-isa-demo', 'checkout-privado', 'Checkout (privado)')],
  'consultora-demo': [project(3, 'org-3', 'client-case', 'Client case')],
  'member-lab': [project(4, 'org-4', 'bench', 'Bench')],
};

// --- the case the workbench can open and save into

const flujo: BindingCase = {
  id: 'case-flujo-checkout', project_id: 'project-1', slug: 'flujo-checkout', name: 'Flujo de checkout', description: '', created_by_id: 'user-1', created_at: '2026-04-02T00:00:00Z',
};

const caseRevision = (n: number): CaseRevision => ({
  id: `case-flujo-checkout-r${n}`,
  binding_case_id: flujo.id,
  revision: n,
  digest: digestOf(String(n)),
  document: revisionDocument([['application', 'checkout', refOf('checkout-app', String(n + 1), String(n))]]),
  source_snapshot_id: null,
  created_at: `2026-04-0${n}T00:00:00Z`,
});

// --- what the gateway answers

const ENGINE = { namespace: 'bim.builtin', name: 'random-search', version: '1.0.0', digest: 'sha256-a' };
const REGISTRATION = { namespace: 'bim.builtin', name: 'random-search-deployment', version: '1.0.0+builtin.a', digest: 'sha256-registration-a' };
const EDGE = { namespace: 'lucia-vega', name: 'edge-solver', version: '0.3.1', digest: 'sha256-e' };
const EDGE_REGISTRATION = { namespace: 'lucia-vega', name: 'edge-solver-eu', version: '1', digest: 'sha256-r' };

const analysisBody = () => ({
  valid: true,
  instanceDigest: digestOf('a'),
  packageDigest: digestOf('b'),
  irDigest: digestOf('c'),
  fileDigests: {},
  resourceDigests: {},
  diagnostics: [],
  compatibleModes: [
    { engine: ENGINE, registration: REGISTRATION, mode: 'seeded', compatible: true },
    { engine: EDGE, registration: EDGE_REGISTRATION, mode: 'placement', compatible: false, diagnostics: [{ message: 'It cannot read a RoutingOverlay.' }] },
  ],
  analysis: { tasks: 1, candidates: 2, constraints: 0, placement: false, bindingSpace: '128' },
});

const completedJob = {
  id: 'job-1',
  status: 'completed',
  result: {
    termination: 'FEASIBLE',
    solutions: [{
      decision: { kind: 'binding', binding: { hello: { resource: 'catalog', id: 'service-a' } } },
      metrics: { latency: 10 },
      objectives: { mode: 'weighted', components: [], penalty: 0, score: 10 },
      penalties: [],
      violations: [],
    }],
  },
};

/** The files of the starter package, with the objects as the generator sends them. */
function generatedFiles(name: string): Record<string, unknown> {
  const files: Record<string, unknown> = {};
  for (const [path, text] of Object.entries(DEFAULT_FILES)) files[path] = path.endsWith('.json') ? JSON.parse(text) : text;
  (files['instance.json'] as { metadata: { name: string } }).metadata.name = name;
  return files;
}

const generated = (name = 'generated_qaco') => ({
  name,
  package_digest: digestOf('1'),
  instance_digest: digestOf('2'),
  compilation_digest: digestOf('3'),
  snapshot_id: null,
  case_id: null,
  target_engines: ['evolutionary-heuristics', 'minizinc-csp'],
  workload_features: {},
  files: generatedFiles(name),
  actual_constraint_count: 1,
});

const corpus = (count: number) => ({
  name: 'generated_qaco',
  count,
  instances: Array.from({ length: count }, (_, index) => ({
    name: `generated_qaco_${index + 1}`, package_digest: digestOf('4'), compilation_digest: digestOf('5'), workload_features: {}, actual_constraint_count: 1,
  })),
});

type Overridable = 'validate' | 'snapshot' | 'saveRevision' | 'instance' | 'corpus' | 'convert';

interface State {
  /** A handler that replaces the default answer of one call. */
  refuse: Partial<Record<Overridable, Handler>>;
  /** The last body each write carried, to check what was sent. */
  sent: Record<string, unknown>;
}

interface MockOptions {
  /** The account's role in ISA Demo Group. */
  role?: Role;
  /** A platform administrator. */
  admin?: boolean;
}

const bodyOf = (route: Route) => route.request().postDataJSON() as Record<string, unknown>;

/** Everything these screens read and write, answered; anything else on the API origin is an empty 404. */
async function mockApi(page: Page, options: MockOptions = {}): Promise<State> {
  const state: State = { refuse: {}, sent: {} };
  const organizations = [
    org('org-isa-demo', 'isa-demo', 'ISA Demo Group', options.role ?? 'ADMIN'),
    org('org-3', 'consultora-demo', 'Consultora Demo', 'VIEWER', 'user-nora'),
    org('org-4', 'member-lab', 'Member Lab', 'MEMBER', 'user-nora'),
  ];
  await page.addInitScript(() => {
    localStorage.setItem('openbinding-access-token', 's5d-access');
    localStorage.setItem('openbinding-refresh-token', 's5d-refresh');
  });

  await page.route(`${API}/**`, (route) => route.fulfill({ status: 404, json: { detail: 'not mocked' } }));
  await page.route(`${API}/health**`, json({ status: 'ok' }));
  await page.route(`${API}/v1/auth/refresh`, json({ access_token: 's5d-access-2', refresh_token: 's5d-refresh-2', token_type: 'bearer', expires_in: 900 }));
  await page.route(`${API}/v1/pricing/catalog`, json(catalogFixture));
  await page.route(`${API}/v1/pricing/current`, json(CURRENT_FIXTURE));
  await page.route(`${API}/v1/users/me`, json(options.admin ? { ...lucia, role: 'admin' } : lucia));
  await page.route(`${API}/v1/users/me/usage`, json(usageOf({ capabilities: { maxPayloadBytes: 134_217_728, maxInstanceComplexityLog10: 20, storageBytes: 5_368_709_120 } })));
  await page.route(`${API}/v1/users/me/pricing-token`, json({ pricing_token: token(3600) }));
  await page.route(new RegExp(`^${API}/v1/notifications(\\?.*)?$`), json([]));
  await page.route(`${API}/v1/profiles`, json({ profiles: [] }));
  await page.route(`${API}/v1/examples`, json({ examples: ['demo/01_simple_seq'] }));
  await page.route(`${API}/v1/engines`, json({ engines: [{ ...ENGINE, id: 'engine-1', ref: ENGINE, modes: [] }, { ...EDGE, id: 'engine-2', ref: EDGE, modes: [] }] }));

  await page.route(`${API}/v1/validate`, (route) => (state.refuse.validate ?? json(analysisBody()))(route));
  await page.route(`${API}/v1/instances`, (route) => {
    state.sent.snapshot = route.request().headers()['content-type'];
    return (state.refuse.snapshot ?? json({ id: 'snapshot-1', irDigest: digestOf('c') }, 201))(route);
  });
  await page.route(`${API}/v1/instances/snapshot-1/ir`, json(irDocument()));
  await page.route(`${API}/v1/jobs`, (route) => {
    state.sent.job = bodyOf(route);
    return json({ id: 'job-1', status: 'queued', irDigest: digestOf('c') }, 202)(route);
  });
  await page.route(`${API}/v1/jobs/job-1`, json(completedJob));
  // The run's compiled problem: not available here, so RunResult falls back to the ids it has.
  await page.route(`${API}/v1/jobs/job-1/ir`, (route) => route.fulfill({ status: 404, json: { detail: 'not found' } }));

  await page.route(`${API}/v1/generator/instances`, (route) => {
    // Every body the lab sent for an instance, in order: the preview first, then what was kept.
    state.sent.instances = [...((state.sent.instances as unknown[] | undefined) ?? []), bodyOf(route)];
    return (state.refuse.instance ?? json(generated()))(route);
  });
  await page.route(`${API}/v1/generator/corpus`, (route) => {
    state.sent.corpus = bodyOf(route);
    return (state.refuse.corpus ?? json(corpus(Number((bodyOf(route) as { count: number }).count))))(route);
  });
  await page.route(`${API}/v1/generator/convert-legacy`, (route) => {
    state.sent.convert = bodyOf(route);
    return (state.refuse.convert ?? json(generated('converted_legacy')))(route);
  });

  await page.route(new RegExp(`^${API}/v1/organizations(/.*)?(\\?.*)?$`), async (route) => {
    const url = new URL(route.request().url());
    const parts = url.pathname.split('/').filter(Boolean);
    // /v1/organizations/{org}/projects/{project}/cases/{case}/revisions
    const [, , orgSlug, section, projectSlug, sub, subId, action] = parts;
    const method = route.request().method();
    const found = organizations.find((item) => item.slug === orgSlug);

    if (!orgSlug) return json(organizations)(route);
    if (section === 'members' || section === 'library') return json([])(route);
    if (section !== 'projects') return json(found ?? { detail: { code: 'not_found', error: 'Organization not found.' } }, found ? 200 : 404)(route);

    const list = projectsOf[orgSlug] ?? [];
    if (!projectSlug) return json(list)(route);
    const current = list.find((item) => item.slug === projectSlug);
    if (!current) return detail(404, 'not_found', 'Project not found.')(route);
    if (!sub) return json(current)(route);

    if (sub === 'cases') {
      if (!subId) return json(projectSlug === 'qos-benchmarks' ? [flujo] : [])(route);
      if (action === 'revisions' && method === 'POST') {
        state.sent.saveRevision = bodyOf(route);
        return (state.refuse.saveRevision ?? json(caseRevision(3), 201))(route);
      }
      return json(subId === flujo.slug ? [caseRevision(1), caseRevision(2)] : [])(route);
    }
    return json([])(route);
  });
  return state;
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

/** With E2E_SCREENSHOTS=1, a full-page picture of the current state for a person to look at; always a check that nothing scrolls sideways. */
async function capture(page: Page, testInfo: TestInfo, name: string) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    (document.activeElement as HTMLElement | null)?.blur();
    window.scrollTo(0, 0);
  });
  if (process.env.E2E_SCREENSHOTS) await page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true, animations: 'disabled' });
  // Against the width of the device, not window.innerWidth: a phone widens its layout viewport to fit a page that overflows.
  const width = page.viewportSize()?.width ?? 0;
  const overflow = await page.evaluate((expected) => document.documentElement.scrollWidth - expected, width);
  expect(overflow, `${name} should not scroll sideways`).toBeLessThanOrEqual(1);
}

/** A call that stays unanswered until the test lets it go, to look at the state in between. */
function held(answer: () => Handler) {
  let release: () => void = () => undefined;
  const until = new Promise<void>((resolve) => { release = resolve; });
  const handler: Handler = async (route) => {
    await until;
    await answer()(route);
  };
  return { handler, release: () => release() };
}

const problem = (title: string, status: number, diagnostics: unknown[]): Handler => json({ title, status, detail: 'The BIM package did not compile.', diagnostics }, status);

// Each test walks a screen through its states while the dev server compiles on demand.
test.setTimeout(150_000);
// One worker for the whole file: with every test in parallel the browsers starve each other and the same walk takes twice as long.
test.describe.configure({ mode: 'default' });

const viewports = [
  { name: 'desktop', viewport: { width: 1440, height: 900 }, isMobile: false, deviceScaleFactor: 1 },
  { name: 'mobile', viewport: { width: 390, height: 844 }, isMobile: true, deviceScaleFactor: 2 },
] as const;

const ROOT = '/app/isa-demo/qos-benchmarks';
const WORKBENCH = `${ROOT}/workbench`;
const LAB = '/app/generator';

const packageUpload = () => ({ name: 'imported.bim.zip', mimeType: 'application/vnd.bim+zip', buffer: Buffer.from(zipStore(DEFAULT_FILES)) });

for (const { name, viewport, isMobile, deviceScaleFactor } of viewports) {
  test.describe(`${name} · S5d workbench and generator lab`, () => {
    test.use({ viewport, isMobile, deviceScaleFactor });

    test('wb-workbench /app/:org/:project/workbench · package, check and result views', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      await page.goto(WORKBENCH);
      const main = page.locator('#platform-main');
      const index = main.getByRole('navigation', { name: 'BIM resources' });

      await expect(main.getByRole('heading', { level: 1, name: 'Workbench' })).toBeVisible();
      await expect(main.getByText('Check a package, see which engines can run it, then snapshot, run or save it as a case revision.')).toBeVisible();
      await expect(main.getByRole('link', { name: 'Generate a synthetic instance' })).toHaveAttribute('href', LAB);
      await expect(main.getByRole('navigation', { name: 'Project sections' }).getByRole('link', { name: 'Cases', exact: true })).toHaveAttribute('aria-current', 'page');
      await expect(main.getByRole('tab', { name: 'Case revision' })).toHaveAttribute('aria-selected', 'true');
      await expect(main.getByText(/Nothing validated yet/)).toBeVisible();
      await expect(index).toContainText('workflow.bpmn');
      await expect(main.getByRole('region', { name: 'Package actions' })).toHaveCount(0);
      await capture(page, testInfo, `workbench-${name}-idle`);

      // A revision of a case opens from the two selects, and the address remembers it.
      await expect(main.getByRole('option', { name: 'Flujo de checkout', exact: true })).toHaveCount(1);
      await main.getByRole('combobox', { name: 'Case', exact: true }).selectOption('flujo-checkout');
      await expect(main.getByRole('combobox', { name: 'Revision' })).toBeEnabled();
      await main.getByRole('combobox', { name: 'Revision' }).selectOption({ label: 'Flujo de checkout · revision 2' });
      await expect(page).toHaveURL(/case=flujo-checkout&revision=case-flujo-checkout-r2/);
      await expect(main.getByText('Loaded revision 2')).toBeVisible();
      await expect(index).toContainText('isa-demo/checkout-app@3');
      await capture(page, testInfo, `workbench-${name}-case-revision`);

      // A file is read, compiled by the gateway, and replaces the package only when it is accepted.
      await main.getByRole('tab', { name: 'Upload file' }).click();
      await expect(main.getByText('Up to 128 MiB on your plan (RESEARCH)')).toBeVisible();
      await expect(main.getByText('Drop a .bim.zip here')).toBeVisible();
      await capture(page, testInfo, `workbench-${name}-upload`);
      const compiling = held(() => json(analysisBody()));
      state.refuse.validate = compiling.handler;
      await main.getByLabel('Import .bim.zip').setInputFiles(packageUpload());
      await expect(main.getByRole('status').filter({ hasText: 'Checking the package you brought in…' })).toBeVisible();
      await capture(page, testInfo, `workbench-${name}-compiling`);
      compiling.release();

      await expect(main.getByRole('heading', { name: 'Valid package' })).toBeVisible();
      await expect(main.getByText('hello-bim · qos-binding/v1')).toBeVisible();
      await expect(main.getByRole('button', { name: 'Copy the instance fingerprint' })).toContainText('sha256-aaaa…aaaa');
      const counts = main.getByRole('list', { name: 'What the package holds' }).getByRole('listitem');
      await expect(counts).toHaveCount(5);
      await expect(counts.nth(0)).toContainText('tasks');
      await expect(counts.nth(4)).toContainText('None');
      await expect(main.getByRole('region', { name: 'Package actions' })).toBeVisible();
      await capture(page, testInfo, `workbench-${name}-valid`);

      // The workflow is drawn once the package has been compiled.
      await main.getByRole('button', { name: 'Draw the workflow' }).click();
      await expect(main.getByRole('img', { name: /^Workflow: authenticate, then inventory and shipping in parallel/ })).toBeVisible();
      await capture(page, testInfo, `workbench-${name}-workflow`);

      // Which engines can run it, and why the others cannot.
      await main.getByRole('tab', { name: /Engines that can run it/ }).click();
      const table = main.getByRole('table', { name: 'Engine modes and whether they can run this package' });
      await expect(table.getByRole('row')).toHaveCount(3);
      await expect(table.getByRole('row', { name: /random-search 1\.0\.0/ })).toContainText('Yes');
      await expect(table.getByRole('row', { name: /edge-solver 0\.3\.1/ })).toContainText('Registered');
      await expect(table.getByRole('row', { name: /edge-solver 0\.3\.1/ })).toContainText('It cannot read a RoutingOverlay.');
      await capture(page, testInfo, `workbench-${name}-engines`);

      await main.getByRole('tab', { name: /^Files/ }).click();
      await expect(main.getByRole('list', { name: 'Files in the package' }).getByRole('listitem')).toHaveCount(5);
      await expect(main.getByText('Root of the package · 4 resources')).toBeVisible();
      await capture(page, testInfo, `workbench-${name}-files`);
      expect(critical).toEqual([]);
    });

    test('wb-workbench /app/:org/:project/workbench · what the gateway refuses', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      await page.goto(WORKBENCH);
      const main = page.locator('#platform-main');
      const validate = main.getByRole('button', { name: 'Validate', exact: true });
      await expect(main.getByText(/Nothing validated yet/)).toBeVisible();

      // 422: the problems by file and place, each leading to where it lives.
      state.refuse.validate = problem('invalid_package', 422, [
        { code: 'missing_metric', message: 'latency is required', resource: 'catalog', jsonPointer: '/spec/candidates/service-a/features/latency', fix: 'Add a finite value with a unit.' },
        { code: 'unsupported_bpmn', message: 'The task is not executable.', resource: 'workflow', bpmnElement: 'hello' },
      ]);
      await validate.click();
      await expect(main.getByText('Not valid · 2 problems (422 · invalid_package)')).toBeVisible();
      const problems = main.getByRole('list', { name: 'Diagnostics' }).getByRole('listitem');
      await expect(problems).toHaveCount(2);
      await expect(problems.nth(0)).toContainText('candidates.json');
      await expect(problems.nth(0)).toContainText('Fix: Add a finite value with a unit.');
      await expect(problems.nth(1)).toContainText('BPMN element hello');
      await capture(page, testInfo, `workbench-${name}-422`);
      await main.getByRole('button', { name: /missing_metric latency is required/ }).click();
      await expect(main.getByLabel('candidates.json source')).toBeVisible();
      await expect(main.getByRole('button', { name: 'View source' })).toHaveAttribute('aria-expanded', 'true');
      await capture(page, testInfo, `workbench-${name}-422-source`);

      // 402: too big for the plan, without inventing how far over it is.
      state.refuse.validate = detail(402, 'instance_complexity_exceeded', 'The compiled problem is larger than the plan allows.', {
        quota: { limit_id: 'maxInstanceComplexityLog10', limit: 9 },
      });
      await validate.click();
      const tooBig = main.getByRole('alert').filter({ hasText: 'Too big for your plan' });
      await expect(tooBig).toContainText('Too big for your plan (402 · instance_complexity_exceeded)');
      await expect(tooBig).toContainText('Your RESEARCH plan allows up to 109 combinations.');
      await expect(tooBig).toContainText('The server doesn’t report the measured size in this answer, so we can’t show how far over it is.');
      await expect(tooBig.getByRole('link', { name: 'Compare plans' })).toHaveAttribute('href', '/pricing');
      await capture(page, testInfo, `workbench-${name}-402`);

      // 413: larger than the plan takes in one request.
      state.refuse.validate = detail(413, 'payload_too_large', 'The package exceeds the request size limit.');
      await validate.click();
      await expect(main.getByText('The file is larger than your plan allows per request (128 MiB) · 413.')).toBeVisible();
      await capture(page, testInfo, `workbench-${name}-413`);

      // 403: the credential cannot validate.
      state.refuse.validate = detail(403, 'api_key_forbidden', 'The API key does not include validate_instances.');
      await validate.click();
      await expect(main.getByRole('alert').filter({ hasText: 'This credential doesn’t include' })).toContainText('(403 · api_key_forbidden), so the package can’t be checked with it.');
      await capture(page, testInfo, `workbench-${name}-403-key`);

      // The service does not answer: nothing is said about the package, and checking again works.
      state.refuse.validate = unavailable;
      await validate.click();
      const failed = main.getByRole('alert').filter({ hasText: 'The package couldn’t be checked' });
      await expect(failed).toContainText('A service OpenBinding depends on isn’t answering (503), so nothing was checked.');
      await capture(page, testInfo, `workbench-${name}-503`);
      state.refuse.validate = undefined;
      await failed.getByRole('button', { name: 'Check again' }).click();
      await expect(main.getByRole('heading', { name: 'Valid package' })).toBeVisible();
      expect(critical).toEqual([]);
    });

    test('wb-workbench /app/:org/:project/workbench · the editor and its source', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      await page.goto(WORKBENCH);
      const main = page.locator('#platform-main');
      const index = main.getByRole('navigation', { name: 'BIM resources' });

      // The resources are forms; nothing raw is on the page until View source is asked for.
      await expect(main.getByRole('heading', { name: 'Package editor' })).toBeVisible();
      await expect(main.getByRole('list', { name: 'Resources of the package' }).getByRole('listitem')).toHaveCount(4);
      await expect(main.getByLabel('instance.json source')).toHaveCount(0);
      await capture(page, testInfo, `editor-${name}-resources`);

      await index.getByRole('button', { name: /candidates\.json/ }).click();
      await expect(main.getByRole('heading', { name: 'Feature bindings' })).toBeVisible();
      await expect(main.getByLabel('service-a QoS latency')).toHaveValue('10');
      await main.getByLabel('service-a QoS latency').fill('12');
      await main.getByRole('button', { name: 'Add candidate' }).click();
      await expect(main.getByLabel('candidate2 capability 1 type')).toBeVisible();
      await capture(page, testInfo, `editor-${name}-form`);

      await index.getByRole('button', { name: /instance\.json/ }).click();
      await main.getByLabel('Name', { exact: true }).fill('edited-in-the-browser');
      await expect(main.getByRole('button', { name: 'Undo edit' })).toBeEnabled();

      // View source: the exact JSON, a YAML reading, the diff against what was loaded.
      await main.getByRole('button', { name: 'View source' }).click();
      await expect(main.getByLabel('instance.json source')).toContainText('edited-in-the-browser');
      await main.getByRole('tab', { name: 'YAML view' }).click();
      await expect(main.getByLabel('instance.json YAML view')).toContainText('edited-in-the-browser');
      await main.getByRole('tab', { name: 'Source diff' }).click();
      await expect(main.getByText('Modified')).toBeVisible();
      await expect(main.getByLabel('Changes to instance.json')).toContainText('edited-in-the-browser');
      await capture(page, testInfo, `editor-${name}-source`);

      // What was edited is what the gateway receives.
      const validated = page.waitForRequest((request) => request.url() === `${API}/v1/validate` && request.method() === 'POST');
      await main.getByRole('button', { name: 'Validate', exact: true }).click();
      const request = await validated;
      expect(request.headers()['content-type']).toContain('application/vnd.bim+zip');
      expect(Array.from(request.postDataBuffer()?.subarray(0, 4) ?? [])).toEqual([0x50, 0x4b, 0x03, 0x04]);
      await expect(main.getByRole('heading', { name: 'Valid package' })).toBeVisible();

      // An export, an undo and a reset.
      const downloaded = page.waitForEvent('download');
      await main.getByRole('button', { name: 'Export .bim.zip' }).click();
      expect((await downloaded).suggestedFilename()).toBe('edited-in-the-browser.bim.zip');
      await main.getByRole('button', { name: 'Reset workspace' }).click();
      await index.getByRole('button', { name: /instance\.json/ }).click();
      await expect(main.getByLabel('Name', { exact: true })).toHaveValue('hello-bim');
      if (isMobile) {
        expect(critical).toEqual([]);
        return;
      }

      // The workflow diagram is drawn by bpmn-js with the page's toolbar and panel; a diagnostic leads to its element.
      state.refuse.validate = problem('unsupported_bpmn', 422, [{ code: 'unsupported_bpmn', message: 'The task is not executable.', resource: 'workflow', bpmnElement: 'hello' }]);
      await main.getByRole('button', { name: 'Validate', exact: true }).click();
      await main.getByRole('button', { name: /unsupported_bpmn The task is not executable/ }).click();
      await expect(main.getByRole('toolbar', { name: 'Diagram tools' })).toBeVisible({ timeout: 90_000 });
      await expect(main.locator('.djs-palette')).toBeVisible();
      await expect(main.locator('.djs-element.selected[data-element-id="hello"]')).toBeVisible();
      const selected = main.getByRole('complementary', { name: 'Selected element' });
      await expect(selected).toContainText('Service task');
      await expect(selected).toContainText('hello');
      await capture(page, testInfo, `editor-${name}-bpmn`);

      await selected.getByLabel('Name').fill('Say hello');
      await expect(main.locator('.djs-element[data-element-id="hello"]')).toContainText('Say hello');
      // View source is still open from before: it stays open until it is closed.
      await expect(main.getByRole('button', { name: 'View source' })).toHaveAttribute('aria-expanded', 'true');
      await main.getByRole('tab', { name: 'BPMN XML' }).click();
      await expect(main.getByLabel('workflow.bpmn XML source')).toContainText('Say hello');
      await capture(page, testInfo, `editor-${name}-bpmn-source`);
      expect(critical).toEqual([]);
    });

    test('wb-workbench /app/:org/:project/workbench · snapshot, save as a revision and run', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      await page.goto(`${WORKBENCH}?case=flujo-checkout`);
      const main = page.locator('#platform-main');
      await expect(main.getByRole('combobox', { name: 'Case', exact: true })).toHaveValue('flujo-checkout');
      await main.getByRole('button', { name: 'Validate', exact: true }).click();
      const bar = main.getByRole('region', { name: 'Package actions' });
      await expect(bar).toContainText('Valid packages can be snapshotted, run or saved as a revision of a case.');
      await expect(bar.getByRole('combobox', { name: 'Save into case' })).toHaveValue('flujo-checkout');
      await capture(page, testInfo, `bar-${name}-valid`);

      // One private snapshot, which also draws the workflow.
      await bar.getByRole('button', { name: 'Create snapshot' }).click();
      await expect(main.getByText('Snapshot created. It is private to your account and never changes.')).toBeVisible();
      await expect(main.getByRole('link', { name: 'Open snapshot' })).toHaveAttribute('href', `${ROOT}/snapshots/snapshot-1`);
      await expect(bar.getByRole('button', { name: 'Snapshot created' })).toBeVisible();
      await expect(main.getByRole('img', { name: /^Workflow: authenticate/ })).toBeVisible();
      await capture(page, testInfo, `bar-${name}-snapshot`);

      // Saved as a revision of the case, with the snapshot it came from.
      await expect(bar.getByRole('button', { name: 'Save as case revision' })).toBeEnabled();
      await bar.getByRole('button', { name: 'Save as case revision' }).click();
      await expect(main.getByText('Revision 3 of Flujo de checkout saved and sealed.')).toBeVisible();
      await expect(main.getByRole('link', { name: 'Open it' })).toHaveAttribute('href', `${ROOT}/cases/flujo-checkout/revisions/3`);
      const saved = state.sent.saveRevision as { document: { metadata: { name: string } }; source_snapshot_id: string; resources: unknown[] };
      expect(saved.source_snapshot_id).toBe('snapshot-1');
      expect(saved.document.metadata.name).toBe('hello-bim');
      expect(saved.resources).toEqual([]);
      await capture(page, testInfo, `bar-${name}-saved`);

      // The gateway's refusal keeps the package and says why.
      state.refuse.saveRevision = detail(403, 'forbidden', 'The API key does not include projects:write.');
      await bar.getByRole('button', { name: 'Save as case revision' }).click();
      await expect(main.getByRole('alert').filter({ hasText: 'The revision wasn’t saved' })).toContainText('(403 · forbidden). Nothing was saved.');
      await capture(page, testInfo, `bar-${name}-403`);

      // Run with the engine mode the analysis offered; the same snapshot is used.
      await main.getByRole('button', { name: 'Solve' }).click();
      const runResult = main.getByRole('region', { name: 'Authoritative result' }).getByRole('region', { name: 'Run result' });
      await expect(runResult.getByRole('cell', { name: 'service-a' })).toBeVisible();
      await expect(runResult.getByText('View source').first()).toBeVisible();
      expect(state.sent.job).toMatchObject({ snapshot: 'snapshot-1', engine: ENGINE, registration: REGISTRATION, mode: 'seeded' });
      await capture(page, testInfo, `bar-${name}-run`);
      expect(critical).toEqual([]);
    });

    test('wb-workbench /app/:org/:project/workbench · a VIEWER snapshots and runs but does not save', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      await mockApi(page, { role: 'VIEWER' });
      await page.goto(WORKBENCH);
      const main = page.locator('#platform-main');
      await main.getByRole('button', { name: 'Validate', exact: true }).click();
      const bar = main.getByRole('region', { name: 'Package actions' });
      await expect(bar).toContainText('You can snapshot and run with your own account; saving into this project needs MEMBER.');
      await expect(bar.getByRole('button', { name: 'Save as case revision' })).toBeDisabled();
      await expect(bar.getByRole('combobox', { name: 'Save into case' })).toHaveCount(0);
      await expect(bar.getByRole('button', { name: 'Create snapshot' })).toBeEnabled();
      await expect(main.getByRole('button', { name: 'Solve' })).toBeEnabled();
      await capture(page, testInfo, `bar-${name}-viewer`);

      // A project the account is not in reads like one that does not exist.
      await page.goto('/app/isa-demo/ghost/workbench');
      await expect(main.getByRole('heading', { name: 'Project not found' })).toBeVisible();
      await capture(page, testInfo, `bar-${name}-404`);
      expect(critical).toEqual([]);
    });

    test('gen-lab /app/generator · one instance, keeping it and handing it to the workbench', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      await page.goto(LAB);
      const main = page.locator('#platform-main');
      const preview = main.getByRole('region', { name: 'Preview' });
      const keep = main.getByRole('region', { name: 'Keep it' });

      await expect(main.getByRole('heading', { level: 1, name: 'Generator lab' })).toBeVisible();
      await expect(main.getByText(/A research tool; results are labelled synthetic\./)).toBeVisible();
      await expect(main.getByRole('tab')).toHaveText(['One instance', 'Batch', 'Convert old format']);
      await expect(main.getByLabel('Tasks', { exact: true })).toHaveValue('6');
      await expect(main.getByLabel('Candidates per task')).toHaveValue('5');
      await expect(main.getByLabel('Random seed')).toHaveValue('42');
      await expect(preview).toContainText('Default settings shown. Generate to see the structure.');
      await expect(keep.getByRole('option')).toHaveText(['QoS Benchmarks · ISA Demo Group', 'Checkout (privado) · ISA Demo Group', 'Bench · Member Lab']);
      await expect(keep.getByRole('button', { name: 'Save to project' })).toBeDisabled();
      await capture(page, testInfo, `lab-${name}-default`);

      // The settings that cannot be generated are marked before anything is sent (422).
      await main.getByLabel('Tasks', { exact: true }).fill('1');
      await main.getByRole('button', { name: 'Generate instance' }).click();
      await expect(main.getByRole('alert')).toContainText('Check the highlighted fields (422)');
      await expect(main.getByLabel('Tasks', { exact: true })).toHaveAttribute('aria-invalid', 'true');
      await expect(main.getByText('Tasks: a whole number from 2 to 1000.')).toBeVisible();
      expect(state.sent.instances).toBeUndefined();
      await capture(page, testInfo, `lab-${name}-422-settings`);

      // The server refuses the combination (422): the field it names is marked.
      await main.getByLabel('Tasks', { exact: true }).fill('6');
      state.refuse.instance = json(validationBody('candidates', [{ code: 'value_error', message: 'Too many candidates for these tasks', pointer: '/candidates' }]), 422);
      await main.getByRole('button', { name: 'Generate instance' }).click();
      await expect(main.getByRole('alert')).toContainText('These settings can’t be generated (422 · invalid generation config): the server rejected the combination.');
      await expect(main.getByLabel('Candidates per task')).toHaveAttribute('aria-invalid', 'true');
      await expect(main.getByText('Too many candidates for these tasks')).toBeVisible();
      await capture(page, testInfo, `lab-${name}-422-server`);

      // Generating, then the structure with its figures.
      const generating = held(() => json(generated()));
      state.refuse.instance = generating.handler;
      await main.getByLabel('Random seed').fill('7');
      await main.getByText('Bell curve').click();
      await main.getByRole('button', { name: 'Generate instance' }).click();
      await expect(preview.getByText('Generating…')).toBeVisible();
      await capture(page, testInfo, `lab-${name}-generating`);
      generating.release();
      await expect(preview.getByRole('list', { name: 'Workflow of 6 tasks, in sequence' }).getByRole('listitem')).toHaveCount(6);
      await expect(preview).toContainText('≈ 10^4.2');
      await expect(preview).toContainText('Synthetic · fingerprint sha256-1111…1111');
      const sent = (state.sent.instances as Array<Record<string, unknown>>).at(-1) as { seed: number; features: Array<{ id: string; distribution: { kind: string } }> };
      expect(sent.seed).toBe(7);
      expect(sent.features.find((feature) => feature.id === 'latency')?.distribution.kind).toBe('normal');
      await preview.getByText('View source').click();
      await expect(preview.getByRole('combobox', { name: 'File' })).toHaveValue('instance.json');
      await expect(keep.getByRole('button', { name: 'Save to project' })).toBeEnabled();
      await capture(page, testInfo, `lab-${name}-generated`);

      // Keeping it: the project is gone (404), the account may not add to it (403), then it is kept.
      state.refuse.instance = detail(404, 'not_found', 'Project not found.');
      await keep.getByRole('button', { name: 'Save to project' }).click();
      await expect(keep.getByRole('alert')).toContainText('That project no longer exists or you lost access (404 · not_found).');
      await capture(page, testInfo, `lab-${name}-404`);
      state.refuse.instance = detail(403, 'forbidden', 'You cannot add to this project.');
      await keep.getByRole('button', { name: 'Save to project' }).click();
      await expect(keep.getByRole('alert')).toContainText('You can generate, but you don’t have permission to add to that project (403 · forbidden).');
      await capture(page, testInfo, `lab-${name}-403`);
      state.refuse.instance = undefined;
      await keep.getByRole('combobox', { name: 'Project' }).selectOption({ label: 'Bench · Member Lab' });
      await keep.getByRole('button', { name: 'Save to project' }).click();
      await expect(keep.getByText('Saved to Bench · Member Lab as a synthetic instance.')).toBeVisible();
      await expect(keep.getByRole('link', { name: 'See the project’s cases' })).toHaveAttribute('href', '/app/member-lab/bench/cases');
      const saved = (state.sent.instances as Array<Record<string, unknown>>).at(-1) as Record<string, unknown>;
      expect(saved).toMatchObject({ persist: true, project_id: 'project-4', case_name: 'generated_qaco', seed: 7 });
      await capture(page, testInfo, `lab-${name}-saved`);
      if (isMobile) {
        expect(critical).toEqual([]);
        return;
      }

      // The package goes to the workbench of the project as its draft.
      await keep.getByRole('button', { name: 'Open in Workbench' }).click();
      await expect(page).toHaveURL(/\/app\/member-lab\/bench\/workbench$/);
      await main.getByRole('navigation', { name: 'BIM resources' }).getByRole('button', { name: /instance\.json/ }).click();
      await expect(main.getByLabel('Name', { exact: true })).toHaveValue('generated_qaco');
      await capture(page, testInfo, `lab-${name}-in-workbench`);
      expect(critical).toEqual([]);
    });

    test('gen-lab /app/generator · a batch and a conversion', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      await page.goto(LAB);
      const main = page.locator('#platform-main');
      const preview = main.getByRole('region', { name: 'Preview' });

      // A batch repeats the settings; keeping it makes a collection.
      await main.getByRole('tab', { name: 'Batch' }).click();
      await expect(main.getByText('Same settings as a single instance, repeated as many times as you ask for.')).toBeVisible();
      await main.getByLabel('How many instances').fill('101');
      await main.getByRole('button', { name: 'Generate batch' }).click();
      await expect(main.getByText('How many instances: a whole number from 1 to 100.')).toBeVisible();
      await capture(page, testInfo, `lab-${name}-batch-422`);
      await main.getByLabel('How many instances').fill('3');
      await main.getByRole('button', { name: 'Generate batch' }).click();
      await expect(preview.getByRole('list', { name: 'Instances of the batch' }).getByRole('listitem')).toHaveCount(3);
      await expect(preview.getByText('Combinations each')).toBeVisible();
      expect(state.sent.corpus).toMatchObject({ count: 3, persist: false, name: 'generated_qaco' });
      await capture(page, testInfo, `lab-${name}-batch`);
      await main.getByRole('region', { name: 'Keep it' }).getByRole('button', { name: 'Save to project' }).click();
      await expect(main.getByText('Saved to QoS Benchmarks · ISA Demo Group as a collection of synthetic instances.')).toBeVisible();
      expect(state.sent.corpus).toMatchObject({ persist: true, project_id: 'project-1', collection_name: 'generated_qaco' });

      // An old-format instance becomes a package.
      await main.getByRole('tab', { name: 'Convert old format' }).click();
      await expect(main.getByRole('button', { name: 'Convert to a package' })).toBeDisabled();
      await main.getByLabel('Or paste its text').fill('TASK 1 CANDIDATES 5\nTASK 2 CANDIDATES 3');
      await capture(page, testInfo, `lab-${name}-convert`);
      state.refuse.convert = json(validationBody('raw_text', [{ code: 'value_error', message: 'Not a legacy instance', pointer: '/raw_text' }]), 422);
      await main.getByRole('button', { name: 'Convert to a package' }).click();
      await expect(main.getByRole('alert')).toContainText('That text can’t be converted (422 · invalid legacy instance)');
      await capture(page, testInfo, `lab-${name}-convert-422`);
      state.refuse.convert = undefined;
      await main.getByRole('button', { name: 'Convert to a package' }).click();
      await expect(preview.getByText('Engines it suits')).toBeVisible();
      expect(state.sent.convert).toMatchObject({ raw_text: 'TASK 1 CANDIDATES 5\nTASK 2 CANDIDATES 3', name: 'converted_legacy', repair_empty_branches: true });
      await capture(page, testInfo, `lab-${name}-converted`);
      expect(critical).toEqual([]);
    });
  });
}
