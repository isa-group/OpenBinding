import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { readGalleryScreens, type GalleryScreen } from './helpers/galleryRoutes';
import { installMockApi } from './helpers/mockApi';
import { measurePage, prepareCapture, waitUntilSettled, type PageMeasure } from './helpers/pageChecks';

// QA gallery: one picture of the first screenful of every screen of the registry (src/routes/d1.tsx .. d8.tsx), on a desktop and on a
// phone, saved to <QA_GALLERY_DIR>/<desktop|mobile>/<screen-id>.png for a person to review. QA_GALLERY_DIR defaults to
// frontend/node_modules/.cache/qa-gallery/screenshots/: the pictures are review material, not part of the repository.
//
//   pnpm exec playwright test e2e/qa-gallery.spec.ts
//
// There is no backend: e2e/helpers/mockApi.ts answers the API origin with one shared, populated mock, and every page believes it is
// 2026-10-09 12:00 UTC. Public screens are visited without a session; everything under /app (and the invitation link, which serves
// both) is visited as a platform administrator of an institutional account.

const screens = readGalleryScreens();

const SCREENSHOTS = process.env.QA_GALLERY_DIR
  ? `${process.env.QA_GALLERY_DIR.replace(/\/+$/, '')}/`
  : fileURLToPath(new URL('../node_modules/.cache/qa-gallery/screenshots/', import.meta.url));
/** Measurements of every page, for the person fixing what the pictures show. Not part of the repository. */
const MEASUREMENTS = fileURLToPath(new URL('../node_modules/.cache/qa-gallery/', import.meta.url));

/** The first heading each screen must show once it has loaded. A screen whose title depends on the data names the mock's data. */
const HEADING: Record<string, RegExp> = {
  'pub-home': /Describe\. Bind\. Reproduce\./,
  'pub-explore': /Public work on OpenBinding/,
  'pub-resolve': /Verify by digest/,
  'eng-catalog': /Engine catalog/,
  'eng-detail': /bim\.builtin\/random-search@1\.0\.0/,
  'lang-profiles': /The BIM language/,
  'lang-schemas': /Schemas/,
  'lang-examples': /Example packages/,
  'pub-workbench': /Workbench/,
  'pub-about': /People, research and changes behind OpenBinding/,
  'pub-status': /Service status/,
  'auth-login': /Welcome back/,
  'auth-register': /Create your account/,
  'auth-reset-request': /Forgot your password\?/,
  'auth-reset-complete': /Set a new password/,
  'auth-cas-callback': /no code to finish sign-in/,
  'org-invite-accept': /Paste your invitation/,
  'sys-states': /States and recoverable errors/,
  'pub-pricing': /Plans for every kind of binding work/,
  'acct-profile': /^Account$/,
  'acct-usage': /Plan & permissions/,
  'acct-keys': /^API keys$/,
  'acct-key-new': /New API key/,
  'acct-identities': /^Identities$/,
  'acct-notifications': /^Notifications$/,
  'app-home': /Hello, alex\.rivera/,
  'org-create': /New organization/,
  'org-overview': /ISA Demo Group/,
  'org-settings': /^Settings$/,
  'org-members': /^Members$/,
  'org-audit': /Audit log/,
  'proj-create': /New project in ISA Demo Group/,
  'proj-overview': /QoS Benchmarks/,
  'proj-settings': /Project settings/,
  'proj-package': /Portable package/,
  'case-list': /^Cases$/,
  'case-detail': /Checkout flow/,
  'case-composer': /New revision of Checkout flow/,
  'case-revision': /Checkout flow · revision 2/,
  'case-compare': /Compare revisions/,
  'wb-workbench': /Workbench/,
  'snap-detail': /Compiled snapshot/,
  'proj-files': /^Files$/,
  'coll-list': /^Collections$/,
  'coll-detail': /Checkout references/,
  'gen-lab': /Generator lab/,
  'job-launch': /New run/,
  'job-list': /^Jobs$/,
  'job-detail': /random-search run/,
  'job-history': /My jobs/,
  'study-list': /^Studies$/,
  'study-builder': /New study/,
  'study-detail': /Engines × seeds/,
  'study-run': /Run #1/,
  'study-cell': /Cell 2/,
  'study-analytics': /Compare results · run #1/,
  'proj-publications': /^Publications$/,
  verifier: /Verifier/,
  'eng-register': /Register a private engine/,
  'eng-registrations': /My engines/,
  'eng-registration-detail': /edge-solver/,
  'lang-extensions': /Language extensions/,
  'admin-overview': /Administration/,
  'admin-users': /Accounts/,
  'admin-user-detail': /sam\.okafor/,
  'admin-audit': /Audit log/,
  'admin-errors': /Errors/,
  'admin-queues': /Queues/,
  'admin-moderation': /Moderation/,
  'admin-maintenance': /Maintenance/,
  'admin-sponsor': /Transfer sponsorship/,
};

