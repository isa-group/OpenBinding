import { expect, test, type Page } from '@playwright/test';
import { API, ORG, ORG_PATH, RUNS_PATH, capture, signInByApi, watchPageErrors } from './support';

// J1 against the lab (the mocked twin is e2e/f2a-derive-seal-compare.spec.ts): the owner of lab-main uploads the template the seed
// uses (demo/01_simple_seq: task t1 has two eligible candidates, c1a and c1b), reads the problem's workflow and candidates, runs it
// on random-search, derives version 1.0.0 of a new composition from the run, binds t1 to its other candidate in the Editor's visual
// form (which stops citing the run: its solution is the other binding), seals 1.1.0 and compares the two versions entry by entry
// and line by line. Every run of this spec adds a problem and a
// composition to lab-main, named after the moment it ran; nothing is deleted (runs keep their problem).

const TEMPLATE = 'demo/01_simple_seq';
const PROBLEMS = `${ORG_PATH}/problems`;
/** The latency the gateway computes for each binding of t1 (t2 and t3 have one candidate each: 15 ms and 5 ms). */
const LATENCY_MS: Record<string, number> = { c1a: 30, c1b: 40 };

// A finished run: the 'Run result' region holding the chosen providers, or the explanation of why no combination works.
const finishedResult = (page: Page) =>
  page.getByRole('region', { name: 'Run result' }).filter({
    has: page
      .getByRole('region', { name: 'Chosen providers' })
      .or(page.getByRole('heading', { level: 2, name: 'Why no combination works' })),
  });

