import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';

test('the dedicated pricing route renders the authoritative iPricing YAML', async ({ page }) => {
  const yaml = await readFile(resolve(process.cwd(), '../space/pricing/openbinding.yml'), 'utf8');
  expect(yaml).toContain("syntaxVersion: '3.1'");

  await page.route('**/v1/pricing', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/yaml', body: yaml });
  });

  await page.goto('/pricing');

  await expect(page).toHaveURL(/\/pricing$/);
  await expect(page.getByRole('heading', { name: 'Solve as much as you need to' })).toBeVisible();
  await expect(page.locator('pricing-renderer[data-pr-root]')).toBeVisible();
  await expect(page.locator('.pricing-renderer-shell')).toContainText('FREE');
  await expect(page.locator('.pricing-renderer-shell')).toContainText('PRO');
});
