import { expect, test } from '@playwright/test';
import {
  API_PROBLEMS, API_RUNS, PROBLEMS_FINAL, RUNS_FINAL, SCOPED_SCREENS, SHOWCASE, mockGateway, mockScopedScreens,
} from './helpers-vocabulary';
import { COMPOSITIONS } from './helpers';

test.use({ viewport: { width: 1280, height: 800 } });

test('the Problems screen reads the problems of the organization and the Runs screen its runs', async ({ page }) => {
  const gateway = await mockGateway(page);
  await page.goto(PROBLEMS_FINAL);
  await expect.poll(() => gateway.gets).toContain(API_PROBLEMS);
  expect(new URL(page.url()).pathname).toBe(PROBLEMS_FINAL);
  gateway.gets.length = 0;
  await page.goto(RUNS_FINAL);
  await expect.poll(() => gateway.gets).toContain(API_RUNS);
  expect(new URL(page.url()).pathname).toBe(RUNS_FINAL);
});

// The addresses of the composition screens are `orgs/<org>/compositions` (an organization's list), `compositions` (the public list
// and each composition's card page), `editor` and `language`; none of their links holds a `deployments`, `scenarios` or `builds` segment.
const FORBIDDEN_SEGMENT = /\/(deployments|scenarios|builds)(?=$|[/?#])/;

test('the composition screens keep their addresses and read the compositions of their organization', async ({ page }) => {
  test.setTimeout(180_000);
  const gateway = await mockScopedScreens(page);
  await page.goto(COMPOSITIONS);
  await expect.poll(() => gateway.gets).toContain('/v1/organizations/acme/compositions');
  await page.goto(SHOWCASE);
  await expect.poll(() => gateway.gets).toContain('/v1/organizations/lab-other/compositions/fleet-routing');
  await page.goto('/compositions');
  await expect.poll(() => gateway.gets).toContain('/v1/compositions');

  const offenders: string[] = [];
  for (const { path, heading } of SCOPED_SCREENS) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1, name: heading }).first(), `${path} has loaded`).toBeVisible();
    expect(new URL(page.url()).pathname, `${path} stays where it is`).toBe(path);
    const hrefs = await page.locator('a[href]').evaluateAll((links) => links.map((link) => new URL((link as HTMLAnchorElement).href).pathname));
    offenders.push(...hrefs.filter((href) => FORBIDDEN_SEGMENT.test(href)).map((href) => `${path}: ${href}`));
  }
  expect(offenders).toEqual([]);
  expect(SCOPED_SCREENS.map(({ path }) => path.split('/')[1])).toEqual(expect.arrayContaining(['orgs', 'compositions', 'editor', 'language', 'app']));
});
