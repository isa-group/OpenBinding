import { useId, useState, type FormEvent } from 'react';
import { Trash2 } from 'lucide-react';
import { apiClient } from '../../api/client';
import { Action } from '../../components/ui/Action';
import { Modal } from '../../components/ui/Modal';
import { Notice } from '../../components/ui/Notice';
import { formatDate } from '../../utils/format';
import { useResource } from '../../utils/useResource';
import { FailureNotice, Tag } from './AdminChrome';
import { count, describeAdminFailure, humanize, type Failure } from './adminModel';

const CONFIRMATION = 'PURGE EXPIRED';
const DEFAULT_RETENTION = 365;
const DEFAULT_ERROR_RETENTION = 90;

type Message = { tone: 'success' | 'info' | 'error' | 'warning'; title?: string; text: string };

/** Maintenance refuses with 409 while another run holds the work, and with 503 when the database or SPACE doesn’t answer. */
function maintenanceFailure(error: unknown, what: string): Failure {
  const base = describeAdminFailure(error, what);
  if (base.status === 409) {
    return { ...base, title: base.code ? `Another maintenance run is in progress (409 · ${base.code})` : 'Another maintenance run is in progress (409)', text: `${base.text} Wait for it to finish, then preview again. Nothing was changed.` };
  }
  if (base.status === 503) return { ...base, title: base.code ? `A dependency is down (503 · ${base.code})` : 'A dependency is down (503)' };
  return base;
}

const whole = (text: string, min: number, max: number) => /^\d+$/.test(text.trim()) && Number(text) >= min && Number(text) <= max;

/** The counters a maintenance answer carries, as tiles: the gateway names them, so none is invented. */
function Counters({ result, label }: { result: Record<string, number>; label: string }) {
  const entries = Object.entries(result).filter(([, value]) => typeof value === 'number');
  if (entries.length === 0) return null;
  return (
    <dl className="adm-tiles" aria-label={label}>
      {entries.map(([name, value]) => <div key={name}><dt>{humanize(name)}</dt><dd>{count(value)}</dd></div>)}
    </dl>
  );
}

/**
 * Preview first, then act: the impact of a retention period, the purge of expired data (after typing the confirmation the
 * gateway demands) and the settling of abandoned jobs. Contracts are not touched here: they live in SPACE.
 */
