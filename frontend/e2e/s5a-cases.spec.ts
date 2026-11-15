import JSZip from 'jszip';
import { expect as baseExpect, test, type Page, type Route, type TestInfo } from '@playwright/test';
import { failureBody } from './helpers/problems';
import { CURRENT_FIXTURE, catalogFixture } from '../src/pages/Pricing/pricingFixture';
import { digestOf, irDocument } from '../src/pages/Cases/fixtures';

// S5a · the problems of an organization: case-list (/app/:org/problems) and the problem page case-detail with its tabs Overview,
// Runs, Versions, Source and Settings. A problem is uploaded as a .bim.zip, a new version is another upload (or a save in the
// Workbench), and every version is the package exactly as it was uploaded with its compilation by the installed toolchain.
// There is no backend: the API origin is answered by page.route(). Screenshots go to testInfo.outputPath()
// (test-results/, ignored by git) so they can be looked at after a run.

const API = 'http://localhost:8000';

// Several browsers share one development server, so a screen can take longer than the default five seconds to settle.
const expect = baseExpect.configure({ timeout: 15_000 });

type Handler = (route: Route) => Promise<void> | void;
const json = (body: unknown, status = 200): Handler => (route) => route.fulfill({ status, json: body });
const detail = (status: number, code: string, error: string, extra: Record<string, unknown> = {}): Handler => json(failureBody(status, code, error, extra), status);
const noContent: Handler = (route) => route.fulfill({ status: 204 });

const token = (expiresInSeconds: number) => [
  'header',
  Buffer.from(JSON.stringify({ sub: 'user-1', exp: Math.floor(Date.now() / 1000) + expiresInSeconds })).toString('base64'),
  'signature',
].join('.');

const lucia = {
  id: 'user-1', username: 'lucia.vega', email: 'lucia@example.org', role: 'user', is_active: true, plan: 'RESEARCH',
  created_at: '2026-03-02T00:00:00Z', cas_verified: true,
};

type Role = 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER';

const org = (n: number, slug: string, name: string, role: Role) => ({
  id: `org-${n}`, slug, name, parent_id: null, effective_role: role, created_at: '2026-03-03T00:00:00Z',
});

const organizations = [
  org(1, 'isa-demo', 'ISA Demo Group', 'ADMIN'),
  org(3, 'consultora-demo', 'Consultora Demo', 'VIEWER'),
];

const project = (n: number, orgId: string, slug: string, name: string) => ({
  id: `project-${n}`, organization_id: orgId, slug, name, description: '', visibility: 'private', created_by_id: 'user-1',
  created_at: '2026-04-01T00:00:00Z', updated_at: '2026-10-08T00:00:00Z', access: 'member' as const, effective_role: 'OWNER' as Role,
});

const projectsOf: Record<string, ReturnType<typeof project>[]> = {
  'isa-demo': [project(1, 'org-1', 'qos-benchmarks', 'QoS Benchmarks')],
  'consultora-demo': [],
};

// --- problems, versions and compilations

interface Revision {
  id: string; problem_id: string; revision: number; package_digest: string; package_size: number; created_by_id: string; created_at: string;
}
interface ProblemRow {
  item: { id: string; organization_id: string; slug: string; name: string; description: string; created_by_id: string; created_at: string; updated_at: string };
  revisions: Revision[];
}

