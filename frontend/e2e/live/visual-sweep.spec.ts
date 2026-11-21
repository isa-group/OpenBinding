import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { readScreenLines } from '../helpers/galleryRoutes';
import { API, CASE, LAB_USERS, ORG, OTHER_ORG, RESULTS_DIR, signInByApi } from './support';

/**
 * The palette × size sweep of the lab (F2c described it, F3 commits it), measured by the page itself:
 *
 * - every screen of the route table (`src/routes/router.tsx`, 39 today) and the extra tabs and dialogs of F2c and F3 (the
 *   organization's tabs, a problem's Candidates and Versions, the study front, a public showcase, a SPHERE problem's Candidates,
 *   the SPHERE wizard's steps, a composition drawn from SPHERE snapshots and the beta Connections tab), in both palettes
 *   (`data-brand` sphere and openbinding) at 1440×900 and 390×844: the requested brand is the one drawn, nothing scrolls
 *   sideways, nothing throws, and nothing is asked of a CDN;
 * - a 375 px pass over the same screens: no horizontal overflow and no control under 24 px;
 * - a dark operating system: the body stays light and no `dark:` class of a copied component applies.
 *
 * Screenshots go to `<results>/visual-sweep/<pass>-<screen>.png` and one JSON report per pass beside them. The owner walks
 * the screens behind a session; a visitor the public ones. Beta features are switched on for the owner for the walk and off
 * again at the end.
 */

const OUT = `${RESULTS_DIR}/visual-sweep`;
const BRAND_KEY = 'openbinding:brand';
const PALETTES = ['sphere', 'openbinding'] as const;
const SIZES = [
  ['desktop', { width: 1440, height: 900 }],
  ['phone', { width: 390, height: 844 }],
] as const;
/** The recorded SPHERE family and version the wizard's address steps name (danruilop1's Mailgun, `2026-10`). */
const MAILGUN = { pricing: '6ade364540e55445692b0eda', version: '6ade36454b2b5b01c587db3d' };
const TOMATOMETER_PROBLEM = 'tomatometer-email';

interface Stop {
  /** The route table's id for one of its screens; another name for an extra tab or dialog. */
  id: string;
  path: string;
  visitor?: boolean;
}

interface Row extends Stop {
  brand: string | null;
  overflow: number;
  small: string[];
  errors: string[];
  dark: { bg: string; light: boolean; darkClass: boolean } | null;
}

async function json(
  page: Page,
  token: string,
  path: string,
  init?: { method?: string; data?: unknown }
) {
  const response = await page.request.fetch(`${API}${path}`, {
    method: init?.method ?? 'GET',
    headers: { Authorization: `Bearer ${token}` },
    data: init?.data,
  });
  return response.ok() ? response.json() : null;
}

/** The owner's beta switch, written through the gateway (with the revision it read). */
async function setBeta(page: Page, token: string, enabled: boolean) {
  const setting = `${API}/v1/users/me/settings/beta-features`;
  const read = await page.request.get(setting, { headers: { Authorization: `Bearer ${token}` } });
  const etag = read.headers()['etag'];
  await page.request.put(setting, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(etag ? { 'If-Match': etag } : {}),
    },
    data: { enabled },
  });
}

