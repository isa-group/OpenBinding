import { readFileSync } from 'node:fs';
import type {
  CompositionAdoptionView,
  CompositionEnvironmentView,
  CompositionMargins,
  CompositionVersionView,
  EnvironmentCheck,
  EnvironmentKeyView,
  EvaluateResult,
  FeedKeyCreated,
  EnvironmentUpstreamSummary,
  MyUpstreamEvent,
  ProposalStepView,
  ProposalView,
  UpstreamEventDetail,
  UpstreamEventList,
  UpstreamSummary,
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
  /**
   * Answers `…/evaluate` with users or a revision (the calculator's demand, J6): the gateway's what-if fixtures, under the
   * revision asked; null when the request asks neither, so the shared mock answers it.
   */
  evaluate: (
    request: CompositionRequest,
    version: CompositionVersionView
  ) => CompositionReply | null;
  /** The bodies of every evaluation with a demand, in order. */
  evaluated: Array<Record<string, unknown>>;
  /** Every adoption a page made, in order (environment slug, version label, `If-Match` sent). */
  adopted: Array<{ environment: string; version: string; ifMatch: string | undefined }>;
  /** The proposals of TomatoMeter: the ones a spec seeded and the ones a page made, newest first. */
  proposals: ProposalView[];
  /** Every proposal a page confirmed, in order (its id and the phrase sent). */
  confirmed: Array<{ id: string; confirmation: string | undefined }>;
  /**
   * Answers `…/compositions/tomatometer/proposals` (create, list). `seal` derives and seals a version from a proposal's
   * source as the shared mock's derive does, and `preview` the same without sealing (its document's text).
   */
  proposalsRoute: (
    request: CompositionRequest,
    versions: readonly CompositionVersionView[],
    derive: Derive
  ) => CompositionReply;
  /** Answers `/v1/organizations/{org}/proposals/{proposal}[/confirm]` (read, confirm, cancel). */
  proposalRoute: (
    request: CompositionRequest,
    versions: readonly CompositionVersionView[],
    derive: Derive
  ) => CompositionReply;
  /** `GET /v1/users/me/upstream-events`: TomatoMeter's open events when a spec seeded them (e2e/f6-*.spec.ts), else none. */
  mineEvents: () => unknown[];
  /** TomatoMeter's upstream events (F6), when the page seeded them (`{ upstream: true }`); null otherwise. */
  upstream: UpstreamStore | null;
  /**
   * Seeds a proposal (a B5 fixture, `src/test/fixtures/core/zproposals.*.json`), its steps' environment bases set to the
   * environments as they are now, so it is not stale until something moves them.
   */
  seedProposal: (proposal: ProposalView) => void;
  /** Something else adopted or edited an environment: its ETag moves (a proposal built on it goes stale). */
  touch: (environment: string) => void;
}

/** The fixture events a spec may publish into the store (`src/test/fixtures/core/upstream.tomatometer.event.<name>.json`). */
export type UpstreamFixture =
  'values-changed' | 'binding-invalid' | 'offering-changed' | 'unavailable' | 'withdrawn';

/** TomatoMeter's upstream events in the shared mock: the gateway's F6 fixtures under the mock's ids, and what a page does. */
export interface UpstreamStore {
  /** Answers `…/compositions/tomatometer/upstream-events…` (list, read, review). */
  route: (
    request: CompositionRequest,
    versions: readonly CompositionVersionView[]
  ) => CompositionReply;
  /** A newer upstream version arrives: the fixture event is added (a binding-invalid one supersedes the values-changed one). */
  publish: (fixture: UpstreamFixture) => void;
  /** The composition's counts, as `CompositionView.upstream` carries them. */
  counts: () => UpstreamSummary;
  /** A version's counts (`CompositionVersionView.upstream`). */
  versionCounts: (version: string) => UpstreamSummary;
  /** An environment's counts, by the version in effect there. */
  environmentCounts: (inEffect: string | null) => EnvironmentUpstreamSummary;
  /** The open events as `GET /v1/users/me/upstream-events` lists them. */
  mine: () => MyUpstreamEvent[];
  /** The bytes of a snapshot an event names, when the fixtures hold them. */
  snapshot: (id: string) => string | null;
  /** Every review a page sent (event id, note, `If-Match`). */
  reviewed: Array<{ id: string; note: string; ifMatch: string | undefined }>;
}

