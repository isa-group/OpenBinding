import { useId, useState, type FormEvent } from 'react';
import { MdDelete } from 'react-icons/md';
import { Action } from '../../../core/components/action-button';
import { Modal } from '../../../core/components/modal';
import { Notice } from '../../../core/components/notice';
import { formatDate } from '../../../../utils/format';
import { useResource } from '../../../../utils/useResource';
import { useAdminApi } from '../../api/adminApi';
import { count, describeAdminFailure, humanize, type Failure } from '../../utils/adminModel';
import {
  Card,
  DIALOG_ACTIONS,
  FailureNotice,
  INPUT,
  LABEL,
  MUTED,
  SectionHeader,
  Tag,
} from '../admin-parts';

const CONFIRMATION = 'PURGE EXPIRED';
const DEFAULT_RETENTION = 365;
const DEFAULT_ERROR_RETENTION = 90;

type Message = { tone: 'success' | 'info' | 'error' | 'warning'; title?: string; text: string };

/** Maintenance refuses with 409 while another run holds the work, and with 503 when the database or SPACE doesn’t answer. */
function maintenanceFailure(error: unknown, what: string): Failure {
  const base = describeAdminFailure(error, what);
  if (base.status === 409) {
    return {
      ...base,
      title: base.code
        ? `Another maintenance run is in progress (409 · ${base.code})`
        : 'Another maintenance run is in progress (409)',
      text: `${base.text} Wait for it to finish, then preview again. Nothing was changed.`,
    };
  }
  if (base.status === 503)
    return {
      ...base,
      title: base.code ? `A dependency is down (503 · ${base.code})` : 'A dependency is down (503)',
    };
  return base;
}

const whole = (text: string, min: number, max: number) =>
  /^\d+$/.test(text.trim()) && Number(text) >= min && Number(text) <= max;

