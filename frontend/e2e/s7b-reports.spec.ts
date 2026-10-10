import { createHash } from 'node:crypto';
import { expect as baseExpect, test, type Locator, type Page, type Route, type TestInfo } from '@playwright/test';
import type { ArchiveQuery, ArchiveResponse, ArchiveRow, ArchiveSource } from '../src/analysis/archive';
import type { Publication, Report, VerifierEntity, VerifierVerdict } from '../src/api/platform';
import { CURRENT_FIXTURE, catalogFixture } from '../src/pages/Pricing/pricingFixture';
import { ID_FASTPAY, ID_PAYCO, JOB_DONE, JOB_OLD, JOB_SECOND, ROWS, SOURCES, archiveOf, detailOf } from '../src/test/fixtures/analysis';
import { DRAFT, EDITION, FROZEN, LEGACY, PROVENANCE, publicationOf, reportOf } from '../src/test/fixtures/reports';
import { usageOf } from '../src/test/fixtures/resources';
import { RUN_ID, cellsFixture, digestOf, runFixture, studyFixture } from '../src/test/fixtures/studies';

// S7b · analysis and reports: analysis-sources, analysis-workspace, rep-list, rep-detail, proj-publications and verifier.
// There is no backend: the API origin is answered by page.route(). Screenshots go to testInfo.outputPath() (test-results/, ignored by git)
// so they can be looked at after a run. Every test walks a screen through its states on a desktop and on a phone.

const API = 'http://localhost:8000';

// Several browsers share one development server, so a screen can take longer than the default five seconds to settle.
const expect = baseExpect.configure({ timeout: 15_000 });

type Handler = (route: Route) => Promise<void> | void;
const json = (body: unknown, status = 200): Handler => (route) => route.fulfill({ status, json: body });
const detail = (status: number, code: string, error: string, extra: Record<string, unknown> = {}): Handler => json({ detail: { code, error, ...extra } }, status);
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

const project = (n: number, orgId: string, slug: string, name: string) => ({
  id: `project-${n}`, organization_id: orgId, slug, name, description: '', visibility: 'private', created_by_id: 'user-1',
  created_at: '2026-04-01T00:00:00Z', updated_at: '2026-10-08T00:00:00Z',
});

const projectsOf: Record<string, ReturnType<typeof project>[]> = {
  'isa-demo': [project(1, 'org-isa-demo', 'qos-benchmarks', 'QoS Benchmarks'), project(2, 'org-isa-demo', 'checkout-privado', 'Checkout (privado)')],
  'read-lab': [project(4, 'org-4', 'bench', 'Bench')],
};

// --- the analysis

const KEY_CHANGED = 'The source archive has changed; reload before making this decision';
const FRONT_TASK = { id: 'task-1', revision: archiveOf().revision, scope: 'archive', layers: false, error: null, result: null };

/** The two bindings ranked the way the gateway would under the weights and limit of a query: a balanced rule takes the worst weighted loss, a weighted sum their total. */
function answerFor(query: ArchiveQuery, frontDone: boolean): ArchiveResponse {
  const weight = { cost: query.weights?.cost ?? 1, latency: query.weights?.latency ?? 1 };
  const total = weight.cost + weight.latency || 1;
  const shares = { cost: weight.cost / total, latency: weight.latency / total };
  const limit = query.requirements?.find((requirement) => requirement.dimension === 'latency')?.value;
  const rows: ArchiveRow[] = [ROWS.payco, ROWS.fastpay].map((row) => {
    const eligible = limit === undefined || (row.values?.[1] ?? 0) <= limit;
    const losses = [(row.normalized?.[0] ?? 0) * shares.cost, (row.normalized?.[1] ?? 0) * shares.latency];
    const score = query.rule === 'weighted' ? losses[0] + losses[1] : Math.max(...losses);
    return { ...row, eligible, reasons: eligible ? [] : [`Latency ${row.values?.[1]} ms is above the limit of ${limit} ms.`], score: eligible ? [Number(score.toFixed(3))] : null, rank: null, paretoRank: frontDone ? 1 : null };
  });
  const ordered = rows.filter((row) => row.eligible).sort((a, b) => (a.score?.[0] ?? 0) - (b.score?.[0] ?? 0));
  ordered.forEach((row, index) => { row.rank = index + 1; row.scoreGroup = index + 1; });
  const table = [...ordered, ...rows.filter((row) => !row.eligible)];
  return archiveOf({
    rule: query.rule ?? 'balanced', weights: shares, rows: table, total: table.length, winners: ordered.slice(0, 1), winnerCount: ordered.length ? 1 : 0, next: ordered.slice(1, 2), nextCount: ordered.length > 1 ? 1 : 0,
    counts: { unique: 2, stored: 2, eligible: ordered.length, infeasible: 0, unknown: 0 },
    pareto: frontDone
      ? { state: 'front-complete', scope: 'archive', count: 2, frontCount: 2, meaning: 'Both bindings are non-dominated.', hypervolume: null }
      : { state: 'uncomputed', scope: 'archive', count: 2, frontCount: null, meaning: 'Pareto not computed.', hypervolume: null },
    plot: {
      axes: [0, 1], bounds: [0, 0, 1, 1], count: 2, aggregated: false, bins: [],
      points: table.map((row) => ({ id: row.id, x: row.normalized?.[0] ?? 0, y: row.normalized?.[1] ?? 0, feasible: true, eligible: row.eligible, paretoRank: row.paretoRank })),
    },
    budgets: query.view === 'budgets'
      ? {
        available: true, axes: [0, 1], signs: [1, 1], bounds: [0.1, 300, 0.14, 450], selected: [null, null], resolution: 64, aggregated: false, cornerCount: 2, witnessCount: 2,
        corners: [{ x: 0.118, y: 412, id: ID_PAYCO }, { x: 0.131, y: 327, id: ID_FASTPAY }], tiles: [], excluded: [], skipped: [],
        meaning: 'Each rung is the best latency some stored binding reaches within that cost.', detail: 'Achieved budgets from 2 stored bindings.',
      }
      : null,
    geometry: query.view === 'preferences' && query.geometry === 'sensitivity'
      ? {
        kind: 'sensitivity', state: 'complete', axis: 0, meaning: 'The winner as the priority on cost grows from none to all.',
        scenarios: [{ t: 0, winners: [ID_FASTPAY], winnerCount: 1, score: [0.1] }, { t: 0.5, winners: [ID_FASTPAY], winnerCount: 1, score: [0.2] }, { t: 0.6, winners: [ID_PAYCO], winnerCount: 1, score: [0.2] }, { t: 1, winners: [ID_PAYCO], winnerCount: 1, score: [0.3] }],
      }
      : null,
  });
}

// --- the evidence the verifier can find

const FILE_BYTES = 'a,b\n1,2\n';
const sha = (data: string | Buffer) => `sha256-${createHash('sha256').update(data).digest('hex')}`;
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
};

const reportEntity: VerifierEntity = {
  entity_type: 'report', id: 'report-1', slug: 'engine-comparison', title_or_name: 'Engine comparison at checkout',
  organization_slug: 'isa-demo', project_slug: 'qos-benchmarks', created_at: '2026-09-25T09:00:00Z',
};
const fileEntity: VerifierEntity = {
  entity_type: 'artifact', id: 'blob-1', title_or_name: 'Blob (text/csv, 8 B)', organization_slug: 'isa-demo', project_slug: 'qos-benchmarks', created_at: '2026-09-26T09:00:00Z',
};
const caseEntity: VerifierEntity = {
  entity_type: 'case', id: 'case-1', slug: 'flujo-checkout', title_or_name: 'Flujo de checkout (r2)', organization_slug: 'isa-demo', project_slug: 'checkout-privado', created_at: '2026-08-20T09:00:00Z', revision: 2,
};

const verdictOf = (status: VerifierVerdict['status'], digest: string, entities: VerifierEntity[], extra: Partial<VerifierVerdict> = {}): VerifierVerdict => ({
  status, digest, matches: status !== 'mismatch' && status !== 'not_found', verified_at: '2026-10-09T10:00:00Z', entities,
  detail: entities.length ? `Cryptographically verified against ${entities.length} registered entities.` : 'Digest not registered in platform ledger.', ...extra,
});

// --- what the gateway answers

type Overridable = 'sources' | 'query' | 'candidate' | 'save' | 'reports' | 'update' | 'freeze' | 'publish' | 'withdraw' | 'remove' | 'publications' | 'report' | 'verify' | 'verifyFile';

interface State {
  /** A handler that replaces the default answer of one call. */
  refuse: Partial<Record<Overridable, Handler>>;
  sent: {
    queries: ArchiveQuery[]; candidates: ArchiveQuery[]; save?: Record<string, unknown>; created?: Record<string, unknown>; updated: Array<Record<string, unknown>>;
    frozen: string[]; published?: Record<string, unknown>; withdrawn: string[]; removed: string[]; drafts: string[]; verify: Array<Record<string, unknown>>; verifyFile: number;
  };
  sources: ArchiveSource[];
  reports: Report[];
  publications: Publication[];
  /** The background front reports this state when asked. */
  front: 'running' | 'completed' | 'cancelled';
  frontDone: boolean;
}

