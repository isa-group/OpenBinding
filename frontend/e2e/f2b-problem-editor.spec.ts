import { readFileSync } from 'node:fs';
import { expect as baseExpect, test, type Page, type Route } from '@playwright/test';
import { DEFAULT_FILES } from '../src/features/bim-editor/documents';
import { unzipPackage, zipStore } from '../src/utils/bimZip';
import { API, installMockApi } from './helpers/mockApi';

// J3 · the BIM problem editor (B12, completed by B13 on the candidate matrix): a template opens, already checked → Candidates: a
// candidate's value is edited in the matrix and waits for the check → the gateway's 422 locates the finding at that value's pointer →
// the cell, the Problems panel and the file's range show it → the value is fixed in the matrix → 200 → save as a new version of a
// problem → its page. A second case pauses the live check on a 429 for its Retry-After and resumes it; a third opens a composition
// version's choice on its problem in the editor, from the composition's Overview. There is no backend: e2e/helpers/mockApi.ts answers
// the API origin, and the template, the check and the save are this spec's own.

const expect = baseExpect.configure({ timeout: 15_000 });
test.setTimeout(90_000);

const EDITOR = '/app/isa-demo/problem-editor';
const TEMPLATE = 'demo/01_simple_seq';
const POINTER = '/spec/candidates/service-a/features/latency';
const main = (page: Page) => page.locator('#platform-main');
const core = (file: string) =>
  JSON.parse(
    readFileSync(new URL(`../src/test/fixtures/core/${file}`, import.meta.url), 'utf8')
  ) as Record<string, unknown>;

/** The gateway's answer for a valid package (the simple-seq template's analysis and engines). */
const VALID = core('simple-seq.validate.json');

/** The facts of the template (the blank package): its one task and candidate, with the latency the check read. */
function factsFor(latency: unknown) {
  return {
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
            pointer: POINTER,
          },
        },
      },
    ],
    constraints: [],
    features: [{ id: 'latency', unit: 'ms', direction: 'min', required: true }],
    ir_digest: `sha256-${'c'.repeat(64)}`,
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
  };
}

/** The gateway's refusal of a candidate value outside its feature's domain, in the shape of `refused.validate.json`. */
const REFUSED = {
  type: 'https://openbinding.dev/problems/invalid_instance',
  title: 'invalid_instance',
  status: 422,
  code: 'invalid_instance',
  detail: `invalid_instance: ${POINTER}: candidate feature value is above its declared domain`,
  diagnostics: [
    {
      code: 'feature_value_domain',
      message: 'candidate feature value is above its declared domain',
      resource: 'candidates.json',
      pointer: POINTER,
    },
  ],
};

/** The latency of the one candidate in the package a check sent. */
async function sentLatency(route: Route): Promise<unknown> {
  const body = route.request().postDataBuffer() ?? Buffer.alloc(0);
  const files = await unzipPackage(
    body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer
  );
  return JSON.parse(files['candidates.json']).spec.candidates['service-a'].features.latency;
}

/** The template, as the gateway serves it. */
async function serveTemplate(page: Page) {
  const archive = Buffer.from(zipStore(DEFAULT_FILES));
  await page.route(`${API}/v1/bim/templates/**`, route =>
    route.fulfill({ status: 200, contentType: 'application/vnd.bim+zip', body: archive })
  );
}

const checkStatus = (page: Page) => main(page).getByTestId('pe-check-status');

