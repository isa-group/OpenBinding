import { expect, test } from '@playwright/test';
import { CASE, ORG, ORG_PATH, capture, signInByApi, watchPageErrors } from './support';

test.describe('live · the organization lab-main and its problems', () => {
  test('the owner goes from Home to the organization lab-main and to its problems', async ({ page }, testInfo) => {
    const errors = watchPageErrors(page);
    await signInByApi(page, 'owner');
    await page.goto('/app');

    const organizations = page.getByRole('list', { name: 'Organizations' });
    await expect(organizations).toBeVisible();
    const main = organizations.locator(`a[href="/app/${ORG}"]`);
    await expect(main).toBeVisible();
    await expect(main).toContainText('OWNER');
    // Home leads with the recent compositions of an organization, before its recent runs.
    await expect(page.getByRole('region', { name: 'Recent compositions' })).toBeVisible();
    await capture(page, testInfo, 'navigation-home');

    await main.click();
    await expect(page).toHaveURL(new RegExp(`/app/${ORG}/?$`));
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    // The header leads to the problems too: the panel's link is the one in the main area.
    const problems = page.locator('#platform-main').getByRole('link', { name: 'All problems' });
    await expect(problems).toHaveAttribute('href', `${ORG_PATH}/problems`);
    // The overview leads with the organization's compositions.
    await expect(page.locator('#platform-main').getByRole('heading', { name: /^Compositions/ })).toBeVisible();
    await expect(page.locator('#platform-main').getByRole('link', { name: 'All compositions', exact: true })).toHaveAttribute('href', `${ORG_PATH}/compositions`);
    await capture(page, testInfo, 'navigation-organization');

    await problems.click();
    await expect(page).toHaveURL(new RegExp(`${ORG_PATH}/problems/?$`));
    await expect(page.getByRole('heading', { level: 1, name: 'Problems' })).toBeVisible();
    await capture(page, testInfo, 'navigation-problems');
    expect(errors).toEqual([]);
  });

  test('a member sees the same organization with the role it has, and opens its list of problems', async ({ page }, testInfo) => {
    const errors = watchPageErrors(page);
    await signInByApi(page, 'member');
    await page.goto('/app');

    const main = page.getByRole('list', { name: 'Organizations' }).locator(`a[href="/app/${ORG}"]`);
    await expect(main).toBeVisible();
    await expect(main).toContainText('MEMBER');

    await page.goto(`${ORG_PATH}/problems`);
    await expect(page.getByRole('heading', { level: 1, name: 'Problems' })).toBeVisible();
    await expect(page.getByRole('list', { name: 'Problems' }).locator(`a[href="${ORG_PATH}/problems/${CASE}"]`).first()).toBeVisible();
    await capture(page, testInfo, 'navigation-cases-member');
    expect(errors).toEqual([]);
  });
});
