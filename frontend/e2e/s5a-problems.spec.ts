import { readFileSync } from 'node:fs';
import JSZip from 'jszip';
import { expect as baseExpect, test, type Page, type Route, type TestInfo } from '@playwright/test';
import { failureBody } from './helpers/problems';
import { CURRENT_FIXTURE, catalogFixture } from '../src/pages/Pricing/pricingFixture';
import { checkoutFacts, compiledDocument, digestOf } from '../src/pages/Problems/fixtures';
import type { CompositionVersionView } from '../src/shared/api/types';

// S5a · the problems of an organization: problem-list (/app/:org/problems, filtered by origin and by linking composition) and the
// problem page problem-detail with its tabs Overview, Candidates, Versions, Runs, Compositions, Source and Settings. A problem is
// uploaded as a .bim.zip, a new version is another upload (or a save in the problem editor), and every version is the package exactly
// as it was uploaded with its compilation by the installed toolchain. A composition that links a version is highlighted on its
// candidates.
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

// --- problems, versions and compilations

interface Revision {
  id: string; problem_id: string; revision: number; package_digest: string; package_size: number; created_by_id: string; created_at: string;
}
type Origin = 'upload' | 'editor' | 'qacoforge';
interface ProblemRow {
  item: { id: string; organization_id: string; slug: string; name: string; description: string; created_by_id: string; created_at: string; updated_at: string };
  revisions: Revision[];
  /** Where its latest version came from. */
  origin: Origin;
}

