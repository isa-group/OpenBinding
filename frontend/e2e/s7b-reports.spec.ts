import { createHash } from 'node:crypto';
import { expect as baseExpect, test, type Locator, type Page, type Route, type TestInfo } from '@playwright/test';
import { failureBody } from './helpers/problems';
import type { Publication, VerifierEntity, VerifierVerdict } from '../src/api/platform';
import { CURRENT_FIXTURE, catalogFixture } from '../src/pages/Pricing/pricingFixture';
import { EDITION, FROZEN, publicationOf } from '../src/test/fixtures/reports';
import { usageOf } from '../src/test/fixtures/resources';
import { RUN_ID, cellsFixture, digestOf, runFixture, studyFixture } from '../src/test/fixtures/studies';

// S7b · reports: the redirect of the retired analysis and report addresses, proj-publications and verifier.
// There is no backend: the API origin is answered by page.route(). Screenshots go to testInfo.outputPath() (test-results/, ignored by git)
// so they can be looked at after a run. Every test walks a screen through its states on a desktop and on a phone.

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
  'read-lab': [project(4, 'org-4', 'bench', 'Bench')],
};

// --- the evidence the verifier can find

const FILE_BYTES = 'a,b\n1,2\n';
const sha = (data: string | Buffer) => `sha256-${createHash('sha256').update(data).digest('hex')}`;
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
};

const reportEntity: VerifierEntity = {
  entity_type: 'report', id: 'report-1', slug: 'engine-comparison', title_or_name: 'Engine comparison at checkout',
  organization_slug: 'isa-demo', project_slug: 'qos-benchmarks', created_at: '2026-09-25T09:00:00Z',
};
const fileEntity: VerifierEntity = {
  entity_type: 'artifact', id: 'blob-1', title_or_name: 'Blob (text/csv, 8 B)', organization_slug: 'isa-demo', project_slug: 'qos-benchmarks', created_at: '2026-09-26T09:00:00Z',
};
const caseEntity: VerifierEntity = {
  entity_type: 'case', id: 'case-1', slug: 'flujo-checkout', title_or_name: 'Flujo de checkout (r2)', organization_slug: 'isa-demo', project_slug: 'checkout-privado', created_at: '2026-08-20T09:00:00Z', revision: 2,
};

const verdictOf = (status: VerifierVerdict['status'], digest: string, entities: VerifierEntity[], extra: Partial<VerifierVerdict> = {}): VerifierVerdict => ({
  status, digest, matches: status !== 'mismatch' && status !== 'not_found', verified_at: '2026-10-09T10:00:00Z', entities,
  detail: entities.length ? `Cryptographically verified against ${entities.length} registered entities.` : 'Digest not registered in platform ledger.', ...extra,
});

// --- what the gateway answers

type Overridable = 'withdraw' | 'publications' | 'verify' | 'verifyFile';

interface State {
  /** A handler that replaces the default answer of one call. */
  refuse: Partial<Record<Overridable, Handler>>;
  sent: { withdrawn: string[]; verify: Array<Record<string, unknown>>; verifyFile: number };
  publications: Publication[];
}

interface MockOptions {
  /** The account's role in ISA Demo Group. */
  role?: Role;
}

const bodyOf = <T = Record<string, unknown>>(route: Route) => route.request().postDataJSON() as T;

