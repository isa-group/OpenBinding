import { expect as baseExpect, test, type Page, type Request } from '@playwright/test';
import { API, installMockApi } from './helpers/mockApi';

// J1 · a problem born from SPHERE, and J2 · TomatoMeter's candidates added from SPHERE, through the six-step wizard over the
// gateway's SPHERE routes. There is no backend: e2e/helpers/mockApi.ts answers the API origin, and every SPHERE answer
// (search, family, version, snapshot YAML, preview, apply, recipe) is a gateway-written fixture of src/test/fixtures/sphere
// (e2e/helpers/sphereMock.ts). The browser never calls SPHERE: an unmocked request and any request off the API origin fail.

const expect = baseExpect.configure({ timeout: 15_000 });
test.setTimeout(120_000);

const DROPBOX = '6ab0a323697330667ccce9c1';
const DROPBOX_2021 = '687e4b68102baa50f3a5c7b7';
const MAILGUN = '6ade364540e55445692b0eda';

const dialog = (page: Page) => page.getByRole('dialog');
const next = (page: Page, name: string | RegExp) =>
  dialog(page).getByRole('button', { name, exact: typeof name === 'string' });

/** What the page posted to a SPHERE route, by its last path segment. */
function watchPosts(page: Page) {
  const posts: Record<string, Array<Record<string, unknown>>> = {};
  const outside: string[] = [];
  page.on('request', (request: Request) => {
    const url = new URL(request.url());
    // The application's own origin and the mocked gateway; nothing else (SPHERE, a CDN) may be asked.
    if (url.origin !== API && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(url.origin))
      outside.push(request.url());
    if (request.method() !== 'POST' || !url.pathname.includes('/sphere/')) return;
    const action = url.pathname.split('/').pop() ?? '';
    (posts[action] ??= []).push(request.postDataJSON() as Record<string, unknown>);
  });
  return { posts, outside };
}

