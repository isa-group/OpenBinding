import { readFileSync } from 'node:fs';
import type { CompositionVersionView, CompositionView } from '../../src/modules/core/api/types';
import { operationStore, type OperationStore } from './operationMock';
import { upstreamOf } from './sphereMock';

// The compositions of the shared mock (e2e/helpers/mockApi.ts registers them): in `isa-demo`, a declared composition and one linked
// to the problem `checkout-flow`, three versions each, with evaluations and analytics, and an archived one with no version. The
// linked versions are the gateway's own fixture (src/test/fixtures/core/fms.version.json) under other ids, labels and values; the
// declared ones follow src/test/fixtures/compositions/declared.yaml. A composition created through the mock is kept for the page.
// The diff of two versions is worked out here in the gateway's shape, from their documents and values.
// The facts of the compilation the linked versions were evaluated on are core/fms.facts.json, which mockApi.ts serves for it.
// On request (`{ evolution: true }`) a fourth composition with a longer history is seeded, for the evolution charts (J5).
// Deriving (`POST …/derive`, J1) writes the FMS fixture's binding of checkout-flow@1 into a composition, which from then on is
// evaluated: a check or a seal recomputes its values from T1's candidate, as the gateway's F1 fixtures give them (core/fms.version.json
// for one candidate, core/fms.diff.json for the other), and the diff of its two versions is that golden. Texts the mock writes are
// block YAML, and it reads back the texts it wrote.
// Deriving a binding (`revision` and `binding`, the Analysis tab) writes the FMS binding with those tasks bound otherwise, on the
// problem version named. The Analysis tab's `neighborhood` lists one move per other candidate each task of the linked problem has
// (core/fms.facts.json), and `evaluate` computes another binding's values from T1's candidate, as above.
// Settings change a composition (`PATCH`: name, description, archived, visibility) and delete it (`DELETE`). A fork (`POST …/fork`)
// goes to another organization of the account where it is MEMBER or more (mockApi.ts passes them), as a new private composition
// whose first version is the source version's, without its problem when it links one (`dropProblem`); the target's compositions
// are kept for the page, so the fork opens there.
// Another organization the account is not in, `lab-other` (J2), has a public composition linked to a problem of its own, whose
// candidates name the SPHERE plans they come from. A reader who is not a member of an organization (a visitor, or anybody signed in
// for another organization) reads its public compositions as the gateway serves them to a public reader (redacted: no member ids,
// no problem, revision or compilation ids, only the current evaluation without its findings, lineage only to a public source),
// finds its private ones missing, and may only fork; `GET /v1/compositions` lists the public compositions of every organization.

/** The organization that has compositions; every other one has none. */
export const COMPOSITIONS_ORG = 'isa-demo';

const ORGANIZATION = { id: 'org-isa-demo', slug: COMPOSITIONS_ORG, name: 'ISA Demo Group' };

/** An organization the account is not in, with a public composition (J2): anybody reads it, and anybody signed in forks it. */
export const PUBLIC_ORG = 'lab-other';
const OTHER_ORGANIZATION = { id: 'org-lab-other', slug: PUBLIC_ORG, name: 'Other Lab' };
const AUTHOR = '00000000-0000-4000-8000-000000000005';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const digest = (char: string) => `sha256-${char.repeat(64)}`;

/** The text of the declared versions: the fixture, at their label and cost. */
const DECLARED_TEXT = readFileSync(
  new URL('../../src/test/fixtures/compositions/declared.yaml', import.meta.url),
  'utf8'
);
const declaredText = (label: string, cost: number) =>
  DECLARED_TEXT.replace('version: 1.0.0', `version: ${label}`).replace(
    'value: 42.5',
    `value: ${cost}`
  );

const core = (file: string): Record<string, unknown> =>
  JSON.parse(
    readFileSync(new URL(`../../src/test/fixtures/core/${file}`, import.meta.url), 'utf8')
  );

// -- The declared composition: an order desk whose author wrote its values

const orderWorkflow = {
  seq: [
    'signIn',
    { and: ['notify', 'archive'] },
    {
      xor: [
        { probability: 0.7, flow: 'post' },
        { probability: 0.3, flow: 'courier' },
      ],
    },
  ],
};
const orderBinding = {
  signIn: { local: true },
  notify: {
    candidate: 'email.brevo.starter',
    from: { sphere: 'danruilop1/brevo', version: '6ade2d444b2b5b01c587d80d', plan: 'STARTER' },
  },
  archive: { candidate: 'storage.dropbox.plus' },
  post: { candidate: 'shipping.post.standard' },
  courier: { candidate: 'shipping.courier.express' },
};
const ORDER_OFFERING = { url: 'https://pricings.example.org/order-desk/pricing.yml' };
const ORDER_ANALYTICS = {
  tasks: 5,
  boundTasks: 4,
  localTasks: 1,
  providers: 4,
  upstreamPricings: 1,
  hasOffering: true,
  workflow: { depth: 2, and: 1, xor: 1, loop: 0 },
};

function declaredVersion(
  n: number,
  label: string,
  cost: number,
  createdAt: string
): CompositionVersionView {
  const values = {
    availability: { value: 0.995, unit: '1' },
    cost: { value: cost, unit: 'EUR/month' },
    latency: { value: 380, unit: 'ms' },
  };
  const evaluation = uuid(0xc100 + n);
  return {
    id: uuid(0xc000 + n),
    ordinal: n,
    label,
    syntax_version: '1.0',
    kind: 'application',
    values_status: 'declared',
    verified: false,
    content_digest: digest(String(n)),
    size_bytes: 980 + n,
    values,
    problem: null,
    offering: ORDER_OFFERING,
    evidence_run: null,
    based_on: null,
    forked_from: null,
    derivation: null,
    analytics: ORDER_ANALYTICS,
    created_by_id: AUTHOR,
    created_at: createdAt,
    current_evaluation_id: evaluation,
    current_evaluation: {
      id: evaluation,
      basis: 'declared',
      outcome: 'declared',
      compilation: null,
      created_at: createdAt,
    },
    evaluations: [
      {
        id: evaluation,
        basis: 'declared',
        outcome: 'declared',
        values,
        violations: [],
        diagnostics: [],
        compilation: null,
        binding: null,
        current: true,
        created_at: createdAt,
      },
    ],
    document: {
      syntaxVersion: '1.0',
      composition: 'order-desk',
      version: label,
      kind: 'application',
      workflow: orderWorkflow,
      binding: orderBinding,
      values: {
        availability: 0.995,
        cost: { value: cost, unit: 'EUR/month' },
        latency: { value: 380, unit: 'ms' },
      },
      offering: ORDER_OFFERING,
      evidence: { evaluatedBy: 'declared' },
    },
  };
}

// -- The linked composition: fleet routing, evaluated by the toolchain on the problem checkout-flow

const FMS = core('fms.version.json') as unknown as CompositionVersionView;
const PROBLEM_REF = `${COMPOSITIONS_ORG}/checkout-flow@2`;

function linkedVersion(
  n: number,
  label: string,
  cost: number,
  createdAt: string,
  over: Partial<CompositionVersionView> = {}
): CompositionVersionView {
  const version = structuredClone(FMS);
  const id = uuid(0xd000 + n);
  const evaluation = uuid(0xd100 + n);
  const values = { ...version.values, cost: { value: cost, unit: 'USD/month' } };
  const document = {
    ...version.document,
    composition: 'fleet-routing',
    version: label,
    kind: 'workflow',
    problem: { ...(version.document?.problem as object), ref: PROBLEM_REF },
  };
  return {
    ...version,
    id,
    ordinal: n,
    label,
    kind: 'workflow',
    values,
    created_at: createdAt,
    created_by_id: AUTHOR,
    content_digest: digest(String.fromCharCode(96 + n)),
    document: {
      ...document,
      values: { ...(version.document?.values as object), cost: { value: cost, unit: 'USD/month' } },
    },
    problem: version.problem && {
      ...version.problem,
      problem: { id: 'case-checkout', slug: 'checkout-flow', name: 'Checkout flow' },
      revision: { id: 'rev-2', revision: 2 },
    },
    current_evaluation_id: evaluation,
    current_evaluation: version.current_evaluation && {
      ...version.current_evaluation,
      id: evaluation,
      created_at: createdAt,
    },
    evaluations: version.evaluations.map(item => ({
      ...item,
      id: evaluation,
      values,
      created_at: createdAt,
    })),
    derivation: version.derivation && {
      ...version.derivation,
      revision: { id: 'rev-2', revision: 2 },
    },
    ...over,
  };
}

