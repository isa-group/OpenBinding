import { readFileSync } from 'node:fs';
import { expect as baseExpect, test, type Page, type Route } from '@playwright/test';
import { API, installMockApi } from './helpers/mockApi';

// F6 · upstream events on the screens (J1, J2, J2b, J6, J7), at desktop and phone width. TomatoMeter's watched pricings
// changed upstream: Brevo raised PROFESSIONAL (values changed, on 1.0.0, in effect in production) and the TomatoMeter
// offering published 1.2.0 (offering changed). The notification opens the event in place on the Operation tab; the badges
// count what the gateway counts; the event says the change in words and draws the plan before and after; a member marks it
// reviewed, a VIEWER cannot; Brevo then retires PROFESSIONAL (rebinding recommended, the older event superseded); a vanished
// family and a withdrawn version are said as such; the dashboard and the inbox list them; a live notification refreshes the
// badges and its toast opens the event. There is no backend: e2e/helpers/mockApi.ts answers with the gateway's F6 fixtures
// (src/test/fixtures/core/upstream.*.json) through e2e/helpers/operationMock.ts.

const expect = baseExpect.configure({ timeout: 15_000 });
test.setTimeout(120_000);

const core = <T>(file: string): T =>
  JSON.parse(
    readFileSync(new URL(`../src/test/fixtures/core/${file}`, import.meta.url), 'utf8')
  ) as T;

const VALUES = '00000000-0000-4000-8000-000000000047';
const RETIRED = '00000000-0000-4000-8000-000000000051';
const OFFERING = '00000000-0000-4000-8000-000000000053';
const UNAVAILABLE = '00000000-0000-4000-8000-000000000054';
const WITHDRAWN = '00000000-0000-4000-8000-000000000056';
const PAGE = '/compositions/isa-demo/tomatometer';
const OPERATION = `${PAGE}/operation`;

/** The gateway's UpstreamEvent notification, under the mock's organization. */
const [told] = core<Array<{ payload: Record<string, unknown> } & Record<string, unknown>>>(
  'upstream.notifications.json'
);
const NOTIFICATION = { ...told, payload: { ...told.payload, organization: 'isa-demo' } };

const main = (page: Page) => page.locator('main');
const environment = (page: Page, name: string) =>
  main(page).getByRole('article', { name: `Environment ${name}` });

/** The inbox's list answers TomatoMeter's upstream notification (the bell's as well). */
async function tellInbox(page: Page) {
  await page.route(new RegExp(`^${API}/v1/notifications(\\?.*)?$`), (route: Route) =>
    route.fulfill({ json: [NOTIFICATION] })
  );
}

