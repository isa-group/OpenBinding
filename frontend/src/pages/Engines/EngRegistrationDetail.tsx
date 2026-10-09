import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useLocation, useParams, useSearchParams } from 'react-router-dom';
import {
  apiClient, bimResourceKey, HttpError,
  type BimResourceRef, type EngineRegistrationManifest, type EngineRegistrationReport, type EngineRegistrationRevision,
} from '../../api/client';
import { Action } from '../../components/ui/Action';
import { CopyField } from '../../components/ui/CopyField';
import { DataTable } from '../../components/ui/DataTable';
import { ErrorState, StateAction } from '../../components/ui/ErrorState';
import { Notice, type NoticeTone } from '../../components/ui/Notice';
import { ProjectPicker } from '../../components/ui/ProjectPicker';
import { Skeleton } from '../../components/ui/Skeleton';
import { useCopy } from '../../components/ui/useCopy';
import { useAuth } from '../../contexts/auth';
import { shortDigest } from '../../utils/digest';
import { useResource } from '../../utils/useResource';
import { ConfirmDialog, DeregisterDialog } from './EngineDialogs';
import { ConformanceChecklist, Crumbs, ManifestPanel, StatusChip } from './EngineParts';
import {
  activityOf, describeFailure, exactReference, newVersionHref, publicationOf, publicationStep, readDeployment, readProbe,
  refFromAddress, registrationHref, sameRevision,
  type Probe,
} from './registrationModel';
import './Registrations.css';

interface Loaded {
  forUser: string;
  ref: BimResourceRef;
  detail: EngineRegistrationReport;
  manifest: EngineRegistrationManifest | null;
  /** Every revision this account can see under the same namespace and name. */
  revisions: EngineRegistrationRevision[];
}

type Resolved =
  | { kind: 'ready'; data: Loaded }
  | { kind: 'choose'; forUser: string; name: string; options: EngineRegistrationRevision[] };

async function loadRegistration(username: string, name: string, addressed: BimResourceRef | null): Promise<Resolved> {
  const listing = apiClient.listEngineRegistrations().catch((): EngineRegistrationRevision[] => []);
  let found = addressed;
  if (!found) {
    // A bare name: the exact identity is found among the revisions that are visible, if there is only one.
    const options = (await listing).filter((item) => item.name === name);
    if (options.length === 0) throw new HttpError(404, 'Engine registration not found');
    if (options.length > 1) return { kind: 'choose', forUser: username, name, options };
    found = options[0];
  }
  const ref = found;
  const [detail, manifest, all] = await Promise.all([
    apiClient.getEngineRegistrationReport(ref),
    apiClient.getEngineRegistration(ref).catch(() => null),
    listing,
  ]);
  return {
    kind: 'ready',
    data: { forUser: username, ref, detail, manifest, revisions: all.filter((item) => item.namespace === ref.namespace && item.name === ref.name) },
  };
}

/** A registration the caller may not see answers like one that does not exist. */
function isNeutralNotFound(error: unknown): boolean {
  return error instanceof HttpError && (error.status === 404 || error.status === 403);
}

interface Message {
  tone: NoticeTone;
  title?: string;
  text: string;
}

type Dialog = 'delete' | 'publish' | 'deactivate';

const STEPS = [
  { label: 'Private', at: 0 },
  { label: 'Waiting for review', at: 1 },
  { label: 'Published', at: 2 },
] as const;

function CredentialPanel({ scheme, published, busy, autoOpen, onReplace }: {
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
    <section id="credential" ref={anchor} className="reg-card" aria-labelledby="reg-credential-title">
      <h2 id="reg-credential-title">Credential</h2>
      {scheme === 'none' ? (
        <div className="reg-secret">
          <span className="eng-muted">This deployment is an open endpoint, so OpenBinding sends no sign-in and there is nothing to store.</span>
        </div>
      ) : (
        <>
          <div className="reg-secret">
            <span aria-hidden="true" className="reg-dots">••••••••••••</span>
            <span>The credential is stored encrypted. Nobody can read it back: not you, not support, not this page.</span>
          </div>
          {published && <span className="eng-muted">Published registrations can’t be changed. Register a new version to use another credential.</span>}
          {!open && (
            <Action variant="secondary" className="reg-self-start" disabled={published || busy} onClick={() => setOpen(true)}>Replace credential</Action>
          )}
          {open && (
            <form className="reg-credential-form" onSubmit={(event) => void submit(event)}>
              <label>
                <span>{scheme === 'basic' ? 'New username and password (user:password)' : 'New token'}</span>
                <input
                  type="password"
                  value={secret}
                  onChange={(event) => setSecret(event.target.value)}
                  autoComplete="new-password"
                  spellCheck={false}
                  placeholder="Paste it here; it won’t be shown"
                />
              </label>
              <span className="eng-muted">
                The old one stops being used as soon as you save. The registration becomes private and inactive until it passes its check again.
              </span>
              <div className="reg-form-actions">
                <Action variant="secondary" onClick={() => { setOpen(false); setSecret(''); }} disabled={busy}>Cancel</Action>
                <Action type="submit" variant="primary" busy={busy} disabled={!secret}>Save new credential</Action>
              </div>
            </form>
          )}
        </>
      )}
    </section>
  );
}

