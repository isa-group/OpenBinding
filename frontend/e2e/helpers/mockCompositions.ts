import { readFileSync } from 'node:fs';
import type { CompositionVersionView, CompositionView } from '../../src/shared/api/types';

// The compositions of the shared mock (e2e/helpers/mockApi.ts registers them): in `isa-demo`, a declared composition and one linked
// to the problem `checkout-flow`, three versions each, with evaluations and analytics, and an archived one with no version. The
// linked versions are the gateway's own fixture (src/test/fixtures/core/fms.version.json) under other ids, labels and values; the
// declared ones follow src/test/fixtures/compositions/declared.yaml. A composition created through the mock is kept for the page.
// The facts of the compilation the linked versions were evaluated on are core/fms.facts.json, which mockApi.ts serves for it.

/** The organization that has compositions; every other one has none. */
export const COMPOSITIONS_ORG = 'isa-demo';

const ORGANIZATION = { id: 'org-isa-demo', slug: COMPOSITIONS_ORG, name: 'ISA Demo Group' };
const AUTHOR = '00000000-0000-4000-8000-000000000005';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const digest = (char: string) => `sha256-${char.repeat(64)}`;

/** The text of the declared versions: the fixture, at their label and cost. */
const DECLARED_TEXT = readFileSync(new URL('../../src/test/fixtures/compositions/declared.yaml', import.meta.url), 'utf8');
const declaredText = (label: string, cost: number) => DECLARED_TEXT.replace('version: 1.0.0', `version: ${label}`).replace('value: 42.5', `value: ${cost}`);

const core = (file: string): Record<string, unknown> => JSON.parse(readFileSync(new URL(`../../src/test/fixtures/core/${file}`, import.meta.url), 'utf8'));

// -- The declared composition: an order desk whose author wrote its values

const orderWorkflow = {
  seq: ['signIn', { and: ['notify', 'archive'] }, { xor: [{ probability: 0.7, flow: 'post' }, { probability: 0.3, flow: 'courier' }] }],
};
const orderBinding = {
  signIn: { local: true },
  notify: { candidate: 'email.brevo.starter', from: { sphere: 'brevo/brevo', version: '665f1c2e9b1d4a0012ab34cd', plan: 'STARTER' } },
  archive: { candidate: 'storage.dropbox.plus' },
  post: { candidate: 'shipping.post.standard' },
  courier: { candidate: 'shipping.courier.express' },
};
const ORDER_OFFERING = { url: 'https://pricings.example.org/order-desk/pricing.yml' };
const ORDER_ANALYTICS = {
  tasks: 5, boundTasks: 4, localTasks: 1, providers: 4, upstreamPricings: 1, hasOffering: true, workflow: { depth: 2, and: 1, xor: 1, loop: 0 },
};

function declaredVersion(n: number, label: string, cost: number, createdAt: string): CompositionVersionView {
  const values = { availability: { value: 0.995, unit: '1' }, cost: { value: cost, unit: 'EUR/month' }, latency: { value: 380, unit: 'ms' } };
  const evaluation = uuid(0xc100 + n);
  return {
    id: uuid(0xc000 + n), ordinal: n, label, syntax_version: '1.0', kind: 'application', values_status: 'declared', verified: false,
    content_digest: digest(String(n)), size_bytes: 980 + n, values, problem: null, offering: ORDER_OFFERING, evidence_run: null, based_on: null,
    forked_from: null, derivation: null, analytics: ORDER_ANALYTICS, created_by_id: AUTHOR, created_at: createdAt,
    current_evaluation_id: evaluation,
    current_evaluation: { id: evaluation, basis: 'declared', outcome: 'declared', compilation: null, created_at: createdAt },
    evaluations: [{
      id: evaluation, basis: 'declared', outcome: 'declared', values, violations: [], diagnostics: [], compilation: null, binding: null,
      current: true, created_at: createdAt,
    }],
    document: {
      syntaxVersion: '1.0', composition: 'order-desk', version: label, kind: 'application', workflow: orderWorkflow, binding: orderBinding,
      values: { availability: 0.995, cost: { value: cost, unit: 'EUR/month' }, latency: { value: 380, unit: 'ms' } }, offering: ORDER_OFFERING,
      evidence: { evaluatedBy: 'declared' },
    },
  };
}

// -- The linked composition: fleet routing, evaluated by the toolchain on the problem checkout-flow

const FMS = core('fms.version.json') as unknown as CompositionVersionView;
const PROBLEM_REF = `${COMPOSITIONS_ORG}/checkout-flow@2`;

