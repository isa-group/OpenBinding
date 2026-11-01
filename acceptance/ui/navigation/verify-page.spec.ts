import { expect, test, type Page } from '@playwright/test';
import {
  CANONICAL_MARK, D, DOCUMENT, DOCUMENT_MARK, KINDS, MATCH_TITLE, PUBLISHED_TITLE, address, chooseKind, documentField,
  expectAddress, fieldValues, linkField, mockVerify, mode, rawPres, resolvePaths, storedState, submitButton, trackAddresses,
  verifierCalls,
} from './helpers-hub';
import { pathOf } from './helpers';

test.use({ viewport: { width: 1280, height: 800 } });

const LOGIN_NOTICE = 'Log in to check a document or a file';

/** Pastes the document in the mode `Document` and submits it. */
async function checkDocument(page: Page): Promise<void> {
  await mode(page, 'Document').click();
  await documentField(page).fill(JSON.stringify(DOCUMENT));
  await submitButton(page).click();
}

// ---- frontend-nav-verify-page -----------------------------------------------------------------------------------

// [utest->req~frontend-nav-verify-page~1]
test('a permanent link in the address is resolved once and shows the published result', async ({ page }) => {
  const calls = await mockVerify(page, { role: null });
  await page.goto(`/verify/report/${D}`);
  await expect(page.getByText(PUBLISHED_TITLE).first()).toBeVisible();
  expect(resolvePaths(calls)).toEqual([`/v1/resolve/report/${D}`]);
});

// [utest->req~frontend-nav-verify-page~1]
test('a permanent link in the address is resolved for a signed-in person too', async ({ page }) => {
  const calls = await mockVerify(page);
  await page.goto(`/verify/report/${D}`);
  await expect(page.getByText(PUBLISHED_TITLE).first()).toBeVisible();
  expect(resolvePaths(calls)).toEqual([`/v1/resolve/report/${D}`]);
});

// [utest->req~frontend-nav-verify-page~1]
test('the Verify page offers the modes Link or digest, Document and File', async ({ page }) => {
  await mockVerify(page);
  await page.goto('/verify');
  for (const name of ['Link or digest', 'Document', 'File']) await expect(mode(page, name)).toBeVisible();
});

// [utest->req~frontend-nav-verify-page~1]
test('a permanent link pasted into the form becomes the address of the Verify page', async ({ page }) => {
  await mockVerify(page, { role: null });
  await page.goto('/verify');
  await mode(page, 'Link or digest').click();
  await linkField(page).fill(`https://ob.example/resolve/case-revision/${D}`);
  await linkField(page).press('Enter');
  await expectAddress(page, `/verify/case-revision/${D}`);
});

// [utest->req~frontend-nav-verify-page~1]
test('a digest without a kind is posted to the verifier when signed in and lists the matches', async ({ page }) => {
  const calls = await mockVerify(page);
  await page.goto(`/verify?digest=${D}`);
  await expect.poll(() => verifierCalls(calls).filter((call) => call.method === 'POST' && call.path === '/v1/verifier/inspect')
    .map((call) => (JSON.parse(call.body) as { digest?: string }).digest)).toContain(D);
  await expect(page.getByText(MATCH_TITLE).first()).toBeVisible();
});

// [utest->req~frontend-nav-verify-page~1]
test('a pasted document is posted to the verifier inspect endpoint', async ({ page }) => {
  const calls = await mockVerify(page);
  await page.goto('/verify');
  await checkDocument(page);
  await expect.poll(() => calls.filter((call) => call.method === 'POST' && call.path === '/v1/verifier/inspect')
    .some((call) => call.body.includes(DOCUMENT_MARK))).toBe(true);
  await expect(page.getByText(MATCH_TITLE).first()).toBeVisible();
});

// [utest->req~frontend-nav-verify-page~1]
test('a file is posted to the verifier inspect-file endpoint', async ({ page }) => {
  const calls = await mockVerify(page);
  await page.goto('/verify');
  await mode(page, 'File').click();
  await page.locator('input[type="file"]').first().setInputFiles({
    name: 'problem.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(DOCUMENT)),
  });
  const submit = submitButton(page);
  if (await submit.count()) await submit.click();
  await expect.poll(() => calls.filter((call) => call.method === 'POST' && call.path === '/v1/verifier/inspect-file').length).toBeGreaterThan(0);
  await expect(page.getByText(MATCH_TITLE).first()).toBeVisible();
});

// ---- frontend-nav-verify-permanent-links ------------------------------------------------------------------------

