import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import {
  API,
  FEED_CONSUMER,
  MAILPIT,
  ORG,
  SPHERE_LAB_CONTROL,
  adoptByApi,
  capture,
  consumerUntil,
  feedEtag,
  signInByApi,
  watchPageErrors,
} from './support';

/**
 * F6 against the lab, plan §7.2's chain on the screens: a pricing TomatoMeter reads changes upstream, the team is told, a
 * person reviews, re-solves and adopts through a proposal, and the application follows. The lab's SPHERE is its stand-in
 * (`sphere-lab`, F6-C), whose control port publishes the scripted scenario versions; the gateway's watcher polls every 20 s.
 *
 * - J1: Brevo publishes 2026-11 (PROFESSIONAL 499 → 549): within a cycle the owner and the member are told, the notification
 *   opens the event in place, the summary says +50.00 a month and draws PROFESSIONAL before and after, and the badges show on
 *   the card page, the composition card and `production`; `staging` (put on 1.1.0, Resend, here) carries what the gateway
 *   counts. The feed, the consumer, the adoption and the counts of versions and proposals are unchanged;
 * - J2: the viewer is offered nothing; the member marks it reviewed with a note; a stale page cannot review it again;
 * - J2b: Brevo retires PROFESSIONAL (2027-01): rebinding recommended, the reviewed 2026-11 event superseded; the dashboard and
 *   the inbox list it; the feed is unchanged;
 * - J3: the owner updates the problem from SPHERE (revision 4 reads Brevo 2027-01), takes Resend PRO in the configurator on
 *   revision 4 and derives and adopts it in production as one proposal: both Brevo events are resolved;
 * - J4: the consumer follows the new version and mails through Resend;
 * - J5: a proposal made before production moved is refused as out of date, and nothing changes;
 * - J6: the offering event (TomatoMeter 1.2.0, published and reviewed by smoke step 19–20, else here) shows its margins in
 *   production before and after.
 *
 * Each scenario publishes once per lab: a second run on the same lab skips J1–J5 and says so (`down --volumes` resets it).
 * `afterAll` adopts 1.0.0 back in production; staging stays on 1.1.0.
 */

test.describe.configure({ mode: 'serial' });

const COMPOSITION = 'tomatometer';
const PROBLEM = 'tomatometer-email';
const PAGE = `/compositions/${ORG}/${COMPOSITION}`;
const OPERATION = `${PAGE}/operation`;
const ROOT = `${API}/v1/organizations/${ORG}/compositions/${COMPOSITION}`;
const BREVO = '6ade2d4440e55445692b07f1';
const TOMATOMETER = '6ab0a323697330667ccce8cd';

interface Event {
  id: string;
  category: string;
  state: string;
  subject: string;
  new: { label: string | null } | null;
  supersededBy: string | null;
  resolvedBy: { version: { label: string } } | null;
}

/** Why the walk cannot run here (another SPHERE), or null. */
let unavailable: string | null = null;
/** The Brevo scenarios were published on this lab already. */
let published = false;
let ownerToken = '';
let memberToken = '';
let viewerToken = '';
let values: Event | null = null;
let retired: Event | null = null;
let before: { etag: string; adoption: number; versions: number; proposals: number } | null = null;
let next = '';

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

async function stateOfLab(request: APIRequestContext): Promise<Record<string, unknown> | null> {
  const answer = await request.get(`${SPHERE_LAB_CONTROL}/_lab/state`).catch(() => null);
  return answer && answer.ok() ? ((await answer.json()) as Record<string, unknown>) : null;
}

async function publish(request: APIRequestContext, scenario: string) {
  const answer = await request.post(`${SPHERE_LAB_CONTROL}/_lab/publish/${scenario}`);
  expect([200, 409], `publish ${scenario}: ${await answer.text()}`).toContain(answer.status());
}

async function events(request: APIRequestContext, token: string, query = ''): Promise<Event[]> {
  const answer = await request.get(`${ROOT}/upstream-events${query}`, { headers: auth(token) });
  expect(answer.status()).toBe(200);
  return ((await answer.json()) as { events: Event[] }).events;
}

/** The event the watcher records for `scenario`, waited for up to two minutes (the lab polls every 20 s). */
async function detected(
  request: APIRequestContext,
  token: string,
  match: (event: Event) => boolean
): Promise<Event> {
  let found: Event | undefined;
  await expect
    .poll(
      async () => {
        found = (await events(request, token)).find(match);
        return Boolean(found);
      },
      { timeout: 120_000, intervals: [2_000] }
    )
    .toBe(true);
  return found!;
}

