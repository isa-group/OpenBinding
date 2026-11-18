import { mkdir, writeFile } from 'node:fs/promises';
import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { measurePage, prepareCapture, waitUntilSettled } from '../helpers/pageChecks';
import {
  API,
  CASE,
  ORG,
  PROBLEMS_TAB,
  OTHER_ORG,
  RESULTS_DIR,
  LAUNCH_PATH,
  RUN_PATH,
  RUNS_PATH,
  signInByApi,
} from './support';

/**
 * Visual QA of the main screens at the two sizes of the project (`desktop` 1280x800 and `mobile` 390x844 with touch: see
 * playwright.live.config.ts), measured by the page itself instead of judged by eye. Per screen and size:
 *
 * - no horizontal overflow (`document.documentElement.scrollWidth <= window.innerWidth`);
 * - no `console.error`, no `pageerror`, no 5xx answer (4xx answers are counted and listed, not failed: a 404 the interface expects is
 *   not a defect, and Chromium logs each one as a console error that would hide the real ones, so those log lines are set aside);
 *   the one 5xx listed with them is the 503 of the published pricing (`GET /v1/plans/pricing`, `pricing_unavailable`),
 *   which is how the gateway says SPHERE cannot be read (SPHERE unreachable from the lab, or switched off), and the screens that
 *   read the pricing say it cannot be read instead of failing;
 * - a visible main landmark;
 * - on mobile, every visible button, link, summary and field at least 24 px high (WCAG 2.5.8; a link inside a line of text is exempt,
 *   as the criterion says);
 * - no text that is clipped without an ellipsis (`overflow: hidden|clip` and `scrollWidth > clientWidth`), no broken image;
 * - no clipped content: nothing visible sticks out past a container that cuts it (`overflow-x: hidden|clip`, or the page edge) without
 *   being scrollable (`overflow-x: auto|scroll`) or an ellipsis; a table wider than the screen belongs in a scroll region;
 * - a full-page screenshot in `<results>/screenshots/<size>-<screen>.png`.
 *
 * The composition screens read what tools/seed_lab.py made: lab-main's private `sequential-workflow` (versions 1.0.0 and 1.1.0,
 * derived from its problem) for the owner and the viewer, and lab-other's public `sequential-workflow` for a visitor. On mobile the
 * Editor is also looked at in its Visual and Problems tabs (on desktop the panes sit side by side).
 *
 * The problem screens (F2b) read the seeded `simple-seq`: its Candidates and Compositions tabs, and the problem editor opened on it,
 * once per pane (Workflow, Candidates, Rules, Files, Forms; on mobile also the Engines and Problems tabs; the package has no BPMN
 * file, so there is no BPMN pane). The run presets section of lab-main's settings, and the Pareto front of the newest finished
 * study run of lab-main (the one 11-study-front leaves; skipped when there is none), close the owner's walk.
 *
 * One summary line per screen and size goes to the log (`VQA ...`, and `VQA_PROBLEM ...` for each finding): that log is all the
 * controller of the lab sees, because the screenshots stay in a volume it cannot open. A finding fails the test, but the walk goes on,
 * so one run reports every screen. The owner walks the screens in one test (one login per size: the gateway throttles logins).
 */

const MIN_TARGET_PX = 24;
/** The kind of a finding is what comes before the first colon of its text; this is the one for content a container cuts off. */
const CLIPPED_KIND = 'clipped content';
/** A finished run: the 'Run result' region holding the chosen providers, or the explanation of why no combination works. */
const finishedResult = (target: Page) =>
  target.getByRole('region', { name: 'Run result' }).filter({
    has: target
      .getByRole('region', { name: 'Chosen providers' })
      .or(target.getByRole('heading', { level: 2, name: 'Why no combination works' })),
  });
