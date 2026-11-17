import { readFileSync, readdirSync } from 'node:fs';
import JSZip from 'jszip';
import { expect as baseExpect, test, type Page } from '@playwright/test';
import { zipStore } from '../src/utils/bimZip';
import { WALK_ORG, installWalkApi } from './helpers/mockApi';

// The F0b walk, through the interface: sign in, upload a BIM package as a problem of the organization, read its version and its
// source, edit it in the problem editor and save the edit as version 2, start a second problem from a template, run version 2 and follow
// the run until it completes, then build a study of that version × 2 engine modes × 2 seeds, run it and read its results.
// The gateway is `installWalkApi` (helpers/mockApi.ts): stateful, and any request it does not know fails the walk at the end.
// The live twin of this walk, against the lab, is e2e/live/03-upload-run-study.spec.ts; the API-level one is
// openbinding-gateway/tests/test_f0b_walk.py.

// Several browsers share one development server, so a screen can take longer than the default five seconds to settle.
const expect = baseExpect.configure({ timeout: 20_000 });

const PROBLEMS_TAB = `/orgs/${WALK_ORG}/problems`;
const PROBLEMS = `/problems/${WALK_ORG}`;
const EXAMPLE = new URL('../../examples/demo/01_simple_seq/', import.meta.url);

/** `examples/demo/01_simple_seq` as a `.bim.zip`, the package the gateway serves as the template `demo/01_simple_seq`. */
function examplePackage(): Buffer {
  const files = Object.fromEntries(
    readdirSync(EXAMPLE)
      .sort()
      .map(name => [name, readFileSync(new URL(name, EXAMPLE), 'utf8')])
  );
  return Buffer.from(zipStore(files));
}

async function candidatesOf(
  archive: Buffer
): Promise<{ spec: { candidates: Record<string, { features: Record<string, number> }> } }> {
  const zip = await JSZip.loadAsync(archive);
  return JSON.parse(await zip.file('candidates.json')!.async('string'));
}

function watchCriticalErrors(page: Page) {
  const critical: string[] = [];
  page.on('pageerror', error => critical.push(`pageerror: ${error.message}`));
  page.on('console', message => {
    const text = message.text();
    if (
      message.type() === 'error' &&
      /The above error occurred|Minified React error|Maximum update depth|Uncaught/i.test(text)
    )
      critical.push(`console: ${text}`);
  });
  return critical;
}

test.use({ viewport: { width: 1440, height: 900 } });

