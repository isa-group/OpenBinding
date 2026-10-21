import { expect, test } from '@playwright/test';
import { CASE, ORG, PROJECT_PATH, capture, signInByApi, watchPageErrors } from './support';

test.describe('live · organizations and the project lab-main/bim-demo', () => {
  test('the owner goes from Home to the organization lab-main and to its project bim-demo', async ({ page }, testInfo) => {
    const errors = watchPageErrors(page);
    await signInByApi(page, 'owner');
    await page.goto('/app');

    const organizations = page.getByRole('list', { name: 'Organizations' });
    await expect(organizations).toBeVisible();
    const main = organizations.locator(`a[href="/app/${ORG}"]`);
    await expect(main).toBeVisible();
    await expect(main).toContainText('OWNER');
    await capture(page, testInfo, 'navigation-home');

    await main.click();
    await expect(page).toHaveURL(new RegExp(`/app/${ORG}/?$`));
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    // The header carries project links too (a menu that may be closed): the card of the project is in the main area.
    const project = page.locator('#platform-main').locator(`a[href="${PROJECT_PATH}"]`).first();
    await expect(project).toBeVisible();
    await capture(page, testInfo, 'navigation-organization');

    await project.click();
    await expect(page).toHaveURL(new RegExp(`${PROJECT_PATH}/?$`));
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    const sections = page.getByRole('navigation', { name: 'Project sections' });
    await expect(sections).toBeVisible();
    await expect(sections.locator(`a[href="${PROJECT_PATH}/cases"]`)).toBeVisible();
    await capture(page, testInfo, 'navigation-project');
    expect(errors).toEqual([]);
  });

  test('a member sees the same organization with the role it has, and opens the list of cases of the project', async ({ page }, testInfo) => {
    const errors = watchPageErrors(page);
    await signInByApi(page, 'member');
    await page.goto('/app');

    const main = page.getByRole('list', { name: 'Organizations' }).locator(`a[href="/app/${ORG}"]`);
    await expect(main).toBeVisible();
    await expect(main).toContainText('MEMBER');

    await page.goto(`${PROJECT_PATH}/cases`);
    await expect(page.getByRole('heading', { level: 1, name: 'Cases' })).toBeVisible();
    await expect(page.getByRole('list', { name: 'Cases' }).locator(`a[href="${PROJECT_PATH}/cases/${CASE}"]`).first()).toBeVisible();
    await capture(page, testInfo, 'navigation-cases-member');
    expect(errors).toEqual([]);
  });
});