/** A version whose problem changed meaning after it was sealed: the installed toolchain no longer verifies its values. */
function semanticsChanged(version: CompositionVersionView): CompositionVersionView {
  return {
    ...version,
    verified: false,
    current_evaluation: version.current_evaluation && {
      ...version.current_evaluation,
      outcome: 'semantics_changed',
    },
    evaluations: version.evaluations.map(item => ({
      ...item,
      outcome: 'semantics_changed' as const,
    })),
  };
}

const RUN = uuid(0xa1);

// -- Derived from a run: the FMS binding of checkout-flow@1, evaluated by the mock's toolchain

/** The gateway's F1 diff golden of the FMS fixture: 1.0.0 → a 1.1.0 that binds T1 to another candidate. */
const FMS_DIFF = core('fms.diff.json') as {
  from: { id: string; label: string };
  to: { id: string; label: string };
  sections: Array<{
    key: string;
    entries: Array<{
      name: string;
      changes: Array<{ path: string; before: unknown; after: unknown }>;
    }>;
  }>;
};
const goldenChange = (section: string, name: string) =>
  FMS_DIFF.sections.find(item => item.key === section)?.entries.find(entry => entry.name === name)
    ?.changes[0];
const T1_BEFORE = String(goldenChange('binding', 'T1')?.before);
const T1_AFTER = String(goldenChange('binding', 'T1')?.after);
type Values = CompositionVersionView['values'];
/** The values of the FMS binding by T1's candidate: 1.0.0's, and 1.1.0's as the golden changes them. */
const FMS_VALUES: Record<string, Values> = {
  [T1_BEFORE]: FMS.values,
  [T1_AFTER]: Object.fromEntries(
    Object.entries(FMS.values).map(([name, value]) => {
      const change = goldenChange('values', name);
      return [name, change ? { ...value, value: Number(change.after) } : value];
    })
  ),
};
const DERIVED_REF = `${COMPOSITIONS_ORG}/problems/checkout-flow@1`;
const DERIVED_REVISION = { id: 'rev-checkout-1', revision: 1 };

/** The facts of the compilation the linked versions were evaluated on: what each task can take instead. */
const FMS_FACTS = core('fms.facts.json') as {
  tasks: Array<{
    id: string;
    kind: string;
    eligible: Array<{ candidate: string; written: string }>;
  }>;
};
/** The words the mock's toolchain gives the moves, in turn: one of each the gateway sends. */
const COMPARISONS = [
  'better',
  'trade-off',
  'worse',
  'infeasible',
  'equal',
  'repairs-feasibility',
] as const;

/** T1's candidate in a document's binding. */
const t1Of = (document: Record<string, unknown>) =>
  String(asFields(asFields(document.binding).T1).candidate ?? '');
/** What the mock's toolchain computes for a document of the FMS problem; the 1.0.0 values for a binding it does not know. */
const evaluated = (document: Record<string, unknown>): Values =>
  FMS_VALUES[t1Of(document)] ?? FMS.values;
/** Values as a document writes them: a bare number for unit `1`. */
const documentValues = (values: Values) =>
  Object.fromEntries(
    Object.entries(values).map(([name, { value, unit }]) => [
      name,
      unit === '1' ? value : { value, unit },
    ])
  );

function composition(
  n: number,
  slug: string,
  name: string,
  over: Partial<CompositionView>,
  versions: CompositionVersionView[]
): CompositionView {
  const latest = versions[versions.length - 1];
  return {
    id: uuid(0xb000 + n),
    slug,
    name,
    description: '',
    kind: 'application',
    archived: false,
    visibility: 'private',
    organization: ORGANIZATION,
    created_by_id: AUTHOR,
    created_at: versions[0]?.created_at ?? '2026-09-01T00:00:00Z',
    updated_at: latest?.created_at ?? '2026-09-01T00:00:00Z',
    version_count: versions.length,
    latest_version: latest
      ? {
          id: latest.id,
          ordinal: latest.ordinal,
          label: latest.label,
          values_status: latest.values_status,
          verified: latest.verified,
          created_at: latest.created_at,
        }
      : null,
    ...over,
  };
}

/** What a list row shows of a latest version: its tasks and providers (analytics) and its cost (its values). */
function figuresOf(versions: CompositionVersionView[]) {
  const latest = versions[versions.length - 1];
  if (!latest) return null;
  const analytics = (latest.analytics ?? {}) as Record<string, unknown>;
  const cost = latest.values?.cost as { value?: number; unit?: string } | number | undefined;
  const number = (value: unknown) => (typeof value === 'number' ? value : null);
  return {
    tasks: number(analytics.tasks),
    providers: number(analytics.providers),
    cost: typeof cost === 'number' ? cost : (cost?.value ?? null),
    cost_unit: typeof cost === 'object' ? (cost?.unit ?? null) : null,
  };
}

/** A list row with its latest version's figures, as the gateway lists it. */
function listed({ view, versions }: { view: CompositionView; versions: CompositionVersionView[] }) {
  return view.latest_version
    ? { ...view, latest_version: { ...view.latest_version, figures: figuresOf(versions) } }
    : view;
}

/** The facets of a list: the owners of every match, and the ranges as the gateway sends them (empty here). */
function facetsOf(rows: { organization: { slug: string; name: string } }[]) {
  const owners = new Map<string, { slug: string; name: string; count: number }>();
  for (const row of rows) {
    const owner = owners.get(row.organization.slug) ?? { ...row.organization, count: 0 };
    owner.count += 1;
    owners.set(row.organization.slug, owner);
  }
  const empty = { min: null, max: null, data: [] };
  return {
    owners: [...owners.values()].map(({ slug, name, count }) => ({ slug, name, count })),
    ranges: { tasks: empty, providers: empty, cost: empty },
  };
}

/** The kinds a list asks for: `kinds` (comma-separated) or the older `kind`. */
const kindsOf = (query: URLSearchParams) =>
  (query.get('kinds') ?? query.get('kind') ?? '').split(',').filter(Boolean);

interface Entry {
  view: CompositionView;
  /** Oldest first. */
  versions: CompositionVersionView[];
  /** A run was derived into it: its texts link the FMS problem and are evaluated by T1's candidate. */
  evaluated?: boolean;
}

/**
 * Notification hub (J5): two declared versions with costs in EUR/month, then linked to checkout-flow@1 (values verified, costs in
 * USD/month), then to checkout-flow@2, whose last version the installed toolchain no longer verifies.
 */
function evolutionEntry(): Entry {
  const hub = (
    version: CompositionVersionView,
    n: number,
    analytics: Record<string, unknown>
  ): CompositionVersionView => {
    const evaluation = uuid(0xf100 + n);
    return {
      ...version,
      id: uuid(0xf000 + n),
      kind: 'application',
      analytics,
      content_digest: digest(String.fromCharCode(103 + n)),
      derivation: null,
      current_evaluation_id: evaluation,
      current_evaluation: version.current_evaluation && {
        ...version.current_evaluation,
        id: evaluation,
      },
      evaluations: version.evaluations.map(item => ({ ...item, id: evaluation })),
      document: version.document && {
        ...version.document,
        composition: 'notification-hub',
        kind: 'application',
      },
    };
  };
  const onRevisionOne = (version: CompositionVersionView): CompositionVersionView => ({
    ...version,
    problem: version.problem && { ...version.problem, revision: { id: 'rev-1', revision: 1 } },
    document: version.document && {
      ...version.document,
      problem: {
        ...(version.document.problem as object),
        ref: `${COMPOSITIONS_ORG}/checkout-flow@1`,
      },
    },
  });
  const small = {
    ...ORDER_ANALYTICS,
    tasks: 4,
    boundTasks: 3,
    providers: 3,
    hasOffering: false,
    workflow: { depth: 2, and: 1, xor: 0, loop: 0 },
  };
  const linked = core('fms.version.json').analytics as Record<string, unknown>;
  const versions = [
    hub(declaredVersion(1, '1.0.0', 30, '2026-07-06T09:00:00Z'), 1, small),
    hub(declaredVersion(2, '1.1.0', 28, '2026-07-28T09:30:00Z'), 2, ORDER_ANALYTICS),
    hub(onRevisionOne(linkedVersion(3, '2.0.0', 31, '2026-08-19T10:00:00Z')), 3, linked),
    hub(linkedVersion(4, '2.1.0', 29, '2026-09-14T14:00:00Z'), 4, linked),
    hub(semanticsChanged(linkedVersion(5, '2.2.0', 29, '2026-10-12T16:30:00Z')), 5, linked),
  ];
  return {
    view: composition(
      4,
      'notification-hub',
      'Notification hub',
      { description: 'Tells customers about their orders by e-mail and text message.' },
      versions
    ),
    versions,
  };
}

