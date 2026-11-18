import { expect, test, type Locator, type Page } from '@playwright/test';
import { API, ORG, OTHER_ORG, PROBLEMS_TAB, signInByApi, watchPageErrors } from './support';

/**
 * F3 against the lab and live SPHERE (anonymous, through the gateway; the browser never calls SPHERE):
 *
 * - J1/J2: a problem born from two SPHERE pricings, pinned to their recorded versions (Mailgun and Postmark of danruilop1, both
 *   `2026-10`), Postmark's own name for the monthly limit chosen in the mapping, previewed and created; its Candidates tab says
 *   where each value comes from;
 * - J4: the seeded `lab-main/tomatometer` draws its upstream plan from the stored snapshot with SPHERE's link and its storefront
 *   from the offering version its evaluation read; lab-other's `order-desk`, whose offering URL never resolves, says so in words;
 * - the registry path, when the lab names one (`SPHERE_REGISTRIES`): the search through the `score-mirror` alias;
 * - J3's refusal: with beta features on, the Connections tab sends an invalid key to SPHERE and shows its refusal (the lab has no
 *   real key).
 *
 * SPHERE may answer `sphere_busy`: the search waits for its Retry-After by itself, and a preview is asked once more after it.
 */

const MAILGUN = { pricing: '6ade364540e55445692b0eda', version: '6ade36454b2b5b01c587db3d' };
const POSTMARK = { pricing: '6ade2f3b40e55445692b09aa', version: '6ade2f3b4b2b5b01c587d8f5' };
const OWNER = 'danruilop1';

test.describe.configure({ mode: 'serial' });

const dialog = (page: Page) => page.getByRole('dialog').first();
const button = (page: Page, name: string) =>
  dialog(page).getByRole('button', { name, exact: true });

/**
 * Search SPHERE in the wizard until a row of `owner` is listed (waiting through a busy SPHERE), then open the pinned family by
 * the wizard's address: SPHERE's live catalogue may hold several families of one name and owner, and the walk is pinned to the
 * recorded one. The form so far is kept for the session, so the address lands on the same import.
 */
async function choose(page: Page, words: string, pricing: string) {
  await dialog(page).getByRole('combobox', { name: 'Search SPHERE pricings by name' }).fill(words);
  const row = dialog(page)
    .getByRole('listbox', { name: 'SPHERE pricings' })
    .getByRole('option')
    .filter({ hasText: OWNER })
    .first();
  await expect(row).toBeVisible({ timeout: 90_000 });
  const url = new URL(page.url());
  url.searchParams.set('sphereStep', 'version');
  url.searchParams.set('sphere', pricing);
  url.searchParams.delete('sphereVersion');
  await page.goto(url.toString());
  await expect(dialog(page).getByRole('radio').first()).toBeVisible({ timeout: 60_000 });
}

/** The pinned version, by its name, and the address that names it by id. */
async function pin(page: Page, version: string) {
  await dialog(page)
    .getByRole('radio', { name: /2026-10/ })
    .check();
  await button(page, 'Use this version').click();
  await expect(page).toHaveURL(new RegExp(`sphereVersion=${version}`));
}

/** Preview, asking once more after SPHERE's Retry-After when it is busy. */
async function preview(page: Page): Promise<Locator> {
  const done = dialog(page).getByText(
    /The generated version compiles|can’t generate a version yet/
  );
  const busy = dialog(page).getByText(/SPHERE is busy; preview again in (\d+) s/);
  await button(page, 'Preview').click();
  await expect(done.or(busy)).toBeVisible({ timeout: 120_000 });
  if (await busy.isVisible()) {
    const seconds = Number((await busy.textContent())?.match(/(\d+) s/)?.[1] ?? 10);
    await page.waitForTimeout(seconds * 1000 + 500);
    await dialog(page).getByRole('button', { name: 'Back' }).click();
    await button(page, 'Preview').click();
    await expect(done).toBeVisible({ timeout: 120_000 });
  }
  return done;
}

