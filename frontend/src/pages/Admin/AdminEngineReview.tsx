import { useState } from 'react';
import { Inbox } from 'lucide-react';
import { apiClient, bimResourceKey, type EngineRegistrationReport, type EngineRegistrationRevision } from '../../api/client';
import { Action } from '../../components/ui/Action';
import { EmptyState } from '../../components/ui/EmptyState';
import { Notice } from '../../components/ui/Notice';
import { Skeleton } from '../../components/ui/Skeleton';
import { shortDigest } from '../../utils/digest';
import { useResource } from '../../utils/useResource';
import { ConfirmDialog } from '../Engines/EngineDialogs';
import { ConformanceChecklist, ViewSource } from '../Engines/EngineParts';
import { readProbe } from '../Engines/registrationModel';
import { FailureNotice, Tag } from './AdminChrome';
import { describeModerationFailure } from './adminModel';

type Pending = { kind: 'approve' | 'reject'; row: EngineRegistrationRevision };
type Report = { state: 'loading' } | { state: 'failed' } | { state: 'ready'; report: EngineRegistrationReport };

const name = (row: EngineRegistrationRevision) => `${row.namespace}/${row.name}`;

interface Props {
  /** Called after a decision, so the counts around the queue can be read again. */
  onDecided?: () => void;
}

/**
 * The engine publication requests that wait for a reviewer: read what was submitted and how it was verified, then approve
 * and publish, or reject. Only registrations their owners explicitly submitted appear: private and rejected ones are not
 * discoverable. The gateway records a decision without a written reason, so none is asked for.
 */
