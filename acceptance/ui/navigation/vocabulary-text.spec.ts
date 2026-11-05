import { expect, test } from '@playwright/test';
import {
  PROBLEMS_FINAL, RUNS_ALL_FINAL, RUNS_FINAL, VERIFY_DIGEST, forbiddenText, kindOptionText, mockGateway,
} from './helpers-vocabulary';

test.use({ viewport: { width: 1440, height: 900 } });

test('the project screens are headed Problems and Runs and the Problems tab offers New problem', async ({ page }) => {
  await mockGateway(page);
  await page.goto(PROBLEMS_FINAL);
  await expect(page.getByRole('heading', { name: 'Problems', exact: true }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'New problem' }).or(page.getByRole('link', { name: 'New problem' })).first()).toBeVisible();
  await page.goto(RUNS_FINAL);
  await expect(page.getByRole('heading', { name: 'Runs', exact: true }).first()).toBeVisible();
});

test('the Verify kind selector reads Problem version for the kind case-revision', async ({ page }) => {
  await mockGateway(page, { role: null });
  await page.goto(`/verify?digest=${VERIFY_DIGEST}`);
  expect(await kindOptionText(page, 'case-revision')).toBe('Problem version');
});

const SIGNED_IN_SCREENS = [
  '/app', '/app/acme', '/app/acme/demo', PROBLEMS_FINAL, RUNS_FINAL, RUNS_ALL_FINAL,
  '/app/acme/demo/collections', '/app/acme/demo/studies', '/app/acme/demo/published', '/app/account/usage',
];

test('no signed-in screen shows the words case or job outside code, SourceView and LogPanel', async ({ page }) => {
  test.setTimeout(120_000);
  await mockGateway(page);
  const offenders: string[] = [];
  for (const screen of SIGNED_IN_SCREENS) {
    await page.goto(screen);
    await expect(page.getByRole('banner')).toBeVisible();
    await expect(page.getByRole('main')).toBeVisible();
    await page.waitForLoadState('networkidle');
    // A screen that is not routed shows the not-found page, which would pass the scan for the wrong reason.
    await expect(page.getByRole('heading', { name: 'Page not found' }), `${screen} is a routed screen`).toHaveCount(0);
    offenders.push(...await forbiddenText(page, screen));
  }
  expect(offenders).toEqual([]);
});