/** Everything these screens read and write, answered; anything else on the API origin is an empty 404. */
async function mockApi(page: Page, options: MockOptions = {}): Promise<State> {
  const state: State = {
    refuse: {},
    sent: { withdrawn: [], verify: [], verifyFile: 0 },
    publications: [publicationOf(FROZEN)],
  };
  const organizations = [
    org('org-isa-demo', 'isa-demo', 'ISA Demo Group', options.role ?? 'OWNER'),
    org('org-4', 'read-lab', 'Read Lab', 'VIEWER', 'user-nora'),
  ];
  await page.addInitScript(() => {
    localStorage.setItem('openbinding-access-token', 's7b-access');
    localStorage.setItem('openbinding-refresh-token', 's7b-refresh');
  });

  await page.route(`${API}/**`, (route) => route.fulfill({ status: 404, json: { detail: 'not mocked' } }));
  await page.route(`${API}/health**`, json({ status: 'ok' }));
  await page.route(`${API}/v1/auth/refresh`, json({ access_token: 's7b-access-2', refresh_token: 's7b-refresh-2', token_type: 'bearer', expires_in: 900 }));
  await page.route(`${API}/v1/pricing/catalog`, json(catalogFixture));
  await page.route(`${API}/v1/pricing/current`, json(CURRENT_FIXTURE));
  await page.route(`${API}/v1/users/me`, json(lucia));
  await page.route(`${API}/v1/users/me/usage`, json(usageOf({ plan: 'RESEARCH', capabilities: {} })));
  await page.route(`${API}/v1/users/me/pricing-token`, json({ pricing_token: token(3600) }));
  await page.route(new RegExp(`^${API}/v1/notifications(\\?.*)?$`), json([]));
  await page.route(`${API}/v1/engines`, json({ engines: [] }));

  // --- the verifier
  await page.route(`${API}/v1/verifier/inspect`, (route) => {
    const body = bodyOf<{ digest?: string | null; document?: unknown }>(route);
    state.sent.verify.push(body);
    if (state.refuse.verify) return state.refuse.verify(route);
    if (body.document !== undefined && body.document !== null) {
      const computed = sha(canonical(body.document));
      if (body.digest) return json(verdictOf(body.digest === computed ? 'verified' : 'mismatch', body.digest, [], { canonical_json: canonical(body.document) }))(route);
      return json(verdictOf('computed', computed, [], { canonical_json: canonical(body.document), detail: 'Calculated canonical RFC 8785 SHA-256 digest.' }))(route);
    }
    if (body.digest === EDITION) return json(verdictOf('verified', EDITION, [reportEntity]))(route);
    return json(verdictOf('not_found', body.digest ?? '', []))(route);
  });
  await page.route(`${API}/v1/verifier/inspect-file`, (route) => {
    state.sent.verifyFile += 1;
    if (state.refuse.verifyFile) return state.refuse.verifyFile(route);
    const digest = sha(route.request().postDataBuffer() ?? Buffer.alloc(0));
    return json(verdictOf(digest === sha(FILE_BYTES) ? 'verified' : 'computed', digest, digest === sha(FILE_BYTES) ? [fileEntity] : [], { matches: true }))(route);
  });

  // --- projects, reports and publications
  await page.route(new RegExp(`^${API}/v1/organizations(/.*)?(\\?.*)?$`), async (route) => {
    const url = new URL(route.request().url());
    const parts = url.pathname.split('/').filter(Boolean);
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
    const empty = projectSlug === 'checkout-privado';

    if (sub === 'studies') {
      if (!subId) return json(empty ? [] : [studyFixture()])(route);
      if (action === 'runs') {
        const [, , , , , , , , runId, tail, cellId] = parts;
        if (!runId) return json([runFixture()])(route);
        if (tail === 'cells' && cellId) {
          const cell = cellsFixture().find((item) => item.id === cellId);
          return cell ? json(cell)(route) : detail(404, 'not_found', 'Study cell not found.')(route);
        }
        if (tail === 'cells') return json(cellsFixture())(route);
        return json(runFixture())(route);
      }
      return json(studyFixture())(route);
    }

    if (sub === 'publications') {
      if (method === 'DELETE') {
        state.sent.withdrawn.push(subId);
        if (state.refuse.withdraw) return state.refuse.withdraw(route);
        const target = state.publications.find((item) => item.slug === subId);
        if (target) target.withdrawn = true;
        return route.fulfill({ status: 204 });
      }
      if (state.refuse.publications) return state.refuse.publications(route);
      return json(empty ? [] : state.publications)(route);
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

const ROOT = '/app/isa-demo/qos-benchmarks';

for (const { name, viewport, isMobile, deviceScaleFactor } of viewports) {
  test.describe(`${name} · S7b analysis and reports`, () => {
    // One worker per viewport: with every test in parallel the browsers starve each other and the same walk takes twice as long.
    test.describe.configure({ mode: 'default' });
    test.use({ viewport, isMobile, deviceScaleFactor });

    test('retired analysis screens · old links land on the jobs list or on the study run', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      await mockApi(page);

      await page.goto('/app/analysis');
      await expect(page).toHaveURL(/\/app\/jobs$/);
      await page.goto('/app/analysis/workspace?job=x');
      await expect(page).toHaveURL(/\/app\/jobs$/);

      await page.goto(`/app/analysis?org=isa-demo&project=qos-benchmarks&study=engines-vs-seeds&run=${RUN_ID}`);
      await expect(page).toHaveURL(new RegExp(`${ROOT}/studies/engines-vs-seeds/runs/${RUN_ID}$`));
      await capture(page, testInfo, `analysis-${name}-old-link`, { height: 900 });
      expect(critical).toEqual([]);
    });

    test('retired report editor · old links land on the publications list, with or without a slug, a query or an encoded slug', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      await mockApi(page);

      await page.goto(`${ROOT}/reports/engine-comparison`);
      await expect(page).toHaveURL(new RegExp(`${ROOT}/publications$`));
      await expect(page.locator('#platform-main').getByRole('heading', { level: 1, name: 'Publications' })).toBeVisible();
      await capture(page, testInfo, `reports-${name}-old-link`, { height: 900 });

      await page.goto(`${ROOT}/reports?filter=drafts#top`);
      await expect(page).toHaveURL(new RegExp(`${ROOT}/publications$`));
      await page.goto(`${ROOT}/reports/hallazgos%20de%20checkout`);
      await expect(page).toHaveURL(new RegExp(`${ROOT}/publications$`));
      expect(critical).toEqual([]);
    });

    test('proj-publications /app/:org/:project/publications · citing, verifying, withdrawing', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      await page.goto(`${ROOT}/publications`);
      const main = page.locator('#platform-main');

      await expect(main.getByRole('heading', { level: 1, name: 'Publications' })).toBeVisible();
      await expect(main.getByText(/Report editions made public from QoS Benchmarks\. Withdrawing hides one from listings but keeps every link and fingerprint working\./)).toBeVisible();
      await expect(main.getByRole('navigation', { name: 'Project sections' }).getByRole('link', { name: 'Publications', exact: true })).toHaveAttribute('aria-current', 'page');
      await expect(main.getByRole('heading', { level: 2, name: 'Engine comparison at checkout' })).toBeVisible();
      await expect(main.getByText('checkout-comparison · published Sep 25, 2026 · sha256-eeee…eeee')).toBeVisible();
      await expect(main.getByText('Alex Rivera (2026). Engine comparison at checkout. ISA Demo Group / QoS Benchmarks.')).toBeVisible();
      await expect(main.getByRole('link', { name: 'Open public verification' })).toHaveAttribute('href', `/resolve/report/${EDITION}`);
      await expect(main.getByRole('link', { name: 'Open the report' })).toHaveCount(0);
      await capture(page, testInfo, `publications-${name}-list`, { height: 1500 });

      await main.getByRole('button', { name: 'Withdraw' }).click();
      const dialog = page.getByRole('dialog', { name: 'Withdraw checkout-comparison?' });
      await capture(page, testInfo, `publications-${name}-confirm`);
      state.refuse.withdraw = detail(403, 'forbidden', 'Your role does not reach this.');
      await dialog.getByRole('button', { name: 'Withdraw' }).click();
      await expect(dialog.getByText('Your role doesn’t reach this (403 · forbidden)')).toBeVisible();
      state.refuse.withdraw = undefined;
      await dialog.getByRole('button', { name: 'Withdraw' }).click();
      await expect(main.getByText('Withdrawn. It’s no longer listed in Explore, but its link, citation and fingerprint still work.')).toBeVisible();
      await expect(main.getByText('Withdrawn · still reachable by link')).toBeVisible();
      await expect(main.getByRole('button', { name: 'Withdraw' })).toHaveCount(0);
      await expect(main.getByRole('link', { name: 'Open public verification' })).toBeVisible();
      expect(state.sent.withdrawn).toEqual(['checkout-comparison', 'checkout-comparison']);
      await capture(page, testInfo, `publications-${name}-withdrawn`, { height: 1500 });
      expect(critical).toEqual([]);
    });

    test('proj-publications /app/:org/:project/publications · nothing yet, a viewer, 503 and a project that is not there', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      const main = page.locator('#platform-main');

      await page.goto('/app/isa-demo/checkout-privado/publications');
      await expect(main.getByText('Nothing published yet')).toBeVisible();
      await expect(main.getByText(/Nothing published from this project yet\./)).toBeVisible();
      await capture(page, testInfo, `publications-${name}-empty`, { height: 900 });

      await page.goto('/app/read-lab/bench/publications');
      await expect(main.getByRole('heading', { level: 1, name: 'Publications' })).toBeVisible();
      await expect(main.getByRole('button', { name: 'Withdraw' })).toHaveCount(0);
      state.refuse.publications = unavailable;
      await page.goto(`${ROOT}/publications`);
      await expect(main.getByText(/Publications couldn’t be loaded \(503\)/)).toBeVisible();
      await expect(main.getByText('Nothing published yet')).toHaveCount(0);
      await capture(page, testInfo, `publications-${name}-503`, { height: 900 });
      state.refuse.publications = undefined;
      await main.getByRole('button', { name: 'Retry' }).click();
      await expect(main.getByRole('heading', { level: 2, name: 'Engine comparison at checkout' })).toBeVisible();

      await page.goto('/app/isa-demo/ghost/publications');
      await expect(main.getByRole('heading', { name: 'Project not found' })).toBeVisible();
      expect(critical).toEqual([]);
    });

    test('verifier /app/verifier · a fingerprint: verified with its matches and citation, not found, and not a fingerprint', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      await page.goto('/app/verifier');
      const main = page.locator('#platform-main');

      await expect(main.getByRole('heading', { level: 1, name: 'Verifier' })).toBeVisible();
      await expect(main.getByText(/Your browser computes the fingerprint and the server confirms it\./)).toBeVisible();
      await expect(main.getByText('Enter something to check.')).toBeVisible();
      await expect(main.getByRole('button', { name: 'Check' })).toBeDisabled();
      await capture(page, testInfo, `verifier-${name}-empty`, { height: 1100 });

      await main.getByRole('textbox', { name: 'Fingerprint' }).fill(EDITION);
      await main.getByRole('button', { name: 'Check' }).click();
      const verdict = main.getByRole('region', { name: 'Verdict' });
      await expect(verdict.getByText('Verified', { exact: true })).toBeVisible();
      await expect(verdict.getByText('OpenBinding recorded an element with this fingerprint.')).toBeVisible();
      const matches = main.getByRole('region', { name: 'Matches' });
      await expect(matches.getByText('Engine comparison at checkout')).toBeVisible();
      await expect(matches.getByRole('link', { name: 'Open' })).toHaveAttribute('href', `${ROOT}/publications`);
      await expect(matches.getByRole('link', { name: 'Public record' })).toHaveAttribute('href', `/resolve/report/${EDITION}`);
      await expect(main.getByText('OpenBinding (2026). Engine comparison at checkout. OpenBinding report edition, digest sha256-eeee…eeee.')).toBeVisible();
      expect(state.sent.verify.at(-1)).toEqual({ digest: EDITION });
      await capture(page, testInfo, `verifier-${name}-verified`, { height: 1700 });

      await main.getByRole('textbox', { name: 'Fingerprint' }).fill(digestOf('0'));
      await main.getByRole('button', { name: 'Check' }).click();
      await expect(main.getByText('Nothing found', { exact: true })).toBeVisible();
      await expect(main.getByText('nothing recorded', { exact: true })).toBeVisible();
      await expect(main.getByRole('region', { name: 'Matches' })).toHaveCount(0);
      await capture(page, testInfo, `verifier-${name}-not-found`, { height: 1200 });

      const asked = state.sent.verify.length;
      await main.getByRole('textbox', { name: 'Fingerprint' }).fill('sha256-123');
      await main.getByRole('button', { name: 'Check' }).click();
      await expect(main.getByText('That can’t be checked')).toBeVisible();
      await expect(main.getByText('That isn’t a valid fingerprint. A fingerprint is sha256- followed by 64 lowercase hexadecimal characters.')).toBeVisible();
      expect(state.sent.verify).toHaveLength(asked);
      await capture(page, testInfo, `verifier-${name}-invalid`, { height: 1100 });

      // A fingerprint in the address is checked on arrival.
      await page.goto(`/app/verifier?digest=${EDITION}`);
      await expect(main.getByRole('region', { name: 'Verdict' }).getByText('Verified', { exact: true })).toBeVisible();
      await expect(main.getByRole('textbox', { name: 'Fingerprint' })).toHaveValue(EDITION);
      expect(critical).toEqual([]);
    });

    test('verifier /app/verifier · a document and a file: computed, doesn’t match, verified, and the matches inside one project', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      await page.goto('/app/verifier');
      const main = page.locator('#platform-main');

      // A document: normalised before fingerprinting, so spacing and key order don't matter.
      await main.getByRole('tab', { name: 'Document text' }).click();
      await main.getByLabel('Paste the document’s text').fill('{ "b": 1,\n  "a": 2 }');
      await main.getByRole('button', { name: 'Check' }).click();
      const fingerprint = sha(canonical({ a: 2, b: 1 }));
      await expect(main.getByText('Computed, not on record')).toBeVisible();
      await expect(main.getByText('Computed in your browser')).toBeVisible();
      await expect(main.getByText(fingerprint, { exact: true }).first()).toBeVisible();
      expect(state.sent.verify.at(-1)).toEqual({ document: { b: 1, a: 2 }, digest: null });
      await expect(main.getByLabel('Normalised document')).toBeHidden();
      await main.getByText('View source').click();
      await expect(main.getByLabel('Normalised document')).toHaveText('{"a":2,"b":1}');
      await capture(page, testInfo, `verifier-${name}-computed`, { height: 1500 });

      await main.getByLabel('Fingerprint it should have (optional)').fill(EDITION);
      await main.getByRole('button', { name: 'Check' }).click();
      await expect(main.getByText('Doesn’t match', { exact: true })).toBeVisible();
      await expect(main.getByText('Fingerprint you expected', { exact: true })).toBeVisible();
      await capture(page, testInfo, `verifier-${name}-mismatch`, { height: 1500 });
      await main.getByLabel('Fingerprint it should have (optional)').fill(fingerprint);
      await main.getByRole('button', { name: 'Check' }).click();
      await expect(main.getByRole('region', { name: 'Verdict' }).getByText('Verified', { exact: true })).toBeVisible();

      await main.getByLabel('Paste the document’s text').fill('just words');
      await main.getByRole('button', { name: 'Check' }).click();
      await expect(main.getByText(/That text isn’t a JSON document/)).toBeVisible();

      // A file: hashed in the browser, then looked up.
      await main.getByRole('tab', { name: 'File' }).click();
      await main.getByLabel('Choose file').setInputFiles({ name: 'results.csv', mimeType: 'text/csv', buffer: Buffer.from(FILE_BYTES) });
      await expect(main.getByText(/results\.csv · 8 bytes/)).toBeVisible();
      await main.getByRole('button', { name: 'Check' }).click();
      await expect(main.getByRole('region', { name: 'Verdict' }).getByText('Verified', { exact: true })).toBeVisible();
      await expect(main.getByText(sha(FILE_BYTES), { exact: true }).first()).toBeVisible();
      await expect(main.getByRole('region', { name: 'Matches' }).getByText('Blob (text/csv, 8 B)')).toBeVisible();
      await capture(page, testInfo, `verifier-${name}-file`, { height: 1500 });
      await main.getByLabel('Choose file').setInputFiles({ name: 'other.bin', mimeType: 'application/octet-stream', buffer: Buffer.from('something else') });
      await main.getByRole('button', { name: 'Check' }).click();
      await expect(main.getByText('Computed, not on record')).toBeVisible();
      expect(state.sent.verifyFile).toBe(2);

      // Several matches, and only those of the current project on request.
      state.refuse.verify = json(verdictOf('verified', EDITION, [reportEntity, caseEntity]));
      await main.getByRole('tab', { name: 'Fingerprint' }).click();
      await main.getByRole('textbox', { name: 'Fingerprint' }).fill(EDITION);
      await main.getByRole('button', { name: 'Check' }).click();
      const matches = main.getByRole('region', { name: 'Matches' });
      await expect(matches.getByRole('listitem')).toHaveCount(2);
      await main.getByRole('checkbox', { name: 'Only show matches inside QoS Benchmarks' }).check();
      await expect(matches.getByRole('listitem')).toHaveCount(1);
      await expect(matches.getByText('1 more outside the chosen project.')).toBeVisible();
      await capture(page, testInfo, `verifier-${name}-scope`, { height: 1700 });
      expect(critical).toEqual([]);
    });

    test('verifier /app/verifier · the server refuses (422, 413, 503) and the page says what it means', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      await page.goto('/app/verifier');
      const main = page.locator('#platform-main');

      await main.getByRole('textbox', { name: 'Fingerprint' }).fill(EDITION);
      state.refuse.verify = detail(422, 'validation_error', 'digest is malformed');
      await main.getByRole('button', { name: 'Check' }).click();
      await expect(main.getByText('That isn’t a valid fingerprint or document (422 · validation_error)')).toBeVisible();
      await capture(page, testInfo, `verifier-${name}-422`, { height: 1100 });

      state.refuse.verify = unavailable;
      await main.getByRole('button', { name: 'Check' }).click();
      await expect(main.getByText('The verifier didn’t answer')).toBeVisible();
      await capture(page, testInfo, `verifier-${name}-503`, { height: 1100 });

      await main.getByRole('tab', { name: 'File' }).click();
      await main.getByLabel('Choose file').setInputFiles({ name: 'huge.bin', mimeType: 'application/octet-stream', buffer: Buffer.from('x') });
      state.refuse.verifyFile = detail(413, 'payload_too_large', 'The file is too large.');
      await main.getByRole('button', { name: 'Check' }).click();
      await expect(main.getByText('That file is too large to check here (413 · payload_too_large)')).toBeVisible();
      await capture(page, testInfo, `verifier-${name}-413`, { height: 1100 });
      expect(critical).toEqual([]);
    });
  });
}
