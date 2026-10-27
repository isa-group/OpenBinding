import JSZip from 'jszip';
import { expect as baseExpect, test, type Page, type Route, type TestInfo } from '@playwright/test';
import { failureBody } from './helpers/problems';
import { CURRENT_FIXTURE, catalogFixture } from '../src/pages/Pricing/pricingFixture';
import { digestOf, irDocument, refOf, revisionDocument, sourceContents } from '../src/pages/Cases/fixtures';

// S5a · authoring and cases, part 1: case-list, case-detail, case-revision, case-compare, snap-detail.
// There is no backend: the API origin is answered by page.route(). Screenshots go to testInfo.outputPath()
// (test-results/, ignored by git) so they can be looked at after a run.
// One test per screen and viewport: the desktop walks the states of the screen, the phone gets its layout and its dialogs.

const API = 'http://localhost:8000';

// Several browsers share one development server, so a screen can take longer than the default five seconds to settle.
const expect = baseExpect.configure({ timeout: 15_000 });

type Handler = (route: Route) => Promise<void> | void;
const json = (body: unknown, status = 200): Handler => (route) => route.fulfill({ status, json: body });
const detail = (status: number, code: string, error: string, extra: Record<string, unknown> = {}): Handler => json(failureBody(status, code, error, extra), status);
const noContent: Handler = (route) => route.fulfill({ status: 204 });
/** A service that does not answer: a 503 with no machine code, as a proxy in front of the gateway would send it. */
const unavailable: Handler = json({ detail: 'The service is not reachable.' }, 503);

const token = (expiresInSeconds: number) => [
  'header',
  Buffer.from(JSON.stringify({ sub: 'user-1', exp: Math.floor(Date.now() / 1000) + expiresInSeconds })).toString('base64'),
  'signature',
].join('.');

const lucia = {
  id: 'user-1', username: 'lucia.vega', email: 'lucia@example.org', role: 'user', is_active: true, plan: 'RESEARCH',
  created_at: '2026-03-02T00:00:00Z', cas_verified: true, institutional_branding: true,
};

type Role = 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER';

const org = (n: number, slug: string, name: string, role: Role, sponsor = 'user-1') => ({
  id: `org-${n}`, slug, name, parent_id: null, billing_sponsor_user_id: sponsor, effective_role: role, created_at: '2026-03-03T00:00:00Z',
});

const organizations = [
  org(1, 'isa-demo', 'ISA Demo Group', 'ADMIN'),
  org(3, 'consultora-demo', 'Consultora Demo', 'VIEWER', 'user-nora'),
  org(4, 'member-lab', 'Member Lab', 'MEMBER', 'user-nora'),
];

const project = (n: number, orgId: string, slug: string, name: string, visibility: 'public' | 'private' = 'private') => ({
  id: `project-${n}`, organization_id: orgId, slug, name, description: '', visibility, created_by_id: 'user-1',
  created_at: '2026-04-01T00:00:00Z', updated_at: '2026-10-08T00:00:00Z',
  // The contract's `ProjectView.access`: these specs reach every project as a member.
  access: 'member' as const, effective_role: 'OWNER' as Role,
});

const projectsOf: Record<string, ReturnType<typeof project>[]> = {
  'isa-demo': [project(1, 'org-1', 'qos-benchmarks', 'QoS Benchmarks', 'public'), project(2, 'org-1', 'checkout-privado', 'Checkout (privado)')],
  'consultora-demo': [project(3, 'org-3', 'client-case', 'Client case')],
  'member-lab': [project(4, 'org-4', 'bench', 'Bench')],
};

// --- cases, revisions, library and snapshots

const S1 = '00000000-0000-4000-8000-0000000000e0';
const S2 = '00000000-0000-4000-8000-0000000000e1';
const S3 = '00000000-0000-4000-8000-0000000000e2';

const app3 = refOf('checkout-app', '3', '1');
const catalog2 = refOf('providers-eu', '2', '2');
const catalog3 = refOf('providers-eu', '3', '3');
const rules1 = refOf('sla-hard', '1', '4');
const goal1 = refOf('weighted-cost-latency', '1', '5');
const documentWith = (catalog: typeof catalog2) => revisionDocument([
  ['application', 'checkout', app3], ['candidateCatalog', 'providers', catalog], ['constraintSet', 'sla', rules1], ['optimization', 'goal', goal1],
]);

interface Revision {
  id: string; binding_case_id: string; revision: number; digest: string; document: Record<string, unknown>; source_snapshot_id: string | null; created_at: string;
}
interface CaseRow {
  item: { id: string; project_id: string; slug: string; name: string; description: string; created_by_id: string; created_at: string };
  revisions: Revision[];
}