export function AdminEngineReview({ onDecided }: Props) {
  const list = useResource('admin-engine-review', () => apiClient.adminListEngineRegistrations());
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [reports, setReports] = useState<Record<string, Report>>({});
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'success' | 'error' | 'warning'; text: string; title?: string } | null>(null);

  const rows = list.data ?? list.stale ?? [];
  const failure = list.status === 'error' ? describeModerationFailure(list.error, 'The publication review queue couldn’t be loaded', 'engines') : null;

  const toggle = async (row: EngineRegistrationRevision) => {
    const key = bimResourceKey(row);
    const next = !open[key];
    setOpen((current) => ({ ...current, [key]: next }));
    if (!next || reports[key]?.state === 'ready') return;
    setReports((current) => ({ ...current, [key]: { state: 'loading' } }));
    try {
      const report = await apiClient.getEngineRegistrationReport(row);
      setReports((current) => ({ ...current, [key]: { state: 'ready', report } }));
    } catch {
      setReports((current) => ({ ...current, [key]: { state: 'failed' } }));
    }
  };

  const decide = async () => {
    if (!pending) return;
    const { kind, row } = pending;
    setBusy(true);
    setMessage(null);
    try {
      await (kind === 'approve' ? apiClient.adminApproveEngineRegistration(row) : apiClient.adminRejectEngineRegistration(row));
      setMessage({
        tone: 'success',
        text: kind === 'approve'
          ? `Approved. ${name(row)}@${row.version} is published. Recorded in the audit log.`
          : `Rejected. The request left the queue and ${name(row)}@${row.version} is private to ${row.namespace} again. Recorded in the audit log.`,
      });
      onDecided?.();
    } catch (error: unknown) {
      const refused = describeModerationFailure(error, 'That decision couldn’t be applied', 'engines');
      setMessage({ tone: refused.tone, title: refused.title, text: refused.text });
    } finally {
      setBusy(false);
      setPending(null);
      list.reload();
    }
  };

  return (
    <section className="adm-card" aria-labelledby="adm-review-title">
      <div className="adm-card-head">
        <h2 id="adm-review-title">Engine publication requests</h2>
        <span className="adm-muted">Needs “moderate engines”</span>
      </div>

      {message && <Notice tone={message.tone} title={message.title}>{message.text}</Notice>}
      {failure && <FailureNotice failure={failure} onRetry={list.reload} />}
      {list.status === 'loading' && !list.stale && <div aria-busy="true" className="adm-skeleton"><span className="sr-only">Loading the review queue</span><Skeleton variant="panel" /></div>}

      {list.status !== 'loading' && !failure && rows.length === 0 && (
        <EmptyState icon={<Inbox />} title="No engine is waiting for review" dashed>
          Only registrations their owners submit for publication appear here. Private and rejected ones are not discoverable by administrators.
        </EmptyState>
      )}

      {rows.length > 0 && (
        <ul className="adm-requests" aria-label="Publication requests">
          {rows.map((row) => {
            const key = bimResourceKey(row);
            const shown = open[key] === true;
            const report = reports[key];
            return (
              <li key={key} className="adm-request" aria-label={name(row)}>
                <div className="adm-request-head">
                  <strong>{row.name}</strong>
                  <span>{row.version}</span>
                  <code title={row.digest}>{row.namespace} · {shortDigest(row.digest)}</code>
                  <Tag tone="warning">Waiting for review</Tag>
                  <span className="adm-request-by">Requested by <strong>{row.namespace}</strong></span>
                </div>
                <Action size="sm" variant="link" aria-expanded={shown} onClick={() => void toggle(row)}>
                  {shown ? 'Hide verification report' : 'Show verification report'}
                </Action>
                {shown && (
                  <div className="adm-report" aria-live="polite" aria-label={`Verification report of ${name(row)}`}>
                    {(!report || report.state === 'loading') && <p className="adm-muted">Loading the submitted contract…</p>}
                    {report?.state === 'failed' && <Notice tone="error">The submitted Engine, OpenAPI document and verification report couldn’t be read.</Notice>}
                    {report?.state === 'ready' && (
                      <>
                        <ConformanceChecklist probe={readProbe(report.report.report)} pendingText="The gateway hasn’t verified this deployment yet; approving verifies it again." failedText="A check failed. Approving verifies the live deployment again before anything is published." />
                        <dl className="adm-detail">
                          <div><dt>Registration digest</dt><dd className="is-mono">{report.report.digest}</dd></div>
                          <div><dt>OpenAPI digest</dt><dd className="is-mono">{report.report.openapiDigest || 'not verified'}</dd></div>
                        </dl>
                        <ViewSource value={report.report.report} label="Verification report" />
                        <ViewSource value={report.report.engine} label="Submitted Engine" />
                        <ViewSource value={report.report.openapi} label="Submitted OpenAPI" />
                      </>
                    )}
                  </div>
                )}
                <div className="adm-buttons">
                  <Action variant="primary" onClick={() => setPending({ kind: 'approve', row })}>Approve and publish</Action>
                  <Action variant="danger-outline" onClick={() => setPending({ kind: 'reject', row })}>Reject</Action>
                  <span className="adm-muted">The API records the decision without a written reason.</span>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {pending && (
        <ConfirmDialog
          title={pending.kind === 'approve' ? `Publish ${name(pending.row)} for everyone?` : `Reject ${name(pending.row)}?`}
          tone={pending.kind === 'reject' ? 'warning' : 'default'}
          confirmLabel={pending.kind === 'approve' ? 'Approve and publish' : 'Reject'}
          confirmVariant={pending.kind === 'reject' ? 'danger' : 'primary'}
          busy={busy}
          onConfirm={() => void decide()}
          onClose={() => setPending(null)}
        >
          <p>
            {pending.kind === 'approve'
              ? 'The gateway verifies the live pinned contract again, then publishes this exact revision. Everyone will be able to pick it when launching jobs, and once published it can’t be changed or deleted by its owner.'
              : `The request leaves the queue and the registration goes back to being private to ${pending.row.namespace}. The API takes no written reason.`}
          </p>
        </ConfirmDialog>
      )}
    </section>
  );
}
