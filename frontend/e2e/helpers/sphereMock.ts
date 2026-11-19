import { existsSync, readdirSync, readFileSync } from 'node:fs';

// The SPHERE side of the gallery's gateway (e2e/helpers/mockApi.ts): the problem `tomatometer-email` of `isa-demo`, whose version 2
// a SPHERE import generated, and (from the wizard on) the discovery, preview and apply routes. Every body is a gateway-produced
// fixture (src/test/fixtures/core and src/test/fixtures/sphere, written by openbinding-gateway/tools/dump_frontend_fixtures.py), so
// nothing here invents a SPHERE answer.

type Json = Record<string, unknown>;

interface SphereReply {
  status?: number;
  json?: unknown;
  text?: string;
  type?: string;
}

/** A gateway-produced fixture of src/test/fixtures/<area>, read as JSON. */
export const fixture = <T = Json>(area: 'core' | 'sphere', file: string): T =>
  JSON.parse(
    readFileSync(new URL(`../../src/test/fixtures/${area}/${file}`, import.meta.url), 'utf8')
  ) as T;

/** A fixture as text (a recorded pricing version's YAML). */
export const fixtureText = (area: 'core' | 'sphere', file: string): string =>
  readFileSync(new URL(`../../src/test/fixtures/${area}/${file}`, import.meta.url), 'utf8');

const ok = (json: unknown, status = 200): SphereReply => ({ status, json });
const notFound = (message: string): SphereReply => ({
  status: 404,
  json: { detail: { code: 'not_found', error: message } },
});

const APPLY = fixture<{
  problem: Json;
  revision: Json & { revision: number; package_digest: string };
}>('sphere', 'apply.tomatometer-email.json');
const FACTS = fixture<{
  candidates: Array<{ key: string; provenance: unknown }>;
  tasks: Array<{ id: string; kind: string; eligible: Array<{ candidate: string }> }>;
}>('core', 'tomatometer-email.facts.json');

export const TOMATOMETER_SLUG = 'tomatometer-email';

/** The problem as `isa-demo` lists it. */
export const TOMATOMETER_PROBLEM = {
  ...APPLY.problem,
  id: 'case-tomatometer-email',
  organization_id: 'org-isa-demo',
  name: 'TomatoMeter e-mail',
  description: 'The TomatoMeter services, with e-mail plans imported from SPHERE.',
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-02T00:00:00Z',
};

/** Version 2 is the import (origin `sphere`, with the pricings it read); version 1 the base bundle that was uploaded. */
export const TOMATOMETER_REVISIONS: Array<
  Json & { id: string; revision: number; package_digest: string; created_at: string }
> = [
  {
    ...APPLY.revision,
    id: 'rev-tomatometer-2',
    problem_id: TOMATOMETER_PROBLEM.id,
    created_at: '2026-10-02T00:00:00Z',
  },
  {
    ...APPLY.revision,
    id: 'rev-tomatometer-1',
    problem_id: TOMATOMETER_PROBLEM.id,
    revision: 1,
    origin: 'upload',
    sphere: null,
    provenance: null,
    package_digest: `sha256-${'7a'.repeat(32)}`,
    package_size: 6120,
    created_at: '2026-10-01T00:00:00Z',
  },
];

/** The facts of a version: version 2's are the gateway's; version 1 keeps only the hand-written candidates. */
export function tomatometerFacts(revision: number): Json {
  if (revision === 2) return structuredClone(FACTS) as unknown as Json;
  const handWritten = FACTS.candidates.filter(candidate => !candidate.provenance);
  const keys = new Set(handWritten.map(candidate => candidate.key));
  return {
    ...structuredClone(FACTS),
    binding_space: '1',
    candidates: handWritten,
    tasks: FACTS.tasks.map(task => ({
      ...task,
      eligible: task.eligible.filter(entry => keys.has(entry.candidate)),
    })),
  };
}

const latest = () => {
  const newest = TOMATOMETER_REVISIONS[0];
  return {
    id: newest.id,
    revision: newest.revision,
    package_digest: newest.package_digest,
    created_at: newest.created_at,
    origin: 'sphere' as const,
  };
};

