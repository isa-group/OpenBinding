import { readFileSync } from 'node:fs';
import { expect as baseExpect, test, type Page } from '@playwright/test';
import { RUN_ID, cellsFixture } from '../src/test/fixtures/studies';
import { API, installMockApi } from './helpers/mockApi';

// J4 · study front → compositions: the results of a study run → the gateway's Pareto front of each problem version, one table each →
// two points selected → Derive compositions (one new composition per point, each sealed as 1.0.0, one after another) → Compare two,
// through the gateway's document diff of the two compositions. There is no backend: e2e/helpers/mockApi.ts answers the API origin,
// with the study fixture's run (its analytics carry the fronts of src/test/fixtures/studies.ts) and the composition store of
// e2e/helpers/mockCompositions.ts; the document diff (`POST /v1/compositions/diff`) is this spec's own, the gateway's FMS diff golden
// (the two points bind task T1 to different candidates).

const expect = baseExpect.configure({ timeout: 15_000 });
test.setTimeout(90_000);

const RESULTS = `/app/isa-demo/studies/engines-vs-seeds/results?run=${RUN_ID}`;
const CELLS = cellsFixture();
const main = (page: Page) => page.locator('main');
const FMS_DIFF = JSON.parse(
  readFileSync(new URL('../src/test/fixtures/core/fms.diff.json', import.meta.url), 'utf8')
) as Record<string, unknown>;

/** The gateway's diff of two documents, and the bodies the page sent it. */
async function installDocumentDiff(page: Page): Promise<unknown[]> {
  const sent: unknown[] = [];
  await page.route(`${API}/v1/compositions/diff`, async route => {
    sent.push(route.request().postDataJSON());
    // A document diff names no versions: the golden without its `from` and `to`.
    const diff: Record<string, unknown> = { ...FMS_DIFF };
    delete diff.from;
    delete diff.to;
    await route.fulfill({ json: diff });
  });
  return sent;
}

/** The bodies of every derivation the page asks for, by composition. */
function derivations(page: Page): Array<{ composition: string; body: unknown }> {
  const sent: Array<{ composition: string; body: unknown }> = [];
  page.on('request', request => {
    const match = /\/compositions\/([^/]+)\/derive$/.exec(new URL(request.url()).pathname);
    if (request.method() === 'POST' && match)
      sent.push({ composition: match[1], body: request.postDataJSON() });
  });
  return sent;
}

test.describe('J4 · study front → compositions', () => {
  test('two points of a study’s Pareto front become two compositions, which are then compared', async ({
    page,
  }) => {
    const mock = await installMockApi(page, 'admin');
    const diffs = await installDocumentDiff(page);
    const derived = derivations(page);
    await page.setViewportSize({ width: 1440, height: 900 });

    // The results of the study run, and the gateway's front of each problem version.
    await page.goto(RESULTS);
    await expect(
      main(page).getByRole('heading', { level: 2, name: 'Compare results · run #1' })
    ).toBeVisible();
    const front = main(page).getByRole('region', { name: 'Pareto front' });
    await expect(
      front.getByText('4 points · computed by the gateway · lower is better')
    ).toBeVisible();
    const first = front.getByRole('region', { name: 'Front of checkout-flow · version 1' });
    const second = front.getByRole('region', { name: 'Front of checkout-flow · version 2' });
    await expect(first.getByRole('row')).toHaveCount(3);
    await expect(second.getByRole('row')).toHaveCount(3);
    await expect(first.getByRole('row').nth(1)).toContainText('P1');
    await expect(first.getByRole('row').nth(1)).toContainText('0.112');

    // The focused point walks the front.
    const focused = front.getByRole('group', { name: 'Focused point' });
    await expect(focused).toContainText('P1 1 of 4');
    await focused.getByRole('button', { name: 'Next' }).click();
    await expect(focused).toContainText('P2 2 of 4');

    // Two points, one of each version, derived into two new compositions.
    await front.getByRole('checkbox', { name: 'Select P1' }).check();
    await front.getByRole('checkbox', { name: 'Select P4' }).check();
    await expect(front.getByRole('button', { name: 'Compare two' })).toBeDisabled();
    await front.getByRole('button', { name: 'Derive compositions' }).click();
    const dialog = page.getByRole('dialog', { name: 'Derive compositions' });
    await expect(dialog.getByLabel('Address of P1')).toHaveValue('checkout-flow-p1');
    await expect(dialog.getByLabel('Address of P4')).toHaveValue('checkout-flow-p4');
    await dialog.getByRole('button', { name: 'Derive 2 compositions' }).click();
    await expect(dialog.getByRole('status')).toHaveText('2 of 2 points hold a composition.');
    await expect(dialog.getByLabel('Result of P1')).toContainText('Created; 1.0.0 sealed.');
    expect(derived).toEqual([
      {
        composition: 'checkout-flow-p1',
        body: { run: CELLS[0].job_id, point: 0, version: '1.0.0', seal: true },
      },
      {
        composition: 'checkout-flow-p4',
        body: { run: CELLS[6].job_id, point: 0, version: '1.0.0', seal: true },
      },
    ]);
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(first.getByRole('link', { name: 'checkout-flow-p1 1.0.0' })).toHaveAttribute(
      'href',
      '/compositions/isa-demo/checkout-flow-p1/versions?version=1.0.0'
    );
    await expect(second.getByRole('link', { name: 'checkout-flow-p4 1.0.0' })).toBeVisible();

    // The two compositions compared: both stored texts go to the gateway's document diff.
    await front.getByRole('button', { name: 'Compare two' }).click();
    const compare = page.getByRole('dialog', { name: 'Compare two points' });
    await expect(compare).toContainText(
      'P1 · checkout-flow-p1 1.0.0 compared with P4 · checkout-flow-p4 1.0.0'
    );
    const binding = compare.getByRole('region', { name: /^Binding/ });
    await expect(binding.getByRole('button', { name: /T1/ })).toContainText('Changed');
    // The development server mounts in strict mode, so the dialog may ask twice; each ask carries both texts.
    expect(diffs.length).toBeGreaterThan(0);
    const body = diffs.at(-1) as { before: string; after: string };
    expect(body.before).toContain('composition: checkout-flow-p1');
    expect(body.after).toContain('composition: checkout-flow-p4');
    await compare.getByRole('button', { name: 'Show the two texts line by line' }).click();
    await expect(compare.getByRole('button', { name: 'Hide the two texts' })).toBeVisible();
    await compare.getByRole('button', { name: 'Done' }).click();
    await expect(compare).toHaveCount(0);

    expect(mock.unmocked).toEqual([]);
  });
});
