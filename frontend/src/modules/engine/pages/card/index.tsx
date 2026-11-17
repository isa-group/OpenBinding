// Adapted from SPHERE frontend/src/modules/pricing/pages/card/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: an exact engine revision instead of a pricing, on the card shell shared with the composition page: the breadcrumb
// "Engines / namespace / name", the revision select (the other versions of the same engine), the orange Get menu (copy the
// exact reference, download the manifest), Run and Study actions that choose an organization with SPHERE's selector, the
// stat tiles Modes, Capabilities, Revisions and Your plan ceiling, and the tabs Modes & options, Capabilities and
// Registrations in `?tab=`. A revision that is missing or that the reader may not see is the in-place 404; a link naming
// another digest says so instead of calling the revision verified. HARVEY, Follow, Fork and the versions graph are not
// brought: an engine revision is immutable and is changed by registering a new one.

import { useState } from 'react';
import { Helmet } from 'react-helmet-async';
import { MdWarningAmber } from 'react-icons/md';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  bimResourceKey,
  type CapabilitySelector,
  type EngineManifest,
  type EngineMode,
} from '../../api/engineClient';
import { useResource } from '../../../core/hooks/useResource';
import { HttpError } from '../../../core/api/http';
import { Action } from '../../../core/components/action-button';
import BlockAlert from '../../../core/components/block-alert';
import { DataTable } from '../../../core/components/data-table';
import { FilterPills } from '../../../core/components/filter-pills';
import ResourceCardShell, {
  type OverflowAction,
  type ShellTab,
} from '../../../core/components/resource-card-shell';
import PricingCardSkeleton from '../../../core/components/skeletons/pricing-card-skeleton';
import NotFoundPage from '../../../core/pages/page-not-found';
import { useAuth } from '../../../auth/hooks/useAuth';
import {
  ENGINES_PATH,
  MY_ENGINES_PATH,
  engineHref,
  isEngineTab,
  type EngineTab,
} from '../../../../routes/paths/engines';
import { launchPath } from '../../../../routes/paths/runs';
import { newStudyPath } from '../../../../routes/paths/studies';
import {
  useEnginesApi,
  type EngineCatalogEntry,
  type EngineRegistrationReport,
  type EngineRegistrationRevision,
  type EngineRevision,
  type EnginesApi,
} from '../../api/enginesApi';
import { engineKey, optionFacts, selectorText } from '../../api/enginesModel';
import {
  planCeilings,
  previewOption,
  type PlanCeilings,
  type PlanLimits,
} from '../../api/planCeilings';
import EngineLaunchModal from '../../components/engine-launch-modal';
import { RegistrationReportView } from '../../components/engine-report-view';
import { StatusChip } from '../../components/engine-parts';
import { CARD, CARD_TITLE, MUTED } from '../../components/engine-parts/styles';
import GetEngineMenu from '../../components/get-engine-menu';

type TabId = 'modes' | EngineTab;

interface Loaded {
  forUser: string | null;
  entry: EngineCatalogEntry;
  revision: EngineRevision | null;
  /** The other revisions of the same engine this account can see, for the revision select. */
  siblings: EngineCatalogEntry[];
}

const DIMENSIONS: ReadonlyArray<{ id: keyof EngineMode['capabilities']; label: string }> = [
  { id: 'workflowNodes', label: 'Workflow nodes' },
  { id: 'aggregations', label: 'Aggregations' },
  { id: 'metricScopes', label: 'Metric scopes' },
  { id: 'constraints', label: 'Constraints' },
  { id: 'optimization', label: 'Optimization' },
  { id: 'objectiveTypes', label: 'Objective types' },
  { id: 'expressions', label: 'Expressions' },
  { id: 'placement', label: 'Placement' },
  { id: 'irExtensions', label: 'IR extensions' },
  { id: 'featureValues', label: 'Feature values' },
];

const TERMINATIONS: ReadonlyArray<{ id: string; text: string }> = [
  { id: 'OPTIMAL', text: 'Best binding under the objective, proven.' },
  { id: 'FEASIBLE', text: 'Satisfies every hard constraint; optimality not proven.' },
  { id: 'INFEASIBLE', text: 'No binding satisfies the hard constraints.' },
  { id: 'UNKNOWN', text: 'Ended without a conclusion, for example out of budget.' },
];

