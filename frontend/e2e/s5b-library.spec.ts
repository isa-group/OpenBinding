import { expect as baseExpect, test, type Page, type Route, type TestInfo } from '@playwright/test';
import { failureBody } from './helpers/problems';
import type { ArtifactDraft } from '../src/api/library';
import type { LibraryItem, LibraryVersion } from '../src/api/libraryItems';
import { CURRENT_FIXTURE, catalogFixture } from '../src/pages/Pricing/pricingFixture';
import { OWNER_ORG_ID, catalogContent, draftOf, goalContent, itemOf, rulesContent, versionOf } from '../src/pages/Library/fixtures';
import { templateFor, updateAt, type JsonObject } from '../src/pages/Library/contentModel';

// S5b · library, part 2: lib-list, lib-artifact, lib-draft, lib-version and proj-library.
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

const org = (id: string, slug: string, name: string, role: Role, sponsor = 'user-1') => ({
  id, slug, name, parent_id: null, billing_sponsor_user_id: sponsor, effective_role: role, created_at: '2026-03-03T00:00:00Z',
});

const organizations = [
  org(OWNER_ORG_ID, 'isa-demo', 'ISA Demo Group', 'ADMIN'),
  org('org-3', 'consultora-demo', 'Consultora Demo', 'VIEWER', 'user-nora'),
  org('org-4', 'member-lab', 'Member Lab', 'MEMBER', 'user-nora'),
];

const project = (n: number, orgId: string, slug: string, name: string) => ({
  id: `project-${n}`, organization_id: orgId, slug, name, description: '', visibility: 'private', created_by_id: 'user-1',
  created_at: '2026-04-01T00:00:00Z', updated_at: '2026-10-08T00:00:00Z',
  // The contract's `ProjectView.access`: these specs reach every project as a member.
  access: 'member' as const, effective_role: 'OWNER' as Role,
});

const projectsOf: Record<string, ReturnType<typeof project>[]> = {
  'isa-demo': [project(1, OWNER_ORG_ID, 'qos-benchmarks', 'QoS Benchmarks'), project(2, OWNER_ORG_ID, 'checkout-privado', 'Checkout (privado)')],
  'consultora-demo': [project(3, 'org-3', 'client-case', 'Client case')],
  'member-lab': [project(4, 'org-4', 'bench', 'Bench')],
};

// --- the library behind the screens

const catalog = itemOf('providers-eu', 'CandidateCatalog', 'Proveedores UE', { description: 'Payment, stock and shipping providers in the EU, with their measured latency, cost and availability.' });
const rules = itemOf('sla-hard', 'ConstraintSet', 'SLA hard');
const goal = itemOf('weighted-cost-latency', 'Optimization', 'Weighted cost and latency');
const checkoutApp = itemOf('checkout-app', 'Application', 'Checkout app');
const external = itemOf('catalogo-externo', 'CandidateCatalog', 'Catálogo externo', { organization_id: 'org-other', namespace: 'org-other' });
const clientCatalog = itemOf('client-catalog', 'CandidateCatalog', 'Client catalog', { organization_id: 'org-3', namespace: 'org-3' });

const rulesV1 = versionOf(rules, '1');
const catalogV2 = versionOf(catalog, '2', { public: true });
const catalogV3 = versionOf(catalog, '3', { manifest: { mediaType: 'application/json', contracts: [], dependencies: [rulesV1.ref], kind: 'CandidateCatalog' }, based_on_id: catalogV2.id });
const externalV1 = versionOf(external, '1', { public: true });

const CONTENT_OF: Record<string, unknown> = { [catalog.id]: catalogContent(), [rules.id]: rulesContent(), [goal.id]: goalContent(), [external.id]: catalogContent() };

const LATENCY = ['spec', 'candidates', 'fastpay', 'features', 'latency_ms'];
const withLatency = (value: number) => updateAt(catalogContent() as JsonObject, LATENCY, value);

type Refusable = 'list' | 'create' | 'rename' | 'content' | 'drafts' | 'save' | 'seal' | 'publish' | 'withdraw' | 'associate' | 'projectItems';

interface State {
  items: Record<string, LibraryItem[]>;
  versions: Record<string, LibraryVersion[]>;
  drafts: Record<string, ArtifactDraft[]>;
  /** Item ids associated with each project. */
  associated: Record<string, string[]>;
  refuse: Partial<Record<Refusable, Handler>>;
  /** When set, the next save loses the race: this copy is what someone else saved first. */
  conflictNext: ArtifactDraft | null;
  /** The last body each write carried, to check what was sent. */
  sent: Record<string, unknown>;
}

// Every test gets its own copy: the screens change versions (publish, withdraw), items (rename) and drafts (save, seal).
const seedState = (): State => structuredClone<State>({
  items: {
    'isa-demo': [catalog, rules, goal, checkoutApp],
    'consultora-demo': [clientCatalog],
    'member-lab': [],
  },
  versions: {
    [catalog.id]: [catalogV3, catalogV2],
    [rules.id]: [rulesV1],
    [goal.id]: [versionOf(goal, '1')],
    [checkoutApp.id]: [],
    [external.id]: [externalV1],
    [clientCatalog.id]: [versionOf(clientCatalog, '1')],
  },
  drafts: {
    [catalog.id]: [draftOf('draft-4', 4, catalogContent(), { based_on_id: catalogV3.id })],
    [rules.id]: [draftOf('draft-r1', 2, rulesContent())],
    [goal.id]: [draftOf('draft-g1', 1, goalContent())],
    [checkoutApp.id]: [draftOf('draft-a1', 1, templateFor('Application', 'checkout-app').content as Record<string, unknown>)],
    [clientCatalog.id]: [draftOf('draft-c1', 1, catalogContent())],
  },
  associated: { 'isa-demo/qos-benchmarks': [catalog.id], 'isa-demo/checkout-privado': [], 'consultora-demo/client-case': [clientCatalog.id], 'member-lab/bench': [] },
  refuse: {},
  conflictNext: null,
  sent: {},
});