/** The screens of the route table and the extra tabs and dialogs, with the lab's own data in their addresses. */
async function stops(page: Page, token: string): Promise<Stop[]> {
  const runs = await json(page, token, `/v1/organizations/${ORG}/runs?limit=1`);
  const run = runs?.runs?.[0]?.id ?? '00000000-0000-4000-8000-000000000001';
  const studies = await json(page, token, `/v1/organizations/${ORG}/studies`);
  const study = (Array.isArray(studies) ? studies[0]?.slug : undefined) ?? 'none';
  const compositions = await json(page, token, `/v1/organizations/${ORG}/compositions?limit=1`);
  const composition = compositions?.compositions?.[0] ?? {
    slug: 'sequential-workflow',
    id: 'none',
  };
  const engines = await json(page, token, '/v1/engines');
  const engine = engines?.engines?.[0] ?? {
    namespace: 'bim.builtin',
    name: 'random-search',
    version: '1.0.0',
  };
  const registrations = await json(page, token, '/v1/engine-registrations');
  const registration = registrations?.registrations?.[0]?.name ?? 'none';
  const invitation = await json(page, token, `/v1/organizations/${ORG}/invitations`, {
    method: 'POST',
    data: { expires_in_days: 7 },
  });
  const code = invitation?.code ?? 'none';
  const wizard = `/problems/${ORG}/${TOMATOMETER_PROBLEM}/candidates`;
  return [
    { id: 'pub-home', path: '/', visitor: true },
    { id: 'org-explore', path: '/organizations' },
    { id: 'org-detail', path: `/orgs/${ORG}` },
    { id: 'pub-compositions', path: '/compositions' },
    { id: 'composition-card', path: `/compositions/${ORG}/${composition.slug}` },
    { id: 'composition-permalink', path: `/p/${composition.id}` },
    { id: 'eng-catalog', path: '/engines' },
    { id: 'eng-detail', path: `/engines/${engine.namespace}/${engine.name}/${engine.version}` },
    { id: 'pub-pricing', path: '/pricing' },
    { id: 'pub-team', path: '/team' },
    { id: 'pub-research', path: '/research' },
    { id: 'pub-contributions', path: '/contributions' },
    { id: 'pub-changelog', path: '/changelog' },
    { id: 'pub-language', path: '/language' },
    { id: 'composition-editor', path: `/editor?source=${ORG}/${composition.slug}` },
    { id: 'problem-editor', path: `/problem-editor?org=${ORG}&problem=${CASE}` },
    { id: 'auth', path: '/authentication', visitor: true },
    { id: 'auth-forgot-password', path: '/forgot-password', visitor: true },
    { id: 'auth-reset-password', path: '/reset-password?token=not-a-token', visitor: true },
    { id: 'auth-identity-callback', path: '/sso/identity/callback', visitor: true },
    { id: 'auth-identity-username', path: '/sso/identity/username', visitor: true },
    { id: 'org-list', path: '/me/orgs' },
    { id: 'org-new', path: '/orgs/new' },
    { id: 'org-join', path: `/orgs/join/${code}` },
    { id: 'my-compositions', path: '/me/compositions' },
    { id: 'composition-new', path: `/compositions/new?org=${ORG}` },
    { id: 'problem-detail', path: `/problems/${ORG}/${CASE}` },
    { id: 'run-launch', path: `/runs/new?org=${ORG}&problem=${CASE}` },
    { id: 'run-detail', path: `/runs/${ORG}/${run}` },
    { id: 'study-builder', path: `/studies/new?org=${ORG}` },
    { id: 'study-detail', path: `/studies/${ORG}/${study}` },
    { id: 'acct-settings', path: '/me/settings' },
    { id: 'acct-settings-profile', path: '/me/settings?section=profile' },
    { id: 'acct-api-keys', path: '/me/api-keys' },
    { id: 'notifications', path: '/notifications' },
    { id: 'eng-registrations', path: '/me/engines' },
    { id: 'eng-register', path: '/me/engines/new' },
    { id: 'eng-registration-detail', path: `/me/engines/${registration}` },
    { id: 'admin', path: '/admin' },
    { id: 'admin-user-detail', path: '/admin/users/none' },
    // The extra tabs of F2c: the same pages, other tabs.
    { id: 'org-problems', path: `/orgs/${ORG}/problems` },
    { id: 'org-runs', path: `/orgs/${ORG}/runs` },
    { id: 'org-studies', path: `/orgs/${ORG}/studies` },
    { id: 'problem-candidates', path: `/problems/${ORG}/${CASE}/candidates` },
    { id: 'problem-versions', path: `/problems/${ORG}/${CASE}/versions` },
    { id: 'study-front', path: `/studies/${ORG}/${study}/front` },
    { id: 'showcase-other', path: `/compositions/${OTHER_ORG}/sequential-workflow` },
    // F3: SPHERE on the screens. The wizard's steps are addresses (`sphereStep`); its last three open on the recipe the
    // problem's import pinned ("Update from SPHERE").
    { id: 'sphere-problem-candidates', path: wizard },
    { id: 'sphere-problems-filter', path: `/orgs/${ORG}/problems?origin=sphere` },
    { id: 'sphere-wizard-pricing', path: `${wizard}?sphereStep=pricing` },
    { id: 'sphere-wizard-version', path: `${wizard}?sphereStep=version&sphere=${MAILGUN.pricing}` },
    {
      id: 'sphere-wizard-plans',
      path: `${wizard}?sphereStep=plans&sphere=${MAILGUN.pricing}&sphereVersion=${MAILGUN.version}`,
    },
    { id: 'sphere-wizard-mapping', path: `${wizard}?sphereStep=mapping&sphereUpdate=1` },
    { id: 'sphere-wizard-preview', path: `${wizard}?sphereStep=preview&sphereUpdate=1` },
    { id: 'sphere-wizard-generate', path: `${wizard}?sphereStep=generate&sphereUpdate=1` },
    { id: 'sphere-composition-upstream', path: `/compositions/${ORG}/tomatometer?version=1.0.0` },
    {
      id: 'sphere-composition-compare',
      path: `/compositions/${ORG}/tomatometer/versions`,
    },
    { id: 'org-connections', path: `/orgs/${ORG}/connections` },
    // F4: the operation of TomatoMeter (environment cards, production with its margin table, history and feed keys, staging
    // with nothing adopted), the calculator's demand and margins, and the template cards of "New composition". The dialogs
    // (adopt, key reveal, check report, run adoption, instantiation) are opened and captured by walks 13 and 14.
    { id: 'composition-operation', path: `/compositions/${ORG}/tomatometer/operation` },
    {
      id: 'margin-table',
      path: `/compositions/${ORG}/tomatometer/operation?environment=production`,
    },
    {
      id: 'operation-nothing-adopted',
      path: `/compositions/${ORG}/tomatometer/operation?environment=staging`,
    },
    { id: 'calculator-margins', path: `/compositions/${ORG}/tomatometer/configuration` },
    { id: 'template-cards', path: `/compositions/new?org=${ORG}` },
    // F5-D: the owner's personal organization (its list's Personal section is `org-list`): no Leave, no Transfer.
    { id: 'org-personal', path: `/orgs/${LAB_USERS.owner}` },
    { id: 'org-personal-members', path: `/orgs/${LAB_USERS.owner}/members` },
  ];
}