test('the F0b walk: upload, edit in the problem editor, a template, a run and a study', async ({
  page,
}) => {
  test.setTimeout(300_000);
  const critical = watchCriticalErrors(page);
  const template = examplePackage();
  const api = await installWalkApi(page, template);
  const main = page.locator('main');

  // 1 · Sign in.
  await page.goto('/authentication');
  await page.getByLabel('Username or email').fill('alex.rivera');
  await page
    .getByLabel('Password', { exact: true })
    .fill(['walk', 'secret', 'not', 'real'].join('-'));
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect.poll(() => new URL(page.url()).pathname).toBe('/');

  // 2 · The organization's page, its problems, and an upload of the demo package.
  await page.goto('/me/orgs');
  await page.locator(`main a[href="/orgs/${WALK_ORG}"]`).first().click();
  await expect(page).toHaveURL(new RegExp(`/orgs/${WALK_ORG}/?$`));
  await page.goto(PROBLEMS_TAB);
  await expect(main.getByRole('heading', { level: 2, name: 'Problems' })).toBeVisible();
  await main.getByRole('button', { name: /^New/ }).click();
  await main.getByRole('menuitem', { name: /Upload BIM package/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Upload a BIM package' });
  await dialog.getByLabel('BIM package').setInputFiles({
    name: 'simple-seq.bim.zip',
    mimeType: 'application/vnd.bim+zip',
    buffer: template,
  });
  await expect(dialog.getByLabel('Name')).toHaveValue('simple-seq');
  await dialog.getByRole('button', { name: 'Upload problem' }).click();

  // 3 · The problem page shows version 1, and its source is the package as uploaded.
  await expect(page).toHaveURL(new RegExp(`${PROBLEMS}/simple-seq$`));
  await expect(main.getByRole('heading', { level: 1, name: 'simple-seq' })).toBeVisible();
  await expect(page.getByText('Problem “simple-seq” created with version 1.')).toBeVisible();
  expect(api.sent.uploads).toHaveLength(1);
  expect(api.sent.uploads[0].bytes.equals(template)).toBe(true);
  const sections = main.getByRole('navigation', { name: 'Problem sections' });
  await sections.getByRole('link', { name: 'Source' }).click();
  const files = main.getByRole('list', { name: 'Files in the package' });
  await expect(files).toBeVisible();
  await expect(files).toContainText('candidates.json');

  // 4 · Edit in the problem editor: one candidate value changes in its form, the live check sends it, and it is saved as version 2.
  await sections.getByRole('link', { name: 'Overview' }).click();
  await main.getByRole('button', { name: 'New version' }).click();
  const edit = main.getByRole('menuitem', { name: /Problem editor/ });
  await expect(edit).toHaveAttribute(
    'href',
    `/problem-editor?org=${WALK_ORG}&problem=simple-seq&revision=1`
  );
  await edit.click();
  await expect(main.getByText('Loaded version 1 of simple-seq')).toBeVisible();
  const status = page.getByTestId('pe-check-status');
  await expect(status).toHaveText('Valid package');
  await main.getByRole('tab', { name: 'Forms' }).click();
  await main
    .getByRole('navigation', { name: 'BIM resources' })
    .getByRole('button', { name: /candidates\.json/ })
    .click();
  await expect(main.getByLabel('c1b QoS latency')).toHaveValue('20');
  await main.getByLabel('c1b QoS latency').fill('12');
  await expect
    .poll(
      async () =>
        (await candidatesOf(api.sent.validated[api.sent.validated.length - 1])).spec.candidates.c1b
          .features.latency
    )
    .toBe(12);
  await expect(status).toHaveText('Valid package');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const save = page.getByRole('dialog', { name: 'Save the package' });
  await expect(save.getByRole('button', { name: 'New version' })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  await save.getByRole('button', { name: 'Save as a new version of simple-seq' }).click();
  await expect(
    main.getByText('Saved as version 2 of simple-seq. Run it from its page.')
  ).toBeVisible();
  expect(api.sent.uploads.map(({ problem, revision }) => `${problem}@${revision}`)).toEqual([
    'simple-seq@1',
    'simple-seq@2',
  ]);
  expect((await candidatesOf(api.sent.uploads[1].bytes)).spec.candidates.c1b.features.latency).toBe(
    12
  );
  await main.getByRole('link', { name: 'Open the problem' }).click();
  await expect(page).toHaveURL(new RegExp(`${PROBLEMS}/simple-seq\\?version=2$`));
  await expect(main.getByRole('combobox', { name: 'Version' })).toHaveValue('2');
  await expect(main.getByRole('link', { name: 'Run this version' })).toHaveAttribute(
    'href',
    `/runs/new?org=${WALK_ORG}&problem=simple-seq&revision=2`
  );

  // 4b · Start from a template: it is checked as it opens, saved as a new problem, and that problem's page offers a run.
  await page.goto(PROBLEMS_TAB);
  await main.getByRole('button', { name: /^New/ }).click();
  await main.getByRole('menuitem', { name: /Start from a template/ }).click();
  await expect(page).toHaveURL(
    new RegExp(`/problem-editor\\?org=${WALK_ORG}&template=demo%2F01_simple_seq$`)
  );
  await expect(main.getByText('Opened from template demo/01_simple_seq')).toBeVisible();
  await expect(status).toHaveText('Valid package');
  expect(api.sent.validated[api.sent.validated.length - 1].equals(template)).toBe(true);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(save.getByRole('button', { name: 'New problem' })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  await save.getByRole('button', { name: 'Save as a new problem' }).click();
  await expect(
    main.getByText('Saved as version 1 of demo_01_simple_seq. Run it from its page.')
  ).toBeVisible();
  expect(api.sent.uploads[2]).toMatchObject({ problem: 'demo-01-simple-seq', revision: 1 });
  await main.getByRole('link', { name: 'Open the problem' }).click();
  await expect(main.getByRole('heading', { level: 1, name: 'demo_01_simple_seq' })).toBeVisible();
  await expect(main.getByRole('link', { name: 'Run this version' })).toHaveAttribute(
    'href',
    `/runs/new?org=${WALK_ORG}&problem=demo-01-simple-seq&revision=1`
  );

  // 5 · Run version 2 of simple-seq: pick the engine and its mode, send it, and follow the run until it completes.
  await page.goto(`${PROBLEMS}/simple-seq?version=2`);
  await main.getByRole('link', { name: 'Run this version' }).click();
  await expect(main.getByRole('heading', { level: 1, name: 'New run' })).toBeVisible();
  const next = main.getByRole('button', { name: 'Continue' });
  await expect(
    main
      .getByRole('radiogroup', { name: 'Source' })
      .getByRole('radio', { name: /simple-seq · version 2/ })
  ).toBeChecked();
  await next.click();
  const engine = main
    .getByRole('radiogroup', { name: 'Engine' })
    .getByRole('radio', { name: /^random-search.*Can run this/ });
  await engine.check({ force: true });
  await expect(engine).toBeChecked();
  await expect(
    main.getByRole('heading', { level: 2, name: 'Settings', exact: true })
  ).toBeVisible();
  await expect(main.getByRole('heading', { name: 'Before you send' })).toBeVisible();
  await main.getByRole('button', { name: 'Send run' }).click();
  await expect(main.getByRole('heading', { name: 'Run accepted · queued' })).toBeVisible();
  const revision2 = api.sent.uploads[1].id;
  expect(api.sent.runs).toHaveLength(1);
  expect(api.sent.runs[0]).toMatchObject({
    revision: revision2,
    engine: { name: 'random-search' },
    mode: 'sampling',
  });
  await main.getByRole('link', { name: 'Follow the run' }).click();
  await expect(main.getByRole('heading', { level: 1, name: 'random-search run' })).toBeVisible();
  await expect(
    main
      .getByRole('region', { name: 'Run result' })
      .getByRole('region', { name: 'Chosen providers' })
  ).toBeVisible({ timeout: 30_000 });
  await expect(main.getByText('Live · connected')).toHaveCount(0);

  // 6 · A study of version 2 × 2 engine modes × 2 seeds: created, run, followed until its cells finish, and its results.
  await page.goto(`/orgs/${WALK_ORG}/studies`);
  await main
    .getByRole('link', { name: /New study|Build a study/ })
    .first()
    .click();
  await expect(main.getByRole('heading', { level: 1, name: 'New study' })).toBeVisible();
  const versions = main.getByRole('group', { name: 'Problem versions' });
  await expect(versions.getByRole('checkbox')).toHaveCount(3);
  await expect(versions.getByRole('checkbox', { checked: true })).toHaveCount(0);
  await versions.getByRole('checkbox', { name: /simple-seq · version 2/ }).check();
  const modes = main.getByRole('group', { name: 'Engine modes' });
  await modes.getByRole('checkbox', { name: /^random-search/ }).check();
  await modes.getByRole('checkbox', { name: /^evolutionary/ }).check();
  await main.getByLabel('Study name').fill('Walk study');
  await expect(main.getByLabel(/Seeds \(comma-separated/)).toHaveValue('1, 2');
  await expect(
    main
      .getByRole('complementary', { name: 'Matrix and plan' })
      .getByText('1 problem version × 2 engines × 1 setting × 2 seeds')
  ).toBeVisible();
  await main.getByRole('button', { name: 'Create study' }).click();
  await expect(main.getByRole('heading', { level: 1, name: 'Walk study' })).toBeVisible();
  expect(api.sent.studies).toHaveLength(1);
  expect(api.sent.studies[0]).toMatchObject({
    slug: 'walk-study',
    definition: { seeds: [1, 2], parameter_sets: [{}] },
  });
  const definition = api.sent.studies[0].definition as {
    revision_ids: string[];
    engines: Array<{ name: string; mode: string }>;
  };
  expect(definition.revision_ids).toEqual([revision2]);
  expect(definition.engines.map(item => `${item.name}/${item.mode}`)).toEqual([
    'random-search/sampling',
    'evolutionary/genetic',
  ]);

  await main.getByRole('button', { name: 'Run study' }).click();
  await expect(
    main.getByText('Run #1 accepted (202). Cells start as run slots free up.')
  ).toBeVisible();
  // What the run froze sits in Setup beside the definition.
  const frozen = main.getByRole('region', { name: 'Frozen definition' });
  await expect(
    frozen.getByRole('button', { name: 'Copy the digest of the frozen definition' })
  ).toBeVisible();
  await expect(frozen).not.toContainText('sha256-');
  await main.getByRole('link', { name: 'Follow run #1' }).click();
  await expect(main.getByRole('heading', { level: 2, name: 'Run #1' })).toBeVisible();
  const progress = main.getByRole('region', { name: 'Progress of the run' });
  await expect(progress.getByText('Finished · not live')).toBeVisible({ timeout: 45_000 });
  await expect(progress.getByRole('img', { name: '4 completed of 4 cells' })).toBeVisible();

  await main.getByRole('link', { name: 'Compare results' }).click();
  await expect(main.getByRole('heading', { name: 'Engine ranking' })).toBeVisible();
  const ledger = main.getByRole('region', { name: 'Provenance of every cell' }).getByRole('table');
  await expect(ledger.getByRole('row')).toHaveCount(5);

  expect(api.unmocked).toEqual([]);
  expect(critical).toEqual([]);
});
