// Adapted from SPHERE frontend/src/modules/pricing/pages/card/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: one exact engine registration on the card shell shared with the composition page, as a page of sections instead
// of tabs: the breadcrumb "My engines / name", the version and the Use and Publication pills under the title, the owner's
// actions (activate or deactivate, check again, edit as a new version, launch a run in an organization chosen with SPHERE's
// selector), stat tiles for its use, publication, last check and revisions, the lifecycle stepper, then the sections
// Verification, Deployment, Manifest, Publication and Credential, the other revisions and the Danger zone of SPHERE's
// pricing settings tab (deleting asks for the name). A registration that is missing or that belongs to someone else and is
// not published is the in-place 404; a bare name with several visible revisions asks which one.

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Helmet } from 'react-helmet-async';
import { Link, useLocation, useParams, useSearchParams } from 'react-router-dom';
import { bimResourceKey } from '../../../../api/client';
import { useResource } from '../../../../utils/useResource';
import { HttpError } from '../../../core/api/http';
import type { ImmutableResourceRef } from '../../../core/api/types';
import { Action } from '../../../core/components/action-button';
import BlockAlert from '../../../core/components/block-alert';
import { DataTable } from '../../../core/components/data-table';
import ResourceCardShell, {
  type OverflowAction,
} from '../../../core/components/resource-card-shell';
import PricingCardSkeleton from '../../../core/components/skeletons/pricing-card-skeleton';
import { useCopy } from '../../../core/hooks/useCopy';
import NotFoundPage from '../../../core/pages/page-not-found';
import { useAuth } from '../../../auth/hooks/useAuth';
import { MY_ENGINES_PATH, engineHref, registerEnginePath } from '../../../../routes/paths/engines';
import { launchPath } from '../../../../routes/paths/runs';
import {
  useEnginesApi,
  type EngineRegistrationManifest,
  type EngineRegistrationReport,
  type EngineRegistrationRevision,
  type EnginesApi,
} from '../../api/enginesApi';
import {
  activityOf,
  describeFailure,
  exactReference,
  newVersionHref,
  probeSummary,
  publicationOf,
  publicationStep,
  readDeployment,
  readProbe,
  refFromAddress,
  registrationHref,
  sameRevision,
  type Probe,
} from '../../api/registrationModel';
import { ConfirmDialog, DeregisterDialog } from '../../components/engine-dialogs';
import EngineLaunchModal from '../../components/engine-launch-modal';
import {
  ConformanceChecklist,
  CopyButton,
  ManifestPanel,
  StatusChip,
} from '../../components/engine-parts';
import { CARD, CARD_TITLE, INPUT, MUTED, STACKED } from '../../components/engine-parts/styles';

interface Loaded {
  forUser: string;
  ref: ImmutableResourceRef;
  detail: EngineRegistrationReport;
  manifest: EngineRegistrationManifest | null;
  /** Every revision this account can see under the same namespace and name. */
  revisions: EngineRegistrationRevision[];
}

type Resolved =
  | { kind: 'ready'; data: Loaded }
  | { kind: 'choose'; forUser: string; name: string; options: EngineRegistrationRevision[] };

async function loadRegistration(
  api: EnginesApi,
  username: string,
  name: string,
  addressed: ImmutableResourceRef | null
): Promise<Resolved> {
  const listing = api.listEngineRegistrations().catch((): EngineRegistrationRevision[] => []);
  let found = addressed;
  if (!found) {
    // A bare name: the exact identity is found among the revisions that are visible, if there is only one.
    const options = (await listing).filter(item => item.name === name);
    if (options.length === 0) throw new HttpError(404, 'Engine registration not found');
    if (options.length > 1) return { kind: 'choose', forUser: username, name, options };
    found = options[0];
  }
  const ref = found;
  const [detail, manifest, all] = await Promise.all([
    api.getEngineRegistrationReport(ref),
    api.getEngineRegistration(ref).catch(() => null),
    listing,
  ]);
  return {
    kind: 'ready',
    data: {
      forUser: username,
      ref,
      detail,
      manifest,
      revisions: all.filter(item => item.namespace === ref.namespace && item.name === ref.name),
    },
  };
}

