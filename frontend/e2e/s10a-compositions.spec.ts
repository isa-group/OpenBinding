import { expect as baseExpect, test, type Page } from '@playwright/test';
import { installMockApi } from './helpers/mockApi';

// S10a · the compositions of an organization: its Compositions tab (/orgs/:org/compositions, SPHERE's list) and the composition
// page composition-detail
// with its Overview (the catalog of the version shown, its architecture and its workflow), its Editor (Composition2Yaml code with
// the gateway's lint, and the seal), its Versions (the table, and the comparison of two versions by entry and by line), its
// Analysis (one change at a time, and a binding chosen per task, evaluated and derived) and its Settings (rename, archive, publish
// and delete), and the fork of the version shown into another organization. The smoke grew with the blocks that built the
// composition screens: list, create, overview, editor, versions, analysis and settings.
// There is no backend: e2e/helpers/mockApi.ts answers the API origin, with the compositions of e2e/helpers/mockCompositions.ts.

// Several browsers share one development server, so a screen can take longer than the default five seconds to settle.
const expect = baseExpect.configure({ timeout: 15_000 });

const TAB = '/orgs/isa-demo/compositions';
const LIST = '/compositions/isa-demo';
const main = (page: Page) => page.locator('main');
const region = (page: Page, name: string) => main(page).getByRole('region', { name, exact: true });
const sections = (page: Page) =>
  main(page).getByRole('navigation', { name: 'Composition sections' });

