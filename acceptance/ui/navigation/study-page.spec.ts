import { expect, test } from '@playwright/test';
import { RUNS_SEGMENT, pathAndSearch } from './helpers';
import { choose, mockStudies, selectedTab, selectorOf, shownBy, tabGroup, tabLabels, trackGets } from './helpers-problems';

test.use({ viewport: { width: 1280, height: 800 } });

const STUDY = '/app/acme/demo/studies/s1';
const TABS = ['Setup', 'Progress', 'Results', 'Publish'];

// [utest->req~frontend-nav-study-page~1]
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

// [utest->req~frontend-nav-study-page~1]
test('a study without runs opens Setup', async ({ page }) => {
  await mockStudies(page);
  await page.goto('/app/acme/demo/studies/s0');
  const group = tabGroup(page, TABS);
  await expect.poll(() => tabLabels(group)).toEqual(TABS);
  await expect(selectedTab(group, 'Setup')).toBeVisible();
});

// [utest->req~frontend-nav-study-page~1]
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

// [utest->req~frontend-nav-study-page~1]
test('the three old study run addresses redirect into the study page', async ({ page }) => {
  test.slow(); // three full page loads in one test
  await mockStudies(page);
  const cases: Array<[string, string]> = [
    [`${STUDY}/runs/r1`, `${STUDY}/progress?run=r1`],
    [`${STUDY}/runs/r1/analytics`, `${STUDY}/results?run=r1`],
    [`${STUDY}/runs/r1/cells/c7`, `${STUDY}/results?run=r1&cell=c7`],
  ];
  for (const [old, target] of cases) {
    await page.goto(old);
    await expect.poll(() => pathAndSearch(page), old).toBe(target);
  }
});

// [utest->req~frontend-nav-study-page~1]
test('a cell inside Results links Open run to the run it ran as', async ({ page }) => {
  await mockStudies(page);
  await page.goto(`${STUDY}/results?run=r1&cell=c7`);
  const open = page.getByRole('link', { name: 'Open run', exact: true }).first();
  await expect(open).toBeVisible();
  await expect(open).toHaveAttribute('href', `/app/acme/demo/${RUNS_SEGMENT}/j9`);
});

// [utest->req~frontend-nav-study-page~1]
test('an unknown study tab shows Page not found', async ({ page }) => {
  await mockStudies(page);
  await page.goto(`${STUDY}/runs`);
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
});
