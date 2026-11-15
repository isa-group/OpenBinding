import { expect, test } from '@playwright/test';
import {
  PROBLEMS_FINAL, RUNS_FINAL, forbiddenText, mockGateway,
} from './helpers-vocabulary';

test.use({ viewport: { width: 1440, height: 900 } });

test('the screens are headed Problems and Runs and the Problems screen offers to upload a BIM package', async ({ page }) => {
  await mockGateway(page);
  await page.goto(PROBLEMS_FINAL);
  await expect(page.getByRole('heading', { name: 'Problems', exact: true }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Upload BIM package' }).first()).toBeVisible();
  await page.goto(RUNS_FINAL);
  await expect(page.getByRole('heading', { name: 'Runs', exact: true }).first()).toBeVisible();
});

const SIGNED_IN_SCREENS = [
  '/app', '/app/acme', '/app/acme/demo', PROBLEMS_FINAL, RUNS_FINAL,
  '/app/acme/demo/studies', '/app/account/usage',
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