/** Chromium logs every 4xx/5xx of a sub-resource as a console error; the answers are counted on their own. */
const STATUS_LOG = /^Failed to load resource: the server responded with a status of \d{3}/;
/** The published pricing answers 503 `pricing_unavailable` whenever SPHERE cannot be read. */
const PRICING_UNREADABLE = /^\/api\/v1\/plans\/pricing$/;

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
  let seen = {
    console: [] as string[],
    pageErrors: [] as string[],
    http5xx: [] as string[],
    http4xx: [] as string[],
  };
  page.on('console', message => {
    if (message.type() === 'error' && !STATUS_LOG.test(message.text()))
      seen.console.push(message.text().slice(0, 160));
  });
  page.on('pageerror', error => seen.pageErrors.push(error.message.slice(0, 160)));
  page.on('response', response => {
    const status = response.status();
    if (status < 400) return;
    const path = new URL(response.url()).pathname;
    const line = `${status} ${response.request().method()} ${path}`;
    const serverError = status >= 500 && !(status === 503 && PRICING_UNREADABLE.test(path));
    (serverError ? seen.http5xx : seen.http4xx).push(line);
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
  return page.evaluate(minimum => {
    const controls = document.querySelectorAll(
      'a[href], button, summary, select, [role="button"], [role="link"], [role="tab"], input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"])'
    );
    const small: string[] = [];
    for (const control of controls) {
      if (small.length >= 12) break;
      const style = getComputedStyle(control);
      const box = control.getBoundingClientRect();
      if (
        style.visibility === 'hidden' ||
        style.display === 'none' ||
        box.width === 0 ||
        box.height === 0
      )
        continue;
      // Hidden from everyone (the skip link sits above the page until it is focused) or only for screen readers.
      if (
        control.closest('.sr-only, .pr-sr-only, [aria-hidden="true"], [hidden]') ||
        box.bottom <= 0 ||
        box.right <= 0
      )
        continue;
      const inLine =
        style.display === 'inline' &&
        [...(control.parentElement?.childNodes ?? [])].some(
          node => node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim() !== ''
        );
      if (inLine) continue;
      if (Math.round(box.height) < minimum) {
        const name = (control.getAttribute('aria-label') ?? control.textContent ?? '')
          .trim()
          .replace(/\s+/g, ' ')
          .slice(0, 30);
        // The class and the parent say which element it is when the text does not (an icon button has none).
        const own = String(control.getAttribute('class') ?? '')
          .split(/\s+/)
          .filter(Boolean)
          .slice(0, 2)
          .join('.');
        const parent = String(control.parentElement?.getAttribute('class') ?? '')
          .split(/\s+/)
          .filter(Boolean)[0];
        small.push(
          `${control.tagName.toLowerCase()}${own ? `.${own}` : ''} "${name}" ${Math.round(box.width)}x${Math.round(box.height)}${parent ? ` in .${parent}` : ''}`
        );
      }
    }
    return small;
  }, MIN_TARGET_PX);
}

/**
 * Content that a container cuts off with no way to reach it: a visible element that sticks out past the right (or left) edge of
 * the nearest ancestor that clips (`overflow-x: hidden|clip`). An ancestor that scrolls (`auto|scroll`) is the legitimate case and
 * stops the walk, as does a clipping ancestor that shows an ellipsis. The page edge counts when `html` or `body` clips. One finding
 * per clipping container, with the first elements that are cut, as `tag#id.class > ...` selectors.
 */
function clippedContent(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const found = new Map<Element, { cut: string[]; by: number }>();
    const describe = (element: Element): string => {
      const parts: string[] = [];
      for (
        let node: Element | null = element;
        node && node !== document.body && parts.length < 3;
        node = node.parentElement
      ) {
        const classes = String(node.getAttribute('class') ?? '')
          .split(/\s+/)
          .filter(Boolean)
          .slice(0, 2)
          .join('.');
        parts.unshift(
          `${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ''}${classes ? `.${classes}` : ''}`
        );
      }
      return parts.join(' > ');
    };
    const hides = (value: string) => value === 'hidden' || value === 'clip';
    const scrolls = (value: string) => value === 'auto' || value === 'scroll';

    for (const element of document.body.querySelectorAll('*')) {
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      if (
        box.width === 0 ||
        box.height === 0 ||
        style.visibility === 'hidden' ||
        style.display === 'none'
      )
        continue;
      // Taken out of the flow (a popover, the skip link) or not for the eye: neither is cut by the container it is written in.
      if (style.position === 'fixed' || style.position === 'absolute') continue;
      if (
        element.closest(
          '.sr-only, .pr-sr-only, [aria-hidden="true"], [hidden], details:not([open]) > :not(summary)'
        )
      )
        continue;

      for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
        const parent = getComputedStyle(ancestor);
        if (scrolls(parent.overflowX)) break;
        if (!hides(parent.overflowX)) continue;
        if (parent.textOverflow === 'ellipsis') break;
        const root = ancestor === document.body || ancestor === document.documentElement;
        const edge = root
          ? { left: 0, right: window.innerWidth }
          : ancestor.getBoundingClientRect();
        const cutBy = Math.max(box.right - edge.right, edge.left - box.left);
        // The container must really be cut (`scrollWidth > clientWidth`), not only drawn narrower than a child that is itself clipped.
        if (cutBy > 1 && (root || ancestor.scrollWidth > ancestor.clientWidth + 1)) {
          const entry = found.get(ancestor) ?? { cut: [], by: 0 };
          if (entry.cut.length < 3) entry.cut.push(describe(element));
          entry.by = Math.max(entry.by, Math.round(cutBy));
          found.set(ancestor, entry);
        }
        break;
      }
      if (found.size >= 8) break;
    }
    return [...found].map(
      ([container, entry]) =>
        `${describe(container)} cuts ${entry.by}px off: ${entry.cut.join(' | ')}`
    );
  });
}

