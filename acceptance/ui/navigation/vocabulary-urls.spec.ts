import { expect, test } from '@playwright/test';
import { pathAndSearch } from './helpers';
import {
  API_CASES, API_JOBS, PROBLEMS_FINAL, RUNS_ALL_FINAL, RUNS_FINAL, mockGateway,
} from './helpers-vocabulary';

test.use({ viewport: { width: 1280, height: 800 } });

test('the Problems and Runs screens read the problems and runs from the unchanged API paths', async ({ page }) => {
  const gateway = await mockGateway(page);
  await page.goto(PROBLEMS_FINAL);
  await expect.poll(() => gateway.gets).toContain(API_CASES);
  expect(new URL(page.url()).pathname).toBe(PROBLEMS_FINAL);
  gateway.gets.length = 0;
  await page.goto(RUNS_FINAL);
  await expect.poll(() => gateway.gets).toContain(API_JOBS);
  expect(new URL(page.url()).pathname).toBe(RUNS_FINAL);
});

test('the old global runs address keeps its query and becomes /app/runs', async ({ page }) => {
  await mockGateway(page);
  await page.goto('/app/jobs?state=running');
  await expect.poll(() => pathAndSearch(page)).toBe(`${RUNS_ALL_FINAL}?state=running`);
});
