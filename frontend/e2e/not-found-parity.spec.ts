import { expect, test, type Page } from '@playwright/test';
import { authConfig, signedIn as withSession } from './helpers/session';

// Anything missing and anything unreadable read the same (design §1 and §3.7): every address of a resource answers with the
// in-place 404 whether the gateway says 404 (missing) or 403 (not yours), so the page never reveals that something private
// exists. The sweep visits each public and protected resource address twice, once with every API answer a 404 and once a
// 403, and compares what the page says.

const API = 'http://localhost:8000';

const organization = {
  id: 'org-1',
  slug: 'isa-demo',
  name: 'ISA Demo Group',
  parent_id: null,
  effective_role: 'OWNER',
  created_at: '2026-09-01T00:00:00Z',
};

async function mockApi(page: Page, status: 404 | 403, signedIn: boolean) {
  await page.route(`${API}/**`, route =>
    route.fulfill({
      status,
      json: { code: status === 404 ? 'not_found' : 'forbidden', detail: 'refused' },
    })
  );
  await authConfig(page);
  if (!signedIn) return;
  await withSession(page, 'parity-token');
  await page.route(`${API}/v1/users/me`, route =>
    route.fulfill({
      json: {
        id: 'parity-user',
        username: 'lucia',
        email: 'lucia@example.org',
        role: 'user',
        is_active: true,
        plan: 'FREE',
        created_at: '2026-09-01T00:00:00Z',
      },
    })
  );
  await page.route(`${API}/v1/users/me/pricing-token`, route =>
    route.fulfill({ json: { pricing_token: 'parity-token' } })
  );
  await page.route(
    url => url.origin + url.pathname === `${API}/v1/organizations`,
    route => route.fulfill({ json: [organization] })
  );
  await page.route(`${API}/v1/notifications**`, route => route.fulfill({ json: [] }));
}

/** What the page says once it has settled on its answer. */
async function answer(page: Page, path: string): Promise<string> {
  await page.goto(path);
  const main = page.locator('main');
  await expect(
    main
      .getByRole('heading', { name: 'Page not found' })
      .or(main.getByText(/This resource is unavailable/))
  ).toBeVisible({ timeout: 15_000 });
  return (await main.innerText()).replace(/\s+/g, ' ').trim();
}

const VISITOR: string[] = [
  '/orgs/ghost-lab',
  '/orgs/ghost-lab/members',
  '/compositions/ghost-lab/fleet-plan',
  '/compositions/isa-demo/ghost/versions',
  '/p/00000000-0000-4000-8000-000000000001',
  '/engines/ghost/solver/1.0.0',
];

const MEMBER: string[] = [
  '/orgs/other-lab/audit',
  '/orgs/other-lab/connections',
  '/orgs/isa-demo/connections',
  '/problems/isa-demo/ghost?sphereStep=pricing&sphere=6ade364540e55445692b0eda',
  '/compositions/isa-demo/ghost',
  '/problems/isa-demo/ghost',
  '/problems/other-lab/checkout-flow/versions',
  '/runs/isa-demo/00000000-0000-4000-8000-000000000002',
  '/runs/other-lab/00000000-0000-4000-8000-000000000002',
  '/studies/isa-demo/ghost',
  '/studies/other-lab/engines-compared/front',
  '/me/engines/ghost-solver',
  '/admin',
  '/admin/users/ghost',
];

for (const [who, paths, signedIn] of [
  ['a visitor', VISITOR, false],
  ['a signed-in member of another organization', MEMBER, true],
] as const) {
  test.describe(`404 parity for ${who}`, () => {
    for (const path of paths) {
      test(`${path} reads the same missing and unreadable`, async ({ browser }) => {
        const texts: string[] = [];
        for (const status of [404, 403] as const) {
          const context = await browser.newContext();
          const page = await context.newPage();
          await mockApi(page, status, signedIn);
          texts.push(await answer(page, path));
          await context.close();
        }
        expect(texts[1]).toBe(texts[0]);
        if (!path.startsWith('/p/')) expect(texts[0]).toContain('Page not found');
      });
    }
  });
}