for (const [width, viewport] of [
  ['desktop', { width: 1440, height: 900 }],
  ['phone', { width: 390, height: 844 }],
] as const) {
  test.describe(`J1 · upstream changes are told and counted (${width})`, () => {
    test.use({ viewport });

    test('the badges count the open events, and the event says the change in words and draws the plan', async ({
      page,
    }) => {
      await installMockApi(page, 'admin', { tomatometer: true, upstream: true });
      await page.goto(PAGE);
      await expect(main(page).getByRole('link', { name: '2 upstream changes' })).toBeVisible();

      await page.goto('/orgs/isa-demo/compositions');
      await expect(main(page).getByRole('article', { name: 'TomatoMeter' })).toContainText(
        '2 upstream changes'
      );

      await page.goto(OPERATION);
      await expect(environment(page, 'Production')).toContainText('2 upstream changes');
      await expect(environment(page, 'Staging')).not.toContainText('upstream change');
      const rows = main(page).getByRole('list', { name: 'Upstream events' });
      await expect(rows.getByRole('listitem')).toHaveCount(2);
      await rows.getByRole('link', { name: 'brevo 2026-10 → 2026-11' }).click();
      await expect(page).toHaveURL(`${OPERATION}?event=${VALUES}`);
      await expect(main(page).getByRole('heading', { level: 2, name: 'brevo' })).toBeVisible();
      await expect(main(page).getByRole('region', { name: 'Global values' })).toContainText(
        'subscription 508.99 → 558.99 USD/month, +50.00'
      );
      await expect(main(page).getByRole('row', { name: /Price/ })).toContainText('+50.00');
      await expect(main(page).getByRole('list', { name: 'Notes' })).toContainText(
        'Nothing was re-evaluated'
      );
      // pricing-renderer draws PROFESSIONAL before and after, read only.
      await expect(main(page).locator('pricing-change-review')).toHaveCount(1);
    });

    test('J2 · a member marks it reviewed with a note; the badge and the event say so', async ({
      page,
    }) => {
      const mock = await installMockApi(page, 'admin', { tomatometer: true, upstream: true });
      await page.goto(`${OPERATION}?event=${VALUES}`);
      await main(page).getByRole('button', { name: 'Mark reviewed' }).click();
      const dialog = page.getByRole('dialog', { name: 'Mark reviewed' });
      await dialog.getByRole('textbox', { name: 'Note' }).fill('Seen; re-solving');
      await expect(dialog).toContainText('16 of 1000 characters');
      await dialog.getByRole('button', { name: 'Mark reviewed' }).click();
      await expect(page.getByText('brevo 2026-10 → 2026-11 marked reviewed.')).toBeVisible();
      await expect(main(page).getByText('“Seen; re-solving”')).toBeVisible();
      await expect(main(page).getByRole('button', { name: 'Mark reviewed' })).toHaveCount(0);
      expect(mock.operation?.upstream?.reviewed).toEqual([
        { id: VALUES, note: 'Seen; re-solving', ifMatch: `"event-${VALUES}-open"` },
      ]);
      // The offering change is still open; the Brevo one counts as reviewed.
      await main(page)
        .getByRole('link', { name: /All upstream changes/ })
        .click();
      await expect(environment(page, 'Production')).toContainText('1 upstream change');
      await expect(
        main(page)
          .getByRole('list', { name: 'Upstream events' })
          .getByRole('listitem')
          .filter({ hasText: 'brevo' })
      ).toContainText('Reviewed');
    });

    test('J2 · a VIEWER reads the event and is offered nothing to do', async ({ page }) => {
      await installMockApi(page, 'admin', { tomatometer: true, upstream: true, role: 'VIEWER' });
      await page.goto(`${OPERATION}?event=${VALUES}`);
      await expect(main(page).getByRole('heading', { level: 2, name: 'brevo' })).toBeVisible();
      await expect(main(page).getByRole('button', { name: 'Mark reviewed' })).toHaveCount(0);
      await expect(main(page).getByRole('link', { name: 'Open the configurator' })).toHaveCount(0);
    });

    test('J2b · Brevo retires PROFESSIONAL: rebinding recommended, the older change superseded', async ({
      page,
    }) => {
      const mock = await installMockApi(page, 'admin', { tomatometer: true, upstream: true });
      mock.operation?.upstream?.publish('binding-invalid');
      await page.goto(OPERATION);
      await expect(environment(page, 'Production')).toContainText('Rebinding recommended');
      const rows = main(page).getByRole('list', { name: 'Upstream events' });
      await expect(rows.getByRole('listitem').filter({ hasText: '2026-11' })).toContainText(
        'superseded by a newer upstream version'
      );
      await rows.getByRole('link', { name: 'brevo 2026-10 → 2027-01' }).click();
      await expect(page).toHaveURL(`${OPERATION}?event=${RETIRED}`);
      await expect(main(page).getByRole('region', { name: 'Why' })).toContainText(
        'Plan PROFESSIONAL is no longer offered.'
      );
      await expect(
        main(page).getByText(/^Rebinding recommended: what the version binds/)
      ).toBeVisible();
    });

    test('J6 · the offering changed: its plans before and after, and the margins in production', async ({
      page,
    }) => {
      await installMockApi(page, 'admin', { tomatometer: true, upstream: true });
      await page.goto(`${OPERATION}?event=${OFFERING}`);
      await expect(
        main(page).getByRole('heading', { level: 2, name: 'TomatoMeter' })
      ).toBeVisible();
      await expect(
        main(page).getByRole('region', { name: 'Offering plans', exact: true })
      ).toContainText('1 plan changed');
      const margins = main(page).getByRole('region', { name: 'Margins in production' });
      await expect(margins.getByRole('table')).toHaveCount(2);
      await expect(margins.getByRole('table').first()).toContainText('−0.51');
      await expect(margins.getByRole('table').last()).toContainText('0.48');
      await expect(
        main(page).getByText(
          'The offering is not pinned in the document; this event ends when reviewed.'
        )
      ).toBeVisible();
      await expect(main(page).getByRole('link', { name: 'Update from SPHERE' })).toHaveCount(0);
    });

    test('J7 · a vanished family and a withdrawn version are said as such', async ({ page }) => {
      await installMockApi(page, 'admin', { tomatometer: true, upstream: true });
      await page.goto(`${OPERATION}?event=${UNAVAILABLE}`);
      await expect(main(page).getByRole('region', { name: 'Why' })).toContainText(
        'Source unavailable: the pricing is no longer readable in SPHERE (hidden, private or deleted).'
      );
      await page.goto(`${OPERATION}?event=${WITHDRAWN}`);
      await expect(main(page).getByRole('region', { name: 'Why' })).toContainText(
        'the pinned version is no longer listed'
      );
    });

    test('J7 · the dashboard lists the open changes and the inbox filters them; the notification opens the event', async ({
      page,
    }) => {
      await installMockApi(page, 'admin', { tomatometer: true, upstream: true });
      await tellInbox(page);
      await page.goto('/');
      const changes = main(page).getByRole('region', { name: 'Upstream changes' });
      await expect(changes.getByRole('link', { name: /brevo 2026-10 → 2026-11/ })).toBeVisible();
      await page.goto('/notifications');
      await main(page)
        .getByRole('group', { name: 'Kind' })
        .getByRole('button', { name: 'Upstream changes' })
        .click();
      await main(page)
        .getByRole('button', { name: /^brevo 2026-11: TomatoMeter values changed/ })
        .click();
      await expect(page).toHaveURL(`${OPERATION}?event=${VALUES}`);
      await expect(main(page).getByRole('heading', { level: 2, name: 'brevo' })).toBeVisible();
    });
  });
}

