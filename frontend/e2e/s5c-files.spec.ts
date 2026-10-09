import { createHash } from 'node:crypto';
import { expect as baseExpect, test, type Page, type Route, type TestInfo } from '@playwright/test';
import JSZip from 'jszip';
import type {
  BindingCase, CaseRevision, Collection, CollectionItem, CollectionRevision, ProjectResource, ProjectResourceRevision, StoredBlob,
} from '../src/api/platform';
import { CURRENT_FIXTURE, catalogFixture } from '../src/pages/Pricing/pricingFixture';
import {
  blobOf, caseItem, collectionOf, collectionRevisionOf, digestOf, resourceItem, resourceOf, resourceRevisionOf, usageOf,
} from '../src/pages/Resources/fixtures';

// S5c · files, resources and collections: proj-files, proj-resources, proj-resource-detail, coll-list and coll-detail.
// There is no backend: the API origin is answered by page.route(). Screenshots go to testInfo.outputPath() (test-results/, ignored by
// git) so they can be looked at after a run. One test per screen and viewport: the desktop walks the states of the screen, the phone
// gets its layout and its dialogs.

const API = 'http://localhost:8000';

// Several browsers share one development server, so a screen can take longer than the default five seconds to settle.
const expect = baseExpect.configure({ timeout: 15_000 });

type Handler = (route: Route) => Promise<void> | void;
const json = (body: unknown, status = 200): Handler => (route) => route.fulfill({ status, json: body });
const detail = (status: number, code: string, error: string, extra: Record<string, unknown> = {}): Handler => json({ detail: { code, error, ...extra } }, status);
const noContent: Handler = (route) => route.fulfill({ status: 204 });
/** A service that does not answer: a 503 with no machine code, as a proxy in front of the gateway would send it. */
const unavailable: Handler = json({ detail: 'The service is not reachable.' }, 503);
/** What FastAPI answers to a body that fails validation: a list, with no machine code. */
const invalid = (message: string): Handler => json({ detail: [{ loc: ['body'], msg: message, type: 'value_error' }] }, 422);

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
  org('org-isa-demo', 'isa-demo', 'ISA Demo Group', 'ADMIN'),
  org('org-3', 'consultora-demo', 'Consultora Demo', 'VIEWER', 'user-nora'),
  org('org-4', 'member-lab', 'Member Lab', 'MEMBER', 'user-nora'),
];

const project = (n: number, orgId: string, slug: string, name: string) => ({
  id: `project-${n}`, organization_id: orgId, slug, name, description: '', visibility: 'private', created_by_id: 'user-1',
  created_at: '2026-04-01T00:00:00Z', updated_at: '2026-10-08T00:00:00Z',
});

const projectsOf: Record<string, ReturnType<typeof project>[]> = {
  'isa-demo': [project(1, 'org-isa-demo', 'qos-benchmarks', 'QoS Benchmarks'), project(2, 'org-isa-demo', 'checkout-privado', 'Checkout (privado)')],
  'consultora-demo': [project(3, 'org-3', 'client-case', 'Client case')],
  'member-lab': [project(4, 'org-4', 'bench', 'Bench')],
};

// --- what each project holds

interface ProjectData {
  files: StoredBlob[];
  resources: ProjectResource[];
  resourceRevs: Record<string, ProjectResourceRevision[]>;
  collections: Collection[];
  collectionRevs: Record<string, CollectionRevision[]>;
  cases: BindingCase[];
  caseRevs: Record<string, CaseRevision[]>;
}

const flujo: BindingCase = {
  id: 'case-flujo-checkout', project_id: 'project-1', slug: 'flujo-checkout', name: 'Flujo de checkout', description: '', created_by_id: 'user-1', created_at: '2026-04-02T00:00:00Z',
};
const caseRevision = (n: number): CaseRevision => ({
  id: `case-flujo-checkout-r${n}`, binding_case_id: flujo.id, revision: n, digest: digestOf(String(n)), document: {}, source_snapshot_id: null, created_at: `2026-04-0${n}T00:00:00Z`,
});

const weights = resourceOf('weights', 'Weights', { kind: 'Dataset', description: 'Latency probe results used by the checkout benchmarks.' });
const goal = resourceOf('goal', 'Weighted goal', { kind: 'Optimization' });
const notes = resourceOf('notes', 'Notes');
const checkout = collectionOf('referencias-checkout', 'Referencias checkout', { description: 'What a reviewer needs to reproduce the published comparison.' });
const vacia = collectionOf('vacia', 'Vacía', { description: 'A list that has not got its first revision yet.' });

const VERSION_DIGEST = digestOf('a');
/** The items of a revision as the gateway lists them: a case by revision id, a resource by library reference. */
const listed = (...parts: Array<'c1' | 'c2' | 'c3' | 'w1'>): CollectionItem[] => parts.map((part) => (part === 'w1'
  ? resourceItem('weights', '1', VERSION_DIGEST)
  : caseItem(`case-flujo-checkout-r${part.slice(1)}`, digestOf(part.slice(1)))));

const qosData = (): ProjectData => ({
  files: [
    blobOf('a'),
    blobOf('b', { media_type: 'text/csv', size_bytes: 18_432, public: true, created_at: '2026-09-30T09:00:00Z' }),
  ],
  resources: [goal, notes, weights],
  resourceRevs: {
    weights: [
      resourceRevisionOf(weights, 1, { title: 'Latency probes', samples: 3 }),
      resourceRevisionOf(weights, 2, { title: 'Latency probes', samples: 5 }),
    ],
    goal: [resourceRevisionOf(goal, 1, { apiVersion: 'qos-binding/v1', kind: 'Optimization', metadata: { name: 'weighted-goal' }, spec: { penalties: [], criteria: [] } })],
    notes: [],
  },
  collections: [checkout, vacia],
  collectionRevs: {
    'referencias-checkout': [collectionRevisionOf(checkout, 1, listed('c1', 'w1')), collectionRevisionOf(checkout, 2, listed('c1', 'c2', 'w1'))],
    vacia: [],
  },
  cases: [flujo],
  caseRevs: { 'flujo-checkout': [caseRevision(1), caseRevision(2), caseRevision(3)] },
});

const emptyData = (): ProjectData => ({ files: [], resources: [], resourceRevs: {}, collections: [], collectionRevs: {}, cases: [], caseRevs: {} });

type Refusable = 'files' | 'upload' | 'download' | 'deleteFile' | 'resources' | 'resource' | 'resourceRevisions' | 'createResource' | 'saveResourceRevision'
  | 'collections' | 'collection' | 'collectionRevisions' | 'createCollection' | 'saveCollectionRevision' | 'deleteCollection';

interface State {
  projects: Record<string, ProjectData>;
  refuse: Partial<Record<Refusable, Handler>>;
  /** The last body each write carried, to check what was sent. */
  sent: Record<string, unknown>;
}

