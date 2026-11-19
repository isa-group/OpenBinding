import { expect as baseExpect, test, type Page } from '@playwright/test';
import { installMockApi } from './helpers/mockApi';

// J4 · upstream plans and the offering: TomatoMeter's Overview draws each upstream plan from the snapshot the gateway stored
// (its version name, "Open in SPHERE") and its storefront from the offering version the evaluation read; the catalog says which
// sources each global value has; the version comparison draws a changed upstream plan through the plan change review; an
// offering read from an unreachable URL is said in words. There is no backend: e2e/helpers/mockApi.ts answers the API origin
// with the gateway's fixtures (core/tomatometer-email.version.json and .upstream.json, the recorded SPHERE versions), and
// nothing reaches SPHERE: a request off the application's origins fails the walk.

const expect = baseExpect.configure({ timeout: 15_000 });
test.setTimeout(90_000);

const TOMATOMETER = '/compositions/isa-demo/tomatometer';
const region = (page: Page, name: string) =>
  page.locator('main').getByRole('region', { name, exact: true });

function watchOrigins(page: Page) {
  const outside: string[] = [];
  page.on('request', request => {
    const origin = new URL(request.url()).origin;
    if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) outside.push(request.url());
  });
  return outside;
}

test.describe('J4 · upstream plans and the offering drawn from snapshots', () => {
  test('a member reads the upstream plan card, the value sources and the storefront of the offering version read', async ({
    page,
  }) => {
    const handle = await installMockApi(page, 'admin', { tomatometer: true });
    const outside = watchOrigins(page);
    await page.goto(`${TOMATOMETER}?version=1.0.0`);

    await expect(region(page, 'Binding')).toContainText(
      'From brevo on SPHERE, plan PROFESSIONAL, version 2026-10'
    );
    await expect(region(page, 'Binding')).toContainText(
      'From Dropbox on SPHERE, plan PLUS, version 2021'
    );
    await expect(region(page, 'Binding')).not.toContainText(/[0-9a-f]{24}/);
    const latency = region(page, 'Values').getByRole('list', { name: 'Where latency comes from' });
    await expect(latency).toContainText('Manual');
    await expect(latency).toContainText('Set by hand only');
    await expect(
      region(page, 'Values').getByRole('list', { name: 'Where subscription comes from' })
    ).toContainText('Priced');

    const offering = region(page, 'Offering');
    await expect(offering).toContainText(
      'Offering version 1.0.0, read when this version was evaluated.'
    );
    await expect(offering.getByTestId('storefront').locator('pricing-renderer')).toBeAttached();

    const card = region(page, 'Upstream plans').getByRole('article', { name: 'Plan PROFESSIONAL' });
    await expect(card).toContainText('brevo');
    await expect(card).toContainText('Version2026-10');
    await expect(card.getByRole('link', { name: 'Open in SPHERE' })).toHaveAttribute(
      'href',
      'https://sphere.score.us.es/p/6ade2d4440e55445692b07f1?version=6ade2d444b2b5b01c587d80d'
    );
    await expect(card.locator('pricing-renderer')).toBeAttached();
    const storage = region(page, 'Upstream plans').getByRole('article', { name: 'Plan PLUS' });
    await expect(storage).toContainText('Dropbox');
    await expect(storage).toContainText('Version2021');
    expect(outside).toEqual([]);
    expect(handle.unmocked).toEqual([]);
  });

  test('a visitor of the public composition sees the same plan card and storefront, from public snapshots', async ({
    page,
  }) => {
    await installMockApi(page, 'none', { tomatometer: true });
    const outside = watchOrigins(page);
    await page.goto(`${TOMATOMETER}?version=1.0.0`);
    const card = region(page, 'Upstream plans').getByRole('article', { name: 'Plan PROFESSIONAL' });
    await expect(card.getByRole('link', { name: 'Open in SPHERE' })).toBeVisible();
    await expect(region(page, 'Offering')).toContainText('Offering version 1.0.0');
    await expect(region(page, 'Offering').getByTestId('storefront')).toBeAttached();
    expect(outside).toEqual([]);
  });

  test('the version comparison draws an upstream plan that changes through the plan change review', async ({
    page,
  }) => {
    await installMockApi(page, 'admin', { tomatometer: true });
    await page.goto(`${TOMATOMETER}/versions?version=1.1.0&from=1.0.0&to=1.1.0`);
    const changes = page.getByRole('region', { name: 'Upstream plans that change' });
    await expect(changes).toBeVisible();
    await expect(changes.locator('pricing-change-review')).toBeAttached();
  });

  test('an offering read from an unreachable URL is said in words, and the version keeps its plans', async ({
    page,
  }) => {
    await installMockApi(page, 'admin');
    await page.goto('/compositions/isa-demo/order-desk?version=1.2.0');
    await expect(region(page, 'Offering')).toContainText(
      'The offering could not be read when this version was evaluated.'
    );
    await expect(region(page, 'Offering').getByTestId('storefront')).toHaveCount(0);
    const starter = region(page, 'Upstream plans').getByRole('article', { name: 'Plan STARTER' });
    await expect(starter).toContainText('Version2026-10');
  });
});
