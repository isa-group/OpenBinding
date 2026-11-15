import { expect, test } from '@playwright/test';
import {
  API_JOBS, API_PROBLEMS, PROBLEMS_FINAL, RUNS_FINAL, mockGateway,
} from './helpers-vocabulary';

test.use({ viewport: { width: 1280, height: 800 } });

test('the Problems screen reads the problems of the organization and the Runs screen the runs of the project', async ({ page }) => {
  const gateway = await mockGateway(page);
  await page.goto(PROBLEMS_FINAL);
  await expect.poll(() => gateway.gets).toContain(API_PROBLEMS);
  expect(new URL(page.url()).pathname).toBe(PROBLEMS_FINAL);
  gateway.gets.length = 0;
  await page.goto(RUNS_FINAL);
  await expect.poll(() => gateway.gets).toContain(API_JOBS);
  expect(new URL(page.url()).pathname).toBe(RUNS_FINAL);
});
