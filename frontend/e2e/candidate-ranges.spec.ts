import { expect as baseExpect, test, type Page, type TestInfo } from '@playwright/test';
import { API, PUBLIC_ENGINES, installMockApi } from './helpers/mockApi';
import { failureBody } from './helpers/problems';
import { checkoutFacts, digestOf } from '../src/modules/problem/utils/fixtures';
import { REGISTRATION, detailOf } from '../src/test/fixtures/jobs';
import { unzipPackage } from '../src/utils/bimZip';

// Candidate ranges · ranges of candidate features, from the problems to the engines (the milestone once called F2 ranges).
// A feature of a candidate is a number or a range { min, max } whose ends are numbers or null (no limit). This walks it through the
// screens that read it (the Candidates and Versions tabs of a problem page) and decide on it
// (the engine step of a run, a run the engine refused, the problem editor's engines, a run that failed for ranges). The Source tab is covered by its unit tests. The API origin is the shared mock of the QA gallery with a few answers of
// its own on top. Unlike the other specs, the pictures are always taken (test-results/, ignored by git): they are the evidence of the ranges.

// The first screens are slow to open under load (the problem page reads the problem and then its compilation), so a wait is generous.
const expect = baseExpect.configure({ timeout: 20_000 });

const PROBLEMS = '/problems/isa-demo';

