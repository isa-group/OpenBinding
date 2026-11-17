import { expect as baseExpect, test, type Page } from '@playwright/test';
import { installMockApi } from './helpers/mockApi';

// J6 · language: a visitor opens the Composition2Yaml reference and the composition editor from the header's Tools, breaks the
// starter and sees the gateway's finding at its line, fixes it, changes the text, copies a share link, and opens that link: the
// editor holds the same text, and the fragment has left the address. There is no backend: e2e/helpers/mockApi.ts answers the API
// origin, and the language services (validate, parse, serialise) are e2e/helpers/mockCompositions.ts's, whose lint flags a kind it
// does not know.

const expect = baseExpect.configure({ timeout: 15_000 });

/** The text Monaco shows (its textarea holds only the line being typed). */
const code = (page: Page) => page.locator('.monaco-editor .view-lines');

test.describe('J6 · language', () => {
  test('a visitor breaks the starter, fixes it, and shares the text through a link that opens it again', async ({
    page,
    context,
  }) => {
    test.setTimeout(120_000);
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await installMockApi(page, 'visitor');
    await page.setViewportSize({ width: 1440, height: 900 });
    const main = page.getByRole('main');

    // The reference, from the public header's Tools.
    await page.goto('/');
    const primary = page.getByRole('navigation', { name: 'Primary navigation' });
    await primary.getByRole('button', { name: 'Tools' }).click();
    await primary.getByRole('link', { name: 'Composition2Yaml' }).click();
    await expect(page).toHaveURL('/language');
    await expect(main.getByRole('heading', { level: 1, name: 'Composition2Yaml' })).toBeVisible();

    // The editor, from the same menu: the starter, checked by the gateway.
    await primary.getByRole('button', { name: 'Tools' }).click();
    await primary.getByRole('link', { name: 'Composition editor' }).click();
    await expect(page).toHaveURL('/editor');
    const problems = page.getByRole('region', { name: 'Problems' });
    await expect(code(page)).toContainText('kind: application');
    await expect(problems).toContainText('No issues');
    await expect(page.getByRole('button', { name: /Sign in/ })).toBeVisible();

    // Break the starter: the gateway's lint marks the line and lists the finding where it is.
    await page.locator('.view-line', { hasText: /^kind:\s+application$/ }).click();
    await page.keyboard.press('End');
    await page.keyboard.type('x');
    await page.keyboard.press('Escape');
    const finding = problems.getByRole('button', { name: /'applicationx' is not a kind/ });
    await expect(finding).toContainText('Line 7, column 7');
    await expect(page.locator('.monaco-editor .squiggly-error')).toHaveCount(1);

    // Fix it, and make the text one's own.
    await page.keyboard.press('Backspace');
    await expect(problems).toContainText('No issues');
    await expect(page.locator('.monaco-editor .squiggly-error')).toHaveCount(0);
    await page.locator('.view-line', { hasText: /^composition:\s+my-composition$/ }).click();
    await page.keyboard.press('End');
    await page.keyboard.type('-shared');
    await page.keyboard.press('Escape');
    await expect(code(page)).toContainText('composition: my-composition-shared');
    await expect(problems).toContainText('No issues');

    // The share link carries the text in its fragment.
    await page.getByRole('button', { name: 'Export' }).click();
    await page.getByRole('menuitem', { name: 'Share link' }).click();
    const share = page.getByRole('dialog', { name: 'Share your composition' });
    await share.getByRole('button', { name: 'Copy' }).click();
    const link = await page.evaluate(() => navigator.clipboard.readText());
    expect(link).toMatch(/\/editor#composition=[A-Za-z0-9+\-$]+$/);
    await page.keyboard.press('Escape');

    // Opening it elsewhere gives the same text back, and the address no longer carries it.
    await page.goto('/team');
    await page.goto(link);
    await expect(code(page)).toContainText('composition: my-composition-shared');
    await expect(page).toHaveURL('/editor');
    await expect(problems).toContainText('No issues');
  });
});
