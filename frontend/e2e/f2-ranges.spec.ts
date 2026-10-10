import { expect as baseExpect, test, type Page, type Route, type TestInfo } from '@playwright/test';
import { API, PUBLIC_ENGINES, installMockApi } from './helpers/mockApi';
import { failureBody } from './helpers/problems';
import { digestOf, irDocument } from '../src/pages/Cases/fixtures';
import type { JsonObject } from '../src/pages/Library/contentModel';
import { idFor } from '../src/pages/Library/fixtures';
import { REGISTRATION, detailOf } from '../src/test/fixtures/jobs';

// F2 · ranges of candidate features, from the library to the engines.
// A feature of a candidate is a number or a range { min, max } whose ends are numbers or null (no limit). This walks it through the
// screens that edit it (the draft of a catalog), read it (a sealed version, a case revision, a comparison) and decide on it
// (the engine step of a run, a run the engine refused, the workbench, a run that failed for ranges). Snapshot pages are covered by their unit tests. The API origin is the shared mock of the QA gallery with a few answers of
// its own on top. Unlike the other specs, the pictures are always taken (test-results/, ignored by git): they are the evidence of F2.

const expect = baseExpect.configure({ timeout: 10_000 });

const ME_ID = '00000000-0000-4000-8000-000000000005';
const S1 = '00000000-0000-4000-8000-0000000000e0';
const S2 = '00000000-0000-4000-8000-0000000000e1';

const ROOT = '/app/isa-demo/qos-benchmarks';
const LIB = '/app/isa-demo/library/providers-eu';
const DRAFT = `${LIB}/drafts/draft-providers-4`;

function watchCriticalErrors(page: Page) {
  const critical: string[] = [];
  page.on('pageerror', (error) => critical.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    const text = message.text();
    if (message.type() === 'error' && /The above error occurred|Minified React error|Maximum update depth|Uncaught/i.test(text)) critical.push(`console: ${text}`);
  });
  return critical;
}

/** A full-page picture of the current state, and a check against the width of the device that nothing scrolls sideways. */
async function capture(page: Page, testInfo: TestInfo, name: string) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    (document.activeElement as HTMLElement | null)?.blur();
    window.scrollTo(0, 0);
  });
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true, animations: 'disabled' });
  const width = page.viewportSize()?.width ?? 0;
  const overflow = await page.evaluate((expected) => document.documentElement.scrollWidth - expected, width);
  expect(overflow, `${name} should not scroll sideways`).toBeLessThanOrEqual(1);
}

/** Answers `GET` of a snapshot with a compiled form in which some qualities were edited: the same revision, one step later. */
function snapshotWith(pay: number, edit: (candidates: Record<string, { features: Record<string, unknown> }>) => void, id: string) {
  const document = irDocument(pay) as { spec: { candidates: { providers: { candidates: Record<string, { features: Record<string, unknown> }> } } } };
  edit(document.spec.candidates.providers.candidates);
  return {
    id, ownerId: ME_ID, instanceDigest: digestOf('a'), packageDigest: digestOf('b'), archiveSize: 48_213, createdAt: '2026-08-20T10:05:00Z',
    ir: { id: `ir-${id}`, digest: digestOf('c'), document, sourceMap: null, compilerVersion: '1.0.0', createdAt: '2026-08-20T10:05:00Z' },
  };
}

async function answerSnapshots(page: Page) {
  const reply = (id: string, pay: number, edit: Parameters<typeof snapshotWith>[1]) => page.route(new RegExp(`/v1/snapshots/${id}$`), (route) => route.fulfill({
    status: 200, json: snapshotWith(pay, edit, id),
  }));
  await reply(S1, 5, () => undefined);
  // One step later: a number became an open range, a range moved, and an open range became a number.
  await reply(S2, 8, (candidates) => {
    candidates['authenticate-1'].features.latency = { min: null, max: 60 };
    candidates['authenticate-2'].features.cost = { min: 0.02, max: 0.05 };
    candidates['authenticate-3'].features.latency = 90;
  });
}

// The dev server compiles on demand, so the first screen of a run is slow. Each viewport walks its tests in order in one worker
// (a failure stops the walk), and the two viewports run side by side.
test.setTimeout(100_000);

const viewports = [
  { name: 'desktop', viewport: { width: 1440, height: 900 }, isMobile: false, deviceScaleFactor: 1 },
  { name: 'mobile', viewport: { width: 390, height: 844 }, isMobile: true, deviceScaleFactor: 2 },
] as const;

