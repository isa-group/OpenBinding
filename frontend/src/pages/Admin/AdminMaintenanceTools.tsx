import { useId, useState, type FormEvent } from 'react';
import { Trash2 } from 'lucide-react';
import { apiClient } from '../../api/client';
import { Action } from '../../components/ui/Action';
import { Modal } from '../../components/ui/Modal';
import { Notice } from '../../components/ui/Notice';
import { formatDate } from '../../utils/format';
import { useResource } from '../../utils/useResource';
import { FailureNotice, Tag } from './AdminChrome';
import { count, describeAdminFailure } from './adminModel';

const CONFIRMATION = 'PURGE EXPIRED';

/**
 * What maintenance would touch, and the two actions on it: settle abandoned jobs, and purge expired data after typing
 * the confirmation the gateway demands. The preview is what a purge is limited to.
 */
export function AdminMaintenanceTools() {
  const [days, setDays] = useState(365);
  const [busy, setBusy] = useState<'reconcile' | 'purge' | null>(null);
  const [asking, setAsking] = useState(false);
  const [typed, setTyped] = useState('');
  const [message, setMessage] = useState<{ tone: 'success' | 'error' | 'warning'; title?: string; text: string } | null>(null);
  const typedId = useId();
  const valid = Number.isInteger(days) && days >= 7 && days <= 3650;

  const preview = useResource(`admin-maintenance:${valid ? days : 'invalid'}`, async () => (valid ? apiClient.adminMaintenancePreview(days) : null));
  const data = preview.data ?? preview.stale;
  const failure = preview.status === 'error' ? describeAdminFailure(preview.error, 'The maintenance preview couldn’t be calculated') : null;

  const reconcile = async () => {
    setBusy('reconcile');
    setMessage(null);
    try {
      const result = await apiClient.adminReconcileJobs();
      setMessage({ tone: 'success', text: `${result.settled} abandoned job${result.settled === 1 ? '' : 's'} reconciled.` });
      preview.reload();
    } catch (error: unknown) {
      const refused = describeAdminFailure(error, 'Job reconciliation failed');
      setMessage({ tone: refused.tone, title: refused.title, text: `${refused.text} Inspect the worker and SPACE health before retrying.` });
    } finally {
      setBusy(null);
    }
  };

  const purge = async (event: FormEvent) => {
    event.preventDefault();
    if (typed !== CONFIRMATION) return;
    setBusy('purge');
    setMessage(null);
    try {
      const result = await apiClient.adminPurgeExpired(typed, days);
      setMessage({ tone: 'success', text: `Purged ${result.artifacts ?? 0} artifacts, ${result.apiKeys ?? 0} keys and ${result.jobs ?? 0} jobs.` });
      setAsking(false);
      setTyped('');
      preview.reload();
    } catch (error: unknown) {
      const refused = describeAdminFailure(error, 'Expired data was not purged');
      setMessage({ tone: refused.tone, title: refused.title, text: `${refused.text} Run the preview again and check the audit log.` });
      setAsking(false);
    } finally {
      setBusy(null);
    }
  };

  const tiles: Array<[string, number | undefined]> = [
    ['Expired artifacts', data?.expiredArtifacts],
    ['Expired API keys', data?.expiredApiKeys],
    ['Terminal jobs', data?.terminalJobs],
    ['Abandoned jobs', data?.abandonedJobs],
  ];

  return (
    <section className="adm-card" aria-labelledby="adm-maintenance-title">
      <div className="adm-card-head">
        <h2 id="adm-maintenance-title">Maintenance</h2>
        <span className="adm-muted">Cutoff {data ? formatDate(data.terminalJobCutoff) ?? '—' : '—'}</span>
      </div>
      <p className="adm-muted">Preview first, then act. A purge removes only what the preview counts; the audit log stays.</p>

      {message && <Notice tone={message.tone} title={message.title}>{message.text}</Notice>}
      {failure && <FailureNotice failure={failure} onRetry={preview.reload} />}

      <dl className="adm-tiles" aria-label="Maintenance preview">
        {tiles.map(([label, value]) => (
          <div key={label}><dt>{label}</dt><dd>{count(value)}</dd></div>
        ))}
      </dl>

      <label className="adm-field adm-retention">
        <span className="adm-label">Terminal job retention (days)</span>
        <input type="number" min={7} max={3650} value={Number.isNaN(days) ? '' : days} onChange={(event) => setDays(event.target.valueAsNumber)} aria-invalid={!valid || undefined} />
      </label>
      {!valid && <span className="adm-muted">Retention is between 7 and 3,650 days.</span>}

      <div className="adm-buttons">
        <Action variant="secondary" busy={busy === 'reconcile'} onClick={() => void reconcile()}>Reconcile abandoned jobs</Action>
        <Action variant="danger-outline" disabled={!valid || busy !== null} onClick={() => setAsking(true)}><Trash2 aria-hidden="true" />Purge expired data</Action>
        <Tag tone={data && data.abandonedJobs > 0 ? 'warning' : 'plain'}>{data ? `${data.abandonedJobs} abandoned` : '…'}</Tag>
      </div>

      {asking && (
        <Modal title="Purge expired data?" tone="danger" onClose={() => { setAsking(false); setTyped(''); }}>
          <form className="adm-confirm" onSubmit={(event) => void purge(event)}>
            <p>
              This permanently removes expired artifacts, expired API keys and finished jobs older than {days} days. Only the items in the latest preview are
              eligible. Audit records remain.
            </p>
            <label htmlFor={typedId}>Type <strong className="is-mono">{CONFIRMATION}</strong> to confirm</label>
            <input id={typedId} className="eng-dialog-input" value={typed} onChange={(event) => setTyped(event.target.value)} autoComplete="off" spellCheck={false} />
            <div className="ui-modal-actions">
              <Action variant="secondary" onClick={() => { setAsking(false); setTyped(''); }}>Cancel</Action>
              <Action type="submit" variant="danger" busy={busy === 'purge'} disabled={typed !== CONFIRMATION}>Confirm purge</Action>
            </div>
          </form>
        </Modal>
      )}
    </section>
  );
}