// Every test gets its own copy: the screens upload, delete and save.
const seedState = (): State => ({
  projects: structuredClone({
    'isa-demo/qos-benchmarks': qosData(),
    'isa-demo/checkout-privado': emptyData(),
    'consultora-demo/client-case': qosData(),
    'member-lab/bench': emptyData(),
  }),
  refuse: {},
  sent: {},
});

const methodOf = (route: Route) => route.request().method();
const bodyOf = (route: Route) => route.request().postDataJSON() as Record<string, unknown>;

/** A small ZIP the download and the look-inside serve. */
async function archiveBytes(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('package/manifest.json', '{"kind":"Package"}');
  zip.file('cases/checkout.json', '{"kind":"Case"}');
  zip.file('reports/summary.txt', 'Summary');
  return zip.generateAsync({ type: 'nodebuffer' });
}

/** The way the gateway lists a collection’s item after it has been saved. */
function storedItem(item: CollectionItem, data: ProjectData): CollectionItem {
  if (item.target_kind === 'case') return caseItem(String(item.target_ref.caseRevisionId), item.target_digest);
  const id = String(item.target_ref.resourceRevisionId);
  for (const [slug, revisions] of Object.entries(data.resourceRevs)) {
    const found = revisions.find((revision) => revision.id === id);
    if (found) return resourceItem(slug, String(found.revision), VERSION_DIGEST);
  }
  return item;
}

/** Everything these screens read and write, answered; anything else on the API origin is an empty 404. */
async function mockApi(page: Page, overrides: Partial<State> = {}): Promise<State> {
  const state: State = { ...seedState(), ...overrides };
  await page.addInitScript(() => {
    localStorage.setItem('openbinding-access-token', 's5c-access');
    localStorage.setItem('openbinding-refresh-token', 's5c-refresh');
  });

  await page.route(`${API}/**`, (route) => route.fulfill({ status: 404, json: { detail: 'not mocked' } }));
  await page.route(`${API}/health**`, json({ status: 'ok' }));
  await page.route(`${API}/v1/auth/refresh`, json({ access_token: 's5c-access-2', refresh_token: 's5c-refresh-2', token_type: 'bearer', expires_in: 900 }));
  await page.route(`${API}/v1/pricing/catalog`, json(catalogFixture));
  await page.route(`${API}/v1/pricing/current`, json(CURRENT_FIXTURE));
  await page.route(`${API}/v1/users/me`, json(lucia));
  await page.route(`${API}/v1/users/me/usage`, json(usageOf()));
  await page.route(`${API}/v1/users/me/pricing-token`, json({ pricing_token: token(3600) }));
  await page.route(new RegExp(`^${API}/v1/notifications(\\?.*)?$`), json([]));
  await page.route(`${API}/v1/profiles`, json({ profiles: [] }));

  await page.route(new RegExp(`^${API}/v1/organizations(/.*)?(\\?.*)?$`), async (route) => {
    const url = new URL(route.request().url());
    const parts = url.pathname.split('/').filter(Boolean);
    // /v1/organizations/{org}/projects/{project}/{sub}/{id}/{action}
    const [, , orgSlug, section, projectSlug, sub, subId, action] = parts;
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
    const data = state.projects[`${orgSlug}/${projectSlug}`] ?? emptyData();

    // --- files
    if (sub === 'blobs') {
      if (!subId) {
        if (method === 'POST') {
          if (state.refuse.upload) return state.refuse.upload(route);
          const bytes = route.request().postDataBuffer() ?? Buffer.alloc(0);
          const digest = `sha256-${createHash('sha256').update(bytes).digest('hex')}`;
          state.sent.uploadType = route.request().headers()['content-type'];
          state.sent.uploadPublic = url.searchParams.get('public');
          const stored: StoredBlob = data.files.find((file) => file.digest === digest) ?? {
            ...blobOf('f'), id: `blob-${data.files.length + 1}`, digest, media_type: route.request().headers()['content-type'] ?? 'application/octet-stream',
            size_bytes: bytes.length, public: url.searchParams.get('public') === 'true', created_at: '2026-10-09T08:00:00Z',
          };
          if (!data.files.includes(stored)) data.files = [stored, ...data.files];
          return json(stored, 201)(route);
        }
        if (state.refuse.files) return state.refuse.files(route);
        return json(data.files)(route);
      }
      const file = data.files.find((item) => item.digest === decodeURIComponent(subId));
      if (!file) return detail(404, 'not_found', 'Blob not found.')(route);
      if (method === 'DELETE') {
        if (state.refuse.deleteFile) return state.refuse.deleteFile(route);
        state.sent.deleted = file.digest;
        data.files = data.files.filter((item) => item !== file);
        return noContent(route);
      }
      if (state.refuse.download) return state.refuse.download(route);
      return route.fulfill({ status: 200, contentType: file.media_type, body: /zip/.test(file.media_type) ? await archiveBytes() : Buffer.from('a,b\n1,2\n') });
    }

    // --- cases, only to let a collection name what it pins
    if (sub === 'cases') {
      if (!subId) return json(data.cases)(route);
      return json(data.caseRevs[subId] ?? [])(route);
    }

    // --- resources
    if (sub === 'resources') {
      if (!subId) {
        if (method === 'POST') {
          if (state.refuse.createResource) return state.refuse.createResource(route);
          const body = bodyOf(route) as { slug: string; name: string; description: string; kind: string };
          state.sent.createResource = body;
          const created = resourceOf(body.slug, body.name, { description: body.description, kind: body.kind });
          data.resources = [...data.resources, created];
          data.resourceRevs[created.slug] = [];
          return json(created, 201)(route);
        }
        if (state.refuse.resources) return state.refuse.resources(route);
        return json(data.resources)(route);
      }
      const resource = data.resources.find((item) => item.slug === subId);
      if (!resource) return detail(404, 'not_found', 'Project resource not found.')(route);
      if (!action) {
        if (method === 'PATCH') {
          state.sent.updateResource = bodyOf(route);
          Object.assign(resource, bodyOf(route));
        }
        if (method === 'DELETE') {
          state.sent.deleteResource = resource.slug;
          data.resources = data.resources.filter((item) => item !== resource);
          return noContent(route);
        }
        if (state.refuse.resource) return state.refuse.resource(route);
        return json(resource)(route);
      }
      const revisions = data.resourceRevs[resource.slug] ?? [];
      if (method === 'POST') {
        if (state.refuse.saveResourceRevision) return state.refuse.saveResourceRevision(route);
        const { document } = bodyOf(route) as { document: Record<string, unknown> };
        state.sent.resourceRevision = document;
        const same = revisions.find((item) => JSON.stringify(item.document) === JSON.stringify(document));
        if (same) return json(same, 201)(route);
        const created = resourceRevisionOf(resource, revisions.length + 1, document, { created_at: '2026-10-09T08:00:00Z' });
        data.resourceRevs[resource.slug] = [...revisions, created];
        return json(created, 201)(route);
      }
      if (state.refuse.resourceRevisions) return state.refuse.resourceRevisions(route);
      return json(revisions)(route);
    }

    // --- collections
    if (sub === 'collections') {
      if (!subId) {
        if (method === 'POST') {
          if (state.refuse.createCollection) return state.refuse.createCollection(route);
          const body = bodyOf(route) as { slug: string; name: string; description: string };
          state.sent.createCollection = body;
          const created = collectionOf(body.slug, body.name, { description: body.description });
          data.collections = [...data.collections, created];
          data.collectionRevs[created.slug] = [];
          return json(created, 201)(route);
        }
        if (state.refuse.collections) return state.refuse.collections(route);
        return json(data.collections)(route);
      }
      const collection = data.collections.find((item) => item.slug === subId);
      if (!collection) return detail(404, 'not_found', 'Collection not found.')(route);
      if (!action) {
        if (method === 'PATCH') {
          state.sent.updateCollection = bodyOf(route);
          Object.assign(collection, bodyOf(route));
        }
        if (method === 'DELETE') {
          if (state.refuse.deleteCollection) return state.refuse.deleteCollection(route);
          state.sent.deleteCollection = collection.slug;
          data.collections = data.collections.filter((item) => item !== collection);
          return noContent(route);
        }
        if (state.refuse.collection) return state.refuse.collection(route);
        return json(collection)(route);
      }
      const revisions = data.collectionRevs[collection.slug] ?? [];
      if (method === 'POST') {
        if (state.refuse.saveCollectionRevision) return state.refuse.saveCollectionRevision(route);
        const { items } = bodyOf(route) as { items: CollectionItem[] };
        state.sent.collectionRevision = items;
        const stored = items.map((item) => storedItem(item, data));
        const same = revisions.find((item) => JSON.stringify(item.items) === JSON.stringify(stored));
        if (same) return json(same, 201)(route);
        const created = collectionRevisionOf(collection, revisions.length + 1, stored, { created_at: '2026-10-09T08:00:00Z' });
        data.collectionRevs[collection.slug] = [...revisions, created];
        return json(created, 201)(route);
      }
      if (state.refuse.collectionRevisions) return state.refuse.collectionRevisions(route);
      return json(revisions)(route);
    }

    return json([])(route);
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

/** Full-page capture of the current state, then a check that nothing scrolls sideways. */
async function capture(page: Page, testInfo: TestInfo, name: string) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    (document.activeElement as HTMLElement | null)?.blur();
    window.scrollTo(0, 0);
  });
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true, animations: 'disabled' });
  // Against the width of the device, not window.innerWidth: a phone widens its layout viewport to fit a page that overflows.
  const width = page.viewportSize()?.width ?? 0;
  const overflow = await page.evaluate((expected) => document.documentElement.scrollWidth - expected, width);
  expect(overflow, `${name} should not scroll sideways`).toBeLessThanOrEqual(1);
}