const caseRow = (projectId: string, slug: string, name: string, description: string, revisions: Array<[number, string, ReturnType<typeof documentWith>, string | null, string]>): CaseRow => ({
  item: { id: `case-${slug}`, project_id: projectId, slug, name, description, created_by_id: 'user-1', created_at: '2026-08-01T00:00:00Z' },
  revisions: revisions.map(([revision, char, document, snapshot, createdAt]) => ({
    id: `rev-${slug}-${revision}`, binding_case_id: `case-${slug}`, revision, digest: digestOf(char), document, source_snapshot_id: snapshot, created_at: createdAt,
  })),
});

const checkoutRevisions = (projectId: string, slug = 'flujo-checkout') => caseRow(projectId, slug, 'Flujo de checkout', 'Payments with parallel stock and shipping.', [
  [1, '1', documentWith(catalog2), S1, '2026-08-01T09:00:00Z'], [2, '2', documentWith(catalog3), S2, '2026-08-20T10:05:00Z'],
]);

const seedCases = (): Record<string, CaseRow[]> => ({
  'isa-demo/qos-benchmarks': [checkoutRevisions('project-1'), caseRow('project-1', 'borrador', 'Borrador', '', [])],
  'isa-demo/checkout-privado': [],
  'consultora-demo/client-case': [checkoutRevisions('project-3')],
  'member-lab/bench': [checkoutRevisions('project-4')],
});

const artifact = (id: string, name: string, kind: string, display: string) => ({
  id, organization_id: 'org-1', namespace: 'isa-demo', name, display_name: display, kind, description: '', labels: {}, archived: false,
});
const libraryItems = [
  artifact('art-app', 'checkout-app', 'Application', 'Checkout app'), artifact('art-cat', 'providers-eu', 'CandidateCatalog', 'Proveedores UE'),
  artifact('art-rules', 'sla-hard', 'ConstraintSet', 'SLA hard'), artifact('art-goal', 'weighted-cost-latency', 'Optimization', 'Weighted cost and latency'),
];
const ARTIFACT_OF: Record<string, string> = { 'checkout-app': 'art-app', 'providers-eu': 'art-cat', 'sla-hard': 'art-rules', 'weighted-cost-latency': 'art-goal' };
const CONTENT_OF: Record<string, unknown> = { 'art-app': sourceContents.application, 'art-cat': sourceContents.catalog, 'art-rules': sourceContents.rules, 'art-goal': sourceContents.goal };

const versionView = (ref: { namespace: string; name: string; version: string; versionDigest: string }) => ({
  id: `version-${ARTIFACT_OF[ref.name]}-${ref.version}`, artifact_id: ARTIFACT_OF[ref.name], ordinal: Number(ref.version), ref, contentDigest: digestOf('c'),
  manifest: { mediaType: 'application/json', contracts: [], dependencies: [] }, based_on_id: null, public: ref.name === 'providers-eu' && ref.version === '3', withdrawn: false,
  created_at: '2026-08-01T00:00:00Z',
});
const versionsOf = (id: string) => (id === 'art-cat' ? [catalog3, catalog2] : [{ 'art-app': app3, 'art-rules': rules1, 'art-goal': goal1 }[id]!]).map(versionView);
const refMatching = (body: { name: string; version: string }) => [app3, catalog2, catalog3, rules1, goal1].find((ref) => ref.name === body.name && ref.version === body.version);

const snapshotView = (id: string, pay: number) => ({
  id, ownerId: 'user-1', instanceDigest: digestOf('a'), packageDigest: digestOf('b'), archiveSize: 48_213, createdAt: '2026-08-20T10:05:00Z',
  ir: { id: `ir-${id}`, digest: digestOf('c'), document: irDocument(pay), sourceMap: null, compilerVersion: '1.0.0', createdAt: '2026-08-20T10:05:00Z' },
});
const SNAPSHOTS: Record<string, number> = { [S1]: 5, [S2]: 8, [S3]: 8 };

const researchUsage = (ceiling: number | null = 20) => ({
  plan: 'RESEARCH',
  contract_pending: false,
  features: { collaboration: true, solve: true },
  capabilities: { concurrentJobs: 3, projects: 50, privateProjects: 30, maxPayloadBytes: 134_217_728, maxInstanceComplexityLog10: ceiling },
});

type Refusable = 'cases' | 'createCase' | 'patchCase' | 'deleteCase' | 'revision' | 'snapshot' | 'resolve' | 'validate' | 'archive';

interface State {
  cases: Record<string, CaseRow[]>;
  ceiling: number | null;
  /** A refusal for one call; unset means it succeeds. */
  refuse: Partial<Record<Refusable, Handler>>;
  /** The last body each write carried, to check what was sent. */
  sent: Record<string, unknown>;
}

const methodOf = (route: Route) => route.request().method();
const bodyOf = (route: Route) => route.request().postDataJSON() as Record<string, unknown>;

