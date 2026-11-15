import { expect, test } from '@playwright/test';
import { RUNS_SEGMENT, pathAndSearch } from './helpers';
import { choose, mockStudies, selectedTab, selectorOf, shownBy, tabGroup, tabLabels, trackGets } from './helpers-problems';

test.use({ viewport: { width: 1280, height: 800 } });

// Studies belong to the organization (F0b B7).
const STUDY = '/app/acme/studies/s1';
const TABS = ['Setup', 'Progress', 'Results'];

test('a study with runs opens Progress and the run selector shows the latest run r2', async ({ page }) => {
  await mockStudies(page);
  await page.goto(STUDY);
  const group = tabGroup(page, TABS);
  await expect.poll(() => tabLabels(group)).toEqual(TABS);
  await expect(selectedTab(group, 'Progress')).toBeVisible();
  const runs = selectorOf(page, /run/i);
  await expect(runs).toBeVisible();
  await expect.poll(() => shownBy(runs)).toContain('r2');
});

test('a study without runs opens Setup', async ({ page }) => {
  await mockStudies(page);
  await page.goto('/app/acme/studies/s0');
  const group = tabGroup(page, TABS);
  await expect.poll(() => tabLabels(group)).toEqual(TABS);
  await expect(selectedTab(group, 'Setup')).toBeVisible();
});

test('choosing r1 in the run selector sets ?run=r1 and shows the results of r1', async ({ page }) => {
  await mockStudies(page);
  const gets = trackGets(page);
  await page.goto(`${STUDY}/results`);
  const runs = selectorOf(page, /run/i);
  await expect(runs).toBeVisible();
  await choose(page, runs, 'r1');
  await expect.poll(() => pathAndSearch(page)).toBe(`${STUDY}/results?run=r1`);
  await expect.poll(() => gets.filter((path) => path.includes('/runs/r1/analytics')).length).toBeGreaterThan(0);
  const analytics = gets.filter((path) => path.endsWith('/analytics'));
  expect(analytics[analytics.length - 1]).toContain('/runs/r1/analytics');
});

test('a cell inside Results links Open run to the run it ran as', async ({ page }) => {
  await mockStudies(page);
  await page.goto(`${STUDY}/results?run=r1&cell=c7`);
  const open = page.getByRole('link', { name: 'Open run', exact: true }).first();
  await expect(open).toBeVisible();
  // Runs belong to the organization: the run of a cell opens under it.
  await expect(open).toHaveAttribute('href', `/app/acme/${RUNS_SEGMENT}/j9`);
});

test('the Progress tab shows the definition the selected run froze', async ({ page }) => {
  await mockStudies(page);
  await page.goto(`${STUDY}/progress?run=r1`);
  const frozen = page.getByRole('region', { name: 'Frozen definition' });
  await expect(frozen).toBeVisible();
  await expect(frozen.getByRole('listitem')).toHaveCount(1);
});

test('a study has no address below another segment of the organization', async ({ page }) => {
  await mockStudies(page);
  await page.goto('/app/acme/demo/studies/s1');
  await expect(page.getByRole('heading', { level: 1, name: 'Study one' })).toHaveCount(0);
});

test('an unknown study tab shows Page not found', async ({ page }) => {
  await mockStudies(page);
  await page.goto(`${STUDY}/runs`);
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
});