const everyItem = (state: State) => [...Object.values(state.items).flat(), external];
const methodOf = (route: Route) => route.request().method();
const bodyOf = (route: Route) => route.request().postDataJSON() as Record<string, unknown>;

/** Everything these screens read and write, answered; anything else on the API origin is an empty 404. */
async function mockApi(page: Page, overrides: Partial<State> = {}): Promise<State> {
  const state: State = { ...seedState(), ...overrides };
  await page.addInitScript(() => {
    localStorage.setItem('openbinding-access-token', 's5b-access');
    localStorage.setItem('openbinding-refresh-token', 's5b-refresh');
  });

  await page.route(`${API}/**`, (route) => route.fulfill({ status: 404, json: { detail: 'not mocked' } }));
  await page.route(`${API}/health**`, json({ status: 'ok' }));
  await page.route(`${API}/v1/auth/refresh`, json({ access_token: 's5b-access-2', refresh_token: 's5b-refresh-2', token_type: 'bearer', expires_in: 900 }));
  await page.route(`${API}/v1/pricing/catalog`, json(catalogFixture));
  await page.route(`${API}/v1/pricing/current`, json(CURRENT_FIXTURE));
  await page.route(`${API}/v1/users/me`, json(lucia));
  await page.route(`${API}/v1/users/me/pricing-token`, json({ pricing_token: token(3600) }));
  await page.route(new RegExp(`^${API}/v1/notifications(\\?.*)?$`), json([]));
  await page.route(`${API}/v1/profiles`, json({ profiles: [] }));

  await page.route(new RegExp(`^${API}/v1/organizations(/.*)?(\\?.*)?$`), async (route) => {
    const url = new URL(route.request().url());
    const parts = url.pathname.split('/').filter(Boolean);
    // /v1/organizations/{org}/library · /v1/organizations/{org}/projects/{project}/library/{item}
    const [, , orgSlug, section, projectSlug, sub, subId] = parts;
    const method = methodOf(route);
    const found = organizations.find((item) => item.slug === orgSlug);

    if (!orgSlug) return json(organizations)(route);
    if (section === 'members') return json([])(route);
    if (section === 'library') {
      if (method === 'POST') {
        if (state.refuse.create) return state.refuse.create(route);
        const body = bodyOf(route) as { name: string; display_name: string; kind: string; description: string };
        const created = itemOf(body.name, body.kind, body.display_name, { description: body.description });
        state.items[orgSlug] = [...(state.items[orgSlug] ?? []), created];
        state.versions[created.id] = [];
        state.drafts[created.id] = [];
        return json(created, 201)(route);
      }
      if (state.refuse.list) return state.refuse.list(route);
      const own = state.items[orgSlug] ?? [];
      return json(url.searchParams.get('include_public') === 'true' ? [...own, external] : own)(route);
    }
    if (section !== 'projects') return json(found ?? { detail: { code: 'not_found', error: 'Organization not found.' } }, found ? 200 : 404)(route);

    const list = projectsOf[orgSlug] ?? [];
    if (!projectSlug) return json(list)(route);
    const current = list.find((item) => item.slug === projectSlug);
    if (!current) return detail(404, 'not_found', 'Project not found.')(route);
    if (!sub) return json(current)(route);
    if (sub !== 'library') return json([])(route);

    const key = `${orgSlug}/${projectSlug}`;
    const ids = state.associated[key] ?? [];
    if (!subId) {
      if (state.refuse.projectItems) return state.refuse.projectItems(route);
      return json(ids.map((id) => everyItem(state).find((item) => item.id === id)).filter(Boolean))(route);
    }
    if (method === 'PUT') {
      if (state.refuse.associate) return state.refuse.associate(route);
      state.sent.associate = subId;
      state.associated[key] = [...ids.filter((id) => id !== subId), subId];
      return json({ project_id: current.id, artifact_id: subId })(route);
    }
    state.sent.dissociate = subId;
    state.associated[key] = ids.filter((id) => id !== subId);
    return noContent(route);
  });

  await page.route(new RegExp(`^${API}/v1/artifacts(/.*)?$`), async (route) => {
    const parts = new URL(route.request().url()).pathname.split('/').filter(Boolean);
    // /v1/artifacts/{id}/{drafts|versions}/{sub}/{action}
    const [, , id, sub, subId, action] = parts;
    const method = methodOf(route);

    if (id === 'resolve') {
      const ref = bodyOf(route) as { name: string; version: string };
      const all = Object.values(state.versions).flat();
      const hit = all.find((version) => version.ref.name === ref.name && version.ref.version === ref.version);
      return hit ? json(hit)(route) : detail(404, 'not_found', 'Artifact version not found.')(route);
    }
    const item = everyItem(state).find((candidate) => candidate.id === id);
    if (!item) return detail(404, 'not_found', 'Artifact not found.')(route);
    if (!sub) {
      if (method === 'PATCH') {
        if (state.refuse.rename) return state.refuse.rename(route);
        state.sent.rename = bodyOf(route);
        Object.assign(item, bodyOf(route));
      }
      return json(item)(route);
    }

    const versions = state.versions[item.id] ?? [];
    if (sub === 'versions') {
      if (!subId) return json(versions)(route);
      const version = versions.find((candidate) => candidate.id === subId);
      if (!version) return detail(404, 'not_found', 'Artifact version not found.')(route);
      if (action === 'content') {
        if (state.refuse.content) return state.refuse.content(route);
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(CONTENT_OF[item.id] ?? {}) });
      }
      if (action === 'publish') {
        if (state.refuse.publish) return state.refuse.publish(route);
        state.sent.publish = bodyOf(route);
        const dependencies = Object.values(state.versions).flat().filter((candidate) => version.manifest.dependencies.some((ref) => ref.name === candidate.ref.name && ref.version === candidate.ref.version));
        if (dependencies.some((dependency) => !dependency.public)) return detail(422, 'private_dependency', 'Publish all fixed dependencies before publishing this version.')(route);
        version.public = true;
        return json(version)(route);
      }
      if (state.refuse.withdraw) return state.refuse.withdraw(route);
      version.withdrawn = true;
      return json(version)(route);
    }

    const drafts = state.drafts[item.id] ?? [];
    if (!subId) {
      if (method === 'POST') {
        state.sent.createDraft = bodyOf(route);
        const body = bodyOf(route) as { content: ArtifactDraft['payload']['content']; media_type: string; contracts: []; dependencies: []; based_on_id: string | null };
        const created = draftOf(`draft-new-${drafts.length + 1}`, 1, body.content, { based_on_id: body.based_on_id });
        state.drafts[item.id] = [...drafts, created];
        return json(created, 201)(route);
      }
      return state.refuse.drafts ? state.refuse.drafts(route) : json(drafts)(route);
    }
    const draft = drafts.find((candidate) => candidate.id === subId);
    if (!draft) return detail(404, 'not_found', 'Draft not found.')(route);
    const body = bodyOf(route) as { revision: number; version?: string | null; content: ArtifactDraft['payload']['content'] };

    if (action === 'seal') {
      if (state.refuse.seal) return state.refuse.seal(route);
      state.sent.seal = body;
      if (body.revision !== draft.revision) return detail(409, 'draft_conflict', 'The draft changed; reload before sealing.')(route);
      const label = body.version || String(versions.length + 1);
      if (versions.some((candidate) => candidate.ref.version === label)) return detail(409, 'version_conflict', 'Concurrent version creation; reload the artifact.')(route);
      const sealed = versionOf(item, label, { ordinal: versions.length + 1, based_on_id: draft.based_on_id });
      state.versions[item.id] = [sealed, ...versions];
      state.drafts[item.id] = drafts.filter((candidate) => candidate !== draft);
      return json(sealed, 201)(route);
    }

    // The save of a draft: optimistic, by revision.
    if (state.refuse.save) return state.refuse.save(route);
    state.sent.save = body;
    if (state.conflictNext) {
      Object.assign(draft, state.conflictNext);
      state.conflictNext = null;
      return detail(409, 'draft_conflict', 'The draft changed or has already been sealed.')(route);
    }
    if (body.revision !== draft.revision) return detail(409, 'draft_conflict', 'The draft changed or has already been sealed.')(route);
    draft.revision += 1;
    draft.payload = { ...draft.payload, content: body.content };
    return json({ id: draft.id, revision: draft.revision })(route);
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
  // Against the width of the device, not window.innerWidth: a phone widens its layout viewport to fit a page that overflows.
  const width = page.viewportSize()?.width ?? 0;
  const overflow = await page.evaluate((expected) => document.documentElement.scrollWidth - expected, width);
  expect(overflow, `${name} should not scroll sideways`).toBeLessThanOrEqual(1);
}

