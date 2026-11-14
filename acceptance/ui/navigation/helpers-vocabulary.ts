import { type Page, type Route } from '@playwright/test';
import { API, mockApi, type MockOptions, type Recorded } from './helpers';
import { PROBLEM_SLUG } from './helpers-problems';

// Mocks and locators of the vocabulary acceptance specs. There is no backend: the API origin is answered by page.route();
// routes added here win over the catch-all of mockApi() because they are registered later.
//
// The addresses of these specs are the LITERAL final ones (`/problems`, `/runs`), which match the constants of
// helpers.ts. The HTTP API keeps `cases` and `jobs`.

export const PROBLEMS_FINAL = '/app/acme/demo/problems';
export const RUNS_FINAL = '/app/acme/demo/runs';
export const RUNS_ALL_FINAL = '/app/runs';

export const API_CASES = '/v1/organizations/acme/projects/demo/cases';
export const API_JOBS = '/v1/organizations/acme/projects/demo/jobs';

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
 * A member of `acme` (or a visitor, with `role: null`) and a gateway that answers the lists the project screens read,
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
    id: 'problem-routing', slug: PROBLEM_SLUG, name: 'Routing', description: 'A routing problem', project_id: 'project-demo',
    created_by_id: 'user-1', created_at: NOW,
  };
  await answer(page, API_CASES, [problem]);
  await answer(page, `${API_CASES}/${PROBLEM_SLUG}`, problem);
  await answer(page, API_JOBS, []);
  await answer(page, '/v1/organizations/acme/projects/demo/studies', []);
  return { writes, gets };
}

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
 * `<screen>: "<the text>"`. An empty list means the screen obeys the rule.
 */
export async function forbiddenText(page: Page, screen: string, words: RegExp = CASE_JOB_WORDS): Promise<string[]> {
  const found = await page.evaluate(({ exempt, source, flags }) => {
    const pattern = new RegExp(source, flags);
    const hits: string[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
      const parent = node.parentElement;
      if (!text || !parent || !pattern.test(text) || parent.closest(exempt)) continue;
      const style = getComputedStyle(parent);
      if (style.visibility === 'hidden' || style.display === 'none' || parent.getClientRects().length === 0) continue;
      hits.push(text.slice(0, 80));
    }
    // Text that is not a text node: placeholders, button values and the chosen option of a closed select.
    for (const field of Array.from(document.querySelectorAll('input, textarea, select'))) {
      if (field.closest(exempt) || field.getClientRects().length === 0) continue;
      const input = field as HTMLInputElement & HTMLSelectElement;
      const shown = [input.placeholder, ['button', 'submit', 'reset'].includes(input.type) ? input.value : '',
        input.tagName === 'SELECT' ? input.selectedOptions[0]?.textContent : ''];
      for (const text of shown) {
        if (text && pattern.test(text)) hits.push(text.trim().slice(0, 80));
      }
    }
    return hits;
  }, { exempt: EXEMPT, source: words.source, flags: words.flags.replace('g', '') });
  return found.map((text) => `${screen}: "${text}"`);
}
