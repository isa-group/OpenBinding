import { readFileSync } from 'node:fs';

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

const APPLY = fixture<{ problem: Json; revision: Json & { revision: number } }>(
  'sphere',
  'apply.tomatometer-email.json'
);
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
export const TOMATOMETER_REVISIONS = [
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

const compilation = (revision: number) => ({
  id: `compilation-tomatometer-${revision}`,
  revision_id: `rev-tomatometer-${revision}`,
  compilation_digest: `sha256-${'91'.repeat(32)}`,
  compiler_digest: `sha256-${'82'.repeat(32)}`,
  ir_digest: `sha256-${'c3'.repeat(32)}`,
  binding_space: String(tomatometerFacts(revision).binding_space),
  created_at: '2026-10-02T00:00:00Z',
  current: true,
  toolchain: {},
  analysis: {
    tasks: 4,
    candidates: revision === 2 ? 21 : 4,
    constraints: 0,
    placement: false,
    bindingSpace: String(tomatometerFacts(revision).binding_space),
  },
  resources: {},
  compatible_modes: [],
});

/**
 * `/v1/organizations/isa-demo/problems/tomatometer-email/…`: the problem, its two versions, their compilations and facts. `parts` is
 * the path split at the slashes; null when the path is not this problem's.
 */
export function tomatometerRoutes(method: string, parts: string[]): SphereReply | null {
  const [, , , , problemSlug, sub, revisionRef, tail, compilationId, last] = parts;
  if (problemSlug !== TOMATOMETER_SLUG) return null;
  if (!sub) return ok(tomatometerListed());
  if (sub !== 'revisions') return null;
  if (!revisionRef) return method === 'GET' ? ok(TOMATOMETER_REVISIONS) : null;
  const revision = TOMATOMETER_REVISIONS.find(
    item =>
      String(item.revision) === revisionRef ||
      item.id === revisionRef ||
      item.package_digest === revisionRef
  );
  if (!revision) return notFound('Problem revision not found.');
  if (!tail)
    return ok({
      ...revision,
      document: { apiVersion: 'bim/v1', kind: 'Instance', metadata: { name: 'tomatometer' } },
      compilations: [],
      files: [],
      resource_digests: {},
    });
  if (tail === 'compilation') return ok(compilation(revision.revision));
  if (tail === 'compilations' && compilationId && last === 'facts')
    return ok(tomatometerFacts(revision.revision));
  return notFound('Not mocked.');
}