test.describe('live · F3 SPHERE candidates', () => {
  test('a problem born from two SPHERE pricings pinned to their versions, with every value’s source', async ({
    page,
  }) => {
    test.setTimeout(600_000);
    await signInByApi(page, 'owner');
    const errors = watchPageErrors(page);
    const name = `live-email-${Date.now().toString(36)}`;

    await page.goto(PROBLEMS_TAB);
    const tab = page.locator('main').getByRole('region', { name: 'Problems' });
    await tab.getByRole('button', { name: /^New/ }).click();
    await tab.getByRole('menuitem', { name: /From SPHERE/ }).click();
    await expect(
      dialog(page).getByRole('heading', { name: 'New problem from SPHERE' })
    ).toBeVisible();

    await choose(page, 'mailgun', MAILGUN.pricing);
    await pin(page, MAILGUN.version);
    await dialog(page).getByRole('textbox', { name: 'Name' }).fill(name);
    await dialog(page).getByRole('textbox', { name: 'Task' }).fill('notify');
    await dialog(page).getByRole('textbox', { name: 'Capability' }).fill('service/email');
    await expect(dialog(page).getByRole('checkbox', { name: /^ENTERPRISE/ })).toBeDisabled();
    await button(page, 'Add to the recipe').click();

    // A second pricing: back to the search, which keeps the recipe.
    await dialog(page).getByRole('button', { name: 'Back' }).click();
    await expect(
      dialog(page).getByRole('region', { name: 'Pricings in the recipe' })
    ).toContainText('mailgun');
    await choose(page, 'postmark', POSTMARK.pricing);
    await pin(page, POSTMARK.version);
    await expect(dialog(page).getByRole('textbox', { name: 'Provider key' })).toHaveValue(
      'postmark'
    );
    await button(page, 'Add to the recipe').click();

    // Mapping: the price, availability by hand, the monthly volume at least the demand (Postmark names it otherwise).
    await dialog(page).getByRole('spinbutton', { name: 'Every candidate' }).first().fill('0.999');
    await dialog(page).getByRole('button', { name: 'Add a demand' }).click();
    await dialog(page).getByRole('textbox', { name: 'Demand' }).fill('monthlyEmails');
    await dialog(page).getByRole('spinbutton', { name: 'Value' }).fill('30000');
    await dialog(page).getByRole('button', { name: 'Require a limit' }).click();
    await dialog(page)
      .getByRole('combobox', { name: 'Limit at least' })
      .selectOption('emailsPerMonth');
    await dialog(page).getByRole('combobox', { name: 'The demand' }).selectOption('monthlyEmails');
    await dialog(page)
      .getByRole('combobox', { name: /does not declare emailsPerMonth/ })
      .selectOption({ label: 'It calls it monthlyEmailVolumeLimit' });

    const done = await preview(page);
    await expect(done).toContainText('The generated version compiles');
    await expect(dialog(page).getByText(/added, 0 removed, 0 changed/)).toBeVisible();
    await button(page, 'Continue').click();
    await expect(dialog(page)).toContainText('Mailgun, version 2026-10');
    await button(page, 'Create problem').click();

    await expect(page).toHaveURL(new RegExp(`/problems/${ORG}/${name}/candidates\\?version=1$`), {
      timeout: 120_000,
    });
    await expect(page.getByText('Imported from SPHERE')).toBeVisible();
    const matrix = page.getByRole('region', { name: 'Candidates of each task' });
    await expect(matrix.getByText('Priced').first()).toBeVisible();
    await expect(matrix.getByRole('columnheader', { name: 'Properties' }).first()).toBeVisible();
    await expect(matrix.getByRole('link', { name: /Open in SPHERE/ }).first()).toHaveAttribute(
      'href',
      /^https:\/\/sphere\.score\.us\.es\/p\//
    );
    await expect(matrix).not.toContainText(/sha256-/);
    expect(errors).toEqual([]);
  });

  test('the seeded TomatoMeter draws its upstream plan and storefront; an unreadable offering says so', async ({
    page,
  }) => {
    test.setTimeout(240_000);
    await signInByApi(page, 'owner');
    await page.goto(`/compositions/${ORG}/tomatometer`);
    const plans = page.locator('main').getByRole('region', { name: 'Upstream plans', exact: true });
    const card = plans.getByRole('article').first();
    await expect(card.getByRole('link', { name: 'Open in SPHERE' })).toHaveAttribute(
      'href',
      /^https:\/\/sphere\.score\.us\.es\/p\/[0-9a-f]{24}\?version=[0-9a-f]{24}$/,
      { timeout: 60_000 }
    );
    await expect(card).toContainText('Version2026-10');
    await expect(card.locator('pricing-renderer')).toBeAttached();
    const offering = page.locator('main').getByRole('region', { name: 'Offering', exact: true });
    await expect(offering).toContainText(
      /Offering version .+, read when this version was evaluated\./
    );
    await expect(offering.getByTestId('storefront').locator('pricing-renderer')).toBeAttached();

    await page.goto(`/compositions/${OTHER_ORG}/order-desk`);
    await expect(
      page.locator('main').getByRole('region', { name: 'Offering', exact: true })
    ).toContainText('The offering could not be read when this version was evaluated.', {
      timeout: 60_000,
    });
  });

  test('the search goes through an operator registry when the lab names one', async ({ page }) => {
    test.setTimeout(240_000);
    await signInByApi(page, 'owner');
    await page.goto(`${PROBLEMS_TAB}?sphereStep=pricing`);
    await expect(dialog(page).getByRole('listbox', { name: 'SPHERE pricings' })).toBeVisible();
    await dialog(page).getByText('Filters').click();
    const registry = dialog(page).getByRole('combobox', { name: 'Registry' });
    await expect(dialog(page).getByRole('combobox', { name: 'Sort by' })).toBeVisible({
      timeout: 60_000,
    });
    if ((await registry.count()) === 0) {
      test.info().annotations.push({
        type: 'skipped-check',
        description: 'the lab names no SPHERE registry (SPHERE_REGISTRIES is {})',
      });
      return;
    }
    await registry.selectOption('score-mirror');
    await dialog(page)
      .getByRole('combobox', { name: 'Search SPHERE pricings by name' })
      .fill('tomato');
    await expect(
      dialog(page)
        .getByRole('listbox', { name: 'SPHERE pricings' })
        .getByRole('option')
        .filter({
          hasText: 'TomatoMeter',
        })
        .first()
    ).toBeVisible({ timeout: 90_000 });
  });

  test('with beta features on, the Connections tab shows SPHERE’s refusal of an invalid key', async ({
    page,
  }) => {
    test.setTimeout(240_000);
    const token = await signInByApi(page, 'owner');
    const headers = { Authorization: `Bearer ${token}` };
    const setting = `${API}/v1/users/me/settings/beta-features`;
    const toggle = async (enabled: boolean) => {
      const read = await page.request.get(setting, { headers });
      const etag = read.headers()['etag'];
      const written = await page.request.put(setting, {
        headers: {
          ...headers,
          'Content-Type': 'application/json',
          ...(etag ? { 'If-Match': etag } : {}),
        },
        data: { enabled },
      });
      expect(
        written.ok(),
        `beta features ${enabled ? 'on' : 'off'}: HTTP ${written.status()}`
      ).toBe(true);
    };
    await toggle(true);
    try {
      await page.goto(`/orgs/${ORG}/connections`);
      const tab = page.locator('main').getByRole('region', { name: 'Connections' });
      await expect(tab.getByRole('heading', { name: 'Connections' })).toBeVisible({
        timeout: 60_000,
      });
      await tab.getByLabel('SPHERE API key').fill(`sk-${'0'.repeat(64)}`);
      await tab.getByRole('button', { name: 'Connect' }).click();
      await expect(
        tab.getByText(/^SPHERE refused the key|could not be asked about the key/)
      ).toBeVisible({
        timeout: 90_000,
      });
      await expect(tab.getByLabel('SPHERE API key')).toBeVisible();
    } finally {
      await toggle(false);
    }
  });
});