test.describe('J1 · a live notification refreshes the badges', () => {
  test('the toast of an UpstreamEvent opens the event, and the environment’s badge is read again', async ({
    page,
  }) => {
    const mock = await installMockApi(page, 'admin', { tomatometer: true, upstream: true });
    let tell = false;
    // The stream: connected only, until the spec has Brevo retire PROFESSIONAL; then that notification.
    await page.route(new RegExp(`^${API}/v1/notifications/stream\\?.*$`), (route: Route) =>
      route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
        body: tell
          ? `event: connected\ndata: {}\n\nevent: notification\ndata: ${JSON.stringify({
              ...NOTIFICATION,
              id: 'n-live',
              subject: 'brevo 2027-01: TomatoMeter rebinding recommended',
              payload: { ...NOTIFICATION.payload, event: RETIRED, category: 'binding_invalid' },
            })}\n\n`
          : 'event: connected\ndata: {}\n\n',
      })
    );
    await page.goto(OPERATION);
    await expect(environment(page, 'Production')).toContainText('2 upstream changes');
    mock.operation?.upstream?.publish('binding-invalid');
    tell = true;
    const toast = page.getByRole('link', {
      name: 'brevo 2027-01: TomatoMeter rebinding recommended',
    });
    await expect(toast).toBeVisible({ timeout: 30_000 });
    await expect(environment(page, 'Production')).toContainText('Rebinding recommended');
    await toast.click();
    await expect(page).toHaveURL(`${OPERATION}?event=${RETIRED}`);
  });
});
