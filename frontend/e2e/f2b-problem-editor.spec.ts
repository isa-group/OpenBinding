import { readFileSync } from 'node:fs';
import { expect as baseExpect, test, type Page, type Route } from '@playwright/test';
import { DEFAULT_FILES } from '../src/features/bim-editor/documents';
import { zipStore } from '../src/utils/bimZip';
import { API, installMockApi } from './helpers/mockApi';

// J3 · the BIM problem editor, its first steps (B12; B13 completes it on the candidate matrix): a template opens, already checked
// → Files: a candidate's value is broken → the gateway's 422 locates the finding at that value's pointer → the Problems panel and
// the file's range show it → the value is fixed → 200 → save as a new version of a problem → its page. A second case pauses the
// live check on a 429 for its Retry-After and resumes it. There is no backend: e2e/helpers/mockApi.ts answers the API origin, and
// the template, the check and the save are this spec's own.

const expect = baseExpect.configure({ timeout: 15_000 });
test.setTimeout(90_000);

const EDITOR = '/app/isa-demo/problem-editor';
const TEMPLATE = 'demo/01_simple_seq';
const POINTER = '/spec/candidates/service-a/features/latency';
const main = (page: Page) => page.locator('#platform-main');

const GOOD = DEFAULT_FILES['candidates.json'];
const BROKEN = GOOD.replace('"latency": 10', '"latency": 900');

/** The gateway's answer for a valid package, with its facts (the simple-seq template's own). */
const VALID = JSON.parse(readFileSync(new URL('../src/test/fixtures/core/simple-seq.validate.json', import.meta.url), 'utf8')) as Record<string, unknown>;
/** The gateway's refusal of a candidate value outside its feature's domain, in the shape of `refused.validate.json`. */
const REFUSED = {
  type: 'https://openbinding.dev/problems/invalid_instance', title: 'invalid_instance', status: 422, code: 'invalid_instance',
  detail: `invalid_instance: ${POINTER}: candidate feature value is above its declared domain`,
  diagnostics: [{ code: 'feature_value_domain', message: 'candidate feature value is above its declared domain', resource: 'candidates.json', pointer: POINTER }],
};

/** The template, as the gateway serves it. */
async function serveTemplate(page: Page) {
  const archive = Buffer.from(zipStore(DEFAULT_FILES));
  await page.route(`${API}/v1/bim/templates/**`, (route) => route.fulfill({ status: 200, contentType: 'application/vnd.bim+zip', body: archive }));
}

/** Replace the text of the file open in the Files pane, as typing over all of it would. */
async function typeOver(page: Page, file: string, text: string) {
  const editor = main(page).getByRole('textbox', { name: `${file} source` });
  await editor.click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.insertText(text);
}

const checkStatus = (page: Page) => main(page).getByTestId('pe-check-status');

