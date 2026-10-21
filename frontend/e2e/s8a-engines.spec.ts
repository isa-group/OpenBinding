import { expect as baseExpect, test, type Locator, type Page, type Route, type TestInfo } from '@playwright/test';
import type { EngineRegistrationRevision } from '../src/api/client';
import {
  COMMUNITY_DIALECT, EDGE_SOLVER, EDGE_SOLVER_OLD, OPENAPI_DOCUMENT, PAUSED_SOLVER, PLACEMENT_DIALECT, QOS_PROFILE, REGISTERED_RESOURCES,
  REGISTRATION_MANIFEST, REPORT_FAILED, REPORT_PENDING, REPORT_VERIFIED, SHARED_SOLVER, SOLVER_IN_REVIEW, digestOf, reportOf, usageOf,
} from '../src/test/fixtures/engines';
import { CURRENT_FIXTURE, catalogFixture } from '../src/pages/Pricing/pricingFixture';

// S8a · engines and language of the account: eng-register, eng-registrations, eng-registration-detail and lang-extensions.
// There is no backend: the API origin is answered by page.route(). Screenshots go to testInfo.outputPath() (test-results/, ignored by git)
// so they can be looked at after a run. Every test walks a screen through its states on a desktop and on a phone.

const API = 'http://localhost:8000';

// Several browsers share one development server, so a screen can take longer than the default five seconds to settle.
const expect = baseExpect.configure({ timeout: 15_000 });

type Handler = (route: Route) => Promise<void> | void;
const json = (body: unknown, status = 200): Handler => (route) => route.fulfill({ status, json: body });
const problem = (status: number, code: string, detail: string, diagnostics?: unknown[]): Handler => json({
  type: `https://openbinding.dev/problems/${code}`, title: code, status, detail, ...(diagnostics ? { diagnostics } : {}),
}, status);
const unavailable: Handler = problem(503, 'accounts_unavailable', 'Engine registrations require the accounts database');

const token = (expiresInSeconds: number) => [
  'header',
  Buffer.from(JSON.stringify({ sub: 'user-1', exp: Math.floor(Date.now() / 1000) + expiresInSeconds })).toString('base64'),
  'signature',
].join('.');

const alex = {
  id: 'user-1', username: 'alex.rivera', email: 'alex-rivera@example.org', role: 'user', is_active: true, plan: 'RESEARCH',
  created_at: '2026-03-02T00:00:00Z', cas_verified: true, institutional_branding: true,
};

type Key =
  | 'list' | 'review' | 'detail' | 'report' | 'activate' | 'deactivate' | 'publish' | 'credential' | 'delete'
  | 'createEngine' | 'createRegistration' | 'dialects' | 'resources' | 'profiles';

interface State {
  /** A handler that replaces the default answer of one call. */
  refuse: Partial<Record<Key, Handler>>;
  registrations: EngineRegistrationRevision[];
  reports: Record<string, Record<string, unknown>>;
  sent: {
    engine?: Record<string, unknown>;
    registration?: Record<string, unknown>;
    credential?: Record<string, unknown>;
    activated: string[];
    deactivated: string[];
    publication: string[];
    deleted: string[];
  };
}

interface MockOptions {
  admin?: boolean;
  registrations?: EngineRegistrationRevision[];
  limit?: number | null;
}

const bodyOf = <T = Record<string, unknown>>(route: Route) => route.request().postDataJSON() as T;
const OWN_ENGINE_DIGEST = digestOf('aa');
const OWN_REGISTRATION_DIGEST = digestOf('cc');