/** Looks at the screen that is open and returns what is wrong with it. */
async function inspect(
  page: Page,
  mobile: boolean
): Promise<{ problems: string[]; overflowPx: number }> {
  const problems: string[] = [];
  const settled = await waitUntilSettled(page);
  problems.push(...settled);

  const width = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    inner: window.innerWidth,
  }));
  const overflowPx = width.scroll - width.inner;

  if (!(await page.locator('main, [role="main"]').first().isVisible()))
    problems.push('no visible main landmark');

  const measured = await measurePage(page);
  // Which elements stick out is what the person fixing it needs (the gallery's measurement lists the first few).
  if (overflowPx > 0)
    problems.push(
      `horizontal overflow: scrollWidth ${width.scroll} > innerWidth ${width.inner}; outside: ${measured.offenders.slice(0, 3).join(' | ') || 'none found (inside a scroll container?)'}`
    );
  for (const clipped of measured.clipped)
    problems.push(`clipped text without ellipsis: ${clipped}`);
  for (const image of measured.brokenImages) problems.push(`broken image: ${image}`);
  for (const cut of await clippedContent(page)) problems.push(`${CLIPPED_KIND}: ${cut}`);

  if (mobile) {
    for (const target of await smallTargets(page))
      problems.push(`touch target under ${MIN_TARGET_PX}px: ${target}`);
  }
  return { problems, overflowPx };
}

/**
 * The palette to look at (`VISUAL_BRAND=sphere|openbinding`): kept in the browser as a person's own choice would be
 * (core/theme/brand.ts), and the screenshots go to `screenshots-<brand>/`. Unset, the deployment's default and `screenshots/`.
 */
const BRAND = process.env.VISUAL_BRAND?.trim() || null;
const BRAND_KEY = 'openbinding:brand';
const SCREENSHOTS = `${RESULTS_DIR}/screenshots${BRAND ? `-${BRAND}` : ''}`;

/** Opens each screen, checks it, saves its picture and logs one line. */
async function walk(
  page: Page,
  testInfo: TestInfo,
  stops: Stop[],
  skipped: Array<{ slug: string; why: string }> = []
): Promise<Row[]> {
  const viewport = testInfo.project.name;
  const mobile = viewport === 'mobile';
  const seen = watch(page);
  const rows: Row[] = [];
  if (BRAND)
    await page.addInitScript(
      ([key, value]) => window.localStorage.setItem(key, value),
      [BRAND_KEY, BRAND]
    );
  await mkdir(SCREENSHOTS, { recursive: true }).catch(() => undefined);

  for (const stop of stops) {
    const label = `${viewport} ${stop.slug}`;
    seen.take();
    await page.goto(stop.path);
    await expect
      .soft(stop.ready(page), `${label}: the screen did not arrive (${stop.path})`)
      .toBeVisible({ timeout: 45_000 });
    if (stop.extra) await stop.extra(page, label);

    const { problems, overflowPx } = await inspect(page, mobile);
    const found = seen.take();
    for (const message of found.console) problems.push(`console error: ${message}`);
    for (const message of found.pageErrors) problems.push(`page error: ${message}`);
    for (const message of found.http5xx) problems.push(`server error answer: ${message}`);

    await prepareCapture(page);
    await page
      .screenshot({
        path: `${SCREENSHOTS}/${viewport}-${stop.slug}.png`,
        fullPage: true,
        animations: 'disabled',
      })
      .catch((error: Error) => problems.push(`screenshot failed: ${error.message.split('\n')[0]}`));

    expect.soft(problems, label).toEqual([]);
    rows.push({
      page: stop.slug,
      viewport,
      result: problems.length ? 'FAIL' : 'PASS',
      problems,
      overflowPx,
      http4xx: found.http4xx,
    });
  }
  for (const item of skipped) {
    rows.push({
      page: item.slug,
      viewport,
      result: 'SKIPPED',
      problems: [item.why],
      overflowPx: 0,
      http4xx: [],
    });
  }
  return rows;
}

