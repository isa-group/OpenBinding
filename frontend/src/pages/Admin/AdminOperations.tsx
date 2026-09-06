import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Activity, Database, ExternalLink, HardDrive, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import { apiClient } from '../../api/client';
import type { AdminAuditPage, AdminOverview, AdminQueueStatus, MaintenancePreview } from '../../api/auth';
import { Alert } from '../../components/ui/Alert';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';

export function AdminOperations() {
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [queues, setQueues] = useState<AdminQueueStatus | null>(null);
  const [audit, setAudit] = useState<AdminAuditPage | null>(null);
  const [maintenance, setMaintenance] = useState<MaintenancePreview | null>(null);
  const [retentionDays, setRetentionDays] = useState(365);
  const [busy, setBusy] = useState<string | null>(null);
  const [showPurge, setShowPurge] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [nextOverview, nextQueues, nextAudit, nextMaintenance] = await Promise.allSettled([
      apiClient.adminOverview(),
      apiClient.adminQueues(),
      apiClient.adminAudit(),
      apiClient.adminMaintenancePreview(retentionDays),
    ]);
    if (nextOverview.status === 'fulfilled') setOverview(nextOverview.value);
    if (nextQueues.status === 'fulfilled') setQueues(nextQueues.value);
    if (nextAudit.status === 'fulfilled') setAudit(nextAudit.value);
    if (nextMaintenance.status === 'fulfilled') setMaintenance(nextMaintenance.value);
    setError([nextOverview, nextQueues, nextAudit, nextMaintenance].some((result) => result.status === 'rejected')
      ? 'Some operational signals are unavailable. No maintenance action was run.' : null);
  }, [retentionDays]);

  useEffect(() => { void load(); }, [load]);

  const reconcile = async () => {
    setBusy('reconcile'); setNotice(null); setError(null);
    try {
      const result = await apiClient.adminReconcileJobs();
      setNotice(`${result.settled} abandoned job${result.settled === 1 ? '' : 's'} reconciled.`);
      await load();
    } catch { setError('Job reconciliation failed. Inspect the worker and SPACE health before retrying.'); }
    finally { setBusy(null); }
  };

  const purge = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const confirmation = String(new FormData(event.currentTarget).get('confirmation') || '');
    if (confirmation !== 'PURGE EXPIRED') {
      setError('Type PURGE EXPIRED exactly. Nothing was removed.');
      return;
    }
    setBusy('purge'); setNotice(null); setError(null);
    try {
      const result = await apiClient.adminPurgeExpired(confirmation, retentionDays);
      setNotice(`Purged ${result.artifacts ?? 0} artifacts, ${result.apiKeys ?? 0} keys and ${result.jobs ?? 0} jobs.`);
      setShowPurge(false);
      await load();
    } catch { setError('Expired data was not purged. Re-run the preview and check the audit log.'); }
    finally { setBusy(null); }
  };

  const queueTotal = Object.values(queues?.counts ?? {}).reduce((sum, value) => sum + value, 0);

  return <section className="admin-operations" aria-labelledby="operations-title">
    <div className="admin-section-heading">
      <div><span>Control plane</span><h2 id="operations-title">Platform operations</h2></div>
      <Button size="sm" variant="ghost" onClick={() => void load()}><RefreshCw aria-hidden="true" /> Refresh signals</Button>
    </div>
    {error && <Alert type="warning">{error}</Alert>}
    {notice && <Alert type="success">{notice}</Alert>}

    <div className="admin-signal-grid">
      <article><Database aria-hidden="true" /><span>Domain records</span><strong>{overview ? (overview.counts.projects ?? 0) + (overview.counts.cases ?? 0) + (overview.counts.studies ?? 0) : '—'}</strong><small>projects · cases · studies</small></article>
      <article><Activity aria-hidden="true" /><span>Queue ledger</span><strong>{queues ? queueTotal : '—'}</strong><small>{queues?.counts.running ?? 0} running · {queues?.counts.queued ?? 0} queued</small></article>
      <article><ShieldCheck aria-hidden="true" /><span>Organizations</span><strong>{overview?.counts.organizations ?? '—'}</strong><small>{overview?.counts.memberships ?? 0} direct memberships</small></article>
      <article><HardDrive aria-hidden="true" /><span>Stored evidence</span><strong>{overview?.counts.artifacts ?? '—'}</strong><small>{overview?.counts.caseRevisions ?? 0} immutable case revisions</small></article>
    </div>

    <div className="admin-operations-grid">
      <article className="admin-queue-panel">
        <header><div><span>Durable queue</span><h3>Oldest work in flight</h3></div><Badge variant={queues?.oldestInFlight.length ? 'warning' : 'success'}>{queues?.oldestInFlight.length ?? 0} visible</Badge></header>
        <div className="admin-mini-ledger">
          {queues?.oldestInFlight.slice(0, 6).map((job) => <div key={job.id}><span className={`run-state is-${job.state}`}>{job.state}</span><strong>{job.engine}</strong><code>{job.id.slice(0, 12)}…</code><small>{new Date(job.createdAt).toLocaleString()}</small></div>)}
          {queues && !queues.oldestInFlight.length && <p className="admin-empty">No queued or running jobs.</p>}
        </div>
      </article>

      <article className="admin-maintenance-panel">
        <header><div><span>Safe maintenance</span><h3>Preview before mutation</h3></div><small>Cutoff {maintenance ? new Date(maintenance.terminalJobCutoff).toLocaleDateString() : '—'}</small></header>
        <dl>
          <div><dt>Expired artifacts</dt><dd>{maintenance?.expiredArtifacts ?? '—'}</dd></div>
          <div><dt>Expired API keys</dt><dd>{maintenance?.expiredApiKeys ?? '—'}</dd></div>
          <div><dt>Terminal jobs</dt><dd>{maintenance?.terminalJobs ?? '—'}</dd></div>
          <div><dt>Abandoned jobs</dt><dd>{maintenance?.abandonedJobs ?? '—'}</dd></div>
        </dl>
        <label className="maintenance-retention">Terminal job retention<input type="number" min="7" max="3650" value={retentionDays} onChange={(event) => setRetentionDays(Number(event.target.value))} /><span>days</span></label>
        <div className="maintenance-actions"><Button size="sm" variant="secondary" onClick={() => void reconcile()} disabled={busy === 'reconcile'}>{busy === 'reconcile' ? 'Reconciling…' : 'Reconcile abandoned jobs'}</Button><Button size="sm" variant="ghost" onClick={() => setShowPurge((value) => !value)}><Trash2 aria-hidden="true" /> Purge expired data</Button></div>
        {showPurge && <form className="maintenance-confirm" onSubmit={purge}><label>Type PURGE EXPIRED<input name="confirmation" autoComplete="off" required /></label><p>Only the items in the latest preview are eligible. Audit records remain.</p><div><Button type="button" size="sm" variant="ghost" onClick={() => setShowPurge(false)}>Cancel</Button><Button type="submit" size="sm" variant="secondary" disabled={busy === 'purge'}>{busy === 'purge' ? 'Purging…' : 'Confirm purge'}</Button></div></form>}
      </article>

      <article className="admin-audit-panel">
        <header><div><span>Append-only audit</span><h3>Recent operator events</h3></div><small>{audit?.total ?? 0} total</small></header>
        <div className="admin-audit-ledger">{audit?.events.slice(0, 8).map((event) => <div key={event.id}><span>{event.action}</span><strong>{event.targetType}</strong><code>{event.targetId?.slice(0, 12) ?? 'platform'}</code><small>{new Date(event.createdAt).toLocaleString()}</small></div>)}{audit && !audit.events.length && <p className="admin-empty">No audit events yet.</p>}</div>
      </article>

      <article className="admin-system-links">
        <header><div><span>External control</span><h3>Pricing & emergency access</h3></div></header>
        <Link to="/app/admin/pricing">Open SPHERE / SPACE control room <ExternalLink aria-hidden="true" /></Link>
        <p>Direct database tools are intentionally absent from this browser. Adminer or pgAdmin is available only through the loopback-bound local Docker profile.</p>
      </article>
    </div>
  </section>;
}
