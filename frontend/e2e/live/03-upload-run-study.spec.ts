import { expect, test, type Page } from '@playwright/test';
import {
  API,
  CASE,
  ORG,
  PROBLEM_PAGES,
  PROBLEMS_TAB,
  LAUNCH_PATH,
  capture,
  signInByApi,
  watchPageErrors,
} from './support';

// The F0b walk against the lab (the mocked twin is e2e/f0b-walk.spec.ts): the owner of lab-main uploads the demo package as a new
// problem, edits it in the problem editor into version 2, starts another problem from a template, runs version 2 on random-search and
// follows it to its result, then runs a study of that version × 2 engine modes × 2 seeds. Every run of this spec adds two problems and
// one study to lab-main, named after the moment it ran; nothing is deleted (runs keep their problem).

const TEMPLATE = 'demo/01_simple_seq';

// A finished run: the 'Run result' region holding the chosen providers, or the explanation of why no combination works.
const finishedResult = (page: Page) =>
  page.getByRole('region', { name: 'Run result' }).filter({
    has: page
      .getByRole('region', { name: 'Chosen providers' })
      .or(page.getByRole('heading', { level: 2, name: 'Why no combination works' })),
  });

test.describe('live · upload, run and study on lab-main', () => {
  test('the owner uploads a package, saves an edit as version 2, starts from a template, runs version 2 and runs a study of it', async ({
    page,
  }, testInfo) => {
    test.setTimeout(600_000);
    const errors = watchPageErrors(page);
    const token = await signInByApi(page, 'owner');
    const stamp = Date.now().toString(36);
    const name = `walk-${stamp}`;
    const main = page.locator('main');

    // The package the gateway serves as the template, uploaded through the dialog as a file.
    const template = await page.request.get(`${API}/v1/bim/templates/${TEMPLATE}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(template.status(), `the template ${TEMPLATE} answered ${template.status()}`).toBe(200);
    const archive = await template.body();

    // 1 · The organization, its problems, and the upload.
    await page.goto(PROBLEMS_TAB);
    await expect(main.getByRole('heading', { level: 2, name: 'Problems' })).toBeVisible();
    await main.getByRole('button', { name: /^New/ }).click();
    await main.getByRole('menuitem', { name: /Upload BIM package/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Upload a BIM package' });
    await dialog.getByLabel('BIM package').setInputFiles({
      name: `${name}.bim.zip`,
      mimeType: 'application/vnd.bim+zip',
      buffer: archive,
    });
    await expect(dialog.getByLabel('Name')).toHaveValue(name);
    await capture(page, testInfo, 'walk-1-upload');
    await dialog.getByRole('button', { name: 'Upload problem' }).click();

    // 2 · Version 1 and its source.
    await expect(page).toHaveURL(new RegExp(`${PROBLEM_PAGES}/${name}$`), { timeout: 60_000 });
    await expect(page.getByText(`Problem “${name}” created with version 1.`)).toBeVisible();
    const sections = main.getByRole('navigation', { name: 'Problem sections' });
    await sections.getByRole('link', { name: 'Source' }).click();
    await expect(main.getByRole('list', { name: 'Files in the package' })).toContainText(
      'candidates.json'
    );
    await capture(page, testInfo, 'walk-2-source');

    // 3 · Edit in the problem editor: the live check passes the edit, and it is saved as version 2.
    await sections.getByRole('link', { name: 'Overview' }).click();
    await main.getByRole('button', { name: 'New version' }).click();
    await main.getByRole('menuitem', { name: /Problem editor/ }).click();
    await expect(main.getByText(`Loaded version 1 of ${name}`)).toBeVisible({ timeout: 60_000 });
    const status = main.getByTestId('pe-check-status');
    await expect(status).toHaveText('Valid package', { timeout: 60_000 });
    await main.getByRole('tab', { name: 'Forms' }).click();
    await main
      .getByRole('navigation', { name: 'BIM resources' })
      .getByRole('button', { name: /candidates\.json/ })
      .click();
    await main.getByLabel('c1b QoS latency').fill('12');
    await expect(status).toHaveText('Valid package', { timeout: 60_000 });
    const save = main.getByRole('button', { name: 'Save as version…' });
    await expect(save).toBeEnabled({ timeout: 60_000 });
    await save.click();
    const saveDialog = page.getByRole('dialog', { name: 'Save the package' });
    await saveDialog.getByRole('button', { name: `Save as a new version of ${name}` }).click();
    await expect(
      main.getByText(`Saved as version 2 of ${name}. Run it from its page.`)
    ).toBeVisible({ timeout: 60_000 });
    await capture(page, testInfo, 'walk-3-saved');
    await main.getByRole('link', { name: 'Open the problem' }).click();
    await expect(main.getByRole('combobox', { name: 'Version' })).toHaveValue('2');

    // 4 · A template, checked as it opens and saved as a new problem under a name of this run, offers a run.
    await page.goto(PROBLEMS_TAB);
    await main.getByRole('button', { name: /^New/ }).click();
    await main.getByRole('menuitem', { name: /Start from a template/ }).click();
    await expect(main.getByTestId('pe-check-status')).toHaveText('Valid package', {
      timeout: 60_000,
    });
    await main.getByRole('button', { name: 'Save as version…' }).click();
    await saveDialog
      .getByRole('textbox', { name: 'Name of the new problem' })
      .fill(`${name}-template`);
    await saveDialog.getByRole('button', { name: 'Save as a new problem' }).click();
    await expect(
      main.getByText(`Saved as version 1 of ${name}-template. Run it from its page.`)
    ).toBeVisible({ timeout: 60_000 });
    await main.getByRole('link', { name: 'Open the problem' }).click();
    await expect(main.getByRole('link', { name: 'Run this version' })).toHaveAttribute(
      'href',
      `${LAUNCH_PATH}&problem=${name}-template&revision=1`
    );

    // 5 · Run version 2 on random-search and follow it to its result.
    await page.goto(`${LAUNCH_PATH}&problem=${name}&revision=2`);
    await expect(main.getByRole('heading', { level: 1, name: 'New run' })).toBeVisible();
    await expect(
      main
        .getByRole('radiogroup', { name: 'Source' })
        .getByRole('radio', { name: new RegExp(`${name} · version 2`) })
    ).toBeChecked({ timeout: 30_000 });
    const next = main.getByRole('button', { name: 'Continue' });
    await next.click();
    const engines = main.getByRole('radiogroup', { name: 'Engine' });
    await expect(engines).toBeVisible({ timeout: 60_000 });
    await engines
      .getByRole('radio', { name: /^random-search/, disabled: false })
      .first()
      .check({ force: true });
    const iterations = main.getByLabel('Iterations').first();
    if (await iterations.count()) await iterations.fill('50');
    await expect(main.getByRole('heading', { name: 'Before you send' })).toBeVisible();
    const isLaunch = (response: { url(): string; request(): { method(): string } }) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname.endsWith(`/v1/organizations/${ORG}/runs`);
    const [launched] = await Promise.all([
      page.waitForResponse(isLaunch),
      main.getByRole('button', { name: 'Send run' }).click(),
    ]);
    expect(
      launched.status(),
      `createRun answered ${launched.status()}: ${await launched.text()}`
    ).toBe(202);
    await main.getByRole('link', { name: 'Follow the run' }).click();
    await expect(finishedResult(page)).toBeVisible({ timeout: 180_000 });
    await capture(page, testInfo, 'walk-5-run');

    // 6 · A study of version 2 × random-search and evolutionary-heuristics × seeds 1 and 2: four cells.
    await page.goto(`/studies/new?org=${ORG}`);
    await expect(main.getByRole('heading', { level: 1, name: 'New study' })).toBeVisible();
    await main
      .getByRole('group', { name: 'Problem versions' })
      .getByRole('checkbox', { name: new RegExp(`^${name} · version 2`) })
      .check();
    const modes = main.getByRole('group', { name: 'Engine modes' });
    await modes
      .getByRole('checkbox', { name: /^random-search/ })
      .first()
      .check();
    await modes
      .getByRole('checkbox', { name: /^evolutionary-heuristics.*mode elitist-genetic/ })
      .first()
      .check();
    await main.getByLabel('Study name').fill(`Walk ${stamp}`);
    await expect(main.getByLabel(/Seeds \(comma-separated/)).toHaveValue('1, 2');
    await main.getByRole('button', { name: 'Create study' }).click();
    await expect(main.getByRole('heading', { level: 1, name: `Walk ${stamp}` })).toBeVisible({
      timeout: 60_000,
    });
    await main.getByRole('button', { name: 'Run study' }).click();
    await expect(
      main
        .getByRole('region', { name: 'Frozen definition' })
        .getByRole('button', { name: 'Copy the digest of the frozen definition' })
    ).toBeVisible();
    await main.getByRole('link', { name: 'Follow run #1' }).click();
    const progress = main.getByRole('region', { name: 'Progress of the run' });
    await expect(progress.getByText('Finished · not live')).toBeVisible({ timeout: 300_000 });
    await expect(progress.getByRole('img', { name: '4 completed of 4 cells' })).toBeVisible();
    await capture(page, testInfo, 'walk-6-study');
    await main.getByRole('link', { name: 'Compare results' }).click();
    await expect(main.getByRole('heading', { name: 'Engine ranking' })).toBeVisible();
    await capture(page, testInfo, 'walk-6-results');
    expect(errors).toEqual([]);
  });

  test('a member opens the seeded problem simple-seq and can open it in the problem editor, but not delete it', async ({
    page,
  }, testInfo) => {
    const errors = watchPageErrors(page);
    await signInByApi(page, 'member');
    await page.goto(`${PROBLEM_PAGES}/${CASE}`);

    await expect(page.locator('main').getByRole('heading', { level: 1 })).toBeVisible();
    await page.getByRole('button', { name: 'New version', exact: true }).click();
    await expect(page.getByRole('menuitem', { name: /Problem editor/ })).toHaveAttribute(
      'href',
      new RegExp(`^/problem-editor\\?org=${ORG}&problem=${CASE}&revision=\\d+$`)
    );
    await expect(page.getByRole('link', { name: 'Run this version' })).toHaveAttribute(
      'href',
      new RegExp(`^/runs/new\\?org=${ORG}&problem=${CASE}&revision=\\d+$`)
    );
    // Deleting needs ADMIN: a member has no such control, in the Settings tab either.
    await page.keyboard.press('Escape');
    await page
      .getByRole('navigation', { name: 'Problem sections' })
      .getByRole('link', { name: 'Settings' })
      .click();
    await expect(page.getByRole('button', { name: 'Delete problem' })).toHaveCount(0);
    await capture(page, testInfo, 'case-simple-seq-member');
    expect(errors).toEqual([]);
  });
});