// -- lab-other's public composition: fleet routing on a problem of its own, its candidates priced from SPHERE plans

/** The SPHERE plans two of its candidates come from: the showcase draws a reference card for each. */
const OTHER_FROM: Record<string, Record<string, string>> = {
  T1: { sphere: 'aws/ec2', version: '6650a1b2c3d4e5f600112233', plan: 'ON_DEMAND' },
  T6: { sphere: 'paypal/checkout', version: '6650a1b2c3d4e5f600445566', plan: 'STANDARD' },
};

function otherVersion(
  n: number,
  label: string,
  cost: number,
  createdAt: string
): CompositionVersionView {
  const version = linkedVersion(n, label, cost, createdAt);
  const evaluation = uuid(0x9100 + n);
  const document = asFields(version.document);
  const binding = Object.fromEntries(
    Object.entries(asFields(document.binding)).map(([task, entry]) => [
      task,
      OTHER_FROM[task] ? { ...asFields(entry), from: OTHER_FROM[task] } : entry,
    ])
  );
  return {
    ...version,
    id: uuid(0x9000 + n),
    content_digest: digest(String.fromCharCode(108 + n)),
    document: {
      ...document,
      problem: { ...asFields(document.problem), ref: `${PUBLIC_ORG}/problems/route-planning@3` },
      binding,
    },
    problem: version.problem && {
      ...version.problem,
      problem: { id: 'case-route-planning', slug: 'route-planning', name: 'Route planning' },
      revision: { id: 'rev-route-3', revision: 3 },
    },
    current_evaluation_id: evaluation,
    current_evaluation: version.current_evaluation && {
      ...version.current_evaluation,
      id: evaluation,
    },
    evaluations: version.evaluations.map(item => ({ ...item, id: evaluation })),
    derivation: null,
  };
}

/** The compositions of `lab-other`: one public, linked one. */
function otherEntries(): Entry[] {
  const versions = [
    otherVersion(1, '1.0.0', 3240, '2026-08-20T09:00:00Z'),
    otherVersion(2, '1.1.0', 3105, '2026-09-30T14:00:00Z'),
  ];
  const view = composition(
    5,
    'fleet-routing',
    'Fleet routing',
    {
      organization: OTHER_ORGANIZATION,
      kind: 'workflow',
      visibility: 'public',
      description:
        'Plans the delivery routes of a fleet: cloud compute, a routing API and payments, each priced from a SPHERE plan.',
    },
    versions
  );
  return [{ view, versions }];
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
    linkedVersion(3, '1.2.0', 2980, '2026-10-08T16:20:00Z', {
      derivation: {
        source: 'run',
        run: { id: RUN },
        point: 3,
        revision: { id: 'rev-2', revision: 2 },
      },
    }),
  ];
  return [
    {
      view: composition(
        1,
        'order-desk',
        'Order desk',
        {
          description:
            'Signs customers in, sends a notice and archives each order, then ships by post or courier.',
          visibility: 'public',
        },
        order
      ),
      versions: order,
    },
    {
      view: composition(
        2,
        'fleet-routing',
        'Fleet routing',
        {
          description: 'Routes the delivery fleet across the providers of each leg.',
          kind: 'workflow',
        },
        fleet
      ),
      versions: fleet,
    },
    {
      view: composition(
        3,
        'legacy-intake',
        'Legacy intake',
        {
          kind: 'pipeline',
          archived: true,
          updated_at: '2026-06-01T00:00:00Z',
          created_at: '2026-05-01T00:00:00Z',
        },
        []
      ),
      versions: [],
    },
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
  /** A request header, by lower-case name. */
  header?: (name: string) => string | undefined;
}

export interface CompositionReply {
  status: number;
  json?: unknown;
  text?: string;
  type?: string;
  headers?: Record<string, string>;
}

/** An organization of the account, as `GET /v1/organizations` lists it: where a fork may go. */
export interface MockOrganization {
  id: string;
  slug: string;
  name: string;
  effective_role: 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER' | null;
}

export interface CompositionStore {
  /** Answers `/v1/organizations/{org}/compositions…` for the organization `org`; a fork may go to one of `organizations`. */
  route: (
    request: CompositionRequest,
    org: string,
    organizations?: readonly MockOrganization[]
  ) => CompositionReply;
  /**
   * Answers `/v1/organizations/{org}/compositions…` for a reader who is not a member of `org`, signed in or not: the reads of a
   * public composition, redacted as the gateway redacts them, and its fork for a signed-in reader. Anything else is missing (404) to
   * somebody signed in, and asks a visitor for a session (401).
   */
  publicRoute: (
    request: CompositionRequest,
    org: string,
    signedIn: boolean,
    organizations?: readonly MockOrganization[]
  ) => CompositionReply;
  /** `GET /v1/compositions`: the public compositions of every organization, with the gateway's filters and paging. */
  publicList: (request: CompositionRequest) => CompositionReply;
  /** `GET /v1/users/me/compositions`: every composition the account reads as a member, across its organizations. */
  mineList: (request: CompositionRequest) => CompositionReply;
  /** `GET /v1/permalinks/compositions/{id}`: where a composition's permanent link leads (any composition; the page reads it). */
  permalink: (request: CompositionRequest) => CompositionReply;
  /** Answers the language services `/v1/compositions/{validate,parse,serialise,schema}`; null for anything else. */
  language: (request: CompositionRequest) => CompositionReply | null;
  /** TomatoMeter's environments, adoptions, keys, check and margins, when the page seeded it (e2e/helpers/operationMock.ts). */
  operation: OperationStore | null;
}

const KINDS = ['application', 'workflow', 'pipeline', 'system'];

/** The schema as far as completion reads it: the document's keys and the kinds. */
const SCHEMA = {
  type: 'object',
  properties: {
    syntaxVersion: { const: '1.0' },
    composition: { type: 'string' },
    version: { type: 'string' },
    kind: { enum: KINDS },
    problem: {
      type: 'object',
      properties: { ref: { type: 'string' }, compilation: { type: 'string' } },
    },
    workflow: {},
    binding: { type: 'object' },
    values: { type: 'object' },
    offering: { type: 'object' },
    evidence: { type: 'object' },
  },
};

