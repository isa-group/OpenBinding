import { expect, test } from '@playwright/test';
import { CASE, PROJECT_PATH, capture, signInByApi, watchPageErrors } from './support';

test.describe('live · the problem simple-seq', () => {
  test('the owner opens it from the list of problems and sees its versions, with the controls an owner has', async ({ page }, testInfo) => {
    const errors = watchPageErrors(page);
    await signInByApi(page, 'owner');
    await page.goto(`${PROJECT_PATH}/problems`);

    const list = page.getByRole('list', { name: 'Problems' });
    await expect(list).toBeVisible();
    await expect(page.getByRole('button', { name: 'New problem' })).toBeVisible();
    await capture(page, testInfo, 'case-list-owner');

    await list.locator(`a[href="${PROJECT_PATH}/problems/${CASE}"]`).first().click();
    await expect(page).toHaveURL(new RegExp(`${PROJECT_PATH}/problems/${CASE}/?$`));
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    await expect(page.locator('code.case-slug')).toHaveText(CASE);
    await expect(page.getByRole('tab', { name: 'Versions' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'New version' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Run this version' })).toHaveAttribute('href', new RegExp(`/runs/new\\?case=${CASE}&revision=\\d+`));
    // The owner is not told the page is read-only.
    await expect(page.getByRole('note').filter({ hasText: 'need MEMBER' })).toHaveCount(0);
    await capture(page, testInfo, 'case-simple-seq-owner');
    expect(errors).toEqual([]);
  });

  test('a member opens the same problem and can start a version in the workbench', async ({ page }, testInfo) => {
    const errors = watchPageErrors(page);
    await signInByApi(page, 'member');
    await page.goto(`${PROJECT_PATH}/problems/${CASE}`);

    await expect(page.locator('code.case-slug')).toHaveText(CASE);
    await expect(page.getByRole('link', { name: 'New version' })).toHaveAttribute('href', `${PROJECT_PATH}/workbench?case=${CASE}`);
    // Deleting needs ADMIN: a member has no such control.
    await expect(page.getByRole('button', { name: 'Delete problem' })).toHaveCount(0);
    await capture(page, testInfo, 'case-simple-seq-member');
    expect(errors).toEqual([]);
  });
});
