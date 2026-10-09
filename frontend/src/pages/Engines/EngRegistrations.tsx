import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Inbox, Plus } from 'lucide-react';
import { apiClient, type EngineRegistrationRevision } from '../../api/client';
import { Action } from '../../components/ui/Action';
import { DataTable } from '../../components/ui/DataTable';
import { EmptyState } from '../../components/ui/EmptyState';
import { ErrorState } from '../../components/ui/ErrorState';
import { FilterPills } from '../../components/ui/FilterPills';
import { Notice, type NoticeTone } from '../../components/ui/Notice';
import { PageHeader } from '../../components/ui/PageHeader';
import { Skeleton } from '../../components/ui/Skeleton';
import { useAuth } from '../../contexts/auth';
import { shortDigest } from '../../utils/digest';
import { formatDate } from '../../utils/format';
import { useResource } from '../../utils/useResource';
import { ConfirmDialog, DeregisterDialog } from './EngineDialogs';
import { Crumbs, PlanMeter, StatusChip } from './EngineParts';
import {
  activityOf, allowanceOf, describeFailure, publicationOf, probeSummary, readProbe, registrationHref, registrationKey,
  type Probe,
} from './registrationModel';
import './Registrations.css';

type Filter = 'all' | 'active' | 'inactive' | 'pending_review' | 'published';

const FILTERS: ReadonlyArray<{ id: Filter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'active', label: 'Active' },
  { id: 'inactive', label: 'Inactive' },
  { id: 'pending_review', label: 'Waiting for review' },
  { id: 'published', label: 'Published' },
];

const LIFECYCLE: ReadonlyArray<{ label: string; tone: 'info' | 'warning' | 'error'; text: string }> = [
  { label: 'Inactive / Active', tone: 'info', text: 'Whether you can pick it for your own jobs. Activation re-checks the deployment.' },
  { label: 'Private → Waiting for review → Published', tone: 'warning', text: 'Publishing needs an administrator’s review. Once published, it can’t be changed.' },
  { label: 'Delete', tone: 'error', text: 'Removes a registration you no longer use, with its stored credential. It can’t be undone.' },
];

interface Message {
  tone: NoticeTone;
  title?: string;
  text: string;
  href?: string;
}

type Pending = { kind: 'publish' | 'deactivate' | 'delete'; row: EngineRegistrationRevision };

function matches(filter: Filter, row: EngineRegistrationRevision): boolean {
  if (filter === 'all') return true;
  if (filter === 'active') return row.active;
  if (filter === 'inactive') return !row.active;
  return row.status === filter;
}

function LastCheck({ probe, loading }: { probe: Probe | null | undefined; loading: boolean }) {
  if (loading) return <span className="eng-muted">Checking…</span>;
  if (!probe) return <span className="eng-muted">—</span>;
  const summary = probeSummary(probe);
  const when = formatDate(probe.verifiedAt);
  return (
    <span className="reg-check">
      <StatusChip tone={summary.tone}>{summary.label}</StatusChip>
      {when && <small>{when}</small>}
    </span>
  );
}