test.describe('J3 · the problem editor checks a package live, locates what the gateway refuses, and saves it as a version', () => {
  test.use({ viewport: { width: 1440, height: 1000 } });

  test('template → edit a value in the matrix → located 422 on the cell and in Files → fix → 200 → save as a version → the problem page', async ({
    page,
  }) => {
    await installMockApi(page, 'admin');
    await serveTemplate(page);
    const checked: Array<'valid' | 'refused'> = [];
    await page.route(`${API}/v1/bim/validate**`, async (route: Route) => {
      expect(new URL(route.request().url()).searchParams.get('include')).toBe('facts');
      const latency = await sentLatency(route);
      checked.push(latency === 900 ? 'refused' : 'valid');
      await route.fulfill(
        latency === 900
          ? { status: 422, contentType: 'application/problem+json', json: REFUSED }
          : { status: 200, json: { ...VALID, facts: factsFor(latency) } }
      );
    });

    // 1 · The template opens once the gateway accepts it.
    await page.goto(`${EDITOR}?template=${encodeURIComponent(TEMPLATE)}`);
    await expect(
      main(page).getByRole('heading', { level: 1, name: 'Problem editor' })
    ).toBeVisible();
    await expect(main(page).getByText(`Opened from template ${TEMPLATE}`)).toBeVisible();
    await expect(checkStatus(page)).toHaveText('Valid package');
    expect(checked).toEqual(['valid']);

    // 2 · Candidates: the value of a candidate goes out of its domain in the matrix. The edit is written to the catalog and waits for
    // the live check, which locates the gateway's finding on the cell, in the Problems panel and in the file.
    await main(page).getByRole('tab', { name: 'Candidates' }).click();
    const row = main(page)
      .getByRole('region', { name: 'Candidates of each task' })
      .getByRole('table', { name: /Task hello/ })
      .getByRole('row', { name: /service-a/ });
    const value = row.getByRole('textbox', { name: 'latency for service-a' });
    await expect(value).toHaveValue('10');
    await value.fill('900');
    await expect(row).toContainText('Pending check');
    await expect(checkStatus(page)).toHaveText('Not valid · 1 problem');
    const finding = row.getByRole('button', {
      name: 'candidate feature value is above its declared domain',
    });
    await expect(finding).toBeVisible();
    await expect(row).toContainText('Pending check');
    await expect(main(page).getByText('Stale: showing the last valid package.')).toBeVisible();
    const problems = main(page).getByRole('region', { name: 'Problems' });
    await expect(problems).toContainText('1 error');
    await expect(
      problems.getByRole('button', { name: /candidate feature value is above its declared domain/ })
    ).toContainText(POINTER);
    await expect(main(page).getByRole('button', { name: 'Save as version…' })).toBeDisabled();

    // The finding on the cell opens its file at the value's range.
    await finding.click();
    await expect(main(page).getByRole('tab', { name: 'Files' })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    await expect(main(page).getByRole('textbox', { name: 'candidates.json source' })).toBeVisible();
    await expect(main(page).locator('.cm-lintRange-error')).toHaveText('900');

    // 3 · Fixed in the matrix, the package passes again and the cell is checked.
    await main(page).getByRole('tab', { name: 'Candidates' }).click();
    await value.fill('20');
    await expect(checkStatus(page)).toHaveText('Valid package');
    await expect(row).not.toContainText('Pending check');
    await expect(row.getByRole('button', { name: /above its declared domain/ })).toHaveCount(0);
    await expect(problems).toContainText('No issues');
    expect(checked).toEqual(['valid', 'refused', 'valid']);

    // 4 · Saved as a new version of a problem of the organization, by the problem editor; its page opens from the notice. The
    // mocked problem holds versions 1 and 2, so the save answers version 2 as the one it made, and the page can read it.
    await page.route(
      /\/v1\/organizations\/isa-demo\/problems\/checkout-flow\/revisions\?/,
      route =>
        route.request().method() === 'POST'
          ? route.fulfill({
              status: 201,
              json: {
                problem: { id: 'case-checkout-flow', slug: 'checkout-flow', name: 'Checkout flow' },
                revision: { id: 'rev-2', revision: 2 },
                compilation: {},
                created: true,
              },
            })
          : route.fallback()
    );
    const saved = page.waitForRequest(
      request =>
        request.method() === 'POST' && /\/problems\/checkout-flow\/revisions/.test(request.url())
    );
    await main(page).getByRole('button', { name: 'Save as version…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Save the package' });
    await dialog
      .getByRole('combobox', { name: 'Save into problem' })
      .selectOption({ label: 'Checkout flow' });
    await dialog.getByRole('button', { name: 'Save as a new version of Checkout flow' }).click();
    expect(new URL((await saved).url()).searchParams.get('producer')).toBe(
      'openbinding-problem-editor'
    );
    await expect(
      main(page).getByText('Saved as version 2 of Checkout flow. Run it from its page.')
    ).toBeVisible();
    await main(page).getByRole('link', { name: 'Open the problem' }).click();
    await expect(page).toHaveURL(/\/app\/isa-demo\/problems\/checkout-flow\?version=2$/);
    await expect(
      main(page).getByRole('heading', { level: 1, name: 'Checkout flow' })
    ).toBeVisible();
  });

  test('a 429 pauses the live check for its Retry-After, and the check resumes on its own', async ({
    page,
  }) => {
    await installMockApi(page, 'admin');
    let calls = 0;
    await page.route(`${API}/v1/bim/validate**`, async (route: Route) => {
      calls += 1;
      if (calls === 1) {
        // Retry-After is only readable across origins when the gateway exposes it.
        await route.fulfill({
          status: 429,
          contentType: 'application/json',
          headers: { 'Retry-After': '2', 'Access-Control-Expose-Headers': 'Retry-After' },
          json: { detail: { code: 'rate_limited', error: 'Too many checks; try again shortly.' } },
        });
        return;
      }
      await route.fulfill({ status: 200, json: VALID });
    });

    await page.goto(EDITOR);
    await expect(main(page).getByText('A blank package')).toBeVisible();
    await expect(checkStatus(page)).toContainText('Checks paused, resuming in');
    await expect(main(page).getByRole('button', { name: 'Check now' })).toBeDisabled();
    await expect(checkStatus(page)).toHaveText('Valid package');
    expect(calls).toBe(2);
  });

  test('a composition version’s choice opens on its problem in the editor, highlighted in the workflow and the matrix', async ({
    page,
  }) => {
    await installMockApi(page, 'admin');
    // The linked problem version's package is checked into the facts the composition was evaluated on (core/fms.*).
    await page.route(`${API}/v1/bim/validate**`, route =>
      route.fulfill({ status: 200, json: core('fms.validate.json') })
    );

    await page.goto('/app/isa-demo/compositions/fleet-routing?version=1.0.0');
    await main(page).getByRole('link', { name: 'Open on its problem in the editor' }).click();
    await expect(page).toHaveURL(
      /\/app\/isa-demo\/problem-editor\?problem=checkout-flow&revision=2&composition=fleet-routing&compositionVersion=1\.0\.0$/
    );
    await expect(main(page).getByText('Loaded version 2 of checkout-flow')).toBeVisible();
    const note = main(page).getByRole('note').filter({ hasText: 'chose are selected' });
    await expect(note).toContainText(
      'The candidates Fleet routing 1.0.0 chose are selected, as it chose them on checkout-flow@2.'
    );
    await expect(note.getByRole('link', { name: 'Back to Fleet routing 1.0.0' })).toHaveAttribute(
      'href',
      '/app/isa-demo/compositions/fleet-routing?version=1.0.0'
    );
    await expect(checkStatus(page)).toHaveText('Valid package');

    await expect(main(page).getByRole('group', { name: 'Workflow of the package' })).toContainText(
      'cand_t1_aws'
    );
    await main(page).getByRole('tab', { name: 'Candidates' }).click();
    const chosen = main(page)
      .getByRole('table', { name: /Task T1/ })
      .locator('tr[aria-current="true"]');
    await expect(chosen).toHaveCount(1);
    await expect(chosen).toContainText('cand_t1_aws');
    await expect(chosen).toContainText('Selected');
  });
});
