import { expect as baseExpect, test, type Page, type Route } from '@playwright/test';
import { detailOf, digestOf, jobOf } from '../src/test/fixtures/jobs';
import { API, installMockApi } from './helpers/mockApi';

// J4 · adopt from a run: a run's solution is kept as the next version of TomatoMeter and adopted in staging (where members
// adopt) in the same step: the derive dialog's preview offers "Adopt in Staging in the same step", a `derive_and_adopt`
// proposal (F6) the reader confirms on its card, in the same modal; nothing is sealed or adopted until then. Back on the run
// page, "Adopt in environment" lists the versions derived from that run and adopts one in production directly. There is no
// backend: e2e/helpers/mockApi.ts answers with the gateway's F4 and F6 fixtures, and this spec's run is
// e2e/f2a-derive-seal-compare.spec.ts's run of checkout-flow@1.

const expect = baseExpect.configure({ timeout: 15_000 });
test.setTimeout(120_000);

const main = (page: Page) => page.locator('main');

const RUN = '7c1e5a90-0000-4000-8000-0000000000b1';

const at = (id: string) => ({ resource: 'catalog', id });
/** A solution of the run: a binding of the five service tasks, its features and its objectives as an engine reports them. */
const solution = (t1: string, cost: number, time: number, score: number[]) => ({
  decision: {
    kind: 'binding',
    binding: {
      T1: at(t1),
      T2: at('cand_t2_radius_iot_network'),
      T3: at('cand_t3_distance_matrix_api'),
      T5: at('cand_t5_amazon_braket'),
      T6: at('cand_t6_paypal'),
    },
  },
  features: { cost, execution_time: time },
  objectives: {
    type: 'MULTI',
    scalarization: 'pareto',
    penalty: 0,
    score,
    components: [
      { criteria: 'cost', feature: 'cost', value: cost, loss: score[0], weight: 1 },
      {
        criteria: 'execution_time',
        feature: 'execution_time',
        value: time,
        loss: score[1],
        weight: 1,
      },
    ],
  },
  violations: [],
});

const REFS = {
  organization: { id: 'org-isa-demo', slug: 'isa-demo' },
  problem: { id: 'case-checkout-flow', slug: 'checkout-flow', name: 'Checkout flow' },
  revision: { id: 'rev-checkout-1', revision: 1 },
  compilation: { id: 'compilation-1', compilation_digest: digestOf('9'), ir_digest: digestOf('c') },
};
const SUMMARY = jobOf(
  RUN,
  'random-search',
  'completed',
  'FEASIBLE',
  '2026-10-08T09:00:00Z',
  '2026-10-08T09:01:00Z',
  { ...REFS, organization_id: 'org-isa-demo' }
);
const DETAIL = {
  ...SUMMARY,
  ...detailOf(RUN, 'completed', {
    ...REFS,
    result: {
      termination: 'FEASIBLE',
      solutions: [
        solution('cand_t1_aws', 3060, 3180, [0.306, 0.159]),
        solution('cand_t1_google_cloud', 3080, 3190, [0.308, 0.1595]),
      ],
    },
  }),
};

/** The organization's runs are this spec's run of checkout-flow@1; every other request goes on to the shared mock. */
async function installRun(page: Page) {
  await page.route(`${API}/v1/organizations/isa-demo/runs**`, async (route: Route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/v1/organizations/isa-demo/runs')
      return route.fulfill({ json: { runs: [SUMMARY], total: 1 } });
    if (url.pathname === `/v1/organizations/isa-demo/runs/${RUN}`)
      return route.fulfill({ json: DETAIL });
    return route.fallback();
  });
}

test.describe('J4 · adopt from a run', () => {
  test('a run’s solution is sealed into TomatoMeter and adopted in staging in one proposal, then in production from the run page', async ({
    page,
  }) => {
    const mock = await installMockApi(page, 'admin', { tomatometer: true });
    await installRun(page);
    await page.goto(`/runs/isa-demo/${RUN}`);
    await expect(
      main(page).getByRole('heading', { level: 1, name: 'random-search run' })
    ).toBeVisible();
    // Nothing is derived from this run yet: nothing to adopt.
    await expect(main(page).getByRole('button', { name: 'Keep as composition' })).toBeVisible();
    await expect(main(page).getByRole('button', { name: 'Adopt in environment' })).toHaveCount(0);

    await main(page).getByRole('button', { name: 'Keep as composition' }).click();
    const dialog = page.getByRole('dialog', { name: 'Derive a composition' });
    await dialog.getByRole('radio', { name: 'A composition of this organization' }).check();
    await dialog.getByLabel('Composition', { exact: true }).selectOption('tomatometer');
    await dialog.getByRole('button', { name: 'Next' }).click();
    await expect(dialog.getByLabel('Version label')).toHaveValue('1.2.0');
    await dialog.getByRole('button', { name: 'Preview' }).click();
    // Sealing alone is the default; adopting in staging in the same step makes one proposal of both.
    await expect(dialog.getByRole('radio', { name: 'Seal only; adopt it later' })).toBeChecked();
    await dialog.getByRole('radio', { name: 'Adopt in Staging in the same step' }).check();
    await dialog.getByRole('button', { name: 'Propose sealing and adopting 1.2.0' }).click();

    const proposing = page.getByRole('dialog', { name: 'Derive and adopt' });
    const card = proposing.getByRole('group', { name: /^Proposal:/ });
    await expect(card).toContainText('Waiting for your confirmation');
    await expect(card).toContainText('Seal 1.2.0 from run');
    await expect(card).toContainText('Adopt the version step 1 seals in Staging');
    await expect(card).toContainText('The version is decided when step 1 has run.');
    expect(mock.operation?.adopted).toEqual([]);
    await card.getByRole('button', { name: 'Confirm and apply' }).click();
    await expect(card).toContainText('Applied');
    await expect(card).toContainText('2 of 2 steps done');
    await proposing.getByRole('button', { name: 'Open Staging' }).click();
    await expect(page).toHaveURL(
      '/compositions/isa-demo/tomatometer/operation?environment=staging'
    );
    await expect(page.getByRole('region', { name: 'In effect', exact: true })).toContainText(
      'In effect: 1.2.0'
    );
    const adopt = page.getByRole('dialog', { name: 'Adopt a version' });

    // Back on the run page: the version derived from it can be adopted in production too.
    await page.goto(`/runs/isa-demo/${RUN}`);
    await main(page).getByRole('button', { name: 'Adopt in environment' }).click();
    await expect(adopt.getByRole('radio', { name: /1\.2\.0/ })).toBeChecked();
    await expect(adopt.getByRole('radio')).toHaveCount(1);
    await adopt.getByRole('combobox', { name: 'Environment' }).selectOption('production');
    await adopt.getByRole('button', { name: 'Adopt 1.2.0' }).click();
    await expect(
      page.getByText('Version 1.2.0 of TomatoMeter adopted in Production')
    ).toBeVisible();
    expect(mock.operation?.adopted.map(item => item.environment)).toEqual([
      'staging',
      'production',
    ]);
    expect(mock.operation?.adopted.every(item => item.ifMatch?.startsWith('"env-'))).toBe(true);
    expect(mock.unmocked).toEqual([]);
  });
});
