import { expect as baseExpect, test } from '@playwright/test';
import { installMockApi } from './helpers/mockApi';

// J2 · showcase and fork: a visitor opens the public compositions, reads the public page of another organization's composition (its
// workflow, its values and the upstream plans its candidates come from, named as references), asks to fork it, signs in, and comes
// back to the page with the fork dialog open. The dialog takes the version into an organization of the account, drops its problem on
// purpose, and asks for another name because the target already has one at that address. The new private composition says where it
// was forked from, linked to that public page, and its values are declared. A private composition's public address is not found.
// There is no backend: e2e/helpers/mockApi.ts answers the API origin; the compositions, lab-other's public one included, are
// e2e/helpers/mockCompositions.ts's.

const expect = baseExpect.configure({ timeout: 15_000 });

test.describe('J2 · showcase and fork', () => {
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
    const cards = main.getByRole('region', { name: 'Public compositions' }).getByRole('article');
    await expect(cards).toHaveCount(2);
    await expect(cards.nth(0)).toContainText('Order desk');
    const fleet = cards.nth(1);
    await expect(fleet).toContainText('Workflow · Other Lab');
    await expect(fleet).toContainText('1.1.0 of 2');
    await expect(fleet).toContainText('Verified');
    await fleet.getByRole('link', { name: 'Fleet routing' }).click();

    // Its public page: what the documents say, and nothing of the problem but its reference.
    await expect(page).toHaveURL('/c/lab-other/fleet-routing');
    await expect(main.getByRole('heading', { level: 1, name: 'Fleet routing' })).toBeVisible();
    await expect(main.getByText('Workflow · Other Lab')).toBeVisible();
    await expect(main.getByText('Version 1.1.0, sealed Sep 30, 2026')).toBeVisible();
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
      'Plans and prices arrive when OpenBinding reads the offering.'
    );
    const versions = main.getByRole('list', { name: 'Versions' });
    await expect(versions.getByRole('link', { name: '1.1.0' })).toHaveAttribute(
      'aria-current',
      'page'
    );
    await expect(versions.getByRole('link', { name: '1.0.0' })).toHaveAttribute(
      'href',
      '/c/lab-other/fleet-routing?version=1.0.0'
    );
    // A reader who is not a member only reads.
    for (const region of ['Problem candidates', 'Evaluation findings'])
      await expect(main.getByRole('region', { name: region })).toHaveCount(0);
    await expect(main.getByRole('tab')).toHaveCount(0);
    await expect(main.getByRole('link', { name: 'Open in the app' })).toHaveCount(0);

    // Fork asks the visitor to sign in, and the sign-in comes back to the page with the dialog open.
    await main.getByRole('button', { name: 'Fork', exact: true }).click();
    await expect(page).toHaveURL('/authentication');
    await page.getByLabel('Username or email').fill('alex.rivera');
    await page
      .getByLabel('Password', { exact: true })
      .fill(['showcase', 'walk', 'not', 'real'].join('-'));
    await page.getByRole('button', { name: 'Log in' }).click();
    await expect(page).toHaveURL('/c/lab-other/fleet-routing?version=1.1.0');
    const dialog = page.getByRole('dialog', { name: 'Fork this composition' });
    await expect(dialog).toBeVisible();

    // Where: an organization of the account where it is MEMBER or more.
    await expect(dialog.getByRole('radio', { name: 'Read Lab' })).toBeDisabled();
    await dialog.getByRole('radio', { name: 'ISA Demo Group' }).check();
    await dialog.getByRole('button', { name: 'Next' }).click();
    // Its problem: the target cannot read it, so the fork drops it, on purpose.
    await expect(dialog).toContainText(
      'This version links a problem of Other Lab, which ISA Demo Group cannot read.'
    );
    await expect(dialog.getByRole('button', { name: 'Fork', exact: true })).toBeDisabled();
    await dialog.getByRole('checkbox', { name: /Fork without the problem/ }).check();
    await dialog.getByRole('button', { name: 'Fork', exact: true }).click();
    // The target already has a composition at that address: another name.
    await expect(dialog).toContainText(
      'ISA Demo Group already has a composition at fleet-routing, named “Fleet routing”.'
    );
    await expect(dialog.getByLabel('Name')).toHaveValue('Fleet routing (fork)');
    await expect(dialog.getByLabel('Address')).toHaveValue('fleet-routing-fork');
    await dialog.getByRole('button', { name: 'Fork as a new composition' }).click();

    // The fork: private, its values declared, and it names its public source.
    await expect(page).toHaveURL('/app/isa-demo/compositions/fleet-routing-fork');
    await expect(main.getByText('Forked. The copy is private. Values are declared.')).toBeVisible();
    await expect(
      main.getByRole('heading', { level: 1, name: 'Fleet routing (fork)' })
    ).toBeVisible();
    await expect(main.locator('.cmp-badges')).toContainText('Private');
    const lineage = main.getByRole('list', { name: 'Lineage' });
    await expect(lineage).toContainText(
      'Forked from Other Lab / Fleet routing 1.1.0, without its problem.'
    );
    await expect(lineage.getByRole('link', { name: 'Other Lab / Fleet routing' })).toHaveAttribute(
      'href',
      '/c/lab-other/fleet-routing?version=1.1.0'
    );
    await expect(main.getByRole('region', { name: 'Value status' })).toContainText('Declared');
    expect(mock.unmocked).toEqual([]);
  });

  test('a visitor reads a declared public composition, and the public address of a private one is not found', async ({
    page,
  }) => {
    const mock = await installMockApi(page, 'none');
    const main = page.getByRole('main');

    await page.goto('/c/isa-demo/order-desk');
    await expect(main.getByRole('heading', { level: 1, name: 'Order desk' })).toBeVisible();
    await expect(main.getByRole('region', { name: 'Value status' })).toContainText('Declared');
    await expect(main.getByRole('region', { name: 'Values' })).toContainText('42.5 EUR/month');
    await expect(
      main
        .getByRole('region', { name: 'Offering' })
        .getByRole('link', { name: /pricings\.example\.org/ })
    ).toHaveAttribute('href', 'https://pricings.example.org/order-desk/pricing.yml');
    await expect(main.getByRole('region', { name: 'Problem' })).toHaveCount(0);

    await page.goto('/c/isa-demo/fleet-routing');
    await expect(
      main.getByRole('heading', { name: 'No composition here, or you cannot see it' })
    ).toBeVisible();
    await expect(main.getByRole('heading', { level: 1, name: 'Fleet routing' })).toHaveCount(0);
    await expect(main.getByRole('link', { name: 'Public compositions' }).first()).toHaveAttribute(
      'href',
      '/compositions'
    );
    expect(mock.unmocked).toEqual([]);
  });
});