function linkedVersion(n: number, label: string, cost: number, createdAt: string, over: Partial<CompositionVersionView> = {}): CompositionVersionView {
  const version = structuredClone(FMS);
  const id = uuid(0xd000 + n);
  const evaluation = uuid(0xd100 + n);
  const values = { ...version.values, cost: { value: cost, unit: 'USD/month' } };
  const document = { ...version.document, composition: 'fleet-routing', version: label, kind: 'workflow', problem: { ...(version.document?.problem as object), ref: PROBLEM_REF } };
  return {
    ...version,
    id, ordinal: n, label, kind: 'workflow', values, created_at: createdAt, created_by_id: AUTHOR, content_digest: digest(String.fromCharCode(96 + n)),
    document: { ...document, values: { ...(version.document?.values as object), cost: { value: cost, unit: 'USD/month' } } },
    problem: version.problem && { ...version.problem, problem: { id: 'case-checkout', slug: 'checkout-flow', name: 'Checkout flow' }, revision: { id: 'rev-2', revision: 2 } },
    current_evaluation_id: evaluation,
    current_evaluation: version.current_evaluation && { ...version.current_evaluation, id: evaluation, created_at: createdAt },
    evaluations: version.evaluations.map((item) => ({ ...item, id: evaluation, values, created_at: createdAt })),
    derivation: version.derivation && { ...version.derivation, revision: { id: 'rev-2', revision: 2 } },
    ...over,
  };
}

/** A version whose problem changed meaning after it was sealed: the installed toolchain no longer verifies its values. */
function semanticsChanged(version: CompositionVersionView): CompositionVersionView {
  return {
    ...version,
    verified: false,
    current_evaluation: version.current_evaluation && { ...version.current_evaluation, outcome: 'semantics_changed' },
    evaluations: version.evaluations.map((item) => ({ ...item, outcome: 'semantics_changed' as const })),
  };
}

const RUN = uuid(0xa1);

function composition(n: number, slug: string, name: string, over: Partial<CompositionView>, versions: CompositionVersionView[]): CompositionView {
  const latest = versions[versions.length - 1];
  return {
    id: uuid(0xb000 + n), slug, name, description: '', kind: 'application', archived: false, visibility: 'private',
    organization: ORGANIZATION, created_by_id: AUTHOR, created_at: versions[0]?.created_at ?? '2026-09-01T00:00:00Z',
    updated_at: latest?.created_at ?? '2026-09-01T00:00:00Z', version_count: versions.length,
    latest_version: latest ? { id: latest.id, ordinal: latest.ordinal, label: latest.label, values_status: latest.values_status, created_at: latest.created_at } : null,
    ...over,
  };
}

interface Entry {
  view: CompositionView;
  /** Oldest first. */
  versions: CompositionVersionView[];
}

function seed(): Entry[] {
  const order = [
    declaredVersion(1, '1.0.0', 48, '2026-09-02T09:00:00Z'),
    declaredVersion(2, '1.1.0', 45, '2026-09-18T10:30:00Z'),
    declaredVersion(3, '1.2.0', 42.5, '2026-10-05T08:15:00Z'),
  ];
  const fleet = [
    linkedVersion(1, '1.0.0', 3060, '2026-09-10T11:00:00Z'),
    semanticsChanged(linkedVersion(2, '1.1.0', 3120, '2026-09-25T15:45:00Z')),
    linkedVersion(3, '1.2.0', 2980, '2026-10-08T16:20:00Z', { derivation: { source: 'run', run: { id: RUN }, point: 3, revision: { id: 'rev-2', revision: 2 } } }),
  ];
  return [
    {
      view: composition(1, 'order-desk', 'Order desk', {
        description: 'Signs customers in, sends a notice and archives each order, then ships by post or courier.', visibility: 'public',
      }, order),
      versions: order,
    },
    { view: composition(2, 'fleet-routing', 'Fleet routing', { description: 'Routes the delivery fleet across the providers of each leg.', kind: 'workflow' }, fleet), versions: fleet },
    { view: composition(3, 'legacy-intake', 'Legacy intake', { kind: 'pipeline', archived: true, updated_at: '2026-06-01T00:00:00Z', created_at: '2026-05-01T00:00:00Z' }, []), versions: [] },
  ];
}

/** What a handler of the mock needs of a request. */
export interface CompositionRequest {
  method: string;
  /** `/v1/organizations/{org}/compositions/…` split at the slashes. */
  parts: string[];
  query: URLSearchParams;
  body: () => Record<string, unknown>;
  /** The body as text (a Composition2Yaml document). */
  text: () => string;
}