const VIEWPORTS = [
  { name: 'desktop', viewport: { width: 1440, height: 900 }, isMobile: false, deviceScaleFactor: 1 },
  { name: 'mobile', viewport: { width: 390, height: 844 }, isMobile: true, deviceScaleFactor: 2 },
] as const;

interface Measurement extends PageMeasure {
  id: string;
  url: string;
  viewport: string;
  session: string;
  unmocked: string[];
  problems: string[];
  waiting: string[];
  /** What made the test fail, in words. */
  failures: string[];
}

const NOTHING: PageMeasure = {
  title: '', h1: [], h1Font: null, displayHeadings: [], overflowX: 0, offenders: [], clipped: [], lowContrast: [], darkSurfaces: [], alerts: [], spanish: [], placeholders: [],
  prototypeLeftovers: [], overlays: [], brokenImages: [], emptyControls: [], brand: { header: 0, footer: 0, mobileMenu: 0 },
  projectTabs: { present: false, scrolls: false, visible: 0, total: 0 }, textLength: 0,
};

/** Rebuilds the summary of a viewport from the per-screen files (every worker writes its own, the last one to finish sees them all). */
function summarize(viewport: string) {
  const folder = `${MEASUREMENTS}${viewport}/`;
  const target = `${MEASUREMENTS}${viewport}.txt`;
  try {
    const all = readdirSync(folder).filter((file) => file.endsWith('.json')).sort().flatMap((file) => {
      try {
        return [JSON.parse(readFileSync(`${folder}${file}`, 'utf8')) as Measurement];
      } catch {
        return []; // another worker is writing it right now: the next summary has it
      }
    });
    const scratch = `${target}.${process.pid}.tmp`;
    writeFileSync(scratch, all.map(oneLine).join('\n'));
    renameSync(scratch, target);
  } catch {
    // The summary is a convenience for the reviewer; a screen's picture does not depend on it.
  }
}