/** A registration the caller may not see answers like one that does not exist. */
function isNeutralNotFound(error: unknown): boolean {
  return error instanceof HttpError && (error.status === 404 || error.status === 403);
}

interface Message {
  tone: 'success' | 'error' | 'warning' | 'info';
  title?: string;
  text: string;
}

type Dialog = 'delete' | 'publish' | 'deactivate';

const STEPS = [
  { label: 'Private', at: 0 },
  { label: 'In review', at: 1 },
  { label: 'Published', at: 2 },
] as const;

function CredentialPanel({
  scheme,
  published,
  busy,
  autoOpen,
  onReplace,
}: {
  scheme: string;
  published: boolean;
  busy: boolean;
  autoOpen: boolean;
  onReplace: (secret: string) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(autoOpen);
  const [secret, setSecret] = useState('');
  const anchor = useRef<HTMLElement>(null);

  useEffect(() => {
    if (autoOpen) anchor.current?.scrollIntoView?.({ block: 'start' });
  }, [autoOpen]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!secret) return;
    const replaced = await onReplace(secret);
    // What was typed is never kept: not after it is sent, and not after it was refused.
    setSecret('');
    if (replaced) setOpen(false);
  };

  return (
    <section id="credential" ref={anchor} className={CARD} aria-labelledby="reg-credential-title">
      <h2 id="reg-credential-title" className={CARD_TITLE}>
        Credential
      </h2>
      {scheme === 'none' ? (
        <p className={MUTED}>
          This deployment is an open endpoint, so OpenBinding sends no sign-in and there is nothing
          to store.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3 rounded-lg bg-tp-surface px-3 py-2.5 text-sm text-tp-slate">
            <span aria-hidden="true" className="font-mono tracking-widest text-tp-steel">
              ••••••••••••
            </span>
            <span className="min-w-0 flex-1">
              The credential is stored encrypted. Nobody can read it back: not you, not support, not
              this page.
            </span>
          </div>
          {published && (
            <p className={MUTED}>
              Published registrations can’t be changed. Register a new version to use another
              credential.
            </p>
          )}
          {!open && (
            <Action
              variant="secondary"
              className="self-start"
              disabled={published || busy}
              onClick={() => setOpen(true)}
            >
              Replace credential
            </Action>
          )}
          {open && (
            <form className="flex flex-col gap-3" onSubmit={event => void submit(event)}>
              <label className={STACKED}>
                <span>
                  {scheme === 'basic' ? 'New username and password (user:password)' : 'New token'}
                </span>
                <input
                  type="password"
                  className={`${INPUT} font-mono`}
                  value={secret}
                  onChange={event => setSecret(event.target.value)}
                  autoComplete="new-password"
                  spellCheck={false}
                  placeholder="Paste it here; it won’t be shown"
                />
              </label>
              <p className={MUTED}>
                The old one stops being used as soon as you save. The registration becomes private
                and inactive until it passes its check again.
              </p>
              <div className="flex flex-wrap gap-2">
                <Action
                  variant="secondary"
                  onClick={() => {
                    setOpen(false);
                    setSecret('');
                  }}
                  disabled={busy}
                >
                  Cancel
                </Action>
                <Action type="submit" variant="primary" busy={busy} disabled={!secret}>
                  Save new credential
                </Action>
              </div>
            </form>
          )}
        </>
      )}
    </section>
  );
}