const request = (page: Page, method: string, path: string) => page.waitForRequest((candidate) => candidate.method() === method && candidate.url().startsWith(`${API}${path}`));

// Each test walks a screen through its states while the dev server compiles on demand.
test.setTimeout(150_000);
// One worker for the whole file: with every test in parallel the browsers starve each other and the same walk takes twice as long.
test.describe.configure({ mode: 'default' });
const viewports = [
  { name: 'desktop', viewport: { width: 1440, height: 900 }, isMobile: false, deviceScaleFactor: 1 },
  { name: 'mobile', viewport: { width: 390, height: 844 }, isMobile: true, deviceScaleFactor: 2 },
] as const;

const LIB = '/app/isa-demo/library';
const ITEM = `${LIB}/providers-eu`;
const DRAFT = `${ITEM}/drafts/draft-4`;
const ROOT = '/app/isa-demo/qos-benchmarks';

for (const { name, viewport, isMobile, deviceScaleFactor } of viewports) {
  test.describe(`${name} · S5b library`, () => {
    test.use({ viewport, isMobile, deviceScaleFactor });

    test('lib-list /app/:org/library', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      await page.goto(LIB);
      const main = page.locator('#platform-main');

      await expect(main.getByRole('heading', { level: 1, name: 'Library' })).toBeVisible();
      const table = main.getByRole('table', { name: 'Library items' });
      await expect(table.getByRole('row')).toHaveCount(1 + 4);
      const row = table.getByRole('row', { name: /Proveedores UE/ });
      await expect(row.getByRole('link', { name: 'Proveedores UE' })).toHaveAttribute('href', ITEM);
      await expect(row.getByText('v3')).toBeVisible();
      await expect(row.getByText('Published · public')).toBeVisible();
      await expect(row.getByText('QoS Benchmarks')).toBeVisible();
      await expect(table.getByRole('row', { name: /Checkout app/ }).getByText('No version yet')).toBeVisible();
      await capture(page, testInfo, `list-${name}-success`);

      // The dialog of a new item, with the gateway's 409 and the pricing 422.
      await main.getByRole('button', { name: 'New library item' }).click();
      const dialog = page.getByRole('dialog', { name: 'New library item' });
      await dialog.getByLabel('Name (fixed)').fill('providers-eu');
      state.refuse.create = detail(409, 'artifact_exists', 'This artifact name already exists in the organization.');
      // Submitted with Enter: on a phone the on-screen keyboard moves the buttons while a field has focus.
      await dialog.getByLabel('Name (fixed)').press('Enter');
      await expect(dialog.getByRole('alert')).toContainText('There’s already a Candidate catalog called “providers-eu” here (409 · artifact_exists).');
      await capture(page, testInfo, `list-${name}-dialog-409`);
      if (isMobile) {
        expect(critical).toEqual([]);
        return;
      }

      await dialog.getByLabel('Kind', { exact: true }).selectOption('__other');
      await dialog.getByLabel('Kind name').fill('PricingDocument');
      state.refuse.create = detail(422, 'operational_pricing_only', 'Only the platform operational pricing is supported, through SPHERE.');
      await dialog.getByRole('button', { name: 'Create' }).click();
      await expect(dialog.getByRole('alert')).toContainText('Pricing documents can’t live in the library (422 · operational_pricing_only).');
      await capture(page, testInfo, `list-${name}-dialog-422`);

      // Created: the item and its first draft are made, and the editor is one click away.
      state.refuse.create = undefined;
      await dialog.getByLabel('Kind', { exact: true }).selectOption('CandidateCatalog');
      await dialog.getByLabel('Name (fixed)').fill('providers-us');
      await dialog.getByLabel('Display name').fill('Proveedores US');
      const posted = request(page, 'POST', '/v1/organizations/isa-demo/library');
      await dialog.getByRole('button', { name: 'Create' }).click();
      expect((await posted).postDataJSON()).toEqual({ description: '', name: 'providers-us', display_name: 'Proveedores US', kind: 'CandidateCatalog' });
      await expect(main.getByText('Created “Proveedores US”. It starts with an empty draft; seal it when it’s ready.')).toBeVisible();
      await expect(main.getByRole('link', { name: 'Open the draft' })).toHaveAttribute('href', /\/app\/isa-demo\/library\/providers-us\/drafts\/draft-new-1$/);
      await expect(table.getByRole('row')).toHaveCount(1 + 5);
      await capture(page, testInfo, `list-${name}-created`);

      // Search and kind narrow the list; published items of other organizations are an option.
      await main.getByLabel('Search the library').fill('weighted');
      await expect(table.getByRole('row')).toHaveCount(1 + 1);
      await main.getByLabel('Search the library').fill('');
      await main.getByRole('group', { name: 'Kind' }).getByRole('button', { name: 'Rules' }).click();
      await expect(table.getByRole('row')).toHaveCount(1 + 1);
      await main.getByRole('group', { name: 'Kind' }).getByRole('button', { name: 'All kinds' }).click();
      await main.getByLabel('Include public items from other organizations').check();
      await expect(table.getByRole('row', { name: /Catálogo externo/ }).getByText('Another organization')).toBeVisible();

      expect(critical).toEqual([]);
    });

    test('lib-list /app/:org/library · other roles and failures', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      const main = page.locator('#platform-main');
      const table = main.getByRole('table', { name: 'Library items' });

      // A VIEWER reads and has nothing that writes.
      await page.goto('/app/consultora-demo/library');
      await expect(main.getByRole('note')).toContainText('You’re a VIEWER. You can browse the library and open any item; creating items needs MEMBER.');
      await expect(main.getByRole('button', { name: 'New library item' })).toHaveCount(0);
      await capture(page, testInfo, `list-${name}-viewer`);

      // An empty library explains how to start.
      await page.goto('/app/member-lab/library');
      const guide = main.getByRole('region', { name: 'The library is empty' });
      await expect(guide.getByRole('button', { name: 'Create a candidate catalog' })).toBeVisible();
      await expect(guide.getByRole('link', { name: 'Import an example' })).toHaveAttribute('href', '/examples');
      await capture(page, testInfo, `list-${name}-empty`);

      // The list fails and comes back; a key limited to other organizations is told so.
      state.refuse.list = unavailable;
      await page.goto(LIB);
      await expect(main.getByRole('alert')).toContainText('The library couldn’t be loaded (503)');
      await capture(page, testInfo, `list-${name}-error`);
      state.refuse.list = undefined;
      await main.getByRole('button', { name: 'Retry' }).click();
      await expect(table.getByRole('row')).toHaveCount(1 + 4);
      state.refuse.list = detail(403, 'api_key_boundary', 'The API key boundary excludes this organization artifact.');
      await page.goto(LIB);
      await expect(main.getByText('This API key is limited to other organizations or kinds (403 · api_key_boundary), so this library can’t be listed with it.')).toBeVisible();
      await capture(page, testInfo, `list-${name}-403-key`);

      // An organization the account is not in reads like one that is missing.
      await page.goto('/app/ghost/library');
      await expect(main.getByRole('heading', { name: 'Organization not available' })).toBeVisible();
      expect(critical).toEqual([]);
    });

    test('lib-artifact /app/:org/library/:artifact', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      await page.goto(ITEM);
      const main = page.locator('#platform-main');

      await expect(main.getByRole('heading', { level: 1, name: 'Proveedores UE' })).toBeVisible();
      await expect(main.getByText('Candidate catalog').first()).toBeVisible();
      const versions = main.getByRole('list', { name: 'Versions' });
      await expect(versions.getByRole('listitem')).toHaveCount(2);
      await expect(versions.getByRole('link', { name: 'Version 3' })).toHaveAttribute('href', `${ITEM}/versions/3`);
      await expect(versions.getByText('Published · public')).toBeVisible();
      await expect(versions.getByText('Members only')).toBeVisible();
      await capture(page, testInfo, `artifact-${name}-success`);

      await main.getByRole('tab', { name: /^Drafts/ }).click();
      const drafts = main.getByRole('list', { name: 'Open drafts' });
      await expect(drafts.getByRole('link')).toHaveAttribute('href', `${ITEM}/drafts/draft-4`);
      await expect(drafts.getByRole('link')).toContainText('Based on version 3');
      await capture(page, testInfo, `artifact-${name}-drafts`);

      // An item with no sealed version says how to get one.
      await page.goto(`${LIB}/checkout-app`);
      await expect(main.getByText('No version has been sealed yet. Seal a draft to create version 1.')).toBeVisible();
      await capture(page, testInfo, `artifact-${name}-empty`);
      if (isMobile) {
        expect(critical).toEqual([]);
        return;
      }

      // Rename in place.
      await page.goto(ITEM);
      await main.getByRole('button', { name: 'Rename' }).click();
      await main.getByLabel('Display name').fill('Proveedores Europa');
      await main.getByRole('button', { name: 'Save' }).click();
      await expect(main.getByText('Display name saved. The fixed name and all versions are unchanged.')).toBeVisible();
      expect(state.sent.rename).toEqual({ display_name: 'Proveedores Europa' });
      await expect(main.getByRole('heading', { level: 1, name: 'Proveedores Europa' })).toBeVisible();

      // A new draft from the latest version keeps its content and points to the editor.
      await main.getByRole('button', { name: 'New draft' }).click();
      await capture(page, testInfo, `artifact-${name}-new-draft`);
      const created = request(page, 'POST', `/v1/artifacts/${catalog.id}/drafts`);
      await main.getByRole('button', { name: 'Create draft' }).click();
      const sent = (await created).postDataJSON() as { based_on_id: string; content: unknown };
      expect(sent.based_on_id).toBe(catalogV3.id);
      expect(sent.content).toEqual(catalogContent());
      await expect(main.getByText('Draft created from version 3.')).toBeVisible();
      await expect(main.getByRole('link', { name: 'Open the editor' })).toHaveAttribute('href', `${ITEM}/drafts/draft-new-2`);

      // Where it is used, and adding it to another project.
      await main.getByRole('tab', { name: /^Projects/ }).click();
      await expect(main.getByRole('link', { name: /QoS Benchmarks/ })).toHaveAttribute('href', ROOT + '/library');
      await main.getByRole('button', { name: 'Add to another project' }).click();
      const dialog = page.getByRole('dialog', { name: 'Use in a project' });
      await expect(dialog.getByLabel('Project')).toHaveValue('checkout-privado');
      await capture(page, testInfo, `artifact-${name}-use-in-project`);
      await dialog.getByRole('button', { name: 'Add to project' }).click();
      await expect(main.getByText('“Proveedores Europa” added to Checkout (privado).')).toBeVisible();
      expect(state.sent.associate).toBe(catalog.id);

      // What it depends on.
      await main.getByRole('tab', { name: /^Dependencies/ }).click();
      await expect(main.getByRole('region', { name: 'It depends on' }).getByText('sla-hard')).toBeVisible();

      // A VIEWER reads: no renaming, no drafts.
      await page.goto('/app/consultora-demo/library/client-catalog');
      await expect(main.getByRole('note')).toContainText('You’re a VIEWER.');
      await expect(main.getByRole('button', { name: 'Rename' })).toHaveCount(0);
      await expect(main.getByRole('button', { name: 'New draft' })).toHaveCount(0);
      await capture(page, testInfo, `artifact-${name}-viewer`);

      // An item that isn't there.
      await page.goto(`${LIB}/ghost`);
      await expect(main.getByRole('heading', { name: 'Library item not found' })).toBeVisible();
      await expect(main.getByRole('link', { name: 'Back to the library' })).toHaveAttribute('href', LIB);
      await capture(page, testInfo, `artifact-${name}-404`);
      expect(critical).toEqual([]);
    });

    test('lib-draft /app/:org/library/:artifact/drafts/:draft', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      await page.goto(DRAFT);
      const main = page.locator('#platform-main');
      const latency = main.getByLabel('latency_ms for fastpay', { exact: true });

      await expect(main.getByRole('heading', { level: 1, name: 'Proveedores UE · draft' })).toBeVisible();
      await expect(main.getByRole('table', { name: 'Candidates for service/payment' }).getByRole('row')).toHaveCount(1 + 2);
      await expect(latency).toHaveValue('95');
      await expect(main.getByText('All changes saved')).toBeVisible();
      await expect(main.getByRole('region', { name: 'Checks' }).getByText('3 providers in 2 capabilities')).toBeVisible();
      await expect(main.getByRole('textbox', { name: /json|source/i })).toHaveCount(0);
      await capture(page, testInfo, `draft-${name}-success`);

      // The seal dialog says what gets frozen.
      await main.getByRole('button', { name: 'Seal version…' }).click();
      const seal = page.getByRole('dialog', { name: 'Seal a new version' });
      await expect(seal.getByText('3 providers in 2 capabilities, and their qualities')).toBeVisible();
      await expect(seal.getByText('Everything in version 3 that you didn’t change')).toBeVisible();
      await seal.getByLabel('Version label (optional)').fill('3');
      // Submitted with Enter: on a phone the on-screen keyboard moves the buttons while a field has focus.
      await seal.getByLabel('Version label (optional)').press('Enter');
      await expect(seal.getByRole('alert')).toContainText('Version 3 already exists (409 · version_conflict). Choose another label.');
      await capture(page, testInfo, `draft-${name}-seal-409`);
      if (isMobile) {
        expect(critical).toEqual([]);
        return;
      }

      // Edit one cell, save with the revision the editor started from.
      await seal.getByRole('button', { name: 'Cancel' }).click();
      await latency.fill('90');
      await expect(main.getByText('Unsaved changes')).toBeVisible();
      await capture(page, testInfo, `draft-${name}-unsaved`);
      const saved = request(page, 'PUT', `/v1/artifacts/${catalog.id}/drafts/draft-4`);
      await main.getByRole('button', { name: 'Save draft' }).click();
      const body = (await saved).postDataJSON() as { revision: number; content: unknown };
      expect(body.revision).toBe(4);
      expect(body.content).toEqual(withLatency(90));
      await expect(main.getByText('Draft revision 5')).toBeVisible();

      // Someone saved first: the two copies are put side by side and mine goes on top of theirs.
      await latency.fill('99');
      state.conflictNext = draftOf('draft-4', 6, withLatency(85), { based_on_id: catalogV3.id });
      await main.getByRole('button', { name: 'Save draft' }).click();
      const conflict = main.getByRole('alert');
      await expect(conflict).toContainText('Someone saved this draft while you were editing (409 · draft conflict)');
      await expect(conflict.getByRole('row', { name: /latency_ms/ }).getByRole('cell')).toHaveText(['99', '85']);
      await capture(page, testInfo, `draft-${name}-conflict`);
      const kept = request(page, 'PUT', `/v1/artifacts/${catalog.id}/drafts/draft-4`);
      await conflict.getByRole('button', { name: 'Keep mine on top of theirs' }).click();
      expect(((await kept).postDataJSON() as { revision: number }).revision).toBe(6);
      await expect(main.getByText('Draft revision 7')).toBeVisible();

      expect(critical).toEqual([]);
    });

    test('lib-draft /app/:org/library/:artifact/drafts/:draft · kinds and refusals', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      const main = page.locator('#platform-main');
      const latency = main.getByLabel('latency_ms for fastpay', { exact: true });
      const seal = page.getByRole('dialog', { name: 'Seal a new version' });

      // Rules are a table of their own; any other kind is a form of fields.
      await page.goto(`${LIB}/sla-hard/drafts/draft-r1`);
      await expect(main.getByLabel('Condition of sla-latency')).toHaveValue('features.latency_ms <= 600');
      await capture(page, testInfo, `draft-${name}-rules`);
      await page.goto(`${LIB}/weighted-cost-latency/drafts/draft-g1`);
      await expect(main.getByRole('heading', { level: 1, name: 'Weighted cost and latency · draft' })).toBeVisible();
      await expect(main.getByRole('group', { name: /^Goal criteria/ })).toBeVisible();
      await capture(page, testInfo, `draft-${name}-fields`);
      await page.goto(`${LIB}/checkout-app/drafts/draft-a1`);
      await expect(main.getByText('Nothing here yet.').first()).toBeVisible();
      // A blank draft says what the schema still asks for, and cannot be sealed until it is there.
      await expect(main.getByRole('region', { name: 'Checks' }).getByText('Add at least one task')).toBeVisible();
      await expect(main.getByRole('button', { name: 'Seal version…' })).toBeDisabled();
      await capture(page, testInfo, `draft-${name}-blank`);

      // The key can't write: the editor turns read-only.
      await page.goto(DRAFT);
      await latency.fill('80');
      state.refuse.save = detail(403, 'forbidden', 'The API key does not include artifacts:write.');
      await main.getByRole('button', { name: 'Save draft' }).click();
      await expect(main.getByText('This API key can’t write library items (403), so the editor is read-only.')).toBeVisible();
      await expect(latency).toBeDisabled();
      await capture(page, testInfo, `draft-${name}-403-key`);
      state.refuse.save = undefined;

      // A VIEWER can't read drafts; a draft that isn't there says so.
      state.refuse.drafts = detail(403, 'forbidden', 'The account role does not permit this request.');
      await page.goto('/app/consultora-demo/library/client-catalog/drafts/draft-c1');
      await expect(main.getByText('Drafts are for members')).toBeVisible();
      await capture(page, testInfo, `draft-${name}-viewer`);
      state.refuse.drafts = undefined;
      await page.goto(`${ITEM}/drafts/ghost`);
      await expect(main.getByRole('heading', { name: 'Draft not found' })).toBeVisible();
      await capture(page, testInfo, `draft-${name}-404`);

      // Sealing freezes the draft into version 4 and says so.
      await page.goto(DRAFT);
      await expect(main.getByText('Draft revision 4')).toBeVisible();
      await main.getByRole('button', { name: 'Seal version…' }).click();
      await seal.getByLabel('Version label (optional)').fill('4');
      const sealed = request(page, 'POST', `/v1/artifacts/${catalog.id}/drafts/draft-4/seal`);
      await seal.getByLabel('Version label (optional)').press('Enter');
      expect(((await sealed).postDataJSON() as { revision: number; version: string })).toEqual({ revision: 4, version: '4' });
      await expect(main.getByRole('heading', { level: 1, name: 'Version 4 sealed' })).toBeVisible();
      await expect(main.getByRole('link', { name: 'Open the version' })).toHaveAttribute('href', `${ITEM}/versions/4`);
      await capture(page, testInfo, `draft-${name}-sealed`);
      expect(critical).toEqual([]);
    });

    test('lib-version /app/:org/library/:artifact/versions/:version', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      await page.goto(`${ITEM}/versions/3`);
      const main = page.locator('#platform-main');

      await expect(main.getByRole('heading', { level: 1, name: 'Proveedores UE · version 3' })).toBeVisible();
      const reference = main.getByRole('region', { name: 'Exact reference' });
      await expect(reference.getByText('Version fingerprint')).toBeVisible();
      await expect(reference.getByText('providers-eu')).toBeVisible();
      await expect(main.getByRole('table', { name: 'Candidates for service/payment' })).toBeVisible();
      const checks = main.getByRole('heading', { name: 'Before it can be public' }).locator('xpath=ancestor::section[1]');
      await expect(checks).toContainText('Depends on a private item: sla-hard v1 isn’t published (422 · private dependency).');
      await expect(checks.getByRole('link', { name: 'Open it' })).toHaveAttribute('href', `${LIB}/${rules.id}/versions/1`);
      await expect(main.getByRole('button', { name: 'Publish…' })).toBeVisible();
      await capture(page, testInfo, `version-${name}-success`);

      // The publish dialog, and the gateway's 422 while a dependency is still private.
      await main.getByRole('button', { name: 'Publish…' }).click();
      const dialog = page.getByRole('dialog', { name: 'Publish version 3' });
      await expect(dialog.getByLabel('Citation title')).toHaveValue('Proveedores UE');
      await capture(page, testInfo, `version-${name}-publish-dialog`);
      await dialog.getByRole('button', { name: 'Publish' }).click();
      await expect(main.getByText('Can’t publish yet (422): see the checks below.')).toBeVisible();
      await capture(page, testInfo, `version-${name}-422`);
      if (isMobile) {
        expect(critical).toEqual([]);
        return;
      }

      // Once the dependency is published, the checklist turns green and publishing works.
      state.versions[rules.id][0].public = true;
      await page.goto(`${ITEM}/versions/3`);
      await expect(checks).toContainText('sla-hard v1 is published');
      await main.getByRole('button', { name: 'Publish…' }).click();
      await dialog.getByLabel('Citation title').fill('Catálogo de proveedores UE');
      const published = request(page, 'POST', `/v1/artifacts/${catalog.id}/versions/${catalogV3.id}/publish`);
      await dialog.getByRole('button', { name: 'Publish' }).click();
      expect(((await published).postDataJSON() as { citation: unknown }).citation).toEqual({ title: 'Catálogo de proveedores UE' });
      await expect(main.getByText('Published with its citation. Anyone can now read and verify this version.')).toBeVisible();
      await expect(main.getByRole('region', { name: 'Cite as' })).toContainText('Catálogo de proveedores UE, version 3');
      await expect(main.getByRole('button', { name: 'Publish…' })).toHaveCount(0);
      await capture(page, testInfo, `version-${name}-published`);

      // Withdrawing asks first, and keeps references working.
      await main.getByRole('button', { name: 'Withdraw' }).click();
      const withdraw = page.getByRole('dialog', { name: 'Withdraw version 3?' });
      await capture(page, testInfo, `version-${name}-withdraw-dialog`);
      await withdraw.getByRole('button', { name: 'Withdraw' }).click();
      await expect(main.getByText('Withdrawn: it’s no longer listed, but existing references still resolve.', { exact: true })).toBeVisible();
      await expect(main.getByText('Withdrawn · not listed')).toBeVisible();
      await capture(page, testInfo, `version-${name}-withdrawn`);

      expect(critical).toEqual([]);
    });

    test('lib-version /app/:org/library/:artifact/versions/:version · integrity and visitors', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      const main = page.locator('#platform-main');

      // Content that no longer matches its seal is neither shown nor served.
      state.refuse.content = detail(409, 'version_integrity', 'Version content identity differs from its sealed manifest.');
      await page.goto(`${ITEM}/versions/2`);
      await expect(main.getByText(/The stored content doesn’t match this version’s fingerprint \(409 · version integrity\)/)).toBeVisible();
      await expect(main.getByRole('button', { name: 'Download content' })).toBeDisabled();
      await capture(page, testInfo, `version-${name}-409-integrity`);
      state.refuse.content = undefined;

      // Someone outside the organization sees only what is published.
      await page.goto(`/app/other-org/library/${external.id}/versions/1`);
      await expect(main.getByText('You’re seeing this because the version is published.')).toBeVisible();
      await expect(main.getByRole('button', { name: 'Publish…' })).toHaveCount(0);
      await expect(main.getByRole('region', { name: 'Cite as' })).toBeVisible();
      await capture(page, testInfo, `version-${name}-outsider`);
      await page.goto(`${ITEM}/versions/9`);
      await expect(main.getByRole('heading', { name: 'Version not found' })).toBeVisible();
      expect(critical).toEqual([]);
    });

    test('proj-library /app/:org/:project/library', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      state.associated['isa-demo/qos-benchmarks'] = [catalog.id, rules.id];
      await page.goto(`${ROOT}/library`);
      const main = page.locator('#platform-main');

      await expect(main.getByRole('heading', { level: 1, name: 'Library used here' })).toBeVisible();
      const list = main.getByRole('list', { name: 'Library items used here' });
      await expect(list.getByRole('listitem')).toHaveCount(2);
      await expect(list.getByRole('link', { name: 'Proveedores UE' })).toHaveAttribute('href', ITEM);
      await expect(list.getByText('latest v3')).toBeVisible();
      await expect(main.getByRole('navigation', { name: 'Project sections' }).getByRole('link', { name: 'Library' })).toHaveAttribute('aria-current', 'page');
      const sections = main.getByRole('navigation', { name: 'Library sections' });
      await expect(sections.getByRole('link', { name: 'Collections' })).toHaveAttribute('href', `${ROOT}/collections`);
      await expect(sections.getByRole('link', { name: 'Organization library' })).toHaveAttribute('href', LIB);
      await capture(page, testInfo, `projlib-${name}-success`);

      // The picker offers what isn't here yet, and the published items of others.
      await main.getByRole('button', { name: 'Add from library' }).click();
      const picker = page.getByRole('dialog', { name: 'Add from library' });
      await expect(picker.getByRole('button', { name: 'Add SLA hard' })).toHaveCount(0);
      await expect(picker.getByRole('button', { name: 'Add Checkout app' })).toBeVisible();
      await expect(picker.getByRole('button', { name: 'Add Catálogo externo' })).toBeVisible();
      await capture(page, testInfo, `projlib-${name}-picker`);

      // A private item of another organization is refused (422) and the list stays as it was.
      state.refuse.associate = detail(422, 'private_dependency', 'Another organization can only consume public artifacts.');
      await picker.getByRole('button', { name: 'Add Catálogo externo' }).click();
      await expect(main.getByRole('alert')).toContainText('“Catálogo externo” belongs to another organization and isn’t published (422 · private_dependency).');
      await expect(list.getByRole('listitem')).toHaveCount(2);
      await capture(page, testInfo, `projlib-${name}-422`);
      if (isMobile) {
        expect(critical).toEqual([]);
        return;
      }

      // Adding and removing change the association, not the item.
      state.refuse.associate = undefined;
      await main.getByRole('button', { name: 'Add from library' }).click();
      await picker.getByRole('button', { name: 'Add Checkout app' }).click();
      await expect(main.getByText('Checkout app added.')).toBeVisible();
      expect(state.sent.associate).toBe(checkoutApp.id);
      await expect(list.getByRole('listitem')).toHaveCount(3);
      await list.getByRole('button', { name: 'Remove SLA hard from this project' }).click();
      await expect(main.getByText('“SLA hard” removed from this project. Its versions are untouched.')).toBeVisible();
      expect(state.sent.dissociate).toBe(rules.id);
      await expect(list.getByRole('listitem')).toHaveCount(2);

      // Nothing associated yet.
      await page.goto('/app/isa-demo/checkout-privado/library');
      await expect(main.getByText('Nothing associated yet')).toBeVisible();
      await expect(main.getByRole('link', { name: 'Browse the library' })).toHaveAttribute('href', LIB);
      await capture(page, testInfo, `projlib-${name}-empty`);

      // A VIEWER sees the list and no controls.
      await page.goto('/app/consultora-demo/client-case/library');
      await expect(list.getByRole('listitem')).toHaveCount(1);
      await expect(main.getByRole('button', { name: 'Add from library' })).toHaveCount(0);
      await expect(main.getByRole('button', { name: /^Remove / })).toHaveCount(0);
      await capture(page, testInfo, `projlib-${name}-viewer`);

      // The list fails and comes back.
      state.refuse.projectItems = unavailable;
      await page.goto(`${ROOT}/library`);
      await expect(main.getByRole('alert')).toContainText('The project’s library couldn’t be loaded (503)');
      await capture(page, testInfo, `projlib-${name}-error`);
      state.refuse.projectItems = undefined;
      await main.getByRole('button', { name: 'Retry' }).click();
      await expect(list.getByRole('listitem')).toHaveCount(2);

      // A project the account is not in reads like one that is missing.
      await page.goto('/app/isa-demo/ghost/library');
      await expect(main.getByRole('heading', { name: 'Project not found' })).toBeVisible();
      expect(critical).toEqual([]);
    });
  });
}