function kindOf(problem: string): string {
  return problem.split(':')[0].trim();
}

/** The summary of the run, in the log (and in the report, and in the results directory when it can be written). */
async function report(testInfo: TestInfo, name: string, rows: Row[]): Promise<void> {
  const lines: string[] = [];
  for (const row of rows) {
    const clipped = row.problems.filter(problem => kindOf(problem) === CLIPPED_KIND).length;
    lines.push(
      `VQA viewport=${row.viewport} page=${row.page} result=${row.result} overflow_px=${row.overflowPx} clipped_content=${clipped} http4xx=${row.http4xx.length} problems=${row.problems.length}`
    );
    for (const problem of row.problems)
      lines.push(
        `VQA_PROBLEM viewport=${row.viewport} page=${row.page} kind=${JSON.stringify(kindOf(problem))} ${JSON.stringify(problem)}`
      );
    if (row.http4xx.length)
      lines.push(
        `VQA_HTTP4XX viewport=${row.viewport} page=${row.page} ${JSON.stringify([...new Set(row.http4xx)].slice(0, 8))}`
      );
  }
  console.log(lines.join('\n'));
  await testInfo.attach(`visual-qa-${name}`, { body: lines.join('\n'), contentType: 'text/plain' });
  await writeFile(
    `${RESULTS_DIR}/visual-qa-${testInfo.project.name}-${name}.json`,
    JSON.stringify(rows, null, 2)
  ).catch(() => undefined);
}

const LOGIN: Stop = {
  slug: 'login',
  path: '/authentication',
  ready: page => page.getByRole('heading', { level: 1, name: 'Welcome back' }),
};

const OWNER_STOPS: Stop[] = [
  {
    slug: 'panel',
    path: '/',
    ready: page => page.getByRole('heading', { level: 1, name: /^Welcome back, / }),
  },
  {
    slug: 'organization',
    path: `/orgs/${ORG}`,
    ready: page => page.locator('main').getByRole('heading', { level: 1 }).first(),
  },
  {
    slug: 'cases',
    path: `/orgs/${ORG}/problems`,
    ready: page =>
      page.locator('main').getByRole('region', { name: 'Problems' }).getByRole('article').first(),
  },
  {
    slug: 'case',
    path: `/problems/${ORG}/${CASE}`,
    ready: page => page.locator('main').getByRole('heading', { level: 1 }),
  },
  {
    slug: 'jobs',
    path: `${RUNS_PATH}`,
    ready: page =>
      page.getByRole('region', { name: 'Runs' }).getByRole('heading', { level: 2, name: /Runs/ }),
  },
  {
    slug: 'plan-permissions',
    path: '/me/settings?section=plan',
    ready: page =>
      page.locator('main').getByRole('heading', { level: 2, name: 'Plan & permissions' }),
  },
  {
    slug: 'team-organization',
    path: `/orgs/${ORG}/members`,
    ready: page => page.locator('main').getByRole('heading', { level: 1 }),
  },
];

