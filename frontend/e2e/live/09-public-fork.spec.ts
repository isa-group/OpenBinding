import { expect, test } from '@playwright/test';
import {
  API,
  LAB_USERS,
  ORG,
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
const SHOWCASE = `/compositions/${OTHER_ORG}/${PUBLIC}`;
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
    const cards = main.getByRole('article');
    await expect(cards).toHaveCount(2);
    const linked = cards.filter({ hasText: PUBLIC_NAME });
    await expect(linked).toContainText('Workflow');
    await expect(linked).toContainText(OTHER_NAME);
    await expect(linked).toContainText('Verified');
    await expect(cards.filter({ hasText: 'Order desk' })).toContainText('Declared');
    await capture(page, testInfo, 'j2-1-public-list');
    await linked.getByRole('link', { name: PUBLIC_NAME }).click();

    // The public page: what the document says; the problem only as its reference, and nothing a member alone reads.
    await expect(page).toHaveURL(SHOWCASE);
    await expect(main.getByRole('heading', { level: 1, name: PUBLIC_NAME })).toBeVisible();
    await expect(
      main.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('link', { name: OTHER_NAME })
    ).toBeVisible();
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
    const sections = main.getByRole('navigation', { name: 'Composition sections' });
    await expect(sections.getByRole('link', { name: 'Settings' })).toHaveCount(0);
    await expect(main.getByRole('button', { name: 'New version' })).toHaveCount(0);
    await capture(page, testInfo, 'j2-2-showcase');

    // The declared public one reads too; the private one is not found, in the same words as an address that names nothing.
    await page.goto(`/compositions/${OTHER_ORG}/${DECLARED}`);
    await expect(main.getByRole('heading', { level: 1, name: 'Order desk' })).toBeVisible();
    await expect(main.getByRole('region', { name: 'Value status' })).toContainText('Declared');
    for (const path of [
      `/compositions/${OTHER_ORG}/${PRIVATE}`,
      `/compositions/${OTHER_ORG}/no-such-composition`,
    ]) {
      await page.goto(path);
      await expect(main.getByRole('heading', { name: 'Page not found' }), path).toBeVisible();
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
    await expect(page).toHaveURL(/\/authentication$/);
    await signInThroughForm(page, LAB_USERS.owner, labPassword());
    await expect(page).toHaveURL(new RegExp(`${SHOWCASE}\\?version=1\\.0\\.0$`));
    const dialog = page.getByRole('dialog', { name: 'Fork this composition' });
    await expect(dialog).toBeVisible();
    // Not a member of lab-other: the page only reads.
    await expect(main.getByRole('button', { name: 'New version' })).toHaveCount(0);

    // Where: lab-main, the one organization of lab-owner.
    await dialog.getByRole('button', { name: 'Fork into', exact: true }).click();
    await dialog.getByRole('option', { name: new RegExp(MAIN_NAME) }).click();
    await dialog.getByRole('button', { name: 'Next' }).click();
    // Its problem: lab-main cannot read lab-other's, so the fork drops it, on purpose.
    const problem = page.getByRole('dialog', { name: 'Fork it without its problem?' });
    await expect(problem).toContainText(`${MAIN_NAME} cannot read`);
    await capture(page, testInfo, 'j2-4-fork-problem');
    await problem.getByRole('button', { name: 'Fork without the problem' }).click();
    // lab-main already has a composition named so (the seed's): another name and address, this run's own.
    const rename = page.getByRole('dialog', { name: 'Choose a different name' });
    await expect(rename).toContainText(
      `${MAIN_NAME} already has a composition named “${PUBLIC_NAME}”.`
    );
    await expect(rename.getByLabel('Composition name')).toHaveValue(`${PUBLIC_NAME} (fork)`);
    await rename.getByLabel('Composition name').fill(forkName);
    await rename.getByLabel('Address').fill(forkSlug);
    await rename.getByRole('button', { name: 'Fork as new composition' }).click();

    // The fork: private, its values declared, and it names its public source.
    await expect(page).toHaveURL(`/compositions/${ORG}/${forkSlug}`, { timeout: 60_000 });
    await expect(page.getByText('Composition forked')).toBeVisible();
    await expect(main.getByRole('heading', { level: 1, name: forkName })).toBeVisible();
    const lineage = main.getByRole('list', { name: 'Lineage' });
    await expect(lineage).toContainText(
      `Forked from ${PUBLIC_NAME} (version 1.0.0) · ${OTHER_NAME}, without its problem`
    );
    await expect(lineage.getByRole('link')).toHaveAttribute('href', `${SHOWCASE}?version=1.0.0`);
    await expect(main.getByRole('region', { name: 'Value status' })).toContainText('Declared');
    await expect(main.getByRole('region', { name: 'Values' })).toContainText('30 ms');
    await capture(page, testInfo, 'j2-5-fork');
    expect(errors).toEqual([]);
  });
});