const scalar = (text: string, key: string) =>
  new RegExp(`^${key}:[ \\t]*(.*)$`, 'm')
    .exec(text)?.[1]
    ?.trim()
    .replace(/^["']|["']$/g, '') ?? null;

const NUMBER_LIKE = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;
const RESERVED = /^(?:true|false|null|yes|no|on|off|~)$/i;
/** A scalar as block YAML writes it: plain when it reads back as the same string, double-quoted otherwise. */
function yamlScalar(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'string') return String(value);
  return /^[A-Za-z0-9_][\w./@+-]*$/.test(value) && !NUMBER_LIKE.test(value) && !RESERVED.test(value)
    ? value
    : JSON.stringify(value);
}

const isContainer = (value: unknown): value is Record<string, unknown> | unknown[] =>
  typeof value === 'object' && value !== null;
const isEmpty = (value: Record<string, unknown> | unknown[]) =>
  Array.isArray(value) ? value.length === 0 : Object.keys(value).length === 0;
const inline = (value: unknown) =>
  isContainer(value) && isEmpty(value) ? (Array.isArray(value) ? '[]' : '{}') : yamlScalar(value);

function yamlLines(value: Record<string, unknown> | unknown[], indent: number): string[] {
  const pad = ' '.repeat(indent);
  if (Array.isArray(value)) {
    return value.flatMap(item => {
      if (!isContainer(item) || isEmpty(item)) return [`${pad}- ${inline(item)}`];
      if (Array.isArray(item)) return [`${pad}-`, ...yamlLines(item, indent + 2)];
      const [first, ...rest] = yamlLines(item, indent + 2);
      return [`${pad}- ${first.trimStart()}`, ...rest];
    });
  }
  return Object.entries(value).flatMap(([key, item]) =>
    isContainer(item) && !isEmpty(item)
      ? [`${pad}${key}:`, ...yamlLines(item, indent + 2)]
      : [`${pad}${key}: ${inline(item)}`]
  );
}

/** A document as the mock writes it (`serialise`, a derivation, a check's canonical form): block YAML. */
const yamlText = (document: Record<string, unknown>) => `${yamlLines(document, 0).join('\n')}\n`;
/** The key a written text is read back by: its `version:` line may have been changed since. */
const readingKey = (text: string) => text.replace(/^version:.*$/m, '');

/** The mock's lint: an unknown `kind` is an error at its value; everything else passes. */
function lint(text: string) {
  const match = /^kind:[ \t]*(.*)$/m.exec(text);
  const value = match?.[1].trim() ?? '';
  if (!match || KINDS.includes(value)) return { valid: true, diagnostics: [] };
  const line = text.slice(0, match.index).split('\n').length;
  const column = match[0].indexOf(value, 'kind:'.length) + 1;
  return {
    valid: false,
    diagnostics: [
      {
        code: 'c2y_kind_unknown',
        message: `'${value}' is not a kind; a composition is one of ${KINDS.join(', ')}`,
        severity: 'error',
        path: 'kind',
        pointer: '/kind',
        span: { line, column, end_line: line, end_column: column + value.length },
      },
    ],
  };
}

const refused = (diagnostics: unknown[]): CompositionReply => ({
  status: 422,
  json: {
    type: 'about:blank',
    title: 'Unprocessable Content',
    status: 422,
    code: 'composition_invalid',
    detail: 'The document is not valid Composition2Yaml.',
    diagnostics,
  },
});

const ok = (json: unknown, status = 200): CompositionReply => ({ status, json });
const missing = (): CompositionReply => ({
  status: 404,
  json: { detail: { code: 'not_found', error: 'Composition not found.' } },
});

/** The light row of a version, as the versions list serves it: analytics only when `include` names them. */
const lightRow = (version: CompositionVersionView, include: string[]): CompositionVersionView => ({
  ...version,
  document: null,
  evaluations: [],
  analytics: include.includes('analytics') ? version.analytics : null,
});

/** Whether a version was sealed within `created_after` (inclusive) and `created_before` (exclusive), as the gateway filters. */
function sealedWithin(version: CompositionVersionView, query: URLSearchParams): boolean {
  const at = Date.parse(version.created_at);
  const after = query.get('created_after');
  const before = query.get('created_before');
  return (!after || at >= Date.parse(after)) && (!before || at < Date.parse(before));
}

type Fields = Record<string, unknown>;
type FieldChange = { path: string; before: unknown; after: unknown };
type DiffEntry = { kind: 'added' | 'removed' | 'changed'; name: string; changes: FieldChange[] };

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const asFields = (value: unknown): Fields =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Fields) : {};

/** The fields that differ between two entries, dotted (`from.version`), with `null` on the side where a field is absent. */
function fieldChanges(before: Fields, after: Fields, prefix = ''): FieldChange[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].flatMap(key => {
    const [b, a] = [before[key], after[key]];
    if (same(b, a)) return [];
    const nested =
      typeof b === 'object' &&
      b !== null &&
      typeof a === 'object' &&
      a !== null &&
      !Array.isArray(b) &&
      !Array.isArray(a);
    return nested
      ? fieldChanges(b as Fields, a as Fields, `${prefix}${key}.`)
      : [{ path: `${prefix}${key}`, before: b ?? null, after: a ?? null }];
  });
}

/** The entries of a section: by name, added, removed or changed in some field. */
function entries(before: Fields, after: Fields): DiffEntry[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].flatMap(
    (name): DiffEntry[] => {
      if (!(name in before))
        return [{ kind: 'added', name, changes: fieldChanges({}, asFields(after[name])) }];
      if (!(name in after))
        return [{ kind: 'removed', name, changes: fieldChanges(asFields(before[name]), {}) }];
      const changes = fieldChanges(asFields(before[name]), asFields(after[name]));
      return changes.length ? [{ kind: 'changed', name, changes }] : [];
    }
  );
}

/**
 * The mock's diff of two versions, in the gateway's shape (`GET …/diff`): binding entries from the documents, values from the
 * versions, the offering, and kind and workflow as general changes. Values compare when both sides have the same status and link.
 */
function versionDiff(before: CompositionVersionView, after: CompositionVersionView) {
  const [b, a] = [asFields(before.document), asFields(after.document)];
  const comparable =
    before.values_status === after.values_status &&
    same(asFields(b.problem).ref, asFields(a.problem).ref);
  const sections = [
    {
      key: 'binding',
      label: 'Binding',
      entries: entries(asFields(b.binding), asFields(a.binding)),
    },
    {
      key: 'values',
      label: 'Values',
      entries: comparable ? entries(before.values, after.values) : [],
    },
    {
      key: 'offering',
      label: 'Offering',
      entries: entries(
        before.offering ? { offering: before.offering } : {},
        after.offering ? { offering: after.offering } : {}
      ),
    },
  ];
  const general = ['kind', 'workflow']
    .filter(key => !same(b[key], a[key]))
    .map(key => ({ path: key, before: b[key] ?? null, after: a[key] ?? null }));
  const all = sections.flatMap(section => section.entries);
  const count = (kind: DiffEntry['kind']) => all.filter(entry => entry.kind === kind).length;
  return {
    from: { id: before.id, label: before.label },
    to: { id: after.id, label: after.label },
    comparison: {
      comparable,
      problemRefChanged: !same(asFields(b.problem).ref, asFields(a.problem).ref),
      compilationChanged: false,
      valueStatus: { before: before.values_status, after: after.values_status },
    },
    sections,
    general,
    totals: {
      added: count('added'),
      removed: count('removed'),
      changed: count('changed') + general.length,
    },
    isEmpty: all.length === 0 && general.length === 0,
  };
}

/** A version as a public reader gets it: what the document does not say is removed; lineage only to a public source. */
function publicVersion(
  version: CompositionVersionView,
  sourceIsPublic: (id: string | null | undefined) => boolean
): CompositionVersionView {
  const current = version.evaluations.find(item => item.current) ?? version.evaluations[0];
  const forked = version.forked_from;
  return {
    ...version,
    created_by_id: null,
    based_on: null,
    forked_from:
      forked &&
      (sourceIsPublic(forked.compositionId)
        ? forked
        : {
            droppedProblem: forked.droppedProblem,
            compositionId: null,
            versionId: null,
            label: null,
            organization: null,
            slug: null,
            name: null,
          }),
    problem: version.problem && {
      ...version.problem,
      problem: { ...version.problem.problem, id: null, name: null },
      revision: { ...version.problem.revision, id: null },
      linked_compilation: { ...version.problem.linked_compilation, id: null },
    },
    current_evaluation: version.current_evaluation && {
      ...version.current_evaluation,
      compilation: version.current_evaluation.compilation && {
        ...version.current_evaluation.compilation,
        id: null,
      },
    },
    evaluations: current
      ? [
          {
            ...current,
            diagnostics: [],
            violations: [],
            binding: null,
            compilation: current.compilation && { ...current.compilation, id: null },
          },
        ]
      : [],
    derivation: version.derivation && {
      ...version.derivation,
      revision: { ...version.derivation.revision, id: null },
    },
  } as CompositionVersionView;
}

/**
 * TomatoMeter (F3 J4, F4): the composition the lab makes from its template, whose version 1.0.0 is the gateway's fixture
 * (core/tomatometer-email.version.json: Brevo PROFESSIONAL and Dropbox PLUS pinned by `from`, the offering `sphere/tomatometer`
 * read when it was evaluated) and whose version 1.1.0 binds Brevo STANDARD of the same pricing version instead.
 */