/** lab-main's composition from the seed, its name, and the two versions the comparison stops compare. */
const COMPOSITION = `/compositions/${ORG}/sequential-workflow`;
const COMPOSITION_NAME = 'Sequential workflow';
/** The standalone editor on lab-main's composition. */
const EDITOR_ON_COMPOSITION = `/editor?source=${ORG}/sequential-workflow`;
const PAIR = 'from=1.0.0&to=1.1.0';
const composed = (page: Page) =>
  page.locator('main').getByRole('heading', { level: 1, name: COMPOSITION_NAME });

/** The problem editor on the seeded problem: its check has passed when the status says so. */
const EDITOR = `/problem-editor?org=${ORG}&problem=${CASE}`;
const checked = (page: Page) =>
  page.getByTestId('pe-check-status').filter({ hasText: 'Valid package' });

/**
 * The seeded problem's Candidates and Compositions tabs, the problem editor on it, pane by pane (its files are Code mode; on a
 * phone the engines and the problems are panes too), and the run presets of lab-main.
 */
function problemStops(mobile: boolean): Stop[] {
  const pane = (slug: string, tab: RegExp | 'Code', ready: (page: Page) => Locator): Stop => ({
    slug,
    path: EDITOR,
    ready: checked,
    extra: async (page, label) => {
      if (tab === 'Code') await page.getByRole('button', { name: 'Code', exact: true }).click();
      else
        await page
          .getByRole('tablist', { name: 'Editor panes' })
          .getByRole('tab', { name: tab })
          .click();
      await expect
        .soft(ready(page), `${label}: the pane did not open`)
        .toBeVisible({ timeout: 30_000 });
    },
  });
  const main = (page: Page) => page.locator('main');
  return [
    {
      slug: 'problem-candidates',
      path: `/problems/${ORG}/${CASE}/candidates`,
      ready: page => page.getByRole('region', { name: 'Candidates of each task' }),
    },
    {
      slug: 'problem-compositions',
      path: `/problems/${ORG}/${CASE}/compositions`,
      ready: page => main(page).getByRole('heading', { level: 2, name: 'Compositions' }).first(),
    },
    {
      slug: 'problem-editor',
      path: EDITOR,
      ready: checked,
      extra: async (page, label) => {
        await expect
          .soft(
            page.getByRole('group', { name: 'Workflow of the package' }),
            `${label}: the workflow did not show`
          )
          .toBeVisible();
      },
    },
    pane('problem-editor-candidates', /^Candidates$/, page =>
      page.getByRole('region', { name: 'Candidates of each task' })
    ),
    pane('problem-editor-rules', /^Rules$/, page =>
      main(page).getByRole('heading', { name: 'Rules and objectives' }).first()
    ),
    pane('problem-editor-files', 'Code', page =>
      page.getByRole('navigation', { name: 'Files of the package' })
    ),
    pane('problem-editor-forms', /^Forms$/, page =>
      page.getByRole('navigation', { name: 'BIM resources' })
    ),
    ...(mobile
      ? [
          pane('problem-editor-engines', /^Engines$/, page =>
            main(page).getByRole('heading', { level: 2, name: 'Engines' }).first()
          ),
          pane('problem-editor-problems', /^Problems/, page =>
            page.getByRole('tab', { name: /^Problems/, selected: true })
          ),
        ]
      : []),
    {
      slug: 'presets',
      path: `/orgs/${ORG}/presets`,
      ready: page => main(page).getByRole('heading', { level: 2, name: 'Run presets' }),
    },
  ];
}

/**
 * F3: SPHERE on the screens, on what the seed made from live SPHERE: tomatometer-email's Candidates tab with the value sources
 * and the Properties group, the SPHERE wizard step by step (its last three on the recipe the import pinned), the TomatoMeter
 * composition with its upstream plan and storefront drawn from snapshots, and the beta Connections tab (beta features are on
 * for this walk).
 */