/** What a proposal's seal step asks the shared mock: a preview (the document's text) or the sealed version. */
export interface Derive {
  preview: (label: string, source: Record<string, unknown>) => string;
  seal: (
    label: string,
    source: Record<string, unknown>
  ) => CompositionVersionView | CompositionReply;
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

const WORST = ['binding_invalid', 'values_changed', 'offering_changed'] as const;

/** The id of the gallery's no-impact event (not a gateway fixture: the store derives it). */
export const NO_IMPACT_EVENT = '00000000-0000-4000-8000-0000000004e0';

/** Counts of events, each (version, pricing, subject) once: open and reviewed, binding invalid, the worst category. */
function summarise(events: readonly UpstreamEventDetail[]): UpstreamSummary {
  const counted = events.filter(
    event =>
      event.notify &&
      !event.supersededBy &&
      (event.state === 'open' || (event.state === 'reviewed' && event.subject === 'binding'))
  );
  const open = counted.filter(event => event.state === 'open').length;
  const reviewed = counted.filter(event => event.state === 'reviewed').length;
  const bindingInvalid = counted.filter(event => event.category === 'binding_invalid').length;
  const worst = WORST.find(category => counted.some(event => event.category === category)) ?? null;
  return { open, reviewed, bindingInvalid, worst };
}

function upstreamStore(
  org: string,
  composition: string,
  versionsNow: () => readonly CompositionVersionView[]
): UpstreamStore {
  const read = (fixture: UpstreamFixture) =>
    adapt(
      core<UpstreamEventDetail>(`upstream.tomatometer.event.${fixture}.json`),
      org,
      versionsNow()
    );
  const events: UpstreamEventDetail[] = [read('values-changed'), read('offering-changed')];
  /** A no-impact event (the gallery's, F6): the values-changed fixture as if Brevo had changed another plan only. */
  const noImpact = (): UpstreamEventDetail => {
    const base = read('values-changed');
    const diff = base.diff as {
      entries?: Array<{ attributes?: Array<{ after: unknown; before: unknown; delta: unknown }> }>;
    };
    return {
      ...base,
      id: NO_IMPACT_EVENT,
      category: 'no_impact',
      notify: false,
      diff: {
        ...base.diff,
        global: [],
        notes: ['values_not_reevaluated'],
        entries: (diff.entries ?? []).map(entry => ({
          ...entry,
          attributes: (entry.attributes ?? []).map(attribute => ({
            ...attribute,
            after: attribute.before,
            delta: null,
          })),
        })),
      },
    };
  };
  const known = (id: string) =>
    events.find(event => event.id === id) ??
    [...(['unavailable', 'withdrawn', 'binding-invalid'] as const).map(read), noImpact()].find(
      event => event.id === id
    ) ??
    null;
  const etagOf = (event: UpstreamEventDetail) => `"event-${event.id}-${event.state}"`;
  const snapshots: Record<string, string> = {
    '00000000-0000-4000-8000-000000000026': coreText('upstream.brevo.2026-10.yaml'),
    '00000000-0000-4000-8000-000000000048': coreText('upstream.brevo.2026-11.yaml'),
  };
  const listed = (event: UpstreamEventDetail) => {
    const { diff: _diff, ...row } = event;
    void _diff;
    return row;
  };
  const upstream: UpstreamStore = {
    reviewed: [],
    publish(fixture) {
      const event = read(fixture);
      if (events.some(item => item.id === event.id)) return;
      if (fixture === 'binding-invalid')
        for (const older of events)
          if (older.category === 'values_changed' && older.subject === 'binding')
            older.supersededBy = event.id;
      events.unshift(event);
    },
    counts: () => summarise(events),
    versionCounts: version => summarise(events.filter(event => event.version.id === version)),
    environmentCounts: inEffect => ({
      ...summarise(
        events.filter(
          event =>
            inEffect !== null &&
            (event.version.id === inEffect ||
              (event.subject === 'offering' && event.state === 'open'))
        )
      ),
      resolvedBy: null,
    }),
    mine: () =>
      events
        .filter(event => event.notify && event.state === 'open')
        .map(event => ({
          ...listed(event),
          organization: { id: `org-${org}`, slug: org, name: 'ISA Demo Group' },
          composition: { id: `composition-${composition}`, slug: composition, name: 'TomatoMeter' },
        })) as unknown as MyUpstreamEvent[],
    snapshot: id => snapshots[id] ?? null,
    route(request) {
      const [, , , , , , id, action] = request.parts;
      if (!id && request.method === 'GET') {
        const state = request.query.get('state');
        const version = request.query.get('version');
        const shown = [...events]
          .sort((a, b) => b.detectedAt.localeCompare(a.detectedAt))
          .filter(
            event => (!state || event.state === state) && (!version || event.version.id === version)
          );
        const list: UpstreamEventList = {
          events: shown.map(listed) as UpstreamEventList['events'],
          counts: {
            open: events.filter(event => event.state === 'open' && event.category !== 'no_impact')
              .length,
            reviewed: events.filter(event => event.state === 'reviewed').length,
            resolved: events.filter(event => event.state === 'resolved').length,
            noImpact: events.filter(event => event.category === 'no_impact').length,
          },
          watches: core<UpstreamEventList>('upstream.tomatometer.events.json').watches,
          nextBefore: null,
        };
        return ok(list);
      }
      const event = id ? known(id) : null;
      if (!event) return refuse(404, 'not_found', 'Upstream event not found.');
      if (!action && request.method === 'GET') return ok(event, 200, { ETag: etagOf(event) });
      if (action === 'review' && request.method === 'POST') {
        const ifMatch = request.header?.('if-match');
        const note = String(request.body().note ?? '');
        upstream.reviewed.push({ id: event.id, note, ifMatch });
        if (ifMatch && ifMatch !== etagOf(event))
          return refuse(412, 'precondition_failed', 'The event changed since it was read.', {
            ETag: etagOf(event),
          });
        if (event.state !== 'open')
          return refuse(409, 'event_not_reviewable', 'The event was already reviewed or resolved.');
        event.state = 'reviewed';
        event.note = note;
        event.reviewedBy = { username: 'alex.rivera' };
        event.reviewedAt = STAMP;
        return ok(event, 200, { ETag: etagOf(event) });
      }
      return refuse(405, 'method_not_allowed', 'Not allowed.');
    },
  };
  return upstream;
}

export function operationStore(
  org: string,
  composition: string,
  options: { upstream?: boolean; versions?: readonly CompositionVersionView[] } = {}
): OperationStore {
  let held: Held[] | null = null;
  let minted = 0;
  const store: OperationStore = {
    route,
    margins,
    evaluate,
    check: 'current',
    adopted: [],
    evaluated: [],
    proposals: [],
    confirmed: [],
    proposalsRoute,
    proposalRoute,
    mineEvents: () => store.upstream?.mine() ?? [],
    upstream: null,
    seedProposal(proposal) {
      const all = state(seenVersions);
      const seeded = adapt(proposal, org, seenVersions);
      for (const step of seeded.steps) {
        const environment = all.find(item => item.view.id === step.params.environment);
        if (step.kind === 'adopt' && environment)
          step.base = {
            ...step.base,
            environmentEtag: etagOf(environment),
            inEffect: environment.view.inEffect?.version.id ?? null,
          };
        if (step.kind === 'seal_derived')
          step.base = { ...step.base, headVersionId: seenVersions.at(-1)?.id ?? null };
      }
      store.proposals = [seeded, ...store.proposals];
    },
    touch(slug) {
      const item = state(seenVersions).find(entry => entry.view.slug === slug);
      if (item) item.revision += 1;
    },
  };
  let seenVersions: readonly CompositionVersionView[] = options.versions ?? [];
  if (options.upstream) store.upstream = upstreamStore(org, composition, () => seenVersions);
  let made = 0;
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
    seenVersions = versions;
    const all = state(versions);
    // The upstream badge of each environment (F6): its counts by the version in effect there.
    if (store.upstream)
      for (const item of all)
        item.view = {
          ...item.view,
          upstream: store.upstream.environmentCounts(item.view.inEffect?.version.id ?? null),
        };
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
        source: 'direct',
        proposal: null,
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

  function evaluate(
    request: CompositionRequest,
    version: CompositionVersionView
  ): CompositionReply | null {
    const body = request.body();
    if (body.users === undefined && body.revision === undefined) return null;
    store.evaluated.push(body);
    const revision = typeof body.revision === 'number' ? body.revision : null;
    const answer = core<EvaluateResult>(
      revision !== null ? 'tomatometer.evaluate.revision.json' : 'tomatometer.evaluate.users.json'
    );
    const users = typeof body.users === 'number' ? body.users : null;
    return ok({
      ...answer,
      version: { id: version.id, label: version.label },
      revision: answer.revision && {
        ...answer.revision,
        number: revision ?? version.problem?.revision.revision ?? answer.revision.number,
      },
      margins: users === null ? null : answer.margins && { ...answer.margins, users },
    });
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

  /** A step as the gateway shows it before it runs. */
  const pendingStep = (
    step: Partial<ProposalStepView> & Pick<ProposalStepView, 'ordinal' | 'kind' | 'description'>
  ): ProposalStepView => ({
    base: {},
    deferred: [],
    dependsOn: [],
    destructive: false,
    error: null,
    finishedAt: null,
    params: {},
    preview: null,
    result: null,
    status: 'pending',
    ...step,
  });

  function proposalsRoute(
    request: CompositionRequest,
    versions: readonly CompositionVersionView[],
    derive: Derive
  ): CompositionReply {
    if (request.method === 'GET') {
      const status = request.query.get('status');
      return ok({
        proposals: store.proposals
          .filter(item => !status || item.status === status)
          .map(item => ({ ...item, steps: item.steps.map(step => ({ ...step, preview: null })) })),
      });
    }
    if (request.method !== 'POST') return refuse(405, 'method_not_allowed', 'Not allowed.');
    const all = state(versions);
    const body = request.body();
    const environment = all.find(
      item => item.view.slug === body.environment || item.view.id === body.environment
    );
    if (!environment)
      return ok(
        {
          detail: {
            code: 'proposal_invalid',
            error: 'The proposal is not valid.',
            errors: [{ step: 1, code: 'environment_not_found', message: 'Environment not found.' }],
          },
        },
        422
      );
    const inEffect = environment.view.inEffect;
    const adoptBase = {
      environmentEtag: etagOf(environment),
      inEffect: inEffect?.version.id ?? null,
    };
    made += 1;
    const id = `00000000-0000-4000-8000-0000000007${String(made).padStart(2, '0')}`;
    let steps: ProposalStepView[];
    let summary: string;
    if (body.kind === 'derive_and_adopt') {
      const source = (body.source ?? {}) as Record<string, unknown>;
      const label = String(body.label ?? '');
      const from =
        typeof source.revision === 'string'
          ? source.revision
          : `run ${String(source.run).slice(0, 8)}`;
      const pending = adapt(core<ProposalView>('zproposals.pending.json'), org, versions);
      const preview = pending.steps[0].preview;
      steps = [
        pendingStep({
          ordinal: 1,
          kind: 'seal_derived',
          description: `Seal ${label} from ${from}`,
          params: { label, source },
          base: {
            headVersionId: versions.at(-1)?.id ?? null,
            contentDigest: 'sha256-mock',
            revisionId: 'rev',
          },
          preview: preview && {
            ...preview,
            document: derive.preview(label, source),
            against: inEffect
              ? {
                  environment: {
                    id: environment.view.id,
                    name: environment.view.name,
                    slug: environment.view.slug,
                  },
                  version: { id: inEffect.version.id, label: inEffect.version.label },
                }
              : null,
          },
        }),
        pendingStep({
          ordinal: 2,
          kind: 'adopt',
          description: `Adopt the version step 1 seals in ${environment.view.name}`,
          params: {
            environment: environment.view.id,
            version: '@s1.version',
            note: String(body.note ?? ''),
          },
          base: { ...adoptBase, deferred: ['version'], dependsOn: [1] },
          deferred: ['version'],
          dependsOn: [1],
        }),
      ];
      summary = `${steps[0].description}; then ${steps[1].description}`;
    } else {
      const asked = String(body.version ?? '');
      const version = versions.find(item => item.id === asked || item.label === asked);
      if (!version) return refuse(404, 'version_not_found', 'Composition version not found.');
      steps = [
        pendingStep({
          ordinal: 1,
          kind: 'adopt',
          description: `Adopt ${version.label} in ${environment.view.name}`,
          params: {
            environment: environment.view.id,
            version: version.id,
            note: String(body.note ?? ''),
          },
          base: adoptBase,
        }),
      ];
      summary = steps[0].description;
    }
    // A new proposal replaces its author's pending one.
    for (const item of store.proposals)
      if (item.status === 'pending' && item.mine) {
        item.status = 'superseded';
        item.supersededBy = id;
      }
    const proposal: ProposalView = {
      id,
      status: 'pending',
      summary,
      steps,
      warnings: [],
      origin: 'web',
      mine: true,
      composition: { id: `composition-${composition}`, slug: composition, name: 'TomatoMeter' },
      organization: { id: `org-${org}`, slug: org, name: org },
      proposedBy: { username: 'alex.rivera' },
      confirmationPhrase: null,
      upstreamEvent: typeof body.upstreamEvent === 'string' ? body.upstreamEvent : null,
      supersededBy: null,
      createdAt: STAMP,
      confirmedAt: null,
      completedAt: null,
    };
    store.proposals = [proposal, ...store.proposals];
    return ok(proposal, 201);
  }

  function proposalRoute(
    request: CompositionRequest,
    versions: readonly CompositionVersionView[],
    derive: Derive
  ): CompositionReply {
    const [, , , , id, action] = request.parts;
    const proposal = store.proposals.find(item => item.id === id);
    if (!proposal) return refuse(404, 'not_found', 'Proposal not found.');
    if (!action && request.method === 'GET') return ok(proposal);
    if (proposal.status !== 'pending')
      return refuse(409, 'proposal_not_pending', 'This proposal is no longer pending.');
    if (!action && request.method === 'DELETE') {
      proposal.status = 'cancelled';
      return ok(proposal);
    }
    if (action !== 'confirm' || request.method !== 'POST')
      return refuse(405, 'method_not_allowed', 'Not allowed.');
    store.confirmed.push({
      id: proposal.id,
      confirmation: request.body().confirmation as string | undefined,
    });
    const all = state(versions);
    // The pre-flight: every adopt step's environment as it was when proposed.
    const stale = proposal.steps.flatMap(step => {
      if (step.kind !== 'adopt') return [];
      const environment = all.find(item => item.view.id === step.params.environment);
      const base = step.base as { environmentEtag?: string };
      if (!environment)
        return [{ step: step.ordinal, kind: 'adopt', reason: 'environment_missing' }];
      return etagOf(environment) === base.environmentEtag
        ? []
        : [
            {
              step: step.ordinal,
              kind: 'adopt',
              reason: 'environment_changed',
              base: base.environmentEtag,
              current: etagOf(environment),
            },
          ];
    });
    if (stale.length > 0) {
      proposal.status = 'stale';
      return ok(
        {
          detail: {
            code: 'proposal_stale',
            error:
              'This proposal is out of date: what it was built on changed since it was made. Nothing was changed.',
            stale,
          },
        },
        409
      );
    }
    proposal.confirmedAt = STAMP;
    for (const step of proposal.steps) {
      const failedDependency = step.dependsOn.some(
        ordinal => proposal.steps.find(other => other.ordinal === ordinal)?.status !== 'done'
      );
      if (failedDependency) {
        step.status = 'skipped';
        step.error = {
          status: 0,
          code: 'skipped_dependency',
          message: 'Skipped: a step it depends on did not complete.',
          detail: null,
        };
        continue;
      }
      step.finishedAt = STAMP;
      if (step.kind === 'seal_derived') {
        const sealed = derive.seal(
          String(step.params.label),
          step.params.source as Record<string, unknown>
        );
        if ('status' in sealed && 'json' in sealed) {
          step.status = 'failed';
          step.error = {
            status: sealed.status,
            code: 'derivation_invalid',
            message: 'The version could not be sealed.',
            detail: null,
          };
          continue;
        }
        const version = sealed as CompositionVersionView;
        versions = [...versions.filter(item => item.id !== version.id), version];
        step.status = 'done';
        step.result = { version: { id: version.id, label: version.label }, created: true };
      } else {
        const sealedBy = (proposal.steps.find(other => other.ordinal === step.dependsOn[0])
          ?.result ?? {}) as {
          version?: { id: string };
        };
        const versionId =
          step.params.version === '@s1.version'
            ? sealedBy.version?.id
            : String(step.params.version);
        const environment = all.find(item => item.view.id === step.params.environment)!;
        const answer = route(
          {
            method: 'POST',
            parts: [
              'v1',
              'organizations',
              org,
              'compositions',
              composition,
              'environments',
              environment.view.slug,
              'adopt',
            ],
            query: new URLSearchParams(),
            body: () => ({ version: versionId, note: step.params.note ?? '' }),
            text: () => '',
            header: name =>
              name === 'if-match'
                ? String((step.base as { environmentEtag?: string }).environmentEtag)
                : undefined,
          },
          versions
        );
        if (answer.status !== 200) {
          const refusal =
            (answer.json as { detail?: { code?: string; error?: string } })?.detail ?? {};
          step.status = 'failed';
          step.error = {
            status: answer.status,
            code: refusal.code ?? 'failed',
            message: refusal.error ?? 'Not adopted.',
            detail: null,
          };
          continue;
        }
        const adoption = (answer.json as { adoption: CompositionAdoptionView }).adoption;
        adoption.source = 'proposal';
        adoption.proposal = { id: proposal.id, summary: proposal.summary };
        step.status = 'done';
        step.result = {
          environment: environment.view.slug,
          ordinal: adoption.ordinal,
          feedEtag: adoption.feedEtag,
          versionLabel: adoption.version.label,
        };
      }
    }
    const done = proposal.steps.filter(step => step.status === 'done').length;
    proposal.status =
      done === proposal.steps.length ? 'completed' : done === 0 ? 'failed' : 'partial';
    proposal.completedAt = STAMP;
    return ok(proposal);
  }

  return store;
}
