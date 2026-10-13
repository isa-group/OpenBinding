import { expect, test } from '@playwright/test';
import { CASE, ORG, PROJECT_PATH, capture, signInByApi, watchPageErrors } from './support';

// A VIEWER reads: it sees the project, the cases and their revisions, and none of the controls that change something.

test.describe('live · lab-viewer reads and edits nothing', () => {
  test('the case list and the case have no editing control and say why', async ({ page }, testInfo) => {
    const errors = watchPageErrors(page);
    await signInByApi(page, 'viewer');
    await page.goto(`${PROJECT_PATH}/cases`);

    await expect(page.getByRole('list', { name: 'Cases' })).toBeVisible();
    const note = page.getByRole('note').filter({ hasText: 'creating and editing need MEMBER' });
    await expect(note).toBeVisible();
    await expect(note).toContainText('VIEWER');
    await expect(page.getByRole('button', { name: 'New case' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Delete / })).toHaveCount(0);
    await capture(page, testInfo, 'viewer-case-list');

    await page.goto(`${PROJECT_PATH}/cases/${CASE}`);
    await expect(page.locator('code.case-slug')).toHaveText(CASE);
    await expect(page.getByRole('heading', { level: 2, name: 'Revisions' })).toBeVisible();
    await expect(page.getByRole('note').filter({ hasText: 'New revisions need MEMBER; deleting needs ADMIN' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'New revision' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Delete case' })).toHaveCount(0);
    await capture(page, testInfo, 'viewer-case');
    expect(errors).toEqual([]);
  });

  test('starting a run is for members: the viewer is told so and has no way to send one', async ({ page }, testInfo) => {
    const errors = watchPageErrors(page);
    await signInByApi(page, 'viewer');
    await page.goto(`${PROJECT_PATH}/jobs/new?case=${CASE}`);

    await expect(page.getByRole('heading', { level: 1, name: 'New run' })).toBeVisible();
    await expect(page.getByText('starting a run needs MEMBER')).toBeVisible();
    await expect(page.getByText(/VIEWER/).first()).toBeVisible();
    // Whatever step is on screen, there is no enabled button that sends the run.
    await expect(page.locator('button:not([disabled])', { hasText: 'Send run' })).toHaveCount(0);
    await capture(page, testInfo, 'viewer-job-launch');
    expect(errors).toEqual([]);
  });

  test('studies cannot be created and the settings of the project and the organization are read-only', async ({ page }, testInfo) => {
    const errors = watchPageErrors(page);
    await signInByApi(page, 'viewer');

    await page.goto(`${PROJECT_PATH}/studies`);
    await expect(page.getByRole('heading', { level: 1, name: 'Studies' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'New study' })).toHaveCount(0);

    await page.goto(`${PROJECT_PATH}/settings`);
    await expect(page.getByText(/read-only/).first()).toBeVisible();
    await expect(page.getByLabel('Name', { exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Delete project' })).toHaveCount(0);
    await capture(page, testInfo, 'viewer-project-settings');

    await page.goto(`/app/${ORG}`);
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    await expect(page.getByRole('link', { name: 'New project' })).toHaveCount(0);
    await capture(page, testInfo, 'viewer-organization');
    expect(errors).toEqual([]);
  });
});