const problemRow = (orgId: string, slug: string, name: string, description: string, revisions: Array<[number, string, string]>): ProblemRow => ({
  item: { id: `case-${slug}`, organization_id: orgId, slug, name, description, created_by_id: 'user-1', created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-01T00:00:00Z' },
  revisions: revisions.map(([revision, char, createdAt]) => ({
    id: `rev-${slug}-${revision}`, problem_id: `case-${slug}`, revision, package_digest: digestOf(char), package_size: 48_213, created_by_id: 'user-1', created_at: createdAt,
  })),
});

const checkout = (orgId: string) => problemRow(orgId, 'flujo-checkout', 'Flujo de checkout', 'Payments with parallel stock and shipping.', [
  [1, '1', '2026-08-01T09:00:00Z'], [2, '2', '2026-08-20T10:05:00Z'],
]);

const seedProblems = (): Record<string, ProblemRow[]> => ({
  'isa-demo': [checkout('org-1'), problemRow('org-1', 'borrador', 'Borrador', '', [])],
  'consultora-demo': [checkout('org-3')],
});

/** How many candidates the payment task has in each version: what their compiled forms differ in. */
const PAY_OF: Record<number, number> = { 1: 5, 2: 8 };

const compilationOf = (revision: number) => ({
  id: `compilation-${revision}`, revision_id: `rev-${revision}`, compilation_digest: digestOf('9'), compiler_digest: digestOf('8'), ir_digest: digestOf('c'),
  binding_space: '125892', created_at: '2026-08-20T10:05:00Z', current: true, toolchain: {},
  analysis: { tasks: 6, candidates: 24, constraints: 2, placement: false, bindingSpace: '125892' },
  resources: { application: { role: 'application', path: 'application.json', apiVersion: 'qos-binding/v1', kind: 'Application' } },
  compatible_modes: [{ compatible: true }, { compatible: true }],
});

const researchUsage = () => ({
  plan: 'RESEARCH', contract_pending: false, features: { collaboration: true, runs: true },
  capabilities: { maxConcurrentRuns: 4, maxPrivateProjects: 10, maxProblems: null, maxRepositoryStorage: null },
});

type Refusable = 'list' | 'create' | 'revision' | 'remove' | 'compilation';

interface State {
  problems: Record<string, ProblemRow[]>;
  /** A refusal for one call; unset means it succeeds. */
  refuse: Partial<Record<Refusable, Handler>>;
  /** What the writes carried, to check what was sent. */
  sent: Record<string, unknown>;
}

/** Everything these screens read and write, answered; anything else on the API origin is an empty 404. */
async function mockApi(page: Page): Promise<State> {
  const state: State = { problems: seedProblems(), refuse: {}, sent: {} };
  const zip = await new JSZip().file('instance.json', '{"apiVersion":"bim/v1","kind":"Instance"}').file('application.json', '{"kind":"Application"}').generateAsync({ type: 'nodebuffer' });
  await page.addInitScript(() => {
    localStorage.setItem('openbinding-access-token', 's5a-access');
    localStorage.setItem('openbinding-refresh-token', 's5a-refresh');
  });

  await page.route(`${API}/**`, (route) => route.fulfill({ status: 404, json: { detail: 'not mocked' } }));
  await page.route(`${API}/health**`, json({ status: 'ok' }));
  await page.route(`${API}/v1/auth/refresh`, json({ access_token: 's5a-access-2', refresh_token: 's5a-refresh-2', token_type: 'bearer', expires_in: 900 }));
  await page.route(`${API}/v1/pricing/catalog`, json(catalogFixture));
  await page.route(`${API}/v1/pricing/current`, json(CURRENT_FIXTURE));
  await page.route(`${API}/v1/users/me`, json(lucia));
  await page.route(`${API}/v1/users/me/pricing-token`, json({ pricing_token: token(3600) }));
  await page.route(`${API}/v1/users/me/usage`, json(researchUsage()));
  await page.route(new RegExp(`^${API}/v1/notifications(\\?.*)?$`), json([]));
  await page.route(new RegExp(`^${API}/v1/jobs(\\?.*)?$`), json([]));

  await page.route(new RegExp(`^${API}/v1/organizations(/.*)?(\\?.*)?$`), async (route) => {
    const url = new URL(route.request().url());
    const parts = url.pathname.split('/').filter(Boolean);
    // /v1/organizations/{org}/problems/{problem}/revisions/{revision}/{tail}/{compilation}/ir
    const [, , orgSlug, section, problemSlug, sub, revisionRef, tail] = parts;
    const method = route.request().method();
    const found = organizations.find((item) => item.slug === orgSlug);

    if (!orgSlug) return json(organizations)(route);
    if (!found) return detail(403, 'organization_forbidden', 'Not a member.')(route);
    if (section === 'members' || section === 'library') return json([])(route);
    if (section === 'projects') return json(problemSlug ? projectsOf[orgSlug][0] : projectsOf[orgSlug])(route);
    if (section !== 'problems') return json(found)(route);

    const rows = state.problems[orgSlug] ?? [];
    const latest = (row: ProblemRow) => {
      const newest = [...row.revisions].sort((a, b) => b.revision - a.revision)[0];
      return newest ? { id: newest.id, revision: newest.revision, package_digest: newest.package_digest, created_at: newest.created_at } : null;
    };
    const upload = (row: ProblemRow, revision: Revision, created: boolean) => ({
      problem: { ...row.item, latest_revision: latest(row) }, revision, created, compilation: { ...compilationOf(revision.revision), compatible_modes: undefined },
    });

    if (!problemSlug) {
      if (method === 'POST') {
        if (state.refuse.create) return state.refuse.create(route);
        state.sent.create = url.searchParams.toString();
        const slug = url.searchParams.get('slug') || 'uploaded';
        const row = problemRow(found.id, slug, url.searchParams.get('name') || slug, url.searchParams.get('description') ?? '', [[1, '7', '2026-10-09T08:00:00Z']]);
        state.problems[orgSlug] = [...rows, row];
        return json(upload(row, row.revisions[0], true), 201)(route);
      }
      if (state.refuse.list) return state.refuse.list(route);
      return json({ problems: rows.map((row) => ({ ...row.item, latest_revision: latest(row) })), total: rows.length, limit: 200, offset: 0 })(route);
    }

    const row = rows.find((candidate) => candidate.item.slug === problemSlug);
    if (!row) return detail(404, 'not_found', 'Problem not found.')(route);
    if (!sub) {
      if (method === 'PATCH') {
        state.sent.patch = route.request().postDataJSON();
        row.item = { ...row.item, ...(route.request().postDataJSON() as object) };
        return json(row.item)(route);
      }
      if (method === 'DELETE') {
        if (state.refuse.remove) return state.refuse.remove(route);
        state.problems[orgSlug] = rows.filter((candidate) => candidate !== row);
        return noContent(route);
      }
      return json({ ...row.item, latest_revision: latest(row) })(route);
    }
    if (sub !== 'revisions') return detail(404, 'not_found', 'Not mocked.')(route);
    if (!revisionRef) {
      if (method === 'POST') {
        if (state.refuse.revision) return state.refuse.revision(route);
        const next: Revision = {
          id: `rev-${row.item.slug}-${row.revisions.length + 1}`, problem_id: row.item.id, revision: row.revisions.length + 1, package_digest: digestOf('8'),
          package_size: 49_000, created_by_id: 'user-1', created_at: '2026-10-09T09:00:00Z',
        };
        row.revisions = [...row.revisions, next];
        return json(upload(row, next, true), 201)(route);
      }
      return json([...row.revisions].reverse())(route);
    }
    const revision = row.revisions.find((candidate) => String(candidate.revision) === revisionRef || candidate.id === revisionRef || candidate.package_digest === revisionRef);
    if (!revision) return detail(404, 'not_found', 'Problem revision not found.')(route);
    if (!tail) {
      return json({
        ...revision, document: { apiVersion: 'bim/v1', kind: 'Instance', metadata: { name: `checkout-${revision.revision}` } }, compilations: [],
        files: [{ path: 'instance.json', role: 'root', digest: digestOf('1'), media_type: 'application/json' }, { path: 'application.json', role: 'application', digest: digestOf('2'), media_type: 'application/json' }],
        resource_digests: { application: digestOf('2') },
      })(route);
    }
    if (tail === 'source') return route.fulfill({ status: 200, contentType: 'application/vnd.bim+zip', body: zip });
    if (tail === 'compilation') return state.refuse.compilation ? state.refuse.compilation(route) : json(compilationOf(revision.revision))(route);
    if (tail === 'compilations') return json({ id: `compilation-${revision.revision}`, ir_digest: digestOf('c'), ir: irDocument(PAY_OF[revision.revision] ?? 8), source_map: {} })(route);
    return detail(404, 'not_found', 'Not mocked.')(route);
  });
  return state;
}

function watchCriticalErrors(page: Page) {
  const critical: string[] = [];
  page.on('pageerror', (error) => critical.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    const text = message.text();
    if (message.type() === 'error' && /The above error occurred|Minified React error|Maximum update depth|Uncaught/i.test(text)) critical.push(`console: ${text}`);
  });
  return critical;
}