test.describe('J3 · the problem editor checks a package live, locates what the gateway refuses, and saves it as a version', () => {
  test.use({ viewport: { width: 1440, height: 1000 } });

  test('template → break a value in Files → located 422 → fix → 200 → save as a version → the problem page', async ({ page }) => {
    await installMockApi(page, 'admin');
    await serveTemplate(page);
    const checked: Array<'valid' | 'refused'> = [];
    await page.route(`${API}/v1/bim/validate**`, async (route: Route) => {
      expect(new URL(route.request().url()).searchParams.get('include')).toBe('facts');
      // The archive is stored, not compressed: the canonical JSON the editor sent is in its bytes.
      const broken = (route.request().postDataBuffer() ?? Buffer.alloc(0)).includes('"latency":900');
      checked.push(broken ? 'refused' : 'valid');
      await route.fulfill(broken ? { status: 422, contentType: 'application/problem+json', json: REFUSED } : { status: 200, json: VALID });
    });

    // 1 · The template opens once the gateway accepts it.
    await page.goto(`${EDITOR}?template=${encodeURIComponent(TEMPLATE)}`);
    await expect(main(page).getByRole('heading', { level: 1, name: 'Problem editor' })).toBeVisible();
    await expect(main(page).getByText(`Opened from template ${TEMPLATE}`)).toBeVisible();
    await expect(checkStatus(page)).toHaveText('Valid package');
    expect(checked).toEqual(['valid']);

    // 2 · Files: the value of a candidate goes out of its domain, and the live check locates the gateway's finding.
    await main(page).getByRole('tab', { name: 'Files' }).click();
    await main(page).getByRole('navigation', { name: 'Files of the package' }).getByRole('button', { name: /candidates\.json/ }).click();
    await typeOver(page, 'candidates.json', BROKEN);
    await expect(checkStatus(page)).toHaveText('Not valid · 1 problem');
    const problems = main(page).getByRole('region', { name: 'Problems' });
    await expect(problems).toContainText('1 error');
    await expect(problems).toContainText('candidates.json');
    await expect(problems.getByRole('button', { name: /candidate feature value is above its declared domain/ })).toContainText(POINTER);
    await expect(main(page).locator('.cm-lintRange-error')).toHaveText('900');
    await expect(main(page).getByRole('button', { name: 'Save as version…' })).toBeDisabled();

    // The finding opens its file at its range, from any pane.
    await main(page).getByRole('tab', { name: 'Workflow' }).click();
    await expect(main(page).getByText('Stale: showing the last valid package.')).toBeVisible();
    await problems.getByRole('button', { name: /candidate feature value is above its declared domain/ }).click();
    await expect(main(page).getByRole('tab', { name: 'Files' })).toHaveAttribute('aria-selected', 'true');
    await expect(main(page).getByRole('textbox', { name: 'candidates.json source' })).toBeVisible();
    await expect(main(page).locator('.cm-lintRange-error')).toHaveText('900');

    // 3 · Fixed, the package passes again.
    await typeOver(page, 'candidates.json', GOOD);
    await expect(checkStatus(page)).toHaveText('Valid package');
    await expect(problems).toContainText('No issues');
    expect(checked).toEqual(['valid', 'refused', 'valid']);

    // 4 · Saved as a new version of a problem of the organization, by the problem editor; its page opens from the notice. The
    // mocked problem holds versions 1 and 2, so the save answers version 2 as the one it made, and the page can read it.
    await page.route(/\/v1\/organizations\/isa-demo\/problems\/checkout-flow\/revisions\?/, (route) => (route.request().method() === 'POST'
      ? route.fulfill({ status: 201, json: { problem: { id: 'case-checkout-flow', slug: 'checkout-flow', name: 'Checkout flow' }, revision: { id: 'rev-2', revision: 2 }, compilation: {}, created: true } })
      : route.fallback()));
    const saved = page.waitForRequest((request) => request.method() === 'POST' && /\/problems\/checkout-flow\/revisions/.test(request.url()));
    await main(page).getByRole('button', { name: 'Save as version…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Save the package' });
    await dialog.getByRole('combobox', { name: 'Save into problem' }).selectOption({ label: 'Checkout flow' });
    await dialog.getByRole('button', { name: 'Save as a new version of Checkout flow' }).click();
    expect(new URL((await saved).url()).searchParams.get('producer')).toBe('openbinding-problem-editor');
    await expect(main(page).getByText('Saved as version 2 of Checkout flow. Run it from its page.')).toBeVisible();
    await main(page).getByRole('link', { name: 'Open the problem' }).click();
    await expect(page).toHaveURL(/\/app\/isa-demo\/problems\/checkout-flow\?version=2$/);
    await expect(main(page).getByRole('heading', { level: 1, name: 'Checkout flow' })).toBeVisible();
  });

  test('a 429 pauses the live check for its Retry-After, and the check resumes on its own', async ({ page }) => {
    await installMockApi(page, 'admin');
    let calls = 0;
    await page.route(`${API}/v1/bim/validate**`, async (route: Route) => {
      calls += 1;
      if (calls === 1) {
        // Retry-After is only readable across origins when the gateway exposes it.
        await route.fulfill({
          status: 429, contentType: 'application/json', headers: { 'Retry-After': '2', 'Access-Control-Expose-Headers': 'Retry-After' },
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
});
