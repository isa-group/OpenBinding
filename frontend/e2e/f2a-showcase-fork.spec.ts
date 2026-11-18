import { expect as baseExpect, test } from '@playwright/test';
import { installMockApi } from './helpers/mockApi';

// J2 · the public composition page and fork: a visitor opens the public compositions, reads another organization's composition on
// SPHERE's card page (its workflow, its values and the upstream plans its candidates come from, named as references), asks to fork
// it, signs in, and comes back to the page with the Fork modal open. The modal takes the version into an organization of the
// account where it is MEMBER, drops its problem on purpose, and asks for another name because the target already has one at that
// address. The new private composition says where it was forked from, linked to its source, and its values are declared. A
// private composition reads as missing to a visitor: the in-place 404.
// There is no backend: e2e/helpers/mockApi.ts answers the API origin; the compositions, lab-other's public one included, are
// e2e/helpers/mockCompositions.ts's.

const expect = baseExpect.configure({ timeout: 15_000 });

test.describe('J2 · the public composition page and fork', () => {
  test('a visitor finds a public composition, reads it, signs in to fork it, and the fork names where it came from', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const mock = await installMockApi(page, 'visitor');
    await page.setViewportSize({ width: 1440, height: 900 });
    const main = page.getByRole('main');

    // The public compositions of every organization, newest change first.
    await page.goto('/compositions');
    await expect(
      main.getByRole('heading', { level: 1, name: 'Public compositions' })
    ).toBeVisible();
    const cards = main.getByRole('article');
    await expect(cards).toHaveCount(2);
    await expect(cards.nth(0)).toContainText('Order desk');
    const fleet = main.getByRole('article', { name: 'Fleet routing' });
    await expect(fleet).toContainText('Workflow');
    await expect(fleet).toContainText('Other Lab');
    await expect(fleet).toContainText('v1.1.0');
    await expect(fleet).toContainText('Verified');
    await fleet.getByRole('link', { name: 'Fleet routing' }).click();

    // Its page: what the documents say, and nothing of the problem but its reference.
    await expect(page).toHaveURL('/compositions/lab-other/fleet-routing');
    await expect(main.getByRole('heading', { level: 1, name: 'Fleet routing' })).toBeVisible();
    await expect(main.getByRole('combobox', { name: 'Version' })).toContainText('1.1.0');
    await expect(main.getByRole('region', { name: 'What it does' })).toContainText(
      'Plans the delivery routes of a fleet'
    );
    await expect(main.getByRole('region', { name: 'Value status' })).toContainText('Verified');
    await expect(main.getByRole('region', { name: 'Values' })).toContainText('3,105 USD/month');
    await expect(
      main
        .getByRole('region', { name: 'Workflow' })
        .getByRole('group', { name: 'The workflow of Fleet routing' })
    ).toBeVisible();
    const plans = main.getByRole('region', { name: 'Upstream plans' });
    await expect(plans.getByRole('heading', { name: 'Plan ON_DEMAND' })).toBeVisible();
    await expect(plans.getByRole('heading', { name: 'Plan STANDARD' })).toBeVisible();
    await expect(main.getByRole('region', { name: 'Problem' })).toContainText(
      'lab-other/problems/route-planning@3'
    );
    await expect(main.getByRole('region', { name: 'Offering' })).toContainText(
      'This version names no pricing of its own.'
    );
    // A reader who is not a member only reads: no candidates, findings, Settings or New version.
    for (const region of ['Problem candidates', 'Evaluation findings'])
      await expect(main.getByRole('region', { name: region })).toHaveCount(0);
    const sections = main.getByRole('navigation', { name: 'Composition sections' });
    await expect(sections.getByRole('link', { name: 'Settings' })).toHaveCount(0);
    await expect(main.getByRole('button', { name: 'New version' })).toHaveCount(0);

    // Fork asks the visitor to sign in, and the sign-in comes back to the page with the modal open.
    await main.getByRole('button', { name: 'Fork', exact: true }).click();
    await expect(page).toHaveURL('/authentication');
    await page.getByLabel('Username or email').fill('alex.rivera');
    await page
      .getByLabel('Password', { exact: true })
      .fill(['showcase', 'walk', 'not', 'real'].join('-'));
    await page.getByRole('button', { name: 'Log in' }).click();
    await expect(page).toHaveURL('/compositions/lab-other/fleet-routing?version=1.1.0');
    const dialog = page.getByRole('dialog', { name: 'Fork this composition' });
    await expect(dialog).toBeVisible();

    // Where: an organization of the account where it is MEMBER or more (Read Lab, a VIEWER's, is not offered).
    await dialog.getByRole('button', { name: 'Fork into', exact: true }).click();
    await expect(dialog.getByRole('option', { name: /Read Lab/ })).toHaveCount(0);
    await dialog.getByRole('option', { name: /ISA Demo Group/ }).click();
    await dialog.getByRole('button', { name: 'Next' }).click();
    // Its problem: the target cannot read it, so the fork drops it, on purpose.
    const problem = page.getByRole('dialog', { name: 'Fork it without its problem?' });
    await expect(problem).toContainText('ISA Demo Group cannot read');
    await problem.getByRole('button', { name: 'Fork without the problem' }).click();
    // The target already has a composition named so: another name and address.
    const rename = page.getByRole('dialog', { name: 'Choose a different name' });
    await expect(rename).toContainText(
      'ISA Demo Group already has a composition named “Fleet routing”.'
    );
    await expect(rename.getByLabel('Composition name')).toHaveValue('Fleet routing (fork)');
    await expect(rename.getByLabel('Address')).toHaveValue('fleet-routing-fork');
    await rename.getByRole('button', { name: 'Fork as new composition' }).click();

    // The fork: private, its values declared, and it names its source.
    await expect(page).toHaveURL('/compositions/isa-demo/fleet-routing-fork');
    await expect(page.getByText('Composition forked')).toBeVisible();
    await expect(
      main.getByRole('heading', { level: 1, name: 'Fleet routing (fork)' })
    ).toBeVisible();
    const lineage = main.getByRole('list', { name: 'Lineage' });
    await expect(lineage).toContainText(
      'Forked from Fleet routing (version 1.1.0) · Other Lab, without its problem'
    );
    await expect(lineage.getByRole('link')).toHaveAttribute(
      'href',
      '/compositions/lab-other/fleet-routing?version=1.1.0'
    );
    await expect(main.getByRole('region', { name: 'Value status' })).toContainText('Declared');
    expect(mock.unmocked).toEqual([]);
  });

  test('a visitor reads a declared public composition, and the public address of a private one is not found', async ({
    page,
  }) => {
    const mock = await installMockApi(page, 'none');
    const main = page.getByRole('main');

    await page.goto('/compositions/isa-demo/order-desk');
    await expect(main.getByRole('heading', { level: 1, name: 'Order desk' })).toBeVisible();
    await expect(main.getByRole('region', { name: 'Value status' })).toContainText('Declared');
    await expect(main.getByRole('region', { name: 'Values' })).toContainText('42.5 EUR/month');
    await expect(
      main
        .getByRole('region', { name: 'Offering' })
        .getByRole('link', { name: /pricings\.example\.org/ })
    ).toHaveAttribute('href', 'https://pricings.example.org/order-desk/pricing.yml');
    await expect(main.getByRole('region', { name: 'Problem' })).toHaveCount(0);

    await page.goto('/compositions/isa-demo/fleet-routing');
    await expect(main.getByRole('heading', { name: 'Page not found' })).toBeVisible();
    await expect(main.getByRole('heading', { level: 1, name: 'Fleet routing' })).toHaveCount(0);
    expect(mock.unmocked).toEqual([]);
  });
});