function tomatometerEntry(): Entry {
  const base = core('tomatometer-email.version.json') as unknown as CompositionVersionView;
  const problem = base.problem && {
    ...base.problem,
    problem: {
      id: 'case-tomatometer-email',
      slug: 'tomatometer-email',
      name: 'TomatoMeter e-mail',
    },
    revision: { id: 'rev-tomatometer-2', revision: 2 },
  };
  const first: CompositionVersionView = {
    ...structuredClone(base),
    id: uuid(0xe001),
    created_at: '2026-10-03T09:00:00Z',
    created_by_id: AUTHOR,
    problem,
  };
  const document = structuredClone(base.document ?? {}) as Record<string, unknown> & {
    binding: Record<string, Record<string, unknown>>;
  };
  document.version = '1.1.0';
  document.binding.dailySummary = {
    candidate: 'email.brevo.standard',
    from: { plan: 'STANDARD', sphere: 'danruilop1/brevo', version: '6ade2d444b2b5b01c587d80d' },
  };
  const second: CompositionVersionView = {
    ...structuredClone(first),
    id: uuid(0xe002),
    ordinal: 2,
    label: '1.1.0',
    created_at: '2026-10-04T09:00:00Z',
    content_digest: digest('e'),
    document,
    values: { ...first.values, subscription: { value: 90, unit: 'USD/month' } },
  };
  const versions = [first, second];
  return {
    view: composition(
      5,
      'tomatometer',
      'TomatoMeter',
      {
        description:
          'Daily summaries by e-mail, with plans of SPHERE pricings; its own offering is TomatoMeter’s pricing.',
        visibility: 'public',
      },
      versions
    ),
    versions,
  };
}

/** What a page's store seeds beyond the three compositions every page has. */
export interface CompositionSeed {
  /** Also seed Notification hub, whose history the evolution charts draw (J5). */
  evolution?: boolean;
  /** Also seed TomatoMeter, with upstream plans and an offering drawn from snapshots (F3 J4). */
  tomatometer?: boolean;
}

