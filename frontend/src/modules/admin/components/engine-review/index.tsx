import { useState } from 'react';
import { MdInbox } from 'react-icons/md';
import {
  bimResourceKey,
  type EngineRegistrationReport,
  type EngineRegistrationRevision,
} from '../../../engine/api/engineClient';
import { Action } from '../../../core/components/action-button';
import { EmptyState } from '../../../core/components/empty-state';
import { Notice } from '../../../core/components/notice';
import { Skeleton } from '../../../core/components/skeleton';
import { engineLabel } from '../../../core/utils/identity';
import { useResource } from '../../../core/hooks/useResource';
import { ConformanceChecklist, ViewSource } from '../../../engine/components/engine-parts';
import { readProbe } from '../../../engine/api/registrationModel';
import { useAdminApi } from '../../api/adminApi';
import { describeModerationFailure } from '../../utils/adminModel';
import ConfirmDialog from '../confirm-dialog';
import { Card, FACTS, FailureNotice, Loading, MUTED, Tag } from '../admin-parts';

type Pending = { kind: 'approve' | 'reject'; row: EngineRegistrationRevision };
type Report =
  { state: 'loading' } | { state: 'failed' } | { state: 'ready'; report: EngineRegistrationReport };

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
export default function EngineReview({ onDecided }: Props) {
  const api = useAdminApi();
  const list = useResource('admin-engine-review', () => api.adminListEngineRegistrations());
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [reports, setReports] = useState<Record<string, Report>>({});
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{
    tone: 'success' | 'error' | 'warning';
    text: string;
    title?: string;
  } | null>(null);

  const rows = list.data ?? list.stale ?? [];
  const failure =
    list.status === 'error'
      ? describeModerationFailure(list.error, 'The catalogue review queue couldn’t be loaded')
      : null;

  const toggle = async (row: EngineRegistrationRevision) => {
    const key = bimResourceKey(row);
    const next = !open[key];
    setOpen(current => ({ ...current, [key]: next }));
    if (!next || reports[key]?.state === 'ready') return;
    setReports(current => ({ ...current, [key]: { state: 'loading' } }));
    try {
      const report = await api.getEngineRegistrationReport(row);
      setReports(current => ({ ...current, [key]: { state: 'ready', report } }));
    } catch {
      setReports(current => ({ ...current, [key]: { state: 'failed' } }));
    }
  };

  const decide = async () => {
    if (!pending) return;
    const { kind, row } = pending;
    setBusy(true);
    setMessage(null);
    try {
      await (kind === 'approve'
        ? api.adminApproveEngineRegistration(row)
        : api.adminRejectEngineRegistration(row));
      setMessage({
        tone: 'success',
        text:
          kind === 'approve'
            ? `Approved. ${name(row)}@${row.version} is published. Recorded in the audit log.`
            : `Rejected. The request left the queue and ${name(row)}@${row.version} is private to ${row.namespace} again. Recorded in the audit log.`,
      });
      onDecided?.();
    } catch (error: unknown) {
      const refused = describeModerationFailure(error, 'That decision couldn’t be applied');
      setMessage({ tone: refused.tone, title: refused.title, text: refused.text });
    } finally {
      setBusy(false);
      setPending(null);
      list.reload();
    }
  };

  return (
    <Card title="Engine catalogue requests" aside="Needs “moderate engines”">
      {message && (
        <Notice tone={message.tone} title={message.title}>
          {message.text}
        </Notice>
      )}
      {failure && <FailureNotice failure={failure} onRetry={list.reload} />}
      {list.status === 'loading' && !list.stale && (
        <Loading label="Loading the review queue">
          <Skeleton variant="panel" />
        </Loading>
      )}

      {list.status !== 'loading' && !failure && rows.length === 0 && (
        <EmptyState icon={<MdInbox />} title="No engine is waiting for review" dashed>
          Only registrations their owners submit for the catalogue appear here. Private and rejected
          ones are not discoverable by administrators.
        </EmptyState>
      )}

      {rows.length > 0 && (
        <ul className="flex flex-col gap-3" aria-label="Catalogue requests">
          {rows.map(row => {
            const key = bimResourceKey(row);
            const shown = open[key] === true;
            const report = reports[key];
            return (
              <li
                key={key}
                className="flex flex-col items-start gap-3 rounded-lg border border-tp-hairline p-4"
                aria-label={name(row)}
              >
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <strong className="text-tp-ink">{row.name}</strong>
                  <span className="text-tp-slate">{row.version}</span>
                  <code className="font-mono text-xs text-tp-steel">{row.namespace}</code>
                  <Tag tone="warning">Waiting for review</Tag>
                  <span className={MUTED}>
                    Requested by <strong className="text-tp-ink">{row.namespace}</strong>
                  </span>
                </div>
                <Action
                  size="sm"
                  variant="link"
                  aria-expanded={shown}
                  onClick={() => void toggle(row)}
                >
                  {shown ? 'Hide verification report' : 'Show verification report'}
                </Action>
                {shown && (
                  <div
                    className="flex w-full flex-col gap-3 rounded-lg bg-tp-surface p-4"
                    aria-live="polite"
                    aria-label={`Verification report of ${name(row)}`}
                  >
                    {(!report || report.state === 'loading') && (
                      <p className={MUTED}>Loading the submitted contract…</p>
                    )}
                    {report?.state === 'failed' && (
                      <Notice tone="error">
                        The submitted Engine, OpenAPI document and verification report couldn’t be
                        read.
                      </Notice>
                    )}
                    {report?.state === 'ready' && (
                      <>
                        <ConformanceChecklist
                          probe={readProbe(report.report.report)}
                          pendingText="The gateway hasn’t verified this deployment yet; approving verifies it again."
                          failedText="A check failed. Approving verifies the live deployment again before anything is published."
                        />
                        <dl className={FACTS}>
                          <div>
                            <dt>Engine</dt>
                            <dd>{engineLabel({ name: row.name, version: row.version })}</dd>
                          </div>
                          <div>
                            <dt>OpenAPI document</dt>
                            <dd>{report.report.openapiDigest ? 'pinned' : 'not verified'}</dd>
                          </div>
                        </dl>
                        <ViewSource value={report.report.report} label="Verification report" />
                        <ViewSource value={report.report.engine} label="Submitted Engine" />
                        <ViewSource value={report.report.openapi} label="Submitted OpenAPI" />
                      </>
                    )}
                  </div>
                )}
                <div className="flex flex-wrap items-center gap-3">
                  <Action variant="primary" onClick={() => setPending({ kind: 'approve', row })}>
                    Approve and publish
                  </Action>
                  <Action
                    variant="danger-outline"
                    onClick={() => setPending({ kind: 'reject', row })}
                  >
                    Reject
                  </Action>
                  <span className={MUTED}>
                    The API records the decision without a written reason.
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {pending && (
        <ConfirmDialog
          title={
            pending.kind === 'approve'
              ? `Publish ${name(pending.row)} for everyone?`
              : `Reject ${name(pending.row)}?`
          }
          tone={pending.kind === 'reject' ? 'warning' : 'default'}
          confirmLabel={pending.kind === 'approve' ? 'Approve and publish' : 'Reject'}
          confirmVariant={pending.kind === 'reject' ? 'danger' : 'primary'}
          busy={busy}
          onConfirm={() => void decide()}
          onClose={() => setPending(null)}
        >
          <p>
            {pending.kind === 'approve'
              ? 'The gateway verifies the live pinned contract again, then publishes this exact revision. Everyone will be able to pick it when launching runs, and once published it can’t be changed or deleted by its owner.'
              : `The request leaves the queue and the registration goes back to being private to ${pending.row.namespace}. The API takes no written reason.`}
          </p>
        </ConfirmDialog>
      )}
    </Card>
  );
}