export function AdminMaintenanceTools() {
  const [retention, setRetention] = useState(String(DEFAULT_RETENTION));
  const [days, setDays] = useState(DEFAULT_RETENTION);
  const [errorRetention, setErrorRetention] = useState(String(DEFAULT_ERROR_RETENTION));
  const [busy, setBusy] = useState<'purge' | 'jobs' | null>(null);
  const [asking, setAsking] = useState<'purge' | null>(null);
  const [typed, setTyped] = useState('');
  const [purged, setPurged] = useState<{ result: Record<string, number>; message: Message } | null>(null);
  const [jobsMessage, setJobsMessage] = useState<Message | null>(null);
  const typedId = useId();
  const retentionId = useId();
  const errorId = useId();

  const retentionValid = whole(retention, 7, 3650);
  const errorValid = whole(errorRetention, 1, 3650);

  const preview = useResource(`admin-maintenance:${days}`, () => apiClient.adminMaintenancePreview(days));
  const data = preview.data ?? preview.stale;
  const failure = preview.status === 'error' ? maintenanceFailure(preview.error, 'The maintenance preview couldn’t be calculated') : null;
  const calculating = preview.status === 'loading';
  const nothing = data !== undefined && !calculating && !failure && data.expiredArtifacts + data.expiredApiKeys + data.terminalJobs + data.abandonedJobs === 0;
  // A purge is limited to what its preview counted, so the period typed must be the one previewed.
  const ready = Boolean(preview.data) && retentionValid && Number(retention) === days;

  const runPreview = () => {
    if (!retentionValid) return;
    if (Number(retention) === days) preview.reload();
    else setDays(Number(retention));
  };

  const reconcileJobs = async () => {
    setBusy('jobs');
    setJobsMessage(null);
    try {
      const result = await apiClient.adminReconcileJobs();
      setJobsMessage({ tone: 'success', text: `${result.settled} abandoned job${result.settled === 1 ? '' : 's'} settled. Recorded in the audit log.` });
      preview.reload();
    } catch (error: unknown) {
      const refused = maintenanceFailure(error, 'Job reconciliation failed');
      setJobsMessage({ tone: refused.tone, title: refused.title, text: `${refused.text} Inspect the worker and SPACE health before retrying.` });
    } finally {
      setBusy(null);
    }
  };

  const purge = async (event: FormEvent) => {
    event.preventDefault();
    if (typed !== CONFIRMATION || !retentionValid || !errorValid) return;
    setBusy('purge');
    setPurged(null);
    try {
      const result = await apiClient.adminPurgeExpired(typed, days, Number(errorRetention));
      setPurged({ result, message: { tone: 'success', text: 'Purged. Recorded in the audit log; the next preview shows what is left.' } });
      setAsking(null);
      setTyped('');
      preview.reload();
    } catch (error: unknown) {
      const refused = maintenanceFailure(error, 'Expired data was not purged');
      setPurged({ result: {}, message: { tone: refused.tone, title: refused.title, text: `${refused.text} Run the preview again and check the audit log.` } });
      setAsking(null);
    } finally {
      setBusy(null);
    }
  };

  const impact: Array<[string, number | undefined, string]> = [
    ['Expired artifacts', data?.expiredArtifacts, 'Past their expiry; their stored files go with them.'],
    ['Expired API keys', data?.expiredApiKeys, 'Past their expiry date.'],
    ['Finished jobs to purge', data?.terminalJobs, `Finished before ${data ? formatDate(data.terminalJobCutoff) ?? '—' : '—'}, more than ${days} days ago.`],
    ['Abandoned jobs', data?.abandonedJobs, 'Running or queued far past their time budget.'],
  ];

  return (
    <>
      <section className="adm-card" aria-labelledby="adm-preview-title">
        <h2 id="adm-preview-title">1 · Preview the impact</h2>
        <div className="adm-toolbar">
          <div className="adm-field">
            <label className="adm-label" htmlFor={retentionId}>Keep finished jobs for (days)</label>
            <input id={retentionId} className="adm-narrow" value={retention} onChange={(event) => setRetention(event.target.value)} inputMode="numeric" aria-invalid={!retentionValid || undefined} aria-describedby={`${retentionId}-hint`} />
          </div>
          <Action variant="primary" onClick={runPreview} disabled={!retentionValid}>Preview</Action>
          <Action variant="link" onClick={() => { setRetention('7'); setDays(7); }}>Try 7 days</Action>
        </div>
        <span id={`${retentionId}-hint`} className={retentionValid ? 'adm-muted' : 'adm-muted is-bad'}>
          {retentionValid ? 'Between 7 and 3,650. Default 365.' : 'Use a whole number from 7 to 3,650 (the API refuses anything else).'}
        </span>

        {calculating && <div role="status" className="adm-busy"><span className="adm-spinner" aria-hidden="true" />Calculating what would change…</div>}
        {failure && <FailureNotice failure={failure} onRetry={preview.reload} />}
        {data && !calculating && !failure && (
          <>
            <div className="adm-impact" role="list" aria-label="Maintenance preview">
              {impact.map(([label, value, detail]) => (
                <div key={label} role="listitem" className={`adm-impact-tile${value ? ' is-attention' : ''}`}>
                  <span>{label}</span>
                  <strong>{count(value)}</strong>
                  <span>{detail}</span>
                  <Tag tone="info">Counted by the server</Tag>
                </div>
              ))}
            </div>
            {nothing && <p className="adm-muted">Nothing to purge with these retention periods.</p>}
          </>
        )}
      </section>

      <div className="adm-grid">
        <section className="adm-card is-danger" aria-labelledby="adm-purge-title">
          <h2 id="adm-purge-title" className="adm-danger-title">2 · Purge expired data</h2>
          <p>Removes what the preview counts, plus the error events older than the period below. Audit records stay. This can’t be undone.</p>
          {data && (
            <ul className="adm-bullets" aria-label="What a purge would remove">
              <li>{count(data.expiredArtifacts)} expired artifacts and {count(data.expiredApiKeys)} expired API keys</li>
              <li>{count(data.terminalJobs)} finished jobs older than {days} days</li>
              <li>Error events older than {errorValid ? errorRetention : '—'} days (their count isn’t in the preview)</li>
            </ul>
          )}
          <div className="adm-field">
            <label className="adm-label" htmlFor={errorId}>Keep error events for (days)</label>
            <input id={errorId} className="adm-narrow" value={errorRetention} onChange={(event) => setErrorRetention(event.target.value)} inputMode="numeric" aria-invalid={!errorValid || undefined} aria-describedby={`${errorId}-hint`} />
            <span id={`${errorId}-hint`} className={errorValid ? 'adm-muted' : 'adm-muted is-bad'}>{errorValid ? 'Between 1 and 3,650. Default 90. Not part of the preview.' : 'Use a whole number from 1 to 3,650.'}</span>
          </div>
          {purged && <Notice tone={purged.message.tone} title={purged.message.title}>{purged.message.text}</Notice>}
          {purged && <Counters result={purged.result} label="What was purged" />}
          <div className="adm-buttons">
            <Action variant="danger-outline" disabled={!ready || !errorValid || busy !== null} onClick={() => { setTyped(''); setAsking('purge'); }}><Trash2 aria-hidden="true" />Purge…</Action>
            <span className="adm-muted">{ready ? 'You’ll be asked to type a confirmation.' : 'Preview first.'}</span>
          </div>
        </section>

        <section className="adm-card" aria-labelledby="adm-jobs-title">
          <h2 id="adm-jobs-title">3 · Reconcile abandoned jobs</h2>
          <p>Settles jobs that stopped reporting and frees the concurrency slots they hold.</p>
          <p className="adm-muted">{data ? `${count(data.abandonedJobs)} abandoned job${data.abandonedJobs === 1 ? '' : 's'} found by the preview.` : 'The preview counts them.'}</p>
          {jobsMessage && <Notice tone={jobsMessage.tone} title={jobsMessage.title}>{jobsMessage.text}</Notice>}
          <div className="adm-buttons">
            <Action variant="primary" busy={busy === 'jobs'} disabled={busy !== null} onClick={() => void reconcileJobs()}>Reconcile jobs</Action>
          </div>
        </section>

      </div>

      {asking === 'purge' && (
        <Modal title="Purge expired data?" tone="danger" onClose={() => { if (busy !== 'purge') { setAsking(null); setTyped(''); } }}>
          <form className="adm-confirm" onSubmit={(event) => void purge(event)}>
            <p>
              {data ? `${count(data.expiredArtifacts)} expired artifacts, ${count(data.expiredApiKeys)} expired API keys and ${count(data.terminalJobs)} finished jobs older than ${days} days` : 'The expired data'}
              {' '}and the error events older than {errorRetention} days will be deleted permanently. Audit records remain. This can’t be undone.
            </p>
            <label htmlFor={typedId}>Type <strong className="is-mono">{CONFIRMATION}</strong> to confirm</label>
            <input id={typedId} className="eng-dialog-input" value={typed} onChange={(event) => setTyped(event.target.value)} autoComplete="off" spellCheck={false} />
            <span className="adm-muted">The API accepts only this exact phrase.</span>
            <div className="ui-modal-actions">
              <Action variant="secondary" onClick={() => { setAsking(null); setTyped(''); }} disabled={busy === 'purge'}>Cancel</Action>
              <Action type="submit" variant="danger" busy={busy === 'purge'} disabled={typed !== CONFIRMATION}>Purge permanently</Action>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
