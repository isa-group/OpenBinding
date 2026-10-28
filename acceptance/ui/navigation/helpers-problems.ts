import { expect, type Locator, type Page, type Route } from '@playwright/test';
import { API, mockApi, organization, project, PROBLEMS, type MockOptions, type Recorded } from './helpers';

// Mock data and locators of the problem-page and study-page acceptance specs. There is no backend: the API origin is
// answered by page.route(); routes added here win over the catch-all of mockApi() because they are registered later.

const NOW = '2026-09-01T00:00:00Z';
const ROOT = `${API}/v1/organizations/acme/projects/demo`;

const json = (body: unknown, status = 200) => (route: Route) => route.fulfill({ status, json: body });

/** Answers the exact API path (query ignored). */
async function answer(page: Page, path: string, body: unknown, status = 200): Promise<void> {
  await page.route((url) => url.origin + url.pathname === `${API}${path}`, json(body, status));
}

// ---- problems -------------------------------------------------------------------------------------------------

export const PROBLEM_SLUG = 'routing';
export const VERSION_NUMBERS = [1, 2, 3];
export const versionMarker = (n: number) => `alpha-v${n}`;

const bindingCase = {
  id: 'case-routing', slug: PROBLEM_SLUG, name: 'Routing', description: 'A routing problem', project_id: 'project-demo',
  created_by_id: 'user-1', created_at: NOW,
};

const revision = (n: number) => ({
  id: `rev-${n}`, binding_case_id: 'case-routing', revision: n, digest: `sha256-${String(n).repeat(64)}`,
  document: { name: versionMarker(n) }, source_snapshot_id: null, created_at: NOW,
});

/** `visitor`: a signed-in person who only reads the public project `demo` of `acme` (access `public_read`). */
export interface ProblemMockOptions extends MockOptions {
  visitor?: boolean;
}

export async function mockProblems(page: Page, options: ProblemMockOptions = {}): Promise<Recorded[]> {
  const visitor = options.visitor === true;
  const publicProject = { ...project('demo', 'Demo'), visibility: 'public', access: 'public_read', effective_role: null };
  const requests = await mockApi(page, visitor ? { ...options, projects: [publicProject] } : options);
  if (visitor) {
    await answer(page, '/v1/organizations/acme/projects/demo', publicProject);
    const reader = { ...organization('acme', 'Acme'), effective_role: null };
    await answer(page, '/v1/organizations/acme', reader);
    await answer(page, '/v1/organizations', [reader]);
    await answer(page, '/v1/organizations/acme/members', []);
  }
  await answer(page, '/v1/organizations/acme/projects/demo/cases', [bindingCase]);
  await answer(page, `/v1/organizations/acme/projects/demo/cases/${PROBLEM_SLUG}`, bindingCase);
  await answer(page, `/v1/organizations/acme/projects/demo/cases/${PROBLEM_SLUG}/revisions`, VERSION_NUMBERS.map(revision));
  for (const n of VERSION_NUMBERS) {
    await answer(page, `/v1/organizations/acme/projects/demo/cases/${PROBLEM_SLUG}/revisions/${n}`, revision(n));
  }
  await answer(page, '/v1/organizations/acme/projects/demo/jobs', []);
  return requests;
}

// ---- studies --------------------------------------------------------------------------------------------------

const definition = { engines: [{ id: 'multi-heuristic' }], seeds: [1] };
const study = (slug: string, name: string) => ({
  id: `study-${slug}`, slug, name, description: '', project_id: 'project-demo', archived: false, state: 'ready',
  definition, definition_artifact_id: `artifact-${slug}`, definition_version_id: `definition-${slug}`,
  created_by_id: 'user-1', created_at: NOW,
});

const studyRun = (id: string, number: number, created: string) => ({
  id, study_id: 'study-s1', run_number: number, state: 'completed', matrix_digest: `sha256-${String(number).repeat(64)}`,
  cells: 1, summary: {}, definition_version_id: 'definition-s1', created_at: created, finished_at: created,
});

export const STUDY_RUNS = [studyRun('r1', 1, '2026-09-01T00:00:00Z'), studyRun('r2', 2, '2026-09-02T00:00:00Z')];

const cell = {
  id: 'c7', study_run_id: 'r1', ordinal: 1, binding_case_revision_id: 'rev-1', engine_ref: { id: 'multi-heuristic' },
  parameters: {}, seed: 1, fingerprint: 'fp-c7', job_id: 'j9', state: 'completed', metrics: {},
};