const TABS: ReadonlyArray<{ id: TabId; label: string; shortLabel?: string }> = [
  { id: 'modes', label: 'Modes & options', shortLabel: 'Modes' },
  { id: 'capabilities', label: 'Capabilities' },
  { id: 'registrations', label: 'Registrations' },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** An engine that exists but the caller may not see answers like one that does not exist. */
function isNeutralNotFound(error: unknown): boolean {
  return error instanceof HttpError && (error.status === 404 || error.status === 403);
}

/** The modes of an Engine document, for a revision the catalog list does not carry. */
function entryFromRevision(revision: EngineRevision): EngineCatalogEntry | null {
  const spec = isRecord(revision.document) ? revision.document.spec : undefined;
  const modes = isRecord(spec) && Array.isArray(spec.modes) ? (spec.modes as EngineMode[]) : null;
  if (!modes) return null;
  const ref = {
    namespace: revision.namespace,
    name: revision.name,
    version: revision.version,
    digest: revision.digest,
  };
  return { ...ref, id: `${ref.namespace}/${ref.name}`, ref, modes };
}

async function loadEngine(
  api: EnginesApi,
  username: string | null,
  namespace: string,
  name: string,
  version: string
): Promise<Loaded> {
  const engines = username ? (await api.getCatalogEngines()).engines : await api.getPublicEngines();
  const found =
    engines.find(
      engine => engine.namespace === namespace && engine.name === name && engine.version === version
    ) ?? null;
  let revision: EngineRevision | null = null;
  if (username) {
    try {
      revision = await api.engineRevision(namespace, name, version);
    } catch (error) {
      // The list already answered; the revision adds state and registration, and a refusal means nothing more is visible.
      if (!found && !isNeutralNotFound(error)) throw error;
    }
  }
  const entry = found ?? (revision ? entryFromRevision(revision) : null);
  if (!entry) throw new HttpError(404, 'Engine revision not found');
  return {
    forUser: username,
    entry,
    revision,
    siblings: engines.filter(engine => engine.namespace === namespace && engine.name === name),
  };
}

function downloadManifest(entry: EngineCatalogEntry, revision: EngineRevision | null) {
  const manifest: unknown =
    revision && isRecord(revision.document) && Object.keys(revision.document).length > 0
      ? revision.document
      : ({
          apiVersion: 'bim/v1',
          kind: 'Engine',
          metadata: { namespace: entry.namespace, name: entry.name, version: entry.version },
          spec: { modes: entry.modes },
        } satisfies EngineManifest);
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' })
  );
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${entry.namespace}-${entry.name}-${entry.version}.engine.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

/** How many capability dimensions the revision's modes declare (each dimension once). */
function declaredDimensions(modes: EngineMode[]): number {
  return DIMENSIONS.filter(dimension =>
    modes.some(mode => mode.capabilities?.[dimension.id] !== undefined)
  ).length;
}

function ceilingText(limits: PlanLimits | null | undefined): string {
  if (!limits) return '—';
  return limits.maxRunMinutes === null
    ? 'No limit'
    : `${limits.maxRunMinutes.toLocaleString('en-US')} min`;
}

/**
 * `/engines/:namespace/:name/:version`: one exact engine revision on SPHERE's card page, open to everyone. The tab is in
 * `?tab=`; a revision the reader cannot see, and any other tab, is the in-place 404.
 */
export default function EngineCardPage() {
  const { namespace = '', name = '', version = '' } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const api = useEnginesApi();
  const { user } = useAuth();
  const username = user?.username ?? null;
  const detail = useResource(
    `engine:${namespace}/${name}/${version}:${username ?? 'visitor'}`,
    () => loadEngine(api, username, namespace, name, version)
  );
  // The live catalog (GET /v1/pricing/catalog).
  const pricing = useResource('plan-ceilings', async () =>
    planCeilings(await api.getPricingCatalog())
  );
  const registrations = useResource(`engine-registrations:${username ?? 'visitor'}`, async () =>
    username ? api.listEngineRegistrations() : []
  );
  const [modeChoice, setModeChoice] = useState('');
  const [planChoice, setPlanChoice] = useState('');
  const [launching, setLaunching] = useState<'run' | 'study' | null>(null);

  const tabParam = params.get('tab');
  // After a failed refresh the last copy of this very revision stays on screen; never another revision or account's.
  const kept = detail.stale;
  const sameRevision =
    kept?.forUser === username &&
    kept.entry.namespace === namespace &&
    kept.entry.name === name &&
    kept.entry.version === version;
  const data = detail.data ?? (sameRevision ? kept : undefined);
  const failure = detail.status === 'error' ? detail.error : null;

  if (tabParam !== null && !isEngineTab(tabParam)) return <NotFoundPage />;
  if (isNeutralNotFound(failure)) return <NotFoundPage />;
  if (!data) {
    if (detail.status !== 'error') return <PricingCardSkeleton />;
    return (
      <div className="mx-auto max-w-7xl px-4 py-16 text-center md:px-8">
        <div
          role="alert"
          className="mx-auto max-w-[28rem] rounded-xl border border-red-200 bg-red-50 p-6"
        >
          <p className="text-sm font-medium text-red-800">
            The engine contract couldn’t be loaded.
          </p>
          <p className="mt-1 text-xs text-red-700">
            {failure instanceof HttpError
              ? `The gateway answered HTTP ${failure.status}.`
              : 'The gateway can’t be reached.'}{' '}
            This says nothing about your access.
          </p>
          <button
            type="button"
            onClick={detail.reload}
            className="mt-4 cursor-pointer rounded-lg border border-red-300 bg-tp-canvas px-4 py-1.5 text-xs font-medium text-red-800 hover:bg-red-100"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  const tab: TabId = tabParam && isEngineTab(tabParam) ? tabParam : 'modes';
  const { entry, revision } = data;
  const ref = bimResourceKey(entry);
  const expectedDigest = params.get('digest');
  const digestMismatch = Boolean(expectedDigest) && expectedDigest !== entry.digest;
  const conflict = failure instanceof HttpError && failure.status === 409;
  const refused = failure instanceof HttpError && !conflict ? failure : null;
  const visibility = revision
    ? revision.state === 'private'
      ? 'Private'
      : 'Public'
    : entry.namespace === username
      ? 'Private'
      : 'Public';

  const mode = entry.modes.find(item => item.id === modeChoice) ?? entry.modes[0];
  const ceilings: PlanCeilings | null = pricing.data ?? null;
  const planNames = ceilings?.plans.map(item => item.plan) ?? [];
  const userPlan = user?.plan && planNames.includes(user.plan) ? user.plan : '';
  const plan = planNames.includes(planChoice)
    ? planChoice
    : userPlan || (planNames.includes('FREE') ? 'FREE' : (planNames[0] ?? ''));
  const limits = ceilings?.plans.find(item => item.plan === plan) ?? null;
  const ownLimits = ceilings?.plans.find(item => item.plan === (user ? user.plan : 'FREE'));
  const own = (registrations.data ?? []).filter(
    item =>
      item.namespace === entry.namespace &&
      item.name === entry.name &&
      item.version === entry.version
  );
  const tabs: ShellTab[] = TABS.map(item => ({
    id: item.id,
    label: item.label,
    shortLabel: item.shortLabel,
    to: `${engineHref(entry, item.id === 'modes' ? undefined : item.id)}${
      expectedDigest ? `${item.id === 'modes' ? '?' : '&'}digest=${expectedDigest}` : ''
    }`,
  }));

  const runDestination = (org: string) => launchPath(org, { engine: ref });
  const studyDestination = (org: string) => newStudyPath(org, { engine: ref });
  const overflow: OverflowAction[] = user
    ? [
        { label: 'Run with this engine', onSelect: () => setLaunching('run') },
        { label: 'Add to a study', onSelect: () => setLaunching('study') },
      ]
    : [{ label: 'Log in to run', to: '/authentication' }];

  const subtitle = (
    <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-tp-steel">
      {data.siblings.length > 1 ? (
        <select
          aria-label="Revision"
          value={engineKey(entry)}
          onChange={event => {
            const next = data.siblings.find(item => engineKey(item) === event.target.value);
            if (next) void navigate(engineHref(next));
          }}
          className="h-7 cursor-pointer rounded-lg border border-tp-input-border bg-tp-input-bg px-2 text-xs font-medium text-tp-ink focus:border-tp-primary focus:outline-none"
        >
          {data.siblings.map(item => (
            <option key={engineKey(item)} value={engineKey(item)}>
              {item.version}
            </option>
          ))}
        </select>
      ) : (
        <span className="rounded-lg border border-tp-input-border bg-tp-input-bg px-2 py-1 text-xs font-medium text-tp-ink">
          {entry.version}
        </span>
      )}
      <StatusChip tone={digestMismatch ? 'warning' : visibility === 'Public' ? 'success' : 'plain'}>
        {digestMismatch ? 'Digest mismatch' : visibility === 'Public' ? 'Published' : 'Private'}
      </StatusChip>
    </div>
  );

  const actionClass =
    'flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border border-tp-input-border bg-tp-input-bg px-3 text-xs text-tp-ink transition-colors hover:bg-tp-surface focus:border-tp-primary focus:outline-none';

  return (
    <>
      <Helmet>
        <title>
          OpenBinding - {entry.namespace}/{entry.name} {entry.version}
        </title>
      </Helmet>
      <ResourceCardShell
        crumbs={[
          { label: 'Engines', to: ENGINES_PATH },
          { label: entry.namespace },
          { label: entry.name },
        ]}
        title={`${entry.namespace}/${entry.name}`}
        subtitle={subtitle}
        actions={
          user ? (
            <>
              <button type="button" className={actionClass} onClick={() => setLaunching('run')}>
                Run with this engine
              </button>
              <button type="button" className={actionClass} onClick={() => setLaunching('study')}>
                Add to a study
              </button>
            </>
          ) : (
            <Link to="/authentication" className={actionClass}>
              Log in to run
            </Link>
          )
        }
        primaryAction={
          <GetEngineMenu
            reference={ref}
            onDownloadManifest={() => downloadManifest(entry, revision)}
          />
        }
        overflow={overflow}
        stats={[
          { label: 'Modes', value: entry.modes.length },
          { label: 'Capabilities', value: declaredDimensions(entry.modes) },
          { label: 'Revisions', value: Math.max(1, data.siblings.length) },
          {
            label: user ? 'Your plan ceiling' : 'Plan ceiling (FREE)',
            value: pricing.status === 'loading' && !ceilings ? '…' : ceilingText(ownLimits ?? null),
          },
        ]}
        tabs={tabs}
        activeTab={tab}
        tabsLabel="Engine sections"
      >
        <div className="flex flex-col gap-4">
          {digestMismatch && (
            <BlockAlert variant="error">
              <strong>This reference points to a different digest (409).</strong> The link asked for
              a digest that doesn’t match this revision’s contract, so the revision isn’t shown as
              verified. Copy the exact reference from the Get engine menu to use the correct one.
            </BlockAlert>
          )}
          {conflict && (
            <BlockAlert variant="error">
              <strong>The gateway reports a conflict (409).</strong> The reference doesn’t match the
              revision it holds. Copy the exact reference from the Get engine menu to use the
              correct one.
            </BlockAlert>
          )}
          {(refused || (detail.status === 'error' && !(failure instanceof HttpError))) && (
            <BlockAlert variant="error">
              {refused
                ? `The engine contract couldn’t be refreshed (HTTP ${refused.status}). You’re seeing the last copy loaded.`
                : 'The engine contract couldn’t be refreshed: the gateway can’t be reached. You’re seeing the last copy loaded.'}{' '}
              <button
                type="button"
                onClick={detail.reload}
                className="cursor-pointer font-medium underline"
              >
                Retry
              </button>
            </BlockAlert>
          )}

          {entry.modes.length > 1 && tab !== 'registrations' && (
            <FilterPills
              ariaLabel="Mode"
              options={entry.modes.map(item => ({ id: item.id, label: `Mode · ${item.id}` }))}
              value={mode?.id ?? ''}
              onChange={setModeChoice}
            />
          )}
          {tab === 'modes' && (
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
              <div className="flex min-w-0 flex-col gap-4">
                {mode ? (
                  <ModePanel
                    mode={mode}
                    ceilings={ceilings}
                    loading={pricing.status === 'loading'}
                    failed={pricing.status === 'error'}
                    plan={plan}
                    signedIn={Boolean(user)}
                    ownPlan={userPlan}
                    onPlan={setPlanChoice}
                    limits={limits}
                  />
                ) : (
                  <p className={MUTED}>This revision advertises no modes.</p>
                )}
              </div>
              <aside className="flex flex-col gap-4">
                <section aria-label="Exact reference" className={CARD}>
                  <h2 className={CARD_TITLE}>Exact reference</h2>
                  <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm">
                    <dt className="text-tp-steel">Namespace</dt>
                    <dd className="font-mono [overflow-wrap:anywhere]">{entry.namespace}</dd>
                    <dt className="text-tp-steel">Name</dt>
                    <dd className="font-mono [overflow-wrap:anywhere]">{entry.name}</dd>
                    <dt className="text-tp-steel">Version</dt>
                    <dd>{entry.version}</dd>
                    <dt className="text-tp-steel">Visibility</dt>
                    <dd>
                      <StatusChip tone={visibility === 'Public' ? 'success' : 'plain'}>
                        {visibility}
                      </StatusChip>
                    </dd>
                    <dt className="text-tp-steel">Modes</dt>
                    <dd>
                      {entry.modes.length} ·{' '}
                      {entry.modes
                        .map(
                          item =>
                            `${item.id} (${optionFacts(item).length} option${optionFacts(item).length === 1 ? '' : 's'})`
                        )
                        .join(', ') || 'none'}
                    </dd>
                  </dl>
                  <small className={MUTED}>
                    Everything in the engine’s manifest is shown on this page; the Get engine menu
                    downloads it for tools that need the file.
                  </small>
                </section>
                <section aria-label="Your plan" className={CARD}>
                  <h2 className={CARD_TITLE}>Your plan</h2>
                  <PlanNote ceilings={ceilings} plan={user?.plan ?? ''} signedIn={Boolean(user)} />
                </section>
              </aside>
            </div>
          )}
          {tab === 'capabilities' && (
            <CapabilitiesPanel modes={entry.modes} signedIn={Boolean(user)} />
          )}
          {tab === 'registrations' && (
            <RegistrationsPanel
              api={api}
              signedIn={Boolean(user)}
              status={registrations.status}
              own={own}
              revision={revision}
              builtin={!revision && own.length === 0}
              onRetry={registrations.reload}
            />
          )}
        </div>
      </ResourceCardShell>

      {launching === 'run' && (
        <EngineLaunchModal
          title="Run with this engine"
          actionLabel="Run with this engine"
          noun="run"
          destination={runDestination}
          onClose={() => setLaunching(null)}
        />
      )}
      {launching === 'study' && (
        <EngineLaunchModal
          title="Add to a study"
          actionLabel="Add to a study"
          noun="study"
          destination={studyDestination}
          onClose={() => setLaunching(null)}
        />
      )}
    </>
  );
}

function PlanNote({
  ceilings,
  plan,
  signedIn,
}: {
  ceilings: PlanCeilings | null;
  plan: string;
  signedIn: boolean;
}) {
  const source = ceilings
    ? `Figures from pricing ${ceilings.version ?? 'as served by the gateway'}.`
    : 'The pricing document couldn’t be read.';
  const row = ceilings?.plans.find(item => item.plan === (signedIn ? plan : 'FREE'));
  if (!ceilings || !row)
    return (
      <p className="text-sm text-tp-slate">
        {signedIn ? `${plan}: ceilings unavailable.` : 'Ceilings depend on your plan.'} {source}
      </p>
    );
  const timeout =
    row.maxRunMinutes === null
      ? 'no plan limit'
      : `${row.maxRunMinutes.toLocaleString('en-US')} min`;
  return signedIn ? (
    <p className="text-sm text-tp-slate">
      {row.plan}: max {timeout} per run. {source}
    </p>
  ) : (
    <p className="text-sm text-tp-slate">
      Ceilings depend on your plan. {row.plan} allows {timeout} per run. {source}
    </p>
  );
}

interface ModePanelProps {
  mode: EngineMode;
  ceilings: PlanCeilings | null;
  loading: boolean;
  failed: boolean;
  plan: string;
  signedIn: boolean;
  ownPlan: string;
  onPlan: (plan: string) => void;
  limits: PlanLimits | null;
}

function ModePanel({
  mode,
  ceilings,
  loading,
  failed,
  plan,
  signedIn,
  ownPlan,
  onPlan,
  limits,
}: ModePanelProps) {
  const facts = optionFacts(mode);
  const limitEntries = Object.entries(mode.limits ?? {});
  const termination: string[] = mode.guarantees?.termination ?? [];
  const fact = 'flex flex-col gap-0.5 rounded-lg bg-tp-surface p-3';
  return (
    <>
      <section className={CARD} aria-label={`Mode ${mode.id}`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className={CARD_TITLE}>
            Mode · <span className="font-mono">{mode.id}</span>
          </h2>
          {ceilings && ceilings.plans.length > 0 ? (
            <label className="flex items-center gap-2 text-xs text-tp-steel">
              {signedIn && plan === ownPlan ? 'Your plan' : 'Preview plan'}
              <select
                value={plan}
                onChange={event => onPlan(event.target.value)}
                aria-label="Plan to preview"
                className="h-7 cursor-pointer rounded-lg border border-tp-input-border bg-tp-input-bg px-2 text-xs font-medium text-tp-ink focus:border-tp-primary focus:outline-none"
              >
                {ceilings.plans.map(item => (
                  <option key={item.plan} value={item.plan}>
                    {item.plan}
                  </option>
                ))}
              </select>
              <small>(pricing {ceilings.version ?? 'as served'})</small>
            </label>
          ) : (
            <small className={MUTED}>
              {loading
                ? 'Reading the pricing document…'
                : failed
                  ? 'The pricing document couldn’t be read, so ceilings are not shown.'
                  : 'No plans in the pricing document.'}
            </small>
          )}
        </div>
        {facts.length === 0 ? (
          <p className={MUTED}>This mode takes no caller options.</p>
        ) : (
          <DataTable label={`Options of mode ${mode.id}`} minWidth={640}>
            <thead>
              <tr>
                <th scope="col">Option</th>
                <th scope="col">Unit</th>
                <th scope="col">Default</th>
                <th scope="col">
                  {signedIn && plan === ownPlan ? 'Your plan’s ceiling' : 'Plan ceiling'}
                </th>
                <th scope="col">With the default</th>
              </tr>
            </thead>
            <tbody>
              {facts.map(item => {
                const preview = previewOption(item, limits);
                return (
                  <tr key={item.name}>
                    <td className="font-mono">
                      {preview.name}
                      {preview.required && (
                        <small className="ml-2 font-sans text-[11px] text-tp-warning-text">
                          required
                        </small>
                      )}
                    </td>
                    <td>{preview.unit}</td>
                    <td>{preview.default}</td>
                    <td>{preview.ceiling}</td>
                    <td>
                      {preview.outcome.kind === 'clamped' ? (
                        <span className="inline-flex items-center gap-1 text-tp-warning-text">
                          <MdWarningAmber className="h-4 w-4" aria-hidden="true" />
                          OPTION_CLAMPED → {preview.outcome.applied}
                        </span>
                      ) : (
                        <span className="text-tp-success-text">{preview.outcome.text}</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </DataTable>
        )}
        <p className={MUTED}>
          Time and effort options (<code>time_budget_ms</code>, <code>iterations</code>,{' '}
          <code>max_evaluations</code>) are reduced to the plan’s ceiling and the run carries an
          OPTION_CLAMPED warning; it isn’t an error. Every other option applies as requested.
        </p>
      </section>

      <section className={CARD} aria-label="Mode contract">
        <h2 className={CARD_TITLE}>Mode contract</h2>
        <dl className="grid gap-2 text-sm sm:grid-cols-2">
          <div className={fact}>
            <dt className="text-[11px] text-tp-steel">Profile</dt>
            <dd className="font-mono [overflow-wrap:anywhere]">{mode.profile}</dd>
            <small className={MUTED}>must match exactly</small>
          </div>
          <div className={fact}>
            <dt className="text-[11px] text-tp-steel">Output IR</dt>
            <dd className="font-mono">
              {mode.ir?.apiVersion} · {mode.ir?.kind}
            </dd>
            <small className={MUTED}>must match exactly</small>
          </div>
          <div className={fact}>
            <dt className="text-[11px] text-tp-steel">Algorithm</dt>
            <dd>{mode.algorithm}</dd>
            <small className={MUTED}>does not imply a guarantee</small>
          </div>
          <div className={fact}>
            <dt className="text-[11px] text-tp-steel">Guarantee</dt>
            <dd>{mode.guarantees?.exact ? 'Exact mode' : 'Heuristic mode'}</dd>
            <small className={MUTED}>{termination.join(' · ') || 'No termination declared'}</small>
          </div>
        </dl>
        {limitEntries.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-tp-steel">
            <span>Declared ceilings</span>
            {limitEntries.map(([limit, value]) => (
              <span
                key={limit}
                className="rounded bg-tp-surface px-1.5 py-0.5 font-mono text-tp-ink"
              >
                {limit}: {value.toLocaleString('en-US')}
              </span>
            ))}
          </div>
        )}
      </section>

      <section className={CARD} aria-label="How a run can end">
        <h2 className={CARD_TITLE}>How a run can end</h2>
        <div className="grid gap-2 sm:grid-cols-2">
          {TERMINATIONS.map(item => {
            const declared = termination.includes(item.id);
            return (
              <div
                key={item.id}
                className={`flex flex-col gap-0.5 rounded-lg border p-3 text-sm ${
                  declared
                    ? 'border-tp-severity-success-border bg-tp-severity-success-bg'
                    : 'border-tp-hairline bg-tp-canvas'
                }`}
              >
                <span className="font-mono text-xs font-semibold text-tp-ink">{item.id}</span>
                <p className="text-tp-slate">{item.text}</p>
                {declared && (
                  <small className="text-xs text-tp-success-text">Declared by this mode</small>
                )}
              </div>
            );
          })}
        </div>
        <small className={MUTED}>
          Which of these this revision can guarantee is part of its contract; the mode declares{' '}
          {termination.length ? termination.join(', ') : 'none'}.
        </small>
      </section>
    </>
  );
}

function SelectorChip({ selector }: { selector: CapabilitySelector | undefined }) {
  if (!selector) return <span className={MUTED}>Not declared</span>;
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <StatusChip tone={selector.selector === 'none' ? 'plain' : 'info'}>
        {selector.selector}
      </StatusChip>
      {selector.selector === 'only' && (
        <span className="font-mono text-xs">{selectorText(selector)}</span>
      )}
    </span>
  );
}

function CapabilitiesPanel({ modes, signedIn }: { modes: EngineMode[]; signedIn: boolean }) {
  return (
    <section className={CARD} aria-label="Capabilities">
      <DataTable label="Capabilities by dimension" minWidth={modes.length > 1 ? 720 : 480}>
        <thead>
          <tr>
            <th scope="col">Dimension</th>
            {modes.map(mode => (
              <th key={mode.id} scope="col">
                Mode {mode.id}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {DIMENSIONS.map(dimension => (
            <tr key={dimension.id}>
              <td>{dimension.label}</td>
              {modes.map(mode => (
                <td key={mode.id}>
                  <SelectorChip selector={mode.capabilities?.[dimension.id]} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </DataTable>
      <BlockAlert variant="info">
        {signedIn
          ? 'Compatibility with your last validated package is checked when you launch a run.'
          : 'Validate a package in the Workbench, then log in to check it against this mode.'}
      </BlockAlert>
      <small className={MUTED}>
        <code>none</code> rejects the dimension. <code>only</code> names exact values.{' '}
        <code>all</code> is valid only when the Profile closes the vocabulary.
      </small>
      <small className={MUTED}>
        Feature values: <code>scalar</code> is a single number; <code>interval</code> is a range,
        and includes open ranges (an end <code>null</code>, such as ≤ 200 or ≥ 100). A package with
        a range runs only on a mode that declares <code>interval</code>; the others refuse it with{' '}
        <code>unsupported_capability_value</code>.
      </small>
    </section>
  );
}

interface RegistrationsPanelProps {
  api: EnginesApi;
  signedIn: boolean;
  status: 'loading' | 'ready' | 'error';
  own: EngineRegistrationRevision[];
  revision: EngineRevision | null;
  builtin: boolean;
  onRetry: () => void;
}

function RegistrationsPanel({
  api,
  signedIn,
  status,
  own,
  revision,
  builtin,
  onRetry,
}: RegistrationsPanelProps) {
  if (!signedIn) {
    return (
      <div className={`${CARD} text-sm text-tp-slate`}>
        <p>
          No deployment registrations are listed for this revision. Registrations and their
          conformance reports appear here for federated engines you can access.{' '}
          <Link
            to="/authentication"
            className="cursor-pointer font-medium text-tp-link hover:underline"
          >
            Log in
          </Link>{' '}
          to see yours.
        </p>
      </div>
    );
  }
  if (status === 'loading')
    return <div className={`${CARD} h-32 animate-pulse`} aria-busy="true" aria-label="Loading" />;
  if (status === 'error') {
    return (
      <BlockAlert variant="error">
        Your registrations couldn’t be loaded.{' '}
        <button type="button" onClick={onRetry} className="cursor-pointer font-medium underline">
          Retry
        </button>
      </BlockAlert>
    );
  }
  const anyActive = own.some(item => item.active);
  const needsRegistration = own.length > 0 ? !anyActive : revision?.state === 'private';
  return (
    <div className="flex flex-col gap-4">
      {needsRegistration && (
        <BlockAlert variant="warning">
          No active registration. This revision can’t be executed until a deployment registration is
          active.
        </BlockAlert>
      )}
      {own.length === 0 && (
        <div className={`${CARD} text-sm text-tp-slate`}>
          <p>
            {builtin
              ? 'No deployment registrations are listed for this revision. Built-in and published engines run without one; registrations and their conformance reports appear here for federated engines you can access.'
              : 'No deployment registrations are listed for this revision.'}
          </p>
        </div>
      )}
      {own.map(registration => (
        <RegistrationItem
          key={bimResourceKey(registration)}
          api={api}
          registration={registration}
        />
      ))}
      <Link
        to={MY_ENGINES_PATH}
        className="cursor-pointer self-start text-sm font-medium text-tp-link hover:underline"
      >
        Manage your registrations
      </Link>
    </div>
  );
}

function RegistrationItem({
  api,
  registration,
}: {
  api: EnginesApi;
  registration: EngineRegistrationRevision;
}) {
  const [open, setOpen] = useState(false);
  const report = useResource<EngineRegistrationReport | null>(
    `report:${bimResourceKey(registration)}:${open}`,
    async () => (open ? api.getEngineRegistrationReport(registration) : null)
  );
  return (
    <section className={CARD} aria-label={`Registration ${registration.name}`}>
      <div className="flex flex-wrap items-center gap-2">
        <strong className="mr-auto font-mono text-sm [overflow-wrap:anywhere] text-tp-ink">
          {registration.namespace}/{registration.name}@{registration.version}
        </strong>
        <StatusChip
          tone={
            registration.status === 'published'
              ? 'success'
              : registration.status === 'rejected'
                ? 'warning'
                : 'plain'
          }
        >
          {registration.status.replace('_', ' ')}
        </StatusChip>
        <StatusChip tone={registration.active ? 'success' : 'plain'}>
          {registration.active ? 'active for you' : 'inactive for you'}
        </StatusChip>
        <Action
          size="sm"
          variant="secondary"
          aria-expanded={open}
          onClick={() => setOpen(value => !value)}
        >
          {open ? 'Hide conformance report' : 'Show conformance report'}
        </Action>
      </div>
      {open && report.status === 'loading' && (
        <div className="h-20 animate-pulse rounded-lg bg-tp-surface" aria-hidden="true" />
      )}
      {open && report.status === 'error' && (
        <BlockAlert variant="error">
          {report.error instanceof HttpError &&
          (report.error.status === 404 || report.error.status === 403)
            ? 'No conformance report is visible for this registration.'
            : `The conformance report couldn’t be loaded (${report.error instanceof HttpError ? `HTTP ${report.error.status}` : 'the gateway can’t be reached'}).`}{' '}
          <button
            type="button"
            onClick={report.reload}
            className="cursor-pointer font-medium underline"
          >
            Retry
          </button>
        </BlockAlert>
      )}
      {open && report.data && <RegistrationReportView registration={report.data} />}
    </section>
  );
}
