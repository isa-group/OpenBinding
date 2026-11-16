import { expect as baseExpect, test, type Page } from '@playwright/test';
import { installMockApi } from './helpers/mockApi';

// J6 · language: a visitor opens the Composition2Yaml reference, breaks the sample in its playground and sees the gateway's finding
// at its line, fixes it, changes the text, copies a share link, and opens that link: the playground holds the same text, and the
// fragment has left the address. There is no backend: e2e/helpers/mockApi.ts answers the API origin, and the language services
// (validate, parse, serialise) are e2e/helpers/mockCompositions.ts's, whose lint flags a kind it does not know.

const expect = baseExpect.configure({ timeout: 15_000 });

/** The text of the playground, line by line, as CodeMirror shows it. */
const playgroundText = async (page: Page) =>
  (await page.getByRole('main').locator('.cm-content .cm-line').allInnerTexts()).join('\n');

test.describe('J6 · language', () => {
  test('a visitor breaks the sample, fixes it, and shares the text through a link that opens it again', async ({
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
    const source = main.getByRole('textbox', { name: 'composition.yaml source' });
    const problems = main.getByRole('region', { name: 'Problems' });
    const toolbar = main.getByRole('toolbar', { name: 'Playground' });
    await expect(source).toContainText('kind: application');
    await expect(toolbar).toContainText('Valid Composition2Yaml');
    await expect(problems).toContainText('No issues');

    // Break the sample: the gateway's lint marks the line and lists the finding where it is.
    await source.getByText('kind: application').click();
    await page.keyboard.press('End');
    await page.keyboard.type('x');
    const finding = problems.getByRole('button', { name: /'applicationx' is not a kind/ });
    await expect(finding).toContainText('Line 7, column 7');
    await expect(main.locator('.cm-lintRange-error')).toHaveCount(1);
    await expect(toolbar).toContainText('Not valid yet');

    // Fix it, and make the text one's own.
    await page.keyboard.press('Escape');
    await page.keyboard.press('Backspace');
    await expect(problems).toContainText('No issues');
    await expect(main.locator('.cm-lintRange-error')).toHaveCount(0);
    await source.getByText('composition: my-composition').click();
    await page.keyboard.press('End');
    await page.keyboard.type('-shared');
    await expect(source).toContainText('composition: my-composition-shared');
    await expect(toolbar).toContainText('Valid Composition2Yaml');
    const written = await playgroundText(page);

    // The canonical form is the gateway's writing of the same document.
    await main.getByRole('tab', { name: 'Canonical form' }).click();
    await expect(main.getByRole('region', { name: 'Canonical form' }).locator('pre')).toContainText(
      'composition: my-composition-shared'
    );
    await main.getByRole('tab', { name: 'Problems' }).click();

    // The share link carries the text in its fragment.
    await toolbar.getByRole('button', { name: 'Copy share link' }).click();
    await expect(toolbar).toContainText('Share link copied');
    const link = await page.evaluate(() => navigator.clipboard.readText());
    expect(link).toMatch(/\/language#composition=[A-Za-z0-9+\-$]+$/);

    // Opening it elsewhere gives the same text back, and the address no longer carries it.
    await page.goto('/about');
    await page.goto(link);
    await expect(main.getByRole('heading', { level: 1, name: 'Composition2Yaml' })).toBeVisible();
    await expect(source).toContainText('composition: my-composition-shared');
    expect(await playgroundText(page)).toBe(written);
    await expect(page).toHaveURL('/language');
    await expect(problems).toContainText('No issues');
  });
});