interface MockOptions {
  /** The account's role in ISA Demo Group. */
  role?: Role;
}

const bodyOf = <T = Record<string, unknown>>(route: Route) => route.request().postDataJSON() as T;

const DECISION_DOCUMENT = {
  kind: 'binding-decision', version: 'binding-archive/v1', revision: archiveOf().revision, sources: [{ id: JOB_DONE, engine: 'random-search', resultDigest: digestOf('f') }], dimensions: [],
  query: { sources: [JOB_DONE], rule: 'balanced', weights: { cost: 1, latency: 2 }, revision: archiveOf().revision, compare: [], page: 0 },
  scope: 'Stored evaluated bindings only; unexplored space remains unknown', selected: [detailOf(ROWS.fastpay)],
};
const DECISION = reportOf('decision-choice', 'draft', { title: 'Checkout choice', document: DECISION_DOCUMENT });

/** Everything these screens read and write, answered; anything else on the API origin is an empty 404. */
async function mockApi(page: Page, options: MockOptions = {}): Promise<State> {
  const state: State = {
    refuse: {},
    sent: { queries: [], candidates: [], updated: [], frozen: [], withdrawn: [], removed: [], drafts: [], verify: [], verifyFile: 0 },
    sources: SOURCES,
    reports: [structuredClone(FROZEN), structuredClone(DRAFT), structuredClone(LEGACY), structuredClone(DECISION)],
    publications: [publicationOf(FROZEN)],
    front: 'running',
    frontDone: false,
  };
  const organizations = [
    org('org-isa-demo', 'isa-demo', 'ISA Demo Group', options.role ?? 'OWNER'),
    org('org-4', 'read-lab', 'Read Lab', 'VIEWER', 'user-nora'),
  ];
  await page.addInitScript(() => {
    localStorage.setItem('openbinding-access-token', 's7b-access');
    localStorage.setItem('openbinding-refresh-token', 's7b-refresh');
  });

  await page.route(`${API}/**`, (route) => route.fulfill({ status: 404, json: { detail: 'not mocked' } }));
  await page.route(`${API}/health**`, json({ status: 'ok' }));
  await page.route(`${API}/v1/auth/refresh`, json({ access_token: 's7b-access-2', refresh_token: 's7b-refresh-2', token_type: 'bearer', expires_in: 900 }));
  await page.route(`${API}/v1/pricing/catalog`, json(catalogFixture));
  await page.route(`${API}/v1/pricing/current`, json(CURRENT_FIXTURE));
  await page.route(`${API}/v1/users/me`, json(lucia));
  await page.route(`${API}/v1/users/me/usage`, json(usageOf({ plan: 'RESEARCH', capabilities: {}, limits: {} })));
  await page.route(`${API}/v1/users/me/pricing-token`, json({ pricing_token: token(3600) }));
  await page.route(new RegExp(`^${API}/v1/notifications(\\?.*)?$`), json([]));
  await page.route(`${API}/v1/engines`, json({ engines: [] }));

  // --- analysis
  await page.route(new RegExp(`^${API}/v1/analysis/sources(\\?.*)?$`), (route) => {
    if (state.refuse.sources) return state.refuse.sources(route);
    return json({ items: state.sources, nextCursor: null })(route);
  });
  await page.route(`${API}/v1/analysis/query`, (route) => {
    const query = bodyOf<ArchiveQuery>(route);
    state.sent.queries.push(query);
    if (state.refuse.query) return state.refuse.query(route);
    return json(answerFor(query, state.frontDone))(route);
  });
  await page.route(`${API}/v1/analysis/candidate`, (route) => {
    const query = bodyOf<ArchiveQuery>(route);
    state.sent.candidates.push(query);
    if (state.refuse.candidate) return state.refuse.candidate(route);
    const answer = answerFor(query, state.frontDone);
    const row = answer.rows.find((item) => item.id === query.selected) ?? answer.winners[0] ?? ROWS.payco;
    const other = answer.rows.find((item) => item.id !== row.id) ?? ROWS.fastpay;
    return json(detailOf(row, (query.compare?.length ?? 0) > 0 ? {
      comparison: [{
        id: other.id, reasons: ['It gives up latency for cost.'], score: other.score, scoreDelta: [0.02],
        changes: [{ task: 'pago-tarjeta', selected: { resource: 'candidate', id: 'payco-eu' }, alternative: { resource: 'candidate', id: 'fastpay' } }],
        dimensions: [{ key: 'cost', selected: 0.118, alternative: 0.131, delta: 0.013, improves: false }, { key: 'latency', selected: 412, alternative: 327, delta: -85, improves: true }],
      }],
    } : {}))(route);
  });
  await page.route(`${API}/v1/analysis/export`, (route) => {
    const body = bodyOf<{ format: string }>(route);
    if (body.format === 'receipt') return json(DECISION_DOCUMENT)(route);
    return route.fulfill({ status: 200, contentType: 'text/csv', body: 'id,cost,latency\n' });
  });
  await page.route(`${API}/v1/analysis/reports`, (route) => {
    state.sent.save = bodyOf(route);
    if (state.refuse.save) return state.refuse.save(route);
    const sent = bodyOf<{ slug: string; title: string }>(route);
    return json(reportOf(sent.slug, 'draft', { title: sent.title, document: DECISION_DOCUMENT }), 201)(route);
  });
  await page.route(`${API}/v1/analysis/pareto`, (route) => {
    state.front = 'running';
    return json({ ...FRONT_TASK, state: 'running', progress: 0.4 })(route);
  });
  await page.route(new RegExp(`^${API}/v1/analysis/pareto/task-1(/cancel)?$`), (route) => {
    if (route.request().url().endsWith('/cancel')) {
      state.front = 'cancelled';
      return json({ ...FRONT_TASK, state: 'cancelled', progress: 0.4 })(route);
    }
    if (state.front === 'completed') state.frontDone = true;
    return json({ ...FRONT_TASK, state: state.front, progress: state.front === 'completed' ? 1 : 0.4, result: state.front === 'completed' ? { complete: true, count: 2, front: [ID_PAYCO, ID_FASTPAY], ranks: null } : null })(route);
  });

  // --- the verifier
  await page.route(`${API}/v1/verifier/inspect`, (route) => {
    const body = bodyOf<{ digest?: string | null; document?: unknown }>(route);
    state.sent.verify.push(body);
    if (state.refuse.verify) return state.refuse.verify(route);
    if (body.document !== undefined && body.document !== null) {
      const computed = sha(canonical(body.document));
      if (body.digest) return json(verdictOf(body.digest === computed ? 'verified' : 'mismatch', body.digest, [], { canonical_json: canonical(body.document) }))(route);
      return json(verdictOf('computed', computed, [], { canonical_json: canonical(body.document), detail: 'Calculated canonical RFC 8785 SHA-256 digest.' }))(route);
    }
    if (body.digest === EDITION) return json(verdictOf('verified', EDITION, [reportEntity]))(route);
    return json(verdictOf('not_found', body.digest ?? '', []))(route);
  });
  await page.route(`${API}/v1/verifier/inspect-file`, (route) => {
    state.sent.verifyFile += 1;
    if (state.refuse.verifyFile) return state.refuse.verifyFile(route);
    const digest = sha(route.request().postDataBuffer() ?? Buffer.alloc(0));
    return json(verdictOf(digest === sha(FILE_BYTES) ? 'verified' : 'computed', digest, digest === sha(FILE_BYTES) ? [fileEntity] : [], { matches: true }))(route);
  });

  // --- projects, reports and publications
  await page.route(new RegExp(`^${API}/v1/organizations(/.*)?(\\?.*)?$`), async (route) => {
    const url = new URL(route.request().url());
    const parts = url.pathname.split('/').filter(Boolean);
    const [, , orgSlug, section, projectSlug, sub, subId, action] = parts;
    const method = route.request().method();
    const found = organizations.find((item) => item.slug === orgSlug);

    if (!orgSlug) return json(organizations)(route);
    if (section === 'members' || section === 'library') return json([])(route);
    if (section !== 'projects') return json(found ?? { detail: { code: 'not_found', error: 'Organization not found.' } }, found ? 200 : 404)(route);

    const list = projectsOf[orgSlug] ?? [];
    if (!projectSlug) return json(list)(route);
    const current = list.find((item) => item.slug === projectSlug);
    if (!current) return detail(404, 'not_found', 'Project not found.')(route);
    if (!sub) return json(current)(route);
    const empty = projectSlug === 'checkout-privado';

    if (sub === 'studies') {
      if (!subId) return json(empty ? [] : [studyFixture()])(route);
      if (action === 'runs') {
        const [, , , , , , , , runId, tail, cellId] = parts;
        if (!runId) return json([runFixture()])(route);
        if (tail === 'cells' && cellId) {
          const cell = cellsFixture().find((item) => item.id === cellId);
          return cell ? json(cell)(route) : detail(404, 'not_found', 'Study cell not found.')(route);
        }
        if (tail === 'cells') return json(cellsFixture())(route);
        return json(runFixture())(route);
      }
      return json(studyFixture())(route);
    }

    if (sub === 'publications') {
      if (method === 'POST') {
        state.sent.published = bodyOf(route);
        if (state.refuse.publish) return state.refuse.publish(route);
        const sent = bodyOf<{ report_id: string; slug: string; citation: Record<string, unknown> }>(route);
        const target = state.reports.find((item) => item.id === sent.report_id);
        if (!target || target.state !== 'frozen') return detail(409, 'report_not_frozen', 'Freeze a report before publishing it.')(route);
        const made = publicationOf(target, { id: `pub-${sent.slug}`, slug: sent.slug, citation: { title: target.title, ...sent.citation } });
        state.publications.push(made);
        return json(made, 201)(route);
      }
      if (method === 'DELETE') {
        state.sent.withdrawn.push(subId);
        if (state.refuse.withdraw) return state.refuse.withdraw(route);
        const target = state.publications.find((item) => item.slug === subId);
        if (target) target.withdrawn = true;
        return route.fulfill({ status: 204 });
      }
      if (state.refuse.publications) return state.refuse.publications(route);
      return json(empty ? [] : state.publications)(route);
    }

    if (sub === 'reports') {
      if (!subId) {
        if (method === 'POST') {
          state.sent.created = bodyOf(route);
          const sent = bodyOf<{ slug: string; title: string; study_run_id: string | null; document: Record<string, unknown> }>(route);
          if (state.reports.some((item) => item.slug === sent.slug)) return detail(409, 'slug_conflict', 'That report slug is in use.')(route);
          const made = reportOf(sent.slug, 'draft', { title: sent.title, study_run_id: sent.study_run_id, document: sent.document, draft_revision: 1 });
          state.reports.unshift(made);
          return json(made, 201)(route);
        }
        if (state.refuse.reports) return state.refuse.reports(route);
        return json(empty ? [] : state.reports)(route);
      }
      const target = state.reports.find((item) => item.slug === subId);
      if (!target) return detail(404, 'not_found', 'Report not found.')(route);
      if (!action) {
        if (method === 'PATCH') {
          const sent = bodyOf<{ title?: string; document?: Record<string, unknown>; draft_revision?: number }>(route);
          state.sent.updated.push(sent);
          if (state.refuse.update) return state.refuse.update(route);
          if (target.state === 'frozen') return detail(409, 'report_frozen', 'Frozen reports are immutable and cannot be modified.')(route);
          if (sent.document && sent.draft_revision !== target.draft_revision) return detail(409, 'draft_conflict', 'Supply the current draft_revision before editing this report.')(route);
          if (sent.title) target.title = sent.title;
          if (sent.document) { target.document = sent.document; target.draft_revision = (target.draft_revision ?? 0) + 1; }
          return json(target)(route);
        }
        if (method === 'DELETE') {
          state.sent.removed.push(subId);
          if (state.refuse.remove) return state.refuse.remove(route);
          if (target.state === 'frozen') return detail(409, 'report_history_retained', 'Sealed report history cannot be deleted; archive the library artifact.')(route);
          state.reports = state.reports.filter((item) => item.slug !== subId);
          return route.fulfill({ status: 204 });
        }
        if (state.refuse.report) return state.refuse.report(route);
        return json(target)(route);
      }
      if (action === 'freeze') {
        state.sent.frozen.push(subId);
        if (state.refuse.freeze) return state.refuse.freeze(route);
        const provenance = (target.document.provenance ?? {}) as Record<string, unknown>;
        if (!['study', 'datasets', 'software', 'bimVersion', 'engineRevisions', 'parameters'].every((key) => key in provenance)) {
          return detail(422, 'incomplete_provenance', 'Frozen reports require study, datasets, software, bimVersion, engineRevisions and parameters provenance.')(route);
        }
        Object.assign(target, { state: 'frozen', version_id: `version-${target.slug}`, digest: digestOf('f'), draft_revision: null, draft_id: null });
        return json(target)(route);
      }
      if (action === 'drafts') {
        state.sent.drafts.push(subId);
        Object.assign(target, { state: 'draft', draft_revision: 1, draft_id: `draft-${target.slug}` });
        return json(target)(route);
      }
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

/** A capture of the current state: the whole page, its first `height` pixels, or one area; then a check that nothing scrolls sideways. */
async function capture(page: Page, testInfo: TestInfo, name: string, options: { height?: number; area?: Locator } = {}) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    (document.activeElement as HTMLElement | null)?.blur();
    window.scrollTo(0, 0);
  });
  const path = testInfo.outputPath(`${name}.png`);
  const width = page.viewportSize()?.width ?? 0;
  if (options.area) {
    await options.area.screenshot({ path, animations: 'disabled' });
  } else if (options.height) {
    const total = await page.evaluate(() => document.documentElement.scrollHeight);
    await page.screenshot({ path, fullPage: true, animations: 'disabled', clip: { x: 0, y: 0, width, height: Math.min(options.height, total) } });
  } else {
    await page.screenshot({ path, fullPage: true, animations: 'disabled' });
  }
  // Against the width of the device, not window.innerWidth: a phone widens its layout viewport to fit a page that overflows.
  const overflow = await page.evaluate((expected) => document.documentElement.scrollWidth - expected, width);
  expect(overflow, `${name} should not scroll sideways`).toBeLessThanOrEqual(1);
}

// Each test walks a screen through its states while the dev server compiles on demand.
test.setTimeout(150_000);

const viewports = [
  { name: 'desktop', viewport: { width: 1440, height: 900 }, isMobile: false, deviceScaleFactor: 1 },
  { name: 'mobile', viewport: { width: 390, height: 844 }, isMobile: true, deviceScaleFactor: 2 },
] as const;

const ROOT = '/app/isa-demo/qos-benchmarks';
const WORKSPACE = '/app/analysis/workspace';
const cells = cellsFixture();

for (const { name, viewport, isMobile, deviceScaleFactor } of viewports) {
  test.describe(`${name} · S7b analysis and reports`, () => {
    test.use({ viewport, isMobile, deviceScaleFactor });

    test('analysis-sources /app/analysis · groups by model, a preselected cell and the way into the decision space', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      await mockApi(page);
      await page.goto('/app/analysis');
      const main = page.locator('#platform-main');

      await expect(main.getByRole('heading', { level: 1, name: 'Analysis' })).toBeVisible();
      await expect(main.getByText(/Compare results you already have under the priorities you choose\. Nothing here runs a solver again\./)).toBeVisible();
      const checked = main.getByRole('region', { name: 'Model sha256-c3d4…c3d4 · checked by sha256-1a2b…1a2b' });
      await expect(checked.getByRole('checkbox')).toHaveCount(2);
      await expect(checked.getByText('Can be combined')).toHaveCount(2);
      await expect(main.getByRole('region', { name: 'Not finished yet' }).getByRole('checkbox')).toBeDisabled();
      await expect(main.getByRole('button', { name: 'Open decision space with 0 sources' })).toBeDisabled();
      await capture(page, testInfo, `sources-${name}-groups`, { height: 1800 });

      await checked.getByRole('checkbox', { name: /random-search · job f1a1b2c3…/ }).check();
      await checked.getByRole('checkbox', { name: /evolutionary · job f2a1b2c3…/ }).check();
      await expect(main.getByRole('link', { name: 'Open decision space with 2 sources' })).toHaveAttribute('href', `${WORKSPACE}?job=${JOB_DONE}&job=${JOB_SECOND}`);
      // A result with no recorded model can't be mixed with them, but it opens alone.
      const legacy = main.getByRole('region', { name: 'Can’t be combined' });
      await expect(legacy.getByRole('checkbox')).toBeDisabled();
      await expect(legacy.getByRole('link', { name: /Open random-search · job f7a1b2c3… alone/ })).toHaveAttribute('href', `${WORKSPACE}?job=${JOB_OLD}`);
      await legacy.getByRole('button', { name: 'Why?' }).click();
      await expect(legacy.getByText(/before runs recorded which model and checker they used/)).toBeVisible();
      await capture(page, testInfo, `sources-${name}-selected`, { height: 1800 });

      // Arriving from a study cell: its stored result is already chosen.
      await page.goto(`/app/analysis?org=isa-demo&project=qos-benchmarks&study=engines-vs-seeds&run=${RUN_ID}&cell=${cells[2].id}`);
      await expect(main.getByText(/Preselected from the study: Cell 3 of run/)).toBeVisible();
      await expect(main.getByRole('link', { name: 'Open decision space with 1 source' })).toBeVisible();
      await capture(page, testInfo, `sources-${name}-from-cell`, { height: 1400 });

      await main.getByRole('link', { name: 'Open decision space with 1 source' }).click();
      await expect(main.getByRole('heading', { level: 1, name: 'Decision space' })).toBeVisible();
      await expect(main.getByRole('heading', { level: 2, name: 'Binding a1a1a1a1a1', exact: true })).toBeVisible();
      expect(critical).toEqual([]);
    });

    test('analysis-sources /app/analysis · nothing to compare, a key that cannot read jobs, and an old link', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      const main = page.locator('#platform-main');

      state.sources = [];
      await page.goto('/app/analysis');
      await expect(main.getByText('Nothing to compare yet')).toBeVisible();
      await expect(main.getByText('Analysis works on finished runs you own. Run a case first.')).toBeVisible();
      await main.getByRole('button', { name: 'Start a run' }).click();
      await expect(main.getByRole('link', { name: /ISA Demo Group \/ QoS Benchmarks/ })).toHaveAttribute('href', `${ROOT}/jobs/new`);
      await capture(page, testInfo, `sources-${name}-empty`, { height: 1100 });

      state.sources = SOURCES;
      state.refuse.sources = detail(403, 'api_key_boundary', 'The API key boundary excludes this resource');
      await page.goto('/app/analysis');
      await expect(main.getByText('This API key can’t read these results (403 · api_key_boundary)')).toBeVisible();
      await capture(page, testInfo, `sources-${name}-403`, { height: 900 });
      state.refuse.sources = undefined;
      await main.getByRole('button', { name: 'Retry' }).click();
      await expect(main.getByRole('region', { name: /Model sha256-c3d4/ })).toBeVisible();
      expect(critical).toEqual([]);
    });

    test('analysis-workspace /app/analysis/workspace · ranking, priorities, limits, inspector and shortlist', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      await page.goto(`${WORKSPACE}?job=${JOB_DONE}`);
      const main = page.locator('#platform-main');

      await expect(main.getByRole('heading', { level: 1, name: 'Decision space' })).toBeVisible();
      await expect(main.getByText('1 source · 2 unique bindings, 2 stored occurrences')).toBeVisible();
      await expect(main.getByRole('heading', { level: 2, name: 'Binding a1a1a1a1a1', exact: true })).toBeVisible();
      await expect(main.getByText('Balanced compromise · Preferred under your rule')).toBeVisible();
      const ranking = main.getByRole('region', { name: /Ranking/ });
      await expect(ranking.getByRole('listitem')).toHaveCount(2);
      await expect(ranking.getByText('Cost 0.118 EUR/request · Latency 412 ms')).toBeVisible();
      await expect(main.getByRole('group', { name: 'Binding objective map' })).toBeVisible();
      await expect(main.getByRole('heading', { name: 'Inspector · Binding a1a1a1a1a1' })).toBeVisible();
      await expect(main.getByRole('heading', { name: 'What contributes to this choice' })).toBeVisible();
      await expect(main.getByText('50%').first()).toBeVisible();
      await capture(page, testInfo, `workspace-${name}-decision`, { height: 2600 });

      // Less weight on cost: the other binding wins, and the page says how the priority is shared.
      await main.getByRole('slider', { name: 'Cost priority' }).fill('0.5');
      await expect(main.getByRole('heading', { level: 2, name: 'Binding b2b2b2b2b2', exact: true })).toBeVisible();
      await expect(main.getByText('33%', { exact: true })).toBeVisible();
      expect(state.sent.queries.at(-1)).toMatchObject({ weights: { cost: 0.5 } });

      // A limit that must hold excludes what breaks it, and says why.
      await main.getByRole('spinbutton', { name: 'Latency requirement' }).fill('400');
      await expect(ranking.getByText('Excluded', { exact: true })).toBeVisible();
      await expect(main.getByText('Includes the limit itself. 1 of 2 bindings meet every requirement.')).toBeVisible();
      await ranking.getByText('Why?').click();
      await expect(ranking.getByText('Latency 412 ms is above the limit of 400 ms.')).toBeVisible();
      await capture(page, testInfo, `workspace-${name}-limit`, { height: 2200 });
      await main.getByRole('button', { name: 'Reset priorities and requirements' }).click();
      await expect(main.getByRole('heading', { level: 2, name: 'Binding a1a1a1a1a1', exact: true })).toBeVisible();

      // Another binding in the inspector, and a shortlist to compare it with.
      await ranking.getByRole('button', { name: 'Inspect binding b2b2b2b2b2' }).click();
      await expect(main.getByRole('heading', { name: 'Inspector · Binding b2b2b2b2b2' })).toBeVisible();
      await ranking.getByRole('checkbox', { name: 'Compare a1a1a1a1a1' }).check();
      await expect(main.getByRole('heading', { name: 'Shortlist comparison' })).toBeVisible();
      await expect(main.getByText('Alternative a1a1a1a1a1')).toBeVisible();
      await expect(main.getByText('gain', { exact: true })).toBeVisible();
      await expect(main.getByText('sacrifice', { exact: true })).toBeVisible();
      expect(state.sent.candidates.at(-1)).toMatchObject({ selected: ID_FASTPAY, compare: [ID_PAYCO] });
      await capture(page, testInfo, `workspace-${name}-inspector`, { area: main.locator('section[aria-labelledby="an-inspector-title"]') });

      // The raw evaluation exists, behind "View source" only.
      await expect(main.getByLabel('Constraints and raw metrics')).toBeHidden();
      await main.getByText('View source').click();
      await expect(main.getByLabel('Constraints and raw metrics')).toContainText('"feasible": true');
      expect(critical).toEqual([]);
    });

    test('analysis-workspace /app/analysis/workspace · budgets, the trade-off front, preferences and evidence', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      await page.goto(`${WORKSPACE}?job=${JOB_DONE}&view=budgets`);
      const main = page.locator('#platform-main');

      await expect(main.getByRole('tab', { name: 'Budgets' })).toHaveAttribute('aria-selected', 'true');
      await expect(main.getByRole('heading', { name: 'If Cost had to stay under…' })).toBeVisible();
      await expect(main.getByText(/reaches Latency 412 ms/)).toBeVisible();
      await expect(main.getByText(/reaches Latency 327 ms/)).toBeVisible();
      await expect(main.getByRole('group', { name: 'Budget attainment map' })).toBeVisible();
      await capture(page, testInfo, `workspace-${name}-budgets`, { height: 2200 });

      // The front is computed in the background and can be watched.
      await main.getByRole('tab', { name: 'Trade-off front' }).click();
      await expect(page).toHaveURL(/view=pareto/);
      await main.getByRole('button', { name: 'Compute the front' }).click();
      await expect(main.getByRole('progressbar', { name: 'Progress of the front' })).toBeVisible();
      await expect(main.getByRole('button', { name: 'Cancel' })).toBeVisible();
      await capture(page, testInfo, `workspace-${name}-front-running`, { height: 1600 });
      state.front = 'completed';
      await expect(main.getByText('2 non-dominated bindings among 2 in this scope.')).toBeVisible({ timeout: 30_000 });
      await capture(page, testInfo, `workspace-${name}-front-done`, { height: 1600 });

      await main.getByRole('tab', { name: 'Preferences' }).click();
      await expect(main.getByRole('heading', { name: 'Which choice wins for each balance' })).toBeVisible();
      await expect(main.getByRole('img', { name: /b2b2b2b2b2 from 0% to 55%; a1a1a1a1a1 from 55% to 100%/ })).toBeVisible();
      await expect(main.getByText('Binding a1a1a1a1a1 from 55% to 100%')).toBeVisible();
      await capture(page, testInfo, `workspace-${name}-preferences`, { height: 1800 });

      await main.getByRole('tab', { name: 'Evidence' }).click();
      await expect(main.getByRole('heading', { name: 'Evidence used' })).toBeVisible();
      await expect(main.getByText('Stored job result')).toBeVisible();
      await expect(main.getByRole('button', { name: 'Copy model digest' })).toBeVisible();
      await expect(main.getByRole('link', { name: 'Change sources' })).toHaveAttribute('href', `/app/analysis?job=${JOB_DONE}`);
      await expect(main.getByText('Unexplored space remains unknown.').first()).toBeVisible();
      await capture(page, testInfo, `workspace-${name}-evidence`, { height: 1800 });
      expect(critical).toEqual([]);
    });

    test('analysis-workspace /app/analysis/workspace · stale evidence, a busy evaluator, sources that are not yours, export and save', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      await page.goto(`${WORKSPACE}?job=${JOB_DONE}`);
      const main = page.locator('#platform-main');
      await expect(main.getByRole('heading', { level: 2, name: 'Binding a1a1a1a1a1', exact: true })).toBeVisible();

      // The evidence changed: the last ranking stays, marked as not current, until it is refreshed.
      state.refuse.query = detail(409, 'archive_changed', KEY_CHANGED);
      await main.getByRole('slider', { name: 'Cost priority' }).fill('3');
      await expect(main.getByText('The evidence changed (409 · archive_changed)')).toBeVisible();
      await expect(main.getByText(/The values below are the last response received, not trusted current evidence/)).toBeVisible();
      await expect(main.getByRole('heading', { level: 2, name: 'Binding a1a1a1a1a1', exact: true })).toBeVisible();
      await expect(main.getByRole('button', { name: 'Save as report' })).toBeDisabled();
      await capture(page, testInfo, `workspace-${name}-stale`, { height: 1500 });
      state.refuse.query = undefined;
      await main.getByRole('button', { name: 'Refresh' }).click();
      await expect(main.getByText('The evidence changed (409 · archive_changed)')).toHaveCount(0);

      state.refuse.query = (route) => route.fulfill({ status: 429, headers: { 'Retry-After': '5' }, json: { detail: { error: 'The evaluator is busy.' } } });
      await main.getByRole('slider', { name: 'Cost priority' }).fill('2');
      await expect(main.getByText(/The evaluator is busy \(429/)).toBeVisible();
      await expect(main.getByRole('heading', { level: 2, name: 'Binding a1a1a1a1a1', exact: true })).toBeVisible();
      await capture(page, testInfo, `workspace-${name}-429`, { height: 1300 });
      state.refuse.query = undefined;
      await main.getByRole('button', { name: 'Try again' }).click();
      await expect(main.getByText(/The evaluator is busy/)).toHaveCount(0);

      // Export the receipt as a file.
      const downloaded = page.waitForEvent('download');
      await main.locator('summary', { hasText: 'Export' }).click();
      await main.getByRole('button', { name: 'Export receipt' }).click();
      expect((await downloaded).suggestedFilename()).toBe('binding-decision.json');
      await expect(main.getByText('Export downloaded.')).toBeVisible();

      // Save it as a draft report of a project the person can write to.
      await main.getByRole('button', { name: 'Save as report' }).click();
      const dialog = page.getByRole('dialog', { name: 'Save as report' });
      await expect(dialog.getByRole('option', { name: 'ISA Demo Group' })).toBeAttached();
      await expect(dialog.getByRole('option', { name: 'Read Lab' })).toHaveCount(0);
      await dialog.getByLabel('Project').selectOption('qos-benchmarks');
      await dialog.getByLabel('Title').fill('Checkout choice 2');
      await capture(page, testInfo, `workspace-${name}-save`);
      await dialog.getByRole('button', { name: 'Save draft' }).click();
      await expect(main.getByText(/Saved as a draft report with this exact receipt/)).toBeVisible();
      await expect(main.getByRole('link', { name: 'Open the draft' })).toHaveAttribute('href', /\/app\/isa-demo\/qos-benchmarks\/reports\/binding-decision-/);
      expect(state.sent.save).toMatchObject({ organization: 'isa-demo', project: 'qos-benchmarks', title: 'Checkout choice 2', sources: [JOB_DONE] });

      // Sources that aren't the account's read as missing.
      state.refuse.query = detail(404, 'not_found', 'One or more analysis sources are unavailable');
      await page.goto(`${WORKSPACE}?job=00000000-0000-4000-8000-0000000000aa`);
      await expect(main.getByText('These sources aren’t available (404 · not_found)')).toBeVisible();
      await expect(main.getByRole('link', { name: 'Change sources' })).toHaveAttribute('href', '/app/analysis?job=00000000-0000-4000-8000-0000000000aa');
      await capture(page, testInfo, `workspace-${name}-404`, { height: 900 });

      state.refuse.query = detail(409, 'incompatible_sources', 'The pinned model does not match its stored identity');
      await page.goto(`${WORKSPACE}?job=${JOB_DONE}&job=${JOB_SECOND}`);
      await expect(main.getByText('These sources can’t be ranked together (409 · incompatible_sources)')).toBeVisible();
      await capture(page, testInfo, `workspace-${name}-409`, { height: 900 });
      expect(critical).toEqual([]);
    });

    test('analysis-workspace /app/analysis/workspace · a saved decision, a study cell, a whole run and no sources at all', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      const main = page.locator('#platform-main');

      await page.goto(`${WORKSPACE}?report=isa-demo/qos-benchmarks/decision-choice`);
      await expect(main.getByText('Saved decision snapshot')).toBeVisible();
      await expect(main.getByText(/saved in Checkout choice/)).toBeVisible();
      await expect(main.getByRole('heading', { name: /^Binding / }).first()).toBeVisible();
      expect(state.sent.queries.at(-1)).toMatchObject({ sources: [JOB_DONE], weights: { cost: 1, latency: 2 } });
      await main.getByText('Saved decision snapshot').click();
      await expect(main.getByRole('list', { name: /What contributed to binding b2b2b2b2b2/ })).toBeVisible();
      await capture(page, testInfo, `workspace-${name}-saved`, { height: 2000 });

      await page.goto(`${WORKSPACE}?org=isa-demo&project=qos-benchmarks&study=engines-vs-seeds&run=${RUN_ID}`);
      await expect(main.getByText(/finished cells? of run/)).toBeVisible();
      await expect(main.getByRole('heading', { level: 2, name: 'Binding a1a1a1a1a1', exact: true })).toBeVisible();

      await page.goto(WORKSPACE);
      await expect(main.getByText('No sources chosen')).toBeVisible();
      await expect(main.getByRole('link', { name: 'Choose sources' })).toHaveAttribute('href', '/app/analysis');
      await capture(page, testInfo, `workspace-${name}-no-sources`, { height: 900 });
      expect(critical).toEqual([]);
    });

    test('rep-list /app/:org/:project/reports · drafts and editions, filters, a new draft and deleting', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      await page.goto(`${ROOT}/reports`);
      const main = page.locator('#platform-main');
      const list = main.getByRole('list', { name: 'Reports of the project' });

      await expect(main.getByRole('heading', { level: 1, name: 'Reports' })).toBeVisible();
      await expect(main.getByText(/Freezing makes an edition that never changes; publishing makes it public and citable\./)).toBeVisible();
      await expect(main.getByRole('navigation', { name: 'Project sections' }).getByRole('link', { name: 'Reports', exact: true })).toHaveAttribute('aria-current', 'page');
      await expect(list.getByRole('listitem')).toHaveCount(4);
      const frozen = list.getByRole('listitem').filter({ hasText: 'Engine comparison at checkout' });
      await expect(frozen.getByRole('link')).toHaveAttribute('href', `${ROOT}/reports/engine-comparison`);
      await expect(frozen.getByText('Frozen', { exact: true })).toBeVisible();
      await expect(frozen.getByText('Published', { exact: true })).toBeVisible();
      await expect(frozen).toContainText('Frozen edition · from Engines × seeds · run #1 · sha256-eeee…eeee');
      await expect(list.getByRole('listitem').filter({ hasText: 'Draft: placement' })).toContainText('Draft revision 3 · no edition yet');
      await expect(main.getByRole('link', { name: 'Publications' })).toHaveAttribute('href', `${ROOT}/publications`);
      await capture(page, testInfo, `reports-${name}-list`, { height: 1500 });

      await main.getByRole('button', { name: 'Drafts', exact: true }).click();
      await expect(list.getByRole('listitem')).toHaveCount(3);
      await main.getByRole('button', { name: 'Frozen', exact: true }).click();
      await expect(list.getByRole('listitem')).toHaveCount(1);
      await main.getByRole('button', { name: 'All', exact: true }).click();

      // A new draft, pinned to a study run: the run's identity starts its provenance.
      await main.getByRole('button', { name: 'New report' }).click();
      const dialog = page.getByRole('dialog', { name: 'New report' });
      await dialog.getByLabel('Title').fill('Hallazgos de checkout');
      await expect(dialog.getByLabel('Address')).toHaveValue('hallazgos-de-checkout');
      await dialog.getByLabel('Study run').selectOption(RUN_ID);
      await capture(page, testInfo, `reports-${name}-new`);
      await dialog.getByRole('button', { name: 'Create draft' }).click();
      await expect(main.getByText('New draft report created.')).toBeVisible();
      await expect(main.getByRole('link', { name: 'Open the draft' })).toHaveAttribute('href', `${ROOT}/reports/hallazgos-de-checkout`);
      expect(state.sent.created).toMatchObject({
        slug: 'hallazgos-de-checkout', title: 'Hallazgos de checkout', study_run_id: RUN_ID,
        document: { blocks: [{ type: 'heading', text: 'Hallazgos de checkout' }], provenance: { study: { runId: RUN_ID } } },
      });
      await expect(list.getByRole('listitem')).toHaveCount(5);

      // A draft can be deleted; an edition cannot.
      await main.getByRole('button', { name: 'Delete Older notes' }).click();
      await page.getByRole('dialog', { name: 'Delete Older notes?' }).getByRole('button', { name: 'Delete report' }).click();
      await expect(main.getByText('Deleted “Older notes”.')).toBeVisible();
      await main.getByRole('button', { name: 'Delete Engine comparison at checkout' }).click();
      await page.getByRole('dialog', { name: 'Delete Engine comparison at checkout?' }).getByRole('button', { name: 'Delete report' }).click();
      await expect(main.getByText('This report has frozen editions (409 · report_history_retained)')).toBeVisible();
      await capture(page, testInfo, `reports-${name}-delete-409`, { height: 1500 });
      expect(state.sent.removed).toEqual(['older-notes', 'engine-comparison']);
      expect(critical).toEqual([]);
    });

    test('rep-list /app/:org/:project/reports · empty, 403, 503, a viewer and a project that is not there', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      const main = page.locator('#platform-main');

      await page.goto('/app/isa-demo/checkout-privado/reports');
      await expect(main.getByText('No reports yet')).toBeVisible();
      await expect(main.getByText(/Create one from a study run or from a saved analysis\./)).toBeVisible();
      await expect(main.getByRole('button', { name: 'New report' })).toBeVisible();
      await capture(page, testInfo, `reports-${name}-empty`, { height: 900 });

      state.refuse.reports = detail(403, 'api_key_boundary', 'The API key boundary excludes this resource');
      await page.goto(`${ROOT}/reports`);
      await expect(main.getByText('This API key can’t read reports (403 · api_key_boundary). Use a session, or a key with reports:read.')).toBeVisible();
      await capture(page, testInfo, `reports-${name}-403`, { height: 900 });
      state.refuse.reports = unavailable;
      await page.goto(`${ROOT}/reports`);
      await expect(main.getByText(/Reports couldn’t be loaded \(503\)/)).toBeVisible();
      await expect(main.getByText('No reports yet')).toHaveCount(0);
      state.refuse.reports = undefined;
      await main.getByRole('button', { name: 'Retry' }).click();
      await expect(main.getByRole('list', { name: 'Reports of the project' })).toBeVisible();

      // A viewer reads only.
      await page.goto('/app/read-lab/bench/reports');
      await expect(main.getByRole('list', { name: 'Reports of the project' })).toBeVisible();
      await expect(main.getByRole('button', { name: 'New report' })).toHaveCount(0);
      await expect(main.getByRole('button', { name: /^Delete / })).toHaveCount(0);
      await expect(main.getByRole('link', { name: 'Publications' })).toBeVisible();
      await capture(page, testInfo, `reports-${name}-viewer`, { height: 1300 });

      await page.goto('/app/isa-demo/ghost/reports');
      await expect(main.getByRole('heading', { name: 'Project not found' })).toBeVisible();
      await capture(page, testInfo, `reports-${name}-404`, { height: 900 });
      expect(critical).toEqual([]);
    });

    test('rep-detail /app/:org/:project/reports/:report · a published edition: blocks, evidence, fingerprint, citation and history', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      await mockApi(page);
      await page.goto(`${ROOT}/reports/engine-comparison`);
      const main = page.locator('#platform-main');
      const content = main.getByRole('article', { name: 'Report content' });

      await expect(main.getByRole('heading', { level: 1, name: 'Engine comparison at checkout' })).toBeVisible();
      await expect(main.getByText('Frozen edition · fingerprint sha256-eeee…eeee')).toBeVisible();
      await expect(content.getByRole('heading', { level: 2, name: 'Engine comparison at checkout' })).toBeVisible();
      await expect(content.getByText('Two engines, two seeds, two revisions of the checkout case.')).toBeVisible();
      await expect(content.getByRole('img', { name: '6 completed, 1 failed, 1 cancelled of 8 cells' })).toBeVisible();
      // The run it cites links to the screens of the run, not to a route that no longer exists.
      const analytics = main.getByRole('link', { name: 'Compare results' });
      await expect(analytics).toHaveCount(2);
      await expect(analytics.first()).toHaveAttribute('href', `${ROOT}/studies/engines-vs-seeds/runs/${RUN_ID}/analytics`);
      await expect(main.getByRole('link', { name: 'Version history in the library' })).toHaveAttribute('href', '/app/isa-demo/library/artifact-engine-comparison/versions/version-engine-comparison');
      await expect(main.getByRole('link', { name: 'Verify it' })).toHaveAttribute('href', `/resolve/report/${EDITION}`);
      await expect(main.getByText('Alex Rivera (2026). Engine comparison at checkout. ISA Demo Group / QoS Benchmarks.')).toBeVisible();
      await expect(main.getByRole('button', { name: 'New draft from this edition' })).toBeVisible();
      await expect(main.getByRole('button', { name: 'Withdraw' })).toBeVisible();
      await capture(page, testInfo, `report-${name}-published`, { height: 2200 });

      // The document itself, only behind "View source".
      await expect(main.getByLabel('Report document (JSON)')).toBeHidden();
      await main.getByText('View source').click();
      await expect(main.getByLabel('Report document (JSON)')).toContainText('"bimVersion": "bim/v1"');
      await capture(page, testInfo, `report-${name}-source`, { area: main.locator('details.rp-source') });

      // Withdrawing keeps the link, citation and fingerprint.
      await main.getByRole('button', { name: 'Withdraw' }).click();
      const dialog = page.getByRole('dialog', { name: 'Withdraw checkout-comparison?' });
      await capture(page, testInfo, `report-${name}-withdraw`);
      await dialog.getByRole('button', { name: 'Withdraw' }).click();
      await expect(main.getByText('Withdrawn. It’s no longer listed in Explore, but its link, citation and fingerprint still work.')).toBeVisible();
      await expect(main.getByRole('button', { name: 'Publish…' })).toBeVisible();
      expect(critical).toEqual([]);
    });

    test('rep-detail /app/:org/:project/reports/:report · a draft: edit, save, freeze refused for provenance, fixed, frozen and published', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      await page.goto(`${ROOT}/reports/draft-placement`);
      const main = page.locator('#platform-main');
      const block = (label: string) => main.getByRole('region', { name: label }).getByRole('textbox');

      await expect(main.getByRole('heading', { level: 1, name: 'Draft: placement' })).toBeVisible();
      await expect(main.getByText('Draft revision 3 · saved')).toBeVisible();
      await expect(main.getByRole('button', { name: 'Save draft' })).toBeDisabled();
      await block('Text block 2').fill('Pools and latencies on the edge, with two engines.');
      await main.getByRole('button', { name: '+ Heading' }).click();
      await block('Heading block 3').fill('Next steps');
      await main.getByRole('button', { name: 'Move block up' }).nth(2).click();
      await expect(main.getByText('Draft revision 3 · unsaved changes')).toBeVisible();
      await capture(page, testInfo, `report-${name}-editing`, { height: 2000 });
      await main.getByRole('button', { name: 'Save draft' }).click();
      await expect(main.getByText('Draft saved.')).toBeVisible();
      expect(state.sent.updated.at(-1)).toMatchObject({
        title: 'Draft: placement', draft_revision: 3,
        document: { blocks: [{ type: 'heading', text: 'Draft: placement' }, { type: 'heading', text: 'Next steps' }, { type: 'text', text: 'Pools and latencies on the edge, with two engines.' }] },
      });
      await expect(main.getByText('Draft revision 4 · saved')).toBeVisible();

      // The gateway needs exact provenance to seal a report: it says what is missing, and the source opens.
      await main.getByRole('button', { name: 'Freeze edition' }).click();
      await page.getByRole('dialog', { name: 'Freeze this edition?' }).getByRole('button', { name: 'Freeze edition' }).click();
      await expect(main.getByText('The provenance isn’t complete (422 · incomplete_provenance)')).toBeVisible();
      await expect(main.getByLabel('Report document (JSON)')).toBeVisible();
      await capture(page, testInfo, `report-${name}-freeze-422`, { height: 2200 });

      const source = main.getByLabel('Report document (JSON)');
      const current = JSON.parse(await source.inputValue()) as Record<string, unknown>;
      await source.fill(JSON.stringify({ ...current, provenance: PROVENANCE }, null, 2));
      await main.getByRole('button', { name: 'Apply to the draft' }).click();
      await expect(main.getByText('Draft revision 4 · unsaved changes')).toBeVisible();
      await main.getByRole('button', { name: 'Freeze edition' }).click();
      const dialog = page.getByRole('dialog', { name: 'Freeze this edition?' });
      await expect(dialog.getByText(/Your unsaved changes are saved first\./)).toBeVisible();
      await dialog.getByRole('button', { name: 'Freeze edition' }).click();
      await expect(main.getByText('Frozen as a new edition. It can’t change any more; its fingerprint was assigned by the server.')).toBeVisible();
      await expect(main.getByRole('button', { name: 'Publish…' })).toBeVisible();
      await expect(main.getByText(/Frozen edition · fingerprint sha256-ffff…ffff/)).toBeVisible();
      expect(state.sent.frozen).toEqual(['draft-placement', 'draft-placement']);

      // Publishing: the server refuses private evidence, then accepts.
      await main.getByRole('button', { name: 'Publish…' }).click();
      const publish = page.getByRole('dialog', { name: 'Publish this edition' });
      await expect(publish.getByLabel('Authors')).toHaveValue('lucia.vega');
      await publish.getByLabel('DOI or link (optional)').fill('10.1000/placement');
      state.refuse.publish = detail(422, 'private_evidence', 'Job evidence must belong to a public project before report publication.');
      await page.screenshot({ path: testInfo.outputPath(`report-${name}-publish-dialog.png`), animations: 'disabled' });
      await publish.getByRole('button', { name: 'Publish' }).click();
      await expect(publish.getByText('Some of the evidence is private (422 · private_evidence)')).toBeVisible();
      await capture(page, testInfo, `report-${name}-publish-422`);
      state.refuse.publish = undefined;
      await publish.getByRole('button', { name: 'Publish' }).click();
      await expect(main.getByText('Published. Anyone can now find, read and verify this edition.')).toBeVisible();
      expect(state.sent.published).toMatchObject({ slug: 'draft-placement', citation: { authors: ['lucia.vega'], doi: '10.1000/placement' } });
      await expect(main.getByRole('heading', { name: 'Published', exact: true })).toBeVisible();
      await capture(page, testInfo, `report-${name}-published-now`, { height: 2200 });
      expect(critical).toEqual([]);
    });

    test('rep-detail /app/:org/:project/reports/:report · a conflict, an older report, a saved decision, a viewer and a report that is not there', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      const main = page.locator('#platform-main');

      // Someone else saved a newer revision: what was typed stays, theirs can be loaded.
      await page.goto(`${ROOT}/reports/draft-placement`);
      await main.getByRole('region', { name: 'Text block 2' }).getByRole('textbox').fill('My version');
      state.reports[1].draft_revision = 4;
      await main.getByRole('button', { name: 'Save draft' }).click();
      await expect(main.getByText('Someone saved a newer draft revision (409 · draft_conflict)')).toBeVisible();
      await expect(main.getByRole('region', { name: 'Text block 2' }).getByRole('textbox')).toHaveValue('My version');
      await capture(page, testInfo, `report-${name}-409`, { height: 1500 });
      await main.getByRole('button', { name: 'Load the newer draft' }).click();
      await expect(main.getByText('Draft revision 4 · saved')).toBeVisible();

      // A report that holds summary and findings is read as blocks and written back as blocks.
      await page.goto(`${ROOT}/reports/older-notes`);
      await expect(main.getByRole('region', { name: 'Text block 1' }).getByRole('textbox')).toHaveValue('Initial notes');
      await expect(main.getByRole('region', { name: 'Text block 2' }).getByRole('textbox')).toHaveValue('Evolutionary is cheaper but slower.');
      await capture(page, testInfo, `report-${name}-legacy`, { height: 1500 });

      // A saved binding decision: drawn as a decision, with the way to reopen it.
      await page.goto(`${ROOT}/reports/decision-choice`);
      await expect(main.getByRole('heading', { level: 2, name: 'Recorded binding decision' })).toBeVisible();
      await expect(main.getByRole('link', { name: 'Reopen decision space' })).toHaveAttribute('href', `${WORKSPACE}?report=isa-demo%2Fqos-benchmarks%2Fdecision-choice`);
      await expect(main.getByRole('heading', { level: 3, name: 'Binding b2b2b2b2b2' })).toBeVisible();
      await capture(page, testInfo, `report-${name}-decision`, { height: 2000 });

      // A viewer reads only.
      await page.goto('/app/read-lab/bench/reports/draft-placement');
      await expect(main.getByText('Read-only for you: editing needs MEMBER, publishing needs ADMIN.')).toBeVisible();
      for (const label of ['Save draft', 'Freeze edition', 'Delete', '+ Text']) await expect(main.getByRole('button', { name: label })).toHaveCount(0);
      await expect(main.getByRole('article', { name: 'Report content' }).getByRole('textbox')).toHaveCount(0);
      await capture(page, testInfo, `report-${name}-viewer`, { height: 1500 });

      await page.goto(`${ROOT}/reports/ghost`);
      await expect(main.getByRole('heading', { name: 'Report not found' })).toBeVisible();
      await expect(main.getByText('No report with this address in QoS Benchmarks (404).')).toBeVisible();
      await capture(page, testInfo, `report-${name}-404`, { height: 900 });

      state.refuse.report = unavailable;
      await page.goto(`${ROOT}/reports/draft-placement`);
      await expect(main.getByText(/The report couldn’t be loaded \(503\)/)).toBeVisible();
      expect(critical).toEqual([]);
    });

    test('proj-publications /app/:org/:project/publications · citing, verifying, withdrawing', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      await page.goto(`${ROOT}/publications`);
      const main = page.locator('#platform-main');

      await expect(main.getByRole('heading', { level: 1, name: 'Publications' })).toBeVisible();
      await expect(main.getByText(/Report editions made public from QoS Benchmarks\. Withdrawing hides one from listings but keeps every link and fingerprint working\./)).toBeVisible();
      await expect(main.getByRole('navigation', { name: 'Project sections' }).getByRole('link', { name: 'Reports', exact: true })).toHaveAttribute('aria-current', 'page');
      await expect(main.getByRole('heading', { level: 2, name: 'Engine comparison at checkout' })).toBeVisible();
      await expect(main.getByText('checkout-comparison · published Sep 25, 2026 · sha256-eeee…eeee')).toBeVisible();
      await expect(main.getByText('Alex Rivera (2026). Engine comparison at checkout. ISA Demo Group / QoS Benchmarks.')).toBeVisible();
      await expect(main.getByRole('link', { name: 'Open public verification' })).toHaveAttribute('href', `/resolve/report/${EDITION}`);
      await expect(main.getByRole('link', { name: 'Open the report' })).toHaveAttribute('href', `${ROOT}/reports/engine-comparison`);
      await capture(page, testInfo, `publications-${name}-list`, { height: 1500 });

      await main.getByRole('button', { name: 'Withdraw' }).click();
      const dialog = page.getByRole('dialog', { name: 'Withdraw checkout-comparison?' });
      await capture(page, testInfo, `publications-${name}-confirm`);
      state.refuse.withdraw = detail(403, 'forbidden', 'Your role does not reach this.');
      await dialog.getByRole('button', { name: 'Withdraw' }).click();
      await expect(dialog.getByText('Your role doesn’t reach this (403 · forbidden)')).toBeVisible();
      state.refuse.withdraw = undefined;
      await dialog.getByRole('button', { name: 'Withdraw' }).click();
      await expect(main.getByText('Withdrawn. It’s no longer listed in Explore, but its link, citation and fingerprint still work.')).toBeVisible();
      await expect(main.getByText('Withdrawn · still reachable by link')).toBeVisible();
      await expect(main.getByRole('button', { name: 'Withdraw' })).toHaveCount(0);
      await expect(main.getByRole('link', { name: 'Open public verification' })).toBeVisible();
      expect(state.sent.withdrawn).toEqual(['checkout-comparison', 'checkout-comparison']);
      await capture(page, testInfo, `publications-${name}-withdrawn`, { height: 1500 });
      expect(critical).toEqual([]);
    });

    test('proj-publications /app/:org/:project/publications · nothing yet, a viewer, 503 and a project that is not there', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      const main = page.locator('#platform-main');

      await page.goto('/app/isa-demo/checkout-privado/publications');
      await expect(main.getByText('Nothing published yet')).toBeVisible();
      await expect(main.getByText('Nothing published from this project yet. Publish a frozen report edition from its page.')).toBeVisible();
      await capture(page, testInfo, `publications-${name}-empty`, { height: 900 });

      await page.goto('/app/read-lab/bench/publications');
      await expect(main.getByRole('heading', { level: 1, name: 'Publications' })).toBeVisible();
      await expect(main.getByRole('button', { name: 'Withdraw' })).toHaveCount(0);
      state.refuse.publications = unavailable;
      await page.goto(`${ROOT}/publications`);
      await expect(main.getByText(/Publications couldn’t be loaded \(503\)/)).toBeVisible();
      await expect(main.getByText('Nothing published yet')).toHaveCount(0);
      await capture(page, testInfo, `publications-${name}-503`, { height: 900 });
      state.refuse.publications = undefined;
      await main.getByRole('button', { name: 'Retry' }).click();
      await expect(main.getByRole('heading', { level: 2, name: 'Engine comparison at checkout' })).toBeVisible();

      await page.goto('/app/isa-demo/ghost/publications');
      await expect(main.getByRole('heading', { name: 'Project not found' })).toBeVisible();
      expect(critical).toEqual([]);
    });

    test('verifier /app/verifier · a fingerprint: verified with its matches and citation, not found, and not a fingerprint', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      await page.goto('/app/verifier');
      const main = page.locator('#platform-main');

      await expect(main.getByRole('heading', { level: 1, name: 'Verifier' })).toBeVisible();
      await expect(main.getByText(/Your browser computes the fingerprint and the server confirms it\./)).toBeVisible();
      await expect(main.getByText('Enter something to check.')).toBeVisible();
      await expect(main.getByRole('button', { name: 'Check' })).toBeDisabled();
      await capture(page, testInfo, `verifier-${name}-empty`, { height: 1100 });

      await main.getByRole('textbox', { name: 'Fingerprint' }).fill(EDITION);
      await main.getByRole('button', { name: 'Check' }).click();
      const verdict = main.getByRole('region', { name: 'Verdict' });
      await expect(verdict.getByText('Verified', { exact: true })).toBeVisible();
      await expect(verdict.getByText('OpenBinding recorded an element with this fingerprint.')).toBeVisible();
      const matches = main.getByRole('region', { name: 'Matches' });
      await expect(matches.getByText('Engine comparison at checkout')).toBeVisible();
      await expect(matches.getByRole('link', { name: 'Open' })).toHaveAttribute('href', `${ROOT}/reports/engine-comparison`);
      await expect(matches.getByRole('link', { name: 'Public record' })).toHaveAttribute('href', `/resolve/report/${EDITION}`);
      await expect(main.getByText('OpenBinding (2026). Engine comparison at checkout. OpenBinding report edition, digest sha256-eeee…eeee.')).toBeVisible();
      expect(state.sent.verify.at(-1)).toEqual({ digest: EDITION });
      await capture(page, testInfo, `verifier-${name}-verified`, { height: 1700 });

      await main.getByRole('textbox', { name: 'Fingerprint' }).fill(digestOf('0'));
      await main.getByRole('button', { name: 'Check' }).click();
      await expect(main.getByText('Nothing found', { exact: true })).toBeVisible();
      await expect(main.getByText('nothing recorded', { exact: true })).toBeVisible();
      await expect(main.getByRole('region', { name: 'Matches' })).toHaveCount(0);
      await capture(page, testInfo, `verifier-${name}-not-found`, { height: 1200 });

      const asked = state.sent.verify.length;
      await main.getByRole('textbox', { name: 'Fingerprint' }).fill('sha256-123');
      await main.getByRole('button', { name: 'Check' }).click();
      await expect(main.getByText('That can’t be checked')).toBeVisible();
      await expect(main.getByText('That isn’t a valid fingerprint. A fingerprint is sha256- followed by 64 lowercase hexadecimal characters.')).toBeVisible();
      expect(state.sent.verify).toHaveLength(asked);
      await capture(page, testInfo, `verifier-${name}-invalid`, { height: 1100 });

      // A fingerprint in the address is checked on arrival.
      await page.goto(`/app/verifier?digest=${EDITION}`);
      await expect(main.getByRole('region', { name: 'Verdict' }).getByText('Verified', { exact: true })).toBeVisible();
      await expect(main.getByRole('textbox', { name: 'Fingerprint' })).toHaveValue(EDITION);
      expect(critical).toEqual([]);
    });

    test('verifier /app/verifier · a document and a file: computed, doesn’t match, verified, and the matches inside one project', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      await page.goto('/app/verifier');
      const main = page.locator('#platform-main');

      // A document: normalised before fingerprinting, so spacing and key order don't matter.
      await main.getByRole('tab', { name: 'Document text' }).click();
      await main.getByLabel('Paste the document’s text').fill('{ "b": 1,\n  "a": 2 }');
      await main.getByRole('button', { name: 'Check' }).click();
      const fingerprint = sha(canonical({ a: 2, b: 1 }));
      await expect(main.getByText('Computed, not on record')).toBeVisible();
      await expect(main.getByText('Computed in your browser')).toBeVisible();
      await expect(main.getByText(fingerprint, { exact: true }).first()).toBeVisible();
      expect(state.sent.verify.at(-1)).toEqual({ document: { b: 1, a: 2 }, digest: null });
      await expect(main.getByLabel('Normalised document')).toBeHidden();
      await main.getByText('View source').click();
      await expect(main.getByLabel('Normalised document')).toHaveText('{"a":2,"b":1}');
      await capture(page, testInfo, `verifier-${name}-computed`, { height: 1500 });

      await main.getByLabel('Fingerprint it should have (optional)').fill(EDITION);
      await main.getByRole('button', { name: 'Check' }).click();
      await expect(main.getByText('Doesn’t match', { exact: true })).toBeVisible();
      await expect(main.getByText('Fingerprint you expected', { exact: true })).toBeVisible();
      await capture(page, testInfo, `verifier-${name}-mismatch`, { height: 1500 });
      await main.getByLabel('Fingerprint it should have (optional)').fill(fingerprint);
      await main.getByRole('button', { name: 'Check' }).click();
      await expect(main.getByRole('region', { name: 'Verdict' }).getByText('Verified', { exact: true })).toBeVisible();

      await main.getByLabel('Paste the document’s text').fill('just words');
      await main.getByRole('button', { name: 'Check' }).click();
      await expect(main.getByText(/That text isn’t a JSON document/)).toBeVisible();

      // A file: hashed in the browser, then looked up.
      await main.getByRole('tab', { name: 'File' }).click();
      await main.getByLabel('Choose file').setInputFiles({ name: 'results.csv', mimeType: 'text/csv', buffer: Buffer.from(FILE_BYTES) });
      await expect(main.getByText(/results\.csv · 8 bytes/)).toBeVisible();
      await main.getByRole('button', { name: 'Check' }).click();
      await expect(main.getByRole('region', { name: 'Verdict' }).getByText('Verified', { exact: true })).toBeVisible();
      await expect(main.getByText(sha(FILE_BYTES), { exact: true }).first()).toBeVisible();
      await expect(main.getByRole('region', { name: 'Matches' }).getByText('Blob (text/csv, 8 B)')).toBeVisible();
      await capture(page, testInfo, `verifier-${name}-file`, { height: 1500 });
      await main.getByLabel('Choose file').setInputFiles({ name: 'other.bin', mimeType: 'application/octet-stream', buffer: Buffer.from('something else') });
      await main.getByRole('button', { name: 'Check' }).click();
      await expect(main.getByText('Computed, not on record')).toBeVisible();
      expect(state.sent.verifyFile).toBe(2);

      // Several matches, and only those of the current project on request.
      state.refuse.verify = json(verdictOf('verified', EDITION, [reportEntity, caseEntity]));
      await main.getByRole('tab', { name: 'Fingerprint' }).click();
      await main.getByRole('textbox', { name: 'Fingerprint' }).fill(EDITION);
      await main.getByRole('button', { name: 'Check' }).click();
      const matches = main.getByRole('region', { name: 'Matches' });
      await expect(matches.getByRole('listitem')).toHaveCount(2);
      await main.getByRole('checkbox', { name: 'Only show matches inside QoS Benchmarks' }).check();
      await expect(matches.getByRole('listitem')).toHaveCount(1);
      await expect(matches.getByText('1 more outside the chosen project.')).toBeVisible();
      await capture(page, testInfo, `verifier-${name}-scope`, { height: 1700 });
      expect(critical).toEqual([]);
    });

    test('verifier /app/verifier · the server refuses (422, 413, 503) and the page says what it means', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      await page.goto('/app/verifier');
      const main = page.locator('#platform-main');

      await main.getByRole('textbox', { name: 'Fingerprint' }).fill(EDITION);
      state.refuse.verify = detail(422, 'validation_error', 'digest is malformed');
      await main.getByRole('button', { name: 'Check' }).click();
      await expect(main.getByText('That isn’t a valid fingerprint or document (422 · validation_error)')).toBeVisible();
      await capture(page, testInfo, `verifier-${name}-422`, { height: 1100 });

      state.refuse.verify = unavailable;
      await main.getByRole('button', { name: 'Check' }).click();
      await expect(main.getByText('The verifier didn’t answer')).toBeVisible();
      await capture(page, testInfo, `verifier-${name}-503`, { height: 1100 });

      await main.getByRole('tab', { name: 'File' }).click();
      await main.getByLabel('Choose file').setInputFiles({ name: 'huge.bin', mimeType: 'application/octet-stream', buffer: Buffer.from('x') });
      state.refuse.verifyFile = detail(413, 'payload_too_large', 'The file is too large.');
      await main.getByRole('button', { name: 'Check' }).click();
      await expect(main.getByText('That file is too large to check here (413 · payload_too_large)')).toBeVisible();
      await capture(page, testInfo, `verifier-${name}-413`, { height: 1100 });
      expect(critical).toEqual([]);
    });
  });
}
