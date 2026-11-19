import { readFileSync } from 'node:fs';
import type {
  CompositionAdoptionView,
  CompositionEnvironmentView,
  CompositionMargins,
  CompositionVersionView,
  EnvironmentCheck,
  EnvironmentKeyView,
  FeedKeyCreated,
} from '../../src/modules/core/api/types';
import type { CompositionReply, CompositionRequest } from './mockCompositions';

// The operation of TomatoMeter in the shared mock (e2e/helpers/mockCompositions.ts registers it behind `{ tomatometer: true }`):
// its environments, adoptions, feed keys, check and margins, answered from the gateway's own F4 fixtures
// (src/test/fixtures/core/tomatometer.*.json, written by tools/dump_frontend_fixtures.py) under the mock's version ids and the
// organization `isa-demo`. What a page writes is kept for the page: an environment created, edited or deleted, an adoption
// (which needs the environment's ETag as `If-Match`: 428 without one, 412 with an old one), a key minted (its secret is the
// fixture's test secret) or revoked. `check` answers the recorded manifests (every source current) until a spec asks for the
// scripted newer answer (`operation.check = 'newer'`). Margins are the fixture of the version's label, with the users asked.

const core = <T>(file: string): T =>
  JSON.parse(
    readFileSync(new URL(`../../src/test/fixtures/core/${file}`, import.meta.url), 'utf8')
  ) as T;
const coreText = (file: string): string =>
  readFileSync(new URL(`../../src/test/fixtures/core/${file}`, import.meta.url), 'utf8');

/** The time the mock stamps on what a page writes: the page's fixed clock (e2e/helpers/mockApi.ts `NOW`). */
const STAMP = '2026-10-09T11:00:00Z';
const FIXTURE_ORG = '/organizations/fixtures/';

const ok = (json: unknown, status = 200, headers?: Record<string, string>): CompositionReply => ({
  status,
  json,
  headers,
});
const refuse = (status: number, code: string, error: string, headers?: Record<string, string>) =>
  ok({ detail: { code, error } }, status, headers);

export interface OperationStore {
  /** Answers `…/compositions/tomatometer/environments…`. */
  route: (
    request: CompositionRequest,
    versions: readonly CompositionVersionView[]
  ) => CompositionReply;
  /** Answers `…/versions/{version}/margins` for one of TomatoMeter's versions. */
  margins: (request: CompositionRequest, version: CompositionVersionView) => CompositionReply;
  /** Which answer `check` gives. */
  check: 'current' | 'newer';
  /** Every adoption a page made, in order (environment slug, version label, `If-Match` sent). */
  adopted: Array<{ environment: string; version: string; ifMatch: string | undefined }>;
}

interface Held {
  view: CompositionEnvironmentView;
  revision: number;
  adoptions: CompositionAdoptionView[];
}

/** The fixture's view, under the organization `org` and the mock's version ids (matched by label). */
function adapt<T>(value: T, org: string, versions: readonly CompositionVersionView[]): T {
  const text = JSON.stringify(value).replaceAll(FIXTURE_ORG, `/organizations/${org}/`);
  const parsed = JSON.parse(text) as T;
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) node.forEach(visit);
    else if (node && typeof node === 'object') {
      const record = node as Record<string, unknown>;
      if (typeof record.label === 'string' && typeof record.id === 'string') {
        const match = versions.find(version => version.label === record.label);
        if (match) record.id = match.id;
      }
      Object.values(record).forEach(visit);
    }
  };
  visit(parsed);
  return parsed;
}