const analytics = (cells: number) => ({
  cells, completed: cells, failed: 0, feasible: cells, infeasible: 0, objective_distributions: {}, runtimes_s: [],
  pareto: [], stability: {}, binding_space: null,
});

/** Study `s1` with the study runs r1 and r2 (r2 the latest) and the cell c7 of r1 that ran as the run j9; study `s0` has none. */
export async function mockStudies(page: Page, options: MockOptions = {}): Promise<Recorded[]> {
  const requests = await mockApi(page, options);
  await answer(page, '/v1/organizations/acme/projects/demo/studies', [study('s1', 'Study one'), study('s0', 'Study zero')]);
  await answer(page, '/v1/organizations/acme/projects/demo/studies/s1', study('s1', 'Study one'));
  await answer(page, '/v1/organizations/acme/projects/demo/studies/s0', study('s0', 'Study zero'));
  await answer(page, '/v1/organizations/acme/projects/demo/studies/s1/runs', STUDY_RUNS);
  await answer(page, '/v1/organizations/acme/projects/demo/studies/s0/runs', []);
  for (const run of STUDY_RUNS) {
    const base = `/v1/organizations/acme/projects/demo/studies/s1/runs/${run.id}`;
    await answer(page, base, run);
    await answer(page, `${base}/analytics`, analytics(run.id === 'r1' ? 11 : 22));
    await answer(page, `${base}/cells`, [{ ...cell, study_run_id: run.id }]);
    await answer(page, `${base}/cells/c7`, { ...cell, study_run_id: run.id });
    await answer(page, `${base}/cells/c7/result`, { job_id: 'j9' });
  }
  return requests;
}

/** The API GET requests (path and query) the page sends, in order. */
export function trackGets(page: Page): string[] {
  const seen: string[] = [];
  page.on('request', (request) => {
    if (!request.url().startsWith(API) || request.method() !== 'GET') return;
    const url = new URL(request.url());
    seen.push(url.pathname + url.search);
  });
  return seen;
}

export { PROBLEMS, ROOT };

// ---- locators -------------------------------------------------------------------------------------------------

/**
 * The tab group of a page: the innermost `nav` or tablist that holds all the given labels (links or tabs). The
 * project tabs and the application header never hold the labels of a page's own tabs together.
 */
export const tabGroup = (page: Page, labels: string[]): Locator => {
  let group = page.locator('nav, [role="tablist"]');
  for (const label of labels) group = group.filter({ has: page.getByText(label, { exact: true }) });
  return group.last();
};

/** The visible labels of the tab group's entries, in order. */
export const tabLabels = async (group: Locator): Promise<string[]> => (await group.locator('a, [role="tab"], button').allInnerTexts())
  .map((text) => text.trim()).filter(Boolean);

/** The entry `label` of the group that is marked as the current one. */
export const selectedTab = (group: Locator, label: string): Locator => group
  .locator('[aria-current="page"], [aria-selected="true"], [aria-current="true"]')
  .filter({ hasText: new RegExp(`^\\s*${label}\\s*$`) }).first();

/** A selector (native or ARIA combobox) by the word of its accessible name. */
export const selectorOf = (page: Page, word: RegExp): Locator => page.getByRole('combobox', { name: word }).first();

/** What a selector currently shows: its value and its visible text. */
export const shownBy = (selector: Locator): Promise<string> => selector.evaluate((element) => {
  const input = element as HTMLSelectElement & HTMLInputElement;
  const chosen = input.tagName === 'SELECT' ? input.selectedOptions[0]?.textContent ?? '' : element.textContent ?? '';
  return `${input.value ?? ''}|${chosen}`;
});

/** Chooses the option whose value is `value`, or whose text holds it as a whole word. */
export async function choose(page: Page, selector: Locator, value: string): Promise<void> {
  const isSelect = await selector.evaluate((element) => element.tagName === 'SELECT');
  if (isSelect) {
    const match = await selector.evaluate((element, wanted) => {
      const options = Array.from((element as HTMLSelectElement).options);
      const found = options.find((option) => option.value === wanted)
        ?? options.find((option) => new RegExp(`\\b${wanted}\\b`).test(option.textContent ?? ''));
      return found?.value ?? null;
    }, value);
    expect(match, `an option for ${value}`).not.toBeNull();
    await selector.selectOption({ value: match! });
    return;
  }
  await selector.click();
  await page.getByRole('option', { name: new RegExp(`\\b${value}\\b`) }).first().click();
}
