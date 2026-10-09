import { useState } from 'react';
import { AlertTriangle, Search } from 'lucide-react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  apiClient,
  bimResourceKey,
  HttpError,
  type CapabilitySelector,
  type EngineCatalogEntry,
  type EngineManifest,
  type EngineMode,
  type EngineRegistrationReport,
  type EngineRegistrationRevision,
} from '../../api/client';
import { platformApi, type EngineRevision } from '../../api/platform';
import { RegistrationReportView } from '../../components/EngineReportView/EngineReportView';
import { Button } from '../../components/ui/Button';
import { Chip } from '../../components/ui/Chip';
import { DataTable } from '../../components/ui/DataTable';
import { FilterPills } from '../../components/ui/FilterPills';
import { Notice } from '../../components/ui/Notice';
import { ProjectPicker } from '../../components/ui/ProjectPicker';
import { Skeleton } from '../../components/ui/Skeleton';
import { TabBar, TabPanel } from '../../components/ui/TabBar';
import { useCopy } from '../../components/ui/useCopy';
import { useAuth } from '../../contexts/auth';
import { shortDigest } from '../../utils/digest';
import { useResource } from '../../utils/useResource';
import { engineHref, engineKey, optionFacts, selectorText } from '../Engines/enginesModel';
import { planCeilings, previewOption, type PlanCeilings, type PlanLimits } from './planCeilings';
import './EngineDetail.css';

type TabId = 'modes' | 'caps' | 'regs';

interface Loaded {
  forUser: string | null;
  entry: EngineCatalogEntry;
  revision: EngineRevision | null;
  /** Every revision this account can see, for the revision selector. */
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
];