function sphereStops(): Stop[] {
  const candidates = `/problems/${ORG}/tomatometer-email/candidates`;
  const wizard = (step: string, query = '') => ({
    slug: `sphere-wizard-${step}`,
    path: `${candidates}?sphereStep=${step}${query}`,
    ready: (page: Page) => page.getByRole('dialog').getByRole('list', { name: 'Steps' }),
  });
  return [
    {
      slug: 'sphere-candidates',
      path: candidates,
      ready: page =>
        page.getByRole('region', { name: 'Candidates of each task' }).getByText('Priced').first(),
    },
    wizard('pricing'),
    wizard('version', '&sphere=6ade364540e55445692b0eda'),
    wizard('plans', '&sphere=6ade364540e55445692b0eda&sphereVersion=6ade36454b2b5b01c587db3d'),
    wizard('mapping', '&sphereUpdate=1'),
    wizard('preview', '&sphereUpdate=1'),
    {
      slug: 'sphere-composition',
      path: `/compositions/${ORG}/tomatometer`,
      ready: page =>
        page
          .locator('main')
          .getByRole('region', { name: 'Upstream plans', exact: true })
          .getByRole('article')
          .first(),
    },
    {
      slug: 'connections',
      path: `/orgs/${ORG}/connections`,
      ready: page =>
        page.locator('main').getByRole('region', { name: 'Connections' }).getByRole('heading', {
          name: 'Connections',
        }),
    },
  ];
}

