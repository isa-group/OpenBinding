import { expect, test } from '@playwright/test';
import {
  API,
  LAB_USERS,
  ORG_PATH,
  OTHER_ORG,
  capture,
  labPassword,
  signInThroughForm,
  watchPageErrors,
} from './support';

// J2 against the lab (the mocked twin is e2e/f2a-showcase-fork.spec.ts), on what tools/seed_lab.py made in lab-other: the public
// composition `sequential-workflow` (derived from lab-other's own simple-seq, so its values are verified), the public declared
// `order-desk` and the private `internal-draft`. A visitor reads the public list and the public page, and does not find the private
// one. Then lab-owner, who is not a member of lab-other, asks to fork, signs in, and forks the public composition into lab-main
// without its problem. lab-main already has a composition at `sequential-workflow` (the seed's), so the dialog asks for another name;
// each run gives one of its own, so the spec can run again on the same lab. The fork is private and its values are declared.

const PUBLIC = 'sequential-workflow';
const PUBLIC_NAME = 'Sequential workflow';
const DECLARED = 'order-desk';
const PRIVATE = 'internal-draft';
const SHOWCASE = `/c/${OTHER_ORG}/${PUBLIC}`;
const OTHER_NAME = 'Lab Other Organization';
const MAIN_NAME = 'Lab Main Organization';

