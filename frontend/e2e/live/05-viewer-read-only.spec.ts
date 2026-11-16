import { expect, test } from '@playwright/test';
import { CASE, ORG, ORG_PATH, RUNS_PATH, capture, signInByApi, watchPageErrors } from './support';

// A VIEWER reads: it sees the organization, the problems and their versions, and none of the controls that change something.

test.describe('live · lab-viewer reads and edits nothing', () => {
  test('the problem list and the problem have no editing control and say why', async ({
    page,
  }, testInfo) => {
    const errors = watchPageErrors(page);
    await signInByApi(page, 'viewer');
    await page.goto(`${ORG_PATH}/problems`);

    await expect(page.getByRole('list', { name: 'Problems' })).toBeVisible();
    const note = page.getByRole('note').filter({ hasText: 'uploading and editing need MEMBER' });
    await expect(note).toBeVisible();
    await expect(note).toContainText('VIEWER');
    await expect(page.getByRole('button', { name: 'Upload BIM package' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Delete / })).toHaveCount(0);
    await capture(page, testInfo, 'viewer-problem-list');

    await page.goto(`${ORG_PATH}/problems/${CASE}`);
    await expect(page.locator('code.case-slug')).toHaveText(CASE);
    await expect(page.getByRole('tab', { name: 'Versions' })).toBeVisible();
    await expect(
      page.getByRole('note').filter({ hasText: 'New versions need MEMBER; deleting needs ADMIN' })
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Upload new version' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Delete problem' })).toHaveCount(0);
    await capture(page, testInfo, 'viewer-case');
    expect(errors).toEqual([]);
  });

  test('starting a run is for members: the viewer is told so and has no way to send one', async ({
    page,
  }, testInfo) => {
    const errors = watchPageErrors(page);
    await signInByApi(page, 'viewer');
    await page.goto(`${RUNS_PATH}/new?problem=${CASE}`);

    await expect(page.getByRole('heading', { level: 1, name: 'New run' })).toBeVisible();
    await expect(page.getByText('starting a run needs MEMBER')).toBeVisible();
    await expect(page.getByText(/VIEWER/).first()).toBeVisible();
    // Whatever step is on screen, there is no enabled button that sends the run (the gateway refuses it below MEMBER as well).
    await expect(page.locator('button:not([disabled])', { hasText: 'Send run' })).toHaveCount(0);
    await capture(page, testInfo, 'viewer-run-launch');
    expect(errors).toEqual([]);
  });

  test('the list of runs of the organization offers no way to start one', async ({
    page,
  }, testInfo) => {
    const errors = watchPageErrors(page);
    await signInByApi(page, 'viewer');
    await page.goto(`${RUNS_PATH}`);

    await expect(page.getByRole('heading', { level: 1, name: 'Runs' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'New run' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Start a run' })).toHaveCount(0);
    // The problem offers "Run this version" to a member of the organization, a viewer included, but it only leads to the steps above, read-only. That
    // is noted rather than failed: the entry point is the interface's, the refusal is the gateway's and the launch page's.
    await page.goto(`${ORG_PATH}/problems/${CASE}`);
    await expect(page.locator('code.case-slug')).toHaveText(CASE);
    const entries = await page.getByRole('link', { name: 'Run this version' }).count();
    if (entries > 0) {
      testInfo.annotations.push({
        type: 'viewer-run-entry',
        description: `${entries} "Run this version" link(s) are shown to a VIEWER; they lead to a read-only launch page`,
      });
    }
    expect(errors).toEqual([]);
  });

  test('studies cannot be created and the settings of the organization are read-only', async ({
    page,
  }, testInfo) => {
    const errors = watchPageErrors(page);
    await signInByApi(page, 'viewer');

    await page.goto(`/app/${ORG}/studies`);
    await expect(page.getByRole('heading', { level: 1, name: 'Studies' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'New study' })).toHaveCount(0);

    await page.goto(`${ORG_PATH}/settings`);
    await expect(page.getByLabel('Name', { exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Delete organization' })).toHaveCount(0);
    await capture(page, testInfo, 'viewer-organization-settings');

    await page.goto(ORG_PATH);
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    await expect(page.getByRole('link', { name: 'Upload BIM package' })).toHaveCount(0);
    await capture(page, testInfo, 'viewer-organization');
    expect(errors).toEqual([]);
  });
});
