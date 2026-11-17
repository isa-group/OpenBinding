import { type Page, type Route } from '@playwright/test';
import { API, COMPOSITIONS, LAB_FLOW_PAGE, mockApi, type MockOptions, type Recorded } from './helpers';
import { PROBLEM_SLUG, mockProblems } from './helpers-problems';

// Mocks and locators of the vocabulary acceptance specs. There is no backend: the API origin is answered by page.route();
// routes added here win over the catch-all of mockApi() because they are registered later.
//
// The addresses of these specs are the LITERAL final ones, which match the constants of helpers.ts: the problems and the
// runs of the organization (`/orgs/acme/problems`, `/app/acme/runs`), and a problem's page (`/problems/acme/<slug>`). The HTTP
// API reads them from the organization.

export const PROBLEMS_FINAL = '/orgs/acme/problems';
export const PROBLEM_PAGES_FINAL = '/problems/acme';
export const RUNS_FINAL = '/app/acme/runs';

export const API_PROBLEMS = '/v1/organizations/acme/problems';
export const API_RUNS = '/v1/organizations/acme/runs';

const NOW = '2026-09-01T00:00:00Z';

const json = (body: unknown, status = 200) => (route: Route) => route.fulfill({ status, json: body });

/** Answers the exact API path (query ignored). */
async function answer(page: Page, path: string, body: unknown): Promise<void> {
  await page.route((url) => url.origin + url.pathname === `${API}${path}`, json(body));
}

export interface Gateway {
  /** The non-GET requests that reached the gateway. */
  writes: Recorded[];
  /** The paths (without the query) of the GET requests the page sent to the gateway, in order. */
  gets: string[];
}

/**
 * A member of `acme` (or a visitor, with `role: null`) and a gateway that answers the lists the organization's screens read,
 * with synthetic data that holds none of the words the vocabulary forbids. Records the GET paths the page sends.
 */
export async function mockGateway(page: Page, options: MockOptions = {}): Promise<Gateway> {
  const gets: string[] = [];
  page.on('request', (request) => {
    if (!request.url().startsWith(API) || request.method() !== 'GET') return;
    gets.push(new URL(request.url()).pathname);
  });
  const writes = await mockApi(page, options);
  if (options.role === null) return { writes, gets };

  const problem = {
    id: 'problem-routing', organization_id: 'org-acme', slug: PROBLEM_SLUG, name: 'Routing', description: 'A routing problem',
    created_by_id: 'user-1', created_at: NOW, updated_at: NOW, latest_revision: null, revision_count: 0,
  };
  await answer(page, API_PROBLEMS, { problems: [problem], total: 1, limit: 200, offset: 0 });
  await answer(page, `${API_PROBLEMS}/${PROBLEM_SLUG}`, problem);
  await answer(page, API_RUNS, { runs: [], total: 0 });
  await answer(page, '/v1/organizations/acme/studies', []);
  return { writes, gets };
}

// ---- the composition and problem screens ----------------------------------------------------------------------

/** A public composition of another organization, with no version yet: its showcase is read without membership. */
export const SHOWCASE = '/compositions/lab-other/fleet-routing';
const LAB_OTHER = { id: 'org-lab-other', slug: 'lab-other', name: 'Other Lab' };

/**
 * The screens of the composition and problem vocabulary scope (`src/test/vocabulary.terms.test.ts`), each with the level-1 heading
 * that shows it has loaded: the organization's Compositions tab, the composition `lab-flow` (no version yet) on each of its tabs,
 * the editor, the public list, another organization's public composition, Language, and the Problems tab and a problem's page.
 */
export const SCOPED_SCREENS: ReadonlyArray<{ path: string; heading: string | RegExp }> = [
  { path: COMPOSITIONS, heading: 'Acme' },
  { path: LAB_FLOW_PAGE, heading: 'Lab flow' },
  { path: `${LAB_FLOW_PAGE}/analytics`, heading: 'Lab flow' },
  { path: `${LAB_FLOW_PAGE}/versions`, heading: 'Lab flow' },
  { path: `${LAB_FLOW_PAGE}/settings`, heading: 'Lab flow' },
  { path: '/editor', heading: 'Composition editor' },
  { path: '/compositions', heading: 'Public compositions' },
  { path: SHOWCASE, heading: 'Fleet routing' },
  { path: '/language', heading: 'Composition2Yaml' },
  { path: PROBLEMS_FINAL, heading: 'Acme' },
  { path: `${PROBLEM_PAGES_FINAL}/${PROBLEM_SLUG}`, heading: 'Routing' },
];