async function snapshot(request: APIRequestContext, token: string) {
  const environment = (await (
    await request.get(`${ROOT}/environments/production`, { headers: auth(token) })
  ).json()) as { inEffect: { adoption: number } };
  const composition = (await (await request.get(ROOT, { headers: auth(token) })).json()) as {
    version_count: number;
  };
  const proposals = (await (
    await request.get(`${ROOT}/proposals?limit=100`, { headers: auth(token) })
  ).json()) as { proposals: unknown[] };
  return {
    etag: await feedEtag(request),
    adoption: environment.inEffect.adoption,
    versions: composition.version_count,
    proposals: proposals.proposals.length,
  };
}

const card = (page: Page, name: string) =>
  page.locator('main').getByRole('article', { name: `Environment ${name}` });

test.afterAll(async ({ playwright }) => {
  if (!ownerToken) return;
  const request = await playwright.request.newContext({
    baseURL: process.env.BASE_URL ?? 'http://web:8080',
  });
  await adoptByApi(request, ownerToken, '1.0.0').catch(() => {});
  await request.dispose();
});

test('J0 · the lab’s SPHERE is the stand-in, and the walk starts from the seed', async ({
  browser,
  page,
}) => {
  const lab = await stateOfLab(page.request);
  const reads = Object.keys((lab?.requests ?? {}) as Record<string, unknown>);
  if (!lab) unavailable = `the stand-in's control port (${SPHERE_LAB_CONTROL}) does not answer`;
  else if (!reads.some(route => route.includes(BREVO) || route.includes(TOMATOMETER)))
    unavailable =
      'the lab reads another SPHERE: the stand-in was never asked for the scenario families';
  test.skip(unavailable !== null, unavailable ?? '');
  published = ((lab?.published ?? []) as string[]).includes('brevo-professional-up');
  // Each role signs in in a browser context of its own: a sign-in over another's session cookie ends that session.
  const tokenOf = async (role: 'member' | 'viewer') =>
    signInByApi(await (await browser.newContext()).newPage(), role);
  memberToken = await tokenOf('member');
  viewerToken = await tokenOf('viewer');
  ownerToken = await signInByApi(page, 'owner');
  await adoptByApi(page.request, ownerToken, '1.0.0');
  // Walk 14 leaves its run-derived version in staging; 1.1.0 (Resend) pins no Brevo version.
  await adoptByApi(page.request, ownerToken, '1.1.0', 'staging');
  before = await snapshot(page.request, ownerToken);
  test.skip(
    published,
    'brevo-professional-up was published on this lab already: each scenario publishes once per lab (down --volumes resets it)'
  );
});

test('J1 · Brevo raises PROFESSIONAL: the team is told, the badges show, the event says +50.00, nothing else moves', async ({
  page,
}, testInfo) => {
  test.skip(unavailable !== null || published || !before, 'see J0');
  test.setTimeout(300_000);
  const errors = watchPageErrors(page);
  await publish(page.request, 'brevo-professional-up');
  values = await detected(
    page.request,
    ownerToken,
    event => event.category === 'values_changed' && event.new?.label === '2026-11'
  );

  // Who is told: the owner and the member, not the viewer.
  const told = async (token: string) => {
    const answer = await page.request.get(`${API}/v1/notifications?kind=UpstreamEvent`, {
      headers: auth(token),
    });
    expect(answer.status(), await answer.text()).toBe(200);
    const listed = (await answer.json()) as Array<{
      payload: { event?: string; events?: string[] };
    }>;
    return listed.some(
      item => item.payload.events?.includes(values!.id) ?? item.payload.event === values!.id
    );
  };
  await expect.poll(() => told(ownerToken), { timeout: 30_000 }).toBe(true);
  expect(await told(memberToken)).toBe(true);
  expect(await told(viewerToken)).toBe(false);

  await signInByApi(page, 'owner');
  await page.goto('/notifications');
  const main = page.locator('main');
  await main
    .getByRole('group', { name: 'Kind' })
    .getByRole('button', { name: 'Upstream changes' })
    .click();
  await main
    .getByRole('button', { name: /^brevo 2026-11: TomatoMeter values changed/ })
    .first()
    .click();
  await expect(page).toHaveURL(new RegExp(`${OPERATION}\\?event=${values.id}$`));
  await expect(main.getByRole('region', { name: 'Global values' })).toContainText(
    /subscription 508\.99 → 558\.99 USD\/month, \+50\.00/
  );
  await expect(main.locator('pricing-change-review')).toHaveCount(1, { timeout: 30_000 });
  await capture(page, testInfo, 'f6-event-values');

  await page.goto(PAGE);
  await expect(main.getByRole('link', { name: /upstream change/ }).first()).toBeVisible();
  await capture(page, testInfo, 'f6-badge');
  await page.goto(`/orgs/${ORG}/compositions`);
  await expect(main.getByRole('article', { name: 'TomatoMeter' })).toContainText(/upstream change/);
  await page.goto(OPERATION);
  await expect(card(page, 'Production')).toContainText(/upstream change/);
  const staging = (await (
    await page.request.get(`${ROOT}/environments/staging`, { headers: auth(ownerToken) })
  ).json()) as { upstream: { open: number; worst: string | null } | null };
  expect(staging.upstream?.worst ?? null).not.toBe('values_changed');
  if (!staging.upstream?.open)
    await expect(card(page, 'Staging')).not.toContainText(/upstream change/);
  await expect(main.getByRole('heading', { level: 2, name: 'Upstream changes' })).toBeVisible();
  await capture(page, testInfo, 'f6-events');

  // Nothing a person must do was done: the feed, the consumer, the adoption and the counts are the same.
  expect(await snapshot(page.request, ownerToken)).toEqual(before);
  await consumerUntil(page.request, state => state.provider === 'brevo');
  expect(errors).toEqual([]);
});