/** A store of compositions for one page: the seeded ones plus what the page creates. */
export function compositionStore(options: CompositionSeed = {}): CompositionStore {
  const entries = seed();
  if (options.evolution) entries.push(evolutionEntry());
  if (options.tomatometer) entries.push(tomatometerEntry());
  const operation = options.tomatometer ? operationStore(COMPOSITIONS_ORG, 'tomatometer') : null;
  /** The compositions of the other organizations: lab-other's, and those forks made, by organization slug. */
  const others = new Map<string, Entry[]>([[PUBLIC_ORG, otherEntries()]]);
  const allEntries = () => [...entries, ...[...others.values()].flat()];
  let created = 0;
  let sealed = 0;
  /** The stored text of each version, by id. */
  const texts = new Map<string, string>();
  for (const entry of allEntries()) {
    for (const version of entry.versions) {
      const cost = (version.values.cost as { value: number } | undefined)?.value ?? 0;
      texts.set(
        version.id,
        version.values_status === 'declared'
          ? declaredText(version.label, cost)
          : `${JSON.stringify(version.document, null, 2)}\n`
      );
    }
  }

  /** The documents of the texts the mock wrote, by `readingKey`. */
  const written = new Map<string, Record<string, unknown>>();
  const write = (document: Record<string, unknown>): string => {
    const text = yamlText(document);
    written.set(readingKey(text), structuredClone(document));
    return text;
  };

  /**
   * A text read back: the document the mock wrote it from, or else the stored document of its composition; either with the text's
   * label and kind.
   */
  const documentOf = (text: string): Record<string, unknown> => {
    const slug = scalar(text, 'composition') ?? '';
    const latest = entries.find(entry => entry.view.slug === slug)?.versions.at(-1);
    const base = written.get(readingKey(text)) ??
      (latest?.document as Record<string, unknown> | null | undefined) ?? {
        syntaxVersion: '1.0',
        composition: slug,
        workflow: null,
        binding: {},
        values: {},
      };
    return {
      ...structuredClone(base),
      version: scalar(text, 'version') ?? '',
      kind: scalar(text, 'kind') ?? '',
    };
  };

  /** A new version of an entry with this label, text and document: a copy of `from` (by default its latest version), changed by `over`. */
  const store = (
    entry: Entry,
    label: string,
    text: string,
    document: Record<string, unknown>,
    over: Partial<CompositionVersionView> = {},
    from: CompositionVersionView | undefined = entry.versions.at(-1)
  ) => {
    sealed += 1;
    const now = new Date().toISOString();
    const version: CompositionVersionView = {
      ...structuredClone(from ?? declaredVersion(0, label, 0, now)),
      id: uuid(0xe000 + sealed),
      ordinal: entry.versions.length + 1,
      label,
      created_at: now,
      content_digest: digest('e'),
      document: { ...document, composition: entry.view.slug },
      ...over,
    };
    entry.versions.push(version);
    texts.set(version.id, text);
    entry.view = {
      ...entry.view,
      updated_at: now,
      version_count: entry.versions.length,
      latest_version: {
        id: version.id,
        ordinal: version.ordinal,
        label,
        values_status: version.values_status,
        verified: version.verified,
        created_at: now,
      },
    };
    return version;
  };

  /** What an evaluated entry's version holds for these values: its values and its evaluation's. */
  const evaluatedFields = (
    version: CompositionVersionView,
    values: Values
  ): Partial<CompositionVersionView> => ({
    values,
    values_status: 'verified',
    verified: true,
    evaluations: version.evaluations.map(item => ({
      ...item,
      values,
      outcome: 'verified' as const,
    })),
    current_evaluation: version.current_evaluation && {
      ...version.current_evaluation,
      outcome: 'verified' as const,
    },
  });

  /**
   * `POST …/derive`, previewed (`seal: false`) or sealed as `version`: from a run, the FMS binding of checkout-flow@1; from a binding
   * (`revision`, `binding`), the FMS binding with the tasks it names bound otherwise, on that problem version.
   */
  const derive = (entry: Entry, request: CompositionRequest): CompositionReply => {
    const sent = request.body() as {
      run?: string;
      point?: number;
      revision?: string;
      binding?: Record<string, string>;
      version?: string;
      seal?: boolean;
    };
    const label = String(sent.version ?? '');
    const run = sent.run ? String(sent.run) : null;
    const point = run ? (sent.point ?? 0) : null;
    const fms = FMS.document as Record<string, unknown>;
    const rebound = Object.fromEntries(
      Object.entries(sent.binding ?? {}).map(([task, candidate]) => [task, { candidate }])
    );
    const binding = { ...asFields(fms.binding), ...rebound };
    const revision = run
      ? DERIVED_REVISION
      : {
          id: `rev-${String(sent.revision)}`,
          revision: Number(String(sent.revision).split('@')[1] ?? 1),
        };
    const ref = run ? DERIVED_REF : `${COMPOSITIONS_ORG}/problems/${String(sent.revision)}`;
    const values = evaluated({ binding });
    const document = {
      syntaxVersion: '1.0',
      composition: entry.view.slug,
      version: label,
      kind: entry.view.kind,
      problem: { ref, compilation: asFields(fms.problem).compilation },
      workflow: fms.workflow,
      binding,
      values: documentValues(values),
      evidence: run
        ? { run, point, evaluatedBy: 'gateway', toolchain: 'bim-core 0.2.0' }
        : { evaluatedBy: 'gateway', toolchain: 'bim-core 0.2.0' },
    };
    const text = write(document);
    entry.evaluated = true;
    if (sent.seal === false) return ok({ content: text, document, values, diagnostics: [] });
    const existing = entry.versions.find(version => version.label === label);
    if (existing && texts.get(existing.id) !== text) {
      return {
        status: 409,
        json: {
          detail: {
            code: 'version_label_taken',
            error: `Version ${label} already holds another content.`,
          },
        },
      };
    }
    const base = structuredClone(FMS);
    const version =
      existing ??
      store(
        entry,
        label,
        text,
        document,
        {
          ...evaluatedFields(base, values),
          kind: entry.view.kind,
          created_by_id: AUTHOR,
          evidence_run: run ? { id: run } : null,
          problem: base.problem && {
            ...base.problem,
            problem: { id: 'case-checkout-flow', slug: 'checkout-flow', name: 'Checkout flow' },
            revision,
          },
          derivation: run
            ? { source: 'run', run: { id: run }, point, revision }
            : { source: 'binding', run: null, point: null, revision },
        },
        base
      );
    const derivation = {
      id: uuid(0xe200 + version.ordinal),
      source: run ? 'run' : 'binding',
      revision_id: revision.id,
      compilation_id: base.problem?.linked_compilation?.id,
      binding: {},
      binding_digest: digest('d'),
      provenance: {},
      job_id: run,
      point,
      created_by_id: AUTHOR,
      created_at: version.created_at,
    };
    return ok(
      { version, evaluation: version.evaluations[0], derivation, diagnostics: [] },
      existing ? 200 : 201
    );
  };

  /** The version a request names (`version`: an id, a label or an ordinal), the latest by default; null when there is none. */
  const named = (entry: Entry, ref: unknown) =>
    ref === undefined || ref === null || ref === ''
      ? (entry.versions.at(-1) ?? null)
      : (entry.versions.find(
          item => item.id === ref || item.label === ref || String(item.ordinal) === String(ref)
        ) ?? null);

  /** What `evaluate` and `neighborhood` refuse before the toolchain has a say: no version, or a version that links no problem. */
  const unanalysable = (
    entry: Entry,
    version: CompositionVersionView | null
  ): CompositionReply | null => {
    if (!version) {
      return entry.versions.length === 0
        ? {
            status: 409,
            json: {
              detail: {
                code: 'composition_empty',
                error: 'This composition has no version yet: seal one before evaluating it.',
              },
            },
          }
        : {
            status: 404,
            json: { detail: { code: 'not_found', error: 'Composition version not found.' } },
          };
    }
    if (!version.problem) {
      return {
        status: 422,
        json: {
          type: 'about:blank',
          title: 'Unprocessable Content',
          status: 422,
          code: 'composition_not_linked',
          detail: `Version ${version.label} links no problem.`,
          diagnostics: [],
        },
      };
    }
    return null;
  };

  /** `POST …/evaluate`: another binding of a linked version, its values computed from T1's candidate; nothing is stored. */
  const evaluate = (entry: Entry, request: CompositionRequest): CompositionReply => {
    const sent = request.body() as { version?: string; binding?: Record<string, string> };
    const version = named(entry, sent.version);
    const refusal = unanalysable(entry, version);
    if (refusal || !version) return refusal ?? missing();
    const document = asFields(version.document);
    const tasks = new Set(FMS_FACTS.tasks.map(task => task.id));
    const unknown = Object.keys(sent.binding ?? {}).filter(task => !tasks.has(task));
    if (unknown.length) {
      return {
        status: 422,
        json: {
          type: 'about:blank',
          title: 'Unprocessable Content',
          status: 422,
          code: 'evaluation_invalid',
          detail: 'The binding names what the version does not have.',
          diagnostics: unknown.map(task => ({
            code: 'c2y_binding_unknown_task',
            message: `the version's workflow has no task '${task}'`,
            severity: 'error',
            path: `binding.${task}`,
            pointer: `/binding/${task}`,
            span: null,
          })),
        },
      };
    }
    const rebound = Object.fromEntries(
      Object.entries(sent.binding ?? {}).map(([task, candidate]) => [task, { candidate }])
    );
    const values = Object.keys(rebound).length
      ? evaluated({ binding: { ...asFields(document.binding), ...rebound } })
      : version.values;
    return ok({
      version: { id: version.id, label: version.label },
      valid: true,
      values,
      violations: [],
      diagnostics: [],
    });
  };

  /** `GET …/neighborhood`: one move per other candidate of each service task, with the mock toolchain's words and deltas. */
  const neighbourhood = (entry: Entry, request: CompositionRequest): CompositionReply => {
    const version = named(entry, request.query.get('version'));
    const refusal = unanalysable(entry, version);
    if (refusal || !version) return refusal ?? missing();
    const bound = asFields(asFields(version.document).binding);
    const limit = Number(request.query.get('limit') ?? 64);
    const task = request.query.get('task');
    const tasks = FMS_FACTS.tasks.filter(
      item => item.kind === 'service' && (!task || item.id === task)
    );
    const choices = tasks.flatMap(item =>
      item.eligible
        .filter(eligible => eligible.written !== String(asFields(bound[item.id]).candidate ?? ''))
        .map(eligible => ({
          task: item.id,
          eligible,
          from: String(asFields(bound[item.id]).candidate ?? ''),
        }))
    );
    const moves = choices.slice(0, limit).map(({ task: id, eligible, from }, index) => {
      const comparison = COMPARISONS[index % COMPARISONS.length];
      const [resource, ...rest] = eligible.candidate.split('/');
      const step = (index + 1) * 10;
      return {
        task: id,
        candidate: eligible.written,
        from: { resource, id: from },
        to: { resource, id: rest.join('/') },
        decision: { kind: 'binding' },
        objectives: {},
        feasible: comparison !== 'infeasible',
        comparison,
        componentDeltas: [
          { feature: 'cost', value: comparison === 'better' ? -step : step, loss: 0 },
          { feature: 'execution_time', value: comparison === 'trade-off' ? -step : step, loss: 0 },
        ],
        penaltyDelta: comparison === 'infeasible' ? 5 : 0,
        violations:
          comparison === 'infeasible'
            ? [
                {
                  constraint: { resource: 'rules', id: 'eu-only' },
                  enforcement: 'hard',
                  penalty: 5,
                  message: 'Keep the data in the EU',
                },
              ]
            : [],
      };
    });
    const improving = moves.filter(
      move => move.comparison === 'better' || move.comparison === 'repairs-feasibility'
    ).length;
    return ok({
      version: { id: version.id, label: version.label },
      kind: 'canonical-one-task-counterfactuals',
      irDigest: digest('f'),
      scope: task ? 'selected-service-task' : 'all-service-tasks',
      task,
      base: {},
      moves,
      failures: [],
      coverage: {
        total: choices.length,
        attempted: moves.length,
        evaluated: moves.length,
        complete: moves.length === choices.length,
        limit,
        stopReason: moves.length === choices.length ? null : 'evaluation-limit',
        perTask: Object.fromEntries(tasks.map(item => [item.id, item.eligible.length - 1])),
      },
      conclusion: `Found ${improving} feasible canonical improvements or feasibility repairs. Every eligible one-task move in this scope was evaluated.`,
      semantics: 'Re-evaluated with the current canonical evaluator.',
    });
  };

  const seal = (entry: Entry, text: string): CompositionReply => {
    const linted = lint(text);
    if (!linted.valid) return refused(linted.diagnostics);
    const label = scalar(text, 'version') ?? '';
    const existing = entry.versions.find(version => version.label === label);
    if (existing && texts.get(existing.id) === text)
      return ok({ version: existing, evaluation: existing.evaluations[0], diagnostics: [] });
    if (existing)
      return {
        status: 409,
        json: {
          detail: {
            code: 'version_label_taken',
            error: `Version ${label} already holds another content.`,
          },
        },
      };
    const document = documentOf(text);
    const latest = entry.versions.at(-1);
    const over =
      entry.evaluated && latest
        ? { ...evaluatedFields(latest, evaluated(document)), derivation: null, evidence_run: null }
        : {};
    const version = store(entry, label, text, document, over);
    return ok({ version, evaluation: version.evaluations[0], diagnostics: [] }, 201);
  };

  const check = (entry: Entry, text: string): CompositionReply => {
    const linted = lint(text);
    if (!linted.valid)
      return ok({
        valid: false,
        values_status: null,
        values: null,
        content: null,
        diagnostics: linted.diagnostics,
      });
    if (entry.evaluated && /^problem\s*:/m.test(text)) {
      // The toolchain computes the values of the binding the text names; the canonical form states them.
      const document = documentOf(text);
      const values = evaluated(document);
      return ok({
        valid: true,
        values_status: 'verified',
        values,
        content: write({ ...document, values: documentValues(values) }),
        diagnostics: [],
      });
    }
    return ok({
      valid: true,
      values_status: /^problem\s*:/m.test(text) ? 'verified' : 'declared',
      values: entry.versions.at(-1)?.values ?? {},
      content: text,
      diagnostics: [],
    });
  };

  const poolOf = (org: string): Entry[] =>
    org === COMPOSITIONS_ORG ? entries : (others.get(org) ?? []);
  /** The compositions of an organization, kept from now on (a fork goes there). */
  const keptPoolOf = (org: string): Entry[] => {
    if (org === COMPOSITIONS_ORG) return entries;
    const pool = others.get(org) ?? [];
    others.set(org, pool);
    return pool;
  };
  /** Whether the composition with this id is public now: a public reader's lineage names only such a source. */
  const isPublic = (id: string | null | undefined) =>
    allEntries().some(entry => entry.view.id === id && entry.view.visibility === 'public');

  const list = (request: CompositionRequest, pool: Entry[]): CompositionReply => {
    const { query } = request;
    const kinds = kindsOf(query);
    const archived = query.get('archived');
    const owners = (query.get('owners') ?? '').split(',').filter(Boolean);
    const needle = (query.get('q') ?? '').toLowerCase();
    // `problem`: the compositions with a version linking a revision of that problem (its slug or id).
    const problem = query.get('problem');
    const matched = pool
      .filter(
        entry =>
          !problem ||
          entry.versions.some(
            version =>
              version.problem?.problem.slug === problem || version.problem?.problem.id === problem
          )
      )
      .filter(
        ({ view }) =>
          (!kinds.length || kinds.includes(view.kind)) &&
          (archived === null || String(view.archived) === archived)
      )
      .filter(({ view }) => !needle || `${view.name} ${view.slug}`.toLowerCase().includes(needle))
      .sort((a, b) =>
        query.get('sort') === 'updated'
          ? b.view.updated_at.localeCompare(a.view.updated_at)
          : a.view.name.localeCompare(b.view.name)
      );
    const rows = matched
      .filter(({ view }) => !owners.length || owners.includes(view.organization.slug))
      .map(listed);
    const limit = Number(query.get('limit') ?? 50);
    const offset = Number(query.get('offset') ?? 0);
    return ok({
      compositions: rows.slice(offset, offset + limit),
      total: rows.length,
      limit,
      offset,
      facets: facetsOf(matched.map(entry => entry.view)),
    });
  };

  const create = (request: CompositionRequest): CompositionReply => {
    const sent = request.body() as {
      slug?: string;
      name?: string;
      kind?: CompositionView['kind'];
      description?: string;
    };
    if (entries.some(entry => entry.view.slug === sent.slug)) {
      return {
        status: 409,
        json: {
          detail: {
            code: 'slug_conflict',
            error: 'That composition slug is in use in this organization.',
          },
        },
      };
    }
    created += 1;
    const now = new Date().toISOString();
    const view = composition(
      0x100 + created,
      String(sent.slug),
      String(sent.name),
      {
        kind: sent.kind ?? 'application',
        description: sent.description ?? '',
        created_at: now,
        updated_at: now,
      },
      []
    );
    entries.push({ view, versions: [] });
    return ok(view, 201);
  };

  /** `PATCH` a composition: its name, description, archived state and visibility, as sent. */
  const update = (entry: Entry, request: CompositionRequest): CompositionReply => {
    const sent = request.body() as Partial<
      Pick<CompositionView, 'name' | 'description' | 'archived' | 'visibility'>
    >;
    const changed = Object.fromEntries(
      Object.entries(sent).filter(
        ([key, value]) =>
          ['name', 'description', 'archived', 'visibility'].includes(key) &&
          value !== null &&
          value !== undefined
      )
    );
    entry.view = { ...entry.view, ...changed, updated_at: new Date().toISOString() };
    return ok(entry.view);
  };

  /**
   * `POST …/fork`: the version named into another organization of the account, as a new private composition. A version that links a
   * problem needs `dropProblem`, and its copy is declared; without `slug`, a target that has the source's slug answers `nameTaken`.
   */
  const fork = (
    entry: Entry,
    request: CompositionRequest,
    organizations: readonly MockOrganization[],
    source: string
  ): CompositionReply => {
    const sent = request.body() as {
      version?: string;
      targetOrganization?: string;
      dropProblem?: boolean;
      slug?: string;
      name?: string;
      description?: string;
    };
    const version = named(entry, sent.version);
    if (!version)
      return {
        status: 404,
        json: { detail: { code: 'not_found', error: 'Composition version not found.' } },
      };
    const target = organizations.find(
      item => item.slug === sent.targetOrganization || item.id === sent.targetOrganization
    );
    if (!target || target.effective_role === null || target.effective_role === 'VIEWER') {
      return {
        status: 403,
        json: {
          detail: {
            code: 'organization_forbidden',
            error: 'This action requires MEMBER access to the organization.',
          },
        },
      };
    }
    if (target.slug === source) {
      return {
        status: 409,
        json: {
          detail: {
            code: 'composition_fork_same_organization',
            error:
              'A fork goes to another organization; to change this composition, seal a new version of it instead.',
          },
        },
      };
    }
    const linked = version.problem !== null;
    if (linked && !sent.dropProblem) {
      return {
        status: 409,
        json: {
          detail: {
            code: 'composition_fork_problem_unreadable',
            error:
              'This version links a problem of its own organization, which the target organization cannot read.',
          },
        },
      };
    }
    const pool = keptPoolOf(target.slug);
    const wanted = sent.slug ?? entry.view.slug;
    const holder = pool.find(item => item.view.slug === wanted);
    if (holder && !sent.slug)
      return ok({
        nameTaken: true,
        existingComposition: { id: holder.view.id, slug: holder.view.slug, name: holder.view.name },
      });
    if (holder)
      return {
        status: 409,
        json: {
          detail: {
            code: 'slug_conflict',
            error: 'That composition slug is in use in this organization.',
          },
        },
      };

    created += 1;
    const now = new Date().toISOString();
    const document: Fields = {
      ...structuredClone(asFields(version.document)),
      composition: wanted,
    };
    if (linked) {
      delete document.problem;
      delete document.evidence;
    }
    const copy: CompositionVersionView = {
      ...structuredClone(version),
      id: uuid(0xe800 + created),
      ordinal: 1,
      created_at: now,
      created_by_id: AUTHOR,
      document,
      based_on: { composition_id: entry.view.id, version_id: version.id, label: version.label },
      forked_from: {
        droppedProblem: linked,
        compositionId: entry.view.id,
        versionId: version.id,
        label: version.label,
        name: entry.view.name,
        slug: entry.view.slug,
        organization: {
          id: entry.view.organization.id,
          name: entry.view.organization.slug,
          displayName: entry.view.organization.name,
        },
      },
      ...(linked
        ? ({
            problem: null,
            values_status: 'declared',
            verified: false,
            evidence_run: null,
            derivation: null,
            current_evaluation: version.current_evaluation && {
              ...version.current_evaluation,
              basis: 'declared',
              outcome: 'declared',
              compilation: null,
            },
            evaluations: version.evaluations.map(item => ({
              ...item,
              basis: 'declared',
              outcome: 'declared',
              compilation: null,
              binding: null,
              diagnostics: [],
              violations: [],
            })),
          } as Partial<CompositionVersionView>)
        : {}),
    };
    texts.set(copy.id, write(document));
    const view = composition(
      0x200 + created,
      wanted,
      sent.name ?? entry.view.name,
      {
        organization: { id: target.id, slug: target.slug, name: target.name },
        kind: entry.view.kind,
        description: sent.description ?? entry.view.description,
        visibility: 'private',
      },
      [copy]
    );
    pool.push({ view, versions: [copy] });
    return ok({ composition: view, version: copy, droppedProblem: linked }, 201);
  };

  /** `GET …/graph`: the composition's lane and, when its first version was forked, the lane of its source. */
  const graphOf = (entry: Entry): CompositionReply => {
    const lane = (item: Entry, role: 'current' | 'source') => ({
      composition_id: item.view.id,
      role,
      available: true,
      name: item.view.name,
      slug: item.view.slug,
      organization: {
        id: item.view.organization.id,
        slug: item.view.organization.slug,
        name: item.view.organization.name,
      },
      versions: item.versions.map(version => ({
        id: version.id,
        label: version.label,
        created_at: version.created_at,
        forked_from: version.forked_from
          ? {
              composition_id: version.forked_from.compositionId,
              version_id: version.forked_from.versionId,
              label: version.forked_from.label,
            }
          : null,
      })),
    });
    const sourceId = entry.versions.find(version => version.forked_from)?.forked_from
      ?.compositionId;
    const source = sourceId ? allEntries().find(item => item.view.id === sourceId) : undefined;
    return ok({
      lanes: [...(source ? [lane(source, 'source')] : []), lane(entry, 'current')],
      truncated: false,
    });
  };

  /** The answer to a member of `org`. */
  const answer = (
    request: CompositionRequest,
    org: string,
    organizations: readonly MockOrganization[] = []
  ): CompositionReply => {
    const [, , , , slug, section, ref, tail] = request.parts;
    const pool = poolOf(org);
    if (!slug)
      return request.method === 'POST' && org === COMPOSITIONS_ORG
        ? create(request)
        : list(request, pool);
    const entry = pool.find(item => item.view.slug === slug);
    if (!entry) return missing();
    if (!section && request.method === 'PATCH') return update(entry, request);
    if (!section && request.method === 'DELETE') {
      pool.splice(pool.indexOf(entry), 1);
      return { status: 204 };
    }
    if (!section) return ok(entry.view);
    if (section === 'fork' && request.method === 'POST')
      return fork(entry, request, organizations, org);
    if (section === 'derive' && request.method === 'POST') return derive(entry, request);
    if (section === 'graph' && request.method === 'GET') return graphOf(entry);
    if (section === 'download' && request.method === 'GET')
      return { status: 200, text: 'PK', type: 'application/zip' };
    if (section === 'evaluate' && request.method === 'POST') return evaluate(entry, request);
    if (section === 'neighborhood' && request.method === 'GET')
      return neighbourhood(entry, request);
    if (section === 'environments')
      return operation && slug === 'tomatometer'
        ? operation.route(request, entry.versions)
        : ok({ environments: [] });
    const find = (value: string | null) =>
      entry.versions.find(
        item => item.id === value || item.label === value || String(item.ordinal) === value
      );
    if (section === 'diff') {
      const to = request.query.get('to') ? find(request.query.get('to')) : entry.versions.at(-1);
      const from = request.query.get('from')
        ? find(request.query.get('from'))
        : to && entry.versions[entry.versions.indexOf(to) - 1];
      if (!to || !from)
        return {
          status: 409,
          json: {
            detail: { code: 'diff_version_missing', error: 'There is no version to compare with.' },
          },
        };
      // The pair the gateway's F1 diff golden compares answers that golden, under these versions' ids and labels.
      const golden =
        entry.evaluated &&
        t1Of(asFields(from.document)) === T1_BEFORE &&
        t1Of(asFields(to.document)) === T1_AFTER;
      if (golden)
        return ok({
          ...structuredClone(FMS_DIFF),
          from: { id: from.id, label: from.label },
          to: { id: to.id, label: to.label },
        });
      return ok(versionDiff(from, to));
    }
    // The upstream plans and the offering of a version, from stored data (e2e/helpers/sphereMock.ts).
    if (section === 'upstream' && request.method === 'GET') {
      const asked = request.query.get('version');
      const version = asked ? find(asked) : entry.versions.at(-1);
      if (!version)
        return {
          status: 404,
          json: { detail: { code: 'not_found', error: 'Composition version not found.' } },
        };
      return ok(upstreamOf(version));
    }
    if (section !== 'versions') return { status: 404, json: { detail: 'not mocked' } };
    const newest = [...entry.versions].reverse();
    if (!ref && request.method === 'POST') return seal(entry, request.text());
    if (ref === 'check' && request.method === 'POST') return check(entry, request.text());
    if (!ref) {
      const ordered = (request.query.get('order') === 'oldest' ? entry.versions : newest).filter(
        version => sealedWithin(version, request.query)
      );
      const include = (request.query.get('include') ?? '').split(',');
      return ok({
        versions: ordered.map(version => lightRow(version, include)),
        total: ordered.length,
        limit: 200,
        offset: 0,
      });
    }
    const version = find(ref);
    if (!version)
      return {
        status: 404,
        json: { detail: { code: 'not_found', error: 'Composition version not found.' } },
      };
    if (tail === 'content')
      return { status: 200, text: texts.get(version.id) ?? '', type: 'application/yaml' };
    if (tail === 'margins' && request.method === 'GET')
      return operation && slug === 'tomatometer'
        ? operation.margins(request, version)
        : ok({
            version: { id: version.id, label: version.label },
            evaluation: null,
            offering: null,
            cost: null,
            users: null,
            billing: null,
            apportionment: 'uniform',
            status: 'no_offering',
            currency: null,
            costPerUser: null,
            rowsTruncated: false,
            rows: [],
            warnings: [],
          });
    // The installed toolchain has evaluated every version already: its evaluation, 200.
    if (tail === 'evaluations' && request.method === 'POST') return ok(version.evaluations[0]);
    return ok(
      request.query.get('include') === 'document' ? version : { ...version, document: null }
    );
  };

  /** A member's answer to a read, as a public reader gets it. */
  const redacted = (
    reply: CompositionReply,
    section: string | undefined,
    ref: string | undefined,
    tail: string | undefined
  ): CompositionReply => {
    if (reply.status !== 200 || reply.json === undefined) return reply;
    if (!section) return ok({ ...(reply.json as CompositionView), created_by_id: null });
    if (section !== 'versions' || tail) return reply;
    if (ref) return ok(publicVersion(reply.json as CompositionVersionView, isPublic));
    const page = reply.json as { versions: CompositionVersionView[] };
    return ok({
      ...page,
      versions: page.versions.map(version => publicVersion(version, isPublic)),
    });
  };

  return {
    route: answer,

    publicRoute(request, org, signedIn, organizations = []) {
      const [, , , , slug, section, ref, tail] = request.parts;
      const refused = (): CompositionReply =>
        signedIn
          ? missing()
          : {
              status: 401,
              json: { detail: { code: 'not_authenticated', error: 'Authentication required.' } },
            };
      // The list: an organization that publishes answers its public compositions to anybody (G6); one that does not is missing.
      if (!slug) {
        const published = poolOf(org).filter(
          ({ view, versions }) =>
            view.visibility === 'public' && !view.archived && versions.length > 0
        );
        if (request.method === 'GET' && published.length) {
          const answer = list(request, published);
          const body = answer.json as { compositions: CompositionView[] };
          body.compositions = body.compositions.map(view => ({ ...view, created_by_id: null }));
          return answer;
        }
        return {
          status: 404,
          json: { detail: { code: 'not_found', error: 'Organization not found.' } },
        };
      }
      const entry = poolOf(org).find(item => item.view.slug === slug);
      if (!entry || entry.view.visibility !== 'public')
        return request.method === 'GET' ? missing() : refused();
      if (section === 'fork' && request.method === 'POST')
        return signedIn ? fork(entry, request, organizations, org) : refused();
      const reads =
        request.method === 'GET' &&
        (!section || ['versions', 'diff', 'graph', 'download', 'upstream'].includes(section));
      if (!reads) return refused();
      return redacted(answer(request, org, organizations), section, ref, tail);
    },

    publicList(request) {
      const { query } = request;
      const kinds = kindsOf(query);
      const owners = (query.get('owners') ?? '').split(',').filter(Boolean);
      const organization = query.get('organization');
      const needle = (query.get('q') ?? '').toLowerCase();
      const rows = allEntries()
        .filter(
          ({ view, versions }) =>
            view.visibility === 'public' && !view.archived && versions.length > 0
        )
        .filter(
          ({ view }) =>
            (!kinds.length || kinds.includes(view.kind)) &&
            (!organization || view.organization.slug === organization)
        )
        .filter(({ view }) => !needle || `${view.name} ${view.slug}`.toLowerCase().includes(needle))
        .sort(
          (a, b) =>
            b.view.updated_at.localeCompare(a.view.updated_at) ||
            a.view.slug.localeCompare(b.view.slug)
        )
        .map(({ view, versions }) => {
          const latest = versions[versions.length - 1];
          return {
            organization: { slug: view.organization.slug, name: view.organization.name },
            slug: view.slug,
            name: view.name,
            description: view.description,
            kind: view.kind,
            version_count: versions.length,
            updated_at: view.updated_at,
            latest_version: {
              label: latest.label,
              ordinal: latest.ordinal,
              values_status: latest.values_status,
              verified: latest.verified,
              created_at: latest.created_at,
              figures: figuresOf(versions),
            },
          };
        });
      const shown = rows.filter(row => !owners.length || owners.includes(row.organization.slug));
      const limit = Number(query.get('limit') ?? 24);
      const offset = Number(query.get('offset') ?? 0);
      return ok({
        compositions: shown.slice(offset, offset + limit),
        total: shown.length,
        limit,
        offset,
        facets: facetsOf(rows),
      });
    },

    mineList(request) {
      return list(request, allEntries());
    },

    permalink(request) {
      const [, , , id] = request.parts;
      const entry = allEntries().find(item => item.view.id === id);
      if (!entry) return missing();
      const version = request.query.get('version');
      const location = `/compositions/${entry.view.organization.slug}/${entry.view.slug}${version ? `?version=${encodeURIComponent(version)}` : ''}`;
      return ok({ location });
    },

    language(request) {
      const [, , operation] = request.parts;
      if (request.method === 'GET' && operation === 'schema') return ok(SCHEMA);
      if (request.method !== 'POST') return null;
      switch (operation) {
        case 'validate':
          return ok(lint(request.text()));
        case 'parse': {
          const linted = lint(request.text());
          return linted.valid
            ? ok({ document: documentOf(request.text()), diagnostics: [] })
            : refused(linted.diagnostics);
        }
        case 'serialise':
          return { status: 200, text: write(request.body()), type: 'application/yaml' };
        default:
          return null;
      }
    },
    operation,
  };
}