/** The problem as a list row or the problem itself. */
export const tomatometerListed = () => ({
  ...TOMATOMETER_PROBLEM,
  latest_revision: latest(),
  revision_count: TOMATOMETER_REVISIONS.length,
});

/** `storage`, the problem J1 creates from Dropbox: answered once it exists (not listed, so the lists of the gallery stay as they are). */
const STORAGE_APPLY = fixture<{ problem: Json; revision: Json & { revision: number } }>(
  'sphere',
  'apply.storage.json'
);
const STORAGE_FACTS = fixture<{ facts: Json }>('sphere', 'expand.storage.json').facts;

interface SphereProblem {
  item: Json;
  revisions: Array<Json & { id: string; revision: number; package_digest: string }>;
  facts: (revision: number) => Json;
  listed: () => Json;
}

const SPHERE_PROBLEMS: Record<string, SphereProblem> = {
  [TOMATOMETER_SLUG]: {
    item: TOMATOMETER_PROBLEM,
    revisions: TOMATOMETER_REVISIONS,
    facts: tomatometerFacts,
    listed: tomatometerListed,
  },
  storage: {
    item: { ...STORAGE_APPLY.problem, organization_id: 'org-isa-demo' },
    revisions: [
      STORAGE_APPLY.revision as Json & { id: string; revision: number; package_digest: string },
    ],
    facts: () => structuredClone(STORAGE_FACTS),
    listed: () => ({ ...STORAGE_APPLY.problem, organization_id: 'org-isa-demo' }),
  },
};

const compilationOf = (slug: string, problem: SphereProblem, revision: number) => {
  const space = String(problem.facts(revision).binding_space ?? '1');
  return {
    id: `compilation-${slug}-${revision}`,
    revision_id: `rev-${slug}-${revision}`,
    compilation_digest: `sha256-${'91'.repeat(32)}`,
    compiler_digest: `sha256-${'82'.repeat(32)}`,
    ir_digest: `sha256-${'c3'.repeat(32)}`,
    binding_space: space,
    created_at: '2026-10-02T00:00:00Z',
    current: true,
    toolchain: {},
    analysis: { tasks: 4, candidates: 0, constraints: 0, placement: false, bindingSpace: space },
    resources: {},
    compatible_modes: [],
  };
};

// -- SPHERE through the gateway: every answer is a recorded or gateway-written fixture.

const SPHERE_DIR = new URL('../../src/test/fixtures/sphere/', import.meta.url);
const sphereFiles = readdirSync(SPHERE_DIR);
const byPricing = (prefix: string) =>
  Object.fromEntries(
    sphereFiles
      .filter(file => file.startsWith(prefix) && file.endsWith('.json'))
      .map(file => {
        const body = fixture<Json & { pricingId?: string; snapshot?: { versionId: string } }>(
          'sphere',
          file
        );
        return [prefix === 'version.' ? body.snapshot?.versionId : body.pricingId, body];
      })
  ) as Record<string, Json>;
const MANIFESTS = byPricing('manifest.');
const VERSIONS = byPricing('version.');

/** Every snapshot id a fixture names, with the recorded YAML of its version. */
const SNAPSHOT_YAML: Record<string, string> = (() => {
  const found: Record<string, string> = {};
  const visit = (value: unknown) => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== 'object') return;
    const node = value as Record<string, unknown>;
    if (
      typeof node.id === 'string' &&
      typeof node.pricingId === 'string' &&
      typeof node.versionId === 'string'
    ) {
      const file = `${node.pricingId}.${node.versionId}.yml`;
      if (existsSync(new URL(file, SPHERE_DIR))) found[node.id] = fixtureText('sphere', file);
    }
    Object.values(node).forEach(visit);
  };
  for (const file of sphereFiles.filter(
    name => name.endsWith('.json') && !name.includes('normalised')
  ))
    visit(fixture('sphere', file));
  visit(fixture('core', 'tomatometer-email.upstream.json'));
  return found;
})();