test.describe('live · J2 public compositions and a fork from another organization', () => {
  test('a visitor reads the public list and a public composition of lab-other, and not its private one', async ({
    page,
  }, testInfo) => {
    const errors = watchPageErrors(page);
    const main = page.getByRole('main');

    await page.goto('/compositions');
    await expect(
      main.getByRole('heading', { level: 1, name: 'Public compositions' })
    ).toBeVisible();
    const cards = main.getByRole('region', { name: 'Public compositions' }).getByRole('article');
    await expect(cards).toHaveCount(2);
    const linked = cards.filter({ hasText: PUBLIC_NAME });
    await expect(linked).toContainText(`Workflow · ${OTHER_NAME}`);
    await expect(linked).toContainText('Verified');
    await expect(cards.filter({ hasText: 'Order desk' })).toContainText('Declared');
    await capture(page, testInfo, 'j2-1-public-list');
    await linked.getByRole('link', { name: PUBLIC_NAME }).click();

    // The public page: what the document says; the problem only as its reference, and nothing a member alone reads.
    await expect(page).toHaveURL(SHOWCASE);
    await expect(main.getByRole('heading', { level: 1, name: PUBLIC_NAME })).toBeVisible();
    await expect(main.getByText(`Workflow · ${OTHER_NAME}`)).toBeVisible();
    await expect(main.getByRole('region', { name: 'Value status' })).toContainText('Verified');
    await expect(main.getByRole('region', { name: 'Values' })).toContainText('30 ms');
    await expect(
      main
        .getByRole('region', { name: 'Workflow' })
        .getByRole('group', { name: `The workflow of ${PUBLIC_NAME}` })
    ).toBeVisible();
    await expect(main.getByRole('region', { name: 'Problem' })).toContainText(
      `${OTHER_ORG}/problems/simple-seq@1`
    );
    for (const region of ['Problem candidates', 'Evaluation findings'])
      await expect(main.getByRole('region', { name: region })).toHaveCount(0);
    await expect(main.getByRole('tab')).toHaveCount(0);
    await capture(page, testInfo, 'j2-2-showcase');

    // The declared public one reads too; the private one is not found, in the same words as an address that names nothing.
    await page.goto(`/c/${OTHER_ORG}/${DECLARED}`);
    await expect(main.getByRole('heading', { level: 1, name: 'Order desk' })).toBeVisible();
    await expect(main.getByRole('region', { name: 'Value status' })).toContainText('Declared');
    for (const path of [`/c/${OTHER_ORG}/${PRIVATE}`, `/c/${OTHER_ORG}/no-such-composition`]) {
      await page.goto(path);
      await expect(
        main.getByRole('heading', { name: 'No composition here, or you cannot see it' }),
        path
      ).toBeVisible();
    }
    await capture(page, testInfo, 'j2-3-private-not-found');

    // The gateway answers the private composition with the bytes of a missing one.
    const hidden = await page.request.get(
      `${API}/v1/organizations/${OTHER_ORG}/compositions/${PRIVATE}`
    );
    const missing = await page.request.get(
      `${API}/v1/organizations/${OTHER_ORG}/compositions/no-such-composition`
    );
    expect(hidden.status()).toBe(404);
    expect(await hidden.text()).toBe(await missing.text());
    expect(errors).toEqual([]);
  });

  test('lab-owner signs in from the public page and forks it into lab-main without its problem: a private, declared copy', async ({
    page,
  }, testInfo) => {
    test.setTimeout(300_000);
    const errors = watchPageErrors(page);
    const stamp = Date.now().toString(36);
    const forkName = `Sequential workflow fork ${stamp}`;
    const forkSlug = `sequential-workflow-fork-${stamp}`;
    const main = page.getByRole('main');

    // Fork asks the visitor to sign in, and the sign-in comes back to the page with the dialog open.
    await page.goto(SHOWCASE);
    await expect(main.getByRole('heading', { level: 1, name: PUBLIC_NAME })).toBeVisible();
    await main.getByRole('button', { name: 'Fork', exact: true }).click();
    await expect(page).toHaveURL(/\/login$/);
    await signInThroughForm(page, LAB_USERS.owner, labPassword());
    await expect(page).toHaveURL(new RegExp(`${SHOWCASE}\\?version=1\\.0\\.0$`));
    const dialog = page.getByRole('dialog', { name: 'Fork this composition' });
    await expect(dialog).toBeVisible();
    // Not a member of lab-other: the page only reads, and offers no way into the app.
    await expect(main.getByRole('link', { name: 'Open in the app' })).toHaveCount(0);

    // Where: lab-main, the one organization of lab-owner.
    await dialog.getByRole('radio', { name: MAIN_NAME }).check();
    await dialog.getByRole('button', { name: 'Next' }).click();
    // Its problem: lab-main cannot read lab-other's, so the fork drops it, on purpose.
    await expect(dialog).toContainText(
      `This version links a problem of ${OTHER_NAME}, which ${MAIN_NAME} cannot read.`
    );
    const fork = dialog.getByRole('button', { name: 'Fork', exact: true });
    await expect(fork).toBeDisabled();
    await dialog.getByRole('checkbox', { name: /Fork without the problem/ }).check();
    await capture(page, testInfo, 'j2-4-fork-problem');
    await fork.click();
    // lab-main already has a composition at that address (the seed's): another name and address, this run's own.
    await expect(dialog).toContainText(
      `${MAIN_NAME} already has a composition at ${PUBLIC}, named “${PUBLIC_NAME}”.`
    );
    await expect(dialog.getByLabel('Name')).toHaveValue(`${PUBLIC_NAME} (fork)`);
    await dialog.getByLabel('Name').fill(forkName);
    await dialog.getByLabel('Address').fill(forkSlug);
    await dialog.getByRole('button', { name: 'Fork as a new composition' }).click();

    // The fork: private, its values declared, and it names its public source.
    await expect(page).toHaveURL(`${ORG_PATH}/compositions/${forkSlug}`, { timeout: 60_000 });
    await expect(main.getByText('Forked. The copy is private. Values are declared.')).toBeVisible();
    await expect(main.getByRole('heading', { level: 1, name: forkName })).toBeVisible();
    await expect(main.locator('.cmp-badges')).toContainText('Private');
    const lineage = main.getByRole('list', { name: 'Lineage' });
    await expect(lineage).toContainText(
      `Forked from ${OTHER_NAME} / ${PUBLIC_NAME} 1.0.0, without its problem.`
    );
    await expect(
      lineage.getByRole('link', { name: `${OTHER_NAME} / ${PUBLIC_NAME}` })
    ).toHaveAttribute('href', `${SHOWCASE}?version=1.0.0`);
    await expect(main.getByRole('region', { name: 'Value status' })).toContainText('Declared');
    await expect(main.getByRole('region', { name: 'Values' })).toContainText('30 ms');
    await capture(page, testInfo, 'j2-5-fork');
    expect(errors).toEqual([]);
  });
});