/** With E2E_SCREENSHOTS=1, a full-page picture of the current state for a person to look at; always a check that nothing scrolls sideways. */
async function capture(page: Page, testInfo: TestInfo, name: string) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    (document.activeElement as HTMLElement | null)?.blur();
    window.scrollTo(0, 0);
  });
  if (process.env.E2E_SCREENSHOTS) await page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true, animations: 'disabled' });
  const width = page.viewportSize()?.width ?? 0;
  const overflow = await page.evaluate((expected) => document.documentElement.scrollWidth - expected, width);
  expect(overflow, `${name} should not scroll sideways`).toBeLessThanOrEqual(1);
}

const packageFile = async () => ({
  name: 'analisis-de-latencia.bim.zip', mimeType: 'application/vnd.bim+zip',
  buffer: await new JSZip().file('instance.json', '{"apiVersion":"bim/v1","kind":"Instance"}').generateAsync({ type: 'nodebuffer' }),
});

test.setTimeout(120_000);
test.describe.configure({ mode: 'default' });

const viewports = [
  { name: 'desktop', viewport: { width: 1440, height: 900 }, isMobile: false, deviceScaleFactor: 1 },
  { name: 'mobile', viewport: { width: 390, height: 844 }, isMobile: true, deviceScaleFactor: 2 },
] as const;

