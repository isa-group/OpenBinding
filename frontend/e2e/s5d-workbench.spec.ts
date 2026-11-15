import { expect as baseExpect, test, type Page, type Route, type TestInfo } from '@playwright/test';
import { failureBody } from './helpers/problems';
import type { Problem, ProblemRevision } from '../src/api/problems';
import { checkoutFacts, compiledDocument } from '../src/pages/Cases/fixtures';
import { CURRENT_FIXTURE, catalogFixture } from '../src/pages/Pricing/pricingFixture';
import { digestOf, usageOf } from '../src/test/fixtures/resources';
import { DEFAULT_FILES } from '../src/pages/Workbench/bimDocuments';
import { zipStore } from '../src/utils/bimZip';

// S5d · workbench: wb-workbench.
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
  created_at: '2026-03-02T00:00:00Z', cas_verified: true,
};

type Role = 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER';

const org = (id: string, slug: string, name: string, role: Role) => ({
  id, slug, name, parent_id: null, effective_role: role, created_at: '2026-03-03T00:00:00Z',
});

// --- the problem the workbench can open and save into

const flujo: Problem = {
  id: 'case-flujo-checkout', organization_id: 'org-isa-demo', slug: 'flujo-checkout', name: 'Flujo de checkout', description: '', created_by_id: 'user-1',
  created_at: '2026-04-02T00:00:00Z', updated_at: '2026-04-02T00:00:00Z',
};

const problemRevision = (n: number): ProblemRevision => ({
  id: `case-flujo-checkout-r${n}`, problem_id: flujo.id, revision: n, package_digest: digestOf(String(n)), package_size: 2048, created_by_id: 'user-1',
  created_at: `2026-04-0${n}T00:00:00Z`,
});