for (const { name, viewport, isMobile, deviceScaleFactor } of viewports) {
  test.describe(`${name} · F2 ranges`, () => {
    test.describe.configure({ mode: 'serial' });
    test.use({ viewport, isMobile, deviceScaleFactor });

    test('lib-draft · edit closed, open and unbounded ranges, save, then read the version', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      await installMockApi(page, 'admin');
      const store: { saved: { revision: number; content: JsonObject } | null } = { saved: null };
      const catalogId = idFor('providers-eu');
      await page.route(new RegExp(`/v1/artifacts/${catalogId}/drafts/draft-providers-4$`), async (route: Route) => {
        if (route.request().method() !== 'PUT') return route.fallback();
        const body = route.request().postDataJSON() as { revision: number; content: JsonObject };
        store.saved = body;
        return route.fulfill({ status: 200, json: { id: 'draft-providers-4', revision: body.revision + 1 } });
      });
      // The version a reader opens is the content that was just saved.
      await page.route(new RegExp(`/v1/artifacts/${catalogId}/versions/[^/]+/content$`), (route) => (
        store.saved ? route.fulfill({ status: 200, contentType: 'text/plain', body: JSON.stringify(store.saved.content) }) : route.fallback()
      ));
      const main = page.locator('#platform-main');
      const cell = (candidate: string, quality: string) => main.getByRole('group', { name: `${quality} for ${candidate}: value or range` });
      const field = (candidate: string, quality: string, part: string) => main.getByLabel(`${quality} for ${candidate} ${part}`, { exact: true });
      const open = (candidate: string, quality: string, side: 'lower' | 'upper') => main.getByLabel(`${quality} for ${candidate}: no ${side} limit`, { exact: true });

      await page.goto(DRAFT);
      await expect(main.getByRole('heading', { level: 1, name: 'EU providers · draft' })).toBeVisible();

      // The draft opens with ranges already in it: each cell shows the mode it holds, and a column mixes numbers and ranges.
      await expect(cell('stockly-1', 'latency_ms').getByRole('button', { name: 'Range' })).toHaveAttribute('aria-pressed', 'true');
      await expect(field('stockly-1', 'latency_ms', 'min')).toHaveValue('35');
      await expect(field('stockly-1', 'latency_ms', 'max')).toHaveValue('60');
      await expect(field('stockly-1', 'cost_eur', 'min')).toBeDisabled();
      await expect(field('stockly-1', 'cost_eur', 'min')).toHaveValue('−∞');
      await expect(field('stockly-1', 'availability', 'max')).toHaveValue('+∞');
      await expect(cell('fastpay', 'latency_ms').getByRole('button', { name: 'Value' })).toHaveAttribute('aria-pressed', 'true');
      await expect(main.getByLabel('latency_ms for fastpay', { exact: true })).toHaveValue('95');
      await expect(main.getByRole('region', { name: 'Checks' })).toContainText('3 qualities are ranges');
      await capture(page, testInfo, `draft-${name}-opened`);

      // A closed range, one with no upper limit, one with no lower limit and one with no information.
      await cell('fastpay', 'latency_ms').getByRole('button', { name: 'Range' }).click();
      await expect(field('fastpay', 'latency_ms', 'min')).toHaveValue('95');
      await field('fastpay', 'latency_ms', 'min').fill('80');
      await field('fastpay', 'latency_ms', 'max').fill('120');

      await cell('fastpay', 'availability').getByRole('button', { name: 'Range' }).click();
      await open('fastpay', 'availability', 'upper').check();
      await expect(field('fastpay', 'availability', 'max')).toBeDisabled();

      await cell('payco-eu', 'cost_eur').getByRole('button', { name: 'Range' }).click();
      await open('payco-eu', 'cost_eur', 'lower').check();
      await field('payco-eu', 'cost_eur', 'max').fill('0.03');

      await cell('payco-eu', 'latency_ms').getByRole('button', { name: 'Range' }).click();
      await open('payco-eu', 'latency_ms', 'lower').check();
      await open('payco-eu', 'latency_ms', 'upper').check();
      await expect(main.getByRole('region', { name: 'Checks' })).toContainText('7 qualities are ranges');
      await capture(page, testInfo, `draft-${name}-edited`);

      // Min above max is flagged where it is typed and keeps the draft from being saved or sealed.
      await field('fastpay', 'latency_ms', 'min').fill('200');
      await expect(main.getByRole('alert').filter({ hasText: /^Min can’t be greater than max\.$/ })).toBeVisible();
      await expect(field('fastpay', 'latency_ms', 'min')).toHaveAttribute('aria-invalid', 'true');
      await expect(field('fastpay', 'latency_ms', 'max')).toHaveAttribute('aria-invalid', 'true');
      await expect(main.getByRole('button', { name: 'Save draft' })).toBeDisabled();
      await expect(main.getByRole('button', { name: 'Seal version…' })).toBeDisabled();
      await expect(main.getByRole('region', { name: 'Checks' })).toContainText('1 range is not valid');
      await capture(page, testInfo, `draft-${name}-invalid`);
      await field('fastpay', 'latency_ms', 'min').fill('80');
      await expect(main.getByRole('button', { name: 'Save draft' })).toBeEnabled();

      const request = page.waitForRequest((candidate) => candidate.method() === 'PUT' && /\/drafts\/draft-providers-4$/.test(candidate.url()));
      await main.getByRole('button', { name: 'Save draft' }).click();
      await request;
      await expect(main.getByText('All changes saved')).toBeVisible();

      const content = store.saved!.content as { spec: { candidates: Record<string, { features: Record<string, unknown> }> } };
      expect(content.spec.candidates.fastpay.features).toEqual({ latency_ms: { min: 80, max: 120 }, cost_eur: 0.034, availability: { min: 99.9, max: null } });
      expect(content.spec.candidates['payco-eu'].features).toEqual({ latency_ms: { min: null, max: null }, cost_eur: { min: null, max: 0.03 }, availability: 99.95 });
      expect(content.spec.candidates['stockly-1'].features).toEqual({ latency_ms: { min: 35, max: 60 }, cost_eur: { min: null, max: 0.004 }, availability: { min: 99.5, max: null } });
      await capture(page, testInfo, `draft-${name}-saved`);

      // Reading what was saved.
      await page.goto(`${LIB}/versions/3`);
      const payment = main.getByRole('table', { name: 'Candidates for service/payment' });
      await expect(payment.getByRole('row', { name: /fastpay/ })).toContainText('80–120');
      await expect(payment.getByRole('row', { name: /fastpay/ })).toContainText('≥ 99.9');
      await expect(payment.getByRole('row', { name: /payco-eu/ })).toContainText('unbounded');
      await expect(payment.getByRole('row', { name: /payco-eu/ })).toContainText('≤ 0.03');
      await expect(payment.getByRole('row', { name: /payco-eu/ })).toContainText('99.95');
      await expect(payment.getByText('≥ 99.9')).toHaveAttribute('title', '[99.9, +∞)');
      await expect(main.getByRole('table', { name: 'Candidates for service/stock' }).getByRole('row', { name: /stockly-1/ })).toContainText('35–60');
      await capture(page, testInfo, `version-${name}`);
      expect(critical).toEqual([]);
    });

    test('case-revision and case-compare · bars for ranges and what changed between two revisions', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      await installMockApi(page, 'admin');
      await answerSnapshots(page);
      const main = page.locator('#platform-main');

      await page.goto(`${ROOT}/cases/checkout-flow/revisions/2`);
      const providers = main.getByRole('region', { name: 'Candidates' });
      await expect(providers.getByRole('table')).toBeVisible();
      await expect(providers.getByRole('row', { name: /auth-1/ })).toContainText('≤ 60 ms');
      await expect(providers.getByRole('row', { name: /auth-2/ })).toContainText('0.02–0.05 EUR');
      await expect(providers.getByRole('row', { name: /auth-4/ })).toContainText('unbounded');
      await expect(providers.getByRole('row', { name: /auth-4/ })).toContainText('0.04 EUR');
      await expect(providers.getByText('≤ 60 ms')).toHaveAttribute('title', '(−∞, 60] ms');
      // A range is a stretch on the bar; an open end fades out towards the edge.
      await expect(providers.locator('.case-bar.is-interval')).not.toHaveCount(0);
      await expect(providers.locator('.case-bar.is-interval i.is-open-low')).not.toHaveCount(0);
      await expect(providers.locator('.case-bar.is-interval i.is-open-high')).not.toHaveCount(0);
      await expect(providers.locator('.case-bar.is-interval i.is-open-low.is-open-high')).toHaveCount(1);
      await capture(page, testInfo, `revision-${name}`);
      if (isMobile) {
        expect(critical).toEqual([]);
        return;
      }

      await page.goto(`${ROOT}/cases/checkout-flow/compare?from=1&to=2`);
      const row = (what: RegExp) => main.getByRole('row', { name: what });
      await expect(row(/authenticate-1 · latency \(now a range\)/)).toContainText('40 ms');
      await expect(row(/authenticate-1 · latency \(now a range\)/)).toContainText('≤ 60 ms');
      await expect(row(/authenticate-2 · cost \(range changed\)/)).toContainText('0.02–0.04 EUR');
      await expect(row(/authenticate-2 · cost \(range changed\)/)).toContainText('0.02–0.05 EUR');
      await expect(row(/authenticate-3 · latency \(now a single value\)/)).toContainText('≥ 100 ms');
      await expect(row(/authenticate-3 · latency \(now a single value\)/)).toContainText('90 ms');
      await capture(page, testInfo, `compare-${name}`);
      expect(critical).toEqual([]);
    });

    test('job-launch · the engine that only takes single values is off, with its reason, and a refused run is explained', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      await installMockApi(page, 'admin');
      const REASON = 'This package has range features; this engine only accepts single values';
      const pointer = '/spec/candidates/providers/candidates/authenticate-3/features/latency';
      const refusal = [{ code: 'unsupported_capability_value', message: 'featureValues interval is not declared by this mode', pointer }];

      await page.route(`${API}/v1/validate`, (route) => route.fulfill({
        status: 200,
        json: {
          valid: true, instanceDigest: digestOf('a'), packageDigest: digestOf('b'), irDigest: digestOf('c'), fileDigests: {}, resourceDigests: {}, diagnostics: [],
          analysis: { tasks: 6, candidates: 24, constraints: 2, placement: false, bindingSpace: '125892' },
          compatibleModes: [
            { engine: PUBLIC_ENGINES[0].ref, registration: REGISTRATION, mode: 'sampling', compatible: false, diagnostics: refusal },
            { engine: PUBLIC_ENGINES[2].ref, registration: { ...REGISTRATION, name: 'minizinc-deployment' }, mode: 'cp', compatible: true },
          ],
        },
      }));
      // The engine that was left on is refused anyway at the gateway (as if its manifest said interval and the problem said otherwise).
      await page.route(/\/v1\/jobs$/, (route) => (route.request().method() === 'POST'
        ? route.fulfill({ status: 422, json: failureBody(422, 'unsupported_capability_value', 'featureValues interval is not declared by this mode', { diagnostics: refusal }) })
        : route.fallback()));
      const main = page.locator('#platform-main');

      await page.goto(`${ROOT}/jobs/new?case=checkout-flow&revision=2`);
      await main.getByRole('button', { name: 'Continue' }).click();
      const engines = main.getByRole('radiogroup', { name: 'Engine' });
      const off = engines.getByRole('radio', { name: /^random-search/ });
      await expect(off).toBeDisabled();
      await expect(off).toHaveAccessibleName(new RegExp(REASON));
      await expect(engines.getByRole('radio', { name: /^minizinc/ })).toBeEnabled();
      await expect(engines.getByRole('radio', { name: /^minizinc/ })).toBeChecked();
      const notice = main.locator('.ui-notice').filter({ hasText: 'This package has range features' });
      await expect(notice).toContainText('The engines marked “Can’t run this” only accept single values.');
      await expect(notice.getByRole('link', { name: 'Engines' })).toHaveAttribute('href', '/engines');
      await expect(notice.getByRole('link', { name: 'edit the candidates' })).toHaveAttribute('href', '/app/isa-demo/library');
      await capture(page, testInfo, `launch-engines-${name}`);

      await main.getByRole('button', { name: 'Continue' }).click();
      // The mock engine declares a seed whose default is 0, which the form asks to be a positive number.
      await main.getByLabel('Seed', { exact: true }).fill('1');
      await main.getByRole('button', { name: 'Continue' }).click();
      await main.getByRole('button', { name: 'Send run' }).click();
      const alert = main.getByRole('alert').filter({ hasText: 'This engine only accepts single values' });
      await expect(alert).toContainText(`featureValues interval is not declared by this mode (${pointer})`);
      await expect(alert.getByRole('link', { name: 'Engines' })).toHaveAttribute('href', '/engines');
      await expect(alert.getByRole('link', { name: 'Edit the candidate' })).toHaveAttribute('href', '/app/isa-demo/library');
      await capture(page, testInfo, `launch-refused-${name}`);
      expect(critical).toEqual([]);
    });
  });
}