/**
 * A member of `acme` and a gateway that answers the screens of `SCOPED_SCREENS`: the problem `routing` with its versions
 * (`mockProblems`), the composition `lab-flow` (`mockApi`), one public composition in the public list, and the public composition
 * `lab-other/fleet-routing`. Records the GET paths the page sends.
 */
export async function mockScopedScreens(page: Page): Promise<Gateway> {
  const gets: string[] = [];
  page.on('request', (request) => {
    if (!request.url().startsWith(API) || request.method() !== 'GET') return;
    gets.push(new URL(request.url()).pathname);
  });
  const writes = await mockProblems(page);
  const latest = { id: 'version-order-desk-1', label: '1.0.0', ordinal: 1, values_status: 'declared', verified: false, created_at: NOW };
  await answer(page, '/v1/compositions', {
    compositions: [{
      slug: 'order-desk', name: 'Order desk', description: 'Takes an order and confirms it.', kind: 'application', organization: LAB_OTHER,
      latest_version: latest, version_count: 1, updated_at: NOW,
    }],
    total: 1, limit: 24, offset: 0,
  });
  await answer(page, '/v1/organizations/lab-other/compositions/fleet-routing', {
    id: 'composition-fleet-routing', slug: 'fleet-routing', name: 'Fleet routing', description: 'Routes a fleet.', kind: 'workflow',
    archived: false, visibility: 'public', organization: LAB_OTHER, created_by_id: null, created_at: NOW, updated_at: NOW,
    version_count: 0, latest_version: null,
  });
  await answer(page, '/v1/organizations/lab-other/compositions/fleet-routing/versions', { versions: [], total: 0, limit: 200, offset: 0 });
  return { writes, gets };
}

/**
 * The words the composition and problem screens do not show: `deployment(s)`, `scenario(s)`, `build(s)`, `project(s)`,
 * `Application2Yaml` and a versioned `Composition2Yaml v1` or `v2`.
 */
export const COMPOSITION_WORDS = /\b(deployments?|scenarios?|builds?|projects?|Application2Yaml|Composition2Yaml v[12])\b/i;

/** "Plan" next to a proposal. */
export const PLAN_WITH_PROPOSAL = /^(?=[\s\S]*\bproposals?\b)[\s\S]*\bplans?\b/i;

// ---- the text scan --------------------------------------------------------------------------------------------

/** The elements whose text the vocabulary rule leaves out: code, and the SourceView and LogPanel regions. */
const EXEMPT = [
  'code', 'pre', 'kbd', 'samp', 'script', 'style', 'noscript', 'textarea',
  '[data-testid*="source-view" i]', '[data-testid*="sourceview" i]', '[data-testid*="log-panel" i]', '[data-testid*="logpanel" i]',
  '[data-component="SourceView"]', '[data-component="LogPanel"]',
  '[class*="SourceView"]', '[class*="LogPanel"]',
].join(', ');

/** The words of the vocabulary rule, as whole words in any letter case. */
export const CASE_JOB_WORDS = /\b(cases?|jobs?)\b/i;

/**
 * The visible text outside the exempt elements that holds a forbidden word, one entry per text node:
 * `<screen>: "<the text>"`. An empty list means the screen obeys the rule. `root` is a selector of the part of the page read
 * (the whole body by default).
 */
export async function forbiddenText(page: Page, screen: string, words: RegExp = CASE_JOB_WORDS, root = 'body'): Promise<string[]> {
  const found = await page.evaluate(({ exempt, source, flags, scope }) => {
    const pattern = new RegExp(source, flags);
    const hits: string[] = [];
    const within = document.querySelector(scope) ?? document.body;
    const walker = document.createTreeWalker(within, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
      const parent = node.parentElement;
      if (!text || !parent || !pattern.test(text) || parent.closest(exempt)) continue;
      const style = getComputedStyle(parent);
      if (style.visibility === 'hidden' || style.display === 'none' || parent.getClientRects().length === 0) continue;
      hits.push(text.slice(0, 80));
    }
    // Text that is not a text node: placeholders, button values and the chosen option of a closed select.
    for (const field of Array.from(within.querySelectorAll('input, textarea, select'))) {
      if (field.closest(exempt) || field.getClientRects().length === 0) continue;
      const input = field as HTMLInputElement & HTMLSelectElement;
      const shown = [input.placeholder, ['button', 'submit', 'reset'].includes(input.type) ? input.value : '',
        input.tagName === 'SELECT' ? input.selectedOptions[0]?.textContent : ''];
      for (const text of shown) {
        if (text && pattern.test(text)) hits.push(text.trim().slice(0, 80));
      }
    }
    return hits;
  }, { exempt: EXEMPT, source: words.source, flags: words.flags.replace('g', ''), scope: root });
  return found.map((text) => `${screen}: "${text}"`);
}
