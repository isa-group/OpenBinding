import { expect, test } from '@playwright/test';
import { ORG, OTHER_ORG, PROJECT, PROJECT_PATH, capture, signInByApi, watchPageErrors } from './support';

// lab-outsider owns lab-other and has no role in lab-main: the interface must show nothing of lab-main and must not even say that it exists.

test.describe('live · lab-outsider has no access to lab-main', () => {
  test('Home lists only the organization of the outsider', async ({ page }, testInfo) => {
    const errors = watchPageErrors(page);
    await signInByApi(page, 'outsider');
    await page.goto('/app');

    const organizations = page.getByRole('list', { name: 'Organizations' });
    await expect(organizations.locator(`a[href="/app/${OTHER_ORG}"]`)).toBeVisible();
    await expect(organizations.locator(`a[href="/app/${ORG}"]`)).toHaveCount(0);
    await capture(page, testInfo, 'outsider-home');
    expect(errors).toEqual([]);
  });

  test('the organization and the project of lab-main are refused with the same neutral words, and the gateway answers 403 or 404', async ({ page }, testInfo) => {
    const errors = watchPageErrors(page);
    const statuses: number[] = [];
    page.on('response', (response) => {
      const path = new URL(response.url()).pathname;
      if (path.includes(`/v1/organizations/${ORG}`)) statuses.push(response.status());
    });
    await signInByApi(page, 'outsider');

    await page.goto(`/app/${ORG}`);
    await expect(page.getByRole('heading', { name: 'Organization not available' })).toBeVisible();
    await expect(page.getByText(/It doesn’t exist, or you’re not a member/)).toBeVisible();
    await capture(page, testInfo, 'outsider-organization');

    await page.goto(PROJECT_PATH);
    await expect(page.getByRole('heading', { name: 'Project not found' })).toBeVisible();
    await expect(page.getByText(/It doesn’t exist, or it’s private and you’re not a member of its organization\./)).toBeVisible();
    await capture(page, testInfo, 'outsider-project');

    // Nothing of the project is on screen, and what the gateway said to the interface is a refusal, never a success.
    await expect(page.getByText(PROJECT, { exact: true })).toHaveCount(0);
    expect(statuses.length, 'the interface should have asked the gateway about lab-main').toBeGreaterThan(0);
    for (const status of statuses) expect([403, 404], `a call about lab-main answered ${status}`).toContain(status);
    expect(errors).toEqual([]);
  });

  test('a case, the launch of a run and the studies of the project are as hidden as the project', async ({ page }) => {
    const errors = watchPageErrors(page);
    await signInByApi(page, 'outsider');

    for (const path of [`${PROJECT_PATH}/cases`, `${PROJECT_PATH}/cases/simple-seq`, `${PROJECT_PATH}/jobs/new`, `${PROJECT_PATH}/studies`]) {
      await page.goto(path);
      await expect(page.getByRole('heading', { name: 'Project not found' }), path).toBeVisible();
      await expect(page.getByRole('heading', { level: 1, name: 'Cases' }), path).toHaveCount(0);
    }
    expect(errors).toEqual([]);
  });
});
