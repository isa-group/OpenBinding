import { useId, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { RefreshCw } from 'lucide-react';
import { apiClient } from '../../api/client';
import { Action } from '../../components/ui/Action';
import { Notice } from '../../components/ui/Notice';
import { Skeleton } from '../../components/ui/Skeleton';
import { useResource } from '../../utils/useResource';
import { ConfirmDialog } from '../Engines/EngineDialogs';
import { AdminEngineReview } from './AdminEngineReview';
import { AdminFrame, AdminOnly, FailureNotice } from './AdminChrome';
import { describeAdminFailure, describeModerationFailure } from './adminModel';

type Kind = 'dialect' | 'resource';

interface Reference {
  kind: Kind;
  namespace: string;
  name: string;
  version: string;
  revision: string;
}

const BLANK: Reference = { kind: 'dialect', namespace: '', name: '', version: '', revision: '' };
const KIND_LABEL: Record<Kind, string> = { dialect: 'Dialect', resource: 'Resource' };

/**
 * Dialects and registered resources are approved, never rejected, and the gateway lists none of the ones waiting: it only counts
 * the dialects. So an approval starts from the exact revision the submitter reports, and is asked to be confirmed.
 */
function ExtensionApproval({ waiting, onDecided }: { waiting: number | null; onDecided: () => void }) {
  const [form, setForm] = useState<Reference>(BLANK);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'success' | 'error' | 'warning'; text: string; title?: string } | null>(null);
  const id = useId();
  const complete = [form.namespace, form.name, form.version, form.revision].every((value) => value.trim() !== '');
  const set = (field: keyof Reference) => (event: { target: { value: string } }) => setForm((current) => ({ ...current, [field]: event.target.value }));
  const label = `${form.namespace.trim()}/${form.name.trim()}@${form.version.trim()}`;

  const approve = async () => {
    setBusy(true);
    setMessage(null);
    try {
      await apiClient.adminApproveExtension(form.kind, {
        namespace: form.namespace.trim(), name: form.name.trim(), version: form.version.trim(), revision: form.revision.trim(),
      });
      setMessage({ tone: 'success', text: `${KIND_LABEL[form.kind]} ${label} approved and published. Recorded in the audit log.` });
      setForm(BLANK);
      onDecided();
    } catch (error: unknown) {
      const refused = describeModerationFailure(error, `That ${form.kind} couldn’t be approved`, 'extensions');
      setMessage({ tone: refused.tone, title: refused.title, text: refused.text });
    } finally {
      setBusy(false);
      setAsking(false);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (complete) setAsking(true);
  };

  return (
    <section className="adm-card" aria-labelledby="adm-ext-title">
      <div className="adm-card-head">
        <h2 id="adm-ext-title">Dialects and registered resources</h2>
        <span className="adm-muted">Needs “moderate extensions”</span>
      </div>
      <p className="adm-muted">
        {waiting === null ? 'The number of dialects waiting is not available right now. ' : waiting === 0 ? 'No dialect is waiting for approval. ' : `${waiting} dialect revision${waiting === 1 ? '' : 's'} waiting for approval. `}
        The gateway lists no pending dialects or resources, so an approval names the exact revision the submitter gives you.
      </p>

      {message && <Notice tone={message.tone} title={message.title}>{message.text}</Notice>}

      <form className="adm-form-grid" onSubmit={submit} aria-label="Approve a dialect or resource">
        <label className="adm-field" htmlFor={`${id}-kind`}>
          <span className="adm-label">Kind</span>
          <select id={`${id}-kind`} value={form.kind} onChange={set('kind')}>
            <option value="dialect">Dialect</option>
            <option value="resource">Registered resource</option>
          </select>
        </label>
        <label className="adm-field">
          <span className="adm-label">Namespace</span>
          <input value={form.namespace} onChange={set('namespace')} autoComplete="off" spellCheck={false} placeholder="ada-lovelace" />
        </label>
        <label className="adm-field">
          <span className="adm-label">Name</span>
          <input value={form.name} onChange={set('name')} autoComplete="off" spellCheck={false} placeholder="edge-annotations" />
        </label>
        <label className="adm-field">
          <span className="adm-label">Version</span>
          <input value={form.version} onChange={set('version')} autoComplete="off" spellCheck={false} placeholder="1.0.0" />
        </label>
        <label className="adm-field adm-wide">
          <span className="adm-label">Revision (digest)</span>
          <input value={form.revision} onChange={set('revision')} autoComplete="off" spellCheck={false} placeholder="sha256-…" />
        </label>
        <div className="adm-buttons adm-wide">
          <Action type="submit" variant="primary" disabled={!complete}>Approve…</Action>
          <span className="adm-muted">Approval publishes the revision for everyone.</span>
        </div>
      </form>

      <p className="adm-muted">
        The API offers approval only for dialects and resources; there is no reject action for them. Submitters see the decision on{' '}
        <Link to="/language/extensions" viewTransition>Language extensions</Link>.
      </p>

      {asking && (
        <ConfirmDialog
          title={`Approve ${form.kind} ${label}?`}
          confirmLabel={`Approve ${form.kind}`}
          busy={busy}
          onConfirm={() => void approve()}
          onClose={() => setAsking(false)}
        >
          <p>It becomes available to everyone and, once published, can’t be changed. Approving is recorded in the audit log.</p>
        </ConfirmDialog>
      )}
    </section>
  );
}

function ModerationScreen() {
  const overview = useResource('admin-moderation-counts', () => apiClient.adminModeration());
  const counts = overview.data ?? overview.stale;
  const failure = overview.status === 'error' ? describeAdminFailure(overview.error, 'The moderation counts couldn’t be loaded') : null;
  const waiting = (map: Record<string, number> | undefined) => (counts ? map?.pending_review ?? 0 : null);
  const tiles: Array<[string, number | null]> = [
    ['Engine requests', waiting(counts?.registrations)],
    ['Engine revisions', waiting(counts?.engines)],
    ['Dialects', waiting(counts?.dialects)],
  ];

  return (
    <AdminFrame
      section="moderation"
      trail={[{ label: 'Administration', to: '/app/admin' }, { label: 'Moderation' }]}
      title="Moderation"
      lede="Decide what becomes available to everyone: engine deployments people asked to publish, new dialects and registered resources."
      actions={<Action variant="secondary" onClick={overview.reload} busy={overview.status === 'loading' && Boolean(counts)}><RefreshCw aria-hidden="true" />Refresh</Action>}
    >
      {failure && <FailureNotice failure={failure} onRetry={overview.reload} />}
      {overview.status === 'loading' && !counts && <div aria-busy="true" className="adm-skeleton"><span className="sr-only">Loading what waits for review</span><Skeleton variant="tile" /></div>}

      {counts && (
        <div className="adm-queue-tiles" role="list" aria-label="Waiting for review">
          {tiles.map(([label, total]) => (
            <div key={label} role="listitem" className={`adm-queue-tile${total ? ' is-attention' : ''}`}>
              <span>{label}</span>
              <strong>{total ?? '—'}</strong>
            </div>
          ))}
        </div>
      )}

      <AdminEngineReview onDecided={overview.reload} />
      <ExtensionApproval waiting={waiting(counts?.dialects)} onDecided={overview.reload} />
    </AdminFrame>
  );
}

/** admin-moderation: the queue of engine publication requests, and the approval of dialects and resources. */
export function AdminModeration() {
  return <AdminOnly><ModerationScreen /></AdminOnly>;
}