/** Everything these screens read and write, answered; anything else on the API origin is an empty 404. */
async function mockApi(page: Page, overrides: Partial<State> = {}): Promise<State> {
  const state: State = { cases: seedCases(), ceiling: 20, refuse: {}, sent: {}, ...overrides };
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
  await page.route(`${API}/v1/users/me/usage`, (route) => route.fulfill({ json: researchUsage(state.ceiling) }));
  await page.route(new RegExp(`^${API}/v1/notifications(\\?.*)?$`), json([]));
  await page.route(`${API}/v1/profiles`, json({ profiles: [{ id: 'qos-binding/v1', digest: digestOf('a'), metadata: { name: 'qos-binding', version: '1.0.0' } }] }));

  await page.route(new RegExp(`^${API}/v1/organizations(/.*)?(\\?.*)?$`), async (route) => {
    const parts = new URL(route.request().url()).pathname.split('/').filter(Boolean);
    // /v1/organizations/{org}/projects/{project}/{sub}/{subId}/{subSub}/{subSubId}
    const [, , orgSlug, section, projectSlug, sub, subId, subSub, subSubId] = parts;
    const method = methodOf(route);
    const found = organizations.find((item) => item.slug === orgSlug);

    if (!orgSlug) return json(organizations)(route);
    if (section === 'members') return json([])(route);
    if (section !== 'projects') return json(found ?? { detail: { code: 'not_found', error: 'Organization not found.' } }, found ? 200 : 404)(route);

    const list = projectsOf[orgSlug] ?? [];
    if (!projectSlug) return json(list)(route);
    const current = list.find((item) => item.slug === projectSlug);
    if (!current) return detail(404, 'not_found', 'Project not found.')(route);
    if (!sub) return json(current)(route);

    const key = `${orgSlug}/${projectSlug}`;
    const rows = state.cases[key] ?? [];
    if (sub !== 'cases') return json([])(route);

    if (!subId) {
      if (method === 'POST') {
        if (state.refuse.createCase) return state.refuse.createCase(route);
        const body = bodyOf(route) as { slug: string; name: string; description: string };
        const created = { id: `case-${body.slug}`, project_id: current.id, slug: body.slug, name: body.name, description: body.description, created_by_id: 'user-1', created_at: '2026-10-09T08:00:00Z' };
        state.cases[key] = [...rows, { item: created, revisions: [] }];
        return json(created, 201)(route);
      }
      return state.refuse.cases ? state.refuse.cases(route) : json(rows.map((row) => row.item))(route);
    }

    const row = rows.find((candidate) => candidate.item.slug === subId);
    if (!row) return detail(404, 'not_found', 'Binding case not found.')(route);
    if (!subSub) {
      if (method === 'PATCH') {
        if (state.refuse.patchCase) return state.refuse.patchCase(route);
        state.sent.patch = bodyOf(route);
        row.item = { ...row.item, ...(bodyOf(route) as object) };
        return json(row.item)(route);
      }
      if (method === 'DELETE') {
        if (state.refuse.deleteCase) return state.refuse.deleteCase(route);
        if (row.revisions.length > 0) return detail(409, 'historical_references', 'A case with sealed revisions cannot be deleted.')(route);
        state.cases[key] = rows.filter((candidate) => candidate !== row);
        return noContent(route);
      }
      return json(row.item)(route);
    }

    if (subSub !== 'revisions') return detail(404, 'not_found', 'Not mocked.')(route);
    if (subSubId) {
      const revision = row.revisions.find((candidate) => String(candidate.revision) === subSubId);
      return revision ? json(revision)(route) : detail(404, 'not_found', 'Binding case revision not found.')(route);
    }
    if (method === 'POST') {
      if (state.refuse.revision) return state.refuse.revision(route);
      state.sent.revision = bodyOf(route);
      const next = row.revisions.length + 1;
      // The gateway stores the Instance with the exact library versions it was built from.
      const uses = (bodyOf(route) as { resources: Array<{ role: string; alias: string; artifact: typeof app3 }> }).resources;
      const created: Revision = {
        id: `rev-${row.item.slug}-${next}`, binding_case_id: row.item.id, revision: next, digest: digestOf(String(next + 2)),
        document: revisionDocument(uses.map((use): [string, string, typeof app3] => [use.role, use.alias, use.artifact])),
        source_snapshot_id: S3, created_at: '2026-10-09T09:00:00Z',
      };
      row.revisions = [...row.revisions, created];
      return json(created, 201)(route);
    }
    return json(row.revisions)(route);
  });

  // The library of an organization and the versions behind it.
  await page.route(new RegExp(`^${API}/v1/organizations/[^/]+/library(\\?.*)?$`), json(libraryItems));
  await page.route(new RegExp(`^${API}/v1/artifacts/[^/]+/versions(\\?.*)?$`), (route) => {
    const id = new URL(route.request().url()).pathname.split('/')[3];
    return json(versionsOf(id))(route);
  });
  await page.route(new RegExp(`^${API}/v1/artifacts/[^/]+/versions/[^/]+/content(\\?.*)?$`), (route) => {
    const id = new URL(route.request().url()).pathname.split('/')[3];
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(CONTENT_OF[id]) });
  });
  await page.route(`${API}/v1/artifacts/resolve`, (route) => {
    if (state.refuse.resolve) return state.refuse.resolve(route);
    const ref = refMatching(bodyOf(route) as { name: string; version: string });
    return ref ? json(versionView(ref))(route) : detail(404, 'not_found', 'Artifact version not found.')(route);
  });

  // Snapshots.
  await page.route(new RegExp(`^${API}/v1/snapshots/[^/]+$`), (route) => {
    if (state.refuse.snapshot) return state.refuse.snapshot(route);
    const id = new URL(route.request().url()).pathname.split('/')[3];
    return SNAPSHOTS[id] ? json(snapshotView(id, SNAPSHOTS[id]))(route) : detail(404, 'not_found', 'Snapshot not found')(route);
  });
  await page.route(new RegExp(`^${API}/v1/snapshots/[^/]+/archive$`), (route) => (state.refuse.archive ? state.refuse.archive(route) : route.fulfill({ status: 200, contentType: 'application/zip', body: zip })));
  await page.route(new RegExp(`^${API}/v1/instances/[^/]+$`), (route) => {
    const id = new URL(route.request().url()).pathname.split('/')[3];
    return json({
      id, kind: 'InstanceSnapshot', instanceDigest: digestOf('a'), packageDigest: digestOf('b'), irDigest: digestOf('c'),
      fileDigests: { 'instance.json': digestOf('1'), 'application.json': digestOf('2') }, resourceDigests: { app: digestOf('3') }, instance: {}, createdAt: '2026-08-20T10:05:00Z',
    })(route);
  });
  await page.route(new RegExp(`^${API}/v1/instances/[^/]+/source$`), (route) => route.fulfill({ status: 200, contentType: 'application/vnd.bim+zip', body: zip }));
  await page.route(new RegExp(`^${API}/v1/instances/[^/]+/ir$`), json(irDocument(8)));
  await page.route(`${API}/v1/validate`, (route) => {
    if (state.refuse.validate) return state.refuse.validate(route);
    return json({
      valid: true, instanceDigest: digestOf('a'), packageDigest: digestOf('b'), irDigest: digestOf('c'),
      analysis: { tasks: 6, candidates: 24, constraints: 2, placement: false, bindingSpace: '1920' }, compatibleModes: [{}, {}, {}],
    })(route);
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
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, `${name} should not scroll sideways`).toBeLessThanOrEqual(1);
}

