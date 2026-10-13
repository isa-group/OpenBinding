import { mkdir, writeFile } from 'node:fs/promises';
import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { measurePage, prepareCapture, waitUntilSettled } from '../helpers/pageChecks';
import { API, CASE, ORG, PROJECT_PATH, RESULTS_DIR, signInByApi } from './support';

/**
 * Visual QA of the main screens at the two sizes of the project (`desktop` 1280x800 and `mobile` 390x844 with touch: see
 * playwright.live.config.ts), measured by the page itself instead of judged by eye. Per screen and size:
 *
 * - no horizontal overflow (`document.documentElement.scrollWidth <= window.innerWidth`);
 * - no `console.error`, no `pageerror`, no 5xx answer (4xx answers are counted and listed, not failed: a 404 the interface expects is
 *   not a defect, and Chromium logs each one as a console error that would hide the real ones, so those log lines are set aside);
 * - a visible main landmark;
 * - on mobile, every visible button, link, summary and field at least 24 px high (WCAG 2.5.8; a link inside a line of text is exempt,
 *   as the criterion says);
 * - no text that is clipped without an ellipsis (`overflow: hidden|clip` and `scrollWidth > clientWidth`), no broken image;
 * - a full-page screenshot in `<results>/screenshots/<size>-<screen>.png`.
 *
 * One summary line per screen and size goes to the log (`VQA ...`, and `VQA_PROBLEM ...` for each finding): that log is all the
 * controller of the lab sees, because the screenshots stay in a volume it cannot open. A finding fails the test, but the walk goes on,
 * so one run reports every screen. The owner walks the screens in one test (one login per size: the gateway throttles logins).
 */

const MIN_TARGET_PX = 24;
const RESULT_HEADING = /Best combination found|Solution \d+ of \d+|Why no combination works/;
/** Chromium logs every 4xx/5xx of a sub-resource as a console error; the answers are counted on their own. */
const STATUS_LOG = /^Failed to load resource: the server responded with a status of \d{3}/;

interface Stop {
  /** Label of the screen in the log and the name of its screenshot. */
  slug: string;
  path: string;
  /** What shows that the screen has arrived. */
  ready: (page: Page) => Locator;
  /** What this screen alone must or must not show to the role looking at it. */
  extra?: (page: Page, label: string) => Promise<void>;
}

interface Row {
  page: string;
  viewport: string;
  result: 'PASS' | 'FAIL' | 'SKIPPED';
  problems: string[];
  overflowPx: number;
  http4xx: string[];
}

function watch(page: Page) {
  let seen = { console: [] as string[], pageErrors: [] as string[], http5xx: [] as string[], http4xx: [] as string[] };
  page.on('console', (message) => {
    if (message.type() === 'error' && !STATUS_LOG.test(message.text())) seen.console.push(message.text().slice(0, 160));
  });
  page.on('pageerror', (error) => seen.pageErrors.push(error.message.slice(0, 160)));
  page.on('response', (response) => {
    const status = response.status();
    if (status < 400) return;
    const line = `${status} ${response.request().method()} ${new URL(response.url()).pathname}`;
    (status >= 500 ? seen.http5xx : seen.http4xx).push(line);
  });
  return {
    /** What was seen since the last call. */
    take() {
      const taken = seen;
      seen = { console: [], pageErrors: [], http5xx: [], http4xx: [] };
      return taken;
    },
  };
}