test('J2 · the viewer is offered nothing; the member marks it reviewed; a stale page cannot review it again', async ({
  browser,
  page,
}, testInfo) => {
  test.skip(!values, 'J1 did not detect the event');
  const errors = watchPageErrors(page);
  await signInByApi(page, 'viewer');
  await page.goto(`${OPERATION}?event=${values!.id}`);
  await expect(
    page.locator('main').getByRole('heading', { level: 2, name: /brevo/i })
  ).toBeVisible();
  await expect(page.locator('main').getByRole('button', { name: 'Mark reviewed' })).toHaveCount(0);

  // The owner opens the event first: their page goes stale when the member reviews it.
  const stale = await (await browser.newContext()).newPage();
  await signInByApi(stale, 'owner');
  await stale.goto(`${OPERATION}?event=${values!.id}`);
  await expect(stale.locator('main').getByRole('button', { name: 'Mark reviewed' })).toBeVisible();

  await signInByApi(page, 'member');
  await page.goto(`${OPERATION}?event=${values!.id}`);
  await page.locator('main').getByRole('button', { name: 'Mark reviewed' }).click();
  const dialog = page.getByRole('dialog', { name: 'Mark reviewed' });
  await dialog.getByRole('textbox', { name: 'Note' }).fill('Seen; re-solving');
  await capture(page, testInfo, 'f6-review');
  await dialog.getByRole('button', { name: 'Mark reviewed' }).click();
  await expect(page.locator('main').getByText('“Seen; re-solving”')).toBeVisible();
  await expect(page.locator('main').getByText('Reviewed', { exact: true }).first()).toBeVisible();

  await stale.locator('main').getByRole('button', { name: 'Mark reviewed' }).click();
  await stale
    .getByRole('dialog', { name: 'Mark reviewed' })
    .getByRole('button', { name: 'Mark reviewed' })
    .click();
  await expect(
    stale.getByText(/This event changed; read it again\.|Already reviewed\./).first()
  ).toBeVisible();
  await stale.context().close();

  await page.goto(PAGE);
  await expect(
    page
      .locator('main')
      .getByRole('link', { name: /reviewed|upstream change/ })
      .first()
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test('J2b · Brevo retires PROFESSIONAL: rebinding recommended, the older change superseded; the dashboard and the inbox list it', async ({
  page,
}, testInfo) => {
  test.skip(!values, 'J1 did not detect the event');
  test.setTimeout(300_000);
  const errors = watchPageErrors(page);
  await publish(page.request, 'brevo-professional-retired');
  retired = await detected(
    page.request,
    ownerToken,
    event => event.category === 'binding_invalid' && event.new?.label === '2027-01'
  );
  const older = (await events(page.request, ownerToken)).find(event => event.id === values!.id);
  expect(older?.supersededBy).toBe(retired.id);

  await signInByApi(page, 'owner');
  await page.goto(OPERATION);
  await expect(card(page, 'Production')).toContainText('Rebinding recommended');
  await expect(
    page
      .locator('main')
      .getByRole('list', { name: 'Upstream events' })
      .getByRole('listitem')
      .filter({ hasText: '2026-11' })
  ).toContainText('superseded by a newer upstream version');
  await page.goto(`${OPERATION}?event=${retired.id}`);
  await expect(page.locator('main').getByRole('region', { name: 'Why' })).toContainText(
    'Plan PROFESSIONAL is no longer offered.'
  );
  await capture(page, testInfo, 'f6-event-retired');

  await page.goto('/');
  await expect(
    page.locator('main').getByRole('region', { name: 'Upstream changes' })
  ).toContainText('2027-01');
  await capture(page, testInfo, 'f6-dashboard');
  expect(await feedEtag(page.request)).toBe(before!.etag);
  expect(errors).toEqual([]);
});

test('J3 · the owner updates the problem from SPHERE and derives and adopts Resend PRO as one proposal', async ({
  page,
}, testInfo) => {
  test.skip(!retired, 'J2b did not detect the retirement');
  test.setTimeout(420_000);
  const errors = watchPageErrors(page);
  await signInByApi(page, 'owner');
  const main = page.locator('main');

  // Update from SPHERE: Brevo's pinned version moves to 2027-01, and the problem gets its next revision.
  await page.goto(`/problems/${ORG}/${PROBLEM}`);
  await main.getByRole('button', { name: 'New version' }).click();
  await page.getByRole('menuitem', { name: /Update from SPHERE/ }).click();
  const wizard = page.getByRole('dialog').first();
  const sources = wizard.getByRole('region', { name: 'Pricings in the recipe' });
  await expect(sources).toBeVisible({ timeout: 60_000 });
  const brevo = sources
    .locator('div')
    .filter({ hasText: /brevo/i })
    .filter({ has: page.getByRole('button', { name: 'Change version' }) })
    .last();
  await brevo.getByRole('button', { name: 'Change version' }).click();
  // The version is part of the wizard's address: a choice navigates, then reads as checked.
  const version = wizard.getByRole('radio', { name: /2027-01/ });
  await version.click({ timeout: 60_000 });
  await expect(version).toBeChecked();
  await wizard.getByRole('button', { name: 'Use this version', exact: true }).click();
  await wizard
    .getByRole('button', { name: 'Add to the recipe', exact: true })
    .click({ timeout: 60_000 });
  await wizard.getByRole('button', { name: 'Preview', exact: true }).click({ timeout: 60_000 });
  await wizard.getByRole('button', { name: 'Continue', exact: true }).click({ timeout: 120_000 });
  const revisions = async () =>
    (
      (await (
        await page.request.get(`${API}/v1/organizations/${ORG}/problems/${PROBLEM}`, {
          headers: auth(ownerToken),
        })
      ).json()) as { latest_revision?: { revision: number } }
    ).latest_revision?.revision ?? 0;
  const was = await revisions();
  await wizard
    .getByRole('button', { name: 'Generate revision', exact: true })
    .click({ timeout: 120_000 });
  await expect.poll(revisions, { timeout: 120_000 }).toBeGreaterThan(was);
  const revision = await revisions();

  // The configurator on that revision: Resend PRO for the daily summary, derived and adopted in production in one step.
  // The configurator on the version in effect in production (1.0.0, Brevo PROFESSIONAL), evaluated on that revision.
  await page.goto(`${PAGE}/configuration?version=1.0.0`);
  const variant = main.getByRole('combobox', { name: /problem version|demand/i }).first();
  await variant.selectOption(String(revision));
  await main
    .getByRole('radio', { name: 'email.resend.pro for dailySummary' })
    .click({ timeout: 60_000 });
  const result = main.getByRole('region', { name: 'This binding' });
  await result.getByRole('button', { name: 'Derive as a new version' }).click({ timeout: 120_000 });
  const dialog = page.getByRole('dialog', { name: 'Derive a composition' });
  next = await dialog.getByLabel('Version label').inputValue();
  await dialog.getByRole('button', { name: 'Preview' }).click();
  await expect(dialog.getByRole('region', { name: 'Derived composition.yaml' })).toContainText(
    `${PROBLEM}@${revision}`,
    { timeout: 120_000 }
  );
  await dialog.getByRole('radio', { name: 'Adopt in Production in the same step' }).check();
  await dialog.getByRole('button', { name: `Propose sealing and adopting ${next}` }).click();
  const proposing = page.getByRole('dialog', { name: 'Derive and adopt' });
  const proposal = proposing.getByRole('group', { name: /^Proposal:/ });
  await expect(proposal).toContainText('Waiting for your confirmation', { timeout: 120_000 });
  await proposal
    .getByRole('button', { name: /^Compare with the version in effect in Production/ })
    .click();
  await expect(proposal.getByRole('region', { name: 'Binding' })).toContainText('email.resend.pro');
  await capture(page, testInfo, 'f6-proposal');
  expect(await feedEtag(page.request)).toBe(before!.etag);
  await proposal.getByRole('button', { name: 'Confirm and apply' }).click();
  await expect(proposal).toContainText('Applied', { timeout: 180_000 });

  // Both Brevo events are resolved by the new version; production holds it, adopted through the proposal.
  const after = await events(page.request, ownerToken);
  for (const id of [values!.id, retired!.id])
    expect(after.find(event => event.id === id)?.resolvedBy?.version.label, id).toBe(next);
  const history = (await (
    await page.request.get(`${ROOT}/environments/production/adoptions`, {
      headers: auth(ownerToken),
    })
  ).json()) as { adoptions: Array<{ version: { label: string }; source: string }> };
  expect(history.adoptions[0]).toMatchObject({ version: { label: next }, source: 'proposal' });
  await proposing.getByRole('button', { name: 'Open Production' }).click();
  await expect(page.getByRole('region', { name: 'In effect', exact: true })).toContainText(
    `In effect: ${next}`
  );
  expect(errors).toEqual([]);
});

test('J4 · the application follows the new version and mails through Resend', async ({ page }) => {
  test.skip(!next, 'J3 did not adopt');
  await consumerUntil(page.request, state => state.provider === 'resend' && state.version === next);
  const sent = await page.request.post(`${FEED_CONSUMER}/send`, { data: {} });
  expect(sent.status()).toBe(200);
  const { messageId } = (await sent.json()) as { messageId: string };
  const headers = (await (
    await page.request.get(`${MAILPIT}/api/v1/message/${messageId}/headers`)
  ).json()) as Record<string, string[]>;
  const header = (name: string) =>
    Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1]?.[0];
  expect(header('X-OpenBinding-Composition-Version')).toBe(next);
  expect(header('X-OpenBinding-Provider')).toBe('resend');
});

test('J5 · a proposal made before production moved is out of date, and nothing changes', async ({
  page,
}) => {
  test.skip(!next, 'J3 did not adopt');
  const errors = watchPageErrors(page);
  await signInByApi(page, 'owner');
  const made = await page.request.post(`${ROOT}/proposals`, {
    headers: auth(ownerToken),
    data: { kind: 'adopt', environment: 'production', version: '1.0.0', note: 'J5' },
  });
  expect(made.status(), await made.text()).toBe(201);
  // Production moves by a direct adoption: the proposal's base no longer holds.
  await adoptByApi(page.request, ownerToken, '1.1.0');
  const etag = await feedEtag(page.request);
  await page.goto(OPERATION);
  const card = page
    .locator('main')
    .getByRole('group', { name: 'Proposal: Adopt 1.0.0 in Production' })
    .first();
  await card.getByRole('button', { name: 'Confirm and apply' }).click();
  await expect(card.getByRole('alert')).toContainText(
    'This proposal is out of date: production changed since it was made. Nothing was changed.'
  );
  expect(await feedEtag(page.request)).toBe(etag);
  expect(errors).toEqual([]);
});

test('J6 · the offering changed: TomatoMeter 1.2.0 and the margins in production before and after', async ({
  page,
}, testInfo) => {
  test.skip(unavailable !== null || !ownerToken, 'see J0');
  test.setTimeout(300_000);
  const errors = watchPageErrors(page);
  let offering = (await events(page.request, ownerToken, '?subject=offering'))[0];
  if (!offering) {
    await publish(page.request, 'tomatometer-1.2.0');
    offering = await detected(page.request, ownerToken, event => event.subject === 'offering');
  }
  await signInByApi(page, 'owner');
  await page.goto(`${OPERATION}?event=${offering.id}`);
  const main = page.locator('main');
  await expect(main.getByRole('region', { name: 'Offering plans', exact: true })).toBeVisible();
  await expect(
    main.getByText('The offering is not pinned in the document; this event ends when reviewed.')
  ).toBeVisible();
  if (offering.state === 'open') {
    await main.getByRole('button', { name: 'Mark reviewed' }).click();
    await page
      .getByRole('dialog', { name: 'Mark reviewed' })
      .getByRole('button', { name: 'Mark reviewed' })
      .click();
    await expect(main.getByRole('button', { name: 'Mark reviewed' })).toHaveCount(0);
  }
  await expect(main.getByRole('button', { name: /resolve/i })).toHaveCount(0);
  await capture(page, testInfo, 'f6-event-offering');
  expect(errors).toEqual([]);
});
