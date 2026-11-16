import { expect as baseExpect, test, type Page, type Route } from '@playwright/test';
import { detailOf, digestOf, jobOf } from '../src/test/fixtures/jobs';
import { API, installMockApi } from './helpers/mockApi';

// J1 · derive, seal and compare: the problem page (its workflow and candidates) → one of its runs → Derive composition (a new
// composition, the preview, seal 1.0.0) → the Editor, where the visual form binds task T1 to its other candidate, the check states
// the values that binding has, and 1.1.0 is sealed → Versions, comparing 1.0.0 with 1.1.0 entry by entry and line by line.
// There is no backend: e2e/helpers/mockApi.ts answers the API origin, with the derivation and the evaluated composition of
// e2e/helpers/mockCompositions.ts (the FMS fixture's binding of checkout-flow@1, and the gateway's F1 diff golden of it). The run is
// this spec's own: a completed run of checkout-flow@1, whose compilation's facts are FMS's.

const expect = baseExpect.configure({ timeout: 15_000 });
// Four screens and two seals in one walk, while the development server compiles each on demand.
test.setTimeout(120_000);

const ORG = '/app/isa-demo';
const RUN = '7c1e5a90-0000-4000-8000-0000000000b1';
const COMPOSITION = `${ORG}/compositions/fleet-plan`;
const main = (page: Page) => page.locator('#platform-main');

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

/** The bodies of every derivation the page asks for. */
function derivations(page: Page): unknown[] {
  const sent: unknown[] = [];
  page.on('request', request => {
    if (request.method() === 'POST' && request.url().endsWith('/compositions/fleet-plan/derive'))
      sent.push(request.postDataJSON());
  });
  return sent;
}