/** The owner's beta switch, written through the gateway with the revision it read. */
async function setBeta(page: Page, token: string, enabled: boolean): Promise<void> {
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

/** The results of the newest finished study run of lab-main (11-study-front leaves one), or why there is none. */
async function studyFrontStop(page: Page, token: string): Promise<Stop | { why: string }> {
  const headers = { Authorization: `Bearer ${token}` };
  const listed = await page.request.get(`${API}/v1/organizations/${ORG}/studies`, { headers });
  if (!listed.ok()) return { why: `listStudies answered ${listed.status()}` };
  const studies = ((await listed.json()) as Array<{ slug: string; created_at: string }>).sort(
    (a, b) => b.created_at.localeCompare(a.created_at)
  );
  for (const study of studies) {
    const runs = await page.request.get(
      `${API}/v1/organizations/${ORG}/studies/${encodeURIComponent(study.slug)}/runs`,
      { headers }
    );
    if (!runs.ok()) continue;
    const finished = (
      (await runs.json()) as Array<{ id: string; run_number: number; state: string }>
    )
      .filter(run => run.state === 'completed')
      .sort((a, b) => b.run_number - a.run_number)[0];
    if (finished) {
      return {
        slug: 'study-front',
        path: `/studies/${ORG}/${encodeURIComponent(study.slug)}/front?run=${finished.id}`,
        ready: target =>
          target.locator('main').getByRole('heading', { level: 2, name: 'Pareto front' }),
      };
    }
  }
  return {
    why: `lab-main has no finished study run (${studies.length} studies); run 11-study-front first`,
  };
}

/** The compositions of lab-main as its owner reads and edits them: the list, every tab of the card page and the editor. */
function compositionStops(mobile: boolean): Stop[] {
  const editor: Stop = {
    slug: 'composition-editor',
    path: EDITOR_ON_COMPOSITION,
    ready: page => page.getByRole('textbox', { name: 'composition.yaml source' }),
  };
  const visual: Stop = {
    slug: 'composition-editor-visual',
    path: `${EDITOR_ON_COMPOSITION}&mode=visual`,
    ready: page => page.getByRole('radio', { name: /for t1$/ }).first(),
  };
  // Below 640 px the editor's code, preview and problems are tabs: the Problems tab is a stop of its own.
  const pane = (slug: string, tab: RegExp, ready: (page: Page) => Locator): Stop => ({
    slug,
    path: EDITOR_ON_COMPOSITION,
    ready: page => page.getByRole('tablist', { name: 'Editor panes' }),
    extra: async (page, label) => {
      await page
        .getByRole('tablist', { name: 'Editor panes' })
        .getByRole('tab', { name: tab })
        .click();
      await expect
        .soft(ready(page), `${label}: the pane did not open`)
        .toBeVisible({ timeout: 30_000 });
    },
  });
  return [
    {
      slug: 'compositions',
      path: `/orgs/${ORG}/compositions`,
      ready: page => page.locator('main').getByRole('heading', { level: 2, name: 'Compositions' }),
    },
    {
      slug: 'my-compositions',
      path: '/me/compositions',
      ready: page =>
        page.locator('main').getByRole('heading', { level: 1, name: 'My compositions' }),
    },
    {
      slug: 'composition-new',
      path: `/compositions/new?org=${ORG}`,
      ready: page =>
        page
          .locator('main')
          .getByRole('heading', { level: 1, name: 'Add a composition to OpenBinding' }),
    },
    { slug: 'composition-overview', path: COMPOSITION, ready: page => composed(page) },
    editor,
    visual,
    ...(mobile
      ? [
          pane('composition-editor-problems', /^Problems/, page =>
            page.getByRole('tab', { name: /^Problems/, selected: true })
          ),
        ]
      : []),
    {
      slug: 'composition-versions',
      path: `${COMPOSITION}/versions`,
      ready: page => page.getByRole('list', { name: `Versions of ${COMPOSITION_NAME}` }),
    },
    {
      slug: 'composition-versions-compare',
      path: `${COMPOSITION}/versions?${PAIR}`,
      ready: page => page.getByRole('region', { name: /^Binding/ }),
    },
    {
      slug: 'composition-versions-file',
      path: `${COMPOSITION}/versions?${PAIR}&diff=file`,
      ready: page => page.getByRole('region', { name: 'The text of 1.0.0 and 1.1.0' }),
    },
    {
      slug: 'composition-analytics',
      path: `${COMPOSITION}/analytics`,
      ready: page => page.getByRole('region', { name: 'Analytics' }),
    },
    {
      slug: 'composition-configuration',
      path: `${COMPOSITION}/configuration`,
      ready: page => page.getByRole('region', { name: 'Configuration explorer' }),
    },
    {
      slug: 'composition-settings',
      path: `${COMPOSITION}/settings`,
      ready: page => page.locator('main').getByRole('heading', { level: 2, name: 'Visibility' }),
    },
  ];
}

/** What anybody reads with no account: the public compositions, lab-other's public page, the language and the pricing. */
const VISITOR_STOPS: Stop[] = [
  {
    // OpenBinding's published pricing (GET /v1/plans/pricing), drawn by pricing-renderer, or the notice that it cannot be read.
    slug: 'pricing',
    path: '/pricing',
    ready: page =>
      page.getByRole('heading', { level: 1, name: 'Plans for every kind of binding work' }),
  },
  {
    slug: 'public-compositions',
    path: '/compositions',
    ready: page => page.getByRole('heading', { level: 1, name: 'Public compositions' }),
  },
  {
    slug: 'showcase',
    path: `/compositions/${OTHER_ORG}/sequential-workflow`,
    ready: page =>
      page.getByRole('main').getByRole('heading', { level: 1, name: COMPOSITION_NAME }),
    extra: async (page, label) => {
      await expect
        .soft(
          page
            .getByRole('navigation', { name: 'Composition sections' })
            .getByRole('link', { name: 'Settings' }),
          `${label}: a visitor sees Settings`
        )
        .toHaveCount(0);
      await expect
        .soft(
          page.getByRole('region', { name: 'Problem candidates' }),
          `${label}: a visitor sees the problem's candidates`
        )
        .toHaveCount(0);
    },
  },
  {
    slug: 'language',
    path: '/language',
    ready: page => page.getByRole('heading', { level: 1, name: 'Composition2Yaml' }),
  },
];

/** The viewer reads; the backend now asks for MEMBER to start a run, and nothing on these screens may let it try. */
const VIEWER_STOPS: Stop[] = [
  {
    slug: 'viewer-cases',
    path: PROBLEMS_TAB,
    ready: page => page.getByRole('region', { name: 'Problems' }),
    extra: async (page, label) => {
      await expect
        .soft(
          page.getByRole('button', { name: 'Upload BIM package' }),
          `${label}: a viewer sees "Upload BIM package"`
        )
        .toHaveCount(0);
    },
  },
  {
    slug: 'viewer-jobs',
    path: `${RUNS_PATH}`,
    ready: page =>
      page.getByRole('region', { name: 'Runs' }).getByRole('heading', { level: 2, name: /Runs/ }),
    extra: async (page, label) => {
      await expect
        .soft(
          page.getByRole('link', { name: 'Start a run' }),
          `${label}: a viewer sees "Start a run"`
        )
        .toHaveCount(0);
    },
  },
  {
    slug: 'viewer-run-launch',
    path: `${LAUNCH_PATH}&problem=${CASE}`,
    ready: page => page.getByRole('heading', { level: 1, name: 'New run' }),
    extra: async (page, label) => {
      await expect
        .soft(
          page.getByText('starting a run needs MEMBER'),
          `${label}: the launch page does not say a run needs MEMBER`
        )
        .toBeVisible();
      await expect
        .soft(
          page.locator('button:not([disabled])', { hasText: 'Send run' }),
          `${label}: a viewer has an enabled "Send run"`
        )
        .toHaveCount(0);
    },
  },
  {
    slug: 'viewer-compositions',
    path: `/orgs/${ORG}/compositions`,
    ready: page => page.locator('main').getByRole('heading', { level: 2, name: 'Compositions' }),
    extra: async (page, label) => {
      await expect
        .soft(
          page.getByRole('link', { name: 'New composition' }),
          `${label}: a viewer sees "New composition"`
        )
        .toHaveCount(0);
    },
  },
  {
    slug: 'viewer-composition',
    path: COMPOSITION,
    ready: page => composed(page),
    extra: async (page, label) => {
      await expect
        .soft(
          page.getByRole('button', { name: 'New version' }),
          `${label}: a viewer sees "New version"`
        )
        .toHaveCount(0);
      await expect
        .soft(
          page
            .getByRole('navigation', { name: 'Composition sections' })
            .getByRole('link', { name: 'Settings' }),
          `${label}: a viewer sees the Settings tab`
        )
        .toHaveCount(0);
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
    const listed = await page.request.get(`${API}/v1/organizations/${ORG}/runs?limit=100`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const jobs = listed.ok()
      ? ((await listed.json()) as { runs: Array<{ id: string; status: string }> }).runs
      : [];
    const finished = jobs.find(job => String(job.status).toLowerCase() === 'completed');
    const mobile = testInfo.project.name === 'mobile';
    const stops = [
      ...OWNER_STOPS,
      ...compositionStops(mobile),
      ...problemStops(mobile),
      ...sphereStops(),
    ];
    const skipped: Array<{ slug: string; why: string }> = [];
    // An engine card, whose plan ceilings come from the published pricing's document.
    const engines = await page.request.get(`${API}/v1/engines`);
    const engine = engines.ok()
      ? (
          (await engines.json()) as {
            engines: Array<{ namespace: string; name: string; version: string }>;
          }
        ).engines.find(item => item.name === 'random-search')
      : undefined;
    if (engine)
      stops.push({
        slug: 'engine-card',
        path: `/engines/${encodeURIComponent(engine.namespace)}/${encodeURIComponent(engine.name)}/${encodeURIComponent(engine.version)}`,
        ready: target => target.locator('main').getByRole('heading', { level: 1 }),
      });
    else
      skipped.push({
        slug: 'engine-card',
        why: `GET /v1/engines answered ${engines.status()} without random-search`,
      });
    const front = await studyFrontStop(page, token);
    if ('why' in front) {
      skipped.push({ slug: 'study-front', why: front.why });
      testInfo.annotations.push({
        type: 'skipped-screen',
        description: 'study-front: no finished study run',
      });
    } else {
      stops.push(front);
    }
    if (finished) {
      stops.splice(6, 0, {
        slug: 'job-result',
        path: `${RUN_PATH}/${finished.id}`,
        ready: target => finishedResult(target),
      });
    } else {
      skipped.push({
        slug: 'job-result',
        why: `the owner has no completed job to open (listRuns answered ${listed.status()}, ${jobs.length} jobs); run 04-job-random-search first`,
      });
      testInfo.annotations.push({
        type: 'skipped-screen',
        description: 'job-result: no completed job',
      });
    }
    await setBeta(page, token, true);
    try {
      await report(testInfo, 'owner', await walk(page, testInfo, stops, skipped));
    } finally {
      await setBeta(page, token, false);
    }
  });

  test('a visitor reads the public compositions, a public composition and the language', async ({
    page,
  }, testInfo) => {
    test.setTimeout(300_000);
    await report(testInfo, 'visitor', await walk(page, testInfo, VISITOR_STOPS));
  });

  test('the viewer is offered no way to start a run', async ({ page }, testInfo) => {
    test.setTimeout(600_000);
    await signInByApi(page, 'viewer');
    await report(testInfo, 'viewer', await walk(page, testInfo, VIEWER_STOPS));
  });
});