/** What a save answers: the problem, its version and the compilation. */
const upload = (problem: Problem, revision: number, created: boolean) => ({
  problem, revision: problemRevision(revision), created,
  compilation: { id: `compilation-${revision}`, compilation_digest: digestOf('9'), compiler_digest: digestOf('8'), ir_digest: digestOf('c'), binding_space: '128', created_at: '2026-04-02T00:00:00Z', current: true },
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

type Overridable = 'validate' | 'create' | 'saveRevision';

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


/** Everything these screens read and write, answered; anything else on the API origin is an empty 404. */
async function mockApi(page: Page, options: MockOptions = {}): Promise<State> {
  const state: State = { refuse: {}, sent: {} };
  const organizations = [
    org('org-isa-demo', 'isa-demo', 'ISA Demo Group', options.role ?? 'ADMIN'),
    org('org-3', 'consultora-demo', 'Consultora Demo', 'VIEWER'),
    org('org-4', 'member-lab', 'Member Lab', 'MEMBER'),
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
  await page.route(`${API}/v1/users/me/usage`, json(usageOf({ capabilities: { maxRunMinutes: 30, maxProblems: null, maxRepositoryStorage: null } })));
  await page.route(`${API}/v1/users/me/pricing-token`, json({ pricing_token: token(3600) }));
  await page.route(new RegExp(`^${API}/v1/notifications(\\?.*)?$`), json([]));
  await page.route(`${API}/v1/engines/protocol`, json({ profiles: [] }));
  await page.route(`${API}/v1/bim/templates`, json({ templates: ['demo/01_simple_seq'] }));
  await page.route(`${API}/v1/engines`, json({ engines: [{ ...ENGINE, id: 'engine-1', ref: ENGINE, modes: [] }, { ...EDGE, id: 'engine-2', ref: EDGE, modes: [] }] }));

  // The check, and the compiled form with its facts when the Workbench asks for them (`include=ir,facts`).
  await page.route(new RegExp(`^${API}/v1/bim/validate(\\?.*)?$`), (route) => {
    const compiled = new URL(route.request().url()).searchParams.get('include') === 'ir,facts';
    if (state.refuse.validate) return state.refuse.validate(route);
    return json(compiled ? { ...analysisBody(), ir: compiledDocument(), facts: checkoutFacts(), sourceMap: {} } : analysisBody())(route);
  });
  // The package of a version, exactly as it was uploaded.
  const packageBytes = Buffer.from(zipStore({ ...DEFAULT_FILES, 'instance.json': DEFAULT_FILES['instance.json'].replace('"hello-bim"', '"from-version-2"') }));

  await page.route(new RegExp(`^${API}/v1/organizations(/.*)?(\\?.*)?$`), async (route) => {
    const url = new URL(route.request().url());
    const parts = url.pathname.split('/').filter(Boolean);
    // /v1/organizations/{org}/problems/{problem}/revisions/{revision}/source
    const [, , orgSlug, section, problemSlug, sub, subId, action] = parts;
    const method = route.request().method();
    const found = organizations.find((item) => item.slug === orgSlug);

    if (!orgSlug) return json(organizations)(route);
    if (section === 'members' || section === 'library') return json([])(route);
    if (section === 'problems') {
      if (!found) return detail(403, 'organization_forbidden', 'Not a member.')(route);
      if (!problemSlug) {
        if (method === 'POST') {
          state.sent.create = new URL(route.request().url()).searchParams.toString();
          const made: Problem = { ...flujo, id: 'case-hello-bim', slug: 'hello-bim', name: 'hello-bim' };
          return (state.refuse.create ?? json(upload(made, 1, true), 201))(route);
        }
        return json({ problems: orgSlug === 'isa-demo' ? [flujo] : [], total: orgSlug === 'isa-demo' ? 1 : 0, limit: 200, offset: 0 })(route);
      }
      if (problemSlug !== flujo.slug) return detail(404, 'not_found', 'Problem not found.')(route);
      if (sub === 'revisions' && !subId) {
        if (method === 'POST') {
          state.sent.saveRevision = route.request().headers()['content-type'];
          return (state.refuse.saveRevision ?? json(upload(flujo, 3, true), 201))(route);
        }
        return json([problemRevision(1), problemRevision(2)])(route);
      }
      if (sub === 'revisions' && action === 'source') {
        return route.fulfill({ status: 200, contentType: 'application/vnd.bim+zip', body: packageBytes });
      }
      return json(flujo)(route);
    }
    if (!section) return json(found ?? { detail: { code: 'not_found', error: 'Organization not found.' } }, found ? 200 : 404)(route);
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

const ROOT = '/app/isa-demo';
const WORKBENCH = `${ROOT}/workbench`;

const packageUpload = () => ({ name: 'imported.bim.zip', mimeType: 'application/vnd.bim+zip', buffer: Buffer.from(zipStore(DEFAULT_FILES)) });

for (const { name, viewport, isMobile, deviceScaleFactor } of viewports) {
  test.describe(`${name} · S5d workbench`, () => {
    test.use({ viewport, isMobile, deviceScaleFactor });

    test('wb-workbench /app/:org/workbench · package, check and result views', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      await page.goto(WORKBENCH);
      const main = page.locator('#platform-main');
      const index = main.getByRole('navigation', { name: 'BIM resources' });

      await expect(main.getByRole('heading', { level: 1, name: 'Workbench' })).toBeVisible();
      await expect(main.getByText('Write or check a package, see which engines can run it, then save it as a new problem or as a new version of one. A saved version runs from its problem page.')).toBeVisible();
      await expect(main.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('link', { name: 'Problems' })).toHaveAttribute('href', '/app/isa-demo/problems');
      await expect(main.getByRole('tab', { name: 'Problem version' })).toHaveAttribute('aria-selected', 'true');
      await expect(main.getByText(/Nothing validated yet/)).toBeVisible();
      await expect(index).toContainText('workflow.bpmn');
      await expect(main.getByRole('region', { name: 'Package actions' })).toHaveCount(0);
      await capture(page, testInfo, `workbench-${name}-idle`);

      // A version of a problem opens from the two selects, and the address remembers it.
      await expect(main.getByRole('option', { name: 'Flujo de checkout', exact: true })).toHaveCount(1);
      await main.getByRole('combobox', { name: 'Problem', exact: true }).selectOption('flujo-checkout');
      await expect(main.getByRole('combobox', { name: 'Problem version', exact: true })).toBeEnabled();
      await main.getByRole('combobox', { name: 'Problem version', exact: true }).selectOption({ label: 'Flujo de checkout · version 2' });
      await expect(page).toHaveURL(/problem=flujo-checkout&revision=2/);
      await expect(main.getByText('Loaded version 2')).toBeVisible();
      await index.getByRole('button', { name: /instance\.json/ }).click();
      await expect(main.getByLabel('Name', { exact: true })).toHaveValue('from-version-2');
      await capture(page, testInfo, `workbench-${name}-case-revision`);

      // A file is read, compiled by the gateway, and replaces the package only when it is accepted.
      await main.getByRole('tab', { name: 'Upload file' }).click();
      await expect(main.getByText('The gateway refuses packages larger than this deployment allows')).toBeVisible();
      await expect(main.getByText('Drop a .bim.zip here')).toBeVisible();
      await capture(page, testInfo, `workbench-${name}-upload`);
      const compiling = held(() => json(analysisBody()));
      state.refuse.validate = compiling.handler;
      await main.getByLabel('Import .bim.zip').setInputFiles(packageUpload());
      await expect(main.getByRole('status').filter({ hasText: 'Checking the package you brought in…' })).toBeVisible();
      await capture(page, testInfo, `workbench-${name}-compiling`);
      compiling.release();
      state.refuse.validate = undefined;

      await expect(main.getByRole('heading', { name: 'Valid package' })).toBeVisible();
      await expect(main.getByText('hello-bim · qos-binding/v1')).toBeVisible();
      await expect(main.getByRole('button', { name: 'Copy the instance digest' })).toHaveText('Copy instance digest');
      await expect(main.getByRole('region', { name: 'Validation result' })).not.toContainText(/sha256-|[0-9a-f]{12}/);
      const counts = main.getByRole('list', { name: 'What the package holds' }).getByRole('listitem');
      await expect(counts).toHaveCount(5);
      await expect(counts.nth(0)).toContainText('tasks');
      await expect(counts.nth(4)).toContainText('None');
      await expect(main.getByRole('region', { name: 'Package actions' })).toBeVisible();
      await capture(page, testInfo, `workbench-${name}-valid`);

      // The workflow is drawn once the package has been compiled.
      await main.getByRole('button', { name: 'Draw the workflow' }).click();
      const drawing = main.getByRole('group', { name: 'Workflow' });
      await expect(drawing).toBeVisible();
      await expect(drawing).toHaveAccessibleDescription(/^Workflow: authenticate, then \(inventory and shipping in parallel\)/);
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

    test('wb-workbench /app/:org/workbench · what the gateway refuses', async ({ page }, testInfo) => {
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

      // 422: over the deployment's size limit, which no plan changes: no plan ceiling, no "compare plans".
      state.refuse.validate = detail(422, 'binding_space_over_technical_limit', 'The binding space is larger than this deployment accepts.', {
        quota: { limit_id: 'MAX_BINDING_SPACE_LOG10', state: 'exhausted', source: 'technical', limit: 20, used: 23 },
      });
      await validate.click();
      const capped = main.getByRole('alert').filter({ hasText: 'Over this deployment’s size limit' });
      await expect(capped).toContainText('Over this deployment’s size limit (422 · binding_space_over_technical_limit)');
      await expect(capped).toContainText('whatever the plan, so a larger plan won’t change it');
      await expect(capped.getByRole('link', { name: 'Compare plans' })).toHaveCount(0);
      await capture(page, testInfo, `workbench-${name}-422-size`);

      // 413: larger than the deployment takes in one request.
      state.refuse.validate = detail(413, 'payload_too_large', 'The package exceeds the request size limit.');
      await validate.click();
      await expect(main.getByText('The package is larger than this deployment allows per request (413 · payload_too_large).')).toBeVisible();
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

    test('wb-workbench /app/:org/workbench · the editor and its source', async ({ page }, testInfo) => {
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
      const changes = main.getByRole('region', { name: 'Changes to instance.json' });
      await expect(changes).toContainText('edited-in-the-browser');
      expect(await changes.locator('pre').textContent()).toMatch(/^\+.*edited-in-the-browser/m);
      await expect(changes.getByRole('button', { name: 'Copy Changes to instance.json' })).toBeVisible();
      await capture(page, testInfo, `editor-${name}-source`);

      // What was edited is what the gateway receives.
      const validated = page.waitForRequest((request) => request.url() === `${API}/v1/bim/validate` && request.method() === 'POST');
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

    test('wb-workbench /app/:org/workbench · save as a new problem, then as a new version, which runs from its page', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      await page.goto(WORKBENCH);
      const main = page.locator('#platform-main');
      await main.getByRole('button', { name: 'Validate', exact: true }).click();
      const bar = main.getByRole('region', { name: 'Package actions' });
      await expect(bar).toContainText('Save a valid package as a new problem, or as a new version of one; it runs from its problem page.');
      // The Workbench runs nothing itself: no engine to pick, no Solve and no snapshot.
      await expect(main.getByRole('button', { name: 'Solve' })).toHaveCount(0);
      await expect(main.getByRole('button', { name: 'Create snapshot' })).toHaveCount(0);
      await expect(bar.getByRole('combobox', { name: 'Save into problem' })).toHaveValue('');
      await expect(bar.getByRole('textbox', { name: 'Name of the new problem' })).toHaveValue('hello-bim');
      await capture(page, testInfo, `bar-${name}-valid`);

      // A new problem of the organization, named after the package.
      await bar.getByRole('button', { name: 'Save as a new problem' }).click();
      await expect(main.getByText('Saved as version 1 of hello-bim. Run it from its page.')).toBeVisible();
      await expect(main.getByRole('link', { name: 'Open the problem' })).toHaveAttribute('href', `${ROOT}/problems/hello-bim?version=1`);
      expect(state.sent.create).toContain('name=hello-bim');
      await capture(page, testInfo, `bar-${name}-new-problem`);

      // A new version of an existing problem: 201 is a new version, 200 the version it already is.
      await bar.getByRole('combobox', { name: 'Save into problem' }).selectOption('flujo-checkout');
      await bar.getByRole('button', { name: 'Save as a new version of Flujo de checkout' }).click();
      await expect(main.getByText('Saved as version 3 of Flujo de checkout. Run it from its page.')).toBeVisible();
      expect(state.sent.saveRevision).toContain('application/vnd.bim+zip');
      state.refuse.saveRevision = json(upload(flujo, 2, false));
      await bar.getByRole('button', { name: 'Save as a new version of Flujo de checkout' }).click();
      await expect(main.getByText('Unchanged: this is version 2 of Flujo de checkout.')).toBeVisible();
      await capture(page, testInfo, `bar-${name}-saved`);

      // The gateway's refusals keep the package and say why.
      state.refuse.saveRevision = detail(403, 'forbidden', 'The API key does not include problems:write.');
      await bar.getByRole('button', { name: 'Save as a new version of Flujo de checkout' }).click();
      await expect(main.getByRole('alert').filter({ hasText: 'The package wasn’t saved' })).toContainText('(403 · forbidden). Nothing was saved.');
      await bar.getByRole('combobox', { name: 'Save into problem' }).selectOption('');
      state.refuse.create = detail(409, 'slug_conflict', 'That problem slug is in use in this organization.');
      await bar.getByRole('button', { name: 'Save as a new problem' }).click();
      await expect(main.getByRole('alert').filter({ hasText: 'The package wasn’t saved' })).toContainText('That address is already used by another problem in this organization (409 · slug_conflict).');
      await capture(page, testInfo, `bar-${name}-refused`);
      expect(critical).toEqual([]);
    });

    test('wb-workbench /app/:org/workbench · a version opens from the address, and a VIEWER checks but does not save', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      await mockApi(page, { role: 'VIEWER' });
      await page.goto(`${WORKBENCH}?problem=flujo-checkout&revision=2`);
      const main = page.locator('#platform-main');
      await expect(main.getByText('Loaded version 2')).toBeVisible();
      await main.getByRole('button', { name: 'Validate', exact: true }).click();
      const bar = main.getByRole('region', { name: 'Package actions' });
      await expect(bar).toContainText('You can edit and check here; saving into the organization needs MEMBER.');
      await expect(bar.getByRole('button', { name: /^Save as a new version of / })).toBeDisabled();
      await expect(bar.getByRole('combobox', { name: 'Save into problem' })).toHaveCount(0);
      await capture(page, testInfo, `bar-${name}-viewer`);

      // An organization the account is not in reads like one that does not exist.
      await page.goto('/app/ghost-lab/workbench');
      await expect(main.getByRole('heading', { name: 'Organization not available' })).toBeVisible();
      await capture(page, testInfo, `bar-${name}-404`);
      expect(critical).toEqual([]);
    });
  });
}
