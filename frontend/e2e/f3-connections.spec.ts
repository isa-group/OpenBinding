import { expect as baseExpect, test, type Page, type Route } from '@playwright/test';
import { API, installMockApi } from './helpers/mockApi';
import { fixture } from './helpers/sphereMock';

// J3 · an organization connects its SPHERE key, in the beta Connections tab: with beta features on, an ADMIN pastes a key,
// SPHERE (through the gateway) refuses a bad one in its own words and accepts a good one, the tab says whose key it is and
// what it may read, and the wizard's search then offers the organization's SPHERE organizations; the key is removed again.
// Without beta features, or below ADMIN, the tab is the in-place 404. There is no backend: e2e/helpers/mockApi.ts answers the
// API origin and this spec answers the connection's writes.

const expect = baseExpect.configure({ timeout: 15_000 });
test.setTimeout(90_000);

const GOOD = `sk-${'a1'.repeat(32)}`;
const REFUSED = `sk-${'0'.repeat(64)}`;
const CONNECTIONS = `${API}/v1/organizations/isa-demo/connections`;

/** Beta features on, and the organization's connection as this spec's own state. */
async function connectable(page: Page) {
  await page.route(`${API}/v1/users/me/settings/beta-features`, route =>
    route.fulfill({ json: { enabled: true }, headers: { ETag: '"r1"' } })
  );
  let connection: Record<string, unknown> | null = null;
  const sent: Array<{ method: string; key?: string; ifMatch?: string }> = [];
  const answer = async (route: Route) => {
    const request = route.request();
    const method = request.method();
    if (method === 'GET')
      return route.fulfill({ json: { connections: connection ? [connection] : [] } });
    if (method === 'DELETE') {
      sent.push({ method });
      connection = null;
      return route.fulfill({ status: 204 });
    }
    const key = (request.postDataJSON() as { apiKey: string }).apiKey;
    sent.push({ method, key, ifMatch: request.headers()['if-match'] });
    if (key === REFUSED)
      return route.fulfill({
        status: 422,
        json: { detail: { code: 'sphere_key_rejected', error: 'The API key is not valid.' } },
      });
    connection = {
      kind: 'sphere',
      status: 'active',
      username: 'sphere-lab',
      keyHint: key.slice(-4),
      scopes: [
        { organizationId: '6ab0a323697330667ccce000', scope: 'MANAGEMENT' },
        { organizationId: '6ab0a323697330667ccce001', scope: 'MANAGEMENT' },
      ],
      validatedAt: '2026-11-18T10:00:00Z',
      expiresAt: null,
    };
    return route.fulfill({
      json: connection,
      headers: { ETag: '"c1"', 'Access-Control-Expose-Headers': 'ETag' },
    });
  };
  await page.route(CONNECTIONS, answer);
  await page.route(`${CONNECTIONS}/sphere`, answer);
  return sent;
}

test.describe('J3 · an organization connects its SPHERE key in the beta Connections tab', () => {
  test('an ADMIN connects a key SPHERE accepts, after one it refuses, sees whose it is, and removes it', async ({
    page,
  }) => {
    await installMockApi(page, 'admin');
    const sent = await connectable(page);
    await page.goto('/orgs/isa-demo/connections');

    const tab = page.locator('main').getByRole('region', { name: 'Connections' });
    await expect(tab.getByRole('heading', { name: 'Connections' })).toBeVisible();
    await expect(
      page.getByRole('navigation', { name: 'Organization sections' }).getByRole('link', {
        name: /Connections\s*Beta/,
      })
    ).toHaveAttribute('aria-current', 'page');
    await expect(tab).toContainText('MANAGEMENT or ALL');

    const field = tab.getByLabel('SPHERE API key');
    await expect(field).toHaveValue('');
    await expect(field).toHaveAttribute('type', 'password');
    await field.fill('sk-short');
    await expect(
      tab.getByText('A SPHERE key is sk- followed by 64 hexadecimal characters.')
    ).toBeVisible();
    await expect(tab.getByRole('button', { name: 'Connect' })).toBeDisabled();

    await field.fill(REFUSED);
    await tab.getByRole('button', { name: 'Connect' }).click();
    await expect(tab.getByText('SPHERE refused the key: The API key is not valid.')).toBeVisible();

    await field.fill(GOOD);
    await tab.getByRole('button', { name: 'Connect' }).click();
    await expect(tab.getByText('Connected', { exact: true })).toBeVisible();
    await expect(tab).toContainText('Connected assphere-lab');
    await expect(tab).toContainText('MANAGEMENT on 2 organizations');
    await expect(tab).toContainText('…a1a1');
    await expect(tab).not.toContainText(GOOD);
    expect(sent.filter(entry => entry.method === 'PUT').map(entry => entry.key)).toEqual([
      REFUSED,
      GOOD,
    ]);

    // A replace sends back the revision the last write answered.
    await tab.getByRole('button', { name: 'Replace the key' }).click();
    const replace = page.getByRole('dialog', { name: 'Replace the SPHERE key' });
    await replace.getByLabel('SPHERE API key').fill(`sk-${'b2'.repeat(32)}`);
    await replace.getByRole('button', { name: 'Replace' }).click();
    await expect(replace).toHaveCount(0);
    expect(sent.at(-1)).toMatchObject({ method: 'PUT', ifMatch: '"c1"' });

    await tab.getByRole('button', { name: 'Remove' }).click();
    await page.getByRole('button', { name: 'Remove', exact: true }).last().click();
    await expect(tab.getByLabel('SPHERE API key')).toBeVisible();
    expect(sent.at(-1)).toMatchObject({ method: 'DELETE' });
  });

  test('with the organization connected, the SPHERE wizard offers its SPHERE organizations', async ({
    page,
  }) => {
    await installMockApi(page, 'admin');
    await page.route(`${API}/v1/organizations/isa-demo/sphere/pricings**`, route =>
      route.fulfill({ json: { ...fixture('sphere', 'search.mailgun.json'), connected: true } })
    );
    await page.goto('/orgs/isa-demo/problems?sphereStep=pricing');
    const dialog = page.getByRole('dialog');
    await dialog.getByText('Filters').click();
    await expect(dialog.getByRole('textbox', { name: 'Your SPHERE organization' })).toBeVisible();
  });

  test('without beta features, and below ADMIN, the tab is the in-place 404', async ({ page }) => {
    await installMockApi(page, 'admin');
    await page.goto('/orgs/isa-demo/connections');
    await expect(
      page.locator('main').getByRole('heading', { name: 'Page not found' })
    ).toBeVisible();
    await expect(
      page.getByRole('navigation', { name: 'Organization sections' }).getByRole('link', {
        name: /Connections/,
      })
    ).toHaveCount(0);

    await connectable(page);
    await page.goto('/orgs/read-lab/connections');
    await expect(
      page.locator('main').getByRole('heading', { name: 'Page not found' })
    ).toBeVisible();
  });
});