function RevisionHistory({
  current,
  revisions,
}: {
  current: ImmutableResourceRef;
  revisions: EngineRegistrationRevision[];
}) {
  const others = revisions.filter(item => !sameRevision(item, current));
  return (
    <section className={CARD} aria-labelledby="reg-history-title">
      <h2 id="reg-history-title" className={CARD_TITLE}>
        Other revisions
      </h2>
      {others.length === 0 ? (
        <p className={MUTED}>
          This is the only revision of {current.namespace}/{current.name} you can see. A new version
          is a new registration; it appears here once registered.
        </p>
      ) : (
        <DataTable label="Other revisions of this registration" minWidth={560}>
          <thead>
            <tr>
              <th scope="col">Version</th>
              <th scope="col">Use</th>
              <th scope="col">Publication</th>
              <th scope="col">
                <span className="sr-only">Open</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {others.map(item => (
              <tr key={bimResourceKey(item)}>
                <td>{item.version}</td>
                <td>
                  <StatusChip tone={activityOf(item).tone}>{activityOf(item).label}</StatusChip>
                </td>
                <td>
                  <StatusChip tone={publicationOf(item.status).tone}>
                    {publicationOf(item.status).label}
                  </StatusChip>
                </td>
                <td>
                  <Link
                    to={registrationHref(item)}
                    aria-label={`Open ${item.name} ${item.version}`}
                    className="cursor-pointer text-tp-link hover:underline"
                  >
                    Open
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}
    </section>
  );
}

/** Where the registration is in its life: its use, and the way from Private to Published. */
function LifecycleStepper({ active, step }: { active: boolean; step: number }) {
  return (
    <section className={CARD} aria-labelledby="reg-life-title">
      <h2 id="reg-life-title" className={CARD_TITLE}>
        Where it is in its life
      </h2>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="w-24 text-xs font-medium text-tp-steel">Use</span>
        <StatusChip tone={active ? 'plain' : 'info'}>Inactive</StatusChip>
        <StatusChip tone={active ? 'info' : 'plain'}>Active</StatusChip>
      </div>
      <ol className="flex flex-wrap items-center gap-2 text-sm" aria-label="Publication">
        <li className="w-24 text-xs font-medium text-tp-steel">Publication</li>
        {STEPS.map(item => {
          const current = item.at === step;
          const done = item.at < step;
          return (
            <li key={item.label} className="flex items-center gap-2">
              <span
                className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium ${
                  current
                    ? 'border-tp-primary bg-tp-primary text-tp-on-primary'
                    : done
                      ? 'border-tp-severity-success-border bg-tp-severity-success-bg text-tp-success-text'
                      : 'border-tp-hairline text-tp-steel'
                }`}
                aria-current={current ? 'step' : undefined}
              >
                <span aria-hidden="true">{done ? '✓' : current ? '●' : '○'}</span>
                {item.label}
              </span>
              {item.at < 2 && (
                <span aria-hidden="true" className="text-tp-muted">
                  →
                </span>
              )}
            </li>
          );
        })}
        <li className={MUTED}>A rejected request returns to Private</li>
      </ol>
    </section>
  );
}

/**
 * `/me/engines/:name`: one exact registration (the rest of its identity in the query), readable, with what its owner can
 * do with it.
 */
export default function RegistrationPage() {
  const { name = '' } = useParams();
  const [params] = useSearchParams();
  const { hash } = useLocation();
  const api = useEnginesApi();
  const { user } = useAuth();
  const username = user?.username ?? '';
  const addressed = refFromAddress(name, params);
  const { copy, status: copyStatus } = useCopy();
  const [message, setMessage] = useState<Message | null>(null);
  const [busy, setBusy] = useState('');
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [failedProbe, setFailedProbe] = useState<Probe | null>(null);
  const [deleted, setDeleted] = useState(false);
  const [launching, setLaunching] = useState(false);

  const resource = useResource(`registration:${username}:${name}?${params.toString()}`, () =>
    loadRegistration(api, username, name, addressed)
  );
  const kept = resource.stale;
  const keptReady =
    kept?.kind === 'ready' &&
    kept.data.forUser === username &&
    kept.data.ref.name === name &&
    (!addressed || sameRevision(kept.data.ref, addressed))
      ? kept
      : undefined;
  const resolved = resource.data ?? keptReady;
  const failure = resource.status === 'error' ? resource.error : null;

  if (resolved?.kind === 'choose') {
    return (
      <div className="mx-auto max-w-3xl px-4 py-8">
        <Helmet>
          <title>OpenBinding - {resolved.name}</title>
        </Helmet>
        <nav aria-label="Breadcrumb" className="mb-2 flex items-center gap-2 text-xs text-tp-steel">
          <Link to={MY_ENGINES_PATH} className="cursor-pointer hover:text-tp-ink">
            My engines
          </Link>
          <span aria-hidden="true">/</span>
          <span className="font-mono text-tp-ink" aria-current="page">
            {resolved.name}
          </span>
        </nav>
        <section className={CARD} aria-labelledby="reg-choose-title">
          <h1 id="reg-choose-title" className="font-display text-2xl text-tp-ink">
            Which revision of {resolved.name}?
          </h1>
          <p className={MUTED}>
            More than one registration is called {resolved.name}. Pick the exact one.
          </p>
          <ul className="flex flex-col divide-y divide-tp-hairline-soft">
            {resolved.options.map(item => (
              <li key={bimResourceKey(item)} className="flex flex-wrap items-center gap-2 py-2">
                <Link
                  to={registrationHref(item)}
                  className="mr-auto cursor-pointer font-mono text-sm text-tp-link hover:underline"
                >
                  {item.namespace}/{item.name}@{item.version}
                </Link>
                <StatusChip tone={publicationOf(item.status).tone}>
                  {publicationOf(item.status).label}
                </StatusChip>
              </li>
            ))}
          </ul>
        </section>
      </div>
    );
  }

  if (!resolved) {
    if (isNeutralNotFound(failure)) return <NotFoundPage />;
    if (resource.status !== 'error') return <PricingCardSkeleton />;
    const unauthorized = failure instanceof HttpError && failure.status === 401;
    return (
      <div className="mx-auto max-w-7xl px-4 py-16 text-center md:px-8">
        <div
          role="alert"
          className="mx-auto max-w-md rounded-xl border border-red-200 bg-red-50 p-6"
        >
          <p className="text-sm font-medium text-red-800">
            {unauthorized ? 'Your session ended (401)' : 'The registration couldn’t be loaded.'}
          </p>
          <p className="mt-1 text-xs text-red-700">
            {unauthorized
              ? 'Log in again to see this registration.'
              : `${failure instanceof HttpError ? `The gateway answered HTTP ${failure.status}.` : 'The gateway can’t be reached.'} This says nothing about your access.`}
          </p>
          {unauthorized ? (
            <Link
              to="/authentication"
              className="mt-4 inline-block cursor-pointer rounded-lg border border-red-300 bg-tp-canvas px-4 py-1.5 text-xs font-medium text-red-800 hover:bg-red-100"
            >
              Log in
            </Link>
          ) : (
            <button
              type="button"
              onClick={resource.reload}
              className="mt-4 cursor-pointer rounded-lg border border-red-300 bg-tp-canvas px-4 py-1.5 text-xs font-medium text-red-800 hover:bg-red-100"
            >
              Retry
            </button>
          )}
        </div>
      </div>
    );
  }

  const { data } = resolved;
  const { ref, detail, manifest, revisions } = data;
  const owner = ref.namespace === username;
  const published = detail.status === 'published';
  const publication = publicationOf(detail.status);
  const activity = activityOf(detail);
  const probe = failedProbe ?? readProbe(detail.report);
  const deployment = readDeployment(manifest, detail.openapi, detail.openapiDigest);
  const engineRef = manifest?.spec?.engine ?? null;
  const step = publicationStep(detail.status);
  const refreshFailed = resource.status === 'error';

  const refuse = (error: unknown, fallback: string) => {
    const refused = describeFailure(error, fallback);
    setFailedProbe(refused.probe);
    setMessage({
      tone: refused.tone,
      title: refused.title,
      text: [refused.text, ...refused.details].join(' '),
    });
    return refused;
  };

  const run = async (
    label: string,
    task: () => Promise<unknown>,
    success: string
  ): Promise<boolean> => {
    setBusy(label);
    setMessage(null);
    try {
      await task();
      setMessage({ tone: 'success', text: success });
      setFailedProbe(null);
      resource.reload();
      return true;
    } catch (error: unknown) {
      // A refused activation leaves the registration inactive with a new report: read it again.
      if (refuse(error, 'The change was refused').probe) resource.reload();
      return false;
    } finally {
      setBusy('');
    }
  };

  const activate = () =>
    run(
      'activate',
      () => api.activateEngineRegistration(ref),
      `${ref.name} passed its check and is active for you.`
    );
  const deactivate = () =>
    run(
      'deactivate',
      () => api.deactivateEngineRegistration(ref),
      'Deactivated. You can’t pick it for new runs until you activate it again.'
    );
  const checkAgain = () =>
    void run(
      'check',
      () => api.activateEngineRegistration(ref),
      'Checked again. The deployment still passes.'
    );

  const toggle = () => {
    if (!detail.active) void activate();
    else if (published) setDialog('deactivate');
    else void deactivate();
  };

  const askPublication = () => {
    if (!detail.active) {
      setMessage({
        tone: 'warning',
        title: 'Activate it first',
        text: 'Activate it before requesting publication. Activation re-checks your deployment.',
      });
      return;
    }
    setDialog('publish');
  };

  const confirmDialog = async () => {
    if (dialog === 'publish')
      await run(
        'publish',
        () => api.requestEngineRegistrationPublication(ref),
        'Publication requested. An administrator will review it.'
      );
    if (dialog === 'deactivate') await deactivate();
    if (dialog === 'delete') {
      const removed = await run(
        'delete',
        () => api.deleteEngineRegistration(ref),
        `Deleted ${ref.name} ${ref.version}.`
      );
      if (removed) setDeleted(true);
    }
    setDialog(null);
  };

  const replaceCredential = (secret: string) =>
    run(
      'credential',
      () => api.setEngineRegistrationCredential(ref, secret),
      'Credential replaced. The old one is no longer used; the registration is private and inactive until it passes its check again.'
    );

  const crumbs = [
    { label: 'My engines', to: MY_ENGINES_PATH },
    { label: `${ref.name} ${ref.version}` },
  ];

  if (deleted) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-8">
        <Helmet>
          <title>OpenBinding - {ref.name}</title>
        </Helmet>
        <div role="status" className={`${CARD} items-start`}>
          <strong className="text-base font-semibold text-tp-ink">
            This registration was deleted
          </strong>
          <span className="text-sm text-tp-slate">
            Its slot is free. You can register the engine again any time.
          </span>
          <span className="flex flex-wrap gap-2">
            <Action to={registerEnginePath()} variant="primary">
              Register an engine
            </Action>
            <Action to={MY_ENGINES_PATH} variant="secondary">
              Back to My engines
            </Action>
          </span>
        </div>
      </div>
    );
  }

  const intro = owner
    ? `Your deployment of the ${engineRef?.name ?? ref.name} engine. Only you can use it${published ? '; it’s also published, so everyone can pick it.' : detail.status === 'pending_review' ? '; publication is waiting for review.' : '.'}`
    : `Published by ${ref.namespace}. You can pick it when launching a run.`;

  const subtitle = (
    <>
      <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-tp-steel">
        <span className="rounded-lg border border-tp-input-border bg-tp-input-bg px-2 py-1 font-mono text-xs font-medium text-tp-ink">
          {ref.version}
        </span>
        <StatusChip tone={activity.tone}>{activity.label}</StatusChip>
        <StatusChip tone={publication.tone}>{publication.label}</StatusChip>
        <span className="font-mono text-xs">{ref.namespace}</span>
      </div>
      <p className="mt-2 max-w-2xl text-sm text-tp-slate">{intro}</p>
    </>
  );

  const actionClass =
    'flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border border-tp-input-border bg-tp-input-bg px-3 text-xs text-tp-ink transition-colors hover:bg-tp-surface focus:border-tp-primary focus:outline-none disabled:cursor-not-allowed disabled:opacity-50';
  const overflow: OverflowAction[] = [
    ...(owner && detail.active ? [{ label: 'Check again', onSelect: checkAgain }] : []),
    ...(owner ? [{ label: 'Edit as a new version', to: newVersionHref(ref) }] : []),
    ...(engineRef ? [{ label: 'Launch a run with it', onSelect: () => setLaunching(true) }] : []),
  ];
  const summary = probeSummary(probe);

  return (
    <>
      <Helmet>
        <title>
          OpenBinding - {ref.name} {ref.version}
        </title>
      </Helmet>
      <ResourceCardShell
        crumbs={crumbs}
        title={ref.name}
        subtitle={subtitle}
        actions={
          <>
            {owner && detail.active && (
              <button
                type="button"
                className={actionClass}
                disabled={busy === 'check'}
                onClick={checkAgain}
              >
                {busy === 'check' ? 'Checking…' : 'Check again'}
              </button>
            )}
            {owner && (
              <Link to={newVersionHref(ref)} className={actionClass}>
                Edit as a new version
              </Link>
            )}
            {engineRef && (
              <button type="button" className={actionClass} onClick={() => setLaunching(true)}>
                Launch a run with it
              </button>
            )}
          </>
        }
        primaryAction={
          owner ? (
            <Action
              size="sm"
              variant={detail.active ? 'secondary' : 'primary'}
              busy={busy === 'activate' || busy === 'deactivate'}
              onClick={toggle}
            >
              {detail.active ? 'Deactivate' : 'Activate'}
            </Action>
          ) : undefined
        }
        overflow={overflow}
        stats={[
          { label: 'Use', value: activity.label },
          { label: 'Publication', value: publication.label },
          { label: 'Last check', value: summary.label },
          { label: 'Revisions', value: Math.max(1, revisions.length) },
        ]}
        tabs={[]}
        activeTab="sections"
        tabsLabel="Registration sections"
      >
        <div className="flex flex-col gap-4">
          {message && (
            <BlockAlert variant={message.tone} onDismiss={() => setMessage(null)}>
              <div className="min-w-0">
                {message.title && <p className="font-medium">{message.title}</p>}
                <p>{message.text}</p>
              </div>
            </BlockAlert>
          )}
          {refreshFailed && (
            <BlockAlert variant="error">
              The registration couldn’t be refreshed
              {failure instanceof HttpError ? ` (HTTP ${failure.status})` : ''}. You’re seeing the
              last copy loaded.{' '}
              <button
                type="button"
                onClick={resource.reload}
                className="cursor-pointer font-medium underline"
              >
                Retry
              </button>
            </BlockAlert>
          )}

          <LifecycleStepper active={detail.active} step={step} />

          <section className={CARD} aria-labelledby="reg-identity-title">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 id="reg-identity-title" className={CARD_TITLE}>
                Exact identity
              </h2>
              <button
                type="button"
                className="cursor-pointer text-xs font-medium text-tp-link hover:underline"
                onClick={() => void copy(exactReference(ref))}
              >
                {copyStatus() === 'copied'
                  ? 'Reference copied'
                  : copyStatus() === 'failed'
                    ? 'Copy failed'
                    : 'Copy exact reference'}
              </button>
            </div>
            <dl className="grid gap-2 text-sm sm:grid-cols-3">
              {(
                [
                  ['Namespace', ref.namespace],
                  ['Name', ref.name],
                  ['Version', ref.version],
                ] as const
              ).map(([label, value]) => (
                <div key={label} className="flex flex-col gap-0.5 rounded-lg bg-tp-surface p-3">
                  <dt className="text-[11px] text-tp-steel">{label}</dt>
                  <dd className="font-mono [overflow-wrap:anywhere] text-tp-ink">{value}</dd>
                </div>
              ))}
            </dl>
            <p className={MUTED}>
              These three together name this deployment exactly. A new version is a new
              registration.
              {engineRef && (
                <>
                  {' '}
                  Engine revision:{' '}
                  <Link
                    to={engineHref(engineRef)}
                    className="cursor-pointer text-tp-link hover:underline"
                  >
                    see it in the catalog
                  </Link>
                  .
                </>
              )}
            </p>
          </section>

          <section className={CARD} aria-labelledby="reg-probe-title">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 id="reg-probe-title" className={CARD_TITLE}>
                Verification
              </h2>
              {probe.protocol && <span className={MUTED}>Protocol {probe.protocol}</span>}
            </div>
            <ConformanceChecklist
              probe={probe}
              failedText={
                failedProbe
                  ? 'A check failed. Nothing was activated; the registration itself is unchanged.'
                  : 'The last check did not pass.'
              }
              pendingText={
                owner
                  ? 'It has not been checked yet. Activating it runs the check against your deployment.'
                  : 'It has not been checked yet.'
              }
            />
          </section>

          <section className={CARD} aria-labelledby="reg-deploy-title">
            <h2 id="reg-deploy-title" className={CARD_TITLE}>
              Deployment
            </h2>
            <dl className="grid gap-2 text-sm sm:grid-cols-2">
              {(
                [
                  ['Endpoint', deployment.endpoint ?? 'Not shown', true],
                  ['Sign-in', deployment.auth, false],
                  ['Protocol', deployment.protocol ?? '—', true],
                  [
                    'Contract',
                    `${
                      deployment.contractTitle
                        ? `${deployment.contractTitle} ${deployment.contractVersion ?? ''}`.trim()
                        : '—'
                    }${
                      deployment.contractPaths !== null
                        ? ` · ${deployment.contractPaths} path${deployment.contractPaths === 1 ? '' : 's'}`
                        : ''
                    }`,
                    false,
                  ],
                ] as const
              ).map(([label, value, mono]) => (
                <div key={label} className="flex flex-col gap-0.5 rounded-lg bg-tp-surface p-3">
                  <dt className="text-[11px] text-tp-steel">{label}</dt>
                  <dd className={`[overflow-wrap:anywhere] text-tp-ink ${mono ? 'font-mono' : ''}`}>
                    {value}
                  </dd>
                </div>
              ))}
            </dl>
            {deployment.mappings.length > 0 && (
              <ul
                className="flex flex-col divide-y divide-tp-hairline-soft rounded-lg border border-tp-hairline"
                aria-label="Paths on the deployment"
              >
                {deployment.mappings.map(item => (
                  <li
                    key={item.id}
                    className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm"
                  >
                    <span className="text-tp-slate">{item.label}</span>
                    <code className="font-mono text-xs text-tp-ink">{item.path}</code>
                  </li>
                ))}
              </ul>
            )}
            {deployment.contractDigest && (
              <div className="flex flex-wrap items-center gap-3 text-sm text-tp-slate">
                <span>Pinned contract</span>
                <CopyButton value={deployment.contractDigest} label="contract fingerprint" />
              </div>
            )}
            {!manifest && (
              <p className={MUTED}>
                The registration manifest couldn’t be read, so the endpoint and paths aren’t shown.
              </p>
            )}
          </section>

          <section className={CARD} aria-labelledby="reg-manifest-title">
            <h2 id="reg-manifest-title" className={CARD_TITLE}>
              Manifest
            </h2>
            {detail.engine ? (
              <ManifestPanel document={detail.engine} />
            ) : (
              <p className={MUTED}>
                The gateway didn’t return the engine manifest for this registration.
              </p>
            )}
          </section>

          {owner && (
            <section
              className={`${CARD} sm:flex-row sm:items-center sm:justify-between`}
              aria-labelledby="reg-pub-title"
            >
              <div className="min-w-0 flex-1">
                <h2 id="reg-pub-title" className={CARD_TITLE}>
                  Publication
                </h2>
                <p className="mt-1 text-sm text-tp-slate">
                  {published
                    ? 'Published. Everyone can pick it when launching a run. It can no longer be changed.'
                    : detail.status === 'pending_review'
                      ? 'Waiting for an administrator’s review. It stays private until then.'
                      : detail.status === 'rejected'
                        ? 'A reviewer rejected your last request, so it’s private again. You can ask again.'
                        : 'Ask an administrator to review it so everyone can use it. It must be active, and your account or key must be allowed to publish engines.'}
                </p>
              </div>
              {(detail.status === 'private' || detail.status === 'rejected') && (
                <Action variant="primary" busy={busy === 'publish'} onClick={askPublication}>
                  Request publication
                </Action>
              )}
            </section>
          )}

          {owner && (
            <CredentialPanel
              scheme={deployment.authScheme}
              published={published}
              busy={busy === 'credential'}
              autoOpen={hash === '#credential'}
              onReplace={replaceCredential}
            />
          )}

          <RevisionHistory current={ref} revisions={revisions} />

          {owner && (
            <section aria-labelledby="reg-danger-title" className="mt-2">
              <h2 id="reg-danger-title" className="mb-2 text-sm font-medium text-red-700">
                Danger Zone
              </h2>
              <div className="rounded-lg border border-red-500 p-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p id="reg-delete-title" className="text-sm font-medium text-tp-ink">
                      Delete this registration
                    </p>
                    <p className="mt-1 text-xs text-tp-steel">
                      {published
                        ? 'This registration is published, so others may depend on it. Administrators are told when you delete it.'
                        : 'Removes this deployment and its stored credential. It can’t be undone.'}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setDialog('delete')}
                    className="shrink-0 cursor-pointer rounded-md border border-red-600 px-4 py-2 text-sm font-bold text-red-700 hover:bg-red-600 hover:text-white"
                  >
                    Delete
                  </button>
                </div>
              </div>
            </section>
          )}
        </div>
      </ResourceCardShell>

      {launching && engineRef && (
        <EngineLaunchModal
          title="Launch a run with it"
          actionLabel="Launch a run"
          noun="run"
          destination={org => launchPath(org, { engine: bimResourceKey(engineRef) })}
          onClose={() => setLaunching(false)}
        />
      )}
      {dialog === 'publish' && (
        <ConfirmDialog
          title={`Request publication of ${ref.name}?`}
          confirmLabel="Request publication"
          busy={busy === 'publish'}
          onConfirm={() => void confirmDialog()}
          onClose={() => setDialog(null)}
        >
          <p>
            Administrators will then be able to discover and review this exact revision. It stays
            private until they approve it.
          </p>
        </ConfirmDialog>
      )}
      {dialog === 'deactivate' && (
        <ConfirmDialog
          title={`Deactivate ${ref.name}?`}
          tone="warning"
          confirmLabel="Deactivate"
          busy={busy === 'deactivate'}
          onConfirm={() => void confirmDialog()}
          onClose={() => setDialog(null)}
        >
          <p>
            It is published, so other people may be using it. Deactivating pauses it for everyone;
            its publication state doesn’t change. Administrators are told.
          </p>
        </ConfirmDialog>
      )}
      {dialog === 'delete' && (
        <DeregisterDialog
          name={ref.name}
          version={ref.version}
          published={published}
          busy={busy === 'delete'}
          onConfirm={() => void confirmDialog()}
          onClose={() => setDialog(null)}
        />
      )}
    </>
  );
}