/** Everything these screens read and write, answered; anything else on the API origin is an empty 404. */
async function mockApi(page: Page, options: MockOptions = {}): Promise<State> {
  const state: State = {
    refuse: {},
    registrations: structuredClone(options.registrations ?? [EDGE_SOLVER, PAUSED_SOLVER, SOLVER_IN_REVIEW, SHARED_SOLVER, EDGE_SOLVER_OLD]),
    reports: {
      'edge-solver': REPORT_VERIFIED,
      'paused-solver': REPORT_FAILED,
      'region-solver': REPORT_PENDING,
    },
    sent: { activated: [], deactivated: [], publication: [], deleted: [] },
  };
  const user = options.admin ? { ...alex, role: 'admin' } : alex;
  await page.addInitScript(() => {
    localStorage.setItem('openbinding-access-token', 's8a-access');
    localStorage.setItem('openbinding-refresh-token', 's8a-refresh');
  });

  await page.route(`${API}/**`, (route) => route.fulfill({ status: 404, json: { detail: 'not mocked' } }));
  await page.route(`${API}/health**`, json({ status: 'ok' }));
  await page.route(`${API}/v1/auth/refresh`, json({ access_token: 's8a-access-2', refresh_token: 's8a-refresh-2', token_type: 'bearer', expires_in: 900 }));
  await page.route(`${API}/v1/pricing/catalog`, json(catalogFixture));
  await page.route(`${API}/v1/pricing/current`, json(CURRENT_FIXTURE));
  await page.route(`${API}/v1/users/me`, json(user));
  await page.route(`${API}/v1/users/me/usage`, (route) => json(usageOf('RESEARCH', options.limit === undefined ? 3 : options.limit))(route));
  await page.route(`${API}/v1/users/me/pricing-token`, json({ pricing_token: token(3600) }));
  await page.route(new RegExp(`^${API}/v1/notifications(\\?.*)?$`), json([]));
  await page.route(`${API}/v1/engines`, (route) => {
    if (route.request().method() !== 'POST') return json({ engines: [] })(route);
    const sent = bodyOf<{ metadata: { namespace: string; name: string; version: string } }>(route);
    state.sent.engine = sent as unknown as Record<string, unknown>;
    if (state.refuse.createEngine) return state.refuse.createEngine(route);
    return json({ ...sent.metadata, digest: OWN_ENGINE_DIGEST, status: 'private' }, 201)(route);
  });
  await page.route(new RegExp(`^${API}/v1/organizations(/.*)?(\\?.*)?$`), (route) => {
    const parts = new URL(route.request().url()).pathname.split('/').filter(Boolean);
    if (parts.length === 2) {
      return json([{ id: 'org-isa-demo', slug: 'isa-demo', name: 'ISA Demo Group', parent_id: null, billing_sponsor_user_id: 'user-1', effective_role: 'OWNER', created_at: '2026-03-03T00:00:00Z' }])(route);
    }
    if (parts[3] === 'projects' && parts.length === 4) {
      return json([{ id: 'project-1', organization_id: 'org-isa-demo', slug: 'qos-benchmarks', name: 'QoS Benchmarks', description: '', visibility: 'private', created_by_id: 'user-1', created_at: '2026-04-01T00:00:00Z', updated_at: '2026-10-08T00:00:00Z', access: 'member', effective_role: 'OWNER' }])(route);
    }
    return json([])(route);
  });

  // --- the language
  await page.route(`${API}/v1/profiles`, (route) => (state.refuse.profiles ? state.refuse.profiles(route) : json({ profiles: [QOS_PROFILE] })(route)));
  await page.route(`${API}/v1/dialects`, (route) => (state.refuse.dialects ? state.refuse.dialects(route) : json({ dialects: [PLACEMENT_DIALECT, COMMUNITY_DIALECT] })(route)));
  await page.route(`${API}/v1/resources`, (route) => (state.refuse.resources ? state.refuse.resources(route) : json({ resources: REGISTERED_RESOURCES })(route)));

  // --- registrations
  await page.route(new RegExp(`^${API}/v1/engine-registrations(/.*)?(\\?.*)?$`), async (route) => {
    const url = new URL(route.request().url());
    const [, , , rawName, action] = url.pathname.split('/');
    const method = route.request().method();

    if (!rawName) {
      if (method === 'POST') {
        const sent = bodyOf<{ metadata: { namespace: string; name: string; version: string } }>(route);
        state.sent.registration = sent as unknown as Record<string, unknown>;
        if (state.refuse.createRegistration) return state.refuse.createRegistration(route);
        const made: EngineRegistrationRevision = { ...sent.metadata, digest: OWN_REGISTRATION_DIGEST, status: 'private', active: false };
        state.registrations.push(made);
        return json(made, 201)(route);
      }
      if (url.searchParams.get('review') === 'true') {
        if (state.refuse.review) return state.refuse.review(route);
        return json({ registrations: state.registrations.filter((item) => item.status === 'pending_review') })(route);
      }
      if (state.refuse.list) return state.refuse.list(route);
      return json({ registrations: state.registrations })(route);
    }

    const name = decodeURIComponent(rawName);
    const found = state.registrations.find((item) => item.name === name
      && item.namespace === url.searchParams.get('namespace')
      && item.version === url.searchParams.get('version')
      && item.digest === url.searchParams.get('digest'));
    const key = `${name}@${url.searchParams.get('version')}`;

    if (!action && method === 'GET') {
      if (state.refuse.detail) return state.refuse.detail(route);
      if (!found) return problem(404, 'not_found', 'Engine registration not found')(route);
      return json({
        ...REGISTRATION_MANIFEST,
        metadata: { namespace: found.namespace, name: found.name, version: found.version },
        spec: { ...REGISTRATION_MANIFEST.spec, engine: { ...REGISTRATION_MANIFEST.spec.engine, name: found.name, version: found.version } },
      })(route);
    }
    if (!action && method === 'DELETE') {
      state.sent.deleted.push(name);
      if (state.refuse.delete) return state.refuse.delete(route);
      if (!found) return problem(404, 'not_found', 'Engine registration not found')(route);
      state.registrations = state.registrations.filter((item) => item !== found);
      return route.fulfill({ status: 204 });
    }
    if (action === 'report') {
      if (state.refuse.report) return state.refuse.report(route);
      if (!found) return problem(404, 'not_found', 'Engine registration not found')(route);
      return json(reportOf(found, state.reports[name] ?? REPORT_VERIFIED))(route);
    }
    if (!found) return problem(404, 'not_found', 'Engine registration not found')(route);
    if (action === 'activate') {
      state.sent.activated.push(key);
      if (state.refuse.activate) return state.refuse.activate(route);
      found.active = true;
      state.reports[name] = REPORT_VERIFIED;
      return json(found)(route);
    }
    if (action === 'deactivate') {
      state.sent.deactivated.push(key);
      if (state.refuse.deactivate) return state.refuse.deactivate(route);
      found.active = false;
      return json(found)(route);
    }
    if (action === 'publication-request') {
      state.sent.publication.push(key);
      if (state.refuse.publish) return state.refuse.publish(route);
      if (!found.active) return problem(409, 'registration_inactive', 'Activate and verify the private registration before requesting publication')(route);
      found.status = 'pending_review';
      return json(found)(route);
    }
    if (action === 'credential') {
      state.sent.credential = bodyOf(route);
      if (state.refuse.credential) return state.refuse.credential(route);
      found.active = false;
      found.status = 'private';
      state.reports[name] = REPORT_PENDING;
      return json(found)(route);
    }
    return json({})(route);
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

/**
 * A capture of the current state: with E2E_SCREENSHOTS=1 the whole page, its first `height` pixels, or one area, saved for a person to
 * look at; always a check that nothing scrolls sideways.
 */
async function capture(page: Page, testInfo: TestInfo, name: string, options: { height?: number; area?: Locator } = {}) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    (document.activeElement as HTMLElement | null)?.blur();
    window.scrollTo(0, 0);
  });
  const path = testInfo.outputPath(`${name}.png`);
  const width = page.viewportSize()?.width ?? 0;
  if (!process.env.E2E_SCREENSHOTS) {
    // No picture: the page is still measured below.
  } else if (options.area) {
    await options.area.screenshot({ path, animations: 'disabled' });
  } else if (options.height) {
    const total = await page.evaluate(() => document.documentElement.scrollHeight);
    await page.screenshot({ path, fullPage: true, animations: 'disabled', clip: { x: 0, y: 0, width, height: Math.min(options.height, total) } });
  } else {
    await page.screenshot({ path, fullPage: true, animations: 'disabled' });
  }
  // Against the width of the device, not window.innerWidth: a phone widens its layout viewport to fit a page that overflows.
  const overflow = await page.evaluate((expected) => document.documentElement.scrollWidth - expected, width);
  expect(overflow, `${name} should not scroll sideways`).toBeLessThanOrEqual(1);
}

