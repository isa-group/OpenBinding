import { readFile, writeFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

// This suite deliberately uses persisted production sources and never mocks analysis responses.
test.skip(process.env.ANALYSIS_LIVE !== '1', 'Run the development seeder, then set ANALYSIS_LIVE=1');
test.describe.configure({ mode: 'serial' });
const liveExpect = expect.configure({ timeout: 30_000 });
let scenarios: Record<string, { analysisLink: string; reportLink: string; jobIds: string[] }>;
let token: string;
test.beforeAll(async ({ request }) => {
  scenarios = JSON.parse(await readFile('../openbinding-gateway/tools/analysis-manifest.json', 'utf8')).scenarios;
  const login = await request.post('http://localhost:8000/v1/auth/login', { data: { username_or_email: 'alice', password: 'devpass123' } });
  expect(login.ok(), await login.text()).toBeTruthy();
  token = (await login.json()).access_token;
});
test.beforeEach(async ({ page }) => {
  await page.addInitScript(value => localStorage.setItem('openbinding-access-token', value), token);
});

test('decision, budgets, Pareto, preferences, evidence and recorded reports', async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(scenarios['decision-rules'].analysisLink);
  await liveExpect(page.getByText('Unexplored space: unknown')).toBeVisible();
  await expect(page.getByText(/Balanced compromise · 2 co-winners/)).toBeVisible();
  const inspector = page.getByRole('complementary', { name: 'Binding inspector' });
  await expect(inspector.getByText('What contributes to this choice?')).toBeVisible();
  await page.locator('.analysis-next button').click();
  await expect(inspector.getByText('Shortlist comparison')).toBeVisible();
  await expect(inspector.getByText(/stored feasible bindings dominate/)).toBeVisible();
  await page.getByRole('button', { name: 'Budgets', exact: true }).click();
  await expect(page.getByText('Which budgets can these bindings meet?')).toBeVisible();
  await page.getByLabel('application:cost requirement', { exact: true }).fill('0');
  await page.getByLabel('application:latency requirement', { exact: true }).fill('0');
  await expect(page.getByRole('heading', { name: 'No stored binding meets these requirements' })).toBeVisible();
  await page.getByRole('button', { name: 'Reset priorities and requirements' }).click();
  await page.getByRole('button', { name: 'Pareto', exact: true }).click();
  await page.getByLabel('Voronoi proximity').check();
  await expect(page.getByText(/Selected cell area:/)).toBeVisible();
  await page.getByRole('button', { name: 'Preferences', exact: true }).click();
  await expect(page.getByText('What changes as this priority increases?')).toBeVisible();
  await page.getByRole('button', { name: 'Weighted-sum power map' }).click();
  await expect(page.getByText('Where does each binding win?')).toBeVisible();
  await expect(page.getByLabel('Recommendation rule')).toHaveValue('weighted');
  await page.getByRole('button', { name: 'Evidence', exact: true }).click();
  await expect(page.getByText('Source and normalization evidence')).toBeVisible();
  const receipt = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export receipt', exact: true }).click();
  expect((await receipt).suggestedFilename()).toBe('binding-decision.json');
  const csv = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export ranking CSV' }).click();
  expect((await csv).suggestedFilename()).toBe('binding-archive.csv');
  await page.goto(scenarios['decision-rules'].reportLink);
  await expect(page.getByText('Recorded binding decision', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Reopen decision workspace' }).click();
  await expect(page.getByText('Saved decision snapshot')).toBeVisible();
  await liveExpect(page.getByText('Unexplored space: unknown')).toBeVisible();
  await page.screenshot({ path: '/tmp/openbinding-decision-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
  await expect(inspector.getByText('What contributes to this choice?')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  await page.getByRole('button', { name: 'Budgets', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText('Which budgets can these bindings meet?')).toBeVisible();
  await page.screenshot({ path: '/tmp/openbinding-decision-mobile.png', fullPage: true });
  expect(errors).toEqual([]);
});

test('compatible pooled evidence and three-priority power geometry', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto(scenarios['compatible-pool'].analysisLink);
  await expect(page.getByText('54 stored occurrences')).toBeVisible();
  await page.goto(scenarios['power-slice'].analysisLink);
  await page.getByRole('button', { name: 'Preferences', exact: true }).click();
  await page.getByRole('button', { name: 'Weighted-sum power map' }).click();
  await expect(page.getByLabel('Third priority')).toBeVisible();
  await expect(page.getByText('Where does each binding win?')).toBeVisible();
  await expect(page.locator('.analysis-error')).toHaveCount(0);
});


test('save a project draft through the decision workspace', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto(scenarios['decision-rules'].analysisLink);
  await liveExpect(page.getByText('Unexplored space: unknown')).toBeVisible();
  await page.getByRole('button', { name: 'Save decision', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('combobox', { name: 'Organization', exact: true }).selectOption('score-ai');
  await dialog.getByRole('combobox', { name: 'Project', exact: true }).selectOption('qos-placement');
  const slug = `live-verification-${Date.now()}`;
  await dialog.getByLabel('Report slug').fill(slug);
  await dialog.getByRole('button', { name: 'Save draft' }).click();
  await liveExpect(page.getByText(/Decision saved as a project-visible draft:/)).toBeVisible();
  await page.goto(`/app/score-ai/qos-placement/reports/${slug}`);
  await liveExpect(page.getByText('Recorded binding decision', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Reopen decision workspace' }).click();
  await liveExpect(page.getByText('Unexplored space: unknown')).toBeVisible();
});

test('100,000 bindings render as a counted overview and paginate the complete archive', async ({ page }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const started = Date.now();
  await page.goto(scenarios['scale-100000'].analysisLink);
  await expect(page.getByText('Unexplored space: unknown')).toBeVisible({ timeout: 180_000 });
  const initialMs = Date.now()-started;
  await expect(page.locator('.analysis-pagination')).toContainText('1–50 of 100,000');
  const next = page.getByRole('button', { name: 'Next', exact: true });
  await liveExpect(next).toBeEnabled();
  const interaction = Date.now();
  await next.click();
  await expect(page.locator('.analysis-pagination')).toContainText('51–100 of 100,000', { timeout: 60_000 });
  const paginationMs = Date.now()-interaction;
  await expect(page.getByRole('complementary', { name: 'Binding inspector' }).getByText('What contributes to this choice?')).toBeVisible({ timeout: 60_000 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: '/tmp/openbinding-analysis-scale.png', fullPage: true });
  await writeFile('../openbinding-gateway/tools/analysis-browser-benchmark.json', JSON.stringify({ count: 100000, initialMs, paginationMs, viewport: page.viewportSize(), errors }, null, 2)+'\n');
  expect(errors).toEqual([]);
});

test('Jobs, Account, project Analytics, and Playground open the shared workspace', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto(`/app/score-ai/qos-placement/jobs/${scenarios['decision-rules'].jobIds[0]}`);
  await liveExpect(page.getByRole('link', { name: 'Open analysis', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Open analysis', exact: true }).click();
  await liveExpect(page.getByText('Unexplored space: unknown')).toBeVisible();
  await page.goto('/app/account?tab=history');
  await liveExpect(page.getByRole('button', { name: 'Solution', exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Solution', exact: true }).first().click();
  await liveExpect(page.getByRole('link', { name: 'Open analysis', exact: true })).toBeVisible();
  await page.goto('/app/score-ai/qos-placement/analytics');
  await liveExpect(page.getByRole('link', { name: 'Open analysis', exact: true })).toBeVisible();
  await page.goto('/playground');
  await liveExpect(page.getByRole('button', { name: 'Solve', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Solve', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Open analysis', exact: true })).toBeVisible({ timeout: 90_000 });
  await page.getByRole('link', { name: 'Open analysis', exact: true }).click();
  await liveExpect(page.getByText('Unexplored space: unknown')).toBeVisible();
});
