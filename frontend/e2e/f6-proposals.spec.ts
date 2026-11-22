import { readFileSync } from 'node:fs';
import { expect as baseExpect, test, type Page, type Route } from '@playwright/test';
import type { ProposalView } from '../src/modules/core/api/types';
import { API, installMockApi } from './helpers/mockApi';

// F6 · proposals on the screens (J3, J5): TomatoMeter's Operation tab shows its author's pending proposal on the ProposalCard
// adapted from SPHERE ORBIT, with each step's base, the document its seal step stores and what that document changes
// against the version in effect; confirming applies it step by step (J3), an environment that moved meanwhile makes it out of
// date and nothing changes (J5), a partial answer is reported step by step, and a replaced proposal says so. There is no
// backend: e2e/helpers/mockApi.ts answers with the gateway's B5 fixtures (src/test/fixtures/core/zproposals.*.json) through
// e2e/helpers/operationMock.ts.

const expect = baseExpect.configure({ timeout: 15_000 });
test.setTimeout(120_000);

const core = <T>(file: string): T =>
  JSON.parse(
    readFileSync(new URL(`../src/test/fixtures/core/${file}`, import.meta.url), 'utf8')
  ) as T;

const OPERATION = '/compositions/isa-demo/tomatometer/operation';
const PENDING = core<ProposalView>('zproposals.pending.json');
const PARTIAL = core<ProposalView>('zproposals.partial.json');
const SUPERSEDED = core<ProposalView>('zproposals.superseded.json');
const ADOPT_PRODUCTION: ProposalView = {
  ...SUPERSEDED,
  id: '00000000-0000-4000-8000-0000000007a1',
  status: 'pending',
  supersededBy: null,
  summary: 'Adopt 1.1.0 in Production',
  steps: [
    {
      ...SUPERSEDED.steps[0],
      description: 'Adopt 1.1.0 in Production',
      params: {
        ...SUPERSEDED.steps[0].params,
        environment: '00000000-0000-4000-8000-000000000040',
      },
    },
  ],
};

const main = (page: Page) => page.locator('main');
const proposal = (page: Page, summary: string) =>
  main(page).getByRole('group', { name: `Proposal: ${summary}` });

test.describe('J3 · derive and adopt as one proposal', () => {
  test('the author reads what the seal step stores and changes, confirms, and the version is in effect', async ({
    page,
  }) => {
    const mock = await installMockApi(page, 'admin', { tomatometer: true });
    mock.operation?.seedProposal(PENDING);
    await page.goto(OPERATION);
    const card = proposal(page, PENDING.summary);
    await expect(card).toContainText('Waiting for your confirmation');
    await expect(card).toContainText('From the web');
    await expect(card).toContainText('Built on 1.1.0 as the latest version');
    await expect(card).toContainText('Production as it was when proposed, with 1.0.0 in effect.');
    await expect(card).toContainText('The version is decided when step 1 has run.');

    await card
      .getByRole('button', { name: 'Compare with the version in effect in Production (1.0.0)' })
      .click();
    await expect(card.getByRole('region', { name: 'Binding' })).toContainText('dailySummary');
    await card.getByRole('button', { name: 'Show the document' }).click();
    await expect(card.getByLabel('The document step 1 seals')).toContainText('version: 1.2.0');

    await card.getByRole('button', { name: 'Confirm and apply' }).click();
    await expect(card).toContainText('Applied');
    await expect(card).toContainText('2 of 2 steps done');
    await expect(card.getByRole('link', { name: /Open production \(adoption #4\)/ })).toBeVisible();
    await expect(main(page).getByRole('article', { name: 'Environment Production' })).toContainText(
      'In effect1.2.0'
    );
    expect(mock.operation?.confirmed.map(item => item.id)).toEqual([PENDING.id]);
    expect(mock.operation?.adopted.map(item => item.environment)).toEqual(['production']);
  });
});

test.describe('J5 · stale, partial and replaced proposals', () => {
  test('an environment that moved since makes the proposal out of date, and nothing changes', async ({
    page,
  }) => {
    const mock = await installMockApi(page, 'admin', { tomatometer: true });
    mock.operation?.seedProposal(ADOPT_PRODUCTION);
    await page.goto(OPERATION);
    const card = proposal(page, ADOPT_PRODUCTION.summary);
    await expect(card).toContainText('Waiting for your confirmation');
    mock.operation?.touch('production');
    await card.getByRole('button', { name: 'Confirm and apply' }).click();
    await expect(card.getByRole('alert')).toContainText(
      'This proposal is out of date: production changed since it was made. Nothing was changed.'
    );
    await expect(card).toContainText('Out of date');
    expect(mock.operation?.adopted).toEqual([]);
  });

  test('a partial answer reports each step: the seal done with its link, the adoption refused', async ({
    page,
  }) => {
    const mock = await installMockApi(page, 'admin', { tomatometer: true });
    mock.operation?.seedProposal(PENDING);
    await page.route(
      new RegExp(`^${API}/v1/organizations/isa-demo/proposals/${PENDING.id}/confirm$`),
      (route: Route) => route.fulfill({ json: { ...PARTIAL, id: PENDING.id } })
    );
    await page.goto(OPERATION);
    const card = proposal(page, PENDING.summary);
    await card.getByRole('button', { name: 'Confirm and apply' }).click();
    const done = proposal(page, PARTIAL.summary);
    await expect(done).toContainText('Partly applied');
    await expect(done).toContainText('1 of 2 steps done · 1 failed');
    await expect(done).toContainText('What is done stays done; nothing else was changed.');
    await expect(done).toContainText(
      'The resource changed since it was read; fetch it again and retry. (412)'
    );
    await expect(done.getByRole('link', { name: 'Compare 1.3.0 in Versions' })).toBeVisible();
  });

  test('a new proposal replaces the author’s pending one, which says so', async ({ page }) => {
    const mock = await installMockApi(page, 'admin', { tomatometer: true });
    mock.operation?.seedProposal(SUPERSEDED);
    mock.operation?.seedProposal(PENDING);
    await page.goto(OPERATION);
    await expect(proposal(page, PENDING.summary)).toContainText('Waiting for your confirmation');
    await main(page).getByText('Recent proposals (1)').click();
    await expect(proposal(page, SUPERSEDED.summary)).toContainText('Replaced by a newer proposal');
  });
});