/** One line per screen: what it is and everything the measurements found wrong, if anything. */
function oneLine(m: Measurement): string {
  const found: string[] = [];
  const add = (label: string, values: string[]) => { if (values.length) found.push(`${label}=[${values.join(' | ')}]`); };
  add('FAILED', m.failures);
  add('displayHeadings', m.displayHeadings);
  if (m.h1Font) {
    // The computed stack is "PP Editorial Old", Georgia, serif: Georgia must be the second family, Times New Roman must not appear.
    const stack = m.h1Font.split(',').map((family) => family.trim().replace(/^["']|["']$/g, ''));
    if (stack[0] !== 'PP Editorial Old' || stack[1] !== 'Georgia') found.push(`h1 is not in the display stack (PP Editorial Old, Georgia, serif): ${m.h1Font}`);
  }
  if (m.overflowX > 1) found.push(`overflowX=${m.overflowX}`);
  add('offenders', m.offenders);
  add('clipped', m.clipped);
  add('contrast', m.lowContrast);
  add('dark', m.darkSurfaces);
  add('alerts', m.alerts);
  add('spanish', m.spanish);
  add('placeholders', m.placeholders);
  add('prototype', m.prototypeLeftovers);
  add('overlays', m.overlays);
  add('images', m.brokenImages);
  add('emptyControls', m.emptyControls);
  add('unmocked', m.unmocked);
  add('problems', m.problems);
  add('waiting', m.waiting);
  const brand = `brand ${m.brand.header}/${m.brand.footer}/${m.brand.mobileMenu}`;
  const tabs = m.projectTabs.present ? ` tabs ${m.projectTabs.visible}/${m.projectTabs.total}${m.projectTabs.scrolls ? ' scroll' : ''}` : '';
  return `${m.id} ${m.url} · h1 "${m.h1.join('" "')}" · ${m.session} · ${brand}${tabs} · text ${m.textLength}${found.length ? `\n    ${found.join('\n    ')}` : ''}`;
}

/** Uncaught exceptions and React error reports are critical; a request the mock did not answer is reported apart. */
function watchCriticalErrors(page: Page) {
  const critical: string[] = [];
  page.on('pageerror', (error) => critical.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    if (/Failed to load resource|net::ERR_/i.test(text)) return;
    if (/The above error occurred|Minified React error|Maximum update depth|Uncaught/i.test(text)) critical.push(`console: ${text.slice(0, 300)}`);
  });
  return critical;
}

/**
 * The status screen shows how long each probe took, measured with the browser's own clock: it differs on every run. The picture shows
 * the same plausible figure each time instead.
 */
async function freezeProbeTimes(page: Page) {
  await page.evaluate(() => {
    for (const element of document.querySelectorAll('small')) {
      if (/^\d+ ms$/.test(element.textContent ?? '')) element.textContent = '120 ms';
    }
  });
}

/** A session for /app and for the invitation link; the other public addresses are visited by nobody in particular. */
const sessionOf = (screen: GalleryScreen) => (screen.underApp || screen.sessionHeader ? 'admin' : 'none');

test.describe('gallery registry', () => {
  test('lists all 71 screens of the prototype', () => {
    expect(screens).toHaveLength(71);
    expect(new Set(screens.map((screen) => screen.id)).size).toBe(71);
  });
});

for (const { name, viewport, isMobile, deviceScaleFactor } of VIEWPORTS) {
  test.describe(`${name} · QA gallery`, () => {
    // The same dates and numbers whoever runs the gallery and wherever: English formats, UTC.
    test.use({ viewport, isMobile, deviceScaleFactor, locale: 'en-US', timezoneId: 'UTC' });
    test.setTimeout(120_000);

    mkdirSync(`${SCREENSHOTS}${name}`, { recursive: true });
    mkdirSync(`${MEASUREMENTS}${name}`, { recursive: true });

    for (const screen of screens) {
      test(`${screen.id} ${screen.path}`, async ({ page }) => {
        const record = `${MEASUREMENTS}${name}/${screen.id}.json`;
        rmSync(record, { force: true });
        const session = sessionOf(screen);
        const failures: string[] = [];
        const critical = watchCriticalErrors(page);
        const mock = await installMockApi(page, session);
        let measured: PageMeasure | null = null;
        let waiting: string[] = [];

        try {
          await page.goto(screen.url, { waitUntil: 'domcontentloaded' });

          // The layout of the screen has arrived, and the screen itself has a title.
          const header = page.locator(screen.underApp || screen.sessionHeader ? 'header.app-header' : 'header.site-header');
          await expect(header).toBeVisible({ timeout: 30_000 });
          await expect(page.locator('main h1, #platform-main h1').first()).toHaveText(HEADING[screen.id] ?? /\S/, { timeout: 30_000 });

          waiting = await waitUntilSettled(page);
          await prepareCapture(page);
          if (screen.id === 'pub-status') await freezeProbeTimes(page);
          measured = await measurePage(page);
          await page.screenshot({ path: `${SCREENSHOTS}${name}/${screen.id}.png`, animations: 'disabled', fullPage: false });

          const text = await page.evaluate(() => document.body.innerText);
          if (text.includes('This screen is being rebuilt')) failures.push('shows the placeholder of a screen that is being rebuilt');
          if (text.includes('Something went wrong')) failures.push('fell into the error boundary');
          if (text.includes('not mocked')) failures.push('shows an error that says the mock does not answer');
        } catch (error) {
          failures.push(String(error instanceof Error ? error.message : error).split('\n').slice(0, 5).join(' ⏎ '));
        }

        // What the page asked for while it settled counts too.
        await page.waitForTimeout(150);
        if (waiting.length) failures.push(`has not finished loading: ${waiting.join('; ')}`);
        if (critical.length) failures.push(`raised critical console errors: ${critical.join('; ')}`);
        if (measured && measured.overflowX > 1) failures.push(`scrolls sideways by ${measured.overflowX}px`);
        if (measured?.overlays.length) failures.push(`shows a dialog, banner or overlay: ${measured.overlays.join(', ')}`);
        if (mock.unmocked.length) failures.push(`asked for what the mock does not answer: ${mock.unmocked.join(', ')}`);

        const result: Measurement = {
          ...(measured ?? NOTHING), id: screen.id, url: screen.url, viewport: name, session, unmocked: mock.unmocked, problems: critical, waiting, failures,
        };
        writeFileSync(record, JSON.stringify(result, null, 1));
        summarize(name);

        expect(failures, `${screen.url} on the ${name} gallery`).toEqual([]);
      });
    }
  });
}