// [utest->req~frontend-nav-verify-permanent-links~1]
test('every resolver kind opened at /resolve while signed out ends on /verify and never shows /login', async ({ page }) => {
  test.setTimeout(120_000);
  await mockVerify(page, { role: null });
  const seen = trackAddresses(page);
  for (const kind of KINDS) {
    await page.goto(`/resolve/${kind}/${D}`);
    await expectAddress(page, `/verify/${kind}/${D}`);
  }
  expect(seen.filter((path) => path === '/login')).toEqual([]);
});

// [utest->req~frontend-nav-verify-permanent-links~1]
test('a permanent link signed in keeps its query and hash on /verify', async ({ page }) => {
  await mockVerify(page);
  await page.goto(`/resolve/report/${D}?page=2#locations`);
  await expectAddress(page, `/verify/report/${D}?page=2#locations`);
});

// [utest->req~frontend-nav-verify-permanent-links~1]
test('a verifier citation link while signed out ends on /verify and never shows /login', async ({ page }) => {
  await mockVerify(page, { role: null });
  const seen = trackAddresses(page);
  await page.goto(`/app/verifier?digest=${D}`);
  await expectAddress(page, `/verify?digest=${D}`);
  expect(seen.filter((path) => path === '/login')).toEqual([]);
});

// [utest->req~frontend-nav-verify-permanent-links~1]
test('the verifier address without a query ends on /verify, signed in', async ({ page }) => {
  await mockVerify(page);
  await page.goto('/app/verifier');
  await expectAddress(page, '/verify');
});

// [utest->req~frontend-nav-verify-permanent-links~1]
test('a permanent link replaces the history entry instead of adding one', async ({ page }) => {
  test.setTimeout(90_000);
  await mockVerify(page, { role: null });
  await page.goto('/about');
  await page.goto(`/resolve/report/${D}`);
  await expectAddress(page, `/verify/report/${D}`);
  await page.goBack({ waitUntil: 'commit' });
  await expect.poll(() => pathOf(page)).toBe('/about');
});

// [utest->req~frontend-nav-verify-permanent-links~1]
test('the verifier address replaces the history entry instead of adding one', async ({ page }) => {
  test.setTimeout(90_000);
  await mockVerify(page, { role: null });
  await page.goto('/about');
  await page.goto(`/app/verifier?digest=${D}`);
  await expectAddress(page, `/verify?digest=${D}`);
  await page.goBack({ waitUntil: 'commit' });
  await expect.poll(() => pathOf(page)).toBe('/about');
});

// [utest->req~frontend-nav-verify-permanent-links~1]
test('copying the permanent link of a resolved result puts the /resolve form on the clipboard', async ({ page }) => {
  await mockVerify(page, { role: null });
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto(`/verify/report/${D}`);
  await expect(page.getByText(PUBLISHED_TITLE).first()).toBeVisible();
  await page.getByRole('button', { name: /copy.*link/i }).first().click();
  const origin = new URL(page.url()).origin;
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(`${origin}/resolve/report/${D}`);
});

// ---- frontend-nav-verify-signed-out -----------------------------------------------------------------------------

// [utest->req~frontend-nav-verify-signed-out~1]
test('a permanent link while signed out calls only the resolver and never the verifier', async ({ page }) => {
  const calls = await mockVerify(page, { role: null });
  await page.goto(`/verify/report/${D}`);
  await expect(page.getByText(PUBLISHED_TITLE).first()).toBeVisible();
  await page.waitForLoadState('networkidle');
  expect(resolvePaths(calls)).toEqual([`/v1/resolve/report/${D}`]);
  expect(verifierCalls(calls)).toEqual([]);
});

// [utest->req~frontend-nav-verify-signed-out~1]
test('the mode Document while signed out asks to log in and offers no document field', async ({ page }) => {
  const calls = await mockVerify(page, { role: null });
  await page.goto('/verify');
  await mode(page, 'Document').click();
  await expect(page.getByText(LOGIN_NOTICE).first()).toBeVisible();
  await expect(page.locator('main a[href="/login"]').first()).toBeVisible();
  await expect(page.locator('main textarea')).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: /document/i })).toHaveCount(0);
  expect(calls.filter((call) => call.path === '/v1/verifier/inspect')).toEqual([]);
});

// [utest->req~frontend-nav-verify-signed-out~1]
test('the log-in link of Document mode leads to /login and promises no return to /verify', async ({ page }) => {
  await mockVerify(page, { role: null });
  await page.goto('/verify');
  await mode(page, 'Document').click();
  const link = page.locator('main a[href="/login"]').first();
  await expect(link).toBeVisible();
  expect(await link.getAttribute('href')).toBe('/login');
  expect(await storedState(page)).not.toContain('/verify');
  await link.click();
  await expectAddress(page, '/login');
  expect(await storedState(page)).not.toContain('/verify');
});