const PROBLEMS = '/app/isa-demo/problems';

for (const { name, viewport, isMobile, deviceScaleFactor } of viewports) {
  test.describe(`${name} · S5a problems`, () => {
    test.use({ viewport, isMobile, deviceScaleFactor });

    test('case-list /app/:org/problems · the problems of the organization, an upload and a delete', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      await page.goto(PROBLEMS);
      const main = page.locator('#platform-main');

      await expect(main.getByRole('heading', { level: 1, name: 'Problems' })).toBeVisible();
      const list = main.getByRole('list', { name: 'Problems' });
      await expect(list.getByRole('listitem')).toHaveCount(2);
      await expect(list.getByRole('link', { name: /Flujo de checkout/ })).toHaveAttribute('href', `${PROBLEMS}/flujo-checkout`);
      await expect(list.getByText('2 versions')).toBeVisible();
      await expect(list.getByRole('link', { name: 'Run latest' })).toHaveAttribute('href', '/app/isa-demo/qos-benchmarks/runs/new?problem=flujo-checkout&revision=2');
      await expect(main.getByRole('link', { name: 'Write one in the Workbench' })).toHaveAttribute('href', '/app/isa-demo/workbench');
      await expect(main.getByRole('link', { name: 'Start from a template' })).toHaveAttribute('href', '/app/isa-demo/workbench?template=demo%2F01_simple_seq');
      await expect(main.getByRole('navigation', { name: 'Project sections' })).toHaveCount(0);
      await expect(main).not.toContainText(/sha256-|[0-9a-f]{12}/);
      await capture(page, testInfo, `list-${name}`);

      // Upload a package as a new problem: a refused one lists where it is wrong, an accepted one opens the new problem.
      await main.getByRole('button', { name: 'Upload BIM package' }).click();
      await expect(page).toHaveURL(new RegExp(`${PROBLEMS}\\?create=problem$`));
      const dialog = page.getByRole('dialog', { name: 'Upload a BIM package' });
      await dialog.getByLabel('BIM package').setInputFiles(await packageFile());
      await expect(dialog.getByLabel('Name')).toHaveValue('analisis-de-latencia');
      state.refuse.create = detail(422, 'invalid_instance', 'The BIM package did not compile.', { diagnostics: [{ code: 'missing_role', message: 'The application is missing.', resource: 'instance.json' }] });
      await dialog.getByRole('button', { name: 'Upload problem' }).click();
      await expect(dialog.getByRole('alert')).toContainText('The package was read and refused (422 · invalid_instance)');
      await expect(dialog.getByRole('list', { name: 'What the compiler found' })).toContainText('The application is missing.');
      await capture(page, testInfo, `upload-${name}-422`);
      state.refuse.create = undefined;
      await dialog.getByRole('button', { name: 'Upload problem' }).click();
      await expect(page).toHaveURL(new RegExp(`${PROBLEMS}/analisis-de-latencia$`));
      await expect(main.getByRole('heading', { level: 1, name: 'analisis-de-latencia' })).toBeVisible();
      await expect(main.getByText('Problem “analisis-de-latencia” created with version 1.')).toBeVisible();
      expect(state.sent.create).toContain('slug=analisis-de-latencia');
      await capture(page, testInfo, `upload-${name}-created`);
      if (isMobile) {
        expect(critical).toEqual([]);
        return;
      }

      // Deleting a problem that runs used is refused, and says why.
      await page.goto(PROBLEMS);
      state.refuse.remove = detail(409, 'problem_has_runs', 'Runs or studies name a revision of this problem, so it is kept as their evidence.');
      await main.getByRole('list', { name: 'Problems' }).getByRole('button', { name: 'Delete Flujo de checkout' }).click();
      const remove = page.getByRole('dialog', { name: 'Delete Flujo de checkout?' });
      await remove.getByLabel('Type flujo-checkout to confirm').fill('flujo-checkout');
      await remove.getByRole('button', { name: 'Delete problem' }).click();
      await expect(remove.getByRole('alert')).toContainText('Runs or studies name a version of this problem, so it can’t be deleted (409 · problem_has_runs).');
      await capture(page, testInfo, `delete-${name}-409`);
      expect(critical).toEqual([]);
    });

    test('case-detail /app/:org/problems/:case · overview, versions, source, settings and a new version', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      await mockApi(page);
      await page.goto(`${PROBLEMS}/flujo-checkout`);
      const main = page.locator('#platform-main');

      await expect(main.getByRole('heading', { level: 1, name: 'Flujo de checkout' })).toBeVisible();
      await expect(main.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
      await expect(main.getByRole('link', { name: 'Edit in the Workbench' })).toHaveAttribute('href', '/app/isa-demo/workbench?problem=flujo-checkout&revision=2');
      await expect(main.getByRole('link', { name: 'Run this version' })).toHaveAttribute('href', '/app/isa-demo/qos-benchmarks/runs/new?problem=flujo-checkout&revision=2');
      const workflow = main.getByRole('region', { name: 'How the service works' });
      await expect(workflow.getByRole('img', { name: /^Workflow: authenticate, then inventory and shipping in parallel/ })).toBeVisible();
      await expect(main.getByRole('region', { name: 'Candidates' }).getByRole('table')).toBeVisible();
      await expect(main.getByRole('region', { name: 'Resources it’s built from' })).toHaveCount(0);
      await capture(page, testInfo, `overview-${name}`);

      // The versions as a timeline, and what changed between two of them.
      await main.getByRole('tab', { name: 'Versions' }).click();
      const versions = main.getByRole('region', { name: 'Versions' });
      await expect(versions.getByRole('link', { name: /^Version \d$/ })).toHaveText(['Version 2', 'Version 1']);
      await expect(main.getByRole('heading', { level: 2, name: 'Compare versions' })).toBeVisible();
      await expect(main.getByRole('row', { name: /Candidates for pay-card/ })).toContainText('Changed');
      await capture(page, testInfo, `versions-${name}`);

      // The source: the files of the package as uploaded, and the compiled form.
      await main.getByRole('tab', { name: 'Source' }).click();
      await expect(main.getByRole('list', { name: 'Files in the package' })).toBeVisible();
      await expect(main.getByRole('region', { name: 'What the engines receive' })).toContainText('2 engine modes can run it.');
      await capture(page, testInfo, `source-${name}`);

      // A new version: another upload of a package.
      await main.getByRole('button', { name: 'Upload new version' }).click();
      const dialog = page.getByRole('dialog', { name: 'New version of Flujo de checkout' });
      await dialog.getByLabel('BIM package').setInputFiles(await packageFile());
      await dialog.getByRole('button', { name: 'Upload version' }).click();
      await expect(main.getByText('Saved as version 3.')).toBeVisible();
      await expect(main.getByRole('combobox', { name: 'Version' })).toHaveValue('3');
      await capture(page, testInfo, `new-version-${name}`);

      await main.getByRole('tab', { name: 'Settings' }).click();
      await expect(main.getByLabel('Name', { exact: true })).toHaveValue('Flujo de checkout');
      await expect(main.getByRole('button', { name: 'Delete problem' })).toBeVisible();
      await capture(page, testInfo, `settings-${name}`);
      expect(critical).toEqual([]);
    });

    test('case-detail /app/:org/problems/:case · a VIEWER reads, and a missing problem answers 404', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      await mockApi(page);
      const main = page.locator('#platform-main');
      await page.goto('/app/consultora-demo/problems/flujo-checkout');
      await expect(main.getByRole('heading', { level: 1, name: 'Flujo de checkout' })).toBeVisible();
      await expect(main.getByRole('note')).toContainText('You can read and compare versions. New versions need MEMBER; deleting needs ADMIN.');
      await expect(main.getByRole('button', { name: 'Upload new version' })).toHaveCount(0);
      await capture(page, testInfo, `viewer-${name}`);

      await page.goto(`${PROBLEMS}/ghost`);
      await expect(main.getByRole('heading', { name: 'No problem with this address in ISA Demo Group (404)' })).toBeVisible();
      await expect(main.getByRole('link', { name: 'All problems' })).toHaveAttribute('href', PROBLEMS);
      await capture(page, testInfo, `missing-${name}`);
      expect(critical).toEqual([]);
    });
  });
}