function RevisionHistory({ current, revisions }: { current: BimResourceRef; revisions: EngineRegistrationRevision[] }) {
  const others = revisions.filter((item) => !sameRevision(item, current));
  return (
    <section className="reg-card" aria-labelledby="reg-history-title">
      <h2 id="reg-history-title">Other revisions</h2>
      {others.length === 0 ? (
        <span className="eng-muted">This is the only revision of {current.namespace}/{current.name} you can see. A new version is a new registration; it appears here once registered.</span>
      ) : (
        <DataTable label="Other revisions of this registration" minWidth={560}>
          <thead>
            <tr><th scope="col">Version</th><th scope="col">Fingerprint</th><th scope="col">Use</th><th scope="col">Publication</th><th scope="col"><span className="sr-only">Open</span></th></tr>
          </thead>
          <tbody>
            {others.map((item) => (
              <tr key={bimResourceKey(item)}>
                <td>{item.version}</td>
                <td className="is-mono" title={item.digest}>{shortDigest(item.digest)}</td>
                <td><StatusChip tone={activityOf(item).tone}>{activityOf(item).label}</StatusChip></td>
                <td><StatusChip tone={publicationOf(item.status).tone}>{publicationOf(item.status).label}</StatusChip></td>
                <td><Link to={registrationHref(item)} aria-label={`Open ${item.name} ${item.version}`}>Open</Link></td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}
    </section>
  );
}

/** eng-registration-detail: one exact registration, readable, with what its owner can do with it. */
export function EngRegistrationDetail() {
  const { name = '' } = useParams();
  const [params] = useSearchParams();
  const { hash } = useLocation();
  const { user } = useAuth();
  const username = user?.username ?? '';
  const addressed = refFromAddress(name, params);
  const { copy, status: copyStatus } = useCopy();
  const [message, setMessage] = useState<Message | null>(null);
  const [busy, setBusy] = useState('');
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [failedProbe, setFailedProbe] = useState<Probe | null>(null);
  const [deleted, setDeleted] = useState(false);

  const resource = useResource(`registration:${username}:${name}?${params.toString()}`, () => loadRegistration(username, name, addressed));
  const kept = resource.stale;
  const keptReady = kept?.kind === 'ready' && kept.data.forUser === username && kept.data.ref.name === name
    && (!addressed || sameRevision(kept.data.ref, addressed)) ? kept : undefined;
  const resolved = resource.data ?? keptReady;
  const failure = resource.status === 'error' ? resource.error : null;

  if (resolved?.kind === 'choose') {
    return (
      <div className="reg-page">
        <Crumbs items={[{ label: 'Home', to: '/app' }, { label: 'My engines', to: '/app/engines/registrations' }, { label: resolved.name, mono: true }]} />
        <section className="reg-card" aria-labelledby="reg-choose-title">
          <h1 id="reg-choose-title" className="reg-h1">Which revision of {resolved.name}?</h1>
          <p className="eng-muted">More than one registration is called {resolved.name}. Pick the exact one.</p>
          <ul className="reg-choices">
            {resolved.options.map((item) => (
              <li key={bimResourceKey(item)}>
                <Link to={registrationHref(item)}>{item.namespace}/{item.name}@{item.version}</Link>
                <span className="is-mono" title={item.digest}>{shortDigest(item.digest)}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    );
  }

  if (!resolved) {
    const crumbs = [{ label: 'Home', to: '/app' }, { label: 'My engines', to: '/app/engines/registrations' }, { label: name, mono: true }];
    if (isNeutralNotFound(failure)) {
      return (
        <div className="reg-page">
          <Crumbs items={crumbs} />
          <ErrorState
            variant="404"
            layout="card"
            title="Not found"
            code="not_found"
            actions={<StateAction tone="primary" to="/app/engines/registrations">Back to My engines</StateAction>}
          >
            There’s no registration with this exact identity that you can see. Private registrations only open for their owner; everyone else, administrators included, gets this same answer.
          </ErrorState>
        </div>
      );
    }
    if (failure instanceof HttpError && failure.status === 401) {
      return <div className="reg-page"><Crumbs items={crumbs} /><ErrorState variant="401" layout="card" /></div>;
    }
    return (
      <div className="reg-page">
        <Crumbs items={crumbs} />
        {resource.status === 'error' ? (
          <Notice tone="error" action={<Action size="sm" variant="secondary" onClick={resource.reload}>Retry</Action>}>
            The registration couldn’t be loaded ({failure instanceof HttpError ? `HTTP ${failure.status}` : 'the gateway can’t be reached'}).
          </Notice>
        ) : (
          <div className="reg-skeleton" aria-busy="true" aria-live="polite">
            <h1 className="sr-only">Loading registration</h1>
            <Skeleton variant="panel" /><Skeleton variant="tile" /><Skeleton variant="panel" />
          </div>
        )}
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
    setMessage({ tone: refused.tone, title: refused.title, text: [refused.text, ...refused.details].join(' ') });
    return refused;
  };

  const run = async (label: string, task: () => Promise<unknown>, success: string): Promise<boolean> => {
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

  const activate = () => run('activate', () => apiClient.activateEngineRegistration(ref), `${ref.name} passed its check and is active for you.`);
  const deactivate = () => run('deactivate', () => apiClient.deactivateEngineRegistration(ref), 'Deactivated. You can’t pick it for new jobs until you activate it again.');

  const toggle = () => {
    if (!detail.active) void activate();
    else if (published) setDialog('deactivate');
    else void deactivate();
  };

  const askPublication = () => {
    if (!detail.active) {
      setMessage({ tone: 'warning', title: 'Activate it first', text: 'Activate it before requesting publication. Activation re-checks your deployment.' });
      return;
    }
    setDialog('publish');
  };

  const confirmDialog = async () => {
    if (dialog === 'publish') await run('publish', () => apiClient.requestEngineRegistrationPublication(ref), 'Publication requested. An administrator will review it.');
    if (dialog === 'deactivate') await deactivate();
    if (dialog === 'delete') {
      const removed = await run('delete', () => apiClient.deleteEngineRegistration(ref), `Deleted ${ref.name} ${ref.version}.`);
      if (removed) setDeleted(true);
    }
    setDialog(null);
  };

  const replaceCredential = (secret: string) => run(
    'credential',
    () => apiClient.setEngineRegistrationCredential(ref, secret),
    'Credential replaced. The old one is no longer used; the registration is private and inactive until it passes its check again.',
  );

  const crumbs = [{ label: 'Home', to: '/app' }, { label: 'My engines', to: '/app/engines/registrations' }, { label: `${ref.name} ${ref.version}`, mono: true }];

  if (deleted) {
    return (
      <div className="reg-page">
        <Crumbs items={crumbs} />
        <div className="reg-deleted" role="status">
          <strong>This registration was deleted</strong>
          <span>Its slot is free. You can register the engine again any time.</span>
          <span className="reg-form-actions">
            <Action to="/app/engines/new" variant="primary">Register an engine</Action>
            <Action to="/app/engines/registrations" variant="secondary">Back to My engines</Action>
          </span>
        </div>
      </div>
    );
  }

  const intro = owner
    ? `Your deployment of the ${engineRef?.name ?? ref.name} engine. Only you can use it${published ? '; it’s also published, so everyone can pick it.' : detail.status === 'pending_review' ? '; publication is waiting for review.' : '.'}`
    : `Published by ${ref.namespace}. You can pick it when launching a job.`;

  return (
    <div className="reg-page">
      <Crumbs items={crumbs} />

      <header className="reg-header">
        <div className="reg-title">
          <span className="reg-kicker">Engine registration</span>
          <div className="reg-title-line">
            <h1 className="reg-h1">{ref.name}</h1>
            <span className="reg-version-big">{ref.version}</span>
            <StatusChip tone={activity.tone}>{activity.label}</StatusChip>
            <StatusChip tone={publication.tone}>{publication.label}</StatusChip>
          </div>
          <p>{intro}</p>
        </div>
        <div className="reg-header-actions">
          {owner && (
            <Action variant={detail.active ? 'secondary' : 'primary'} busy={busy === 'activate' || busy === 'deactivate'} onClick={toggle}>
              {detail.active ? 'Deactivate' : 'Activate'}
            </Action>
          )}
          {owner && detail.active && (
            <Action variant="secondary" busy={busy === 'check'} onClick={() => void run('check', () => apiClient.activateEngineRegistration(ref), 'Checked again. The deployment still passes.')}>
              Check again
            </Action>
          )}
          {owner && <Action to={newVersionHref(ref)} variant="secondary">Edit as a new version</Action>}
          {engineRef && (
            <ProjectPicker
              label="Launch a job with it"
              destination={(org, project) => `/app/${org}/${project}/jobs/new?engine=${encodeURIComponent(bimResourceKey(engineRef))}`}
            />
          )}
        </div>
      </header>

      {message && <Notice tone={message.tone} title={message.title}>{message.text}</Notice>}
      {refreshFailed && (
        <Notice tone="error" action={<Action size="sm" variant="secondary" onClick={resource.reload}>Retry</Action>}>
          The registration couldn’t be refreshed{failure instanceof HttpError ? ` (HTTP ${failure.status})` : ''}. You’re seeing the last copy loaded.
        </Notice>
      )}

      <section className="reg-card" aria-labelledby="reg-identity-title">
        <div className="reg-card-head">
          <h2 id="reg-identity-title">Exact identity</h2>
          <button type="button" className="reg-text-button" onClick={() => void copy(exactReference(ref))}>
            {copyStatus() === 'copied' ? 'Reference copied' : copyStatus() === 'failed' ? 'Copy failed' : 'Copy exact reference'}
          </button>
        </div>
        <dl className="reg-ident">
          <div><dt>Namespace</dt><dd className="is-mono">{ref.namespace}</dd></div>
          <div><dt>Name</dt><dd className="is-mono">{ref.name}</dd></div>
          <div><dt>Version</dt><dd className="is-mono">{ref.version}</dd></div>
          <div><dt>Fingerprint</dt><dd className="is-mono" title={ref.digest}>{shortDigest(ref.digest)}</dd></div>
        </dl>
        <span className="eng-muted">
          These four together name this deployment exactly. A new version is a new registration.
          {engineRef && <> Engine revision: <Link to={`/engines/${encodeURIComponent(engineRef.namespace)}/${encodeURIComponent(engineRef.name)}/${encodeURIComponent(engineRef.version)}`}>see it in the catalog</Link>.</>}
        </span>
      </section>

      <section className="reg-card" aria-labelledby="reg-life-title">
        <h2 id="reg-life-title">Where it is in its life</h2>
        <div className="reg-track">
          <span className="reg-track-label">Use</span>
          <StatusChip tone={detail.active ? 'plain' : 'info'}>Inactive</StatusChip>
          <StatusChip tone={detail.active ? 'info' : 'plain'}>Active</StatusChip>
        </div>
        <ol className="reg-track" aria-label="Publication">
          <li className="reg-track-label">Publication</li>
          {STEPS.map((item) => (
            <li key={item.label} className="reg-track-step">
              <span className={`reg-step${item.at === step ? ' is-current' : item.at < step ? ' is-done' : ''}`} aria-current={item.at === step ? 'step' : undefined}>
                <span aria-hidden="true">{item.at < step ? '✓' : item.at === step ? '●' : '○'}</span> {item.label}
              </span>
              {item.at < 2 && <span aria-hidden="true" className="reg-arrow">→</span>}
            </li>
          ))}
          <li className="eng-muted">A rejected request returns to Private</li>
        </ol>
      </section>

      <div className="reg-two">
        <section className="reg-card" aria-labelledby="reg-probe-title">
          <div className="reg-card-head">
            <h2 id="reg-probe-title">Last verification</h2>
            {probe.protocol && <span className="eng-muted">Protocol {probe.protocol}{probe.protocolDigest ? ` · fingerprint ${shortDigest(probe.protocolDigest)}` : ''}</span>}
          </div>
          <ConformanceChecklist
            probe={probe}
            failedText={failedProbe ? 'A check failed. Nothing was activated; the registration itself is unchanged.' : 'The last check did not pass.'}
            pendingText={owner ? 'It has not been checked yet. Activating it runs the check against your deployment.' : 'It has not been checked yet.'}
          />
        </section>
        {owner && (
          <CredentialPanel
            scheme={deployment.authScheme}
            published={published}
            busy={busy === 'credential'}
            autoOpen={hash === '#credential'}
            onReplace={replaceCredential}
          />
        )}
      </div>

      <section className="reg-card" aria-labelledby="reg-deploy-title">
        <h2 id="reg-deploy-title">Deployment</h2>
        <dl className="reg-ident">
          <div><dt>Endpoint</dt><dd className="is-mono">{deployment.endpoint ?? 'Not shown'}</dd></div>
          <div><dt>Sign-in</dt><dd>{deployment.auth}</dd></div>
          <div><dt>Protocol</dt><dd className="is-mono">{deployment.protocol ?? '—'}</dd></div>
          <div>
            <dt>Contract</dt>
            <dd>{deployment.contractTitle ? `${deployment.contractTitle} ${deployment.contractVersion ?? ''}`.trim() : '—'}{deployment.contractPaths !== null ? ` · ${deployment.contractPaths} path${deployment.contractPaths === 1 ? '' : 's'}` : ''}</dd>
          </div>
        </dl>
        {deployment.mappings.length > 0 && (
          <ul className="reg-paths" aria-label="Paths on the deployment">
            {deployment.mappings.map((item) => <li key={item.id}><span>{item.label}</span><code>{item.path}</code></li>)}
          </ul>
        )}
        {deployment.contractDigest && (
          <div className="reg-digest"><span>Pinned contract fingerprint</span><CopyField value={deployment.contractDigest} label="contract fingerprint" truncate /></div>
        )}
        {!manifest && <span className="eng-muted">The registration manifest couldn’t be read, so the endpoint and paths aren’t shown.</span>}
      </section>

      <section className="reg-card" aria-labelledby="reg-manifest-title">
        <h2 id="reg-manifest-title">Engine manifest</h2>
        {detail.engine ? <ManifestPanel document={detail.engine} /> : <span className="eng-muted">The gateway didn’t return the engine manifest for this registration.</span>}
      </section>

      <RevisionHistory current={ref} revisions={revisions} />

      {owner && (
        <>
          <section className="reg-card reg-row" aria-labelledby="reg-pub-title">
            <div className="reg-grow">
              <h2 id="reg-pub-title">Publication</h2>
              <p>
                {published
                  ? 'Published. Everyone can pick it when launching a job. It can no longer be changed.'
                  : detail.status === 'pending_review'
                    ? 'Waiting for an administrator’s review. It stays private until then.'
                    : detail.status === 'rejected'
                      ? 'A reviewer rejected your last request, so it’s private again. You can ask again.'
                      : 'Ask an administrator to review it so everyone can use it. It must be active, and your account or key must be allowed to publish engines.'}
              </p>
            </div>
            {(detail.status === 'private' || detail.status === 'rejected') && (
              <Action variant="primary" busy={busy === 'publish'} onClick={askPublication}>Request publication</Action>
            )}
          </section>

          <section className="reg-card reg-row reg-danger" aria-labelledby="reg-delete-title">
            <div className="reg-grow">
              <h2 id="reg-delete-title">Delete this registration</h2>
              <p>
                {published
                  ? 'This registration is published, so others may depend on it. Administrators are told when you delete it.'
                  : 'Removes this deployment and its stored credential. It can’t be undone.'}
              </p>
            </div>
            <Action variant="danger-outline" onClick={() => setDialog('delete')}>Delete</Action>
          </section>
        </>
      )}

      {dialog === 'publish' && (
        <ConfirmDialog
          title={`Request publication of ${ref.name}?`}
          confirmLabel="Request publication"
          busy={busy === 'publish'}
          onConfirm={() => void confirmDialog()}
          onClose={() => setDialog(null)}
        >
          <p>Administrators will then be able to discover and review this exact revision. It stays private until they approve it.</p>
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
          <p>It is published, so other people may be using it. Deactivating pauses it for everyone; its publication state doesn’t change. Administrators are told.</p>
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
    </div>
  );
}
