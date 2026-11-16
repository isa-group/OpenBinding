import { expect, test } from '@playwright/test';
import { ORG, ORG_PATH, capture, signInByApi, watchPageErrors } from './support';

// J4 against the lab (the mocked twin is e2e/f2b-study-front.spec.ts): the owner of lab-main builds a small study of the problem
// the seed made (simple-seq, version 1) × random-search × seeds 1 and 2, runs it to the end, opens its results and the gateway's
// Pareto front of that version, and derives the focused point into a new composition whose version 1.0.0 is sealed from that
// point's run. Every run of this spec adds a study and a composition to lab-main, named after the moment it ran; nothing is deleted.

/** The name tools/seed_lab.py gives lab-main's simple-seq: the study builder lists problem versions by name. */
const SEEDED_PROBLEM = 'Sequential Service Workflow';

test.describe('live · J4 study front to a composition on lab-main', () => {
  test.use({ viewport: { width: 1440, height: 1000 } });

  test('a study of the seeded version with two seeds, its front computed by the gateway, and one point derived into a composition', async ({
    page,
  }, testInfo) => {
    test.setTimeout(600_000);
    const errors = watchPageErrors(page);
    await signInByApi(page, 'owner');
    const stamp = Date.now().toString(36);
    const slug = `j4-${stamp}`;
    const main = page.locator('main');

    // 1 · The study: the seeded version × random-search × seeds 1 and 2, two cells.
    await page.goto(`/app/${ORG}/studies/new`);
    await expect(main.getByRole('heading', { level: 1, name: 'New study' })).toBeVisible();
    await main
      .getByRole('group', { name: 'Problem versions' })
      .getByRole('checkbox', { name: new RegExp(`^${SEEDED_PROBLEM} · version 1\\b`) })
      .check();
    await main
      .getByRole('group', { name: 'Engine modes' })
      .getByRole('checkbox', { name: /^random-search/ })
      .first()
      .check();
    await main.getByLabel('Study name').fill(`J4 ${stamp}`);
    await expect(main.getByLabel(/Seeds \(comma-separated/)).toHaveValue('1, 2');
    await main.getByRole('button', { name: 'Create study' }).click();
    await expect(main.getByRole('heading', { name: 'Study created' })).toBeVisible({
      timeout: 60_000,
    });
    await main.getByRole('link', { name: 'Open the study' }).click();

    // 2 · Run it and follow it to the end.
    await main.getByRole('button', { name: 'Run study' }).click();
    await main.getByRole('link', { name: 'Follow run #1' }).click();
    const progress = main.getByRole('region', { name: 'Progress of the run' });
    await expect(progress.getByText('Finished · not live')).toBeVisible({ timeout: 300_000 });
    await expect(progress.getByRole('img', { name: '2 completed of 2 cells' })).toBeVisible();
    await capture(page, testInfo, 'j4-1-progress');

    // 3 · The results and the gateway's front of the seeded version: at least one point, focused on the first.
    await main.getByRole('link', { name: 'Compare results' }).click();
    await expect(
      main.getByRole('heading', { level: 2, name: 'Compare results · run #1' })
    ).toBeVisible();
    const front = main.getByRole('region', { name: 'Pareto front' });
    await expect(
      front.getByText(/^\d+ points? · computed by the gateway · lower is better$/)
    ).toBeVisible({ timeout: 60_000 });
    await expect(front.getByRole('region', { name: /^Front of / }).first()).toBeVisible();
    const focused = front.getByRole('group', { name: 'Focused point' });
    await expect(focused).toContainText(/P1 1 of \d+/);
    await expect(focused).toContainText('random-search');
    await capture(page, testInfo, 'j4-2-front');

    // 4 · The focused point becomes a new composition under an address of this run; its 1.0.0 is sealed from the point's run.
    await focused.getByRole('button', { name: 'Derive this point' }).click();
    const dialog = page.getByRole('dialog', { name: 'Derive compositions' });
    const address = dialog.getByLabel('Address of P1');
    await expect(address).toBeVisible();
    await address.fill(slug);
    await dialog.getByRole('button', { name: 'Derive 1 composition' }).click();
    await expect(dialog.getByRole('status')).toHaveText('1 of 1 point holds a composition.', {
      timeout: 120_000,
    });
    await expect(dialog.getByLabel('Result of P1')).toContainText('Created; 1.0.0 sealed.');
    await capture(page, testInfo, 'j4-3-derived');
    await dialog.getByRole('button', { name: 'Done' }).click();

    // The point now names its composition, which opens on that version.
    const made = focused.getByRole('link', { name: `${slug} 1.0.0` });
    await expect(made).toHaveAttribute(
      'href',
      `${ORG_PATH}/compositions/${slug}/versions?version=1.0.0`
    );
    await made.click();
    await expect(page).toHaveURL(`${ORG_PATH}/compositions/${slug}/versions?version=1.0.0`, {
      timeout: 60_000,
    });
    await expect(main.getByRole('heading', { level: 1 })).toBeVisible();
    await capture(page, testInfo, 'j4-4-composition');
    expect(errors).toEqual([]);
  });
});