const problemRow = (orgId: string, slug: string, name: string, description: string, revisions: Array<[number, string, string]>, origin: Origin = 'upload'): ProblemRow => ({
  origin,
  item: { id: `case-${slug}`, organization_id: orgId, slug, name, description, created_by_id: 'user-1', created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-01T00:00:00Z' },
  revisions: revisions.map(([revision, char, createdAt]) => ({
    id: `rev-${slug}-${revision}`, problem_id: `case-${slug}`, revision, package_digest: digestOf(char), package_size: 48_213, created_by_id: 'user-1', created_at: createdAt,
  })),
});

const checkout = (orgId: string, origin: Origin = 'upload') => problemRow(orgId, 'flujo-checkout', 'Flujo de checkout', 'Payments with parallel stock and shipping.', [
  [1, '1', '2026-08-01T09:00:00Z'], [2, '2', '2026-08-20T10:05:00Z'],
], origin);

const seedProblems = (): Record<string, ProblemRow[]> => ({
  'isa-demo': [checkout('org-1', 'editor'), problemRow('org-1', 'borrador', 'Borrador', '', [])],
  'consultora-demo': [checkout('org-3')],
});

/** How many candidates the payment task has in each version: what the facts of their compilations differ in. */
const PAY_OF: Record<number, number> = { 1: 5, 2: 8 };

const compilationOf = (revision: number) => ({
  id: `compilation-${revision}`, revision_id: `rev-${revision}`, compilation_digest: digestOf('9'), compiler_digest: digestOf('8'), ir_digest: digestOf('c'),
  binding_space: '125892', created_at: '2026-08-20T10:05:00Z', current: true, toolchain: {},
  analysis: { tasks: 6, candidates: 24, constraints: 2, placement: false, bindingSpace: '125892' },
  resources: { application: { role: 'application', path: 'application.json', apiVersion: 'qos-binding/v1', kind: 'Application' } },
  compatible_modes: [{ compatible: true }, { compatible: true }],
});

// --- a composition of isa-demo whose version 1.0.0 links flujo-checkout@2 (the gateway's FMS fixture, rebound to the checkout)

const COMPOSITION = { slug: 'fleet-plan', name: 'Fleet plan', version: 'fleet-plan-v1', label: '1.0.0' };
/** What 1.0.0 chose for each task of the checkout, as `EvaluationView.binding` writes it. */
const CHOSEN: Record<string, string> = {
  authenticate: 'providers/authenticate-2', inventory: 'providers/inventory-1', shipping: 'providers/shipping-3', 'pay-card': 'providers/pay-card-4', 'pay-transfer': 'providers/pay-transfer-1',
};

function compositionVersion(): CompositionVersionView {
  const fms = JSON.parse(readFileSync(new URL('../src/test/fixtures/core/fms.version.json', import.meta.url), 'utf8')) as CompositionVersionView;
  const [evaluation] = fms.evaluations;
  return {
    ...fms, id: COMPOSITION.version, label: COMPOSITION.label, document: null,
    problem: fms.problem && { ...fms.problem, problem: { id: 'case-flujo-checkout', slug: 'flujo-checkout', name: 'Flujo de checkout' }, revision: { id: 'rev-flujo-checkout-2', revision: 2 } },
    evaluations: [{ ...evaluation, compilation: evaluation.compilation && { ...evaluation.compilation, id: 'compilation-2' }, binding: CHOSEN }],
  };
}

const compositionView = (orgId: string) => ({
  id: 'composition-fleet-plan', slug: COMPOSITION.slug, name: COMPOSITION.name, description: '', kind: 'workflow', archived: false, visibility: 'private',
  organization: { id: orgId, slug: 'isa-demo', name: 'ISA Demo Group' }, created_by_id: 'user-1', created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z',
  version_count: 1, latest_version: { id: COMPOSITION.version, ordinal: 1, label: COMPOSITION.label, values_status: 'verified', verified: true, created_at: '2026-09-01T00:00:00Z' },
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

  await page.route(new RegExp(`^${API}/v1/organizations(/.*)?(\\?.*)?$`), async (route) => {
    const url = new URL(route.request().url());
    const parts = url.pathname.split('/').filter(Boolean);
    // /v1/organizations/{org}/problems/{problem}/revisions/{revision}/{tail}/{compilation}/{ir or facts}
    const [, , orgSlug, section, problemSlug, sub, revisionRef, tail] = parts;
    const method = route.request().method();
    const found = organizations.find((item) => item.slug === orgSlug);

    if (!orgSlug) return json(organizations)(route);
    if (!found) return detail(403, 'organization_forbidden', 'Not a member.')(route);
    if (section === 'members' || section === 'library') return json([])(route);
    if (section === 'runs') return json({ runs: [], total: 0 })(route);
    if (section === 'compositions') {
      // /v1/organizations/{org}/compositions[/{composition}[/versions/{version}]]: fleet-plan links checkout-flow@2 in isa-demo.
      const [, , , , compositionSlug, versions, versionRef] = parts;
      const pool = orgSlug === 'isa-demo' ? [compositionView(found.id)] : [];
      if (!compositionSlug) {
        const problem = url.searchParams.get('problem');
        const listed = pool.filter(() => !problem || problem === 'flujo-checkout');
        state.sent.compositions = url.searchParams.toString();
        return json({ compositions: listed, total: listed.length, limit: 200, offset: 0 })(route);
      }
      if (compositionSlug !== COMPOSITION.slug || pool.length === 0) return detail(404, 'not_found', 'Composition not found.')(route);
      if (!versions) return json(pool[0])(route);
      if (versionRef === COMPOSITION.version || versionRef === COMPOSITION.label) return json(compositionVersion())(route);
      return detail(404, 'not_found', 'Composition version not found.')(route);
    }
    if (section !== 'problems') return json(found)(route);

    const rows = state.problems[orgSlug] ?? [];
    const latest = (row: ProblemRow) => {
      const newest = [...row.revisions].sort((a, b) => b.revision - a.revision)[0];
      return newest ? { id: newest.id, revision: newest.revision, package_digest: newest.package_digest, created_at: newest.created_at, origin: row.origin } : null;
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
      // The gateway's filters: the origin of the latest version, and the problems a version of the composition links.
      const origin = url.searchParams.get('origin');
      const composition = url.searchParams.get('composition');
      const listed = rows
        .filter((row) => !origin || (row.revisions.length > 0 && row.origin === origin))
        .filter((row) => !composition || (composition === COMPOSITION.slug && row.item.slug === 'flujo-checkout'));
      return json({ problems: listed.map((row) => ({ ...row.item, latest_revision: latest(row) })), total: listed.length, limit: 200, offset: 0 })(route);
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
        state.sent.revision = url.searchParams.toString();
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
    // A compilation's facts (what the page draws), and its IR (bytes the source view shows and never reads).
    if (tail === 'compilations' && parts.at(-1) === 'facts') return json(checkoutFacts(PAY_OF[revision.revision] ?? 8))(route);
    if (tail === 'compilations') return json({ id: `compilation-${revision.revision}`, ir_digest: digestOf('c'), ir: compiledDocument(), source_map: {} })(route);
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

    test('problem-list /app/:org/problems · the problems of the organization, an upload and a delete', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      await page.goto(PROBLEMS);
      const main = page.locator('#platform-main');

      await expect(main.getByRole('heading', { level: 1, name: 'Problems' })).toBeVisible();
      const list = main.getByRole('list', { name: 'Problems' });
      await expect(list.getByRole('listitem')).toHaveCount(2);
      await expect(list.getByRole('link', { name: /Flujo de checkout/ })).toHaveAttribute('href', `${PROBLEMS}/flujo-checkout`);
      await expect(list.getByText('2 versions')).toBeVisible();
      await expect(list.getByRole('link', { name: 'Run latest' })).toHaveAttribute('href', '/app/isa-demo/runs/new?problem=flujo-checkout&revision=2');
      await expect(main.getByRole('link', { name: 'Write one in the problem editor' })).toHaveAttribute('href', '/app/isa-demo/problem-editor');
      await expect(main.getByRole('link', { name: 'Start from a template' })).toHaveAttribute('href', '/app/isa-demo/problem-editor?template=demo%2F01_simple_seq');
      await expect(main).not.toContainText(/sha256-|[0-9a-f]{12}/);
      await expect(list.getByRole('listitem').filter({ hasText: 'Flujo de checkout' }).getByText('Problem editor', { exact: true })).toBeVisible();
      await capture(page, testInfo, `list-${name}`);

      // The gateway narrows the list: by where the latest version came from, and to the problems a composition links.
      const origins = main.getByRole('group', { name: 'Origin of the latest version' });
      await origins.getByRole('button', { name: 'Uploaded' }).click();
      await expect(page).toHaveURL(new RegExp(`${PROBLEMS}\\?origin=upload$`));
      await expect(main.getByText('No problem matches these filters.')).toBeVisible();
      await origins.getByRole('button', { name: 'Problem editor' }).click();
      await expect(page).toHaveURL(new RegExp(`${PROBLEMS}\\?origin=editor$`));
      await expect(list.getByRole('listitem')).toHaveCount(1);
      await origins.getByRole('button', { name: 'All origins' }).click();
      await expect(list.getByRole('listitem')).toHaveCount(2);
      await main.getByRole('combobox', { name: 'Linked by composition' }).selectOption('fleet-plan');
      await expect(page).toHaveURL(new RegExp(`${PROBLEMS}\\?composition=fleet-plan$`));
      await expect(list.getByRole('listitem')).toHaveCount(1);
      await expect(list.getByRole('link', { name: /Flujo de checkout/ })).toBeVisible();
      await capture(page, testInfo, `list-${name}-filtered`);
      await page.goto(PROBLEMS);
      await expect(list.getByRole('listitem')).toHaveCount(2);

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
      expect(state.sent.create).toContain('producer=openbinding-upload');
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

    test('problem-detail /app/:org/problems/:case · overview, candidates, compositions, versions, source, settings and a new version', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      await page.goto(`${PROBLEMS}/flujo-checkout`);
      const main = page.locator('#platform-main');

      await expect(main.getByRole('heading', { level: 1, name: 'Flujo de checkout' })).toBeVisible();
      await expect(main.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
      await expect(main.getByRole('link', { name: 'Edit in the problem editor' })).toHaveAttribute('href', '/app/isa-demo/problem-editor?problem=flujo-checkout&revision=2');
      await expect(main.getByRole('link', { name: 'Run this version' })).toHaveAttribute('href', '/app/isa-demo/runs/new?problem=flujo-checkout&revision=2');
      const workflow = main.getByRole('region', { name: 'How the service works' });
      const drawing = workflow.getByRole('group', { name: 'Workflow' });
      await expect(drawing).toBeVisible();
      await expect(drawing).toHaveAccessibleDescription(/^Workflow: authenticate, then \(inventory and shipping in parallel\)/);
      await expect(drawing.getByRole('group', { name: 'Choice, 2 branches, probabilities 0.7, 0.3' })).toBeVisible();
      // The rules and objectives, each rule with the file the package writes it in.
      const rules = main.getByRole('region', { name: 'Rules and objectives' });
      await expect(rules.getByRole('list', { name: 'Rules of this version' })).toContainText('features.latency ≤ 600');
      await expect(rules.getByRole('list', { name: 'Rules of this version' })).toContainText('written in rules.json at /spec/constraints/sla-latency');
      await expect(rules.getByRole('list', { name: 'What breaking a soft rule costs' })).toContainText('costs weight 5');
      await expect(main.getByRole('region', { name: 'Resources it’s built from' })).toHaveCount(0);
      await capture(page, testInfo, `overview-${name}`);

      // The candidates: a table per task on a desktop, a card per candidate on a phone.
      await main.getByRole('tab', { name: 'Candidates' }).click();
      await expect(page).toHaveURL(new RegExp(`${PROBLEMS}/flujo-checkout/candidates`));
      const candidates = main.getByRole('region', { name: 'Candidates of each task' });
      const authenticate = (written: string) => (isMobile
        ? candidates.getByRole('list', { name: 'Candidates for authenticate' }).getByRole('listitem').filter({ hasText: written })
        : candidates.getByRole('table', { name: /Task authenticate · 4 candidates/ }).getByRole('row', { name: new RegExp(written) }));
      await expect(authenticate('authenticate-2')).toBeVisible();
      await expect(authenticate('authenticate-2')).not.toHaveAttribute('aria-current', 'true');
      await capture(page, testInfo, `candidates-${name}`);

      // The compositions that link it: one, whose choice shows on the candidates, with a way back to it.
      await main.getByRole('tab', { name: 'Compositions' }).click();
      const linking = main.getByRole('region', { name: 'Compositions that link this problem' });
      await expect(linking.getByRole('link', { name: 'Fleet plan', exact: true })).toHaveAttribute('href', '/app/isa-demo/compositions/fleet-plan');
      await expect(linking.getByRole('list', { name: 'Values of Fleet plan 1.0.0' })).toContainText('3,060 USD/month');
      expect(state.sent.compositions).toContain('problem=flujo-checkout');
      await capture(page, testInfo, `compositions-${name}`);
      await linking.getByRole('link', { name: 'Show Fleet plan 1.0.0 on the problem' }).click();
      await expect(page).toHaveURL(new RegExp(`${PROBLEMS}/flujo-checkout/candidates\\?version=2&composition=fleet-plan&compositionVersion=1\\.0\\.0$`));
      await expect(main.getByText(/The candidates Fleet plan 1\.0\.0 chose are selected/)).toBeVisible();
      await expect(authenticate('authenticate-2')).toHaveAttribute('aria-current', 'true');
      await expect(authenticate('authenticate-1')).not.toHaveAttribute('aria-current', 'true');
      await expect(main.getByRole('link', { name: 'Back to Fleet plan 1.0.0' })).toHaveAttribute('href', '/app/isa-demo/compositions/fleet-plan?version=1.0.0');
      await capture(page, testInfo, `candidates-${name}-highlight`);

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

    test('problem-detail /app/:org/problems/:case · a VIEWER reads, and a missing problem answers 404', async ({ page }, testInfo) => {
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