test.describe('J1 · derive, seal and compare', () => {
  test('a run of a problem becomes a composition, edited in the visual form, sealed again and compared with its first version', async ({
    page,
  }) => {
    const mock = await installMockApi(page, 'admin');
    await installRun(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    const sent = derivations(page);

    // The problem page: version 1's workflow, then the candidates of each task.
    await page.goto(`${ORG}/problems/checkout-flow?version=1`);
    await expect(main(page).getByRole('group', { name: 'Workflow' })).toBeVisible();
    await main(page).getByRole('tab', { name: 'Candidates' }).click();
    const candidates = main(page).getByRole('region', { name: 'Candidates of each task' });
    await expect(candidates.getByRole('region', { name: 'Candidates for T1' })).toContainText(
      'cand_t1_google_cloud'
    );

    // One of its runs.
    await main(page).getByRole('tab', { name: 'Runs' }).click();
    await main(page)
      .getByRole('region', { name: 'Runs of the problem' })
      .getByRole('link', { name: 'Run 1' })
      .click();
    await expect(page).toHaveURL(`${ORG}/runs/${RUN}`);
    await expect(
      main(page).getByRole('heading', { level: 1, name: 'random-search run' })
    ).toBeVisible();

    // Derive: a new composition, the first of the run's two solutions, the preview, then the seal of 1.0.0.
    await main(page)
      .getByRole('region', { name: 'Keep it as a composition' })
      .getByRole('button', { name: 'Derive composition' })
      .click();
    const dialog = page.getByRole('dialog', { name: 'Derive a composition' });
    await dialog.getByLabel('Name').fill('Fleet plan');
    await expect(dialog.getByLabel('Address')).toHaveValue('fleet-plan');
    await dialog.getByLabel('Kind').selectOption('workflow');
    await dialog.getByRole('button', { name: 'Next' }).click();
    const points = dialog.getByRole('region', { name: 'Solutions of the run' });
    await expect(points.getByRole('row')).toHaveCount(3);
    await expect(points.getByRole('radio', { name: 'Solution 1' })).toBeChecked();
    await expect(dialog.getByLabel('Version label')).toHaveValue('1.0.0');
    await dialog.getByRole('button', { name: 'Preview' }).click();
    await expect(dialog.getByRole('region', { name: 'Derived composition.yaml' })).toContainText(
      'candidate: cand_t1_aws'
    );
    await expect(dialog.getByRole('region', { name: 'Values' })).toContainText('3,060 USD/month');
    await expect(dialog.getByRole('region', { name: 'Values' })).toContainText(
      'These values will be verified'
    );
    await dialog.getByRole('button', { name: 'Seal 1.0.0' }).click();

    await expect(page).toHaveURL(`${COMPOSITION}/versions?version=1.0.0`);
    await expect(main(page).getByText('Version 1.0.0 sealed.')).toBeVisible();
    // The preview and the seal asked for the same bytes.
    expect(sent).toEqual([
      { run: RUN, point: 0, version: '1.0.0', seal: false },
      { run: RUN, point: 0, version: '1.0.0', seal: true },
    ]);
    const table = main(page)
      .getByRole('region', { name: 'Versions of Fleet plan' })
      .getByRole('table');
    await expect(table.getByRole('row', { name: /^1\.0\.0/ })).toContainText(
      'Derived from run 7c1e5a90'
    );

    // The Editor: the visual form binds T1 to the other candidate, the check states that binding's values, and 1.1.0 is sealed.
    await main(page).getByRole('tab', { name: 'Editor' }).click();
    await expect(page).toHaveURL(new RegExp(`${COMPOSITION}/editor`));
    const source = main(page).getByRole('textbox', { name: 'composition.yaml source' });
    await expect(source).toContainText('candidate: cand_t1_aws');
    await main(page)
      .getByRole('region', { name: 'Visual editor' })
      .getByRole('radio', { name: 'cand_t1_google_cloud for T1' })
      .click();
    await expect(source).toContainText('candidate: cand_t1_google_cloud');
    const onSeal = main(page).getByRole('region', { name: 'Values on seal' });
    await expect(onSeal).toContainText('These values will be verified');
    await expect(onSeal).toContainText('3,080 USD/month');
    await onSeal.getByRole('button', { name: 'Use the canonical form' }).click();
    await expect(source).toContainText('value: 3080');
    const label = main(page).getByLabel('Label');
    await label.fill('1.1.0');
    await label.press('Enter');
    await expect(source).toContainText('version: 1.1.0');
    await main(page).getByRole('button', { name: 'Seal version' }).click();
    await expect(page).toHaveURL(`${COMPOSITION}/versions?version=1.1.0`);
    await expect(main(page).getByText('Version 1.1.0 sealed.')).toBeVisible();

    // Versions: 1.0.0 against 1.1.0, entry by entry (the binding and the values) and line by line.
    await table
      .getByRole('row', { name: /^1\.1\.0/ })
      .getByRole('button', { name: 'Compare with previous' })
      .click();
    await expect(page).toHaveURL(
      `${COMPOSITION}/versions?version=1.1.0&view=compare&from=1.0.0&to=1.1.0`
    );
    const binding = main(page).getByRole('region', { name: /^Binding/ });
    await expect(binding).toContainText('T1');
    await expect(binding).toContainText('cand_t1_aws');
    await expect(binding).toContainText('cand_t1_google_cloud');
    const values = main(page).getByRole('region', { name: /^Values/ });
    await expect(values).toContainText('3,060 to 3,080');
    await expect(values).toContainText('3,180 to 3,190');

    await main(page)
      .getByRole('group', { name: 'Versions view' })
      .getByRole('button', { name: 'File' })
      .click();
    await expect(page).toHaveURL(
      `${COMPOSITION}/versions?version=1.1.0&view=file&from=1.0.0&to=1.1.0`
    );
    const text = main(page).getByRole('region', { name: 'The text of 1.0.0 and 1.1.0' });
    await expect(text).toContainText('candidate: cand_t1_aws');
    await expect(text).toContainText('candidate: cand_t1_google_cloud');
    expect(mock.unmocked).toEqual([]);
  });
});
