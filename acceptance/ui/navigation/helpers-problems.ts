import { expect, type Locator, type Page, type Route } from '@playwright/test';
import { API, mockApi, organization, PROBLEMS, type MockOptions, type Recorded } from './helpers';

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
const PROBLEMS_API = `/v1/organizations/acme/problems`;

const revision = (n: number) => ({
  id: `rev-${n}`, problem_id: 'problem-routing', revision: n, package_digest: `sha256-${String(n).repeat(64)}`, package_size: 120,
  created_by_id: 'user-1', created_at: NOW,
});

const latest = VERSION_NUMBERS.length;
const problem = {
  id: 'problem-routing', organization_id: 'org-acme', slug: PROBLEM_SLUG, name: 'Routing', description: 'A routing problem',
  created_by_id: 'user-1', created_at: NOW, updated_at: NOW,
  latest_revision: { id: `rev-${latest}`, revision: latest, package_digest: revision(latest).package_digest, created_at: NOW },
};

const revisionDetail = (n: number) => ({
  ...revision(n), document: { name: versionMarker(n) }, compilations: [],
  files: [{ path: 'instance.json', role: 'root', digest: `sha256-${'a'.repeat(64)}`, media_type: 'application/json' }], resource_digests: {},
});

/** CRC-32 of the bytes, as a ZIP entry records it. */
function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** A ZIP with one stored (uncompressed) file: the package of a version, as the gateway serves it back. */
function storedZip(name: string, text: string): Buffer {
  const data = Buffer.from(text);
  const path = Buffer.from(name);
  const crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(path.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(path.length, 28);
  const offset = local.length + path.length + data.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + path.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([local, path, data, central, path, end]);
}

/** `viewer`: the account is a VIEWER of `acme`, so it reads the problems and saves nothing. */
export interface ProblemMockOptions extends MockOptions {
  viewer?: boolean;
}

/** The problem `routing` of `acme` with the versions 1 to 3; each package holds an instance named after its version. */
export async function mockProblems(page: Page, options: ProblemMockOptions = {}): Promise<Recorded[]> {
  const requests = await mockApi(page, options);
  if (options.viewer) {
    const reader = { ...organization('acme', 'Acme'), effective_role: 'VIEWER' };
    await answer(page, '/v1/organizations/acme', reader);
    await answer(page, '/v1/organizations', [reader]);
  }
  await answer(page, PROBLEMS_API, { problems: [problem], total: 1, limit: 200, offset: 0 });
  await answer(page, `${PROBLEMS_API}/${PROBLEM_SLUG}`, problem);
  await answer(page, `${PROBLEMS_API}/${PROBLEM_SLUG}/revisions`, [...VERSION_NUMBERS].reverse().map(revision));
  for (const n of VERSION_NUMBERS) {
    const base = `${PROBLEMS_API}/${PROBLEM_SLUG}/revisions/${n}`;
    await answer(page, base, revisionDetail(n));
    const zip = storedZip('instance.json', JSON.stringify({ apiVersion: 'bim/v1', kind: 'Instance', metadata: { name: versionMarker(n) } }));
    await page.route((url) => url.origin + url.pathname === `${API}${base}/source`, (route) => route.fulfill({ status: 200, contentType: 'application/vnd.bim+zip', body: zip }));
  }
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
