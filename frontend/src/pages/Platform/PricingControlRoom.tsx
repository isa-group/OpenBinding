import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ExternalLink, FilePlus, History, RefreshCw } from 'lucide-react';
import { apiClient } from '../../api/client';
import { platformApi, type PricingControlRoom, type PricingRelease } from '../../api/platform';
import { Action } from '../../components/ui/Action';
import { EmptyState } from '../../components/ui/EmptyState';
import { Notice } from '../../components/ui/Notice';
import { Skeleton } from '../../components/ui/Skeleton';
import { config } from '../../config';
import { shortDigest } from '../../utils/digest';
import { formatDate } from '../../utils/format';
import { useResource } from '../../utils/useResource';
import { AdminFrame, AdminOnly, FailureNotice, Tag } from '../Admin/AdminChrome';
import { count, humanize, type ChipTone, type Failure } from '../Admin/adminModel';
import { SPACE_LABEL, SPHERE_LABEL, describePricingFailure } from '../Admin/pricingModel';
import { ConfirmDialog } from '../Engines/EngineDialogs';
import '../Admin/AdminPricing.css';
import './PricingControlRoom.css';

type Service = { enabled: boolean; reachable: boolean };

const releasePath = (version: string) => `/app/admin/pricing/${encodeURIComponent(version)}`;

/** The stages of a version’s life, in order, and which of the versions is in each. */
const STAGES: Array<{ id: string; label: string; where: string; in: (release: PricingRelease) => boolean }> = [
  { id: 'draft', label: 'Private draft', where: 'SPHERE', in: (release) => release.sphere_state === 'PRIVATE_DRAFT' },
  { id: 'release', label: 'Immutable release', where: 'SPHERE', in: (release) => release.sphere_state === 'PUBLIC_RELEASE' },
  { id: 'deployed', label: 'Deployed', where: 'SPACE', in: (release) => release.space_state === 'ACTIVE' },
  { id: 'live', label: 'LIVE', where: 'Gateway', in: (release) => release.is_live },
  { id: 'draining', label: 'Draining', where: 'SPACE', in: (release) => release.space_state === 'DRAINING' },
  { id: 'archived', label: 'Archived', where: 'SPACE', in: (release) => release.space_state === 'ARCHIVED' },
];

function serviceState(service: Service | undefined): { label: string; tone: ChipTone } {
  if (!service) return { label: 'Unknown', tone: 'plain' };
  if (!service.enabled) return { label: 'Not configured', tone: 'plain' };
  return service.reachable ? { label: 'Connected', tone: 'success' } : { label: 'Unavailable', tone: 'error' };
}

function Health({ name, role, service, children }: { name: string; role: string; service: Service | undefined; children?: ReactNode }) {
  const state = serviceState(service);
  return (
    <section className={`apr-health is-${state.tone}`} aria-label={name}>
      <span className="apr-health-head"><strong>{name}</strong><Tag tone={state.tone}>{state.label}</Tag></span>
      <span>{role}</span>
      <span className="adm-muted">Checked by the server. Your browser never connects to it.</span>
      {children}
    </section>
  );
}