/** The counters a maintenance answer carries, as tiles: the gateway names them, so none is invented. */
function Counters({ result, label }: { result: Record<string, number>; label: string }) {
  const entries = Object.entries(result).filter(([, value]) => typeof value === 'number');
  if (entries.length === 0) return null;
  return (
    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3" aria-label={label}>
      {entries.map(([name, value]) => (
        <div key={name} className="rounded-lg border border-tp-hairline bg-tp-canvas p-3">
          <dt className="text-[11px] text-tp-steel">{humanize(name)}</dt>
          <dd className="text-lg font-semibold text-tp-ink">{count(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A hint under a field: steel, or the error red when the field is refused. */
const hint = (valid: boolean) => (valid ? MUTED : 'text-[13px] font-medium text-tp-error-text');

/**
 * The Maintenance section of `/admin`. Preview first, then act: the impact of a retention period, the purge of expired data (after
 * typing the confirmation the gateway demands) and the settling of abandoned jobs. Contracts are not touched here: they live in SPACE.
 */
export default function MaintenanceSection() {
  const api = useAdminApi();
  const [retention, setRetention] = useState(String(DEFAULT_RETENTION));
  const [days, setDays] = useState(DEFAULT_RETENTION);
  const [errorRetention, setErrorRetention] = useState(String(DEFAULT_ERROR_RETENTION));
  const [busy, setBusy] = useState<'purge' | 'jobs' | null>(null);
  const [asking, setAsking] = useState<'purge' | null>(null);
  const [typed, setTyped] = useState('');
  const [purged, setPurged] = useState<{ result: Record<string, number>; message: Message } | null>(
    null
  );
  const [jobsMessage, setJobsMessage] = useState<Message | null>(null);
  const typedId = useId();
  const retentionId = useId();
  const errorId = useId();

  const retentionValid = whole(retention, 7, 3650);
  const errorValid = whole(errorRetention, 1, 3650);

  const preview = useResource(`admin-maintenance:${days}`, () => api.adminMaintenancePreview(days));
  const data = preview.data ?? preview.stale;
  const failure =
    preview.status === 'error'
      ? maintenanceFailure(preview.error, 'The maintenance preview couldn’t be calculated')
      : null;
  const calculating = preview.status === 'loading';
  const nothing =
    data !== undefined &&
    !calculating &&
    !failure &&
    data.expiredApiKeys + data.terminalJobs + data.abandonedJobs === 0;
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
      const result = await api.adminReconcileJobs();
      setJobsMessage({
        tone: 'success',
        text: `${result.settled} abandoned run${result.settled === 1 ? '' : 's'} settled. Recorded in the audit log.`,
      });
      preview.reload();
    } catch (error: unknown) {
      const refused = maintenanceFailure(error, 'Run reconciliation failed');
      setJobsMessage({
        tone: refused.tone,
        title: refused.title,
        text: `${refused.text} Inspect the worker and SPACE health before retrying.`,
      });
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
      const result = await api.adminPurgeExpired(typed, days, Number(errorRetention));
      setPurged({
        result,
        message: {
          tone: 'success',
          text: 'Purged. Recorded in the audit log; the next preview shows what is left.',
        },
      });
      setAsking(null);
      setTyped('');
      preview.reload();
    } catch (error: unknown) {
      const refused = maintenanceFailure(error, 'Expired data was not purged');
      setPurged({
        result: {},
        message: {
          tone: refused.tone,
          title: refused.title,
          text: `${refused.text} Run the preview again and check the audit log.`,
        },
      });
      setAsking(null);
    } finally {
      setBusy(null);
    }
  };

  const impact: Array<[string, number | undefined, string]> = [
    ['Expired API keys', data?.expiredApiKeys, 'Past their expiry date.'],
    [
      'Finished runs to purge',
      data?.terminalJobs,
      `Finished before ${data ? (formatDate(data.terminalJobCutoff) ?? '—') : '—'}, more than ${days} days ago.`,
    ],
    ['Abandoned runs', data?.abandonedJobs, 'Running or queued far past their time budget.'],
  ];

  return (
    <>
      <SectionHeader
        title="Maintenance"
        lede="Preview first, then act. Every action here is recorded in the audit log; purging can’t be undone."
      />
      <Card title="1 · Preview the impact">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <label className={LABEL} htmlFor={retentionId}>
              Keep finished runs for (days)
            </label>
            <input
              id={retentionId}
              className={`${INPUT} w-28`}
              value={retention}
              onChange={event => setRetention(event.target.value)}
              inputMode="numeric"
              aria-invalid={!retentionValid || undefined}
              aria-describedby={`${retentionId}-hint`}
            />
          </div>
          <Action variant="primary" onClick={runPreview} disabled={!retentionValid}>
            Preview
          </Action>
          <Action
            variant="link"
            onClick={() => {
              setRetention('7');
              setDays(7);
            }}
          >
            Try 7 days
          </Action>
        </div>
        <span id={`${retentionId}-hint`} className={hint(retentionValid)}>
          {retentionValid
            ? 'Between 7 and 3,650. Default 365.'
            : 'Use a whole number from 7 to 3,650 (the API refuses anything else).'}
        </span>

        {calculating && (
          <div role="status" className="flex items-center gap-2 text-sm text-tp-slate">
            <span
              className="h-4 w-4 animate-spin rounded-full border-2 border-tp-hairline border-t-tp-primary motion-reduce:animate-none"
              aria-hidden="true"
            />
            Calculating what would change…
          </div>
        )}
        {failure && <FailureNotice failure={failure} onRetry={preview.reload} />}
        {data && !calculating && !failure && (
          <>
            <div className="grid gap-3 sm:grid-cols-3" role="list" aria-label="Maintenance preview">
              {impact.map(([label, value, detail]) => (
                <div
                  key={label}
                  role="listitem"
                  className={`flex flex-col items-start gap-1 rounded-lg border p-3 ${
                    value
                      ? 'border-tp-severity-warning-border bg-tp-severity-warning-bg'
                      : 'border-tp-hairline bg-tp-canvas'
                  }`}
                >
                  <span className="text-[13px] font-medium text-tp-slate">{label}</span>
                  <strong className="font-display text-2xl text-tp-ink">{count(value)}</strong>
                  <span className={MUTED}>{detail}</span>
                  <Tag tone="info">Counted by the server</Tag>
                </div>
              ))}
            </div>
            {nothing && <p className={MUTED}>Nothing to purge with these retention periods.</p>}
          </>
        )}
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="2 · Purge expired data" danger>
          <p className="text-sm text-tp-slate">
            Removes what the preview counts, plus the error events older than the period below.
            Audit records stay. This can’t be undone.
          </p>
          {data && (
            <ul
              className="list-disc pl-5 text-sm text-tp-slate"
              aria-label="What a purge would remove"
            >
              <li>{count(data.expiredApiKeys)} expired API keys</li>
              <li>
                {count(data.terminalJobs)} finished runs older than {days} days
              </li>
              <li>
                Error events older than {errorValid ? errorRetention : '—'} days (their count isn’t
                in the preview)
              </li>
            </ul>
          )}
          <div className="flex flex-col gap-1">
            <label className={LABEL} htmlFor={errorId}>
              Keep error events for (days)
            </label>
            <input
              id={errorId}
              className={`${INPUT} w-28`}
              value={errorRetention}
              onChange={event => setErrorRetention(event.target.value)}
              inputMode="numeric"
              aria-invalid={!errorValid || undefined}
              aria-describedby={`${errorId}-hint`}
            />
            <span id={`${errorId}-hint`} className={hint(errorValid)}>
              {errorValid
                ? 'Between 1 and 3,650. Default 90. Not part of the preview.'
                : 'Use a whole number from 1 to 3,650.'}
            </span>
          </div>
          {purged && (
            <Notice tone={purged.message.tone} title={purged.message.title}>
              {purged.message.text}
            </Notice>
          )}
          {purged && <Counters result={purged.result} label="What was purged" />}
          <div className="flex flex-wrap items-center gap-3">
            <Action
              variant="danger-outline"
              disabled={!ready || !errorValid || busy !== null}
              onClick={() => {
                setTyped('');
                setAsking('purge');
              }}
            >
              <MdDelete aria-hidden="true" />
              Purge…
            </Action>
            <span className={MUTED}>
              {ready ? 'You’ll be asked to type a confirmation.' : 'Preview first.'}
            </span>
          </div>
        </Card>

        <Card title="3 · Reconcile abandoned runs">
          <p className="text-sm text-tp-slate">
            Settles runs that stopped reporting and frees the concurrency slots they hold.
          </p>
          <p className={MUTED}>
            {data
              ? `${count(data.abandonedJobs)} abandoned run${data.abandonedJobs === 1 ? '' : 's'} found by the preview.`
              : 'The preview counts them.'}
          </p>
          {jobsMessage && (
            <Notice tone={jobsMessage.tone} title={jobsMessage.title}>
              {jobsMessage.text}
            </Notice>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <Action
              variant="primary"
              busy={busy === 'jobs'}
              disabled={busy !== null}
              onClick={() => void reconcileJobs()}
            >
              Reconcile runs
            </Action>
          </div>
        </Card>
      </div>

      {asking === 'purge' && (
        <Modal
          title="Purge expired data?"
          tone="danger"
          onClose={() => {
            if (busy !== 'purge') {
              setAsking(null);
              setTyped('');
            }
          }}
        >
          <form className="flex flex-col gap-2" onSubmit={event => void purge(event)}>
            <p>
              {data
                ? `${count(data.expiredApiKeys)} expired API keys and ${count(data.terminalJobs)} finished runs older than ${days} days`
                : 'The expired data'}{' '}
              and the error events older than {errorRetention} days will be deleted permanently.
              Audit records remain. This can’t be undone.
            </p>
            <label htmlFor={typedId} className="mt-2 text-sm text-tp-ink">
              Type <strong className="font-mono">{CONFIRMATION}</strong> to confirm
            </label>
            <input
              id={typedId}
              className={`${INPUT} font-mono`}
              value={typed}
              onChange={event => setTyped(event.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
            <span className={MUTED}>The API accepts only this exact phrase.</span>
            <div className={DIALOG_ACTIONS}>
              <Action
                variant="secondary"
                onClick={() => {
                  setAsking(null);
                  setTyped('');
                }}
                disabled={busy === 'purge'}
              >
                Cancel
              </Action>
              <Action
                type="submit"
                variant="danger"
                busy={busy === 'purge'}
                disabled={typed !== CONFIRMATION}
              >
                Purge permanently
              </Action>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