// Each test walks a screen through its states while the dev server compiles on demand.
test.setTimeout(150_000);
const viewports = [
  { name: 'desktop', viewport: { width: 1440, height: 900 }, isMobile: false, deviceScaleFactor: 1 },
  { name: 'mobile', viewport: { width: 390, height: 844 }, isMobile: true, deviceScaleFactor: 2 },
] as const;

const SECRET = 'live-secret-123';
const EDGE_ADDRESS = `/app/engines/registrations/edge-solver?namespace=${EDGE_SOLVER.namespace}&version=${EDGE_SOLVER.version}&digest=${EDGE_SOLVER.digest}`;
const openApiFile = (document: unknown = OPENAPI_DOCUMENT) => ({ name: 'openapi.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(document)) });

for (const { name, viewport, isMobile, deviceScaleFactor } of viewports) {
  // A phone is taller for the same content, so its captures keep more of the page.
  const tall = (height: number) => (isMobile ? Math.round(height * 1.9) : height);

  test.describe(`${name} · S8a engines and language`, () => {
    // One worker per viewport: with every test in parallel the browsers starve each other and the same walk takes twice as long.
    test.describe.configure({ mode: 'default' });
    test.use({ viewport, isMobile, deviceScaleFactor });

    test('eng-register /app/engines/new · the four steps from the engine to an active deployment', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page, { registrations: [EDGE_SOLVER] });
      await page.goto('/app/engines/new');
      const main = page.locator('#platform-main');

      await expect(main.getByRole('heading', { level: 1, name: 'Register a private engine' })).toBeVisible();
      await expect(main.getByText('1 of 3 used')).toBeVisible();
      await expect(main.getByRole('list', { name: 'Steps' }).getByRole('listitem')).toHaveCount(4);
      await expect(main.getByRole('button', { name: /Deployment/ })).toBeDisabled();
      await expect(main.getByRole('heading', { name: '1 · Your engine' })).toBeVisible();
      await capture(page, testInfo, `register-${name}-1-engine`, { height: tall(2600) });

      // The form builds the manifest: nothing is typed as JSON, and ranges are one click.
      await main.getByLabel('Name', { exact: true }).fill('edge-router');
      await main.getByLabel('Algorithm', { exact: true }).fill('Tabu search');
      await main.getByRole('button', { name: /Interval values \(ranges\)/ }).click();
      await main.getByRole('button', { name: 'Pareto front' }).click();
      await main.locator('summary', { hasText: 'Other capabilities' }).click();
      await expect(main.getByRole('radiogroup', { name: 'Workflow nodes' })).toBeVisible();
      await expect(main.getByLabel('View source (JSON)')).toBeHidden();
      await capture(page, testInfo, `register-${name}-1-capabilities`, { height: tall(3600) });

      await main.getByText('View source').click();
      await expect(main.getByLabel('View source (JSON)')).toContainText('"featureValues"');
      await main.getByRole('button', { name: 'Create engine revision' }).click();
      await expect(main.getByText('✓ Engine revision created · private')).toBeVisible();
      expect(state.sent.engine).toMatchObject({
        metadata: { namespace: 'alex.rivera', name: 'edge-router', version: '1.0.0' },
        spec: { modes: [{ id: 'default', algorithm: 'Tabu search', capabilities: { featureValues: { selector: 'only', values: ['scalar', 'interval'] } } }] },
      });
      await expect(main.getByLabel('Name', { exact: true })).toBeDisabled();
      await capture(page, testInfo, `register-${name}-1-created`, { height: tall(1000) });

      // The deployment: an address, paths, how it signs in and the contract it pins, read from the file.
      await main.getByRole('button', { name: 'Next: deployment' }).click();
      await expect(main.getByRole('heading', { name: '2 · Where it runs' })).toBeVisible();
      await main.getByLabel('Endpoint address').fill('https://edge.example.org');
      await main.getByLabel('Deployment OpenAPI file').setInputFiles(openApiFile());
      await expect(main.getByText('Read openapi.json')).toBeVisible();
      await expect(main.getByRole('list', { name: 'What we read from the contract' }).getByText('Matches')).toBeVisible();
      await main.getByRole('radio', { name: /Bearer token/ }).click();
      await expect(main.getByRole('button', { name: 'Create registration' })).toBeEnabled();
      await capture(page, testInfo, `register-${name}-2-deployment`, { height: tall(2400) });

      await main.getByRole('button', { name: 'Create registration' }).click();
      await expect(main.getByText('✓ Registration created · inactive')).toBeVisible();
      expect(state.sent.registration).toMatchObject({
        metadata: { namespace: 'alex.rivera', name: 'edge-router-deployment', version: '1.0.0' },
        spec: { endpoint: 'https://edge.example.org', auth: { scheme: 'bearer' }, engine: { name: 'edge-router', digest: OWN_ENGINE_DIGEST } },
      });
      expect(JSON.stringify(state.sent.registration)).not.toContain(SECRET);

      // The credential goes apart from the manifest and is never shown again.
      await main.getByRole('button', { name: 'Next: credential' }).click();
      await main.getByLabel('Token', { exact: true }).fill(SECRET);
      await expect(main.getByLabel('Token', { exact: true })).toHaveAttribute('type', 'password');
      await capture(page, testInfo, `register-${name}-3-credential`, { height: tall(1000) });
      await main.getByRole('button', { name: 'Save credential' }).click();
      await expect(main.getByText('Stored encrypted. It will never be shown again.')).toBeVisible();
      expect(state.sent.credential).toEqual({ secret: SECRET });
      await expect(page.locator('body')).not.toContainText(SECRET);
      await capture(page, testInfo, `register-${name}-3-stored`, { height: tall(900) });

      await main.getByRole('button', { name: 'Next: verify' }).click();
      await expect(main.getByRole('heading', { name: '4 · Verify and activate' })).toBeVisible();
      await capture(page, testInfo, `register-${name}-4-verify`, { height: tall(900) });
      await main.getByRole('button', { name: 'Check conformance and activate' }).click();
      await expect(main.getByText('edge-router-deployment 1.0.0 is active')).toBeVisible();
      await expect(main.getByText('Sample problem solved')).toBeVisible();
      expect(state.sent.activated).toEqual(['edge-router-deployment@1.0.0']);
      await expect(main.getByRole('link', { name: 'Open registration' })).toHaveAttribute('href', /\/app\/engines\/registrations\/edge-router-deployment\?namespace=alex\.rivera&version=1\.0\.0/);
      await capture(page, testInfo, `register-${name}-5-done`, { height: tall(1800) });

      await main.getByRole('button', { name: 'Request publication' }).click();
      await expect(main.getByText('Waiting for review')).toBeVisible();
      expect(state.sent.publication).toEqual(['edge-router-deployment@1.0.0']);
      expect(critical).toEqual([]);
    });

    test('eng-register /app/engines/new · what the gateway refuses (422, 402, a contract that fails, a failed check) and the plan limit', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page, { registrations: [EDGE_SOLVER, PAUSED_SOLVER, SOLVER_IN_REVIEW] });
      await page.goto('/app/engines/new');
      const main = page.locator('#platform-main');
      await expect(main.getByText('3 of 3 used')).toBeVisible();
      await expect(main.getByText(/Limit reached/)).toBeVisible();

      // Fields the form can check say so, and nothing is sent.
      await main.getByLabel('Version', { exact: true }).fill('0.1.0');
      await expect(main.getByText('Use three numbers like 1.0.0, starting at 1.')).toBeVisible();
      await expect(main.getByRole('button', { name: 'Create engine revision' })).toBeDisabled();
      await capture(page, testInfo, `register-${name}-field-error`, { height: tall(1400) });
      await main.getByLabel('Version', { exact: true }).fill('1.0.0');

      // 422: the gateway says where the manifest is wrong.
      state.refuse.createEngine = problem(422, 'invalid_engine', 'Engine manifest does not satisfy bim/v1', [
        { code: 'limit_unknown', pointer: '/spec/modes/0/limits/maxTasks', message: "limit 'maxTasks' is not declared by profile 'qos-binding/v1'" },
      ]);
      await main.getByRole('button', { name: 'Create engine revision' }).click();
      await expect(main.getByText('The engine manifest was refused (422 · invalid_engine)')).toBeVisible();
      await expect(main.getByText(/\/spec\/modes\/0\/limits\/maxTasks: limit 'maxTasks' is not declared/)).toBeVisible();
      await capture(page, testInfo, `register-${name}-422`, { height: tall(1400) });
      state.refuse.createEngine = undefined;
      await main.getByRole('button', { name: 'Create engine revision' }).click();
      await expect(main.getByText('✓ Engine revision created · private')).toBeVisible();

      // A contract that is not bim-engine/v1 is read and refused before anything is created.
      await main.getByRole('button', { name: 'Next: deployment' }).click();
      await expect(main.getByText('Your plan is full')).toBeVisible();
      await main.getByLabel('Endpoint address').fill('https://edge.example.org?token=abc');
      await expect(main.getByText('This looks like it contains a secret. Remove it.')).toBeVisible();
      await main.getByLabel('Endpoint address').fill('https://edge.example.org');
      await main.getByLabel('Deployment OpenAPI file').setInputFiles(openApiFile({ openapi: '3.0.3', info: { title: 'x', version: '1' }, paths: { '/a': {} }, 'x-bim-protocol': 'bim-engine/v1', 'x-bim-protocol-digest': digestOf('99') }));
      const checks = main.getByRole('list', { name: 'What we read from the contract' });
      await expect(checks.getByText('Different from bim-engine/v1’s')).toBeVisible();
      await expect(main.getByRole('button', { name: 'Create registration' })).toBeDisabled();
      await expect(main.getByText('The contract doesn’t pass every check.')).toBeVisible();
      await capture(page, testInfo, `register-${name}-contract-fails`, { height: tall(2600) });
      await main.getByLabel('Deployment OpenAPI file').setInputFiles(openApiFile());
      await expect(main.getByRole('button', { name: 'Create registration' })).toBeEnabled();

      // 402: the plan has no room for another federated engine.
      state.refuse.createRegistration = json({ detail: { code: 'quota_exceeded', error: 'Federated engines limit reached', quota: { limit_id: 'federatedEngines', limit: 3, used: 3 } } }, 402);
      await main.getByRole('button', { name: 'Create registration' }).click();
      await expect(main.getByText('Engine limit reached (402)')).toBeVisible();
      await expect(main.getByRole('link', { name: 'See your plan' })).toHaveAttribute('href', '/app/account/usage');
      await capture(page, testInfo, `register-${name}-402`, { height: tall(2400) });
      state.refuse.createRegistration = problem(422, 'secret_in_document', 'credentials must be supplied through the secret store', [{ code: 'secret_in_document', pointer: '/spec/endpoint', message: 'secret-like field is forbidden' }]);
      await main.getByRole('button', { name: 'Create registration' }).click();
      await expect(main.getByText('Refused: there’s a secret in the document (422 · secret_in_document)')).toBeVisible();
      state.refuse.createRegistration = undefined;
      await main.getByRole('button', { name: 'Create registration' }).click();
      await expect(main.getByText('✓ Registration created · inactive')).toBeVisible();

      // A deployment that does not conform: the checks that ran are listed, and the person can check again.
      await main.getByRole('button', { name: 'Next: verify' }).click();
      state.refuse.activate = problem(409, 'conformance_failed', 'Engine registration failed its OpenAPI and response-contract checks', REPORT_FAILED.checks);
      await main.getByRole('button', { name: 'Check conformance and activate' }).click();
      await expect(main.getByText('Your deployment didn’t pass (409 · conformance_failed)')).toBeVisible();
      await expect(main.getByText('engine did not solve the deterministic conformance problem')).toBeVisible();
      await expect(main.getByRole('button', { name: 'Check again' })).toBeVisible();
      await capture(page, testInfo, `register-${name}-conformance-failed`, { height: tall(2000) });
      state.refuse.activate = undefined;
      await main.getByRole('button', { name: 'Check again' }).click();
      await expect(main.getByText('my-engine-deployment 1.0.0 is active')).toBeVisible();
      expect(critical).toEqual([]);
    });

    test('eng-register /app/engines/new · an engine kept alone, a manifest loaded from a file and a registration copied as a new version', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page, { registrations: [EDGE_SOLVER] });
      await page.goto('/app/engines/new');
      const main = page.locator('#platform-main');

      await main.locator('summary', { hasText: 'Start from a manifest file' }).click();
      await main.getByLabel('Engine manifest JSON').fill(JSON.stringify({
        apiVersion: 'bim/v1', kind: 'Engine', metadata: { namespace: 'somebody-else', name: 'imported-solver', version: '1.4.0' },
        spec: { modes: [{ id: 'cp', profile: 'qos-binding/v1', algorithm: 'constraint-programming', capabilities: { featureValues: { selector: 'only', values: ['scalar', 'interval'] }, scalarizations: { selector: 'only', values: [{ id: 'weighted-sum', objectiveTypes: ['SINGLE'], weightPolicy: 'required' }] } }, limits: { maxTimeBudgetMs: 60000 }, guarantees: { termination: ['OPTIMAL', 'FEASIBLE'], exact: true } }] },
      }));
      await main.getByRole('button', { name: 'Load into the form' }).click();
      await expect(main.getByText('Loaded into the form.')).toBeVisible();
      await expect(main.getByLabel('Name', { exact: true })).toHaveValue('imported-solver');
      await capture(page, testInfo, `register-${name}-imported`, { height: tall(1800) });
      await main.getByRole('button', { name: 'Create engine revision' }).click();
      await expect(main.getByText('✓ Engine revision created · private')).toBeVisible();
      expect(state.sent.engine).toMatchObject({ metadata: { namespace: 'alex.rivera', name: 'imported-solver' } });

      await main.getByRole('button', { name: 'Keep the engine only' }).click();
      await expect(main.getByText('imported-solver 1.4.0 is saved')).toBeVisible();
      await expect(main.getByRole('button', { name: 'Register a deployment for it' })).toBeVisible();
      await capture(page, testInfo, `register-${name}-engine-only`, { height: tall(1100) });

      // “Edit as a new version” from a registration opens the form already filled in, one patch ahead.
      await page.goto(`/app/engines/new?from=edge-solver&namespace=${EDGE_SOLVER.namespace}&version=${EDGE_SOLVER.version}&digest=${EDGE_SOLVER.digest}`);
      await expect(main.getByLabel('Name', { exact: true })).toHaveValue('edge-solver');
      await expect(main.getByLabel('Version', { exact: true })).toHaveValue('0.3.2');
      await expect(main.getByLabel('Algorithm', { exact: true })).toHaveValue('tabu-search');
      expect(critical).toEqual([]);
    });

    test('eng-registrations /app/engines/registrations · state, last check and actions of each registration', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page, { limit: 5 });
      await page.goto('/app/engines/registrations');
      const main = page.locator('#platform-main');

      await expect(main.getByRole('heading', { level: 1, name: 'My engines' })).toBeVisible();
      await expect(main.getByText('4 of 5 used')).toBeVisible();
      await expect(main.getByRole('link', { name: 'See all your limits' })).toHaveAttribute('href', '/app/account/usage');
      const edge = main.getByRole('row', { name: 'edge-solver 0.3.1' });
      await expect(edge.getByText('Passed')).toBeVisible();
      await expect(edge.getByText('Active')).toBeVisible();
      await expect(main.getByRole('row', { name: 'paused-solver 1.2.0' }).getByText('Failed')).toBeVisible();
      await expect(main.getByRole('row', { name: 'region-solver 1.0.0' }).getByText('Waiting for review')).toBeVisible();
      await expect(main.getByRole('row', { name: 'shared-solver 2.0.0' }).getByText(/published by another account/)).toBeVisible();
      await expect(main.getByRole('link', { name: 'Register an engine' })).toHaveAttribute('href', '/app/engines/new');
      await capture(page, testInfo, `registrations-${name}-list`, { height: tall(1900) });

      await main.getByRole('group', { name: 'Filter' }).getByRole('button', { name: 'Inactive' }).click();
      // On a phone the header row is hidden and each registration is a card, so only the registrations are counted.
      await expect(main.getByRole('row', { name: /-solver \d/ })).toHaveCount(1);
      await expect(main.getByRole('row', { name: 'paused-solver 1.2.0' })).toBeVisible();
      await main.getByRole('group', { name: 'Filter' }).getByRole('button', { name: 'All', exact: true }).click();

      // Activation re-checks the deployment; a refusal names the checks.
      state.refuse.activate = problem(409, 'conformance_failed', 'Engine registration failed its OpenAPI and response-contract checks', REPORT_FAILED.checks);
      await main.getByRole('button', { name: 'Activate paused-solver 1.2.0' }).click();
      await expect(main.getByText('Your deployment didn’t pass (409 · conformance_failed)')).toBeVisible();
      await expect(main.getByRole('link', { name: 'See the checks' })).toHaveAttribute('href', /\/app\/engines\/registrations\/paused-solver\?/);
      await capture(page, testInfo, `registrations-${name}-activation-refused`, { height: tall(1400) });
      state.refuse.activate = undefined;
      await main.getByRole('button', { name: 'Activate paused-solver 1.2.0' }).click();
      await expect(main.getByText('paused-solver passed its check and is active for you.')).toBeVisible();
      await expect(main.getByRole('row', { name: 'paused-solver 1.2.0' }).getByText('Passed')).toBeVisible();

      await main.getByRole('button', { name: 'Deactivate edge-solver 0.3.1' }).click();
      await expect(main.getByText('Deactivated. You can’t pick it for new jobs until you activate it again.')).toBeVisible();
      expect(state.sent.deactivated).toEqual(['edge-solver@0.3.1']);

      // Publication is asked for with a confirmation, and refused while the registration is inactive.
      await main.getByRole('button', { name: 'Request publication of edge-solver 0.3.1' }).click();
      await expect(main.getByText('Activate it first')).toBeVisible();
      await main.getByRole('button', { name: 'Request publication of paused-solver 1.2.0' }).click();
      const publish = page.getByRole('dialog', { name: 'Request publication of paused-solver?' });
      await capture(page, testInfo, `registrations-${name}-publish-dialog`);
      await publish.getByRole('button', { name: 'Request publication' }).click();
      await expect(main.getByText('Publication requested. An administrator will review it.')).toBeVisible();
      expect(state.sent.publication).toEqual(['paused-solver@1.2.0']);

      // Deleting needs the registration’s name.
      await main.getByRole('button', { name: 'Delete edge-solver 0.3.1' }).click();
      const dialog = page.getByRole('dialog', { name: 'Delete edge-solver 0.3.1?' });
      await expect(dialog.getByRole('button', { name: 'Delete registration' })).toBeDisabled();
      await dialog.getByRole('textbox').fill('edge-solver');
      await capture(page, testInfo, `registrations-${name}-delete-dialog`);
      await dialog.getByRole('button', { name: 'Delete registration' }).click();
      await expect(main.getByText('Deleted edge-solver 0.3.1.')).toBeVisible();
      await expect(main.getByRole('row', { name: 'edge-solver 0.3.1' })).toHaveCount(0);
      expect(state.sent.deleted).toEqual(['edge-solver']);
      await capture(page, testInfo, `registrations-${name}-after`, { height: tall(1700) });
      expect(critical).toEqual([]);
    });

    test('eng-registrations /app/engines/registrations · empty, accounts unavailable (503) and a review link without the right (403)', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page, { registrations: [] });
      const main = page.locator('#platform-main');

      await page.goto('/app/engines/registrations');
      await expect(main.getByText('You haven’t registered an engine')).toBeVisible();
      await expect(main.getByText('Bring your own solver: register its deployment and use it in your jobs. It stays private until reviewed.')).toBeVisible();
      await capture(page, testInfo, `registrations-${name}-empty`, { height: tall(1300) });

      state.refuse.list = unavailable;
      await page.goto('/app/engines/registrations');
      await expect(main.getByText('Accounts are unavailable right now (503 · accounts_unavailable)')).toBeVisible();
      await expect(main.getByText('You haven’t registered an engine')).toHaveCount(0);
      await capture(page, testInfo, `registrations-${name}-503`, { height: tall(1200) });
      state.refuse.list = undefined;
      state.registrations.push(EDGE_SOLVER);
      await main.getByRole('button', { name: 'Try again' }).click();
      await expect(main.getByRole('row', { name: 'edge-solver 0.3.1' })).toBeVisible();

      state.refuse.review = problem(403, 'forbidden', 'Only an administrator may read publication requests');
      await page.goto('/app/engines/registrations?review=true');
      await expect(main.getByText('Only administrators can filter by “waiting for review” (403)')).toBeVisible();
      await expect(main.getByLabel(/Only waiting for review/)).toHaveCount(0);
      await capture(page, testInfo, `registrations-${name}-403`, { height: tall(1100) });
      await main.getByRole('button', { name: 'Show my engines' }).click();
      await expect(main.getByRole('row', { name: 'edge-solver 0.3.1' })).toBeVisible();
      expect(critical).toEqual([]);
    });

    test('eng-registrations /app/engines/registrations · an administrator lists only what waits for review', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      await mockApi(page, { admin: true });
      await page.goto('/app/engines/registrations');
      const main = page.locator('#platform-main');

      await expect(main.getByRole('row', { name: 'edge-solver 0.3.1' })).toBeVisible();
      await main.getByLabel(/Only waiting for review/).click();
      await expect(main.getByLabel(/Only waiting for review/)).toBeChecked();
      const waiting = main.getByRole('row', { name: 'region-solver 1.0.0' });
      await expect(waiting).toBeVisible();
      await expect(waiting.getByRole('link', { name: 'Review region-solver 1.0.0' })).toHaveAttribute('href', '/app/admin/moderation');
      await expect(main.getByRole('row', { name: 'edge-solver 0.3.1' })).toHaveCount(0);
      await expect(page).toHaveURL(/review=true/);
      await capture(page, testInfo, `registrations-${name}-review`, { height: tall(1100) });
      expect(critical).toEqual([]);
    });

    test('eng-registration-detail /app/engines/registrations/:name · identity, life cycle, verification, deployment, manifest with ranges and history', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      await mockApi(page);
      await page.goto(EDGE_ADDRESS);
      const main = page.locator('#platform-main');

      await expect(main.getByRole('heading', { level: 1, name: 'edge-solver' })).toBeVisible();
      await expect(main.getByText('Your deployment of the edge-solver engine. Only you can use it.')).toBeVisible();
      await expect(main.getByRole('region', { name: 'Exact identity' }).getByText('sha256-e5f6…e5f6')).toBeVisible();
      const verification = main.locator('section').filter({ has: page.getByRole('heading', { name: 'Last verification' }) });
      await expect(verification.getByText('Sample problem solved')).toBeVisible();
      await expect(verification.getByText('Verified', { exact: true })).toBeVisible();
      await expect(main.getByRole('region', { name: 'Deployment' }).getByText('https://edge.example.org')).toBeVisible();
      const mode = main.getByRole('region', { name: 'Mode tabu' });
      await expect(mode.getByRole('region', { name: 'Feature values of mode tabu' })).toContainText('Ranges, min–max · accepted');
      await expect(mode.getByRole('region', { name: 'Options of mode tabu' })).toContainText('1 – 3,600,000');
      await expect(main.getByRole('region', { name: 'Other revisions of this registration' }).getByRole('link', { name: 'Open edge-solver 0.2.0' })).toBeVisible();
      await expect(main.getByLabel('View source (JSON)')).toBeHidden();
      await capture(page, testInfo, `detail-${name}-top`, { height: tall(2200) });
      await capture(page, testInfo, `detail-${name}-full`);

      await main.getByText('View source').click();
      await expect(main.getByLabel('View source (JSON)')).toContainText('"kind": "Engine"');
      expect(critical).toEqual([]);
    });

    test('eng-registration-detail /app/engines/registrations/:name · check again, replace the credential, ask for publication and delete', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      await page.goto(EDGE_ADDRESS);
      const main = page.locator('#platform-main');
      await expect(main.getByRole('heading', { level: 1, name: 'edge-solver' })).toBeVisible();

      // A check that fails leaves the registration inactive and says which check.
      state.refuse.activate = problem(409, 'conformance_failed', 'Engine registration failed its OpenAPI and response-contract checks', REPORT_FAILED.checks);
      await main.getByRole('button', { name: 'Check again' }).click();
      await expect(main.getByText('Your deployment didn’t pass (409 · conformance_failed)')).toBeVisible();
      await expect(main.getByText('engine did not solve the deterministic conformance problem')).toBeVisible();
      await capture(page, testInfo, `detail-${name}-check-failed`, { height: tall(2000) });
      state.refuse.activate = undefined;
      await main.getByRole('button', { name: 'Check again' }).click();
      await expect(main.getByText('Checked again. The deployment still passes.')).toBeVisible();

      // The credential: never shown, replaced on request, and the secret is gone from the page after it is sent.
      await expect(main.getByText(/The credential is stored encrypted\. Nobody can read it back/)).toBeVisible();
      await main.getByRole('button', { name: 'Replace credential' }).click();
      await main.getByLabel('New token').fill(SECRET);
      await capture(page, testInfo, `detail-${name}-credential`, { area: main.locator('#credential') });
      await main.getByRole('button', { name: 'Save new credential' }).click();
      await expect(main.getByText(/Credential replaced\. The old one is no longer used/)).toBeVisible();
      expect(state.sent.credential).toEqual({ secret: SECRET });
      await expect(page.locator('body')).not.toContainText(SECRET);
      await expect(main.getByRole('button', { name: 'Activate' })).toBeVisible();
      await expect(main.getByText('Not checked yet').first()).toBeVisible();

      // Publication needs the registration to be active.
      await main.getByRole('button', { name: 'Request publication' }).click();
      await expect(main.getByText('Activate it first')).toBeVisible();
      await main.getByRole('button', { name: 'Activate', exact: true }).click();
      await expect(main.getByText('edge-solver passed its check and is active for you.')).toBeVisible();
      await main.getByRole('button', { name: 'Request publication' }).click();
      await capture(page, testInfo, `detail-${name}-publish-dialog`);
      await page.getByRole('dialog', { name: 'Request publication of edge-solver?' }).getByRole('button', { name: 'Request publication' }).click();
      await expect(main.getByText('Publication requested. An administrator will review it.')).toBeVisible();
      await expect(main.getByText('Waiting for an administrator’s review. It stays private until then.')).toBeVisible();
      expect(state.sent.publication).toEqual(['edge-solver@0.3.1']);

      await main.getByRole('button', { name: 'Delete', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Delete edge-solver 0.3.1?' });
      await dialog.getByRole('textbox').fill('edge-solver');
      await capture(page, testInfo, `detail-${name}-delete-dialog`);
      await dialog.getByRole('button', { name: 'Delete registration' }).click();
      await expect(main.getByText('This registration was deleted')).toBeVisible();
      expect(state.sent.deleted).toEqual(['edge-solver']);
      await capture(page, testInfo, `detail-${name}-deleted`, { height: tall(900) });
      expect(critical).toEqual([]);
    });

    test('eng-registration-detail /app/engines/registrations/:name · read-only when it is published by someone else, and a neutral 404', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      const main = page.locator('#platform-main');

      await page.goto(`/app/engines/registrations/shared-solver?namespace=${SHARED_SOLVER.namespace}&version=${SHARED_SOLVER.version}&digest=${SHARED_SOLVER.digest}`);
      await expect(main.getByRole('heading', { level: 1, name: 'shared-solver' })).toBeVisible();
      await expect(main.getByText('Published by priya.nair. You can pick it when launching a job.')).toBeVisible();
      await expect(main.getByRole('button', { name: 'Deactivate' })).toHaveCount(0);
      await expect(main.getByRole('heading', { name: 'Credential' })).toHaveCount(0);
      await expect(main.getByRole('heading', { name: 'Delete this registration' })).toHaveCount(0);
      await expect(main.getByRole('button', { name: 'Launch a job with it' })).toBeVisible();
      await capture(page, testInfo, `detail-${name}-readonly`, { height: tall(1800) });

      // The project picker is the way into a job with this engine.
      await main.getByRole('button', { name: 'Launch a job with it' }).click();
      await expect(main.getByRole('link', { name: /ISA Demo Group \/ QoS Benchmarks/ })).toHaveAttribute('href', /\/app\/isa-demo\/qos-benchmarks\/jobs\/new\?engine=/);

      // Someone else’s private registration, or one that does not exist, answer the same.
      state.refuse.detail = problem(404, 'not_found', 'Engine registration not found');
      state.refuse.report = problem(404, 'not_found', 'Engine registration not found');
      await page.goto(`/app/engines/registrations/private-elsewhere?namespace=priya.nair&version=1.0.0&digest=${digestOf('77')}`);
      await expect(main.getByText('Not found', { exact: true })).toBeVisible();
      await expect(main.getByText(/everyone else, administrators included, gets this same answer/)).toBeVisible();
      await expect(main.getByRole('link', { name: 'Back to My engines' })).toHaveAttribute('href', '/app/engines/registrations');
      await capture(page, testInfo, `detail-${name}-404`, { height: tall(1000) });

      // A bare name works when only one revision is visible, and asks which one when several are.
      state.refuse.detail = undefined;
      state.refuse.report = undefined;
      await page.goto('/app/engines/registrations/edge-solver');
      await expect(main.getByRole('heading', { name: 'Which revision of edge-solver?' })).toBeVisible();
      await expect(main.getByRole('link', { name: /alex\.rivera\/edge-solver@/ })).toHaveCount(2);
      await capture(page, testInfo, `detail-${name}-which`, { height: tall(900) });
      expect(critical).toEqual([]);
    });

    test('lang-extensions /app/language/extensions · dialects, adapters and registered resources with their version and provenance', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      await mockApi(page);
      await page.goto('/app/language/extensions');
      const main = page.locator('#platform-main');

      await expect(main.getByRole('heading', { level: 1, name: 'Language extensions' })).toBeVisible();
      await expect(main.getByRole('region', { name: 'What is installed' })).toContainText('2Dialects installed');
      await expect(main.getByRole('region', { name: 'What is installed' })).toContainText('3Adapters');
      const placement = main.getByRole('article', { name: 'Dialect placement 1.0.0' });
      await expect(placement.getByText('Installed', { exact: true })).toBeVisible();
      await expect(placement.getByText('Built in', { exact: true })).toBeVisible();
      const community = main.getByRole('article', { name: 'Dialect edge-annotations 1.0.0' });
      await expect(community.getByText('Approved', { exact: true })).toBeVisible();
      await expect(community.getByText('Submitted by alex.rivera and approved by an administrator.')).toBeVisible();
      await capture(page, testInfo, `language-${name}-dialects`, { height: tall(1500) });

      await community.getByRole('button', { name: 'Details of edge-annotations' }).click();
      await expect(community.getByRole('region', { name: 'Resource types of edge-annotations' })).toContainText('BPMN (XML) · root definitions');
      await expect(community.getByText('/spec/annotations', { exact: true })).toBeVisible();
      await expect(community.getByLabel('View source (JSON)')).toBeHidden();
      await capture(page, testInfo, `language-${name}-dialect-details`, { height: tall(2000) });

      await main.getByRole('group', { name: 'Provenance' }).getByRole('button', { name: 'Built in' }).click();
      await expect(main.getByRole('article', { name: 'Dialect edge-annotations 1.0.0' })).toHaveCount(0);
      await main.getByRole('group', { name: 'Provenance' }).getByRole('button', { name: 'All', exact: true }).click();

      await main.getByRole('tab', { name: /^Adapters/ }).click();
      await expect(page).toHaveURL(/tab=adapters/);
      const adapters = main.getByRole('region', { name: 'Installed adapters' });
      await expect(adapters.getByRole('row')).toHaveCount(4);
      await expect(adapters).toContainText('Profile · qos-binding/v1');
      await capture(page, testInfo, `language-${name}-adapters`, { height: tall(1300) });

      await main.getByRole('tab', { name: /Registered resources/ }).click();
      const resources = main.getByRole('region', { name: 'Registered resources' });
      await expect(resources.getByRole('row')).toHaveCount(3);
      await expect(resources.getByRole('row', { name: /eu-edge-placement/ })).toContainText('placement/v1 · JSON');
      await capture(page, testInfo, `language-${name}-resources`, { height: tall(1300) });
      expect(critical).toEqual([]);
    });

    test('lang-extensions /app/language/extensions · nothing installed yet, a key that cannot read it (403) and a catalog that does not answer (503)', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      const main = page.locator('#platform-main');

      state.refuse.dialects = json({ dialects: [] });
      state.refuse.resources = json({ resources: [] });
      state.refuse.profiles = json({ profiles: [] });
      await page.goto('/app/language/extensions');
      await expect(main.getByText('No dialects installed')).toBeVisible();
      await capture(page, testInfo, `language-${name}-empty`, { height: tall(1200) });
      await main.getByRole('tab', { name: /Registered resources/ }).click();
      await expect(main.getByText('No resources registered yet')).toBeVisible();

      state.refuse.resources = problem(403, 'insufficient_api_key_permission', 'The API key does not include this permission');
      await page.goto('/app/language/extensions?tab=resources');
      await expect(main.getByText('This API key can’t read the language catalog (403)')).toBeVisible();
      await expect(main.getByRole('link', { name: 'Manage API keys' })).toHaveAttribute('href', '/app/account/keys');
      await capture(page, testInfo, `language-${name}-403`, { height: tall(1100) });

      state.refuse.dialects = unavailable;
      await page.goto('/app/language/extensions');
      await expect(main.getByText(/The language extensions couldn’t be loaded \(HTTP 503\)/)).toBeVisible();
      await capture(page, testInfo, `language-${name}-503`, { height: tall(1100) });
      state.refuse.dialects = undefined;
      state.refuse.resources = undefined;
      state.refuse.profiles = undefined;
      await main.getByRole('button', { name: 'Retry' }).click();
      await expect(main.getByRole('article', { name: 'Dialect placement 1.0.0' })).toBeVisible();
      expect(critical).toEqual([]);
    });
  });
}