const request = (page: Page, method: string, path: string) => page.waitForRequest((candidate) => candidate.method() === method && candidate.url().startsWith(`${API}${path}`));

// Each test walks a screen through its states while the dev server compiles on demand.
test.setTimeout(150_000);

const viewports = [
  { name: 'desktop', viewport: { width: 1440, height: 900 }, isMobile: false, deviceScaleFactor: 1 },
  { name: 'mobile', viewport: { width: 390, height: 844 }, isMobile: true, deviceScaleFactor: 2 },
] as const;

const ROOT = '/app/isa-demo/qos-benchmarks';
const API_ROOT = '/v1/organizations/isa-demo/projects/qos-benchmarks';
const FILES = `${ROOT}/files`;
const RESOURCES = `${ROOT}/resources`;
const COLLECTIONS = `${ROOT}/collections`;
const ARCHIVE = 'ZIP archive · sha256-aaaa…aaaa';
const CSV_ROW = /CSV · sha256-bbbb…bbbb/;

const csvFile = (name: string, content = 'a,b\n1,2\n') => ({ name, mimeType: 'text/csv', buffer: Buffer.from(content) });

for (const { name, viewport, isMobile, deviceScaleFactor } of viewports) {
  test.describe(`${name} · S5c files, resources and collections`, () => {
    test.use({ viewport, isMobile, deviceScaleFactor });

    test('proj-files /app/:org/:project/files', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      await page.goto(FILES);
      const main = page.locator('#platform-main');
      const table = main.getByRole('region', { name: 'Files' });

      await expect(main.getByRole('heading', { level: 1, name: 'Files' })).toBeVisible();
      await expect(main.getByText('Plain files stored by their fingerprint. Uploading the same file twice keeps one copy. Files aren’t library items.')).toBeVisible();
      await expect(table.getByRole('row')).toHaveCount(1 + 2);
      const archive = table.getByRole('row', { name: new RegExp(ARCHIVE) });
      await expect(archive.getByText('47.1 KiB')).toBeVisible();
      await expect(archive.getByText(/Private to members/)).toBeVisible();
      await expect(table.getByRole('row', { name: CSV_ROW }).getByText(/Public by fingerprint/)).toBeVisible();
      await expect(main.getByRole('navigation', { name: 'Project sections' }).getByRole('link', { name: 'Files' })).toHaveAttribute('aria-current', 'page');
      await expect(main.getByRole('meter', { name: 'Storage used' })).toHaveAttribute('aria-valuetext', '65.1 KiB of 5 GiB');
      await expect(main.getByText('Storage · sponsored by you')).toBeVisible();
      await expect(main.getByText('Up to 128 MiB each on the RESEARCH plan')).toBeVisible();
      await capture(page, testInfo, `files-${name}-success`);

      // The dialog of a deletion says what goes; the gateway’s 409 stays inside it.
      await table.getByRole('button', { name: `Delete ${ARCHIVE}` }).click();
      const dialog = page.getByRole('dialog', { name: `Delete ${ARCHIVE}?` });
      state.refuse.deleteFile = detail(409, 'in_use', 'A sealed version refers to this file.');
      await dialog.getByRole('button', { name: 'Delete file' }).click();
      await expect(dialog.getByRole('alert')).toContainText(`“${ARCHIVE}” is used by a sealed version, so it can’t be deleted (409 · in_use).`);
      await capture(page, testInfo, `files-${name}-delete-409`);
      if (isMobile) {
        expect(critical).toEqual([]);
        return;
      }

      // Deleted: the row goes and the toast says so.
      state.refuse.deleteFile = undefined;
      await dialog.getByRole('button', { name: 'Delete file' }).click();
      await expect(main.getByText(`“${ARCHIVE}” deleted.`)).toBeVisible();
      expect(state.sent.deleted).toBe(digestOf('a'));
      await expect(table.getByRole('row')).toHaveCount(1 + 1);

      // An upload keeps its name for this visit, and may be public by fingerprint.
      await main.getByLabel('Readable by anyone with the fingerprint').check();
      const posted = request(page, 'POST', `${API_ROOT}/blobs`);
      await main.getByLabel('Files to upload').setInputFiles(csvFile('results.csv'));
      expect((await posted).url()).toContain('public=true');
      await expect(main.getByText('Uploaded “results.csv”. Copy its fingerprint to reference it.')).toBeVisible();
      expect(state.sent.uploadType).toBe('text/csv');
      const uploaded = table.getByRole('row', { name: /results\.csv/ });
      await expect(uploaded.getByText(/Uploaded in this visit/)).toBeVisible();
      await expect(table.getByRole('row')).toHaveCount(1 + 2);
      await capture(page, testInfo, `files-${name}-uploaded`);

      // The sponsor’s storage is full (402), then the file is over the plan’s ceiling (413).
      state.refuse.upload = detail(402, 'storage_quota_exceeded', 'The sponsor storage allowance would be exceeded.', {
        quota: { limit_id: 'storageBytes', limit: 5_368_709_120, used: 5_368_709_120 },
      });
      await main.getByLabel('Files to upload').setInputFiles(csvFile('more.csv', 'x,y\n3,4\n'));
      await expect(main.getByRole('alert')).toContainText('No storage left for the sponsor (402 · storage_quota_exceeded). 5 GiB of 5 GiB used.');
      await expect(main.getByRole('link', { name: 'See usage' })).toHaveAttribute('href', '/app/account/usage');
      await capture(page, testInfo, `files-${name}-402`);
      state.refuse.upload = detail(413, 'artifact_too_large', 'The artifact exceeds this account’s per-request payload limit.');
      await main.getByLabel('Files to upload').setInputFiles(csvFile('more.csv', 'x,y\n3,4\n'));
      await expect(main.getByRole('alert')).toContainText('That file is bigger than your plan allows per upload (128 MiB on the RESEARCH plan) (413 · artifact_too_large).');
      await capture(page, testInfo, `files-${name}-413`);

      // A key that cannot write: the screen turns read-only and the downloads stay.
      state.refuse.upload = detail(403, 'forbidden', 'The API key does not include artifacts:write.');
      await main.getByLabel('Files to upload').setInputFiles(csvFile('more.csv', 'x,y\n3,4\n'));
      await expect(main.getByText('This account or API key can’t write files (403 · forbidden). You can still list and download.')).toBeVisible();
      await expect(main.getByLabel('Files to upload')).toHaveCount(0);
      await capture(page, testInfo, `files-${name}-403-key`);

      // Reading the page again leaves the read-only state behind: the upload is offered once more.
      state.refuse.upload = undefined;
      await page.goto(FILES);
      await expect(table.getByRole('row')).toHaveCount(1 + 2);
      await expect(main.getByLabel('Files to upload')).toHaveCount(1);
      expect(critical).toEqual([]);
    });

    test('proj-files /app/:org/:project/files · downloads, archives, other roles and failures', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      await page.goto(FILES);
      const main = page.locator('#platform-main');
      const table = main.getByRole('region', { name: 'Files' });
      await expect(table.getByRole('row')).toHaveCount(1 + 2);

      const downloaded = page.waitForEvent('download');
      await table.getByRole('button', { name: `Download ${ARCHIVE}` }).click();
      expect((await downloaded).suggestedFilename()).toBe('sha256-aaaaaaaaaaaa.zip');
      await expect(table.getByRole('button', { name: `Download ${ARCHIVE}` })).toContainText('Downloaded');

      await table.getByRole('button', { name: `Look inside ${ARCHIVE}` }).click();
      const inside = page.getByRole('dialog', { name: `Inside ${ARCHIVE}` });
      const entries = inside.getByRole('list', { name: 'Files in the archive' });
      await expect(entries.getByRole('listitem')).toHaveCount(3);
      await expect(entries.getByText('package/manifest.json')).toBeVisible();
      await capture(page, testInfo, `files-${name}-look-inside`);
      // The capture has taken the focus off the dialog, so Escape would not reach it: close it with its own button.
      await inside.getByRole('button', { name: 'Close' }).first().click();
      await expect(inside).toHaveCount(0);

      // A VIEWER downloads and has nothing that writes.
      await page.goto('/app/consultora-demo/client-case/files');
      await expect(main.getByRole('note')).toContainText('You’re a VIEWER. You can download files; uploading needs MEMBER and deleting needs ADMIN.');
      await expect(main.getByLabel('Files to upload')).toHaveCount(0);
      await expect(main.getByRole('button', { name: /^Delete / })).toHaveCount(0);
      await expect(main.getByRole('button', { name: `Download ${ARCHIVE}` })).toBeVisible();
      await expect(main.getByText('Storage · sponsored by another account')).toBeVisible();
      await expect(main.getByText(/The sponsor’s allowance isn’t shown to you\./)).toBeVisible();
      await capture(page, testInfo, `files-${name}-viewer`);

      // A MEMBER uploads and cannot delete.
      await page.goto('/app/member-lab/bench/files');
      await expect(main.getByText('No files yet')).toBeVisible();
      await expect(main.getByText('Drop files to upload')).toBeVisible();
      await capture(page, testInfo, `files-${name}-empty`);

      // The list fails and comes back; a key limited to other projects is told so.
      state.refuse.files = unavailable;
      await page.goto(FILES);
      await expect(main.getByRole('alert')).toContainText('The files couldn’t be loaded (503)');
      await capture(page, testInfo, `files-${name}-error`);
      state.refuse.files = undefined;
      await main.getByRole('button', { name: 'Retry' }).click();
      await expect(table.getByRole('row')).toHaveCount(1 + 2);
      state.refuse.files = detail(403, 'api_key_boundary', 'The API key boundary excludes this project.');
      await page.goto(FILES);
      await expect(main.getByText('This account or API key can’t list this project’s files (403 · api_key_boundary).')).toBeVisible();
      await expect(main.getByRole('button', { name: 'Retry' })).toHaveCount(0);
      await capture(page, testInfo, `files-${name}-403-list`);

      // A project the account is not in reads like one that is missing.
      await page.goto('/app/isa-demo/ghost/files');
      await expect(main.getByRole('heading', { name: 'Project not found' })).toBeVisible();
      expect(critical).toEqual([]);
    });

    test('proj-resources /app/:org/:project/resources', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      await page.goto(RESOURCES);
      const main = page.locator('#platform-main');
      const table = main.getByRole('region', { name: 'Project resources' });

      await expect(main.getByRole('heading', { level: 1, name: 'Project resources' })).toBeVisible();
      await expect(table.getByRole('row')).toHaveCount(1 + 3);
      const weightsRow = table.getByRole('row', { name: /Weights/ });
      await expect(weightsRow.getByRole('link', { name: 'Weights' })).toHaveAttribute('href', `${RESOURCES}/weights`);
      await expect(weightsRow.getByText('Dataset', { exact: true })).toBeVisible();
      await expect(weightsRow.getByText('revision 2')).toBeVisible();
      await expect(table.getByRole('row', { name: /Weighted goal/ }).getByText('Goal', { exact: true })).toBeVisible();
      await expect(table.getByRole('row', { name: /Notes/ }).getByText('none yet')).toBeVisible();
      await expect(main.getByRole('navigation', { name: 'Project sections' }).getByRole('link', { name: 'Library' })).toHaveAttribute('aria-current', 'page');
      await expect(main.getByRole('navigation', { name: 'Library sections' }).getByText('Project resources (older view)')).toHaveAttribute('aria-current', 'page');
      const note = main.getByRole('note').filter({ hasText: 'Recommended' });
      await expect(note.getByRole('link', { name: 'Open the library' })).toHaveAttribute('href', '/app/isa-demo/library');
      await capture(page, testInfo, `resources-${name}-success`);

      // The dialog of a new resource, with the gateway’s 409 and 422.
      await main.getByRole('button', { name: 'New resource' }).click();
      const dialog = page.getByRole('dialog', { name: 'New project resource' });
      await dialog.getByLabel('Name', { exact: true }).fill('Search weights');
      await expect(dialog.getByLabel('Address')).toHaveValue('search-weights');
      state.refuse.createResource = detail(409, 'slug_conflict', 'That resource slug is in use.');
      // Submitted with Enter: on a phone the on-screen keyboard moves the buttons while a field has focus.
      await dialog.getByLabel('Name', { exact: true }).press('Enter');
      await expect(dialog.getByRole('alert')).toContainText('That address is already used by another item in this organization (409 · slug_conflict).');
      await capture(page, testInfo, `resources-${name}-dialog-409`);
      if (isMobile) {
        expect(critical).toEqual([]);
        return;
      }

      state.refuse.createResource = invalid('String should match pattern');
      await dialog.getByRole('button', { name: 'Create' }).click();
      await expect(dialog.getByRole('alert')).toContainText('Use lowercase letters, numbers and hyphens for the address (422)');
      await capture(page, testInfo, `resources-${name}-dialog-422`);

      // A kind the library owns is sent to the library instead of creating a resource that would never be listed.
      await dialog.getByLabel('Kind', { exact: true }).selectOption('__other');
      await dialog.getByLabel('Kind name').fill('CandidateCatalog');
      await dialog.getByRole('button', { name: 'Create' }).click();
      await expect(dialog.getByRole('alert')).toContainText('CandidateCatalog items live in the library');

      // Created: the first revision is one click away.
      state.refuse.createResource = undefined;
      await dialog.getByLabel('Kind', { exact: true }).selectOption('Dataset');
      const posted = request(page, 'POST', `${API_ROOT}/resources`);
      await dialog.getByRole('button', { name: 'Create' }).click();
      expect((await posted).postDataJSON()).toEqual({ slug: 'search-weights', name: 'Search weights', description: '', kind: 'Dataset' });
      await expect(main.getByText('Resource “Search weights” created.')).toBeVisible();
      await expect(main.getByRole('link', { name: 'Add its first revision' })).toHaveAttribute('href', `${RESOURCES}/search-weights`);
      await expect(table.getByRole('row')).toHaveCount(1 + 4);
      await capture(page, testInfo, `resources-${name}-created`);

      // Deleting asks first, and keeps the library versions.
      await table.getByRole('button', { name: 'Delete Notes' }).click();
      const remove = page.getByRole('dialog', { name: 'Delete Notes?' });
      await capture(page, testInfo, `resources-${name}-delete-dialog`);
      await remove.getByRole('button', { name: 'Delete resource' }).click();
      await expect(main.getByText('“Notes” deleted from this project. Library versions stay.')).toBeVisible();
      expect(state.sent.deleteResource).toBe('notes');
      await expect(table.getByRole('row')).toHaveCount(1 + 3);
      expect(critical).toEqual([]);
    });

    test('proj-resources /app/:org/:project/resources · other roles and failures', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      const main = page.locator('#platform-main');
      const table = main.getByRole('region', { name: 'Project resources' });

      // Nothing yet is normal for a new project.
      await page.goto('/app/isa-demo/checkout-privado/resources');
      await expect(main.getByText('No project resources')).toBeVisible();
      await expect(main.getByText('That’s normal for new projects: use the library instead.')).toBeVisible();
      await capture(page, testInfo, `resources-${name}-empty`);

      // A VIEWER reads and has nothing that writes.
      await page.goto('/app/consultora-demo/client-case/resources');
      await expect(table.getByRole('row')).toHaveCount(1 + 3);
      await expect(main.getByRole('button', { name: 'New resource' })).toHaveCount(0);
      await expect(main.getByRole('button', { name: /^Delete / })).toHaveCount(0);
      await expect(main.getByRole('note').filter({ hasText: 'You’re a VIEWER' })).toBeVisible();
      await capture(page, testInfo, `resources-${name}-viewer`);

      // A MEMBER creates and cannot delete.
      await page.goto('/app/member-lab/bench/resources');
      await expect(main.getByRole('button', { name: 'New resource' })).toBeVisible();

      // The list fails and comes back.
      state.refuse.resources = unavailable;
      await page.goto(RESOURCES);
      await expect(main.getByRole('alert')).toContainText('The resources couldn’t be loaded (503)');
      await capture(page, testInfo, `resources-${name}-error`);
      state.refuse.resources = undefined;
      await main.getByRole('button', { name: 'Retry' }).click();
      await expect(table.getByRole('row')).toHaveCount(1 + 3);

      // A resource whose revisions cannot be read shows a dash, never a made-up zero.
      state.refuse.resourceRevisions = detail(409, 'content_integrity', 'Resource content is not valid JSON.');
      await page.goto(RESOURCES);
      await expect(table.getByRole('row', { name: /Notes/ }).getByText('—')).toBeVisible();

      await page.goto('/app/isa-demo/ghost/resources');
      await expect(main.getByRole('heading', { name: 'Project not found' })).toBeVisible();
      expect(critical).toEqual([]);
    });

    test('proj-resource-detail /app/:org/:project/resources/:resource', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      await page.goto(`${RESOURCES}/weights`);
      const main = page.locator('#platform-main');

      await expect(main.getByRole('heading', { level: 1, name: 'Weights' })).toBeVisible();
      await expect(main.getByText('Dataset', { exact: true })).toBeVisible();
      await expect(main.getByText('Latency probe results used by the checkout benchmarks.')).toBeVisible();
      const revisions = main.getByRole('list', { name: 'Revisions' });
      await expect(revisions.getByRole('listitem')).toHaveCount(2);
      await expect(revisions.getByRole('listitem').first()).toContainText('Revision 2');
      await expect(revisions.getByRole('listitem').first()).toContainText('Latest');
      await expect(main.getByRole('link', { name: 'Open in library' })).toHaveAttribute('href', '/app/isa-demo/library/resource-weights');
      await expect(main.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('link', { name: 'Resources' })).toHaveAttribute('href', RESOURCES);
      await capture(page, testInfo, `resource-${name}-success`);

      // What a revision holds is shown as fields; the source is behind a control.
      await main.getByRole('button', { name: 'Show what revision 2 holds' }).click();
      await expect(main.getByText('Latency probes', { exact: true })).toBeVisible();
      await expect(main.getByText('View source')).toBeVisible();
      await capture(page, testInfo, `resource-${name}-contents`);

      // A new revision starts from the latest one.
      await main.getByRole('button', { name: 'New revision' }).click();
      const form = main.getByRole('form', { name: /New revision/ });
      await expect(form.getByRole('heading', { name: 'New revision · change what differs from revision 2' })).toBeVisible();
      await expect(form.getByLabel('title', { exact: true })).toHaveValue('Latency probes');
      await expect(form.getByRole('button', { name: 'Save revision' })).toBeDisabled();
      await capture(page, testInfo, `resource-${name}-editor`);
      if (isMobile) {
        expect(critical).toEqual([]);
        return;
      }

      // The gateway’s 422 keeps the form; a good save seals revision 3.
      await form.getByLabel('title', { exact: true }).fill('Latency probes v2');
      state.refuse.saveResourceRevision = invalid('Document is not valid');
      await form.getByRole('button', { name: 'Save revision' }).click();
      await expect(form.getByRole('alert')).toContainText('The gateway refused this content (422)');
      await capture(page, testInfo, `resource-${name}-422`);
      state.refuse.saveResourceRevision = undefined;
      const posted = request(page, 'POST', `${API_ROOT}/resources/weights/revisions`);
      await form.getByRole('button', { name: 'Save revision' }).click();
      expect((await posted).postDataJSON()).toEqual({ document: { title: 'Latency probes v2', samples: 5 } });
      await expect(main.getByText('Revision 3 saved and sealed.')).toBeVisible();
      await expect(revisions.getByRole('listitem')).toHaveCount(3);
      await expect(main.getByRole('form', { name: /New revision/ })).toHaveCount(0);
      await capture(page, testInfo, `resource-${name}-saved`);

      // The details are edited in a dialog.
      await main.getByRole('button', { name: 'Edit details' }).click();
      const dialog = page.getByRole('dialog', { name: 'Edit resource' });
      await dialog.getByLabel('Name', { exact: true }).fill('Weights v2');
      await capture(page, testInfo, `resource-${name}-edit-dialog`);
      await dialog.getByLabel('Name', { exact: true }).press('Enter');
      await expect(main.getByText('Details saved.')).toBeVisible();
      expect(state.sent.updateResource).toEqual({ name: 'Weights v2', description: 'Latency probe results used by the checkout benchmarks.', kind: 'Dataset' });
      await expect(main.getByRole('heading', { level: 1, name: 'Weights v2' })).toBeVisible();
      expect(critical).toEqual([]);
    });

    test('proj-resource-detail /app/:org/:project/resources/:resource · empty, other roles and failures', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      const main = page.locator('#platform-main');

      // A resource with no revision says how to get one, and the first one starts from an empty document.
      await page.goto(`${RESOURCES}/notes`);
      await expect(main.getByText('No revisions yet')).toBeVisible();
      await expect(main.getByText('Add the first revision to give this resource content.')).toBeVisible();
      await capture(page, testInfo, `resource-${name}-empty`);
      await main.getByRole('button', { name: 'New revision' }).click();
      await expect(main.getByRole('heading', { name: 'First revision · fill in what this resource holds' })).toBeVisible();
      await capture(page, testInfo, `resource-${name}-first-revision`);

      // A VIEWER reads every revision and has nothing that writes.
      await page.goto('/app/consultora-demo/client-case/resources/weights');
      await expect(main.getByRole('note')).toContainText('You’re a VIEWER. You can read every revision; adding one needs MEMBER.');
      await expect(main.getByRole('button', { name: 'New revision' })).toHaveCount(0);
      await expect(main.getByRole('button', { name: 'Edit details' })).toHaveCount(0);
      await capture(page, testInfo, `resource-${name}-viewer`);

      // A resource that is not in the project.
      await page.goto(`${RESOURCES}/ghost`);
      await expect(main.getByRole('heading', { name: 'Resource not found' })).toBeVisible();
      await expect(main.getByText('This resource doesn’t exist in QoS Benchmarks (404 · not_found).')).toBeVisible();
      await expect(main.getByRole('link', { name: 'All resources' })).toHaveAttribute('href', RESOURCES);
      await capture(page, testInfo, `resource-${name}-404`);

      // The revisions fail and come back; the header stays.
      state.refuse.resourceRevisions = unavailable;
      await page.goto(`${RESOURCES}/weights`);
      await expect(main.getByRole('alert')).toContainText('The revisions couldn’t be loaded (503)');
      await expect(main.getByRole('heading', { level: 1, name: 'Weights' })).toBeVisible();
      await capture(page, testInfo, `resource-${name}-error`);
      state.refuse.resourceRevisions = undefined;
      await main.getByRole('button', { name: 'Retry' }).click();
      await expect(main.getByRole('list', { name: 'Revisions' }).getByRole('listitem')).toHaveCount(2);

      await page.goto('/app/isa-demo/ghost/resources/weights');
      await expect(main.getByRole('heading', { name: 'Project not found' })).toBeVisible();
      expect(critical).toEqual([]);
    });

    test('coll-list /app/:org/:project/collections', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      await page.goto(COLLECTIONS);
      const main = page.locator('#platform-main');
      const cards = main.getByRole('list', { name: 'Collections' });

      await expect(main.getByRole('heading', { level: 1, name: 'Collections' })).toBeVisible();
      await expect(cards.getByRole('listitem')).toHaveCount(2);
      const first = cards.getByRole('listitem').first();
      await expect(first.getByRole('link', { name: 'Referencias checkout' })).toHaveAttribute('href', `${COLLECTIONS}/referencias-checkout`);
      await expect(first.getByText('2 case revisions')).toBeVisible();
      await expect(first.getByText('1 resource version')).toBeVisible();
      await expect(first.getByText('3 items · revision 2')).toBeVisible();
      await expect(cards.getByRole('listitem').nth(1).getByText('No revision yet')).toBeVisible();
      await expect(main.getByRole('navigation', { name: 'Library sections' }).getByText('Collections')).toHaveAttribute('aria-current', 'page');
      await expect(main.getByRole('meter', { name: 'Sponsor’s collections used' })).toHaveAttribute('aria-valuetext', '2 of 50');
      await capture(page, testInfo, `collections-${name}-success`);

      // The dialog of a new collection, with the sponsor’s 402 and the 409.
      await main.getByRole('button', { name: 'New collection' }).click();
      const dialog = page.getByRole('dialog', { name: 'New collection' });
      await dialog.getByLabel('Name', { exact: true }).fill('Mi lista');
      await expect(dialog.getByLabel('Address')).toHaveValue('mi-lista');
      state.refuse.createCollection = detail(402, 'sponsor_quota_exceeded', 'The sponsor allowance would be exceeded.', { quota: { limit_id: 'collections', limit: 50, used: 51 } });
      // Submitted with Enter: on a phone the on-screen keyboard moves the buttons while a field has focus.
      await dialog.getByLabel('Name', { exact: true }).press('Enter');
      await expect(dialog.getByRole('alert')).toContainText('The sponsor has no collections left (402 · sponsor_quota_exceeded). 51 of 50 collections are used.');
      await capture(page, testInfo, `collections-${name}-dialog-402`);
      if (isMobile) {
        expect(critical).toEqual([]);
        return;
      }

      state.refuse.createCollection = detail(409, 'slug_conflict', 'That collection slug is in use.');
      await dialog.getByRole('button', { name: 'Create' }).click();
      await expect(dialog.getByRole('alert')).toContainText('That address is already used by another collection in this organization (409 · slug_conflict).');
      await capture(page, testInfo, `collections-${name}-dialog-409`);

      // Created: its first items are one click away.
      state.refuse.createCollection = undefined;
      const posted = request(page, 'POST', `${API_ROOT}/collections`);
      await dialog.getByRole('button', { name: 'Create' }).click();
      expect((await posted).postDataJSON()).toEqual({ slug: 'mi-lista', name: 'Mi lista', description: '' });
      await expect(main.getByText('Collection “Mi lista” created.')).toBeVisible();
      await expect(main.getByRole('link', { name: 'Add its first items' })).toHaveAttribute('href', `${COLLECTIONS}/mi-lista`);
      await expect(cards.getByRole('listitem')).toHaveCount(3);
      await capture(page, testInfo, `collections-${name}-created`);

      // Deleting asks first and leaves what the collection pointed to untouched.
      await cards.getByRole('button', { name: 'Delete Mi lista' }).click();
      const remove = page.getByRole('dialog', { name: 'Delete Mi lista?' });
      await capture(page, testInfo, `collections-${name}-delete-dialog`);
      await remove.getByRole('button', { name: 'Delete collection' }).click();
      await expect(main.getByText('Mi lista deleted. The things it pointed to are untouched.')).toBeVisible();
      expect(state.sent.deleteCollection).toBe('mi-lista');
      await expect(cards.getByRole('listitem')).toHaveCount(2);
      expect(critical).toEqual([]);
    });

    test('coll-list /app/:org/:project/collections · other roles and failures', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      const main = page.locator('#platform-main');
      const cards = main.getByRole('list', { name: 'Collections' });

      // An empty project explains what a collection is.
      await page.goto('/app/isa-demo/checkout-privado/collections');
      await expect(main.getByText('No collections')).toBeVisible();
      await expect(main.getByText(/Group the cases and resources you want to keep together/)).toBeVisible();
      await capture(page, testInfo, `collections-${name}-empty`);

      // A VIEWER reads, and does not see the sponsor’s allowance.
      await page.goto('/app/consultora-demo/client-case/collections');
      await expect(cards.getByRole('listitem')).toHaveCount(2);
      await expect(main.getByRole('button', { name: 'New collection' })).toHaveCount(0);
      await expect(main.getByRole('button', { name: /^Delete / })).toHaveCount(0);
      await expect(main.getByText(/the sponsor’s allowance isn’t shown to you/)).toBeVisible();
      await capture(page, testInfo, `collections-${name}-viewer`);

      // The list fails and comes back; a key that cannot read collections is told so.
      state.refuse.collections = unavailable;
      await page.goto(COLLECTIONS);
      await expect(main.getByRole('alert')).toContainText('The collections couldn’t be loaded (503)');
      await capture(page, testInfo, `collections-${name}-error`);
      state.refuse.collections = undefined;
      await main.getByRole('button', { name: 'Retry' }).click();
      await expect(cards.getByRole('listitem')).toHaveCount(2);
      state.refuse.collections = detail(403, 'forbidden', 'The API key does not include collections:read.');
      await page.goto(COLLECTIONS);
      await expect(main.getByText('This account or API key can’t read this project’s collections (403 · forbidden).')).toBeVisible();

      await page.goto('/app/isa-demo/ghost/collections');
      await expect(main.getByRole('heading', { name: 'Project not found' })).toBeVisible();
      expect(critical).toEqual([]);
    });

    test('coll-detail /app/:org/:project/collections/:collection', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      await page.goto(`${COLLECTIONS}/referencias-checkout`);
      const main = page.locator('#platform-main');
      const items = main.getByRole('list', { name: 'Items' });

      await expect(main.getByRole('heading', { level: 1, name: 'Referencias checkout' })).toBeVisible();
      await expect(items.getByRole('listitem')).toHaveCount(3);
      await expect(items.getByRole('link', { name: 'Flujo de checkout · revision 1' })).toHaveAttribute('href', `${ROOT}/cases/flujo-checkout/revisions/1`);
      await expect(items.getByRole('link', { name: 'Weights · revision 1' })).toHaveAttribute('href', `${RESOURCES}/weights`);
      await expect(main.getByText('Revision 2 · 3 items · What a reviewer needs to reproduce the published comparison.')).toBeVisible();
      await expect(main.getByRole('button', { name: 'Revision 2 · 3 items' })).toHaveAttribute('aria-pressed', 'true');
      await expect(main.getByRole('link', { name: 'Start a study from this' })).toHaveAttribute('href', `${ROOT}/studies/new?collection=referencias-checkout`);
      await capture(page, testInfo, `collection-${name}-success`);

      // Reordering marks the list as unsaved; the comparison names what moved.
      await main.getByRole('button', { name: 'Move Flujo de checkout · revision 2 up' }).click();
      await expect(main.getByText('Unsaved changes to the list. Saving creates a new sealed revision; the previous one stays as it was.')).toBeVisible();
      await main.getByRole('button', { name: 'Compare revisions' }).click();
      const compare = main.getByRole('region', { name: 'Your changes vs revision 2' });
      await expect(compare.getByRole('list', { name: 'Differences' }).getByRole('listitem')).toHaveCount(2);
      await expect(compare.getByRole('listitem').first()).toContainText('Moved');
      await capture(page, testInfo, `collection-${name}-unsaved-compare`);

      // The picker offers what is not in the list yet, from the project’s cases and resources.
      await main.getByRole('button', { name: 'Add item' }).click();
      const picker = page.getByRole('dialog', { name: 'Add an item' });
      await expect(picker.getByRole('list', { name: 'Cases' }).getByRole('button')).toHaveCount(1);
      await expect(picker.getByRole('button', { name: 'Add Flujo de checkout · revision 3' })).toBeVisible();
      await capture(page, testInfo, `collection-${name}-picker`);
      if (isMobile) {
        expect(critical).toEqual([]);
        return;
      }

      await picker.getByRole('button', { name: 'Add Flujo de checkout · revision 3' }).click();
      await expect(items.getByRole('listitem')).toHaveCount(4);

      // The gateway’s 422s keep the list: a repeated item, then a fingerprint that is no longer valid.
      state.refuse.saveCollectionRevision = invalid('Value error, a collection revision cannot repeat a target');
      await main.getByRole('button', { name: 'Save as revision 3' }).click();
      await expect(main.getByRole('alert')).toContainText('An item appears twice (422)');
      await capture(page, testInfo, `collection-${name}-422-duplicate`);
      state.refuse.saveCollectionRevision = detail(422, 'collection_target_mismatch', 'The collection target must belong to this project and match its pinned digest.');
      await main.getByRole('button', { name: 'Save as revision 3' }).click();
      await expect(main.getByRole('alert')).toContainText('An item’s fingerprint isn’t valid any more (422 · collection_target_mismatch)');
      await capture(page, testInfo, `collection-${name}-422-fingerprint`);
      await expect(items.getByRole('listitem')).toHaveCount(4);

      // Saved: revision 3 holds the list in the order it was in.
      state.refuse.saveCollectionRevision = undefined;
      const posted = request(page, 'POST', `${API_ROOT}/collections/referencias-checkout/revisions`);
      await main.getByRole('button', { name: 'Save as revision 3' }).click();
      const sent = (await posted).postDataJSON() as { items: CollectionItem[] };
      expect(sent.items.map((item) => `${item.target_kind}:${String(item.target_ref.caseRevisionId ?? item.target_ref.resourceRevisionId)}`)).toEqual([
        'case:case-flujo-checkout-r2', 'case:case-flujo-checkout-r1', 'resource:resource-weights-r1', 'case:case-flujo-checkout-r3',
      ]);
      await expect(main.getByText('Revision 3 saved and sealed.')).toBeVisible();
      await expect(main.getByRole('button', { name: 'Revision 3 · 4 items' })).toHaveAttribute('aria-pressed', 'true');
      await expect(main.getByText(/Unsaved changes/)).toHaveCount(0);
      await capture(page, testInfo, `collection-${name}-saved`);

      // An earlier revision is read without editing it.
      await main.getByRole('button', { name: 'Revision 1 · 2 items' }).click();
      await expect(main.getByText('You’re reading revision 1, not the latest. It never changes.')).toBeVisible();
      await expect(items.getByRole('listitem')).toHaveCount(2);
      await expect(main.getByRole('button', { name: /^Move / })).toHaveCount(0);
      await capture(page, testInfo, `collection-${name}-older-revision`);
      expect(critical).toEqual([]);
    });

    test('coll-detail /app/:org/:project/collections/:collection · empty, other roles and failures', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      const main = page.locator('#platform-main');
      const items = main.getByRole('list', { name: 'Items' });

      // A collection with no revision says how to get one.
      await page.goto(`${COLLECTIONS}/vacia`);
      await expect(main.getByText('No items yet')).toBeVisible();
      await expect(main.getByText('Add cases or resources to make the first revision.')).toBeVisible();
      await expect(main.getByRole('button', { name: 'Save as revision 1' })).toBeDisabled();
      await capture(page, testInfo, `collection-${name}-empty`);

      // A VIEWER reads, compares and exports, and has nothing that writes.
      await page.goto('/app/consultora-demo/client-case/collections/referencias-checkout');
      await expect(items.getByRole('listitem')).toHaveCount(3);
      await expect(main.getByRole('note')).toContainText('You’re a VIEWER. You can read every revision and compare them; adding, reordering and saving need MEMBER.');
      await expect(main.getByRole('button', { name: 'Add item' })).toHaveCount(0);
      await expect(main.getByRole('button', { name: /^Move / })).toHaveCount(0);
      await expect(main.getByRole('button', { name: 'Compare revisions' })).toBeVisible();
      await main.getByRole('button', { name: 'Compare revisions' }).click();
      await expect(main.getByRole('region', { name: 'Revision 2 vs revision 1' }).getByText('Added', { exact: true })).toBeVisible();
      await capture(page, testInfo, `collection-${name}-viewer`);

      // A collection that is not in the project.
      await page.goto(`${COLLECTIONS}/ghost`);
      await expect(main.getByRole('heading', { name: 'Collection not found' })).toBeVisible();
      await expect(main.getByText('No collection with this address in QoS Benchmarks (404 · not_found).')).toBeVisible();
      await expect(main.getByRole('link', { name: 'All collections' })).toHaveAttribute('href', COLLECTIONS);
      await capture(page, testInfo, `collection-${name}-404`);

      // The revisions fail and come back; the header stays.
      state.refuse.collectionRevisions = unavailable;
      await page.goto(`${COLLECTIONS}/referencias-checkout`);
      await expect(main.getByRole('alert')).toContainText('The revisions couldn’t be loaded (503)');
      await expect(main.getByRole('heading', { level: 1, name: 'Referencias checkout' })).toBeVisible();
      await capture(page, testInfo, `collection-${name}-error`);
      state.refuse.collectionRevisions = undefined;
      await main.getByRole('button', { name: 'Retry' }).click();
      await expect(items.getByRole('listitem')).toHaveCount(3);
      if (isMobile) {
        expect(critical).toEqual([]);
        return;
      }

      // Renaming is inline and keeps the description.
      await main.getByRole('button', { name: 'Rename' }).click();
      const rename = main.getByRole('form', { name: 'Rename the collection' });
      await rename.getByLabel('Name', { exact: true }).fill('Referencias del checkout');
      await capture(page, testInfo, `collection-${name}-rename`);
      await rename.getByRole('button', { name: 'Save' }).click();
      await expect(main.getByText('Name saved.')).toBeVisible();
      expect(state.sent.updateCollection).toEqual({ name: 'Referencias del checkout', description: 'What a reviewer needs to reproduce the published comparison.' });
      await expect(main.getByRole('heading', { level: 1, name: 'Referencias del checkout' })).toBeVisible();

      // The manifest of the revision on show is downloaded.
      const exported = page.waitForEvent('download');
      await main.getByRole('button', { name: 'Export manifest' }).click();
      expect((await exported).suggestedFilename()).toBe('collection-referencias-checkout-r2.json');

      await page.goto('/app/isa-demo/ghost/collections/referencias-checkout');
      await expect(main.getByRole('heading', { name: 'Project not found' })).toBeVisible();
      expect(critical).toEqual([]);
    });
  });
}