test.describe('J1 · a problem born from SPHERE', () => {
  test('Problems tab → From SPHERE → Dropbox 2021 → storage → create → its Candidates tab with SPHERE sources', async ({
    page,
  }) => {
    const handle = await installMockApi(page, 'admin');
    const { posts, outside } = watchPosts(page);
    await page.goto('/orgs/isa-demo/problems');
    const tab = page.locator('main').getByRole('region', { name: 'Problems' });
    await tab.getByRole('button', { name: /^New/ }).click();
    await tab.getByRole('menuitem', { name: /From SPHERE/ }).click();

    await expect(dialog(page)).toBeVisible();
    await expect(
      dialog(page).getByRole('heading', { name: 'New problem from SPHERE' })
    ).toBeVisible();
    await expect(page).toHaveURL(/sphereStep=pricing/);

    // 1 · Pricing: the gateway's search, by name, owner and latest version; never an id.
    await dialog(page)
      .getByRole('combobox', { name: 'Search SPHERE pricings by name' })
      .fill('Dropbox');
    const list = dialog(page).getByRole('listbox', { name: 'SPHERE pricings' });
    await expect(list.getByRole('option')).toHaveCount(4);
    await expect(list).not.toContainText(/[0-9a-f]{24}/);
    await list.getByRole('option').filter({ hasText: 'latest 2021' }).click();

    // 2 · Version: newest first by date, SPHERE's latest marked and chosen.
    await expect(page).toHaveURL(new RegExp(`sphere=${DROPBOX}`));
    await expect(dialog(page).getByRole('radio', { name: /2021/ })).toBeChecked();
    await expect(dialog(page).getByText('Latest')).toBeVisible();
    await next(page, 'Use this version').click();

    // 3 · Task and plans: a new problem, its task and capability, Dropbox's plans drawn and all importable.
    await expect(page).toHaveURL(new RegExp(`sphereVersion=${DROPBOX_2021}`));
    await expect(next(page, 'Add to the recipe')).toBeDisabled();
    await dialog(page).getByRole('textbox', { name: 'Name' }).fill('storage');
    await dialog(page).getByRole('textbox', { name: 'Task' }).fill('export');
    await dialog(page).getByRole('textbox', { name: 'Capability' }).fill('service/storage');
    await expect(dialog(page).getByRole('checkbox', { name: /^PLUS/ })).toBeChecked();
    await expect(dialog(page).getByRole('spinbutton', { name: 'Seats' })).toHaveValue('1');
    await next(page, 'Add to the recipe').click();

    // 4 · Mapping: subscription from the price, availability by hand, storage at least the demand.
    await expect(page).toHaveURL(/sphereStep=mapping/);
    await expect(
      dialog(page).getByRole('combobox', { name: 'Read subscription from' })
    ).toHaveValue('price');
    await dialog(page).getByRole('spinbutton', { name: 'Every dropbox plan' }).fill('0.999');
    await dialog(page).getByRole('button', { name: 'Add a demand' }).click();
    await dialog(page).getByRole('textbox', { name: 'Demand' }).fill('storageGB');
    await dialog(page).getByRole('spinbutton', { name: 'Value' }).fill('1000');
    await dialog(page).getByRole('textbox', { name: 'Unit' }).last().fill('GB');
    await dialog(page).getByRole('button', { name: 'Require a limit' }).click();
    await dialog(page)
      .getByRole('combobox', { name: 'Limit at least' })
      .selectOption('storageLimit');
    await dialog(page).getByRole('combobox', { name: 'The demand' }).selectOption('storageGB');
    await next(page, 'Preview').click();

    // 5 · Preview: the gateway's expansion, with sources; Dropbox 2021 has no private or unreadable plan.
    await expect(
      dialog(page).getByText(/The generated version compiles: 5 of 5 candidates/)
    ).toBeVisible();
    await expect(dialog(page).getByText(/5 added, 0 removed, 0 changed/)).toBeVisible();
    await expect(
      dialog(page).getByRole('region', { name: 'Candidate values' }).getByText('Priced').first()
    ).toBeVisible();
    const preview = posts.expand?.at(-1) as { recipe: Record<string, unknown>; base: unknown };
    expect(preview.base).toBeNull();
    expect(preview.recipe).toMatchObject({
      demand: { storageGB: { value: 1000, unit: 'GB' } },
      tasks: [
        {
          task: 'export',
          capability: 'service/storage',
          from: [
            { provider: 'dropbox', seats: 1, sphere: { pricing: DROPBOX, version: DROPBOX_2021 } },
          ],
          properties: { subscription: 'price', availability: { manual: { dropbox: 0.999 } } },
          require: { limits: { storageLimit: { atLeast: 'storageGB' } } },
        },
      ],
    });
    await next(page, 'Continue').click();

    // 6 · Generate: apply with the preview's package digest, then the new problem's Candidates tab.
    await next(page, 'Create problem').click();
    await expect(page).toHaveURL(/\/problems\/isa-demo\/storage\/candidates\?version=1$/);
    expect(posts.apply?.at(-1)).toMatchObject({
      base: null,
      name: 'storage',
      expect: { packageDigest: expect.stringMatching(/^sha256-/) },
    });
    await expect(page.getByText('Imported from SPHERE')).toBeVisible();
    await expect(page.getByText(/was generated from SPHERE \(Dropbox 2021\)/)).toBeVisible();
    await expect(page.getByRole('link', { name: 'Open in the problem editor' })).toHaveAttribute(
      'href',
      /\/problem-editor\?org=isa-demo&problem=storage&revision=1/
    );
    await expect(page.locator('main').getByText('Priced').first()).toBeVisible();
    expect(outside).toEqual([]);
    expect(handle.unmocked).toEqual([]);
  });

  test('the wizard is a full-screen sheet on a phone, with no horizontal overflow', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await installMockApi(page, 'admin');
    await page.goto('/orgs/isa-demo/problems?sphereStep=pricing');
    await expect(dialog(page)).toBeVisible();
    await expect
      .poll(async () => Math.round((await dialog(page).boundingBox())?.width ?? 0))
      .toBe(390);
    await dialog(page)
      .getByRole('combobox', { name: 'Search SPHERE pricings by name' })
      .fill('Dropbox');
    await expect(
      dialog(page).getByRole('listbox', { name: 'SPHERE pricings' }).getByRole('option')
    ).toHaveCount(4);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});

test.describe('J2 · TomatoMeter: candidates added from SPHERE to an existing problem', () => {
  test('New version ▾ → Add candidates from SPHERE → Mailgun → mapping → preview → generate, with a 409 reloaded', async ({
    page,
  }) => {
    const handle = await installMockApi(page, 'admin');
    const { posts, outside } = watchPosts(page);
    await page.goto('/problems/isa-demo/tomatometer-email/candidates');
    await page.getByRole('button', { name: 'New version' }).click();
    await expect(page.getByRole('menuitem', { name: /Update from SPHERE/ })).toBeVisible();
    await page.getByRole('menuitem', { name: /Add candidates from SPHERE/ }).click();
    await expect(
      dialog(page).getByRole('heading', { name: 'Add candidates from SPHERE' })
    ).toBeVisible();

    await dialog(page)
      .getByRole('combobox', { name: 'Search SPHERE pricings by name' })
      .fill('mailgun');
    await dialog(page).getByRole('option').filter({ hasText: 'danruilop1 PERSONAL' }).click();
    await expect(page).toHaveURL(new RegExp(`sphere=${MAILGUN}`));
    await next(page, 'Use this version').click();

    // A plan the summary marks private is shown, disabled, with its reason; metered add-ons are listed apart.
    const enterprise = dialog(page).getByRole('checkbox', { name: /^ENTERPRISE/ });
    await expect(enterprise).toBeDisabled();
    await expect(dialog(page).getByText('Private in this pricing')).toBeVisible();
    await expect(dialog(page).getByText('Charged per use, not imported')).toBeVisible();
    await dialog(page).getByRole('combobox', { name: 'Task' }).selectOption('dailySummary');
    await dialog(page).getByRole('textbox', { name: 'Capability' }).fill('service/email');
    await next(page, 'Add to the recipe').click();

    // Mapping: the problem's features, availability from the guarantee's table, latency by hand, the demand.
    await expect(page).toHaveURL(/sphereStep=mapping/);
    await dialog(page)
      .getByRole('combobox', { name: 'Read availability from' })
      .selectOption('guarantee');
    await dialog(page)
      .getByRole('combobox', { name: 'The guarantee availability reads' })
      .selectOption('guaranteedUptimeSla');
    await dialog(page)
      .getByRole('spinbutton', { name: 'When guaranteedUptimeSla is yes' })
      .fill('0.9995');
    await dialog(page)
      .getByRole('spinbutton', { name: 'When guaranteedUptimeSla is no' })
      .fill('0.99');
    await dialog(page).getByRole('spinbutton', { name: 'Every candidate' }).fill('250');
    for (const [name, value, unit] of [
      ['monthlyEmails', '30000', 'email/month'],
      ['dailyEmails', '1000', 'email/day'],
    ]) {
      await dialog(page).getByRole('button', { name: 'Add a demand' }).click();
      await dialog(page).getByRole('textbox', { name: 'Demand' }).last().fill(name);
      await dialog(page).getByRole('spinbutton', { name: 'Value' }).last().fill(value);
      await dialog(page).getByRole('textbox', { name: 'Unit' }).last().fill(unit);
    }
    for (const [limit, demand] of [
      ['emailsPerMonth', 'monthlyEmails'],
      ['emailsPerDay', 'dailyEmails'],
    ]) {
      await dialog(page).getByRole('button', { name: 'Require a limit' }).click();
      await dialog(page)
        .getByRole('combobox', { name: 'Limit at least' })
        .last()
        .selectOption(limit);
      await dialog(page).getByRole('combobox', { name: 'The demand' }).last().selectOption(demand);
    }

    // The step, the pricing and what was entered survive a reload of the page.
    await page.reload();
    await expect(dialog(page)).toBeVisible();
    await expect(page).toHaveURL(/sphereStep=mapping/);
    await expect(dialog(page).getByRole('spinbutton', { name: 'Every candidate' })).toHaveValue(
      '250'
    );

    // A preview with an error keeps Generate away.
    await page.route(
      `${API}/v1/organizations/isa-demo/problems/tomatometer-email/sphere/expand`,
      route =>
        route.fulfill({
          status: 200,
          json: {
            valid: false,
            candidates: [],
            changes: { added: [], removed: [], changed: [] },
            diagnostics: [
              {
                at: '/tasks/0/from/0',
                code: 'sphere_currency_mismatch',
                message: 'This pricing is in EUR; the recipe is in USD.',
                severity: 'error',
              },
            ],
            facts: null,
            packageDigest: null,
            recipe: null,
            recipeDigest: null,
            snapshots: [],
          },
        })
    );
    await next(page, 'Preview').click();
    await expect(dialog(page).getByText(/can’t generate a version yet/)).toBeVisible();
    await expect(
      dialog(page).getByText('This pricing is in EUR; the recipe is in USD.')
    ).toBeVisible();
    await expect(next(page, 'Continue')).toBeDisabled();
    await page.unroute(`${API}/v1/organizations/isa-demo/problems/tomatometer-email/sphere/expand`);

    // Back and forward asks the gateway again: Changes and the ineligible plans explained.
    await dialog(page).getByRole('button', { name: 'Back' }).click();
    await dialog(page).getByRole('spinbutton', { name: 'Every candidate' }).fill('260');
    await next(page, 'Preview').click();
    await expect(dialog(page).getByText(/17 added, 0 removed, 0 changed/)).toBeVisible();
    await expect(
      dialog(page)
        .locator('li')
        .filter({ has: page.locator('code', { hasText: /^email\.brevo\.free$/ }) })
    ).toContainText('emailsPerDay: 300 < 1000');
    expect(posts.expand?.at(-1)).toMatchObject({ base: { revision: 2 } });
    await next(page, 'Continue').click();

    // Generate: a 409 says another version was added and offers to reload; then the revision is added.
    let refused = false;
    await page.route(
      `${API}/v1/organizations/isa-demo/problems/tomatometer-email/sphere/apply`,
      async route => {
        if (refused) return route.fallback();
        refused = true;
        await route.fulfill({
          status: 409,
          json: {
            detail: { code: 'revision_moved', error: 'The latest revision is 3.', latest: 3 },
          },
        });
      }
    );
    await next(page, 'Generate revision').click();
    await expect(
      dialog(page).getByText(/Another version was added since the preview/)
    ).toBeVisible();
    await dialog(page).getByRole('button', { name: 'Reload and preview again' }).click();
    await next(page, 'Generate revision').click();
    await expect(page.getByText('Revision 2 added from SPHERE.')).toBeVisible();
    await expect(page).toHaveURL(/\/problems\/isa-demo\/tomatometer-email\/candidates\?version=2$/);
    await expect(dialog(page)).toHaveCount(0);
    expect(posts.apply?.at(-1)).toMatchObject({ base: { revision: 2 } });
    expect(outside).toEqual([]);
    expect(handle.unmocked).toEqual([]);
  });

  test('Escape asks before discarding what was entered', async ({ page }) => {
    await installMockApi(page, 'admin');
    await page.goto('/problems/isa-demo/tomatometer-email/candidates');
    await page.getByRole('button', { name: 'New version' }).click();
    await page.getByRole('menuitem', { name: /Add candidates from SPHERE/ }).click();
    await dialog(page)
      .getByRole('combobox', { name: 'Search SPHERE pricings by name' })
      .fill('mailgun');
    await dialog(page).getByRole('option').filter({ hasText: 'danruilop1 PERSONAL' }).click();
    // The version step has arrived (and holds the focus trap) before Escape is pressed.
    await expect(dialog(page).getByRole('radio', { name: /2026-10/ })).toBeVisible();
    await dialog(page)
      .getByRole('radio', { name: /2026-10/ })
      .focus();
    await page.keyboard.press('Escape');
    const confirm = page.getByRole('alertdialog').or(page.getByRole('dialog', { name: /Discard/ }));
    await expect(
      confirm.getByText('Discard the pricings and choices of this import?')
    ).toBeVisible();
    await confirm.getByRole('button', { name: 'Keep editing' }).click();
    await expect(page.getByRole('dialog', { name: 'Add candidates from SPHERE' })).toBeVisible();
  });
});