async function measure(page: Page) {
  return page.evaluate(() => {
    const small: string[] = [];
    if (window.innerWidth <= 640) {
      for (const element of Array.from(
        document.querySelectorAll<HTMLElement>(
          'button, a[href], select, input:not([type=hidden]), [role=button], [role=tab]'
        )
      )) {
        const box = element.getBoundingClientRect();
        if (box.width === 0 || box.height === 0 || !element.checkVisibility()) continue;
        if (element.closest('.sr-only, [aria-hidden="true"]')) continue;
        const inText =
          element.tagName === 'A' &&
          element.closest('p, h1, h2, h3, h4, h5, h6, dd, small, label, li');
        const type = (element as HTMLInputElement).type;
        if (box.height < 23.5 && !inText && !['checkbox', 'radio', 'range'].includes(type))
          small.push(
            `${element.tagName.toLowerCase()} "${(element.textContent || element.getAttribute('aria-label') || '').trim().slice(0, 40)}" ${Math.round(box.height)}px`
          );
      }
    }
    return {
      brand: document.documentElement.getAttribute('data-brand'),
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      small: small.slice(0, 8),
    };
  });
}

let cached: { stops: Stop[]; token: string } | null = null;
async function plan(page: Page) {
  if (!cached) {
    const token = await signInByApi(page, 'owner');
    cached = { stops: await stops(page, token), token };
  }
  return cached;
}

