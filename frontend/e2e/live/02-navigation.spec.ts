import { expect, test } from '@playwright/test';
import {
  CASE,
  ORG,
  ORG_PAGE,
  PROBLEM_PAGES,
  PROBLEMS_TAB,
  capture,
  signInByApi,
  watchPageErrors,
} from './support';

test.describe('live · the organization lab-main and its problems', () => {
  test('the owner goes from its organizations to lab-main and to its problems', async ({
    page,
  }, testInfo) => {
    const errors = watchPageErrors(page);
    await signInByApi(page, 'owner');
    await page.goto('/me/orgs');

    const organizations = page.locator('main');
    const main = organizations.locator(`a[href="/orgs/${ORG}"]`);
    await expect(main).toBeVisible();
    await expect(organizations.getByText('Owner', { exact: true }).first()).toBeVisible();
    await capture(page, testInfo, 'navigation-home');

    await main.click();
    await expect(page).toHaveURL(new RegExp(`${ORG_PAGE}/?$`));
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    await capture(page, testInfo, 'navigation-organization');

    // The Compositions and Problems tabs list the organization's compositions and problems as SPHERE's cards.
    await page.goto(`${ORG_PAGE}/compositions`);
    await expect(
      page.locator('main').getByRole('heading', { level: 2, name: 'Compositions' })
    ).toBeVisible();
    await expect(page.locator('main').getByRole('article').first()).toBeVisible();
    await page.goto(PROBLEMS_TAB);
    const tab = page.locator('main').getByRole('region', { name: 'Problems' });
    await expect(tab.getByRole('heading', { level: 2, name: 'Problems' })).toBeVisible();
    const problem = tab.locator(`a[href="${PROBLEM_PAGES}/${CASE}"]`).first();
    await expect(problem).toBeVisible();
    await capture(page, testInfo, 'navigation-problems');

    await problem.click();
    await expect(page).toHaveURL(new RegExp(`${PROBLEM_PAGES}/${CASE}$`));
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('a member sees the same organization with the role it has, and opens its list of problems', async ({
    page,
  }, testInfo) => {
    const errors = watchPageErrors(page);
    await signInByApi(page, 'member');
    await page.goto('/me/orgs');

    const main = page.locator(`main a[href="/orgs/${ORG}"]`);
    await expect(main).toBeVisible();
    await expect(page.locator('main').getByText('Member', { exact: true }).first()).toBeVisible();

    await page.goto(PROBLEMS_TAB);
    const tab = page.locator('main').getByRole('region', { name: 'Problems' });
    await expect(tab.getByRole('heading', { level: 2, name: 'Problems' })).toBeVisible();
    await expect(tab.locator(`a[href="${PROBLEM_PAGES}/${CASE}"]`).first()).toBeVisible();
    await capture(page, testInfo, 'navigation-cases-member');
    expect(errors).toEqual([]);
  });
});