const TERMINATIONS: ReadonlyArray<{ id: string; text: string }> = [
  { id: 'OPTIMAL', text: 'Best binding under the objective, proven.' },
  { id: 'FEASIBLE', text: 'Satisfies every hard constraint; optimality not proven.' },
  { id: 'INFEASIBLE', text: 'No binding satisfies the hard constraints.' },
  { id: 'UNKNOWN', text: 'Ended without a conclusion, for example out of budget.' },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** An engine that exists but the caller may not see answers like one that does not exist. */
function isNeutralNotFound(error: unknown): boolean {
  return error instanceof HttpError && (error.status === 404 || error.status === 403);
}

function notFound(): HttpError {
  return new HttpError(404, 'Engine revision not found');
}

/** The modes of an Engine document, for a revision the catalog list does not carry. */
function entryFromRevision(revision: EngineRevision): EngineCatalogEntry | null {
  const spec = isRecord(revision.document) ? revision.document.spec : undefined;
  const modes = isRecord(spec) && Array.isArray(spec.modes) ? spec.modes as EngineMode[] : null;
  if (!modes) return null;
  const ref = { namespace: revision.namespace, name: revision.name, version: revision.version, digest: revision.digest };
  return { ...ref, id: `${ref.namespace}/${ref.name}`, ref, modes };
}

async function loadEngine(username: string | null, namespace: string, name: string, version: string): Promise<Loaded> {
  const engines = username ? (await apiClient.getCatalogEngines()).engines : await apiClient.getPublicEngines();
  const found = engines.find((engine) => engine.namespace === namespace && engine.name === name && engine.version === version) ?? null;
  let revision: EngineRevision | null = null;
  if (username) {
    try {
      revision = await platformApi.engineRevision(namespace, name, version);
    } catch (error) {
      // The list already answered; the revision adds state and registration, and a refusal means nothing more is visible.
      if (!found && !isNeutralNotFound(error)) throw error;
    }
  }
  const entry = found ?? (revision ? entryFromRevision(revision) : null);
  if (!entry) throw notFound();
  return { forUser: username, entry, revision, siblings: engines };
}

function downloadManifest(entry: EngineCatalogEntry, revision: EngineRevision | null) {
  const manifest: unknown = revision && isRecord(revision.document) && Object.keys(revision.document).length > 0
    ? revision.document
    : ({
      apiVersion: 'bim/v1',
      kind: 'Engine',
      metadata: { namespace: entry.namespace, name: entry.name, version: entry.version },
      spec: { modes: entry.modes },
    } satisfies EngineManifest);
  const url = URL.createObjectURL(new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${entry.namespace}-${entry.name}-${entry.version}.engine.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

const TABS: ReadonlyArray<{ id: TabId; label: string }> = [
  { id: 'modes', label: 'Modes & options' },
  { id: 'caps', label: 'Capabilities' },
  { id: 'regs', label: 'Registrations' },
];

export function EngineDetail() {
  const { namespace = '', name = '', version = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const username = user?.username ?? null;
  const { copy, status: copyStatus } = useCopy();
  const detail = useResource(`engine:${namespace}/${name}/${version}:${username ?? 'visitor'}`, () => loadEngine(username, namespace, name, version));
  // The live catalog (GET /v1/pricing/catalog); the deprecated YAML endpoint is no longer read.
  const pricing = useResource('plan-ceilings', async () => planCeilings(await apiClient.getPricingCatalog()));
  const registrations = useResource(`engine-registrations:${username ?? 'visitor'}`, async () => (
    username ? apiClient.listEngineRegistrations() : []
  ));
  const [modeChoice, setModeChoice] = useState('');
  const [planChoice, setPlanChoice] = useState('');

  const tabParam = params.get('tab');
  const tab: TabId = TABS.some((item) => item.id === tabParam) ? tabParam as TabId : 'modes';
  // After a failed refresh the last copy of this very revision stays on screen; never another revision or account's.
  const kept = detail.stale;
  const sameRevision = kept?.forUser === username && kept.entry.namespace === namespace && kept.entry.name === name && kept.entry.version === version;
  const data = detail.data ?? (sameRevision ? kept : undefined);
  const failure = detail.status === 'error' ? detail.error : null;
  const hidden = isNeutralNotFound(failure);

  if (hidden) {
    return (
      <div className="engine-detail-page">
        <Breadcrumb namespace={namespace} name={name} />
        <div role="alert" className="engine-detail-neutral">
          <Search aria-hidden="true" />
          <h1>Engine revision not found</h1>
          <p>There’s no engine revision you can see at this address. Check the namespace, name and version.</p>
          <Link to="/engines">Back to the catalog</Link>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="engine-detail-page">
        <Breadcrumb namespace={namespace} name={name} />
        {detail.status === 'error' ? (
          <Notice tone="error" action={<Button size="sm" variant="secondary" onClick={detail.reload}>Retry</Button>}>
            The engine contract couldn’t be loaded ({failure instanceof HttpError ? `HTTP ${failure.status}` : 'the gateway can’t be reached'}).
          </Notice>
        ) : (
          <div aria-busy="true" aria-live="polite" className="engine-detail-loading">
            <h1 className="sr-only">Loading engine revision</h1>
            <Skeleton variant="panel" />
            <Skeleton variant="tile" />
            <Skeleton variant="panel" />
          </div>
        )}
      </div>
    );
  }

  const { entry, revision } = data;
  const ref = bimResourceKey(entry);
  const expectedDigest = params.get('digest');
  const digestMismatch = Boolean(expectedDigest) && expectedDigest !== entry.digest;
  const conflict = failure instanceof HttpError && failure.status === 409;
  const refused = failure instanceof HttpError && !conflict ? failure : null;
  const visibility = revision ? (revision.state === 'private' ? 'Private' : 'Public') : (entry.namespace === username ? 'Private' : 'Public');

  const mode = entry.modes.find((item) => item.id === modeChoice) ?? entry.modes[0];
  const ceilings: PlanCeilings | null = pricing.data ?? null;
  const planNames = ceilings?.plans.map((item) => item.plan) ?? [];
  const userPlan = user?.plan && planNames.includes(user.plan) ? user.plan : '';
  const plan = planNames.includes(planChoice) ? planChoice : userPlan || (planNames.includes('BASIC') ? 'BASIC' : planNames[0] ?? '');
  const limits = ceilings?.plans.find((item) => item.plan === plan) ?? null;
  const own = (registrations.data ?? []).filter((item) => item.namespace === entry.namespace && item.name === entry.name && item.version === entry.version);

  const setTab = (id: string) => {
    const next = new URLSearchParams(params);
    if (id === 'modes') next.delete('tab'); else next.set('tab', id);
    setParams(next, { replace: true });
  };

  return (
    <div className="engine-detail-page">
      <Breadcrumb namespace={entry.namespace} name={entry.name} />

      <header className="engine-detail-header">
        <div className="engine-detail-identity">
          <span className="engine-detail-kicker">
            Engine revision
            <Chip tone={digestMismatch ? 'warning' : visibility === 'Public' ? 'success' : 'plain'}>{digestMismatch ? 'Digest mismatch' : visibility}</Chip>
          </span>
          <h1>{entry.namespace}/{entry.name}<span>@{entry.version}</span></h1>
          <div className="engine-detail-digest">
            <code>{entry.digest}</code>
            <button type="button" className={copyStatus() === 'copied' ? 'is-copied' : undefined} onClick={() => void copy(ref)}>
              {copyStatus() === 'copied' ? 'Copied' : copyStatus() === 'failed' ? 'Failed' : 'Copy ref'}
            </button>
          </div>
          {data.siblings.length > 1 && (
            <label className="engine-detail-revision">
              Revision
              <select
                value={engineKey(entry)}
                onChange={(event) => {
                  const next = data.siblings.find((item) => engineKey(item) === event.target.value);
                  if (next) void navigate(engineHref(next));
                }}
              >
                {data.siblings.map((item) => <option key={engineKey(item)} value={engineKey(item)}>{engineKey(item)}</option>)}
              </select>
            </label>
          )}
        </div>
        <div className="engine-detail-actions">
          {user ? (
            <>
              <ProjectPicker variant="primary" label="Run with this engine" destination={(org, project) => `/app/${org}/${project}/jobs/new?engine=${encodeURIComponent(ref)}`} />
              <ProjectPicker label="Add to a study" destination={(org, project) => `/app/${org}/${project}/studies/new?engine=${encodeURIComponent(ref)}`} />
            </>
          ) : (
            <Link className="engine-detail-login" to="/login">Log in to run</Link>
          )}
        </div>
      </header>

      {digestMismatch && (
        <Notice tone="error" title="This reference points to a different digest (409).">
          The link asked for a digest that doesn’t match this revision’s contract, so the revision isn’t shown as verified. Copy the exact
          reference above to use the correct one.
        </Notice>
      )}
      {conflict && (
        <Notice tone="error" title="The gateway reports a conflict (409).">
          The reference doesn’t match the revision it holds. Copy the exact reference above to use the correct one.
        </Notice>
      )}
      {refused && (
        <Notice tone="error" action={<Button size="sm" variant="secondary" onClick={detail.reload}>Retry</Button>}>
          The engine contract couldn’t be refreshed (HTTP {refused.status}). You’re seeing the last copy loaded.
        </Notice>
      )}
      {detail.status === 'error' && !(failure instanceof HttpError) && (
        <Notice tone="error" action={<Button size="sm" variant="secondary" onClick={detail.reload}>Retry</Button>}>
          The engine contract couldn’t be refreshed: the gateway can’t be reached. You’re seeing the last copy loaded.
        </Notice>
      )}

      <TabBar
        prefix="engine-detail"
        ariaLabel="Engine sections"
        value={tab}
        onChange={setTab}
        items={TABS.map((item) => ({
          id: item.id,
          label: item.label,
          count: item.id === 'modes' ? entry.modes.length : item.id === 'regs' && user ? (registrations.status === 'ready' ? own.length : '…') : undefined,
        }))}
      />

      <div className="engine-detail-layout">
        <TabPanel prefix="engine-detail" active={tab}>
          {entry.modes.length > 1 && tab !== 'regs' && (
            <FilterPills
              ariaLabel="Mode"
              options={entry.modes.map((item) => ({ id: item.id, label: `Mode · ${item.id}` }))}
              value={mode?.id ?? ''}
              onChange={setModeChoice}
            />
          )}
          {tab === 'modes' && (mode
            ? (
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
            )
            : <p className="engine-detail-muted">This revision advertises no modes.</p>)}
          {tab === 'caps' && <CapabilitiesPanel modes={entry.modes} signedIn={Boolean(user)} />}
          {tab === 'regs' && (
            <RegistrationsPanel
              signedIn={Boolean(user)}
              status={registrations.status}
              own={own}
              revision={revision}
              builtin={!revision && own.length === 0}
              onRetry={registrations.reload}
            />
          )}
        </TabPanel>

        <aside className="engine-detail-side">
          <section aria-label="Exact reference">
            <h2>Exact reference</h2>
            <dl>
              <dt>Namespace</dt><dd className="is-mono">{entry.namespace}</dd>
              <dt>Name</dt><dd className="is-mono">{entry.name}</dd>
              <dt>Version</dt><dd>{entry.version}</dd>
              <dt>Digest</dt><dd className="is-mono" title={entry.digest}>{shortDigest(entry.digest)}</dd>
              <dt>Visibility</dt><dd><Chip tone={visibility === 'Public' ? 'success' : 'plain'}>{visibility}</Chip></dd>
              <dt>Modes</dt>
              <dd>{entry.modes.length} · {entry.modes.map((item) => `${item.id} (${optionFacts(item).length} option${optionFacts(item).length === 1 ? '' : 's'})`).join(', ') || 'none'}</dd>
            </dl>
            <Button size="sm" variant="secondary" onClick={() => downloadManifest(entry, revision)}>Download manifest</Button>
            <small>Everything in the engine’s manifest is shown on this page; the download is for tools that need the file.</small>
          </section>
          <section aria-label="Your plan" className="engine-detail-plan">
            <h2>Your plan</h2>
            <PlanNote ceilings={ceilings} plan={user?.plan ?? ''} signedIn={Boolean(user)} />
          </section>
        </aside>
      </div>
    </div>
  );
}

function Breadcrumb({ namespace, name }: { namespace: string; name: string }) {
  return (
    <nav aria-label="Breadcrumb" className="engine-detail-crumbs">
      <Link to="/engines">Engines</Link><span aria-hidden="true">/</span>
      <span className="is-mono">{namespace}</span><span aria-hidden="true">/</span>
      <span className="is-mono is-current" aria-current="page">{name}</span>
    </nav>
  );
}

function PlanNote({ ceilings, plan, signedIn }: { ceilings: PlanCeilings | null; plan: string; signedIn: boolean }) {
  const source = ceilings ? `Figures from pricing ${ceilings.version ?? 'as served by the gateway'}.` : 'The pricing document couldn’t be read.';
  const row = ceilings?.plans.find((item) => item.plan === (signedIn ? plan : 'BASIC'));
  if (!ceilings || !row) return <p>{signedIn ? `${plan}: ceilings unavailable.` : 'Ceilings depend on your plan.'} {source}</p>;
  const timeout = row.maxTimeoutSeconds === null ? 'not mapped' : `${row.maxTimeoutSeconds.toLocaleString('en-US')} s`;
  const iterations = row.maxIterations === null ? 'not mapped' : row.maxIterations.toLocaleString('en-US');
  return signedIn
    ? <p>{row.plan}: max timeout {timeout}, max {iterations} iterations per request. {source}</p>
    : <p>Ceilings depend on your plan. {row.plan} allows {timeout} and {iterations} iterations per request. {source}</p>;
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

function ModePanel({ mode, ceilings, loading, failed, plan, signedIn, ownPlan, onPlan, limits }: ModePanelProps) {
  const facts = optionFacts(mode);
  const limitEntries = Object.entries(mode.limits ?? {});
  const termination: string[] = mode.guarantees?.termination ?? [];
  return (
    <>
      <div className="engine-detail-card">
        <div className="engine-detail-card-head">
          <span>Mode · <span className="is-mono">{mode.id}</span></span>
          {ceilings && ceilings.plans.length > 0 ? (
            <label>
              {signedIn && plan === ownPlan ? 'Your plan' : 'Preview plan'}
              <select value={plan} onChange={(event) => onPlan(event.target.value)} aria-label="Plan to preview">
                {ceilings.plans.map((item) => <option key={item.plan} value={item.plan}>{item.plan}</option>)}
              </select>
              <small>(pricing {ceilings.version ?? 'as served'})</small>
            </label>
          ) : (
            <small>{loading ? 'Reading the pricing document…' : failed ? 'The pricing document couldn’t be read, so ceilings are not shown.' : 'No plans in the pricing document.'}</small>
          )}
        </div>
        {facts.length === 0 ? (
          <p className="engine-detail-muted engine-detail-pad">This mode takes no caller options.</p>
        ) : (
          <DataTable label={`Options of mode ${mode.id}`} minWidth={640}>
            <thead>
              <tr>
                <th scope="col">Option</th>
                <th scope="col">Unit</th>
                <th scope="col">Default</th>
                <th scope="col">{signedIn && plan === ownPlan ? 'Your plan’s ceiling' : 'Plan ceiling'}</th>
                <th scope="col">With the default</th>
              </tr>
            </thead>
            <tbody>
              {facts.map((fact) => {
                const preview = previewOption(fact, limits);
                return (
                  <tr key={fact.name}>
                    <td className="is-mono">{preview.name}{preview.required && <small className="engine-detail-required">required</small>}</td>
                    <td>{preview.unit}</td>
                    <td>{preview.default}</td>
                    <td>{preview.ceiling}</td>
                    <td>
                      {preview.outcome.kind === 'clamped'
                        ? <span className="engine-detail-clamp"><AlertTriangle aria-hidden="true" />OPTION_CLAMPED → {preview.outcome.applied}</span>
                        : <span className="engine-detail-fit">{preview.outcome.text}</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </DataTable>
        )}
      </div>
      <p className="engine-detail-muted">
        Time and effort options (<code>time_budget_ms</code>, <code>iterations</code>, <code>max_evaluations</code>) are reduced to the plan’s
        ceiling and the job carries an OPTION_CLAMPED warning; it isn’t an error. Every other option applies as requested.
      </p>

      <section className="engine-detail-card engine-detail-pad" aria-label="Mode contract">
        <h2>Mode contract</h2>
        <dl className="engine-detail-facts">
          <div><dt>Profile</dt><dd className="is-mono">{mode.profile}</dd><small>must match exactly</small></div>
          <div><dt>Output IR</dt><dd className="is-mono">{mode.ir?.apiVersion} · {mode.ir?.kind}</dd><small>must match exactly</small></div>
          <div><dt>Algorithm</dt><dd>{mode.algorithm}</dd><small>does not imply a guarantee</small></div>
          <div><dt>Guarantee</dt><dd>{mode.guarantees?.exact ? 'Exact mode' : 'Heuristic mode'}</dd><small>{termination.join(' · ') || 'No termination declared'}</small></div>
        </dl>
        {limitEntries.length > 0 && (
          <div className="engine-detail-limits">
            <span>Declared ceilings</span>
            {limitEntries.map(([limit, value]) => <Chip key={limit} mono>{limit}: {value.toLocaleString('en-US')}</Chip>)}
          </div>
        )}
      </section>

      <section className="engine-detail-card engine-detail-pad" aria-label="How a run can end">
        <h2>How a run can end</h2>
        <div className="engine-detail-ends">
          {TERMINATIONS.map((item) => (
            <div key={item.id} className={termination.includes(item.id) ? 'is-declared' : undefined}>
              <span className="is-mono">{item.id}</span>
              <p>{item.text}</p>
              {termination.includes(item.id) && <small>Declared by this mode</small>}
            </div>
          ))}
        </div>
        <small className="engine-detail-muted">Which of these this revision can guarantee is part of its contract; the mode declares {termination.length ? termination.join(', ') : 'none'}.</small>
      </section>
    </>
  );
}

function SelectorChip({ selector }: { selector: CapabilitySelector | undefined }) {
  if (!selector) return <span className="engine-detail-muted">Not declared</span>;
  return (
    <span className="engine-detail-selector">
      <Chip tone={selector.selector === 'none' ? 'plain' : 'accent'}>{selector.selector}</Chip>
      {selector.selector === 'only' && <span className="is-mono">{selectorText(selector)}</span>}
    </span>
  );
}

function CapabilitiesPanel({ modes, signedIn }: { modes: EngineMode[]; signedIn: boolean }) {
  return (
    <>
      <DataTable label="Capabilities by dimension" minWidth={modes.length > 1 ? 720 : 480}>
        <thead>
          <tr>
            <th scope="col">Dimension</th>
            {modes.map((mode) => <th key={mode.id} scope="col">Mode {mode.id}</th>)}
          </tr>
        </thead>
        <tbody>
          {DIMENSIONS.map((dimension) => (
            <tr key={dimension.id}>
              <td>{dimension.label}</td>
              {modes.map((mode) => <td key={mode.id}><SelectorChip selector={mode.capabilities?.[dimension.id]} /></td>)}
            </tr>
          ))}
        </tbody>
      </DataTable>
      <Notice tone="info">
        {signedIn
          ? 'Compatibility with your last validated package is checked when you launch a job.'
          : 'Validate a package in the Workbench, then log in to check it against this mode.'}
      </Notice>
      <small className="engine-detail-muted"><code>none</code> rejects the dimension. <code>only</code> names exact values. <code>all</code> is valid only when the Profile closes the vocabulary.</small>
    </>
  );
}

interface RegistrationsPanelProps {
  signedIn: boolean;
  status: 'loading' | 'ready' | 'error';
  own: EngineRegistrationRevision[];
  revision: EngineRevision | null;
  builtin: boolean;
  onRetry: () => void;
}

function RegistrationsPanel({ signedIn, status, own, revision, builtin, onRetry }: RegistrationsPanelProps) {
  if (!signedIn) {
    return (
      <div className="engine-detail-card engine-detail-pad">
        No deployment registrations are listed for this revision. Registrations and their conformance reports appear here for federated
        engines you can access. <Link to="/login">Log in</Link> to see yours.
      </div>
    );
  }
  if (status === 'loading') return <Skeleton variant="panel" />;
  if (status === 'error') {
    return (
      <Notice tone="error" action={<Button size="sm" variant="secondary" onClick={onRetry}>Retry</Button>}>
        Your registrations couldn’t be loaded.
      </Notice>
    );
  }
  const anyActive = own.some((item) => item.active);
  const needsRegistration = own.length > 0 ? !anyActive : revision?.state === 'private';
  return (
    <>
      {needsRegistration && (
        <Notice tone="warning">No active registration. This revision can’t be executed until a deployment registration is active.</Notice>
      )}
      {own.length === 0 && (
        <div className="engine-detail-card engine-detail-pad">
          {builtin
            ? 'No deployment registrations are listed for this revision. Built-in and published engines run without one; registrations and their conformance reports appear here for federated engines you can access.'
            : 'No deployment registrations are listed for this revision.'}
        </div>
      )}
      {own.map((registration) => <RegistrationItem key={bimResourceKey(registration)} registration={registration} />)}
      <Link to="/app/engines/registrations" className="engine-detail-link">Manage your registrations</Link>
    </>
  );
}

function RegistrationItem({ registration }: { registration: EngineRegistrationRevision }) {
  const [open, setOpen] = useState(false);
  const report = useResource<EngineRegistrationReport | null>(
    `report:${bimResourceKey(registration)}:${open}`,
    async () => (open ? apiClient.getEngineRegistrationReport(registration) : null),
  );
  return (
    <section className="engine-detail-card engine-detail-pad" aria-label={`Registration ${registration.name}`}>
      <div className="engine-detail-registration">
        <div>
          <strong className="is-mono">{registration.namespace}/{registration.name}@{registration.version}</strong>
          <small className="is-mono" title={registration.digest}>{shortDigest(registration.digest)}</small>
        </div>
        <Chip tone={registration.status === 'published' ? 'success' : registration.status === 'rejected' ? 'warning' : 'plain'}>{registration.status.replace('_', ' ')}</Chip>
        <Chip tone={registration.active ? 'success' : 'plain'}>{registration.active ? 'active for you' : 'inactive for you'}</Chip>
        <Button size="sm" variant="secondary" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
          {open ? 'Hide conformance report' : 'Show conformance report'}
        </Button>
      </div>
      {open && report.status === 'loading' && <Skeleton variant="tile" />}
      {open && report.status === 'error' && (
        <Notice tone="error" action={<Button size="sm" variant="secondary" onClick={report.reload}>Retry</Button>}>
          {report.error instanceof HttpError && (report.error.status === 404 || report.error.status === 403)
            ? 'No conformance report is visible for this registration.'
            : `The conformance report couldn’t be loaded (${report.error instanceof HttpError ? `HTTP ${report.error.status}` : 'the gateway can’t be reached'}).`}
        </Notice>
      )}
      {open && report.data && <RegistrationReportView registration={report.data} />}
    </section>
  );
}
