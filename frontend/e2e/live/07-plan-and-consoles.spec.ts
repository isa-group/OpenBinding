import { expect, test, type Locator } from '@playwright/test';
import { SPACE_URL, SPHERE_URL, capture, signInByApi, watchPageErrors, type LabRole } from './support';

// The interface shows the plan and what it allows, and sends whoever needs to change a price, a pricing version or a contract to the
// native consoles of SPACE and SPHERE. It manages none of those itself.

async function expectConsoleLinks(scope: Locator, names: { space: string | RegExp; sphere: string | RegExp }): Promise<void> {
  const space = scope.getByRole('link', { name: names.space });
  const sphere = scope.getByRole('link', { name: names.sphere });
  await expect(space).toHaveAttribute('href', SPACE_URL);
  await expect(sphere).toHaveAttribute('href', SPHERE_URL);
  for (const link of [space, sphere]) {
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', /noopener/);
  }
}

test.describe('live · plan, permissions and the native consoles', () => {
  for (const role of ['owner', 'member', 'viewer', 'outsider'] as LabRole[]) {
    test(`${role}: the plan page shows the plan or why it cannot be read, and links to SPACE and SPHERE`, async ({ page }, testInfo) => {
      const errors = watchPageErrors(page);
      await signInByApi(page, role);
      await page.goto('/app/account/usage');

      const main = page.locator('#platform-main');
      await expect(main.getByRole('heading', { level: 1, name: 'Plan & permissions' })).toBeVisible();
      await expect(main.getByRole('link', { name: 'Plan & permissions' })).toHaveAttribute('aria-current', 'page');
      // Either the plan is read, or the gateway says the pricing is unavailable (SPACE enabled and no contract for the lab user): both
      // are honest. The lab normally runs with SPACE disabled (the open gate): there is no plan name and no remote entitlement, and
      // the page says what it can ("Features", each one "Enabled" or "Can’t confirm"); it has no notice of its own for that mode.
      const plan = main.getByRole('region', { name: 'Your plan' });
      await expect(plan.or(main.getByRole('alert')).first()).toBeVisible();
      if (await plan.count()) {
        await expect(main.getByRole('heading', { level: 2, name: 'Features' })).toBeVisible();
        const named = (await plan.locator('.usage-plan-name strong').first().innerText()).trim();
        if (!named) testInfo.annotations.push({ type: 'open-gate', description: 'no plan name: the gateway has no remote entitlements (DEMO_SPACE_ENABLED=false)' });
      }
      await expectConsoleLinks(main, { space: 'Open SPACE console', sphere: 'Open SPHERE console' });

      // Nothing is metered: no meter, no monthly counter, no credits.
      await expect(main.getByRole('meter')).toHaveCount(0);
      await expect(main.getByRole('heading', { name: 'This month' })).toHaveCount(0);
      await expect(main.getByText(/\bcredits?\b|compute units?|capacity units?/i)).toHaveCount(0);
      // No control changes a price, a version or a contract.
      await expect(main.getByRole('button', { name: /request a change|change plan|\bpublish\b|\bupgrade\b|\bbuy\b/i })).toHaveCount(0);
      if (role === 'owner' || role === 'viewer') await capture(page, testInfo, `plan-${role}`);
      expect(errors).toEqual([]);
    });
  }

  test('Home carries a plan block that links to the consoles as well', async ({ page }, testInfo) => {
    const errors = watchPageErrors(page);
    await signInByApi(page, 'owner');
    await page.goto('/app');

    const plan = page.locator('#platform-main').getByRole('region', { name: 'Your plan' });
    await expect(plan).toBeVisible();
    await expect(plan.getByRole('link', { name: 'Plan & permissions' })).toHaveAttribute('href', '/app/account/usage');
    await expectConsoleLinks(plan, { space: 'SPACE', sphere: 'SPHERE' });
    await capture(page, testInfo, 'plan-home-block');
    expect(errors).toEqual([]);
  });

  test('the public pricing page is read-only: it shows the published pricing or says it cannot be read, and sells nothing', async ({ page }, testInfo) => {
    const errors = watchPageErrors(page);
    await page.goto('/pricing');

    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: /\b(buy|checkout|pay now|publish|new version)\b/i })).toHaveCount(0);
    await capture(page, testInfo, 'pricing-public');
    expect(errors).toEqual([]);
  });
});