/** Visible controls shorter than the minimum, outside the lines of text they may sit in. */
function smallTargets(page: Page): Promise<string[]> {
  return page.evaluate((minimum) => {
    const controls = document.querySelectorAll(
      'a[href], button, summary, select, [role="button"], [role="link"], [role="tab"], input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"])',
    );
    const small: string[] = [];
    for (const control of controls) {
      if (small.length >= 12) break;
      const style = getComputedStyle(control);
      const box = control.getBoundingClientRect();
      if (style.visibility === 'hidden' || style.display === 'none' || box.width === 0 || box.height === 0) continue;
      // Hidden from everyone (the skip link sits above the page until it is focused) or only for screen readers.
      if (control.closest('.sr-only, [aria-hidden="true"], [hidden]') || box.bottom <= 0 || box.right <= 0) continue;
      const inLine = style.display === 'inline'
        && [...(control.parentElement?.childNodes ?? [])].some((node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim() !== '');
      if (inLine) continue;
      if (Math.round(box.height) < minimum) {
        const name = (control.getAttribute('aria-label') ?? control.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 30);
        // The class and the parent say which element it is when the text does not (an icon button has none).
        const own = String(control.getAttribute('class') ?? '').split(/\s+/).filter(Boolean).slice(0, 2).join('.');
        const parent = String(control.parentElement?.getAttribute('class') ?? '').split(/\s+/).filter(Boolean)[0];
        small.push(`${control.tagName.toLowerCase()}${own ? `.${own}` : ''} "${name}" ${Math.round(box.width)}x${Math.round(box.height)}${parent ? ` in .${parent}` : ''}`);
      }
    }
    return small;
  }, MIN_TARGET_PX);
}

/** Looks at the screen that is open and returns what is wrong with it. */
async function inspect(page: Page, mobile: boolean): Promise<{ problems: string[]; overflowPx: number }> {
  const problems: string[] = [];
  const settled = await waitUntilSettled(page);
  problems.push(...settled);

  const width = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }));
  const overflowPx = width.scroll - width.inner;

  if (!(await page.locator('main, [role="main"]').first().isVisible())) problems.push('no visible main landmark');

  const measured = await measurePage(page);
  // Which elements stick out is what the person fixing it needs (the gallery's measurement lists the first few).
  if (overflowPx > 0) problems.push(`horizontal overflow: scrollWidth ${width.scroll} > innerWidth ${width.inner}; outside: ${measured.offenders.slice(0, 3).join(' | ') || 'none found (inside a scroll container?)'}`);
  for (const clipped of measured.clipped) problems.push(`clipped text without ellipsis: ${clipped}`);
  for (const image of measured.brokenImages) problems.push(`broken image: ${image}`);

  if (mobile) {
    for (const target of await smallTargets(page)) problems.push(`touch target under ${MIN_TARGET_PX}px: ${target}`);
  }
  return { problems, overflowPx };
}

/** Opens each screen, checks it, saves its picture and logs one line. */
async function walk(page: Page, testInfo: TestInfo, stops: Stop[], skipped: Array<{ slug: string; why: string }> = []): Promise<Row[]> {
  const viewport = testInfo.project.name;
  const mobile = viewport === 'mobile';
  const seen = watch(page);
  const rows: Row[] = [];
  await mkdir(`${RESULTS_DIR}/screenshots`, { recursive: true }).catch(() => undefined);

  for (const stop of stops) {
    const label = `${viewport} ${stop.slug}`;
    seen.take();
    await page.goto(stop.path);
    await expect.soft(stop.ready(page), `${label}: the screen did not arrive (${stop.path})`).toBeVisible({ timeout: 45_000 });
    if (stop.extra) await stop.extra(page, label);

    const { problems, overflowPx } = await inspect(page, mobile);
    const found = seen.take();
    for (const message of found.console) problems.push(`console error: ${message}`);
    for (const message of found.pageErrors) problems.push(`page error: ${message}`);
    for (const message of found.http5xx) problems.push(`server error answer: ${message}`);

    await prepareCapture(page);
    await page.screenshot({ path: `${RESULTS_DIR}/screenshots/${viewport}-${stop.slug}.png`, fullPage: true, animations: 'disabled' })
      .catch((error: Error) => problems.push(`screenshot failed: ${error.message.split('\n')[0]}`));

    expect.soft(problems, label).toEqual([]);
    rows.push({ page: stop.slug, viewport, result: problems.length ? 'FAIL' : 'PASS', problems, overflowPx, http4xx: found.http4xx });
  }
  for (const item of skipped) {
    rows.push({ page: item.slug, viewport, result: 'SKIPPED', problems: [item.why], overflowPx: 0, http4xx: [] });
  }
  return rows;
}

/** The summary of the run, in the log (and in the report, and in the results directory when it can be written). */
async function report(testInfo: TestInfo, name: string, rows: Row[]): Promise<void> {
  const lines: string[] = [];
  for (const row of rows) {
    lines.push(`VQA viewport=${row.viewport} page=${row.page} result=${row.result} overflow_px=${row.overflowPx} http4xx=${row.http4xx.length} problems=${row.problems.length}`);
    for (const problem of row.problems) lines.push(`VQA_PROBLEM viewport=${row.viewport} page=${row.page} ${JSON.stringify(problem)}`);
    if (row.http4xx.length) lines.push(`VQA_HTTP4XX viewport=${row.viewport} page=${row.page} ${JSON.stringify([...new Set(row.http4xx)].slice(0, 8))}`);
  }
  console.log(lines.join('\n'));
  await testInfo.attach(`visual-qa-${name}`, { body: lines.join('\n'), contentType: 'text/plain' });
  await writeFile(`${RESULTS_DIR}/visual-qa-${testInfo.project.name}-${name}.json`, JSON.stringify(rows, null, 2)).catch(() => undefined);
}

const LOGIN: Stop = { slug: 'login', path: '/login', ready: (page) => page.getByRole('heading', { level: 1, name: 'Welcome back' }) };

