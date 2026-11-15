import { expect as baseExpect, test, type Page } from '@playwright/test';
import { API, installMockApi } from './helpers/mockApi';

// J5 · evolution: Versions → Evolution → date filter. A composition declared first, with its costs in EUR/month, then linked to a
// problem (verified values, costs in USD/month), then to the problem's next revision, whose last version the installed toolchain
// no longer verifies. The charts keep verified, declared and unverified apart, give each unit its own chart, mark where the link
// and the problem revision changed, narrow the versions the gateway is asked for to the days chosen, and say each chart as a table.
// There is no backend: e2e/helpers/mockApi.ts answers the API origin, with Notification hub from e2e/helpers/mockCompositions.ts.

const expect = baseExpect.configure({ timeout: 15_000 });

const VERSIONS = '/app/isa-demo/compositions/notification-hub/versions';
const main = (page: Page) => page.locator('#platform-main');

/** The queries of every versions list the charts asked for (`include=analytics`). */
function chartReads(page: Page): URLSearchParams[] {
  const reads: URLSearchParams[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.origin === API && url.pathname.endsWith('/compositions/notification-hub/versions') && url.searchParams.get('include') === 'analytics') {
      reads.push(url.searchParams);
    }
  });
  return reads;
}

test.describe('J5 · evolution', () => {
  test('the Versions tab charts how the structure and the values evolved, by date range, as charts and as tables', async ({ page }) => {
    const mock = await installMockApi(page, 'admin', { evolution: true });
    await page.setViewportSize({ width: 1440, height: 900 });
    const reads = chartReads(page);
    await page.goto(VERSIONS);

    await main(page).getByRole('group', { name: 'Versions view' }).getByRole('button', { name: 'Evolution' }).click();
    await expect(page).toHaveURL(`${VERSIONS}?view=evolution`);
    const charts = main(page).getByRole('region', { name: 'Evolution', exact: true });
    await expect(charts.getByText('5 versions, oldest first.')).toBeVisible();
    expect(reads.at(-1)?.get('order')).toBe('oldest');
    const figure = (name: string) => charts.getByRole('figure', { name, exact: true });

    // Structure: one stepped chart per stored count, and whether each version named an offering.
    await expect(figure('Tasks')).toBeVisible();
    await expect(figure('Choice blocks')).toBeVisible();
    await expect(charts.getByRole('list', { name: 'Offering per version' }).getByRole('listitem')).toHaveText([
      /1\.0\.0\s*No offering/, /1\.1\.0\s*Offering named/, /2\.0\.0\s*No offering/, /2\.1\.0\s*No offering/, /2\.2\.0\s*No offering/,
    ]);

    // Values: a unit change splits a value in two charts; the three statuses are separate series with their own marks.
    await expect(figure('cost · EUR/month')).toBeVisible();
    await expect(figure('cost · USD/month')).toBeVisible();
    await expect(figure('latency · ms')).toBeVisible();
    await expect(charts.getByRole('group', { name: 'Value statuses shown' }).getByRole('button')).toHaveText(['Verified', 'Declared', 'Unverified']);
    const availability = figure('availability · number');
    await expect(availability.locator('.ec-dot.is-declared')).toHaveCount(2);
    await expect(availability.locator('.ec-dot.is-verified')).toHaveCount(2);
    await expect(availability.locator('.ec-dot.is-unverified')).toHaveCount(1);

    // The link and the problem revision changes are marked on the charts and said in words.
    const marked = charts.locator('.ec-markers');
    await expect(marked.getByRole('listitem')).toHaveText([
      /2\.0\.0.*Linked to checkout-flow@1 \(“linked”\)/,
      /2\.1\.0.*Problem checkout-flow@1 to checkout-flow@2 \(“problem r1 → r2”\)/,
    ]);
    await expect(figure('cost · USD/month').locator('.recharts-reference-line text')).toHaveText(['linked', 'problem r1 → r2']);

    // The date filter narrows what the gateway is asked for.
    await charts.getByLabel('From').fill('2026-08-01');
    await expect(charts.getByText('3 versions in this date range, oldest first.')).toBeVisible();
    expect(reads.at(-1)?.get('created_after')).toBe('2026-08-01T00:00:00Z');
    await expect(figure('cost · EUR/month')).toHaveCount(0);
    await charts.getByLabel('To').fill('2026-09-30');
    await expect(charts.getByText('2 versions in this date range, oldest first.')).toBeVisible();
    expect(reads.at(-1)?.get('created_before')).toBe('2026-10-01T00:00:00Z');

    // Each chart says the same as a table.
    const usd = figure('cost · USD/month');
    await usd.getByRole('button', { name: 'Show as table' }).click();
    await expect(usd.getByRole('table').locator('tbody tr')).toHaveText([/2\.0\.0.*31 USD\/month.*Verified/, /2\.1\.0.*29 USD\/month.*Verified/]);
    await usd.getByRole('button', { name: 'Show as chart' }).click();
    await expect(usd.locator('.ec-plot')).toBeVisible();

    // A range with no version says so; Clear brings every version back.
    await charts.getByLabel('To').fill('');
    await charts.getByLabel('From').fill('2026-11-01');
    await expect(charts.getByText('No versions in this date range.')).toBeVisible();
    await charts.getByRole('button', { name: 'Clear' }).click();
    await expect(charts.getByText('5 versions, oldest first.')).toBeVisible();
    expect(reads.at(-1)?.has('created_after')).toBe(false);

    // By version, the axis names the versions.
    await charts.getByRole('group', { name: 'Horizontal axis' }).getByRole('button', { name: 'By version' }).click();
    await expect(figure('cost · USD/month').locator('.recharts-xAxis .recharts-cartesian-axis-tick-value')).toHaveText(['1.0.0', '1.1.0', '2.0.0', '2.1.0', '2.2.0']);
    expect(mock.unmocked).toEqual([]);
  });

  test('on a phone the charts stack in one column', async ({ page }) => {
    const mock = await installMockApi(page, 'admin', { evolution: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${VERSIONS}?view=evolution`);

    const charts = main(page).getByRole('region', { name: 'Evolution', exact: true });
    const first = charts.getByRole('figure', { name: 'Tasks', exact: true });
    const second = charts.getByRole('figure', { name: 'Bound tasks', exact: true });
    await expect(second).toBeVisible();
    const [a, b] = [await first.boundingBox(), await second.boundingBox()];
    expect(a && b && Math.abs(a.x - b.x) < 1 && b.y > a.y).toBe(true);
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(width).toBeLessThanOrEqual(390);
    expect(mock.unmocked).toEqual([]);
  });
});