const searchFor = (q: string): Json => {
  const word = q.toLowerCase();
  if (word.includes('dropbox')) return fixture('sphere', 'search.dropbox.json');
  if (word.includes('tomato')) return fixture('sphere', 'search.tomatometer.json');
  return fixture('sphere', 'search.mailgun.json');
};

const sphereNotFound: SphereReply = {
  status: 404,
  json: {
    detail: {
      code: 'sphere_pricing_not_found',
      error: 'No such SPHERE pricing in this organization.',
    },
  },
};

/** `GET …/pricing-snapshots/{snapshot}[/yaml]` under any organization: a stored snapshot's metadata or bytes. */
export function snapshotRoutes(parts: string[]): SphereReply | null {
  const [, , , section, snapshot, tail] = parts;
  if (section !== 'pricing-snapshots' || !snapshot) return null;
  const yaml = SNAPSHOT_YAML[snapshot];
  if (!yaml)
    return {
      status: 404,
      json: { detail: { code: 'pricing_snapshot_not_found', error: 'No such pricing snapshot.' } },
    };
  if (tail === 'yaml') return { status: 200, text: yaml, type: 'application/yaml' };
  return ok({ id: snapshot });
}

/** `/v1/organizations/{org}/sphere/pricings[/{pricingId}[/versions/{versionId}]]`. */
export function sphereRoutes(parts: string[], query: URLSearchParams): SphereReply | null {
  const [, , , section, kind, pricingId, versions, versionId] = parts;
  if (section !== 'sphere' || kind !== 'pricings') return null;
  if (!pricingId) return ok(searchFor(query.get('q') ?? ''));
  if (!versions) return MANIFESTS[pricingId] ? ok(MANIFESTS[pricingId]) : sphereNotFound;
  const view = versionId ? VERSIONS[versionId] : undefined;
  return view ? ok(view) : sphereNotFound;
}

/**
 * `/v1/organizations/isa-demo/problems/{tomatometer-email|storage}/…`: the problem, its versions, their compilations and facts,
 * and its SPHERE routes (`sphere/expand`, `sphere/apply`, `sphere/recipe`). `parts` is the path split at the slashes; null when
 * the path is none of these.
 */
export function sphereProblemRoutes(method: string, parts: string[]): SphereReply | null {
  const [, , , , problemSlug, sub, revisionRef, tail, compilationId, last] = parts;
  if (sub === 'sphere') {
    const action = revisionRef;
    const known = problemSlug === TOMATOMETER_SLUG;
    if (action === 'expand' && method === 'POST')
      return ok(fixture('sphere', known ? 'expand.tomatometer-email.json' : 'expand.storage.json'));
    if (action === 'apply' && method === 'POST')
      // The gateway's apply answered revision 2 that the TomatoMeter template had made already (`created: false`); the
      // walk is the first import of that recipe, so the gallery answers it as made now.
      return ok(
        known
          ? { ...fixture<Json>('sphere', 'apply.tomatometer-email.json'), created: true }
          : fixture('sphere', 'apply.storage.json'),
        known ? 200 : 201
      );
    if (action === 'recipe')
      return known
        ? ok(fixture('sphere', 'recipe.tomatometer-email.json'))
        : {
            status: 404,
            json: { detail: { code: 'sphere_recipe_not_found', error: 'No SPHERE recipe.' } },
          };
    return null;
  }
  const problem = problemSlug ? SPHERE_PROBLEMS[problemSlug] : undefined;
  if (!problem) return null;
  if (!sub) return ok(problem.listed());
  if (sub !== 'revisions') return null;
  if (!revisionRef) return method === 'GET' ? ok(problem.revisions) : null;
  const revision = problem.revisions.find(
    item =>
      String(item.revision) === revisionRef ||
      item.id === revisionRef ||
      item.package_digest === revisionRef
  );
  if (!revision) return notFound('Problem revision not found.');
  if (!tail)
    return ok({
      ...revision,
      document: { apiVersion: 'bim/v1', kind: 'Instance', metadata: { name: problemSlug } },
      compilations: [],
      files: [],
      resource_digests: {},
    });
  if (tail === 'compilation') return ok(compilationOf(problemSlug!, problem, revision.revision));
  if (tail === 'compilations' && compilationId && last === 'facts')
    return ok(problem.facts(revision.revision));
  return notFound('Not mocked.');
}

