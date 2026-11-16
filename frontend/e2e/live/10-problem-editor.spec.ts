import { expect, test } from '@playwright/test';
import { ORG_PATH, RUNS_PATH, capture, signInByApi, watchPageErrors } from './support';

// J3 against the lab (the mocked twin is e2e/f2b-problem-editor.spec.ts): the owner of lab-main opens a template in the problem
// editor, already checked by the gateway; in the candidate matrix it puts a candidate's latency outside the domain the package
// declares for it; the live check sends the package to the real compiler, whose finding is placed on that cell and at the value's
// range in candidates.json; the value is fixed in the matrix, the package passes again, and it is saved as a new problem whose page
// offers a run. Every run of this spec adds a problem to lab-main, named after the moment it ran; nothing is deleted.

/** A template whose latency has a declared domain (0 to 500 ms): 900 is refused by the compiler, 6 is not. */
const TEMPLATE = 'demo/16_json_complete';
const TASK = 'authenticate';
const CANDIDATE = 'auth-edge';
const POINTER = `/spec/candidates/${CANDIDATE}/features/latency`;
const FINDING = 'candidate feature value is above its declared domain';

test.describe('live · J3 the problem editor on lab-main', () => {
  // The matrix is a table per task at this width (cards below 640 px), and the panes sit beside the engines.
  test.use({ viewport: { width: 1440, height: 1000 } });

  test('a template, a value out of its domain in the matrix, the compiler’s finding on the cell and in the file, the fix, the save and a run', async ({
    page,
  }, testInfo) => {
    test.setTimeout(600_000);
    const errors = watchPageErrors(page);
    await signInByApi(page, 'owner');
    const stamp = Date.now().toString(36);
    const name = `j3-${stamp}`;
    const main = page.locator('main');
    const status = main.getByTestId('pe-check-status');

    // 1 · The template opens once the gateway has checked it.
    await page.goto(`${ORG_PATH}/problem-editor?template=${encodeURIComponent(TEMPLATE)}`);
    await expect(main.getByRole('heading', { level: 1, name: 'Problem editor' })).toBeVisible();
    await expect(main.getByText(`Opened from template ${TEMPLATE}`)).toBeVisible({
      timeout: 60_000,
    });
    await expect(status).toHaveText('Valid package', { timeout: 60_000 });
    await expect(main.getByRole('group', { name: 'Workflow of the package' })).toContainText(TASK);
    await capture(page, testInfo, 'j3-1-template');

    // 2 · Candidates: the latency goes out of its domain in the matrix. The edit is written to candidates.json and waits for the
    // live check; the real compiler refuses it, and its finding is placed on the cell and in the Problems panel.
    await main.getByRole('tab', { name: 'Candidates' }).click();
    const row = main
      .getByRole('region', { name: 'Candidates of each task' })
      .getByRole('table', { name: new RegExp(`Task ${TASK}`) })
      .getByRole('row', { name: new RegExp(CANDIDATE) });
    const value = row.getByRole('textbox', { name: `latency for ${CANDIDATE}` });
    await expect(value).toBeVisible();
    await value.fill('900');
    await expect(status).toHaveText(/^Not valid/, { timeout: 60_000 });
    const finding = row.getByRole('button', { name: FINDING });
    await expect(finding).toBeVisible();
    await expect(row).toContainText('Pending check');
    await expect(main.getByText('Stale: showing the last valid package.')).toBeVisible();
    const problems = main.getByRole('region', { name: 'Problems' });
    await expect(problems.getByRole('button', { name: new RegExp(FINDING) })).toContainText(
      POINTER
    );
    await expect(main.getByRole('button', { name: 'Save as version…' })).toBeDisabled();
    await capture(page, testInfo, 'j3-2-refused');

    // The finding on the cell opens candidates.json at the value's range.
    await finding.click();
    await expect(main.getByRole('tab', { name: 'Files' })).toHaveAttribute('aria-selected', 'true');
    await expect(main.getByRole('textbox', { name: 'candidates.json source' })).toBeVisible();
    await expect(main.locator('.cm-lintRange-error').first()).toHaveText('900');
    await capture(page, testInfo, 'j3-3-file');

    // 3 · Fixed in the matrix: the compiler accepts the package again and the cell is no longer pending.
    await main.getByRole('tab', { name: 'Candidates' }).click();
    await value.fill('6');
    await expect(status).toHaveText('Valid package', { timeout: 60_000 });
    await expect(row).not.toContainText('Pending check');
    await expect(row.getByRole('button', { name: FINDING })).toHaveCount(0);
    await expect(problems).not.toContainText(FINDING);

    // 4 · Saved as a new problem under a name of this run; its page offers a run of version 1, and the launcher opens on it.
    const save = main.getByRole('button', { name: 'Save as version…' });
    await expect(save).toBeEnabled({ timeout: 60_000 });
    await save.click();
    const dialog = page.getByRole('dialog', { name: 'Save the package' });
    await dialog.getByRole('textbox', { name: 'Name of the new problem' }).fill(name);
    await dialog.getByRole('button', { name: 'Save as a new problem' }).click();
    await expect(
      main.getByText(`Saved as version 1 of ${name}. Run it from its page.`)
    ).toBeVisible({ timeout: 60_000 });
    await capture(page, testInfo, 'j3-4-saved');
    await main.getByRole('link', { name: 'Open the problem' }).click();
    const run = main.getByRole('link', { name: 'Run this version' });
    await expect(run).toHaveAttribute('href', `${RUNS_PATH}/new?problem=${name}&revision=1`);
    await run.click();
    await expect(main.getByRole('heading', { level: 1, name: 'New run' })).toBeVisible();
    await expect(
      main
        .getByRole('radiogroup', { name: 'Source' })
        .getByRole('radio', { name: new RegExp(`${name} · version 1`) })
    ).toBeChecked({ timeout: 30_000 });
    await capture(page, testInfo, 'j3-5-launch');
    expect(errors).toEqual([]);
  });
});