const request = (page: Page, method: string, path: string) => page.waitForRequest((candidate) => candidate.method() === method && candidate.url().startsWith(`${API}${path}`));

// Each test walks a screen through its states while the dev server compiles on demand.
test.setTimeout(120_000);
// One worker for the whole file: with every test in parallel the browsers starve each other and the same walk takes twice as long.
test.describe.configure({ mode: 'default' });
const viewports = [
  { name: 'desktop', viewport: { width: 1440, height: 900 }, isMobile: false, deviceScaleFactor: 1 },
  { name: 'mobile', viewport: { width: 390, height: 844 }, isMobile: true, deviceScaleFactor: 2 },
] as const;

const ROOT = '/app/isa-demo/qos-benchmarks';
const CASE = `${ROOT}/cases/flujo-checkout`;

for (const { name, viewport, isMobile, deviceScaleFactor } of viewports) {
  test.describe(`${name} · S5a cases`, () => {
    test.use({ viewport, isMobile, deviceScaleFactor });

    test('case-list /app/:org/:project/cases', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      await page.goto(`${ROOT}/cases`);
      const main = page.locator('#platform-main');

      await expect(main.getByRole('heading', { level: 1, name: 'Cases' })).toBeVisible();
      const list = main.getByRole('list', { name: 'Cases' });
      await expect(list.getByRole('listitem')).toHaveCount(2);
      await expect(list.getByRole('link', { name: /Flujo de checkout/ })).toHaveAttribute('href', CASE);
      await expect(list.getByText('Ready to run')).toBeVisible();
      await expect(list.getByText('No revision yet')).toBeVisible();
      await expect(list.getByText('2 revisions')).toBeVisible();
      await expect(main.getByRole('navigation', { name: 'Project sections' }).getByRole('link', { name: 'Cases' })).toHaveAttribute('aria-current', 'page');
      await capture(page, testInfo, `list-${name}-success`);

      // The dialog of a new case, with the address suggested from the name and the gateway's 409.
      await main.getByRole('button', { name: 'New case' }).click();
      const dialog = page.getByRole('dialog', { name: 'New case' });
      await dialog.getByLabel('Name', { exact: true }).fill('Análisis de latencia');
      await expect(dialog.getByLabel('Address')).toHaveValue('analisis-de-latencia');
      state.refuse.createCase = detail(409, 'slug_conflict', 'That case slug is in use.');
      await dialog.getByRole('button', { name: 'Create case' }).click();
      await expect(dialog.getByRole('alert')).toContainText('That address is already used by another case in this project (409 · slug_conflict).');
      await capture(page, testInfo, `list-${name}-dialog-409`);
      if (isMobile) {
        expect(critical).toEqual([]);
        return;
      }

      state.refuse.createCase = undefined;
      const posted = request(page, 'POST', '/v1/organizations/isa-demo/projects/qos-benchmarks/cases');
      await dialog.getByRole('button', { name: 'Create case' }).click();
      expect((await posted).postDataJSON()).toEqual({ slug: 'analisis-de-latencia', name: 'Análisis de latencia', description: '' });
      await expect(main.getByText('Case “Análisis de latencia” created. Compose its first revision when you’re ready.')).toBeVisible();
      await expect(main.getByRole('link', { name: 'Compose its first revision' })).toHaveAttribute('href', `${ROOT}/workbench?case=analisis-de-latencia`);
      await expect(list.getByRole('listitem')).toHaveCount(3);
      await capture(page, testInfo, `list-${name}-created`);

      // Search narrows the list.
      await main.getByLabel('Search cases').fill('borra');
      await expect(list.getByRole('listitem')).toHaveCount(1);
      await main.getByLabel('Search cases').fill('');

      // An ADMIN deletes: a case with sealed revisions is refused up front, an empty one goes after typing its address.
      await list.getByRole('button', { name: 'Delete Flujo de checkout' }).click();
      const sealed = page.getByRole('dialog', { name: 'Delete Flujo de checkout?' });
      await expect(sealed.getByText(/2 sealed revisions, so it can’t be deleted/)).toBeVisible();
      await expect(sealed.getByRole('button', { name: 'Delete case' })).toBeDisabled();
      await capture(page, testInfo, `list-${name}-delete-sealed`);
      await sealed.getByRole('button', { name: 'Cancel' }).click();
      await list.getByRole('button', { name: 'Delete Borrador' }).click();
      const empty = page.getByRole('dialog', { name: 'Delete Borrador?' });
      await empty.getByLabel('Type borrador to confirm').fill('borrador');
      const deleted = request(page, 'DELETE', '/v1/organizations/isa-demo/projects/qos-benchmarks/cases/borrador');
      await empty.getByRole('button', { name: 'Delete case' }).click();
      await deleted;
      await expect(main.getByText('Case “Borrador” deleted.')).toBeVisible();
      await expect(list.getByRole('listitem')).toHaveCount(2);

      // A VIEWER reads and compares, and has no buttons that write.
      await page.goto('/app/consultora-demo/client-case/cases');
      await expect(main.getByRole('note')).toContainText('You’re a VIEWER. You can open and compare cases here; creating and editing need MEMBER.');
      await expect(main.getByRole('button', { name: 'New case' })).toHaveCount(0);
      await expect(main.getByRole('button', { name: /^Delete/ })).toHaveCount(0);
      await expect(main.getByRole('link', { name: 'New revision' })).toHaveCount(0);
      await capture(page, testInfo, `list-${name}-viewer`);

      // A project with no case explains how to start.
      await page.goto('/app/isa-demo/checkout-privado/cases');
      const guide = main.getByRole('region', { name: 'No cases yet' });
      await expect(guide.getByRole('link', { name: 'Import an example' })).toHaveAttribute('href', '/examples');
      await expect(guide.getByRole('link', { name: 'Open the library' })).toHaveCount(0);
      await capture(page, testInfo, `list-${name}-empty`);

      // The list fails and comes back.
      state.refuse.cases = unavailable;
      await page.goto(`${ROOT}/cases`);
      await expect(main.getByRole('alert')).toContainText('Cases couldn’t be loaded (503)');
      await capture(page, testInfo, `list-${name}-error`);
      state.refuse.cases = undefined;
      await main.getByRole('button', { name: 'Retry' }).click();
      await expect(list.getByRole('listitem')).toHaveCount(2);

      // A project the account is not in reads like one that is missing.
      await page.goto('/app/isa-demo/ghost/cases');
      await expect(main.getByRole('heading', { name: 'Project not found' })).toBeVisible();
      expect(critical).toEqual([]);
    });

    test('case-detail /app/:org/:project/cases/:case', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      await page.goto(CASE);
      const main = page.locator('#platform-main');

      await expect(main.getByRole('heading', { level: 1, name: 'Flujo de checkout' })).toBeVisible();
      await expect(main.getByText('Payments with parallel stock and shipping.')).toBeVisible();
      const timeline = main.getByRole('region', { name: 'Revisions' });
      await expect(timeline.getByRole('link', { name: /^Revision \d$/ })).toHaveText(['Revision 2', 'Revision 1']);
      await expect(timeline.getByText('Candidate catalog · providers: providers-eu v2 → providers-eu v3')).toBeVisible();
      await expect(timeline.getByText('First revision.')).toBeVisible();
      const glance = main.getByRole('region', { name: 'Latest revision at a glance' });
      await expect(glance.getByRole('img', { name: /^Workflow: authenticate, then inventory and shipping in parallel/ })).toBeVisible();
      await expect(glance.getByRole('list', { name: 'Latest revision figures' }).getByRole('listitem')).toHaveCount(4);
      await expect(main.getByRole('link', { name: 'New revision' })).toHaveAttribute('href', `${ROOT}/workbench?case=flujo-checkout`);
      await expect(main.getByRole('link', { name: 'Compare revisions' })).toHaveAttribute('href', `${CASE}/compare`);
      await expect(main.getByRole('link', { name: 'Run latest' })).toHaveAttribute('href', `${ROOT}/jobs/new?case=flujo-checkout&revision=2`);
      await capture(page, testInfo, `detail-${name}-success`);

      // A case without revisions points to the workbench.
      await page.goto(`${ROOT}/cases/borrador`);
      const guide = main.getByRole('region', { name: 'No revisions yet' });
      await expect(guide.getByRole('link', { name: 'Compose the first revision' })).toHaveAttribute('href', `${ROOT}/workbench?case=borrador`);
      await capture(page, testInfo, `detail-${name}-empty`);
      if (isMobile) {
        expect(critical).toEqual([]);
        return;
      }

      // The description is edited in place and saved.
      await page.goto(CASE);
      await main.getByRole('button', { name: 'Edit description' }).click();
      await main.getByLabel('Description', { exact: true }).fill('Catalog grown from 5 to 8 candidates.');
      await capture(page, testInfo, `detail-${name}-editing`);
      await main.getByRole('button', { name: 'Save' }).click();
      await expect(main.getByText('Description saved.')).toBeVisible();
      await expect(main.getByText('Catalog grown from 5 to 8 candidates.')).toBeVisible();
      expect(state.sent.patch).toEqual({ description: 'Catalog grown from 5 to 8 candidates.' });

      // Deleting is for an ADMIN, and a case that holds sealed revisions says why it can't go.
      await main.getByRole('button', { name: 'Delete case' }).click();
      const sealed = page.getByRole('dialog', { name: 'Delete Flujo de checkout?' });
      await expect(sealed.getByText(/2 sealed revisions, so it can’t be deleted/)).toBeVisible();
      await expect(sealed.getByRole('button', { name: 'Delete case' })).toBeDisabled();
      await capture(page, testInfo, `detail-${name}-delete-sealed`);
      await sealed.getByRole('button', { name: 'Cancel' }).click();

      // An empty case is deleted and the list takes its place.
      await page.goto(`${ROOT}/cases/borrador`);
      await main.getByRole('button', { name: 'Delete case' }).click();
      const dialog = page.getByRole('dialog', { name: 'Delete Borrador?' });
      await dialog.getByLabel('Type borrador to confirm').fill('borrador');
      await dialog.getByRole('button', { name: 'Delete case' }).click();
      await expect(page).toHaveURL(`${ROOT}/cases`);
      await expect(main.getByText('Case “Borrador” deleted.')).toBeVisible();

      // A VIEWER reads: no new revision, no editing.
      await page.goto('/app/consultora-demo/client-case/cases/flujo-checkout');
      await expect(main.getByRole('note')).toContainText('You can read and compare revisions. New revisions need MEMBER; deleting needs ADMIN.');
      await expect(main.getByRole('link', { name: 'New revision' })).toHaveCount(0);
      await expect(main.getByRole('button', { name: 'Edit description' })).toHaveCount(0);
      await capture(page, testInfo, `detail-${name}-viewer`);

      // A case that isn't there.
      await page.goto(`${ROOT}/cases/ghost`);
      await expect(main.getByRole('heading', { name: 'No case with this address in QoS Benchmarks (404)' })).toBeVisible();
      await expect(main.getByRole('link', { name: 'All cases' })).toHaveAttribute('href', `${ROOT}/cases`);
      await capture(page, testInfo, `detail-${name}-404`);
      expect(critical).toEqual([]);
    });

    test('case-revision /app/:org/:project/cases/:case/revisions/:revision', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      await page.goto(`${CASE}/revisions/2`);
      const main = page.locator('#platform-main');

      await expect(main.getByRole('heading', { level: 1, name: 'Flujo de checkout · revision 2' })).toBeVisible();
      await expect(main.getByText('Sealed', { exact: true }).first()).toBeVisible();
      const workflow = main.getByRole('region', { name: 'How the service works' });
      const drawing = workflow.getByRole('img', { name: /^Workflow: authenticate, then inventory and shipping in parallel/ });
      await expect(drawing).toBeVisible();
      await expect(drawing.getByText('70%')).toBeVisible();
      await expect(drawing.getByText('local task · not bound')).toBeVisible();
      const providers = main.getByRole('region', { name: 'Candidates' });
      await expect(providers.getByRole('row')).toHaveCount(1 + 4);
      await expect(main.getByRole('region', { name: 'Rules' }).getByText('MUST')).toBeVisible();
      await expect(main.getByRole('region', { name: 'Goal' }).getByText('lower is better').first()).toBeVisible();
      await expect(main.getByText(/not declared in this revision \(no pools, network or events\)/)).toBeVisible();
      const resources = main.getByRole('region', { name: 'Resources it’s built from' });
      const catalogCard = resources.getByRole('listitem').filter({ hasText: /Candidate catalog.*providers-eu v3/ });
      await expect(catalogCard).toContainText('Published');
      await expect(catalogCard).not.toContainText(/open in library/i);
      await expect(resources.getByRole('link')).toHaveCount(0);
      await expect(main.getByRole('link', { name: 'Compare' })).toHaveAttribute('href', `${CASE}/compare?from=1&to=2`);
      await expect(main.getByRole('link', { name: 'Open snapshot' })).toHaveAttribute('href', `${ROOT}/snapshots/${S2}`);
      await capture(page, testInfo, `revision-${name}-success`);
      if (isMobile) {
        expect(critical).toEqual([]);
        return;
      }

      // The task whose providers are listed can be changed.
      await providers.getByLabel('Task').selectOption('pay-card');
      await expect(providers.getByRole('row')).toHaveCount(1 + 8);

      // Another revision of the same case.
      await main.getByLabel('Show revision').selectOption('1');
      await expect(main.getByRole('heading', { level: 1, name: 'Flujo de checkout · revision 1' })).toBeVisible();
      await expect(page).toHaveURL(`${CASE}/revisions/1`);

      // The compiled form and the resources can't be loaded: the identity stays, the model says it may be incomplete.
      state.refuse.snapshot = unavailable;
      state.refuse.resolve = detail(404, 'not_found', 'Artifact version not found.');
      await page.goto(`${CASE}/revisions/2`);
      await expect(main.getByText(/Some resources of this revision couldn’t be loaded right now, so the model below may be incomplete/)).toBeVisible();
      await expect(main.getByText('The fingerprint and identity are still exact.')).toBeVisible();
      await expect(main.getByText(/The compiled form couldn’t be read \(503\)/)).toBeVisible();
      await capture(page, testInfo, `revision-${name}-unresolved`);

      // A revision that doesn't exist.
      await page.goto(`${CASE}/revisions/9`);
      await expect(main.getByRole('heading', { name: 'This revision doesn’t exist (404)' })).toBeVisible();
      await expect(main.getByRole('link', { name: 'See all revisions' })).toHaveAttribute('href', CASE);
      await capture(page, testInfo, `revision-${name}-404`);
      expect(critical).toEqual([]);
    });

    test('case-compare /app/:org/:project/cases/:case/compare', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      await mockApi(page);
      await page.goto(`${CASE}/compare`);
      const main = page.locator('#platform-main');

      await expect(main.getByRole('heading', { level: 1, name: 'Compare revisions' })).toBeVisible();
      await expect(main.getByRole('combobox', { name: 'From', exact: true })).toHaveValue('1');
      await expect(main.getByRole('combobox', { name: 'To', exact: true })).toHaveValue('2');
      const table = main.getByRole('table');
      await expect(table.getByRole('row', { name: /Candidates for pay-card/ }).getByRole('cell')).toHaveText(['5', '8', 'Changed']);
      const summary = main.getByRole('region', { name: 'Summary' });
      await expect(summary.getByRole('button', { name: /^All changes/ })).toContainText('4');
      await expect(summary.getByRole('button', { name: /^Providers/ })).toContainText('3');
      await expect(main.getByText('≈ 3.2× more combinations (10^0.5)')).toBeVisible();
      await capture(page, testInfo, `compare-${name}-success`);

      // A category narrows the table.
      await summary.getByRole('button', { name: /^Providers/ }).click();
      await expect(summary.getByRole('button', { name: /^Providers/ })).toHaveAttribute('aria-pressed', 'true');
      await expect(table.getByRole('row', { name: /Workflow/ })).toHaveCount(0);
      await capture(page, testInfo, `compare-${name}-filtered`);
      if (isMobile) {
        expect(critical).toEqual([]);
        return;
      }

      // Swapped, the second revision is the smaller one.
      await main.getByRole('button', { name: 'Swap revisions' }).click();
      await expect(main.getByRole('combobox', { name: 'From', exact: true })).toHaveValue('2');
      await expect(main.getByText('≈ 3.2× fewer combinations (10^0.5)')).toBeVisible();

      // The same revision on both sides has nothing to compare.
      await page.goto(`${CASE}/compare?from=2&to=2`);
      await expect(main.getByText('Both sides are the same revision, so there’s nothing to compare. Choose two different revisions.')).toBeVisible();
      await capture(page, testInfo, `compare-${name}-same`);

      // A revision that doesn't exist.
      await page.goto(`${CASE}/compare?from=1&to=7`);
      await expect(main.getByRole('alert')).toContainText('One of these revisions doesn’t exist (404). Pick another pair.');
      await capture(page, testInfo, `compare-${name}-404`);

      // A case that isn't there.
      await page.goto(`${ROOT}/cases/ghost/compare`);
      await expect(main.getByRole('heading', { name: 'No case with this address in QoS Benchmarks (404)' })).toBeVisible();
      expect(critical).toEqual([]);
    });

    test('snap-detail /app/:org/:project/snapshots/:snapshot', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      await page.goto(`${ROOT}/snapshots/${S2}`);
      const main = page.locator('#platform-main');

      await expect(main.getByRole('heading', { level: 1, name: 'Compiled snapshot' })).toBeVisible();
      await expect(main.getByText(/Made by you · Aug 20, 2026, 10:05 UTC · from Flujo de checkout revision 2 · never changes/)).toBeVisible();
      const fingerprints = main.getByRole('region', { name: 'Fingerprints' });
      await expect(fingerprints.locator('.snap-digest')).toHaveCount(3);
      const language = main.getByRole('region', { name: 'Exact language used' });
      await expect(language.getByText('Profile · qos-binding/v1')).toBeVisible();
      const engines = main.getByRole('region', { name: 'What the engines receive' });
      await expect(engines.getByRole('list', { name: 'What the engines receive' }).getByRole('listitem')).toHaveText(['6tasks', '24candidates', '2rules', '2goal terms', '10^3.3combinations']);
      await expect(engines.getByRole('link', { name: 'See the full model of revision 2' })).toHaveAttribute('href', `${CASE}/revisions/2`);
      await expect(main.getByRole('link', { name: 'Run from this snapshot' })).toHaveAttribute('href', `${ROOT}/jobs/new?snapshot=${S2}`);
      await capture(page, testInfo, `snapshot-${name}-success`);
      if (isMobile) {
        expect(critical).toEqual([]);
        return;
      }

      // The files, as the browser receives them.
      const download = page.waitForEvent('download');
      await main.getByRole('button', { name: /^Package archive/ }).click();
      expect((await download).suggestedFilename()).toBe(`snapshot-${S2}.bim.zip`);
      const compiled = page.waitForEvent('download');
      await main.getByRole('button', { name: /^Compiled form\s*For tools/ }).click();
      expect((await compiled).suggestedFilename()).toBe(`snapshot-${S2}-compiled.json`);

      // The raw source is behind a control.
      await main.getByText('View source').click();
      await expect(main.getByLabel('Compiled form (JSON)')).toBeVisible();
      await main.getByRole('button', { name: 'Files in the package' }).click();
      await expect(main.getByRole('list', { name: 'Files in the package' }).getByRole('button')).toHaveCount(2);
      await capture(page, testInfo, `snapshot-${name}-source`);

      // The pinned files and resources.
      await main.getByText('Per-file and per-resource fingerprints').click();
      await expect(main.getByRole('table', { name: 'Files (2)' })).toBeVisible();

      // The analysis is not available (409): the summary hides, the fingerprints and downloads stay.
      state.refuse.validate = detail(409, 'analysis_unavailable', 'The compiled form does not match.');
      await page.goto(`${ROOT}/snapshots/${S2}`);
      await expect(engines.getByRole('alert')).toContainText('The compiled form doesn’t match this snapshot any more (409 · analysis unavailable), so its summary is hidden.');
      await expect(main.getByRole('region', { name: 'Downloads' })).toBeVisible();
      await capture(page, testInfo, `snapshot-${name}-409`);
      state.refuse.validate = undefined;

      // A snapshot that isn't the account's reads like one that doesn't exist; an API key without the permission is told so.
      await page.goto(`${ROOT}/snapshots/00000000-0000-4000-8000-0000000000ff`);
      await expect(main.getByRole('heading', { name: 'Snapshot not found' })).toBeVisible();
      await capture(page, testInfo, `snapshot-${name}-404`);
      state.refuse.snapshot = detail(403, 'forbidden', 'The API key does not include instances:read.');
      await page.goto(`${ROOT}/snapshots/${S2}`);
      await expect(main.getByText('This API key doesn’t include “read instances” (403).')).toBeVisible();
      await capture(page, testInfo, `snapshot-${name}-403`);
      expect(critical).toEqual([]);
    });
  });
}