function RoomScreen() {
  const room = useResource('admin-pricing-room', () => platformApi.pricingControlRoom());
  const [busy, setBusy] = useState<'sync' | 'contracts' | null>(null);
  const [asking, setAsking] = useState(false);
  const [message, setMessage] = useState<{ tone: 'success' | 'info'; text: string } | null>(null);
  const [counters, setCounters] = useState<Record<string, number> | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);

  const data: PricingControlRoom | undefined = room.data ?? room.stale;
  const loadFailure = room.status === 'error' ? describePricingFailure(room.error, 'The pricing control room couldn’t be loaded') : null;
  const releases = data?.releases ?? [];
  const live = releases.find((release) => release.is_live);
  const differences = (data?.divergence.onlyInSphere.length ?? 0) + (data?.divergence.onlyLocal.length ?? 0);
  const drafts = releases.filter((release) => release.sphere_state === 'PRIVATE_DRAFT').length;

  const sync = async () => {
    setBusy('sync');
    setMessage(null);
    setFailure(null);
    try {
      const result = await platformApi.syncPricing();
      setMessage({
        tone: 'success',
        text: `Metadata synced: ${result.created} new version${result.created === 1 ? '' : 's'} recorded. Only versions, states and fingerprints are stored here; the pricing documents stay in SPHERE.`,
      });
      room.reload();
    } catch (error: unknown) {
      setFailure(describePricingFailure(error, 'Metadata couldn’t be synced'));
    } finally {
      setBusy(null);
    }
  };

  const reconcile = async () => {
    setBusy('contracts');
    setMessage(null);
    setFailure(null);
    setCounters(null);
    try {
      const result = await apiClient.adminReconcileContracts();
      const moved = Object.values(result).reduce((sum, value) => sum + (typeof value === 'number' ? value : 0), 0);
      setCounters(result);
      setMessage({ tone: moved > 0 ? 'success' : 'info', text: moved > 0 ? 'Expired contracts were renewed onto the LIVE pricing. Recorded in the audit log.' : 'Nothing to move: no contract has expired yet. Contracts renew on their own dates.' });
    } catch (error: unknown) {
      setFailure(describePricingFailure(error, 'Contracts weren’t reconciled'));
    } finally {
      setBusy(null);
      setAsking(false);
    }
  };

  return (
    <AdminFrame
      section="pricing"
      trail={[{ label: 'Administration', to: '/app/admin' }, { label: 'Pricing' }]}
      title="Pricing control room"
      lede="Pricing moves through separate stages: a private draft, an immutable release, a deployment, LIVE, then draining and archiving. Each step has its own action and its own conditions."
      actions={(
        <>
          <a href={config.spaceFrontendUrl} target="_blank" rel="noreferrer" className="ui-action is-secondary is-md">
            Open SPACE Console <ExternalLink aria-hidden="true" />
          </a>
          <Action variant="secondary" busy={busy === 'sync'} disabled={busy !== null} onClick={() => void sync()}><RefreshCw aria-hidden="true" />Sync metadata</Action>
          <Action variant="primary" to="/app/admin/pricing/drafts/new"><FilePlus aria-hidden="true" />New draft</Action>
        </>
      )}
    >
      <Notice tone="info" title="LIVE is not a certification">
        LIVE is the version new contracts use. This screen records states and fingerprints; it doesn’t certify that a draft or a release is correct, and the API has no certification step.
      </Notice>

      {message && <Notice tone={message.tone}>{message.text}</Notice>}
      {counters && (
        <dl className="adm-tiles" aria-label="What was moved">
          {Object.entries(counters).filter(([, value]) => typeof value === 'number').map(([name, value]) => <div key={name}><dt>{humanize(name)}</dt><dd>{count(value)}</dd></div>)}
        </dl>
      )}
      {failure && <FailureNotice failure={failure} />}
      {loadFailure && <FailureNotice failure={loadFailure} onRetry={room.reload} />}
      {room.status === 'loading' && !data && <div aria-busy="true" className="adm-skeleton"><span className="sr-only">Loading the pricing control room</span><Skeleton variant="panel" /></div>}

      {data && releases.length === 0 && (
        <EmptyState icon={<History />} title="No releases recorded here yet" dashed action={<Action variant="primary" busy={busy === 'sync'} onClick={() => void sync()}>Sync metadata</Action>}>
          Sync to bring in the versions that exist in SPHERE.
        </EmptyState>
      )}

      {data && (
        <>
          <div className="apr-health-grid">
            <Health name="SPHERE" role="Where drafts and releases are written. OpenBinding / openbinding." service={data.sphere} />
            <Health name="SPACE 1.5" role="Where releases are deployed and contracts are counted." service={data.space}>
              <a href={config.spaceFrontendUrl} target="_blank" rel="noreferrer" className="apr-link" title="Open external SPACE service console">
                Manage in SPACE <ExternalLink aria-hidden="true" />
              </a>
            </Health>
            <section className="apr-live" aria-label="LIVE">
              <span className="apr-health-head"><strong>LIVE</strong>{live && <Tag tone="dark">LIVE</Tag>}</span>
              <strong className="apr-live-version">{data.live ?? 'No release'}</strong>
              <span className="is-mono apr-fingerprint">{live ? shortDigest(live.digest) : '—'}</span>
              <span className="adm-muted">New contracts and renewals use it. How many contracts are pinned to it isn’t reported by the API.</span>
              {data.live && <Link to={releasePath(data.live)} viewTransition>Open {data.live}</Link>}
            </section>
          </div>

          <section className="adm-card" aria-labelledby="apr-pipe-title">
            <h2 id="apr-pipe-title">Lifecycle</h2>
            <ol className="apr-pipeline">
              {STAGES.map((stage) => {
                const inStage = releases.filter(stage.in);
                return (
                  <li key={stage.id} className={`${inStage.length > 0 ? 'has-versions' : ''}${stage.id === 'live' ? ' is-live' : ''}`.trim()} aria-label={stage.label}>
                    <span className="adm-muted">{stage.where}</span>
                    <strong>{stage.label}</strong>
                    <span className="apr-chips">
                      {inStage.map((release) => <Link key={release.id} to={releasePath(release.version)} viewTransition className="apr-version-chip">{release.version}</Link>)}
                      {inStage.length === 0 && <span className="adm-muted">None</span>}
                    </span>
                  </li>
                );
              })}
            </ol>
            <span className="adm-muted">Contracts stay on the version they were made under until they renew; that’s why an old version keeps draining instead of disappearing.</span>
          </section>

          {releases.length > 0 && (
            <section className="adm-card" aria-labelledby="apr-versions-title">
              <div className="adm-card-head">
                <h2 id="apr-versions-title">Versions</h2>
                <span className="adm-muted">{releases.length} recorded · {drafts} private draft{drafts === 1 ? '' : 's'}</span>
              </div>
              <div className="ui-table-wrap" tabIndex={0} role="region" aria-label="Pricing versions">
                <table className="ui-table" style={{ minWidth: 760 }}>
                  <thead>
                    <tr>
                      <th scope="col">Version</th>
                      <th scope="col">In SPHERE</th>
                      <th scope="col">In SPACE</th>
                      <th scope="col">LIVE</th>
                      <th scope="col">Created</th>
                      <th scope="col">Fingerprint</th>
                      <th scope="col"><span className="sr-only">Open</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {releases.map((release) => (
                      <tr key={release.id} aria-label={`Version ${release.version}`}>
                        <td><strong className="is-mono">{release.version}</strong></td>
                        <td><Tag tone={SPHERE_LABEL[release.sphere_state].tone}>{SPHERE_LABEL[release.sphere_state].label}</Tag></td>
                        <td><Tag tone={SPACE_LABEL[release.space_state].tone}>{SPACE_LABEL[release.space_state].label}</Tag></td>
                        <td>{release.is_live ? <Tag tone="dark">LIVE</Tag> : <span className="adm-muted">—</span>}</td>
                        <td>{formatDate(release.created_at) ?? '—'}</td>
                        <td className="is-mono" title={release.digest}>{shortDigest(release.digest)}</td>
                        <td><Link to={releasePath(release.version)} viewTransition aria-label={`Open ${release.version}`}>Open</Link></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <span className="adm-muted">Private drafts have no public address, and none is shown here. Their preview is fetched through the server.</span>
            </section>
          )}

          <div className="adm-grid">
            <section className={`adm-card${differences > 0 ? ' is-warning' : ''}`} aria-labelledby="apr-div-title">
              <h2 id="apr-div-title">SPHERE vs. this database</h2>
              {differences === 0 ? (
                <p className="adm-muted">No differences: every version in SPHERE is recorded here, and nothing here is missing from SPHERE.</p>
              ) : (
                <>
                  {data.divergence.onlyInSphere.length > 0 && <p>In SPHERE but not recorded here: <strong className="is-mono">{data.divergence.onlyInSphere.join(', ')}</strong>. Sync metadata brings them in.</p>}
                  {data.divergence.onlyLocal.length > 0 && <p>Recorded here but not in SPHERE: <strong className="is-mono">{data.divergence.onlyLocal.join(', ')}</strong>.</p>}
                </>
              )}
              <p className="adm-muted">{data.remoteVersions.length} version{data.remoteVersions.length === 1 ? '' : 's'} in SPHERE, {data.remoteVersions.filter((item) => item.private).length} private.</p>
            </section>

            <section className="adm-card" aria-labelledby="apr-contracts-title">
              <h2 id="apr-contracts-title">Expired contracts</h2>
              <p className="adm-muted">Renew expired contracts onto LIVE now instead of waiting for the account’s next request.</p>
              <div className="adm-buttons">
                <Action variant="secondary" busy={busy === 'contracts'} disabled={busy !== null} onClick={() => setAsking(true)}>Move expired contracts to LIVE</Action>
              </div>
            </section>

            <section className="adm-card" aria-labelledby="apr-space-title">
              <h2 id="apr-space-title">SPACE console</h2>
              <p className="adm-muted">An external link to SPACE’s own console. It never carries credentials and doesn’t replace the actions here.</p>
              <span className="is-mono apr-fingerprint">{config.spaceFrontendUrl}</span>
            </section>
          </div>
        </>
      )}

      {asking && (
        <ConfirmDialog
          title="Move expired contracts to LIVE?"
          confirmLabel="Reconcile contracts"
          busy={busy === 'contracts'}
          onConfirm={() => void reconcile()}
          onClose={() => setAsking(false)}
        >
          <p>Every expired contract is renewed now onto LIVE pricing {data?.live ?? ''}. Contracts that haven’t expired are left alone.</p>
        </ConfirmDialog>
      )}
    </AdminFrame>
  );
}

/** admin-pricing: where every pricing version stands, whether SPHERE and SPACE answer, and the way into drafts, releases and LIVE. */
export function PricingControlRoomPage() {
  return <AdminOnly><RoomScreen /></AdminOnly>;
}