function watchCriticalErrors(page: Page) {
  const critical: string[] = [];
  page.on('pageerror', error => critical.push(`pageerror: ${error.message}`));
  page.on('console', message => {
    const text = message.text();
    if (
      message.type() === 'error' &&
      /The above error occurred|Minified React error|Maximum update depth|Uncaught/i.test(text)
    )
      critical.push(`console: ${text}`);
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
  await page.screenshot({
    path: testInfo.outputPath(`${name}.png`),
    fullPage: true,
    animations: 'disabled',
  });
  const width = page.viewportSize()?.width ?? 0;
  const overflow = await page.evaluate(
    expected => document.documentElement.scrollWidth - expected,
    width
  );
  expect(overflow, `${name} should not scroll sideways`).toBeLessThanOrEqual(1);
}

type Values = Record<string, number | { min: number | null; max: number | null }>;

/** The facts of a version's compilation, with some values edited: version 2 is version 1 one step later. */
function factsWith(pay: number, edit: (values: (id: string) => Values) => void) {
  const facts = checkoutFacts(pay);
  edit(id => facts.candidates.find(candidate => candidate.id === id)?.values as Values);
  return facts;
}

async function answerCompilations(page: Page) {
  const reply = (revision: number, pay: number, edit: Parameters<typeof factsWith>[1]) =>
    page.route(
      new RegExp(
        `/v1/organizations/isa-demo/problems/checkout-flow/revisions/${revision}/compilations/[^/]+/facts$`
      ),
      route => route.fulfill({ status: 200, json: factsWith(pay, edit) })
    );
  await reply(1, 5, () => undefined);
  // One step later: a number became an open range, a range moved, and an open range became a number.
  await reply(2, 8, values => {
    values('authenticate-1').latency = { min: null, max: 60 };
    values('authenticate-2').cost = { min: 0.02, max: 0.05 };
    values('authenticate-3').latency = 90;
  });
}

// The dev server compiles on demand, so the first screen of a run is slow. Each viewport walks its tests in order in one worker
// (a failure stops the walk), and the two viewports run side by side.
test.setTimeout(100_000);

const viewports = [
  {
    name: 'desktop',
    viewport: { width: 1440, height: 900 },
    isMobile: false,
    deviceScaleFactor: 1,
  },
  { name: 'mobile', viewport: { width: 390, height: 844 }, isMobile: true, deviceScaleFactor: 2 },
] as const;

for (const { name, viewport, isMobile, deviceScaleFactor } of viewports) {
  test.describe(`${name} · candidate ranges`, () => {
    test.describe.configure({ mode: 'serial' });
    test.use({ viewport, isMobile, deviceScaleFactor });

    test('problem-detail · bars for ranges on the Candidates tab and what changed between two versions on the Versions tab', async ({
      page,
    }, testInfo) => {
      const critical = watchCriticalErrors(page);
      await installMockApi(page, 'admin');
      await answerCompilations(page);
      const main = page.locator('main');

      await page.goto(`${PROBLEMS}/checkout-flow/candidates?version=2`);
      // The candidates of a task: a table on a desktop, a card per candidate on a phone.
      const providers = main.getByRole('region', { name: 'Candidates of each task' });
      const candidate = (written: string) =>
        isMobile
          ? providers
              .getByRole('list', { name: 'Candidates for authenticate' })
              .getByRole('listitem')
              .filter({ hasText: written })
          : providers
              .getByRole('table', { name: /Task authenticate/ })
              .getByRole('row', { name: new RegExp(written) });
      await expect(candidate('authenticate-1')).toContainText('≤ 60 ms');
      await expect(candidate('authenticate-2')).toContainText('0.02–0.05 EUR');
      await expect(candidate('authenticate-4')).toContainText('unbounded');
      await expect(candidate('authenticate-4')).toContainText('0.04 EUR');
      await expect(providers.getByText('≤ 60 ms')).toHaveAttribute('title', '(−∞, 60] ms');
      // A range is a stretch on the bar; an open end fades out towards the edge.
      const intervals = providers.locator('[data-cm-bar="interval"]');
      await expect(intervals).not.toHaveCount(0);
      await expect(intervals.locator('i[data-open="low"]')).not.toHaveCount(0);
      await expect(intervals.locator('i[data-open="both"]')).toHaveCount(1);
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
      await expect(row(/authenticate-3 · latency \(now a single value\)/)).toContainText(
        '≥ 100 ms'
      );
      await expect(row(/authenticate-3 · latency \(now a single value\)/)).toContainText('90 ms');
      await capture(page, testInfo, `compare-${name}`);
      expect(critical).toEqual([]);
    });

    test('run-launch · the engine that only takes single values is off, with its reason, and a refused run is explained', async ({
      page,
    }, testInfo) => {
      const critical = watchCriticalErrors(page);
      await installMockApi(page, 'admin');
      const REASON = 'This package has range features; this engine only accepts single values';
      const pointer = '/spec/candidates/providers/candidates/authenticate-3/features/latency';
      const refusal = [
        {
          code: 'unsupported_capability_value',
          message: 'featureValues interval is not declared by this mode',
          pointer,
        },
      ];

      await answerCompilations(page);
      await page.route(
        /\/v1\/organizations\/isa-demo\/problems\/checkout-flow\/revisions\/2\/compilation$/,
        route =>
          route.fulfill({
            status: 200,
            json: {
              id: 'compilation-2',
              revision_id: 'rev-checkout-2',
              compilation_digest: digestOf('9'),
              compiler_digest: digestOf('8'),
              ir_digest: digestOf('c'),
              binding_space: '125892',
              created_at: '2026-08-20T10:05:00Z',
              current: true,
              toolchain: {},
              resources: {},
              analysis: {
                tasks: 6,
                candidates: 24,
                constraints: 2,
                placement: false,
                bindingSpace: '125892',
              },
              compatible_modes: [
                {
                  engine: PUBLIC_ENGINES[0].ref,
                  registration: REGISTRATION,
                  mode: 'sampling',
                  compatible: false,
                  diagnostics: refusal,
                },
                {
                  engine: PUBLIC_ENGINES[2].ref,
                  registration: { ...REGISTRATION, name: 'minizinc-deployment' },
                  mode: 'cp',
                  compatible: true,
                },
              ],
            },
          })
      );
      // The engine that was left on is refused anyway at the gateway (as if its manifest said interval and the problem said otherwise).
      await page.route(/\/v1\/organizations\/isa-demo\/runs$/, route =>
        route.request().method() === 'POST'
          ? route.fulfill({
              status: 422,
              json: failureBody(
                422,
                'unsupported_capability_value',
                'featureValues interval is not declared by this mode',
                { diagnostics: refusal }
              ),
            })
          : route.fallback()
      );
      const main = page.locator('main');

      await page.goto('/runs/new?org=isa-demo&problem=checkout-flow&revision=2');
      await main.getByRole('button', { name: 'Continue' }).click();
      const engines = main.getByRole('radiogroup', { name: 'Engine' });
      const off = engines.getByRole('radio', { name: /^random-search/ });
      await expect(off).toBeDisabled();
      await expect(off).toHaveAccessibleName(new RegExp(REASON));
      await expect(engines.getByRole('radio', { name: /^minizinc/ })).toBeEnabled();
      await expect(engines.getByRole('radio', { name: /^minizinc/ })).toBeChecked();
      const notice = main
        .locator('.ui-notice')
        .filter({ hasText: 'This package has range features' });
      await expect(notice).toContainText(
        'The engines marked “Can’t run this” only accept single values.'
      );
      await expect(notice.getByRole('link', { name: 'Engines' })).toHaveAttribute(
        'href',
        '/engines'
      );
      await expect(notice.getByRole('link', { name: /library|edit the candidates/i })).toHaveCount(
        0
      );
      await capture(page, testInfo, `launch-engines-${name}`);

      // The mock engine declares a seed whose default is 0, which the form asks to be a positive number.
      await main.getByLabel('Seed', { exact: true }).fill('1');
      await main.getByRole('button', { name: 'Send run' }).click();
      const alert = main
        .getByRole('alert')
        .filter({ hasText: 'This engine only accepts single values' });
      await expect(alert).toContainText(
        `featureValues interval is not declared by this mode (${pointer})`
      );
      await expect(alert.getByRole('link', { name: 'Engines' })).toHaveAttribute(
        'href',
        '/engines'
      );
      await expect(alert.getByRole('link', { name: /library|Edit the candidate/i })).toHaveCount(0);
      await capture(page, testInfo, `launch-refused-${name}`);
      expect(critical).toEqual([]);
    });
  });
}

// The two places the other specs do not reach: the problem editor (a value edited into a range in its candidate matrix) and a run that
// failed for ranges.
test.describe('desktop · candidate ranges in the problem editor and in a failed run', () => {
  test.describe.configure({ mode: 'serial' });
  test.use({ viewport: viewports[0].viewport });

  test('problem editor · a candidate edited into an open range in the matrix turns the engines that only take single values off', async ({
    page,
  }, testInfo) => {
    const critical = watchCriticalErrors(page);
    await installMockApi(page, 'admin');
    const pointer = '/spec/candidates/service-a/features/latency';
    const refusal = [
      {
        code: 'unsupported_capability_value',
        message: 'featureValues interval is not declared by this mode',
        pointer,
      },
    ];
    const sent: unknown[] = [];
    await page.route(`${API}/v1/bim/validate**`, async route => {
      const body = route.request().postDataBuffer() ?? Buffer.alloc(0);
      const files = await unzipPackage(
        body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer
      );
      const latency = JSON.parse(files['candidates.json']).spec.candidates['service-a'].features
        .latency;
      sent.push(latency);
      const ranged = typeof latency === 'object';
      return route.fulfill({
        status: 200,
        json: {
          valid: true,
          instanceDigest: digestOf('a'),
          packageDigest: digestOf('b'),
          irDigest: digestOf('c'),
          fileDigests: {},
          resourceDigests: {},
          diagnostics: [],
          analysis: {
            tasks: 1,
            candidates: 1,
            constraints: 0,
            placement: false,
            bindingSpace: '1',
          },
          compatibleModes: [
            {
              engine: PUBLIC_ENGINES[0].ref,
              registration: REGISTRATION,
              mode: 'sampling',
              compatible: !ranged,
              ...(ranged ? { diagnostics: refusal } : {}),
            },
            {
              engine: PUBLIC_ENGINES[2].ref,
              registration: { ...REGISTRATION, name: 'minizinc-deployment' },
              mode: 'cp',
              compatible: true,
            },
          ],
          // The facts of the blank package, with the value the check read.
          facts: {
            binding_space: '1',
            candidates: [
              {
                id: 'service-a',
                key: 'catalog/service-a',
                resource: 'catalog',
                provider: null,
                values: { latency },
                origins: {
                  latency: {
                    kind: 'package',
                    resource: 'catalog',
                    path: 'candidates.json',
                    pointer,
                  },
                },
              },
            ],
            constraints: [],
            features: [{ id: 'latency', unit: 'ms', direction: 'min', required: true }],
            ir_digest: digestOf('c'),
            objectives: {
              criteria: [{ id: 'latency', feature: { resource: 'application', id: 'latency' } }],
              penalties: [],
            },
            tasks: [
              {
                id: 'hello',
                kind: 'service',
                eligible: [{ candidate: 'catalog/service-a', written: 'service-a' }],
              },
            ],
            workflow: { seq: ['hello'] },
          },
        },
      });
    });
    const main = page.locator('main');

    await page.goto('/problem-editor?org=isa-demo');
    await main.getByRole('tab', { name: 'Candidates' }).click();
    const row = main
      .getByRole('table', { name: /Task hello/ })
      .getByRole('row', { name: /service-a/ });
    await expect(row.getByRole('textbox', { name: 'latency for service-a' })).toHaveValue('10');
    // The value becomes a range (10–10), then its upper end is opened: the catalog writes { min: 10, max: null }.
    await row
      .getByRole('group', { name: 'latency for service-a: value or range' })
      .getByRole('button', { name: 'Range' })
      .click();
    await row.getByRole('checkbox', { name: 'latency for service-a: no upper limit' }).check();
    await expect(row.getByRole('textbox', { name: 'latency for service-a max' })).toHaveValue('+∞');

    // The live check sends the range, the matrix reads it back as checked, and the engines beside the panes say which modes are
    // off and why; the editor runs nothing itself (a saved version runs from its problem page).
    await expect
      .poll(() => sent.some(latency => JSON.stringify(latency) === '{"max":null,"min":10}'))
      .toBe(true);
    await expect(page.getByTestId('pe-check-status')).toHaveText('Valid package');
    await expect(row).not.toContainText('Pending check');
    const engines = main.getByRole('list', { name: 'Engine modes' });
    const off = engines.getByRole('listitem').filter({ hasText: 'random-search' });
    await expect(off).toContainText('Cannot run it');
    await expect(off).toContainText(
      'This package has range features; this engine only accepts single values'
    );
    await expect(engines.getByRole('listitem').filter({ hasText: 'minizinc' })).toContainText(
      'Can run it'
    );
    await expect(main.getByRole('button', { name: 'Solve' })).toHaveCount(0);
    await capture(page, testInfo, 'problem-editor-desktop-ranges');
    expect(critical).toEqual([]);
  });

  test('run-detail · a run the engine refused for ranges says so and leads to the engines', async ({
    page,
  }, testInfo) => {
    const critical = watchCriticalErrors(page);
    await installMockApi(page, 'admin');
    const pointer = '/spec/candidates/providers/candidates/authenticate-3/features/latency';
    await page.route(/\/v1\/organizations\/isa-demo\/runs\/job-range-failed$/, route =>
      route.fulfill({
        status: 200,
        json: detailOf('job-range-failed', 'failed', {
          result: {
            code: 'unsupported_capability_value',
            error:
              'unsupported_capability_value: featureValues interval is not declared by this mode',
            diagnostics: [
              {
                code: 'unsupported_capability_value',
                message: 'featureValues interval is not declared by this mode',
                pointer,
              },
            ],
          },
        }),
      })
    );
    const main = page.locator('main');

    await page.goto('/runs/isa-demo/job-range-failed');
    const alert = main
      .getByRole('alert')
      .filter({ hasText: 'This engine only accepts single values' });
    await expect(alert).toContainText(
      `featureValues interval is not declared by this mode (${pointer})`
    );
    await expect(alert).not.toContainText('Nothing was started.');
    await expect(alert.getByRole('link', { name: 'Engines' })).toHaveAttribute('href', '/engines');
    await expect(alert.getByRole('link', { name: /library|Edit the candidate/i })).toHaveCount(0);
    await capture(page, testInfo, 'run-detail-desktop-range-failure');
    expect(critical).toEqual([]);
  });
});
