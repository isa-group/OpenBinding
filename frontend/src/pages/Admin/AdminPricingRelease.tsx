import { useId, useMemo, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { Check, Circle, CircleDot, Minus, X } from 'lucide-react';
import { apiClient } from '../../api/client';
import { platformApi, type PricingRelease } from '../../api/platform';
import { Action } from '../../components/ui/Action';
import { EmptyState } from '../../components/ui/EmptyState';
import { Modal } from '../../components/ui/Modal';
import { Notice } from '../../components/ui/Notice';
import { Skeleton } from '../../components/ui/Skeleton';
import { shortDigest } from '../../utils/digest';
import { formatDateTime } from '../../utils/format';
import { useResource } from '../../utils/useResource';
import { ConfirmDialog } from '../Engines/EngineDialogs';
import { ViewSource } from '../Engines/EngineParts';
import { AdminFrame, AdminOnly, FailureNotice, Tag } from './AdminChrome';
import { describeAuditEvent, humanize, type Failure } from './adminModel';
import { ChangeList, PlanCards, PricingPreview } from './PricingParts';
import {
  RELEASE_VERSION, SPACE_LABEL, SPHERE_LABEL, describePricingFailure, diffPricing, lifecycleOf, tryReadPricing,
  type ActionId, type LifecycleAction,
} from './pricingModel';
import './AdminPricing.css';

const releasePath = (version: string) => `/app/admin/pricing/${encodeURIComponent(version)}`;

/** The stages a version has passed or is in, in the order a version moves through them. */
function stagesOf(release: PricingRelease): Array<[string, boolean, boolean]> {
  const draft = release.sphere_state === 'PRIVATE_DRAFT';
  const space = release.space_state;
  return [
    ['Draft', true, false],
    ['Published', !draft, false],
    ['Deployed', space !== 'NOT_DEPLOYED', false],
    ['LIVE', release.is_live, true],
    ['Draining', space === 'DRAINING' || space === 'ARCHIVED', false],
    ['Archived', space === 'ARCHIVED', false],
  ];
}

type Pending = ActionId | null;

function ReleaseScreen() {
  const { version = '' } = useParams<{ version: string }>();
  const navigate = useNavigate();
  // What an action said before it sent us to the version it made, so the new page can still say it.
  const carried = (useLocation().state as { notice?: string } | null)?.notice ?? null;
  const room = useResource('admin-pricing-release-room', () => platformApi.pricingControlRoom());
  const data = room.data ?? room.stale;
  const releases = data?.releases ?? [];
  const release = releases.find((item) => item.version === version);
  const liveVersion = data?.live ?? null;
  const loadFailure = room.status === 'error' ? describePricingFailure(room.error, 'The pricing versions couldn’t be loaded') : null;

  const preview = useResource(`admin-pricing-release-preview:${version}`, async () => ({ source: await platformApi.previewPricing(version) }));
  const compareWith = release && !release.is_live ? liveVersion : null;
  const liveSource = useResource(`admin-pricing-release-live:${compareWith ?? ''}`, async () => (compareWith ? { source: await platformApi.previewPricing(compareWith) } : null));
  const audit = useResource('admin-pricing-release-audit', () => apiClient.adminAudit({ limit: 200 }));

  const [pending, setPending] = useState<Pending>(null);
  const [busy, setBusy] = useState<ActionId | null>(null);
  const [message, setMessage] = useState<string | null>(carried);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [deleted, setDeleted] = useState(false);
  const [typed, setTyped] = useState('');
  const [releaseVersion, setReleaseVersion] = useState('');
  const [forkVersion, setForkVersion] = useState('');
  const [changelog, setChangelog] = useState('');
  const [reason, setReason] = useState('new functionality');
  const [showRenderer, setShowRenderer] = useState(false);
  const typedId = useId();

  const previewFailure = preview.status === 'error' ? describePricingFailure(preview.error, `The content of ${version} couldn’t be loaded`) : null;
  const mismatch = previewFailure?.code === 'pricing_digest_mismatch';
  const doc = useMemo(() => (preview.data ? tryReadPricing(preview.data.source) : null), [preview.data]);
  const liveRead = useMemo(() => {
    const source = liveSource.data?.source;
    return source ? tryReadPricing(source) : null;
  }, [liveSource.data]);
  const changes = useMemo(() => (doc && 'doc' in doc && liveRead && 'doc' in liveRead ? diffPricing(liveRead.doc, doc.doc) : []), [doc, liveRead]);

  const history = (audit.data ?? audit.stale)?.events.filter((event) => {
    if (!event.action.startsWith('pricing.')) return false;
    const detail = event.detail ?? {};
    return event.targetId === version || [detail.version, detail.pricingVersion, detail.draft_version, detail.draftVersion].includes(version);
  }).slice(0, 10) ?? [];

  const actions = release ? lifecycleOf(release) : [];
  const draft = release?.sphere_state === 'PRIVATE_DRAFT';
  const paused = mismatch;

  /** Run one action: the gateway’s own message on success, its refusal (409, 422, 403…) in words otherwise. */
  const run = async (id: ActionId, operation: () => Promise<string | undefined>, done?: (text: string) => void) => {
    setBusy(id);
    setMessage(null);
    setFailure(null);
    try {
      const text = (await operation()) || 'Done. Recorded in the audit log.';
      setMessage(text);
      room.reload();
      audit.reload();
      done?.(text);
    } catch (error: unknown) {
      setFailure(describePricingFailure(error, 'That action couldn’t be applied'));
    } finally {
      setBusy(null);
      setPending(null);
    }
  };

  const confirm = (id: ActionId) => {
    if (!release) return;
    if (id === 'deploy' || id === 'activate' || id === 'drain') void run(id, async () => (await platformApi.pricingAction(release.version, id)).message);
    else if (id === 'archive') void run(id, async () => (await platformApi.archivePricing(release.version)).message);
  };

  const publish = (event: FormEvent) => {
    event.preventDefault();
    if (!release || !RELEASE_VERSION.test(releaseVersion) || changelog.trim() === '') return;
    void run(
      'publish',
      async () => (await platformApi.publishPricing(release.version, releaseVersion, changelog, reason.trim() ? { reason: reason.trim() } : {})).message,
      (text) => navigate(releasePath(releaseVersion), { state: { notice: text } }),
    );
  };

  const fork = (event: FormEvent) => {
    event.preventDefault();
    if (!release || !/^\d+\.\d+\.\d+-draft\.[1-9]\d*$/.test(forkVersion)) return;
    void run('fork', async () => (await platformApi.forkPricing(release.version, forkVersion, changelog)).message, (text) => navigate(releasePath(forkVersion), { state: { notice: text } }));
  };

  const remove = (event: FormEvent) => {
    event.preventDefault();
    if (!release || typed !== release.version) return;
    void run('delete', async () => { await platformApi.deletePricingDraft(release.version); return undefined; }, () => setDeleted(true));
  };

  const open = (id: ActionId) => {
    setTyped('');
    setChangelog('');
    setPending(id);
  };

  const stateChips = release && (
    <>
      <Tag tone={SPHERE_LABEL[release.sphere_state].tone}>{SPHERE_LABEL[release.sphere_state].label}</Tag>
      <Tag tone={SPACE_LABEL[release.space_state].tone}>{SPACE_LABEL[release.space_state].label}</Tag>
      {release.is_live && <Tag tone="dark">LIVE</Tag>}
    </>
  );

  const facts: Array<[string, string, boolean]> = release ? [
    ['Fingerprint', shortDigest(release.digest), true],
    ['In SPHERE', SPHERE_LABEL[release.sphere_state].label, false],
    ['In SPACE', SPACE_LABEL[release.space_state].label, false],
    ['LIVE', release.is_live ? 'Yes' : 'No', false],
    ['Created', formatDateTime(release.created_at) ?? '—', false],
    ['Changelog', release.changelog || 'None recorded', false],
  ] : [];

  return (
    <AdminFrame
      section="pricing"
      trail={[{ label: 'Administration', to: '/app/admin' }, { label: 'Pricing', to: '/app/admin/pricing' }, { label: version, mono: true }]}
      title={`Pricing ${version}`}
      badges={stateChips}
      lede={!release ? undefined : draft
        ? 'A private draft: only administrators can see it, and it has no public address. It isn’t certified, and it can’t be LIVE until it is published as a release.'
        : 'A public, immutable release. Its content can’t change; only where it runs can.'}
      actions={releases.length > 1 ? (
        <label className="adm-select">
          <span className="adm-label">Version</span>
          <select value={version} onChange={(event) => navigate(releasePath(event.target.value))}>
            {!release && <option value={version}>{version}</option>}
            {releases.map((item) => <option key={item.id} value={item.version}>{item.version}</option>)}
          </select>
        </label>
      ) : undefined}
    >
      {message && <Notice tone="success">{message}</Notice>}
      {failure && <FailureNotice failure={failure} />}
      {loadFailure && <FailureNotice failure={loadFailure} onRetry={room.reload} />}
      {room.status === 'loading' && !data && <div aria-busy="true" className="adm-skeleton"><span className="sr-only">Loading the version</span><Skeleton variant="panel" /></div>}

      {deleted && (
        <Notice tone="success" title={`Draft ${version} deleted`} action={<Action size="sm" variant="secondary" to="/app/admin/pricing">Back to the control room</Action>}>
          It was removed from SPHERE. Recorded in the audit log.
        </Notice>
      )}

      {data && !release && !deleted && (
        <EmptyState icon={<Minus />} title={`No version ${version}`} dashed action={<Action variant="secondary" to="/app/admin/pricing">Back to the control room</Action>}>
          The control room doesn’t record a version with this name. Sync metadata there if it exists in SPHERE.
        </EmptyState>
      )}

      {release && (
        <>
          {mismatch && previewFailure && <FailureNotice failure={previewFailure} />}

          <div className="apr-facts" role="list" aria-label="About this version">
            {facts.map(([name, value, mono]) => (
              <div key={name} role="listitem"><span>{name}</span><strong className={mono ? 'is-mono' : undefined} title={name === 'Fingerprint' ? release.digest : undefined}>{value}</strong></div>
            ))}
          </div>

          <section className="adm-card" aria-labelledby="apr-where">
            <h2 id="apr-where">Where this version is</h2>
            <ol className="apr-stages">
              {stagesOf(release).map(([label, on, live]) => (
                <li key={label} aria-label={`${label}, ${on ? 'reached' : 'not reached'}`} className={`${on ? 'is-on' : ''}${on && live ? ' is-live' : ''}`.trim()}>
                  {on ? <CircleDot aria-hidden="true" /> : <Circle aria-hidden="true" />}{label}
                </li>
              ))}
            </ol>
          </section>

          <section className="adm-card" aria-labelledby="apr-preview">
            <div className="adm-card-head">
              <h2 id="apr-preview">Preview</h2>
              <span className="adm-muted">Fetched through the server and not stored</span>
            </div>
            {preview.status === 'loading' && <div aria-busy="true" className="adm-skeleton"><span className="sr-only">Loading the content</span><Skeleton variant="tile" /></div>}
            {previewFailure && !mismatch && <FailureNotice failure={previewFailure} onRetry={preview.reload} />}
            {doc && 'error' in doc && <Notice tone="warning" title="The content couldn’t be shown as plans">{doc.error}</Notice>}
            {doc && 'doc' in doc && <PlanCards doc={doc.doc} />}
            {doc && 'doc' in doc && doc.doc.addOns.length > 0 && (
              <div className="apr-addon-list" role="list" aria-label="Add-ons">
                {doc.doc.addOns.map((addOn) => (
                  <div key={addOn.id} role="listitem">
                    <strong>{humanize(addOn.id)}</strong>
                    <span className="adm-muted">{addOn.description || addOn.unit}</span>
                    <span className="adm-muted">For {addOn.availableFor.join(', ') || 'no plan'} · {addOn.min}–{addOn.max}{addOn.step !== 1 ? ` in steps of ${addOn.step}` : ''}</span>
                  </div>
                ))}
              </div>
            )}
            {preview.data && (
              <div className="adm-buttons">
                <Action size="sm" variant="link" aria-expanded={showRenderer} onClick={() => setShowRenderer((value) => !value)}>{showRenderer ? 'Hide the customer preview' : 'Show the customer preview'}</Action>
              </div>
            )}
            {preview.data && showRenderer && doc && 'doc' in doc && (
              <PricingPreview yaml={preview.data.source} />
            )}
            {preview.data && (
              <details className="eng-source">
                <summary>View source</summary>
                <pre tabIndex={0} aria-label="View source (YAML)"><code>{preview.data.source}</code></pre>
              </details>
            )}
          </section>

          <section className="adm-card" aria-labelledby="apr-compare">
            <h2 id="apr-compare">{release.is_live ? 'Compared with LIVE' : `Compared with LIVE ${liveVersion ?? ''}`.trim()}</h2>
            {release.is_live && <p className="adm-muted">This is the LIVE version, so there is nothing to compare it with.</p>}
            {!release.is_live && liveVersion === null && <p className="adm-muted">No version is LIVE, so there is nothing to compare with.</p>}
            {compareWith && liveSource.status === 'loading' && <p className="adm-muted">Reading the LIVE version…</p>}
            {compareWith && liveSource.status === 'error' && <FailureNotice failure={describePricingFailure(liveSource.error, 'The LIVE version couldn’t be read')} onRetry={liveSource.reload} />}
            {compareWith && liveRead && 'doc' in liveRead && doc && 'doc' in doc && changes.length === 0 && <p className="adm-muted">No difference from the LIVE version.</p>}
            {changes.length > 0 && <ChangeList changes={changes} label={`Changes of ${version} against LIVE`} />}
          </section>

          <section className="adm-card" aria-labelledby="apr-history">
            <h2 id="apr-history">History</h2>
            <dl className="adm-detail">
              <div><dt>Created</dt><dd>{formatDateTime(release.created_at) ?? '—'}</dd></div>
              <div><dt>Last changed</dt><dd>{formatDateTime(release.updated_at) ?? '—'}</dd></div>
              <div><dt>Changelog</dt><dd>{release.changelog || 'None recorded'}</dd></div>
              {Object.entries(release.migration_manifest ?? {}).filter(([, value]) => typeof value === 'string' || typeof value === 'number').map(([key, value]) => (
                <div key={key}><dt>Migration · {humanize(key)}</dt><dd>{String(value)}</dd></div>
              ))}
            </dl>
            <ViewSource value={release.migration_manifest} label="Migration manifest" />
            <h3 className="apr-subhead">Recorded events</h3>
            {audit.status === 'loading' && !audit.stale && <p className="adm-muted">Reading the audit log…</p>}
            {audit.status === 'error' && <p className="adm-muted">The audit log couldn’t be read, so no events are shown. <Action size="sm" variant="link" onClick={audit.reload}>Try again</Action></p>}
            {audit.status !== 'error' && audit.status !== 'loading' && history.length === 0 && <p className="adm-muted">The audit log has no event for this version in its most recent 200.</p>}
            {history.length > 0 && (
              <ul className="adm-recent" aria-label="Events of this version">
                {history.map((event) => (
                  <li key={event.id}><span>{describeAuditEvent(event).text}</span><small>{formatDateTime(event.createdAt) ?? event.createdAt}</small></li>
                ))}
              </ul>
            )}
            <Link to="/app/admin/audit" viewTransition className="apr-link">Open the audit log</Link>
            <h3 className="apr-subhead">All versions</h3>
            <ul className="apr-history" aria-label="All versions">
              {[...releases].sort((a, b) => (a.created_at < b.created_at ? 1 : -1)).map((item) => (
                <li key={item.id} className={item.version === version ? 'is-current' : undefined}>
                  <Link to={releasePath(item.version)} viewTransition aria-current={item.version === version ? 'page' : undefined}><span className="is-mono">{item.version}</span></Link>
                  <Tag tone={SPHERE_LABEL[item.sphere_state].tone}>{SPHERE_LABEL[item.sphere_state].label}</Tag>
                  <Tag tone={SPACE_LABEL[item.space_state].tone}>{SPACE_LABEL[item.space_state].label}</Tag>
                  {item.is_live && <Tag tone="dark">LIVE</Tag>}
                  <small>{formatDateTime(item.created_at) ?? ''}</small>
                </li>
              ))}
            </ul>
          </section>

          <section className="adm-card apr-pinned" aria-labelledby="apr-pinned">
            <h2 id="apr-pinned">Contracts on {version}</h2>
            <p className="adm-muted">
              The API doesn’t report how many contracts are pinned to a version. Contracts keep the version they were made under until they renew, so the gateway refuses to archive
              a version while any contract is still on it (409), and a draft never carries contracts.
            </p>
          </section>

          <section aria-labelledby="apr-actions" className="apr-actions">
            <h2 id="apr-actions">Actions, in order</h2>
            {paused && <Notice tone="warning">Actions are paused until the fingerprint mismatch is resolved.</Notice>}
            <div className="apr-action-grid">
              {actions.map((action) => (
                <ActionCard
                  key={action.id}
                  action={action}
                  busy={busy === action.id}
                  disabled={busy !== null || paused}
                  onRun={() => (action.id === 'delete' ? open('delete') : setPending(action.id))}
                />
              ))}
              {draft && (
                <ExtraCard
                  title="Publish as a release"
                  what="Clones this private draft into a public, immutable release. Publishing doesn’t make it LIVE, and a published version can never be deleted."
                  prerequisites={[['Is a private draft', draft]]}
                  button="Publish…"
                  disabled={busy !== null || paused}
                  onRun={() => open('publish')}
                />
              )}
              <ExtraCard
                title="Fork into a new draft"
                what={`Copies ${version} into a new private draft with its own version. Change its content afterwards by forking that draft again.`}
                prerequisites={[]}
                button="Fork…"
                disabled={busy !== null || paused}
                onRun={() => open('fork')}
              />
            </div>
            <p className="adm-muted">Archiving accepts an optional fallback object whose shape the API doesn’t describe, so this screen doesn’t send one.</p>
          </section>
        </>
      )}

      {pending && release && (pending === 'deploy' || pending === 'activate' || pending === 'drain' || pending === 'archive') && (
        <ConfirmDialog
          title={`${actions.find((action) => action.id === pending)?.label ?? ''} ${release.version}?`}
          tone={pending === 'archive' ? 'warning' : 'default'}
          confirmLabel={actions.find((action) => action.id === pending)?.label ?? 'Confirm'}
          confirmVariant={pending === 'archive' ? 'danger' : 'primary'}
          busy={busy === pending}
          onConfirm={() => confirm(pending)}
          onClose={() => setPending(null)}
        >
          <p>{actions.find((action) => action.id === pending)?.what} Recorded in the audit log.</p>
        </ConfirmDialog>
      )}

      {pending === 'delete' && release && (
        <Modal title={`Delete draft ${release.version}?`} tone="danger" onClose={() => { if (busy === null) setPending(null); }}>
          <form className="adm-confirm" onSubmit={remove}>
            <p>It’s removed from SPHERE permanently, together with its archived copy in SPACE. Releases can never be deleted.</p>
            <label htmlFor={typedId}>Type the version <strong className="is-mono">{release.version}</strong> to confirm</label>
            <input id={typedId} className="eng-dialog-input" value={typed} onChange={(event) => setTyped(event.target.value)} autoComplete="off" spellCheck={false} />
            <div className="ui-modal-actions">
              <Action variant="secondary" onClick={() => setPending(null)} disabled={busy === 'delete'}>Cancel</Action>
              <Action type="submit" variant="danger" busy={busy === 'delete'} disabled={typed !== release.version}>Delete draft</Action>
            </div>
          </form>
        </Modal>
      )}

      {pending === 'publish' && release && (
        <Modal title={`Publish ${release.version} as a release?`} onClose={() => { if (busy === null) setPending(null); }}>
          <form className="adm-confirm" onSubmit={publish}>
            <p>It becomes a public, immutable release. It can never change or be deleted, it isn’t LIVE until you make it so, and publishing doesn’t certify its content.</p>
            <label className="adm-field">
              <span className="adm-label">Release version (X.Y.Z)</span>
              <input value={releaseVersion} onChange={(event) => setReleaseVersion(event.target.value)} placeholder="0.2.0" spellCheck={false} aria-invalid={releaseVersion !== '' && !RELEASE_VERSION.test(releaseVersion) ? true : undefined} />
            </label>
            <label className="adm-field">
              <span className="adm-label">Changelog (required)</span>
              <input value={changelog} onChange={(event) => setChangelog(event.target.value)} maxLength={4000} />
            </label>
            <label className="adm-field">
              <span className="adm-label">Reason for the change</span>
              <input value={reason} onChange={(event) => setReason(event.target.value)} />
            </label>
            <div className="ui-modal-actions">
              <Action variant="secondary" onClick={() => setPending(null)} disabled={busy === 'publish'}>Cancel</Action>
              <Action type="submit" variant="primary" busy={busy === 'publish'} disabled={!RELEASE_VERSION.test(releaseVersion) || changelog.trim() === ''}>Publish release</Action>
            </div>
          </form>
        </Modal>
      )}

      {pending === 'fork' && release && (
        <Modal title={`Fork ${release.version} into a new draft`} onClose={() => { if (busy === null) setPending(null); }}>
          <form className="adm-confirm" onSubmit={fork}>
            <label className="adm-field">
              <span className="adm-label">New draft version (X.Y.Z-draft.N)</span>
              <input value={forkVersion} onChange={(event) => setForkVersion(event.target.value)} placeholder="0.2.0-draft.1" spellCheck={false} />
            </label>
            <label className="adm-field">
              <span className="adm-label">Changelog</span>
              <input value={changelog} onChange={(event) => setChangelog(event.target.value)} maxLength={4000} />
            </label>
            <div className="ui-modal-actions">
              <Action variant="secondary" onClick={() => setPending(null)} disabled={busy === 'fork'}>Cancel</Action>
              <Action type="submit" variant="primary" busy={busy === 'fork'} disabled={!/^\d+\.\d+\.\d+-draft\.[1-9]\d*$/.test(forkVersion)}>Fork draft</Action>
            </div>
          </form>
        </Modal>
      )}
    </AdminFrame>
  );
}

function Prerequisites({ items }: { items: Array<[string, boolean, boolean]> }) {
  return (
    <ul className="apr-prereqs">
      {items.map(([label, met, server]) => (
        <li key={label} className={server ? 'is-server' : met ? 'is-met' : 'is-unmet'}>
          {server ? <Minus aria-hidden="true" /> : met ? <Check aria-hidden="true" /> : <X aria-hidden="true" />}
          <span>{label}<span className="sr-only">{server ? ' (checked by the gateway)' : met ? ' (met)' : ' (not met)'}</span></span>
        </li>
      ))}
    </ul>
  );
}

function ActionCard({ action, busy, disabled, onRun }: { action: LifecycleAction; busy: boolean; disabled: boolean; onRun: () => void }) {
  const destructive = action.id === 'delete';
  return (
    <div className={`apr-action${action.available ? ' is-available' : ''}${destructive ? ' is-danger' : ''}`} role="group" aria-label={action.label}>
      <span className="apr-action-head"><strong>{action.label}</strong><Tag tone={action.available ? 'success' : 'plain'}>{action.available ? 'Available' : 'Not now'}</Tag></span>
      <span>{action.what}</span>
      <Prerequisites items={action.prerequisites.map((item) => [item.label, item.met, item.server === true])} />
      {!action.available && <span className="adm-muted">The gateway would answer {action.refusal}.</span>}
      <Action variant={destructive ? 'danger-outline' : 'primary'} busy={busy} disabled={!action.available || disabled} onClick={onRun}>{action.label}{destructive ? '…' : ''}</Action>
    </div>
  );
}

function ExtraCard({ title, what, prerequisites, button, disabled, onRun }: { title: string; what: string; prerequisites: Array<[string, boolean]>; button: string; disabled: boolean; onRun: () => void }) {
  return (
    <div className="apr-action is-available" role="group" aria-label={title}>
      <span className="apr-action-head"><strong>{title}</strong><Tag tone="success">Available</Tag></span>
      <span>{what}</span>
      {prerequisites.length > 0 && <Prerequisites items={prerequisites.map(([label, met]) => [label, met, false])} />}
      <Action variant="secondary" disabled={disabled} onClick={onRun}>{button}</Action>
    </div>
  );
}

/** admin-pricing-release: one pricing version: what it holds, how it differs from LIVE, its history and the actions its stage allows. */
export function AdminPricingRelease() {
  return <AdminOnly><ReleaseScreen /></AdminOnly>;
}
