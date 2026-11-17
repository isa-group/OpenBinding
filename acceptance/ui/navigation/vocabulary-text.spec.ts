import { expect, test } from '@playwright/test';
import {
  COMPOSITION_WORDS, PLAN_WITH_PROPOSAL, PROBLEMS_FINAL, RUNS_FINAL, SCOPED_SCREENS, forbiddenText, mockGateway, mockScopedScreens,
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
  '/', '/orgs/acme', '/orgs/acme/members', PROBLEMS_FINAL, RUNS_FINAL,
  '/app/acme/studies', '/me/settings?section=plan',
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

// The words of the composition and problem vocabulary apply on the composition and problem screens only (D23). Elsewhere they name
// other things and stay: the engines area and engine registration name engine deployments, run launch and run facts name the
// deployment a federated run is sent to, studies are built ("Build a study"), and Login, Pricing and the public workbench name this
// installation. So the engines, registration, runs and studies screens are not read here.
test('no composition or problem screen shows deployment, scenario, build, project or another name of the language', async ({ page }) => {
  test.setTimeout(180_000);
  await mockScopedScreens(page);
  const offenders: string[] = [];
  for (const { path, heading } of SCOPED_SCREENS) {
    await page.goto(path);
    const main = page.getByRole('main');
    await expect(main.getByRole('heading', { level: 1, name: heading }).first(), `${path} has loaded`).toBeVisible();
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('heading', { name: 'Page not found' }), `${path} is a routed screen`).toHaveCount(0);
    offenders.push(...await forbiddenText(page, path, COMPOSITION_WORDS, 'main'));
    offenders.push(...await forbiddenText(page, path, PLAN_WITH_PROPOSAL, 'main'));
    offenders.push(...await forbiddenText(page, path));
  }
  expect(offenders).toEqual([]);
});