const OWNER_STOPS: Stop[] = [
  { slug: 'panel', path: '/app', ready: (page) => page.getByRole('heading', { level: 1, name: /^Hello, / }) },
  { slug: 'organization-projects', path: `/app/${ORG}`, ready: (page) => page.locator('#platform-main').locator(`a[href="${PROJECT_PATH}"]`).first() },
  { slug: 'project', path: PROJECT_PATH, ready: (page) => page.getByRole('navigation', { name: 'Project sections' }) },
  { slug: 'cases', path: `${PROJECT_PATH}/cases`, ready: (page) => page.getByRole('list', { name: 'Cases' }) },
  { slug: 'case', path: `${PROJECT_PATH}/cases/${CASE}`, ready: (page) => page.locator('code.case-slug') },
  { slug: 'jobs', path: `${PROJECT_PATH}/jobs`, ready: (page) => page.getByRole('heading', { level: 1, name: 'Jobs' }) },
  { slug: 'plan-permissions', path: '/app/account/usage', ready: (page) => page.locator('#platform-main').getByRole('heading', { level: 1, name: 'Plan & permissions' }) },
  { slug: 'team-organization', path: `/app/${ORG}/settings/members`, ready: (page) => page.locator('#platform-main').getByRole('heading', { level: 1 }) },
];

/** The viewer reads; the backend now asks for MEMBER to start a run, and nothing on these screens may let it try. */
const VIEWER_STOPS: Stop[] = [
  {
    slug: 'viewer-cases',
    path: `${PROJECT_PATH}/cases`,
    ready: (page) => page.getByRole('list', { name: 'Cases' }),
    extra: async (page, label) => {
      await expect.soft(page.getByRole('button', { name: 'New case' }), `${label}: a viewer sees "New case"`).toHaveCount(0);
    },
  },
  {
    slug: 'viewer-jobs',
    path: `${PROJECT_PATH}/jobs`,
    ready: (page) => page.getByRole('heading', { level: 1, name: 'Jobs' }),
    extra: async (page, label) => {
      await expect.soft(page.getByRole('link', { name: 'New run' }), `${label}: a viewer sees "New run"`).toHaveCount(0);
      await expect.soft(page.getByRole('link', { name: 'Start a run' }), `${label}: a viewer sees "Start a run"`).toHaveCount(0);
    },
  },
  {
    slug: 'viewer-job-launch',
    path: `${PROJECT_PATH}/jobs/new?case=${CASE}`,
    ready: (page) => page.getByRole('heading', { level: 1, name: 'New run' }),
    extra: async (page, label) => {
      await expect.soft(page.getByText('starting a run needs MEMBER'), `${label}: the launch page does not say a run needs MEMBER`).toBeVisible();
      await expect.soft(page.locator('button:not([disabled])', { hasText: 'Send run' }), `${label}: a viewer has an enabled "Send run"`).toHaveCount(0);
    },
  },
];

test.describe('live · visual QA', () => {
  test('the login page', async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    await report(testInfo, 'login', await walk(page, testInfo, [LOGIN]));
  });

  test('the owner walks the main screens', async ({ page }, testInfo) => {
    test.setTimeout(900_000);
    const token = await signInByApi(page, 'owner');

    // "A result" is a finished job of the owner: the one spec 04 starts, or any other (the API smoke leaves some).
    const listed = await page.request.get(`${API}/v1/jobs?limit=100`, { headers: { Authorization: `Bearer ${token}` } });
    const jobs = listed.ok() ? await listed.json() as Array<{ id: string; status: string }> : [];
    const finished = jobs.find((job) => String(job.status).toLowerCase() === 'completed');
    const stops = [...OWNER_STOPS];
    const skipped: Array<{ slug: string; why: string }> = [];
    if (finished) {
      stops.splice(6, 0, {
        slug: 'job-result',
        path: `${PROJECT_PATH}/jobs/${finished.id}`,
        ready: (target) => target.getByRole('heading', { level: 2, name: RESULT_HEADING }),
      });
    } else {
      skipped.push({ slug: 'job-result', why: `the owner has no completed job to open (GET /v1/jobs answered ${listed.status()}, ${jobs.length} jobs); run 04-job-random-search first` });
      testInfo.annotations.push({ type: 'skipped-screen', description: 'job-result: no completed job' });
    }
    await report(testInfo, 'owner', await walk(page, testInfo, stops, skipped));
  });

  test('the viewer is offered no way to start a run', async ({ page }, testInfo) => {
    test.setTimeout(600_000);
    await signInByApi(page, 'viewer');
    await report(testInfo, 'viewer', await walk(page, testInfo, VIEWER_STOPS));
  });
});