async function walk(
  browser: Browser,
  label: string,
  options: {
    width: number;
    height: number;
    brand: string;
    colorScheme?: 'dark' | 'light';
    shots: boolean;
  }
): Promise<{ rows: Row[]; foreign: string[] }> {
  mkdirSync(OUT, { recursive: true });
  const rows: Row[] = [];
  const foreign: string[] = [];
  for (const visitor of [true, false]) {
    const context = await browser.newContext({
      viewport: { width: options.width, height: options.height },
      colorScheme: options.colorScheme ?? 'light',
    });
    await context.addInitScript(
      ([key, brand]) => localStorage.setItem(key, brand),
      [BRAND_KEY, options.brand]
    );
    // One page per screen: the lab's browser has 576 MB, and one page kept for every screen (pricing-renderer drawings,
    // Monaco) runs out of it. The session lives in the context's storage once the first page has signed in.
    const watchForeign = (target: Page) =>
      target.on('request', request => {
        if (/jsdelivr|unpkg|cdnjs|monaco-editor@|fonts\.gstatic/i.test(request.url()))
          foreign.push(request.url());
      });
    let page = await context.newPage();
    watchForeign(page);
    const { stops: all } = await plan(page);
    if (!visitor) await signInByApi(page, 'owner');
    let first = true;
    for (const stop of all.filter(entry => Boolean(entry.visitor) === visitor)) {
      if (!first) {
        await page.close();
        page = await context.newPage();
        watchForeign(page);
      }
      first = false;
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(stop.path);
      await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => undefined);
      await page.waitForTimeout(800);
      const measured = await measure(page);
      const dark =
        options.colorScheme === 'dark'
          ? await page.evaluate(() => {
              const bg = getComputedStyle(document.body).backgroundColor;
              const channels = (bg.match(/\d+(\.\d+)?/g) ?? []).map(Number);
              return {
                bg,
                light:
                  channels.length >= 3 &&
                  channels[0] > 200 &&
                  channels[1] > 200 &&
                  channels[2] > 200,
                darkClass: document.querySelector('.dark') !== null,
              };
            })
          : null;
      if (options.shots)
        await page.screenshot({
          path: `${OUT}/${label}-${stop.id}.png`,
          fullPage: !/editor/.test(stop.id),
        });
      rows.push({ ...stop, ...measured, dark, errors });
    }
    await context.close();
  }
  writeFileSync(`${OUT}/${label}.json`, JSON.stringify({ rows, foreign }, null, 1));
  return { rows, foreign };
}

test.describe.configure({ mode: 'serial' });

test.describe('live · palette sweep', () => {
  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    const { token } = await plan(page);
    await setBeta(page, token, true);
    await page.close();
  });

  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage();
    const token = await signInByApi(page, 'owner');
    await setBeta(page, token, false);
    await page.close();
  });

  test('visits every screen of the route table', async ({ page }) => {
    const { stops: all } = await plan(page);
    const visited = new Set(all.map(stop => stop.id));
    expect(
      readScreenLines()
        .filter(line => !visited.has(line.id))
        .map(line => line.id)
    ).toEqual([]);
  });

  for (const brand of PALETTES) {
    for (const [size, viewport] of SIZES) {
      test(`palette ${brand} at ${size}`, async ({ browser }) => {
        test.setTimeout(1_800_000);
        const { rows, foreign } = await walk(browser, `${brand}-${size}`, {
          ...viewport,
          brand,
          shots: true,
        });
        expect(foreign).toEqual([]);
        expect(rows.filter(row => row.brand !== brand).map(row => row.id)).toEqual([]);
        expect(
          rows.filter(row => row.overflow > 1).map(row => `${row.id} +${row.overflow}px`)
        ).toEqual([]);
        expect(
          rows.filter(row => row.errors.length > 0).map(row => `${row.id}: ${row.errors[0]}`)
        ).toEqual([]);
      });
    }
  }

  test('a phone at 375 px: no overflow and no control under 24 px', async ({ browser }) => {
    test.setTimeout(1_800_000);
    const { rows } = await walk(browser, 'phone375', {
      width: 375,
      height: 812,
      brand: 'sphere',
      shots: true,
    });
    expect(rows.filter(row => row.overflow > 1).map(row => `${row.id} +${row.overflow}px`)).toEqual(
      []
    );
    expect(
      rows.filter(row => row.errors.length > 0).map(row => `${row.id}: ${row.errors[0]}`)
    ).toEqual([]);
    expect(
      rows.filter(row => row.small.length > 0).map(row => `${row.id}: ${row.small.join('; ')}`)
    ).toEqual([]);
  });

  test('a dark operating system: every screen stays light and no dark: class applies', async ({
    browser,
  }) => {
    test.setTimeout(1_800_000);
    const { rows } = await walk(browser, 'dark-os', {
      width: 1440,
      height: 900,
      brand: 'sphere',
      colorScheme: 'dark',
      shots: false,
    });
    expect(
      rows
        .filter(row => !row.dark?.light || row.dark?.darkClass)
        .map(row => `${row.id}: ${JSON.stringify(row.dark)}`)
    ).toEqual([]);
  });
});