export function operationStore(org: string, composition: string): OperationStore {
  let held: Held[] | null = null;
  let minted = 0;
  const store: OperationStore = { route, margins, check: 'current', adopted: [] };
  const etagOf = (item: Held) => `"env-${item.view.slug}-${item.revision}"`;

  function state(versions: readonly CompositionVersionView[]): Held[] {
    if (held) return held;
    const list = adapt(
      core<{ environments: CompositionEnvironmentView[] }>('tomatometer.environments.json'),
      org,
      versions
    ).environments;
    const history = adapt(
      core<{ adoptions: CompositionAdoptionView[] }>('tomatometer.adoptions.production.json'),
      org,
      versions
    ).adoptions;
    held = list.map(view => ({
      view,
      revision: 1,
      adoptions: view.slug === 'production' ? history : [],
    }));
    return held;
  }

  function route(
    request: CompositionRequest,
    versions: readonly CompositionVersionView[]
  ): CompositionReply {
    const all = state(versions);
    const [, , , , , , slug, section, key] = request.parts;
    const ifMatch = request.header?.('if-match');
    if (!slug) {
      if (request.method === 'GET') return ok({ environments: all.map(item => item.view) });
      if (request.method === 'POST') return create(request, all);
    }
    const item = all.find(entry => entry.view.slug === slug);
    if (!item) return refuse(404, 'not_found', 'Environment not found.');
    const etag = etagOf(item);
    const changed = () => {
      item.revision += 1;
      item.view = { ...item.view, updatedAt: STAMP };
    };
    if (!section) {
      if (request.method === 'GET') return ok(item.view, 200, { ETag: etag });
      if (ifMatch && ifMatch !== etag)
        return refuse(412, 'precondition_failed', 'The environment changed.', { ETag: etag });
      if (request.method === 'DELETE') {
        all.splice(all.indexOf(item), 1);
        return { status: 204 };
      }
      if (request.method === 'PATCH') {
        const body = request.body();
        const operator = body.operator as string | null | undefined;
        item.view = {
          ...item.view,
          ...(typeof body.name === 'string' ? { name: body.name } : {}),
          ...(typeof body.description === 'string' ? { description: body.description } : {}),
          ...(body.adoptRole === 'MEMBER' || body.adoptRole === 'ADMIN'
            ? { adoptRole: body.adoptRole }
            : {}),
          ...('expectedUsers' in body
            ? { expectedUsers: (body.expectedUsers as number | null) ?? null }
            : {}),
          ...(operator !== undefined
            ? {
                operator: operator
                  ? { username: operator, displayName: operator, member: true }
                  : null,
              }
            : {}),
        };
        changed();
        return ok(item.view, 200, { ETag: etagOf(item) });
      }
    }
    if (section === 'adopt' && request.method === 'POST') {
      store.adopted.push({
        environment: item.view.slug,
        version: String(request.body().version ?? ''),
        ifMatch,
      });
      if (!ifMatch || ifMatch === '*')
        return refuse(428, 'precondition_required', 'Send the environment’s ETag as If-Match.');
      if (ifMatch !== etag)
        return refuse(412, 'precondition_failed', 'The environment changed since you read it.', {
          ETag: etag,
        });
      const asked = String(request.body().version ?? '');
      const version = versions.find(
        candidate =>
          candidate.id === asked || candidate.label === asked || String(candidate.ordinal) === asked
      );
      if (!version) return refuse(404, 'version_not_found', 'Composition version not found.');
      const previous = item.view.inEffect;
      if (previous?.version.id === version.id)
        return refuse(
          409,
          'already_in_effect',
          `Version ${version.label} is already in effect here.`
        );
      const ordinal = (previous?.adoption ?? 0) + 1;
      const document = (version.document ?? {}) as {
        binding?: Record<string, { candidate?: string }>;
      };
      const binding = Object.fromEntries(
        Object.entries(document.binding ?? {}).flatMap(([task, bound]) =>
          bound?.candidate ? [[task, { candidate: bound.candidate }]] : []
        )
      );
      const evaluation = {
        id: version.current_evaluation_id ?? `evaluation-${version.id}`,
        basisKey: previous?.evaluation?.basisKey ?? 'sha256-mock',
        valuesStatus: version.values_status ?? 'verified',
      };
      const adoption: CompositionAdoptionView = {
        ordinal,
        version: { id: version.id, label: version.label },
        previousVersion: previous ? { ...previous.version } : null,
        adoptedAt: STAMP,
        adoptedBy: { username: 'alex.rivera', displayName: 'Alex Rivera' },
        note: String(request.body().note ?? ''),
        evaluation,
        offering: previous?.offering
          ? { versionName: previous.offering.versionName, createdAt: previous.offering.createdAt }
          : null,
        feedEtag: `"${version.content_digest}"`,
      };
      item.adoptions = [adoption, ...item.adoptions];
      item.view = {
        ...item.view,
        inEffect: {
          adoption: ordinal,
          version: { id: version.id, label: version.label, ordinal: version.ordinal },
          adoptedAt: STAMP,
          adoptedBy: adoption.adoptedBy,
          note: adoption.note,
          evaluation: { ...evaluation, outcome: 'verified' },
          offering: previous?.offering ?? null,
          binding,
        },
        feed: { ...item.view.feed, etag: adoption.feedEtag },
      };
      changed();
      return ok({ environment: item.view, adoption }, 200, { ETag: etagOf(item) });
    }
    if (section === 'adoptions' && request.method === 'GET')
      return ok({ adoptions: item.adoptions, nextBefore: null });
    if (section === 'check' && request.method === 'POST') {
      if (!item.view.inEffect)
        return refuse(409, 'nothing_adopted', 'Nothing is adopted in this environment yet.');
      return ok(
        adapt(
          core<EnvironmentCheck>(
            store.check === 'newer'
              ? 'tomatometer.check.production.newer.json'
              : 'tomatometer.check.production.json'
          ),
          org,
          versions
        )
      );
    }
    if (section === 'composition' && request.method === 'GET') {
      if (!item.view.inEffect)
        return refuse(404, 'nothing_adopted', 'Nothing is adopted in this environment yet.');
      return {
        status: 200,
        text: coreText('tomatometer.feed.production.yaml'),
        type: 'application/yaml',
        headers: { ETag: item.view.feed.etag ?? '' },
      };
    }
    if (section === 'keys') {
      const keys = item.view.keys ?? [];
      if (!key && request.method === 'POST') {
        if (keys.filter(entry => !entry.revokedAt).length >= 2)
          return refuse(
            409,
            'feed_key_limit',
            'This environment has two live keys: revoke one first.'
          );
        const created = core<FeedKeyCreated>('tomatometer.key.created.json');
        minted += 1;
        const view: EnvironmentKeyView = {
          ...created.key,
          id: `00000000-0000-4000-8000-0000000009${String(minted).padStart(2, '0')}`,
          label: String(request.body().label ?? ''),
          createdAt: STAMP,
          createdBy: 'alex.rivera',
        };
        item.view = { ...item.view, keys: [view, ...keys], keyCount: item.view.keyCount + 1 };
        return {
          ...ok({ key: view, secret: created.secret }, 201),
          headers: { 'Cache-Control': 'no-store' },
        };
      }
      const found = keys.find(entry => entry.id === key && !entry.revokedAt);
      if (key && request.method === 'DELETE') {
        if (!found) return refuse(404, 'not_found', 'Feed key not found.');
        item.view = {
          ...item.view,
          keys: keys.map(entry => (entry === found ? { ...entry, revokedAt: STAMP } : entry)),
          keyCount: item.view.keyCount - 1,
        };
        return { status: 204 };
      }
    }
    return refuse(404, 'not_found', 'Not mocked.');
  }

  function create(request: CompositionRequest, all: Held[]): CompositionReply {
    const body = request.body();
    const slug = String(body.slug ?? '');
    if (all.some(item => item.view.slug === slug))
      return refuse(409, 'slug_conflict', 'That slug is in use in this composition.');
    const operator = (body.operator as string | null | undefined) ?? null;
    const view: CompositionEnvironmentView = {
      id: `00000000-0000-4000-8000-0000000008${String(all.length).padStart(2, '0')}`,
      slug,
      name: String(body.name ?? slug),
      description: String(body.description ?? ''),
      operator: operator ? { username: operator, displayName: operator, member: true } : null,
      adoptRole: body.adoptRole === 'MEMBER' ? 'MEMBER' : 'ADMIN',
      expectedUsers: (body.expectedUsers as number | null | undefined) ?? null,
      inEffect: null,
      feed: {
        path: `/v1/organizations/${org}/compositions/${composition}/environments/${slug}/composition`,
        etag: null,
      },
      keys: [],
      keyCount: 0,
      createdAt: STAMP,
      updatedAt: STAMP,
    };
    const item: Held = { view, revision: 1, adoptions: [] };
    all.push(item);
    return ok(view, 201, { ETag: etagOf(item) });
  }

  function margins(request: CompositionRequest, version: CompositionVersionView): CompositionReply {
    const file =
      version.label === '1.1.0'
        ? 'tomatometer.margins.1.1.0.json'
        : 'tomatometer.margins.1.0.0.json';
    const answer = core<CompositionMargins>(file);
    const users = request.query.get('users');
    const base = { ...answer, version: { id: version.id, label: version.label } };
    if (!users)
      return ok({
        ...base,
        users: null,
        costPerUser: null,
        status: 'users_required',
        rows: base.rows.map(row => ({ ...row, cost: null, margin: null })),
      });
    return ok({ ...base, users: Number(users) });
  }

  return store;
}
