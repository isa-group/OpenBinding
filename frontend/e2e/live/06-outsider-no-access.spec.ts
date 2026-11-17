import { expect, test } from '@playwright/test';
import {
  API,
  CASE,
  ORG,
  OTHER_ORG,
  LAUNCH_PATH,
  RUN_PATH,
  RUNS_PATH,
  capture,
  signInByApi,
  watchPageErrors,
} from './support';

// lab-outsider owns lab-other and has no role in lab-main: the interface must show nothing of lab-main and must not even say that it exists.

test.describe('live · lab-outsider has no access to lab-main', () => {
  test('Home lists only the organization of the outsider', async ({ page }, testInfo) => {
    const errors = watchPageErrors(page);
    await signInByApi(page, 'outsider');
    await page.goto('/me/orgs');

    const organizations = page.locator('main');
    await expect(organizations.locator(`a[href="/orgs/${OTHER_ORG}"]`)).toBeVisible();
    await expect(organizations.locator(`a[href="/orgs/${ORG}"]`)).toHaveCount(0);
    await capture(page, testInfo, 'outsider-home');
    expect(errors).toEqual([]);
  });

  test('the organization lab-main and its settings are refused with the same neutral words, and the gateway answers 403 or 404', async ({
    page,
  }, testInfo) => {
    const errors = watchPageErrors(page);
    const statuses: number[] = [];
    page.on('response', response => {
      const path = new URL(response.url()).pathname;
      if (path.includes(`/v1/organizations/${ORG}`)) statuses.push(response.status());
    });
    const token = await signInByApi(page, 'outsider');

    // The organization page of an organization that publishes nothing is the same in-place 404 as a missing one, and so is
    // any of its tabs.
    await page.goto(`/orgs/${ORG}`);
    await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
    await capture(page, testInfo, 'outsider-organization');

    await page.goto(`/orgs/${ORG}/members`);
    await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
    await capture(page, testInfo, 'outsider-organization-settings');

    // Nothing of the organization is on screen. The interface resolves an organization from the account's own list, so it may not
    // ask the gateway about lab-main at all; whatever it asked was refused, and so is every question asked directly.
    await expect(page.getByText(CASE, { exact: true })).toHaveCount(0);
    for (const status of statuses)
      expect([403, 404], `a call of the interface about lab-main answered ${status}`).toContain(
        status
      );
    for (const path of [
      `/v1/organizations/${ORG}`,
      `/v1/organizations/${ORG}/members`,
      `/v1/organizations/${ORG}/problems`,
    ]) {
      const answer = await page.request.get(`${API}${path}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect([403, 404], `GET ${path} answered ${answer.status()}`).toContain(answer.status());
    }
    expect(errors).toEqual([]);
  });

  test('the problems, the runs, the launch of a run and the studies of lab-main are as hidden as lab-main', async ({
    page,
  }) => {
    const errors = watchPageErrors(page);
    await signInByApi(page, 'outsider');

    // A problem of the organization, and its Problems tab, are the page that does not exist.
    for (const path of [`/orgs/${ORG}/problems`, `/problems/${ORG}/${CASE}`]) {
      await page.goto(path);
      await expect(page.getByRole('heading', { name: 'Page not found' }), path).toBeVisible();
    }
    // The Runs tab of the organization and a run of it are the same in-place 404 as anything else unreadable.
    for (const path of [RUNS_PATH, `${RUN_PATH}/00000000-0000-4000-8000-000000000001`]) {
      await page.goto(path);
      await expect(page.getByRole('heading', { name: 'Page not found' }), path).toBeVisible();
      await expect(page.getByRole('list', { name: 'Runs of the organization' })).toHaveCount(0);
    }
    // The launcher offers only the organizations where the account may launch: lab-main is not one of them.
    await page.goto(LAUNCH_PATH);
    await expect(page.getByText(/Choose the organization the run belongs to/)).toBeVisible();
    await expect(page.getByRole('radiogroup', { name: 'Source' })).toHaveCount(0);
    // The studies are the organization's Studies tab and the study pages: an outsider gets the same in-place 404.
    for (const path of [`/orgs/${ORG}/studies`, `/studies/${ORG}/any-study`]) {
      await page.goto(path);
      await expect(page.getByRole('heading', { name: 'Page not found' }), path).toBeVisible();
    }
    expect(errors).toEqual([]);
  });
});
