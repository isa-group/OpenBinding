import { expect, test } from '@playwright/test';
import { CASE, PROJECT_PATH, capture, signInByApi, watchPageErrors } from './support';

// This spec starts one real job (random-search, a few iterations) as the owner of lab-main and waits for its result: the engine runs in
// the lab's worker. The lab has no SPACE contract for its users by default (see docs/qa/E2E_PLAN.md); when the gateway cannot read the
// plan it answers 503 `pricing_unavailable`, the run is not accepted, and this spec fails at "Send run" with that refusal on screen.

const RESULT = /Best combination found|Solution \d+ of \d+|Why no combination works/;

test.describe('live · a random-search job and its result', () => {
  test('the owner launches random-search on simple-seq, follows the run and reads the result', async ({ page }, testInfo) => {
    test.setTimeout(240_000);
    const errors = watchPageErrors(page);
    await signInByApi(page, 'owner');
    await page.goto(`${PROJECT_PATH}/jobs/new?case=${CASE}`);

    // 1 · what to solve: the case, at its latest revision.
    await expect(page.getByRole('heading', { level: 1, name: 'New run' })).toBeVisible();
    await expect(page.getByRole('radiogroup', { name: 'Source' })).toBeVisible({ timeout: 30_000 });
    await capture(page, testInfo, 'job-launch-1-source');
    await page.getByRole('button', { name: 'Continue' }).click();

    // 2 · the engine: random-search, from the modes the gateway says can run the problem.
    const engines = page.getByRole('radiogroup', { name: 'Engine' });
    // The gateway analyses the snapshot before the modes are offered.
    await expect(engines).toBeVisible({ timeout: 60_000 });
    const randomSearch = engines.getByRole('radio', { name: /^random-search/ }).first();
    await expect(randomSearch).toBeEnabled();
    await randomSearch.check({ force: true });
    await capture(page, testInfo, 'job-launch-2-engine');
    await page.getByRole('button', { name: 'Continue' }).click();

    // 3 · the settings: a handful of iterations keeps the run short.
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
    const iterations = page.getByLabel('Iterations').first();
    if (await iterations.count()) await iterations.fill('50');
    await capture(page, testInfo, 'job-launch-3-settings');
    await page.getByRole('button', { name: 'Continue' }).click();

    // 4 · review and send. The request carries the optimization the gateway requires; nothing here is metered.
    await expect(page.getByRole('heading', { name: 'Before you send' })).toBeVisible();
    await expect(page.getByText(/used \+ up to|study runs this month/)).toHaveCount(0);
    await capture(page, testInfo, 'job-launch-4-review');
    const accepted = page.waitForResponse((response) => response.url().endsWith('/v1/jobs') && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Send run' }).click();
    const response = await accepted;
    expect(response.status(), `POST /v1/jobs answered ${response.status()}: ${await response.text()}`).toBe(202);
    const sent = response.request().postDataJSON() as Record<string, unknown>;
    expect(sent.optimization, 'the launch must carry the execution optimization').toMatchObject({ type: expect.stringMatching(/^(SINGLE|MULTI|MANY)$/), scalarization: expect.any(String) });

    await expect(page.getByRole('heading', { level: 1, name: /^Run accepted/ })).toBeVisible();
    await page.getByRole('link', { name: 'Follow the run' }).click();

    // The run page: it moves from queued to completed and shows what the engine found.
    await expect(page).toHaveURL(new RegExp(`${PROJECT_PATH}/jobs/[0-9a-f-]+$`));
    await expect(page.getByRole('heading', { level: 1, name: /random-search run/ })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: RESULT })).toBeVisible({ timeout: 180_000 });
    await expect(page.getByRole('link', { name: 'Analyze', exact: true }).first()).toBeVisible();
    await capture(page, testInfo, 'job-result');
    expect(errors).toEqual([]);
  });
});