// [utest->req~frontend-nav-verify-signed-out~1]
test('the mode File while signed out asks to log in and offers no file input', async ({ page }) => {
  const calls = await mockVerify(page, { role: null });
  await page.goto('/verify');
  await mode(page, 'File').click();
  await expect(page.getByText(LOGIN_NOTICE).first()).toBeVisible();
  await expect(page.locator('main a[href="/login"]').first()).toBeVisible();
  await expect(page.locator('input[type="file"]')).toHaveCount(0);
  expect(verifierCalls(calls)).toEqual([]);
});

// [utest->req~frontend-nav-verify-signed-out~1]
test('a digest without a kind while signed out shows the digest and a kind selector and sends nothing', async ({ page }) => {
  const calls = await mockVerify(page, { role: null });
  await page.goto(`/verify?digest=${D}`);
  await expect(page.getByRole('combobox', { name: /kind/i }).first()).toBeVisible();
  await expect.poll(() => fieldValues(page)).toContain(D);
  await page.waitForLoadState('networkidle');
  expect(resolvePaths(calls)).toEqual([]);
  expect(verifierCalls(calls)).toEqual([]);
});

// [utest->req~frontend-nav-verify-signed-out~1]
test('choosing a kind for a digest while signed out resolves it and changes the address', async ({ page }) => {
  const calls = await mockVerify(page, { role: null });
  await page.goto(`/verify?digest=${D}`);
  await chooseKind(page, 'case-revision');
  await expectAddress(page, `/verify/case-revision/${D}`);
  await expect.poll(() => resolvePaths(calls)).toEqual([`/v1/resolve/case-revision/${D}`]);
  expect(verifierCalls(calls)).toEqual([]);
});

// [utest->req~frontend-nav-verify-signed-out~1]
test('a 404 for an unknown digest says nothing public matches and keeps the form', async ({ page }) => {
  await mockVerify(page, { role: null, resolve: 'missing' });
  await page.goto(`/verify/report/${D}`);
  await expect(page.getByText('Nothing public matches this digest').first()).toBeVisible();
  await expect(linkField(page)).toBeVisible();
});

// [utest->req~frontend-nav-verify-signed-out~1]
test('a 404 for a private element says the same as an unknown digest', async ({ page }) => {
  await mockVerify(page, { role: null, resolve: 'private' });
  await page.goto(`/verify/report/${D}`);
  await expect(page.getByText('Nothing public matches this digest').first()).toBeVisible();
  await expect(page.getByText('The element is private')).toHaveCount(0);
  await expect(linkField(page)).toBeVisible();
});

// ---- frontend-nav-verify-no-raw-json ----------------------------------------------------------------------------

// [utest->req~frontend-nav-verify-no-raw-json~1]
test('the canonical JSON of a checked document is in a collapsed Canonical JSON disclosure', async ({ page }) => {
  await mockVerify(page);
  await page.goto('/verify');
  await checkDocument(page);
  const disclosure = page.locator('details').filter({ has: page.locator('summary', { hasText: 'Canonical JSON' }) });
  await expect(disclosure).toBeVisible();
  await expect(disclosure).not.toHaveAttribute('open', /.*/);
  await expect(page.getByText(CANONICAL_MARK)).toBeHidden();
});

// [utest->req~frontend-nav-verify-no-raw-json~1]
test('opening the disclosure shows a SourceView region Canonical JSON with its copy button', async ({ page }) => {
  await mockVerify(page);
  await page.goto('/verify');
  await checkDocument(page);
  await page.locator('summary', { hasText: 'Canonical JSON' }).click();
  const region = page.getByRole('region', { name: 'Canonical JSON', exact: true });
  await expect(region).toBeVisible();
  await expect(region.getByText(CANONICAL_MARK)).toBeVisible();
  await expect(region.getByRole('button', { name: 'Copy Canonical JSON' })).toBeVisible();
});

// [utest->req~frontend-nav-verify-no-raw-json~1]
test('after a document check with the disclosure open every pre is inside a SourceView region', async ({ page }) => {
  await mockVerify(page);
  await page.goto('/verify');
  await checkDocument(page);
  await page.locator('summary', { hasText: 'Canonical JSON' }).click();
  await expect(page.getByText(CANONICAL_MARK)).toBeVisible();
  expect(await page.locator('pre').count()).toBeGreaterThan(0);
  expect(await rawPres(page)).toEqual([]);
});

// [utest->req~frontend-nav-verify-no-raw-json~1]
test('a resolved published result holds no pre outside a SourceView region', async ({ page }) => {
  await mockVerify(page, { role: null });
  await page.goto(`/verify/report/${D}`);
  await expect(page.getByText(PUBLISHED_TITLE).first()).toBeVisible();
  await page.waitForLoadState('networkidle');
  expect(await rawPres(page)).toEqual([]);
  expect(address(page)).toBe(`/verify/report/${D}`);
});