/** eng-registrations: the engine deployments of this account, and the ones published for everyone. */
export function EngRegistrations() {
  const { user, isAdmin } = useAuth();
  const username = user?.username ?? '';
  const [params, setParams] = useSearchParams();
  const review = params.get('review') === 'true';
  const [filter, setFilter] = useState<Filter>('all');
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState<Message | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);

  const list = useResource(`engine-registrations:${username}:${review}`, async () => ({
    review,
    username,
    rows: review ? await apiClient.adminListEngineRegistrations() : await apiClient.listEngineRegistrations(),
  }));
  const usage = useResource(`engine-registrations-usage:${username}`, () => apiClient.getOwnUsage().catch(() => null));

  // After a failed refresh the last list stays, but never one that was asked for another way or by another account.
  const kept = list.stale?.review === review && list.stale.username === username ? list.stale : undefined;
  const rows = useMemo(() => (list.data ?? kept)?.rows ?? [], [list.data, kept]);
  const stamp = rows.map((row) => `${registrationKey(row)}:${row.active}:${row.status}`).join(',');
  const probes = useResource(`engine-registration-probes:${stamp}`, async () => {
    const found: Record<string, Probe | null> = {};
    await Promise.all(rows.map(async (row) => {
      try {
        found[registrationKey(row)] = readProbe((await apiClient.getEngineRegistrationReport(row)).report);
      } catch {
        found[registrationKey(row)] = null;
      }
    }));
    return found;
  });
  const known = probes.data ?? probes.stale ?? {};

  const failure = list.status === 'error' ? describeFailure(list.error, 'Your engines couldn’t be loaded') : null;
  const visible = rows.filter((row) => matches(filter, row));
  const own = rows.filter((row) => row.namespace === username);
  const allowance = allowanceOf(usage.data ?? usage.stale ?? null, own.length);

  const setReview = (next: boolean) => {
    const query = new URLSearchParams(params);
    if (next) query.set('review', 'true'); else query.delete('review');
    setParams(query, { replace: true });
    setFilter('all');
    setMessage(null);
  };

  const run = async (row: EngineRegistrationRevision, task: () => Promise<unknown>, success: string) => {
    setBusy(registrationKey(row));
    setMessage(null);
    try {
      await task();
      setMessage({ tone: 'success', text: success });
      list.reload();
    } catch (error: unknown) {
      const refused = describeFailure(error, 'The change was refused');
      const checks = refused.probe?.checks.filter((check) => check.state === 'failed').map((check) => check.detail).filter(Boolean) ?? [];
      setMessage({
        tone: refused.tone,
        title: refused.title,
        text: [refused.text, ...checks, ...refused.details].join(' '),
        href: refused.probe ? registrationHref(row) : undefined,
      });
    } finally {
      setBusy('');
    }
  };

  const toggle = (row: EngineRegistrationRevision) => {
    if (!row.active) {
      void run(row, () => apiClient.activateEngineRegistration(row), `${row.name} passed its check and is active for you.`);
    } else if (row.status === 'published') {
      setPending({ kind: 'deactivate', row });
    } else {
      void run(row, () => apiClient.deactivateEngineRegistration(row), 'Deactivated. You can’t pick it for new jobs until you activate it again.');
    }
  };

  const askPublication = (row: EngineRegistrationRevision) => {
    if (!row.active) {
      setMessage({ tone: 'warning', title: 'Activate it first', text: `Activate ${row.name} before requesting publication. Activation re-checks your deployment.` });
      return;
    }
    setPending({ kind: 'publish', row });
  };

  const applyPending = async () => {
    if (!pending) return;
    const { kind, row } = pending;
    const task = kind === 'publish'
      ? () => apiClient.requestEngineRegistrationPublication(row)
      : kind === 'deactivate'
        ? () => apiClient.deactivateEngineRegistration(row)
        : () => apiClient.deleteEngineRegistration(row);
    const success = kind === 'publish'
      ? 'Publication requested. An administrator will review it.'
      : kind === 'deactivate'
        ? 'Deactivated. Nobody can pick it for new jobs until you activate it again.'
        : `Deleted ${row.name} ${row.version}.`;
    await run(row, task, success);
    setPending(null);
  };

  const status = list.status;
  const unauthorized = failure?.status === 401;
  const forbidden = failure?.status === 403;
  const unavailable = failure !== null && !unauthorized && !forbidden;
  const showTable = rows.length > 0 && !forbidden && !unauthorized;
  const showMain = !unauthorized;

  return (
    <div className="reg-page">
      <Crumbs items={[{ label: 'Home', to: '/app' }, { label: 'My engines' }]} />
      <PageHeader
        eyebrow="Engines"
        title="My engines"
        lede={<>Engine deployments you’ve registered, and any that have been published for everyone. Built-in engines live in the <Link to="/engines">catalog</Link>.</>}
        actions={<Action to="/app/engines/new" variant="primary"><Plus aria-hidden="true" />Register an engine</Action>}
      />

      {showMain && !review && (
        <section className="reg-allowance" aria-label="Your plan’s room for federated engines">
          <PlanMeter
            allowance={allowance}
            loading={usage.status === 'loading' && !usage.stale}
            variant="slots"
            note={allowance ? `${allowance.plan} plan · limit from the live pricing. Your registered engines count toward it.` : undefined}
          />
          <Link to="/app/account/usage" viewTransition>See all your limits</Link>
        </section>
      )}

      {showMain && (
        <div className="reg-controls">
          <FilterPills ariaLabel="Filter" options={FILTERS} value={filter} onChange={(id) => setFilter(id as Filter)} />
          {isAdmin && (
            <label className="reg-review">
              <input type="checkbox" checked={review} onChange={(event) => setReview(event.target.checked)} />
              <span>Only waiting for review</span>
              <StatusChip>admin</StatusChip>
            </label>
          )}
        </div>
      )}

      {message && (
        <Notice
          tone={message.tone}
          title={message.title}
          action={message.href ? <Link to={message.href}>See the checks</Link> : undefined}
        >
          {message.text}
        </Notice>
      )}

      {status === 'loading' && !kept && (
        <div className="reg-skeleton" aria-busy="true" aria-live="polite">
          <span className="sr-only">Loading your engines</span>
          <Skeleton variant="tile" /><Skeleton variant="tile" /><Skeleton variant="tile" />
        </div>
      )}

      {unauthorized && <ErrorState variant="401" layout="card" />}

      {forbidden && (
        <Notice
          tone="error"
          title={review
            ? (isAdmin ? 'This key can’t moderate engines (403)' : 'Only administrators can filter by “waiting for review” (403)')
            : 'This key can’t list engines (403)'}
          action={review ? <Action size="sm" variant="secondary" onClick={() => setReview(false)}>Show my engines</Action> : <Link to="/app/account/keys">Manage API keys</Link>}
        >
          {review
            ? (isAdmin
              ? 'Your account is an administrator, but the API key behind this session doesn’t include “moderate engines”.'
              : 'The link you followed asks for every registration waiting for review. That list is for platform administrators. Your own registrations are still here.')
            : 'The API key behind this session doesn’t include the permission to read engines (engines:read).'}
        </Notice>
      )}

      {failure && unavailable && (
        <Notice
          tone={failure.tone}
          title={failure.status === 503 ? 'Accounts are unavailable right now (503 · accounts_unavailable)' : failure.title}
          action={<Action size="sm" variant="secondary" onClick={list.reload}>Try again</Action>}
        >
          {failure.status === 503
            ? 'Registrations are tied to accounts, so we can’t list them. Nothing has changed; try again in a moment.'
            : rows.length > 0 ? `${failure.text} You’re seeing the last list loaded.` : failure.text}
        </Notice>
      )}

      {status === 'ready' && rows.length === 0 && (
        <EmptyState
          icon={<Inbox />}
          dashed
          title={review ? 'Nothing is waiting for review' : 'You haven’t registered an engine'}
          action={review ? undefined : <Action to="/app/engines/new" variant="primary">Register an engine</Action>}
        >
          {review
            ? 'When someone requests publication of a deployment, it shows up here for administrators.'
            : 'Bring your own solver: register its deployment and use it in your jobs. It stays private until reviewed.'}
        </EmptyState>
      )}

      {showTable && visible.length === 0 && (
        <EmptyState icon={<Inbox />} title="No engine matches this filter">Try another filter.</EmptyState>
      )}

      {showTable && visible.length > 0 && (
        <>
          <DataTable label="Engine registrations" minWidth={820}>
            <thead>
              <tr>
                <th scope="col">Engine</th>
                <th scope="col">Use</th>
                <th scope="col">Publication</th>
                <th scope="col">Last check</th>
                <th scope="col"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody className="reg-rows">
              {visible.map((row) => {
                const key = registrationKey(row);
                const mine = row.namespace === username;
                const publication = publicationOf(row.status);
                const activity = activityOf(row);
                const working = busy === key;
                return (
                  <tr key={key} aria-label={`${row.name} ${row.version}`}>
                    <td>
                      <Link className="reg-name" to={registrationHref(row)}>{row.name}</Link>{' '}
                      <span className="reg-version">{row.version}</span>
                      <span className="reg-ref">{row.namespace} · <span title={row.digest}>{shortDigest(row.digest)}</span>{!mine && ' · published by another account'}</span>
                    </td>
                    <td data-label="Use"><StatusChip tone={activity.tone}>{activity.label}</StatusChip></td>
                    <td data-label="Publication"><StatusChip tone={publication.tone}>{publication.label}</StatusChip></td>
                    <td data-label="Last check"><LastCheck probe={known[key]} loading={probes.status === 'loading' && !(key in known)} /></td>
                    <td>
                      <span className="reg-actions">
                        {mine && !review && (
                          <Action size="sm" variant="link" busy={working} aria-label={`${row.active ? 'Deactivate' : 'Activate'} ${row.name} ${row.version}`} onClick={() => toggle(row)}>
                            {row.active ? 'Deactivate' : 'Activate'}
                          </Action>
                        )}
                        {mine && !review && (row.status === 'private' || row.status === 'rejected') && (
                          <Action size="sm" variant="link" disabled={working} aria-label={`Request publication of ${row.name} ${row.version}`} onClick={() => askPublication(row)}>
                            Request publication
                          </Action>
                        )}
                        {mine && !review && row.status !== 'published' && (
                          <Link to={registrationHref(row, '#credential')} aria-label={`Replace the credential of ${row.name} ${row.version}`}>Credential</Link>
                        )}
                        {review && isAdmin && <Link to="/app/admin/moderation" aria-label={`Review ${row.name} ${row.version}`}>Review</Link>}
                        {mine && !review && (
                          <Action size="sm" variant="link" className="reg-delete" disabled={working} aria-label={`Delete ${row.name} ${row.version}`} onClick={() => setPending({ kind: 'delete', row })}>
                            Delete
                          </Action>
                        )}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </DataTable>
          <span className="eng-muted">
            {review
              ? 'Shown because an owner requested publication and the registration is waiting for an administrator.'
              : 'Your registrations are private to your account. Published ones are shared by their owners with everyone.'}
          </span>
        </>
      )}

      {showMain && !review && (
        <section className="reg-lifecycle" aria-label="How registrations change">
          {LIFECYCLE.map((item) => (
            <div key={item.label}>
              <StatusChip tone={item.tone}>{item.label}</StatusChip>
              <span>{item.text}</span>
            </div>
          ))}
        </section>
      )}

      {pending?.kind === 'publish' && (
        <ConfirmDialog
          title={`Request publication of ${pending.row.name}?`}
          confirmLabel="Request publication"
          busy={busy === registrationKey(pending.row)}
          onConfirm={() => void applyPending()}
          onClose={() => setPending(null)}
        >
          <p>Administrators will then be able to discover and review this exact revision. It stays private until they approve it.</p>
        </ConfirmDialog>
      )}
      {pending?.kind === 'deactivate' && (
        <ConfirmDialog
          title={`Deactivate ${pending.row.name}?`}
          tone="warning"
          confirmLabel="Deactivate"
          busy={busy === registrationKey(pending.row)}
          onConfirm={() => void applyPending()}
          onClose={() => setPending(null)}
        >
          <p>It is published, so other people may be using it. Deactivating pauses it for everyone; its publication state doesn’t change. Administrators are told.</p>
        </ConfirmDialog>
      )}
      {pending?.kind === 'delete' && (
        <DeregisterDialog
          name={pending.row.name}
          version={pending.row.version}
          published={pending.row.status === 'published'}
          busy={busy === registrationKey(pending.row)}
          onConfirm={() => void applyPending()}
          onClose={() => setPending(null)}
        />
      )}
    </div>
  );
}