// The two places the other specs do not reach: the workbench (a package edited into a range) and a run that failed for ranges.
test.describe('desktop · F2 ranges in the workbench and in a failed run', () => {
  test.describe.configure({ mode: 'serial' });
  test.use({ viewport: viewports[0].viewport });

  test('workbench · a candidate edited into an open range turns the engines that only take single values off', async ({ page }, testInfo) => {
    const critical = watchCriticalErrors(page);
    await installMockApi(page, 'admin');
    const refusal = [{ code: 'unsupported_capability_value', message: 'featureValues interval is not declared by this mode', pointer: '/spec/candidates/service-a/features/latency' }];
    await page.route(`${API}/v1/validate`, (route) => route.fulfill({
      status: 200,
      json: {
        valid: true, instanceDigest: digestOf('a'), packageDigest: digestOf('b'), irDigest: digestOf('c'), fileDigests: {}, resourceDigests: {}, diagnostics: [],
        analysis: { tasks: 1, candidates: 1, constraints: 0, placement: false, bindingSpace: '1' },
        compatibleModes: [
          { engine: PUBLIC_ENGINES[0].ref, registration: REGISTRATION, mode: 'sampling', compatible: false, diagnostics: refusal },
          { engine: PUBLIC_ENGINES[2].ref, registration: { ...REGISTRATION, name: 'minizinc-deployment' }, mode: 'cp', compatible: true },
        ],
      },
    }));
    const main = page.locator('#platform-main');

    await page.goto(`${ROOT}/workbench`);
    await main.getByRole('navigation', { name: 'BIM resources' }).getByRole('button', { name: /candidates\.json/ }).click();
    await expect(main.getByLabel('service-a QoS latency')).toHaveValue('10');
    await main.getByRole('group', { name: 'latency for service-a: value or range' }).getByRole('button', { name: 'Range' }).click();
    await main.getByLabel('latency for service-a: no upper limit', { exact: true }).check();
    await expect(main.getByLabel('latency for service-a min', { exact: true })).toHaveValue('10');
    await expect(main.getByLabel('latency for service-a max', { exact: true })).toHaveValue('+∞');

    await main.getByRole('button', { name: 'Validate', exact: true }).click();
    const note = main.getByRole('note').filter({ hasText: 'This package has range features' });
    await expect(note).toContainText('1 engine mode is off.');
    await expect(note.getByRole('link', { name: 'Engines' })).toHaveAttribute('href', '/engines');
    await expect(main.getByRole('option', { name: /random-search · sampling .* can’t run ranges/ })).toHaveAttribute('disabled', '');
    await capture(page, testInfo, 'workbench-desktop-ranges');
    expect(critical).toEqual([]);
  });

  test('job-detail · a run the engine refused for ranges says so and leads to the engines and to the candidate', async ({ page }, testInfo) => {
    const critical = watchCriticalErrors(page);
    await installMockApi(page, 'admin');
    const pointer = '/spec/candidates/providers/candidates/authenticate-3/features/latency';
    await page.route(/\/v1\/jobs\/job-range-failed$/, (route) => route.fulfill({
      status: 200,
      json: detailOf('job-range-failed', 'failed', {
        result: { code: 'unsupported_capability_value', error: 'unsupported_capability_value: featureValues interval is not declared by this mode', diagnostics: [{ code: 'unsupported_capability_value', message: 'featureValues interval is not declared by this mode', pointer }] },
      }),
    }));
    const main = page.locator('#platform-main');

    await page.goto(`${ROOT}/jobs/job-range-failed`);
    const alert = main.getByRole('alert').filter({ hasText: 'This engine only accepts single values' });
    await expect(alert).toContainText(`featureValues interval is not declared by this mode (${pointer})`);
    await expect(alert).not.toContainText('Nothing was started.');
    await expect(alert.getByRole('link', { name: 'Engines' })).toHaveAttribute('href', '/engines');
    await expect(alert.getByRole('link', { name: 'Edit the candidate' })).toHaveAttribute('href', '/app/isa-demo/library');
    await capture(page, testInfo, 'job-detail-desktop-range-failure');
    expect(critical).toEqual([]);
  });
});