// -- A composition version's upstream view (`GET …/compositions/{c}/upstream`), from the gateway's fixtures.

type SnapshotView = Json & { id: string; versionId: string; title: string };

/** Every stored snapshot a fixture names, by SPHERE version id: what an upstream view names for a `from` that pins it. */
const SNAPSHOTS_BY_VERSION: Record<string, SnapshotView> = (() => {
  const found: Record<string, SnapshotView> = {};
  const keep = (snapshot: Record<string, unknown>) => {
    if (typeof snapshot.versionId !== 'string' || typeof snapshot.id !== 'string') return;
    found[snapshot.versionId] ??= {
      createdAt: snapshot.createdAt ?? null,
      id: snapshot.id,
      owner: snapshot.owner ?? null,
      permanentUrl: snapshot.permanentUrl ?? null,
      pricingId: snapshot.pricingId ?? null,
      registry: snapshot.registry ?? null,
      slug: snapshot.slug ?? null,
      title: String(snapshot.title ?? ''),
      url: null,
      versionId: snapshot.versionId,
      versionName: snapshot.versionName ?? null,
    } as SnapshotView;
  };
  const upstream = fixture<{ entries: Array<{ snapshot: Record<string, unknown> | null }> }>(
    'core',
    'tomatometer-email.upstream.json'
  );
  for (const entry of upstream.entries) if (entry.snapshot) keep(entry.snapshot);
  for (const file of ['expand.tomatometer-email.json', 'expand.storage.json'])
    for (const snapshot of fixture<{ snapshots: Array<Record<string, unknown>> }>('sphere', file)
      .snapshots)
      keep(snapshot);
  return found;
})();

/** The YAML of a stored snapshot, when the fixtures hold that version (for a mock that wants to read it). */
export const snapshotYamlOf = (id: string): string | undefined => SNAPSHOT_YAML[id];

const UPSTREAM = fixture<Json & { offering: Json | null; values: Json }>(
  'core',
  'tomatometer-email.upstream.json'
);

/**
 * The upstream view of a version from its document: each binding entry with the stored snapshot its `from` pins (when a fixture
 * holds that version), the offering as the evaluation read it (TomatoMeter's offering from the gateway's fixture; a `url`
 * offering recorded unreadable, as the lab seed's is) and, for TomatoMeter, the source kinds of its global values.
 */
export function upstreamOf(version: {
  label: string;
  offering?: unknown;
  document?: unknown;
}): Json {
  const document = (version.document ?? {}) as {
    binding?: Record<string, Record<string, unknown>>;
  };
  const binding = document.binding ?? {};
  const entries = Object.entries(binding).map(([task, entry]) => {
    const from = (entry.from as Record<string, unknown> | undefined) ?? null;
    const snapshot =
      from && typeof from.version === 'string' ? SNAPSHOTS_BY_VERSION[from.version] : undefined;
    return {
      task,
      candidate: String(entry.candidate ?? ''),
      from,
      status: snapshot ? 'snapshotted' : 'not_snapshotted',
      snapshot: snapshot ?? null,
      plan: null,
    };
  });
  const offering = version.offering as Record<string, string> | null | undefined;
  const tomatometer = offering?.sphere === 'sphere/tomatometer';
  return {
    version: version.label,
    entries,
    values: tomatometer ? UPSTREAM.values : {},
    offering: !offering
      ? null
      : tomatometer
        ? UPSTREAM.offering
        : {
            source: offering,
            status: 'unreadable',
            snapshot: null,
            versionName: null,
            createdAt: '2026-10-05T08:15:00Z',
          },
  };
}
