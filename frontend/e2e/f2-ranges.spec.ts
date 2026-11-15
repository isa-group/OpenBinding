import { expect as baseExpect, test, type Page, type TestInfo } from '@playwright/test';
import { API, PUBLIC_ENGINES, installMockApi } from './helpers/mockApi';
import { failureBody } from './helpers/problems';
import { digestOf, irDocument } from '../src/pages/Cases/fixtures';
import { REGISTRATION, detailOf } from '../src/test/fixtures/jobs';

// F2 · ranges of candidate features, from the problems to the engines.
// A feature of a candidate is a number or a range { min, max } whose ends are numbers or null (no limit). This walks it through the
// screens that read it (the Overview and the Versions tab of a problem page) and decide on it
// (the engine step of a run, a run the engine refused, the workbench's check result, a run that failed for ranges). The Source tab is covered by its unit tests. The API origin is the shared mock of the QA gallery with a few answers of
// its own on top. Unlike the other specs, the pictures are always taken (test-results/, ignored by git): they are the evidence of F2.

// The first screens are slow to open under load (the problem page reads the problem and then its compilation), so a wait is generous.
const expect = baseExpect.configure({ timeout: 20_000 });

const ROOT = '/app/isa-demo/qos-benchmarks';
const PROBLEMS = '/app/isa-demo/problems';

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

/** The IR of a version's compilation, with some qualities edited: version 2 is version 1 one step later. */
function irWith(pay: number, edit: (candidates: Record<string, { features: Record<string, unknown> }>) => void) {
  const document = irDocument(pay) as { spec: { candidates: { providers: { candidates: Record<string, { features: Record<string, unknown> }> } } } };
  edit(document.spec.candidates.providers.candidates);
  return document;
}

async function answerCompilations(page: Page) {
  const reply = (revision: number, pay: number, edit: Parameters<typeof irWith>[1]) => page.route(
    new RegExp(`/v1/organizations/isa-demo/problems/checkout-flow/revisions/${revision}/compilations/[^/]+/ir$`),
    (route) => route.fulfill({ status: 200, json: { id: `compilation-${revision}`, ir_digest: digestOf('c'), ir: irWith(pay, edit), source_map: {} } }),
  );
  await reply(1, 5, () => undefined);
  // One step later: a number became an open range, a range moved, and an open range became a number.
  await reply(2, 8, (candidates) => {
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

    test('case-detail · bars for ranges on the Overview and what changed between two versions on the Versions tab', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      await installMockApi(page, 'admin');
      await answerCompilations(page);
      const main = page.locator('#platform-main');

      await page.goto(`${PROBLEMS}/checkout-flow?version=2`);
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

      await page.goto(`${PROBLEMS}/checkout-flow/versions?from=1&to=2`);
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

      await answerCompilations(page);
      await page.route(/\/v1\/organizations\/isa-demo\/problems\/checkout-flow\/revisions\/2\/compilation$/, (route) => route.fulfill({
        status: 200,
        json: {
          id: 'compilation-2', revision_id: 'rev-checkout-2', compilation_digest: digestOf('9'), compiler_digest: digestOf('8'), ir_digest: digestOf('c'),
          binding_space: '125892', created_at: '2026-08-20T10:05:00Z', current: true, toolchain: {}, resources: {},
          analysis: { tasks: 6, candidates: 24, constraints: 2, placement: false, bindingSpace: '125892' },
          compatible_modes: [
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

      await page.goto(`${ROOT}/runs/new?problem=checkout-flow&revision=2`);
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
      await expect(notice.getByRole('link', { name: /library|edit the candidates/i })).toHaveCount(0);
      await capture(page, testInfo, `launch-engines-${name}`);

      await main.getByRole('button', { name: 'Continue' }).click();
      // The mock engine declares a seed whose default is 0, which the form asks to be a positive number.
      await main.getByLabel('Seed', { exact: true }).fill('1');
      await main.getByRole('button', { name: 'Continue' }).click();
      await main.getByRole('button', { name: 'Send run' }).click();
      const alert = main.getByRole('alert').filter({ hasText: 'This engine only accepts single values' });
      await expect(alert).toContainText(`featureValues interval is not declared by this mode (${pointer})`);
      await expect(alert.getByRole('link', { name: 'Engines' })).toHaveAttribute('href', '/engines');
      await expect(alert.getByRole('link', { name: /library|Edit the candidate/i })).toHaveCount(0);
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
    await page.route(`${API}/v1/bim/validate`, (route) => route.fulfill({
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

    await page.goto('/app/isa-demo/workbench');
    await main.getByRole('navigation', { name: 'BIM resources' }).getByRole('button', { name: /candidates\.json/ }).click();
    await expect(main.getByLabel('service-a QoS latency')).toHaveValue('10');
    await main.getByRole('group', { name: 'latency for service-a: value or range' }).getByRole('button', { name: 'Range' }).click();
    await main.getByLabel('latency for service-a: no upper limit', { exact: true }).check();
    await expect(main.getByLabel('latency for service-a min', { exact: true })).toHaveValue('10');
    await expect(main.getByLabel('latency for service-a max', { exact: true })).toHaveValue('+∞');

    await main.getByRole('button', { name: 'Validate', exact: true }).click();
    // The check result says which modes are off and why; the Workbench runs nothing itself (a saved version runs from its problem page).
    await main.getByRole('tab', { name: /Engines that can run it/ }).click();
    const table = main.getByRole('table', { name: 'Engine modes and whether they can run this package' });
    const off = table.getByRole('row').filter({ hasText: 'random-search' });
    await expect(off).toContainText('No');
    await expect(off).toContainText('This package has range features; this engine only accepts single values');
    await expect(table.getByRole('row').filter({ hasText: 'minizinc' })).toContainText('Yes');
    await expect(main.getByRole('button', { name: 'Solve' })).toHaveCount(0);
    await capture(page, testInfo, 'workbench-desktop-ranges');
    expect(critical).toEqual([]);
  });

  test('job-detail · a run the engine refused for ranges says so and leads to the engines', async ({ page }, testInfo) => {
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

    await page.goto(`${ROOT}/runs/job-range-failed`);
    const alert = main.getByRole('alert').filter({ hasText: 'This engine only accepts single values' });
    await expect(alert).toContainText(`featureValues interval is not declared by this mode (${pointer})`);
    await expect(alert).not.toContainText('Nothing was started.');
    await expect(alert.getByRole('link', { name: 'Engines' })).toHaveAttribute('href', '/engines');
    await expect(alert.getByRole('link', { name: /library|Edit the candidate/i })).toHaveCount(0);
    await capture(page, testInfo, 'job-detail-desktop-range-failure');
    expect(critical).toEqual([]);
  });
});
