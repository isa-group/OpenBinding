import { useState } from 'react';
import { Inbox } from 'lucide-react';
import { apiClient, bimResourceKey, type EngineRegistrationReport, type EngineRegistrationRevision } from '../../api/client';
import { Action } from '../../components/ui/Action';
import { DataTable } from '../../components/ui/DataTable';
import { EmptyState } from '../../components/ui/EmptyState';
import { Notice } from '../../components/ui/Notice';
import { Skeleton } from '../../components/ui/Skeleton';
import { shortDigest } from '../../utils/digest';
import { useResource } from '../../utils/useResource';
import { ConfirmDialog } from '../Engines/EngineDialogs';
import { ViewSource } from '../Engines/EngineParts';
import { FailureNotice, Tag } from './AdminChrome';
import { describeAdminFailure } from './adminModel';

type Pending = { kind: 'approve' | 'reject'; row: EngineRegistrationRevision };

const name = (row: EngineRegistrationRevision) => `${row.namespace}/${row.name}`;

/**
 * The engine publication requests that wait for a reviewer: read the submitted contract, then approve or reject.
 * Only registrations their owners explicitly submitted appear here; private and rejected ones are not discoverable.
 */
export function AdminEngineReview() {
  const list = useResource('admin-engine-review', () => apiClient.adminListEngineRegistrations());
  const [reviewing, setReviewing] = useState<EngineRegistrationRevision | null>(null);
  const [report, setReport] = useState<EngineRegistrationReport | null>(null);
  const [reportFailure, setReportFailure] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'success' | 'error' | 'warning'; text: string; title?: string } | null>(null);

  const rows = list.data ?? list.stale ?? [];
  const failure = list.status === 'error' ? describeAdminFailure(list.error, 'The publication review queue couldn’t be loaded') : null;

  const inspect = async (row: EngineRegistrationRevision) => {
    setReviewing(row);
    setReport(null);
    setReportFailure(null);
    try {
      setReport(await apiClient.getEngineRegistrationReport(row));
    } catch {
      setReportFailure('The submitted Engine, OpenAPI document and verification report couldn’t be read.');
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
          ? `${name(row)}@${row.version} is published.`
          : `${name(row)}@${row.version} was rejected and is private again.`,
      });
      if (reviewing && bimResourceKey(reviewing) === bimResourceKey(row)) { setReviewing(null); setReport(null); }
      list.reload();
    } catch (error: unknown) {
      const refused = describeAdminFailure(error, 'That decision couldn’t be applied');
      setMessage({ tone: refused.tone, title: refused.title, text: refused.text });
    } finally {
      setBusy(false);
      setPending(null);
    }
  };

  return (
    <section className="adm-card" aria-labelledby="adm-review-title">
      <div className="adm-card-head">
        <h2 id="adm-review-title">Engine publication requests</h2>
        <Tag tone={rows.length ? 'warning' : 'plain'}>{rows.length} waiting</Tag>
      </div>
      <p className="adm-muted">Only registrations their owners explicitly submitted appear here. Private and rejected registrations are not discoverable by administrators.</p>

      {message && <Notice tone={message.tone} title={message.title}>{message.text}</Notice>}
      {failure && <FailureNotice failure={failure} onRetry={list.reload} />}
      {list.status === 'loading' && !list.stale && <div aria-busy="true"><span className="sr-only">Loading the review queue</span><Skeleton variant="tile" /></div>}

      {list.status !== 'loading' && !failure && rows.length === 0 && (
        <EmptyState icon={<Inbox />} title="Nothing is waiting for publication review" dashed />
      )}

      {rows.length > 0 && (
        <DataTable label="Publication requests" minWidth={780}>
          <thead>
            <tr>
              <th scope="col">Registration</th>
              <th scope="col">Version</th>
              <th scope="col">Digest</th>
              <th scope="col">Status</th>
              <th scope="col">Owner use</th>
              <th scope="col"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={bimResourceKey(row)} aria-label={name(row)}>
                <td><strong>{name(row)}</strong><span className="adm-sub">EngineRegistration</span></td>
                <td><code>{row.version}</code></td>
                <td><code title={row.digest}>{shortDigest(row.digest)}</code></td>
                <td><Tag tone="warning">{row.status.replace('_', ' ')}</Tag></td>
                <td><Tag tone={row.active ? 'success' : 'plain'}>{row.active ? 'active' : 'inactive'}</Tag></td>
                <td>
                  <span className="adm-actions">
                    <Action size="sm" variant="link" onClick={() => void inspect(row)}>Review contract</Action>
                    <Action size="sm" variant="link" title="Verify the live pinned contract again, then publish this exact revision" onClick={() => setPending({ kind: 'approve', row })}>Approve publication</Action>
                    <Action size="sm" variant="link" className="adm-danger-link" onClick={() => setPending({ kind: 'reject', row })}>Reject</Action>
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}

      {reviewing && (
        <section className="adm-report" aria-live="polite" aria-label="Publication contract">
          <header>
            <div>
              <span className="adm-label">Publication contract</span>
              <h3>{name(reviewing)}@{reviewing.version}</h3>
            </div>
            <Action size="sm" variant="ghost" onClick={() => { setReviewing(null); setReport(null); }}>Close</Action>
          </header>
          {reportFailure && <Notice tone="error">{reportFailure}</Notice>}
          {!report && !reportFailure && <p className="adm-muted">Loading the submitted contract…</p>}
          {report && (
            <>
              <dl className="adm-detail">
                <div><dt>Registration digest</dt><dd className="is-mono">{report.digest}</dd></div>
                <div><dt>OpenAPI digest</dt><dd className="is-mono">{report.openapiDigest || 'not verified'}</dd></div>
                <div><dt>Verification</dt><dd className="is-mono">{String(report.report?.status || 'pending')}</dd></div>
              </dl>
              <ViewSource value={report.report} label="Verification report" />
              <ViewSource value={report.engine} label="Submitted Engine" />
              <ViewSource value={report.openapi} label="Submitted OpenAPI" />
            </>
          )}
        </section>
      )}

      {pending && (
        <ConfirmDialog
          title={pending.kind === 'approve' ? `Publish ${name(pending.row)}?` : `Reject publication of ${name(pending.row)}?`}
          tone={pending.kind === 'reject' ? 'warning' : 'default'}
          confirmLabel={pending.kind === 'approve' ? 'Approve publication' : 'Reject'}
          busy={busy}
          onConfirm={() => void decide()}
          onClose={() => setPending(null)}
        >
          <p>
            {pending.kind === 'approve'
              ? 'The gateway verifies the live pinned contract again, then publishes this exact revision for everyone. Once published it can’t be changed.'
              : 'The registration will become private to its owner again. The API takes no written reason.'}
          </p>
        </ConfirmDialog>
      )}
    </section>
  );
}