export interface CompositionReply {
  status: number;
  json?: unknown;
  text?: string;
  type?: string;
}

export interface CompositionStore {
  /** Answers `/v1/organizations/{org}/compositions…` for the organization `org`. */
  route: (request: CompositionRequest, org: string) => CompositionReply;
  /** Answers the language services `/v1/compositions/{validate,parse,serialise,schema}`; null for anything else. */
  language: (request: CompositionRequest) => CompositionReply | null;
}

const KINDS = ['application', 'workflow', 'pipeline', 'system'];

/** The schema as far as completion reads it: the document's keys and the kinds. */
const SCHEMA = {
  type: 'object',
  properties: {
    syntaxVersion: { const: '1.0' }, composition: { type: 'string' }, version: { type: 'string' }, kind: { enum: KINDS },
    problem: { type: 'object', properties: { ref: { type: 'string' }, compilation: { type: 'string' } } },
    workflow: {}, binding: { type: 'object' }, values: { type: 'object' }, offering: { type: 'object' }, evidence: { type: 'object' },
  },
};

const scalar = (text: string, key: string) => new RegExp(`^${key}:[ \\t]*(.*)$`, 'm').exec(text)?.[1]?.trim().replace(/^["']|["']$/g, '') ?? null;

/** The mock's lint: an unknown `kind` is an error at its value; everything else passes. */
function lint(text: string) {
  const match = /^kind:[ \t]*(.*)$/m.exec(text);
  const value = match?.[1].trim() ?? '';
  if (!match || KINDS.includes(value)) return { valid: true, diagnostics: [] };
  const line = text.slice(0, match.index).split('\n').length;
  const column = match[0].indexOf(value, 'kind:'.length) + 1;
  return {
    valid: false,
    diagnostics: [{
      code: 'c2y_kind_unknown', message: `'${value}' is not a kind; a composition is one of ${KINDS.join(', ')}`, severity: 'error', path: 'kind', pointer: '/kind',
      span: { line, column, end_line: line, end_column: column + value.length },
    }],
  };
}

const refused = (diagnostics: unknown[]): CompositionReply => ({
  status: 422,
  json: { type: 'about:blank', title: 'Unprocessable Content', status: 422, code: 'composition_invalid', detail: 'The document is not valid Composition2Yaml.', diagnostics },
});

const ok = (json: unknown, status = 200): CompositionReply => ({ status, json });
const missing = (): CompositionReply => ({ status: 404, json: { detail: { code: 'not_found', error: 'Composition not found.' } } });

/** The light row of a version, as the versions list serves it without `include`. */
const lightRow = (version: CompositionVersionView): CompositionVersionView => ({ ...version, document: null, evaluations: [], analytics: null });

/** A store of compositions for one page: the seeded ones plus what the page creates. */
export function compositionStore(): CompositionStore {
  const entries = seed();
  let created = 0;
  let sealed = 0;
  /** The stored text of each version, by id. */
  const texts = new Map<string, string>();
  for (const entry of entries) {
    for (const version of entry.versions) {
      const cost = (version.values.cost as { value: number } | undefined)?.value ?? 0;
      texts.set(version.id, version.values_status === 'declared' ? declaredText(version.label, cost) : `${JSON.stringify(version.document, null, 2)}\n`);
    }
  }

  /** A text read back as the stored document of its composition, with the text's label and kind. */
  const documentOf = (text: string): Record<string, unknown> => {
    const slug = scalar(text, 'composition') ?? '';
    const latest = entries.find((entry) => entry.view.slug === slug)?.versions.at(-1);
    const base = (latest?.document as Record<string, unknown> | null | undefined)
      ?? { syntaxVersion: '1.0', composition: slug, workflow: null, binding: {}, values: {} };
    return { ...structuredClone(base), version: scalar(text, 'version') ?? '', kind: scalar(text, 'kind') ?? '' };
  };

  const seal = (entry: Entry, text: string): CompositionReply => {
    const linted = lint(text);
    if (!linted.valid) return refused(linted.diagnostics);
    const label = scalar(text, 'version') ?? '';
    const existing = entry.versions.find((version) => version.label === label);
    if (existing && texts.get(existing.id) === text) return ok({ version: existing, evaluation: existing.evaluations[0], diagnostics: [] });
    if (existing) return { status: 409, json: { detail: { code: 'version_label_taken', error: `Version ${label} already holds another content.` } } };
    sealed += 1;
    const now = new Date().toISOString();
    const latest = entry.versions.at(-1) ?? declaredVersion(0, label, 0, now);
    const version: CompositionVersionView = {
      ...structuredClone(latest),
      id: uuid(0xe000 + sealed), ordinal: entry.versions.length + 1, label, created_at: now, content_digest: digest('e'),
      document: { ...documentOf(text), composition: entry.view.slug },
    };
    entry.versions.push(version);
    texts.set(version.id, text);
    entry.view = {
      ...entry.view, updated_at: now, version_count: entry.versions.length,
      latest_version: { id: version.id, ordinal: version.ordinal, label, values_status: version.values_status, created_at: now },
    };
    return ok({ version, evaluation: version.evaluations[0], diagnostics: [] }, 201);
  };

  const check = (entry: Entry, text: string): CompositionReply => {
    const linted = lint(text);
    if (!linted.valid) return ok({ valid: false, values_status: null, values: null, content: null, diagnostics: linted.diagnostics });
    return ok({
      valid: true, values_status: /^problem\s*:/m.test(text) ? 'verified' : 'declared', values: entry.versions.at(-1)?.values ?? {}, content: text, diagnostics: [],
    });
  };

  const list = (request: CompositionRequest): CompositionReply => {
    const { query } = request;
    const kind = query.get('kind');
    const archived = query.get('archived');
    const needle = (query.get('q') ?? '').toLowerCase();
    const rows = entries.map((entry) => entry.view)
      .filter((view) => (!kind || view.kind === kind) && (archived === null || String(view.archived) === archived))
      .filter((view) => !needle || `${view.name} ${view.slug}`.toLowerCase().includes(needle))
      .sort((a, b) => (query.get('sort') === 'updated' ? b.updated_at.localeCompare(a.updated_at) : a.name.localeCompare(b.name)));
    const limit = Number(query.get('limit') ?? 50);
    return ok({ compositions: rows.slice(0, limit), total: rows.length, limit, offset: 0 });
  };

  const create = (request: CompositionRequest): CompositionReply => {
    const sent = request.body() as { slug?: string; name?: string; kind?: CompositionView['kind']; description?: string };
    if (entries.some((entry) => entry.view.slug === sent.slug)) {
      return { status: 409, json: { detail: { code: 'slug_conflict', error: 'That composition slug is in use in this organization.' } } };
    }
    created += 1;
    const now = new Date().toISOString();
    const view = composition(0x100 + created, String(sent.slug), String(sent.name), {
      kind: sent.kind ?? 'application', description: sent.description ?? '', created_at: now, updated_at: now,
    }, []);
    entries.push({ view, versions: [] });
    return ok(view, 201);
  };

  return {
    route(request, org) {
      if (org !== COMPOSITIONS_ORG) return request.parts[4] ? missing() : ok({ compositions: [], total: 0, limit: 50, offset: 0 });
      const [, , , , slug, section, ref, tail] = request.parts;
      if (!slug) return request.method === 'POST' ? create(request) : list(request);
      const entry = entries.find((item) => item.view.slug === slug);
      if (!entry) return missing();
      if (!section) return ok(entry.view);
      if (section !== 'versions') return { status: 404, json: { detail: 'not mocked' } };
      const newest = [...entry.versions].reverse();
      if (!ref && request.method === 'POST') return seal(entry, request.text());
      if (ref === 'check' && request.method === 'POST') return check(entry, request.text());
      if (!ref) {
        const ordered = request.query.get('order') === 'oldest' ? entry.versions : newest;
        return ok({ versions: ordered.map(lightRow), total: ordered.length, limit: 200, offset: 0 });
      }
      const version = entry.versions.find((item) => item.id === ref || item.label === ref || String(item.ordinal) === ref);
      if (!version) return { status: 404, json: { detail: { code: 'not_found', error: 'Composition version not found.' } } };
      if (tail === 'content') return { status: 200, text: texts.get(version.id) ?? '', type: 'application/yaml' };
      return ok(request.query.get('include') === 'document' ? version : { ...version, document: null });
    },

    language(request) {
      const [, , operation] = request.parts;
      if (request.method === 'GET' && operation === 'schema') return ok(SCHEMA);
      if (request.method !== 'POST') return null;
      switch (operation) {
        case 'validate': return ok(lint(request.text()));
        case 'parse': {
          const linted = lint(request.text());
          return linted.valid ? ok({ document: documentOf(request.text()), diagnostics: [] }) : refused(linted.diagnostics);
        }
        case 'serialise': return { status: 200, text: `${JSON.stringify(request.body(), null, 2)}\n`, type: 'application/yaml' };
        default: return null;
      }
    },
  };
}