test.describe('S10a · compositions', () => {
  test('the New menu of the header creates a composition in the organization the address names', async ({
    page,
  }) => {
    const mock = await installMockApi(page, 'admin');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/app/isa-demo/runs');
    await expect(main(page).getByRole('heading', { level: 1, name: 'Runs' })).toBeVisible();

    const header = page.getByRole('banner');
    await header.getByRole('button', { name: 'New', exact: true }).click();
    await header.getByRole('link', { name: 'Composition', exact: true }).click();
    await expect(page).toHaveURL('/compositions/new?org=isa-demo');
    await expect(
      main(page).getByRole('heading', { level: 1, name: 'Add a composition to OpenBinding' })
    ).toBeVisible();
    await expect(
      main(page).getByRole('button', { name: 'Organization', exact: true })
    ).toContainText('ISA Demo Group');
    expect(mock.unmocked).toEqual([]);
  });

  test('the tab shows the active compositions as cards, newest change first, and filters them by kind and state', async ({
    page,
  }) => {
    const mock = await installMockApi(page, 'admin');
    await page.goto(TAB);

    const cards = main(page).getByRole('article');
    const names = cards.getByRole('heading', { level: 3 });
    await expect(names).toHaveText(['Fleet routing', 'Order desk']);
    const fleet = main(page).getByRole('article', { name: 'Fleet routing' });
    await expect(fleet).toContainText('Workflow');
    await expect(fleet).toContainText('v1.2.0');
    await expect(fleet).toContainText('Verified');
    const order = main(page).getByRole('article', { name: 'Order desk' });
    await expect(order).toContainText('Declared');
    await expect(order).toContainText('Public');

    const filters = main(page).getByRole('button', { name: /^Filters/ });
    await filters.click();
    await main(page).getByRole('checkbox', { name: 'Application' }).click();
    await expect(page).toHaveURL(`${TAB}?kinds=application`);
    await expect(names).toHaveText(['Order desk']);

    await main(page).getByRole('checkbox', { name: 'Application' }).click();
    await expect(page).toHaveURL(TAB);
    await main(page).getByRole('checkbox', { name: 'Only archived compositions' }).click();
    await expect(page).toHaveURL(`${TAB}?archived=true`);
    await expect(names).toHaveText(['Legacy intake']);
    await expect(main(page).getByRole('article', { name: 'Legacy intake' })).toContainText(
      'No version yet'
    );

    await main(page).getByRole('checkbox', { name: 'Only archived compositions' }).click();
    await expect(page).toHaveURL(TAB);
    await page.keyboard.press('Escape');
    await main(page).getByRole('searchbox', { name: 'Search compositions' }).fill('desk');
    await expect(page).toHaveURL(`${TAB}?q=desk`);
    await expect(names).toHaveText(['Order desk']);

    await main(page).getByRole('link', { name: 'Order desk' }).click();
    await expect(page).toHaveURL(`${LIST}/order-desk`);
    expect(mock.unmocked).toEqual([]);
  });

  test('a new composition opens in its Editor, on the starter document named after it', async ({
    page,
  }) => {
    const mock = await installMockApi(page, 'admin');
    await page.goto(TAB);

    await main(page).getByRole('link', { name: 'New composition' }).click();
    await expect(page).toHaveURL('/compositions/new?org=isa-demo');
    await main(page).getByLabel('Composition name').fill('Order desk');
    await main(page).getByRole('button', { name: 'Write it in the editor' }).click();
    await expect(main(page).getByRole('alert')).toContainText(
      'order-desk is in use in ISA Demo Group. Choose another name.'
    );

    await main(page).getByLabel('Composition name').fill('Order intake');
    await expect(main(page).getByText('order-intake', { exact: true })).toBeVisible();
    await main(page).getByRole('button', { name: 'Write it in the editor' }).click();

    await expect(page).toHaveURL(`${LIST}/order-intake/editor`);
    await expect(main(page).getByRole('heading', { level: 1, name: 'Order intake' })).toBeVisible();
    await expect(
      page.getByText(
        'Composition “Order intake” created. It has no version yet: write its first one here.'
      )
    ).toBeVisible();
    await expect(sections(page).getByRole('link', { name: 'Editor' })).toHaveAttribute(
      'aria-current',
      'page'
    );
    await expect(
      main(page).getByText('No version yet. Start from this document and seal its first version.')
    ).toBeVisible();
    const source = main(page).getByRole('textbox', { name: 'composition.yaml source' });
    await expect(source).toContainText('composition: order-intake');
    await expect(source).toContainText('kind: application');
    await expect(main(page).getByLabel('Label')).toHaveValue('1.0.0');

    await main(page)
      .getByRole('navigation', { name: 'Breadcrumb' })
      .getByRole('link', { name: 'ISA Demo Group' })
      .click();
    await expect(page).toHaveURL(TAB);
    await expect(main(page).getByRole('article').getByRole('heading', { level: 3 })).toHaveText([
      'Order intake',
      'Fleet routing',
      'Order desk',
    ]);
    expect(mock.unmocked).toEqual([]);
  });

  test('the Editor marks what the gateway finds in the code, and seals the fixed text as a new version', async ({
    page,
  }) => {
    const mock = await installMockApi(page, 'admin');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${LIST}/order-desk`);

    await main(page).getByRole('button', { name: 'New version' }).click();
    await main(page)
      .getByRole('menu', { name: 'New version' })
      .getByRole('menuitem', { name: /Code editor/ })
      .click();
    await expect(page).toHaveURL(`${LIST}/order-desk/editor`);
    await expect(main(page).getByText(/Editing from version/)).toContainText(
      'Editing from version 1.2.0.'
    );
    const source = main(page).getByRole('textbox', { name: 'composition.yaml source' });
    await expect(source).toContainText('version: 1.2.0');
    const problems = main(page).getByRole('region', { name: 'Problems' });
    await expect(problems).toContainText('No issues');

    // Break the kind: the gateway's lint marks it in the code and lists it.
    await source.getByText('kind: application').click();
    await page.keyboard.press('End');
    await page.keyboard.type('x');
    await expect(
      problems.getByRole('button', { name: /'applicationx' is not a kind/ })
    ).toContainText('Line 8, column 7');
    await expect(main(page).locator('.cm-lintRange-error')).toHaveCount(1);
    await expect(main(page).getByText('Needs attention')).toBeVisible();
    await expect(main(page).getByRole('button', { name: 'Seal version' })).toBeDisabled();

    // Fix it, and give the version its own label.
    await page.keyboard.press('Escape');
    await page.keyboard.press('Backspace');
    await expect(problems).toContainText('No issues');
    await expect(main(page).locator('.cm-lintRange-error')).toHaveCount(0);
    const label = main(page).getByLabel('Label');
    await label.fill('1.3.0');
    await label.press('Enter');
    await expect(source).toContainText('version: 1.3.0');

    await main(page).getByRole('button', { name: 'Seal version' }).click();
    await expect(page).toHaveURL(`${LIST}/order-desk/versions?version=1.3.0`);
    await expect(page.getByText('Version 1.3.0 sealed.')).toBeVisible();
    await expect(sections(page).getByRole('link', { name: 'Versions' })).toHaveAttribute(
      'aria-current',
      'page'
    );
    await expect(
      main(page).getByRole('combobox', { name: 'Version' }).locator('option:checked')
    ).toHaveText('1.3.0 · latest');
    const sealed = main(page).getByRole('row', { name: /^1\.3\.0/ });
    await expect(sealed).toContainText('Latest');
    await expect(sealed).toHaveAttribute('aria-current', 'true');
    expect(mock.unmocked).toEqual([]);
  });

  test('the Versions tab lists the versions and compares two of them, entry by entry and line by line', async ({
    page,
  }) => {
    const mock = await installMockApi(page, 'admin');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${LIST}/fleet-routing`);

    await sections(page).getByRole('link', { name: 'Versions' }).click();
    await expect(page).toHaveURL(`${LIST}/fleet-routing/versions`);
    const table = main(page)
      .getByRole('region', { name: 'Versions of Fleet routing' })
      .getByRole('table');
    await expect(table.locator('tbody th code')).toHaveText(['1.2.0', '1.1.0', '1.0.0']);
    const latest = table.getByRole('row', { name: /^1\.2\.0/ });
    await expect(latest).toContainText('Derived from run 00000000, point 3');
    await expect(latest).toContainText('2,980 USD/month');
    await expect(table.getByRole('row', { name: /^1\.1\.0/ })).toContainText(
      'its problem changed meaning'
    );
    await expect(table.getByRole('row', { name: /^1\.0\.0/ })).toContainText('First version');

    await latest.getByRole('button', { name: 'Changes since 1.1.0' }).click();
    await expect(latest.getByRole('list', { name: 'Value changes' })).toContainText(
      'cost: 3,120 → 2,980'
    );

    await latest.getByRole('button', { name: 'Compare with previous' }).click();
    await expect(page).toHaveURL(`${LIST}/fleet-routing/versions?view=compare&from=1.1.0&to=1.2.0`);
    await expect(
      main(page).getByRole('combobox', { name: 'Base version' }).locator('option:checked')
    ).toHaveText('1.1.0');
    await expect(
      main(page).getByRole('combobox', { name: 'Compared with' }).locator('option:checked')
    ).toHaveText('1.2.0');
    const tiles = main(page).getByRole('group', { name: 'Show one kind of change' });
    await expect(tiles.getByRole('button', { name: /Changed/ })).toContainText('1');
    await expect(tiles.getByRole('button', { name: /Added/ })).toBeDisabled();
    const values = main(page).getByRole('region', { name: /^Values/ });
    await expect(values.getByRole('button', { name: /cost/ })).toHaveAttribute(
      'aria-expanded',
      'true'
    );
    await expect(values).toContainText('3,120 to 2,980');
    await expect(
      region(page, 'Workflow changes').getByRole('group', {
        name: 'The workflow of Fleet routing at 1.2.0',
      })
    ).toBeVisible();
    await expect(
      region(page, 'Problem candidates').getByRole('row', { name: /^cand_t1_aws/ })
    ).toContainText('In 1.1.0In 1.2.0');

    await main(page).getByRole('button', { name: 'Swap versions' }).click();
    await expect(page).toHaveURL(`${LIST}/fleet-routing/versions?view=compare&from=1.2.0&to=1.1.0`);
    await expect(values).toContainText('2,980 to 3,120');

    await main(page)
      .getByRole('group', { name: 'Versions view' })
      .getByRole('button', { name: 'File' })
      .click();
    await expect(page).toHaveURL(`${LIST}/fleet-routing/versions?view=file&from=1.2.0&to=1.1.0`);
    const text = main(page).getByRole('region', { name: 'The text of 1.2.0 and 1.1.0' });
    await expect(text).toContainText('1.2.0');
    await expect(main(page).getByText(/lines? removed/)).toBeVisible();
    await expect(text.locator('pre')).toHaveCount(0);
    expect(mock.unmocked).toEqual([]);
  });

  test('the Overview of a linked composition shows its verified values, binding, evidence, problem, providers, workflow and the problem’s candidates, version by version', async ({
    page,
  }) => {
    const mock = await installMockApi(page, 'admin');
    await page.goto(`${LIST}/fleet-routing`);

    await expect(
      main(page).getByRole('heading', { level: 1, name: 'Fleet routing' })
    ).toBeVisible();
    const version = main(page).getByRole('combobox', { name: 'Version' });
    await expect(version.locator('option:checked')).toHaveText('1.2.0 · latest');
    await expect(main(page).getByRole('list', { name: 'Lineage' })).toContainText(
      'Derived from run 00000000, point 3'
    );

    await expect(region(page, 'Value status')).toContainText('Verified');
    await expect(region(page, 'Values')).toContainText('2,980 USD/month');
    await expect(region(page, 'Binding')).toContainText('In-house');
    await expect(region(page, 'Evidence')).toContainText(
      'Evaluated by the gateway with bim-core 0.2.0.'
    );
    await expect(
      region(page, 'Problem').getByRole('link', { name: 'isa-demo/checkout-flow@2' })
    ).toHaveAttribute('href', '/app/isa-demo/problems/checkout-flow?version=2');
    await expect(region(page, 'Evaluation findings')).toContainText('No issues');

    const providers = region(page, 'Providers');
    await expect(
      providers.getByRole('heading', { level: 3, name: 'amazon 2 tasks' })
    ).toBeVisible();
    await expect(
      providers.getByRole('heading', { level: 3, name: 'In-house 1 task' })
    ).toBeVisible();
    await expect(region(page, 'Upstream plans')).toContainText(
      'No candidate names the SPHERE plan it comes from.'
    );
    const workflow = region(page, 'Workflow');
    await expect(
      workflow.getByRole('group', { name: 'The workflow of Fleet routing' })
    ).toBeVisible();
    await expect(workflow).toContainText('candidate cand_t1_aws');
    await expect(workflow).toContainText('local task · not bound');
    const candidates = region(page, 'Problem candidates');
    await expect(candidates.getByRole('row', { name: /^cand_t1_aws/ })).toHaveAttribute(
      'aria-current',
      'true'
    );
    await expect(
      candidates.getByRole('row', { name: /^cand_t1_google_cloud/ })
    ).not.toHaveAttribute('aria-current', 'true');

    await version.selectOption({ label: '1.1.0' });
    await expect(page).toHaveURL(`${LIST}/fleet-routing?version=1.1.0`);
    await expect(region(page, 'Value status')).toContainText('Unverified');
    await expect(region(page, 'Value status')).toContainText('changed meaning');
    await expect(region(page, 'Values')).toContainText('3,120 USD/month');
    expect(mock.unmocked).toEqual([]);
  });

  test('the Overview of a declared composition shows the author’s values, its offering and its upstream plan as references', async ({
    page,
  }) => {
    const mock = await installMockApi(page, 'admin');
    await page.goto(`${LIST}/order-desk?version=1`);

    await expect(
      main(page).getByRole('combobox', { name: 'Version' }).locator('option:checked')
    ).toHaveText('1.0.0');
    await expect(region(page, 'Value status')).toContainText('Declared');
    await expect(region(page, 'Values')).toContainText('48 EUR/month');
    await expect(region(page, 'Binding')).toContainText(
      'From brevo/brevo · plan STARTER · version 665f1c2e9b1d4a0012ab34cd'
    );
    await expect(region(page, 'Offering').getByRole('link')).toHaveAttribute(
      'href',
      'https://pricings.example.org/order-desk/pricing.yml'
    );
    await expect(region(page, 'Problem')).toHaveCount(0);

    const providers = region(page, 'Providers');
    await expect(providers).toContainText('The candidates come from 1 SPHERE pricing.');
    await expect(
      providers.getByRole('heading', { level: 3, name: 'brevo/brevo SPHERE pricing 1 task' })
    ).toBeVisible();
    await expect(
      providers.getByRole('heading', { level: 3, name: 'Provider not known 3 tasks' })
    ).toBeVisible();
    await expect(
      providers.getByRole('heading', { level: 3, name: 'In-house 1 task' })
    ).toBeVisible();
    const plans = region(page, 'Upstream plans');
    const starter = plans.getByRole('article', { name: 'Plan STARTER' });
    await expect(starter).toContainText('brevo/brevo');
    await expect(starter).toContainText('665f1c2e9b1d4a0012ab34cd');
    await expect(plans).toContainText('For notify');
    await expect(plans.getByRole('link')).toHaveCount(0);
    await expect(
      region(page, 'Workflow').getByRole('group', {
        name: 'Choice, 2 branches, probabilities 0.7, 0.3',
      })
    ).toBeVisible();
    await expect(region(page, 'Problem candidates')).toHaveCount(0);
    expect(mock.unmocked).toEqual([]);
  });

  test('the Analysis tab tries a move in the configurator, evaluates the binding and derives it as a new version', async ({
    page,
  }) => {
    const mock = await installMockApi(page, 'admin');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${LIST}/fleet-routing`);

    await sections(page).getByRole('link', { name: 'Analysis' }).click();
    await expect(page).toHaveURL(`${LIST}/fleet-routing/analysis`);
    const moves = region(page, 'One change at a time');
    const t1 = moves.getByRole('row', { name: /^T1 / });
    await expect(t1).toContainText('cand_t1_aws');
    await expect(t1).toContainText('cand_t1_google_cloud');
    await expect(t1).toContainText('Better');
    await expect(moves.getByRole('row', { name: /^T2 / })).toContainText('Trade-off');
    await moves.getByRole('combobox', { name: 'Comparison' }).selectOption('trade-off');
    await expect(moves.getByRole('row', { name: /^T1 / })).toHaveCount(0);
    await moves.getByRole('combobox', { name: 'Comparison' }).selectOption('');

    // Change a candidate: the move is tried in the configurator, which has the toolchain evaluate it.
    await t1.getByRole('button', { name: 'Try in configurator' }).click();
    await expect(
      main(page).getByRole('radio', { name: 'cand_t1_google_cloud for T1' })
    ).toBeChecked();
    const result = region(page, 'This binding');
    await expect(result).toContainText('Valid: the toolchain reports no broken hard rule.');
    const cost = result.getByRole('row', { name: /^cost/ });
    await expect(cost).toContainText('2,980 USD/month');
    await expect(cost).toContainText('3,080 USD/month');

    // Derive it as the next version of this composition.
    await result.getByRole('button', { name: 'Derive as a new version' }).click();
    const dialog = page.getByRole('dialog', { name: 'Derive a composition' });
    await expect(dialog.getByRole('region', { name: 'Binding to derive' })).toContainText(
      'cand_t1_google_cloud'
    );
    await expect(dialog.getByLabel('Version label')).toHaveValue('1.3.0');
    await dialog.getByRole('button', { name: 'Preview' }).click();
    await expect(dialog.getByRole('region', { name: 'Derived composition.yaml' })).toContainText(
      'cand_t1_google_cloud'
    );
    await dialog.getByRole('button', { name: 'Seal 1.3.0' }).click();
    await expect(page).toHaveURL(`${LIST}/fleet-routing/versions?version=1.3.0`);
    await expect(page.getByText('Version 1.3.0 sealed.')).toBeVisible();
    await expect(main(page).getByRole('list', { name: 'Lineage' })).toContainText(
      'Derived from a binding of problem version 2'
    );
    expect(mock.unmocked).toEqual([]);
  });

  test('a declared composition has no Analysis tab, and its address says why', async ({ page }) => {
    const mock = await installMockApi(page, 'admin');
    await page.goto(`${LIST}/order-desk`);
    await expect(sections(page).getByRole('link', { name: 'Versions' })).toBeVisible();
    await expect(sections(page).getByRole('link', { name: 'Analysis' })).toHaveCount(0);

    await page.goto(`${LIST}/order-desk/analysis`);
    await expect(
      main(page).getByText(
        'Values are declared: the calculator and configurator need a linked problem you can read.'
      )
    ).toBeVisible();
    expect(mock.unmocked).toEqual([]);
  });

  test('Settings publish a composition after saying what that shows, and a fork takes the version into another organization without its problem', async ({
    page,
  }) => {
    const mock = await installMockApi(page, 'admin');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${LIST}/fleet-routing/settings`);

    await expect(sections(page).getByRole('link', { name: 'Settings' })).toHaveAttribute(
      'aria-current',
      'page'
    );
    await expect(main(page)).toContainText('Only the members of ISA Demo Group read it.');
    await main(page).getByRole('radio', { name: 'Public' }).click();
    const publish = page.getByRole('dialog', { name: /Public compositions show every version/ });
    await expect(publish).toContainText(
      'the problem reference, the run and point recorded as evidence'
    );
    await expect(publish).toContainText(
      'A fork’s source is named only while that source is public.'
    );
    await publish.getByRole('button', { name: 'Make public' }).click();
    await expect(page.getByText('The composition is public: anybody reads it.')).toBeVisible();
    await expect(main(page).getByRole('radio', { name: 'Public' })).toBeChecked();

    // Fork the version shown (1.2.0, linked to checkout-flow) into QoS Lab: the problem link goes, on purpose.
    await main(page).getByRole('button', { name: 'Fork', exact: true }).click();
    const fork = page.getByRole('dialog', { name: 'Fork this composition' });
    await fork.getByRole('button', { name: 'Fork into', exact: true }).click();
    await expect(fork.getByRole('option', { name: /Read Lab/ })).toHaveCount(0);
    await fork.getByRole('option', { name: /ISA Demo Group/ }).click();
    // The source's own organization is offered by the selector but refused: a fork goes elsewhere.
    await expect(fork).toContainText('Forks go to another organization');
    await expect(fork.getByRole('button', { name: 'Next' })).toBeDisabled();
    await fork.getByRole('button', { name: 'Fork into', exact: true }).click();
    await fork.getByRole('option', { name: /QoS Lab/ }).click();
    await fork.getByRole('button', { name: 'Next' }).click();
    const problem = page.getByRole('dialog', { name: 'Fork it without its problem?' });
    await expect(problem).toContainText('QoS Lab cannot read');
    await problem.getByRole('button', { name: 'Fork without the problem' }).click();

    await expect(page).toHaveURL('/compositions/qos-lab/fleet-routing');
    await expect(page.getByText('Composition forked')).toBeVisible();
    const lineage = main(page).getByRole('list', { name: 'Lineage' });
    await expect(lineage).toContainText(
      'Forked from Fleet routing (version 1.2.0) · ISA Demo Group, without its problem'
    );
    await expect(lineage.getByRole('link')).toHaveAttribute(
      'href',
      '/compositions/isa-demo/fleet-routing?version=1.2.0'
    );
    await expect(region(page, 'Value status')).toContainText('Declared');
    expect(mock.unmocked).toEqual([]);
  });

  test('Settings rename, restore and delete a composition', async ({ page }) => {
    const mock = await installMockApi(page, 'admin');
    await page.goto(`${LIST}/legacy-intake/settings`);

    await main(page).getByLabel('Name', { exact: true }).fill('Legacy intake (old)');
    await main(page).getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Name and description saved.')).toBeVisible();
    await expect(
      main(page).getByRole('heading', { level: 1, name: 'Legacy intake (old)' })
    ).toBeVisible();

    await main(page).getByRole('switch', { name: 'Archived' }).click();
    await expect(page.getByText('Composition restored.')).toBeVisible();
    await expect(main(page).getByRole('switch', { name: 'Archived' })).toHaveAttribute(
      'aria-checked',
      'false'
    );

    await main(page).getByRole('button', { name: 'Delete composition' }).click();
    const dialog = page.getByRole('dialog', { name: 'Delete Legacy intake (old)?' });
    await expect(dialog.getByRole('button', { name: 'Delete permanently' })).toBeDisabled();
    await dialog.getByLabel('Type legacy-intake to confirm').fill('legacy-intake');
    await dialog.getByRole('button', { name: 'Delete permanently' }).click();
    await expect(page).toHaveURL(TAB);
    await expect(page.getByText('Composition “Legacy intake (old)” deleted.')).toBeVisible();
    await expect(main(page).getByRole('article').getByRole('heading', { level: 3 })).toHaveText([
      'Fleet routing',
      'Order desk',
    ]);
    expect(mock.unmocked).toEqual([]);
  });

  test('a composition that is not there reads the same as one that is not shared: the in-place 404', async ({
    page,
  }) => {
    await installMockApi(page, 'admin');
    await page.goto(`${LIST}/no-such-composition`);

    await expect(main(page).getByRole('heading', { name: 'Page not found' })).toBeVisible();
    await expect(main(page)).not.toContainText(/private/i);
  });

  test('a tab the composition page does not have is a page that does not exist', async ({
    page,
  }) => {
    await installMockApi(page, 'admin');
    await page.goto(`${LIST}/order-desk/nonsense`);

    await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();
  });
});