test.describe('live · J1 derive, seal and compare on lab-main', () => {
  test('a run of an uploaded problem becomes a composition, edited in the visual form, sealed again and compared', async ({
    page,
  }, testInfo) => {
    test.setTimeout(600_000);
    const errors = watchPageErrors(page);
    const token = await signInByApi(page, 'owner');
    const stamp = Date.now().toString(36);
    const name = `j1-${stamp}`;
    const compositionName = `J1 ${stamp}`;
    const slug = `j1-${stamp}`;
    const composition = `/compositions/${ORG}/${slug}`;
    const main = page.locator('main');

    // 1 · The problem: the template uploaded through the dialog, its workflow and the candidates of each task.
    const template = await page.request.get(`${API}/v1/bim/templates/${TEMPLATE}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(template.status(), `the template ${TEMPLATE} answered ${template.status()}`).toBe(200);
    await page.goto(PROBLEMS);
    await main.getByRole('button', { name: 'Upload BIM package' }).first().click();
    const upload = page.getByRole('dialog', { name: 'Upload a BIM package' });
    await upload.getByLabel('BIM package').setInputFiles({
      name: `${name}.bim.zip`,
      mimeType: 'application/vnd.bim+zip',
      buffer: await template.body(),
    });
    await expect(upload.getByLabel('Name')).toHaveValue(name);
    await upload.getByRole('button', { name: 'Upload problem' }).click();
    await expect(page).toHaveURL(new RegExp(`${PROBLEMS}/${name}$`), { timeout: 60_000 });
    await expect(main.getByRole('group', { name: 'Workflow' }).first()).toBeVisible({
      timeout: 60_000,
    });
    await main.getByRole('tab', { name: 'Candidates' }).click();
    const t1 = main
      .getByRole('region', { name: 'Candidates of each task' })
      .getByRole('region', { name: 'Candidates for t1' });
    await expect(t1).toContainText('c1a');
    await expect(t1).toContainText('c1b');
    await capture(page, testInfo, 'j1-1-problem');

    // 2 · A short random-search run of version 1, followed to its result.
    await page.goto(`${RUNS_PATH}/new?problem=${name}&revision=1`);
    await expect(main.getByRole('heading', { level: 1, name: 'New run' })).toBeVisible();
    await expect(
      main
        .getByRole('radiogroup', { name: 'Source' })
        .getByRole('radio', { name: new RegExp(`${name} · version 1`) })
    ).toBeChecked({ timeout: 30_000 });
    const next = main.getByRole('button', { name: 'Continue' });
    await next.click();
    const engines = main.getByRole('radiogroup', { name: 'Engine' });
    await expect(engines).toBeVisible({ timeout: 60_000 });
    await engines
      .getByRole('radio', { name: /^random-search/, disabled: false })
      .first()
      .check({ force: true });
    await next.click();
    const iterations = main.getByLabel('Iterations').first();
    if (await iterations.count()) await iterations.fill('50');
    await next.click();
    await expect(main.getByRole('heading', { name: 'Before you send' })).toBeVisible();
    const isLaunch = (response: { url(): string; request(): { method(): string } }) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname.endsWith('/v1/organizations/lab-main/runs');
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
    await capture(page, testInfo, 'j1-2-run');

    // 3 · Derive: a new composition (created when the preview is asked for), the run's first solution, the preview, the seal of 1.0.0.
    await main
      .getByRole('region', { name: 'Keep it as a composition' })
      .getByRole('button', { name: 'Derive composition' })
      .click();
    const dialog = page.getByRole('dialog', { name: 'Derive a composition' });
    await expect(dialog.getByRole('radio', { name: 'A new composition' })).toBeChecked();
    await dialog.getByLabel('Name').fill(compositionName);
    await expect(dialog.getByLabel('Address')).toHaveValue(slug);
    await dialog.getByLabel('Kind').selectOption('workflow');
    await dialog.getByRole('button', { name: 'Next' }).click();
    const solutions = dialog.getByRole('region', { name: 'Solutions of the run' });
    if (await solutions.count())
      await expect(solutions.getByRole('radio', { name: 'Solution 1' })).toBeChecked();
    await expect(dialog.getByLabel('Version label')).toHaveValue('1.0.0');
    await dialog.getByRole('button', { name: 'Preview' }).click();
    const derived = dialog.getByRole('region', { name: 'Derived composition.yaml' });
    await expect(derived).toContainText('candidate: c1', { timeout: 60_000 });
    await expect(derived).toContainText(`${name}@1`);
    await expect(dialog.getByRole('region', { name: 'Values' })).toContainText(
      'These values will be verified'
    );
    await capture(page, testInfo, 'j1-3-preview');
    await dialog.getByRole('button', { name: 'Seal 1.0.0' }).click();

    await expect(page).toHaveURL(`${composition}/versions?version=1.0.0`, { timeout: 60_000 });
    await expect(page.getByText('Version 1.0.0 sealed.')).toBeVisible();
    const table = main
      .getByRole('region', { name: `Versions of ${compositionName}` })
      .getByRole('table');
    await expect(table.getByRole('row', { name: /^1\.0\.0/ })).toContainText('Derived from run');

    // 4 · The Editor: the visual form binds t1 to the candidate the run did not choose and stops citing the run; the check states
    // that binding's values; the canonical form is taken and 1.1.0 is sealed.
    await main
      .getByRole('navigation', { name: 'Composition sections' })
      .getByRole('link', { name: 'Editor' })
      .click();
    await expect(page).toHaveURL(new RegExp(`${composition}/editor`));
    const source = main.getByRole('textbox', { name: 'composition.yaml source' });
    await expect(source).toContainText('candidate: c1');
    const visual = main.getByRole('region', { name: 'Visual editor' });
    await expect(visual.getByRole('radio', { name: 'c1a for t1' })).toBeVisible({
      timeout: 60_000,
    });
    const before = (await visual.getByRole('radio', { name: 'c1a for t1' }).isChecked())
      ? 'c1a'
      : 'c1b';
    const after = before === 'c1a' ? 'c1b' : 'c1a';
    await expect(visual.getByRole('radio', { name: `${before} for t1` })).toBeChecked();
    await visual.getByRole('radio', { name: `${after} for t1` }).click();
    await expect(source).toContainText(`candidate: ${after}`);
    await expect(
      visual.getByRole('status').filter({ hasText: 't1: The run is no longer cited' })
    ).toBeVisible();
    const onSeal = main.getByRole('region', { name: 'Values on seal' });
    await expect(onSeal).toContainText(`${LATENCY_MS[after]} ms`, { timeout: 60_000 });
    await expect(onSeal).toContainText('These values will be verified');
    const canonical = onSeal.getByRole('button', { name: 'Use the canonical form' });
    if (await canonical.isVisible()) await canonical.click();
    const label = main.getByLabel('Label');
    await label.fill('1.1.0');
    await label.press('Enter');
    await expect(source).toContainText('version: 1.1.0');
    await capture(page, testInfo, 'j1-4-editor');
    const seal = main.getByRole('button', { name: 'Seal version' });
    await expect(seal).toBeEnabled({ timeout: 60_000 });
    await seal.click();
    await expect(page).toHaveURL(`${composition}/versions?version=1.1.0`, { timeout: 60_000 });
    await expect(page.getByText('Version 1.1.0 sealed.')).toBeVisible();

    // 5 · Versions: 1.0.0 against 1.1.0, the binding row of t1 and the value row of latency, then line by line.
    await table
      .getByRole('row', { name: /^1\.1\.0/ })
      .getByRole('button', { name: 'Compare with previous' })
      .click();
    await expect(page).toHaveURL(
      `${composition}/versions?version=1.1.0&view=compare&from=1.0.0&to=1.1.0`
    );
    const binding = main.getByRole('region', { name: /^Binding/ });
    await expect(binding).toContainText('t1');
    await expect(binding).toContainText(before);
    await expect(binding).toContainText(after);
    const values = main.getByRole('region', { name: /^Values/ });
    await expect(values).toContainText('latency');
    await expect(values).toContainText(`${LATENCY_MS[before]} to ${LATENCY_MS[after]}`);
    await capture(page, testInfo, 'j1-5-compare');

    await main
      .getByRole('group', { name: 'Versions view' })
      .getByRole('button', { name: 'File' })
      .click();
    await expect(page).toHaveURL(
      `${composition}/versions?version=1.1.0&view=file&from=1.0.0&to=1.1.0`
    );
    const text = main.getByRole('region', { name: 'The text of 1.0.0 and 1.1.0' });
    await expect(text).toContainText(`candidate: ${before}`);
    await expect(text).toContainText(`candidate: ${after}`);
    await capture(page, testInfo, 'j1-5-file');
    expect(errors).toEqual([]);
  });
});
