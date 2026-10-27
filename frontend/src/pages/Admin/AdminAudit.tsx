import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ScrollText } from 'lucide-react';
import { apiClient } from '../../api/client';
import { Action } from '../../components/ui/Action';
import { EmptyState } from '../../components/ui/EmptyState';
import { FilterPills } from '../../components/ui/FilterPills';
import { Skeleton } from '../../components/ui/Skeleton';
import { useCopy } from '../../components/ui/useCopy';
import { formatDateTime } from '../../utils/format';
import { useResource } from '../../utils/useResource';
import { ViewSource } from '../Engines/EngineParts';
import { AdminFrame, AdminOnly, FailureNotice, Pager, Tag } from './AdminChrome';
import { AUDIT_FAMILIES, auditFamily, describeAdminFailure, describeAuditEvent, shortId, UUID, type AuditEvent, type AuditFamily } from './adminModel';

const PAGE = 100;

const FAMILY_TONE: Record<AuditFamily, 'dark' | 'info' | 'warning' | 'plain'> = {
  contract: 'dark',
  pricing: 'info',
  maintenance: 'warning',
  account: 'info',
  organization: 'plain',
  other: 'plain',
};

function AuditScreen() {
  const [family, setFamily] = useState<AuditFamily | ''>('');
  const [action, setAction] = useState('');
  const [applied, setApplied] = useState('');
  const [organization, setOrganization] = useState('');
  const [appliedOrganization, setAppliedOrganization] = useState('');
  const [organizationError, setOrganizationError] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [selectedId, setSelectedId] = useState('');
  const { copy, status } = useCopy();

  const list = useResource(`admin-audit:${applied}:${appliedOrganization}:${offset}`, () => apiClient.adminAudit({
    action: applied || undefined, organizationId: appliedOrganization || undefined, offset, limit: PAGE,
  }));
  const page = list.data ?? list.stale;
  const failure = list.status === 'error' ? describeAdminFailure(list.error, 'The audit log couldn’t be loaded') : null;

  const events = useMemo(() => (page?.events ?? []).filter((event) => !family || auditFamily(event.action) === family), [page, family]);
  const selected: AuditEvent | undefined = events.find((event) => event.id === selectedId) ?? events[0];
  const view = selected ? describeAuditEvent(selected) : null;
  const loading = list.status === 'loading' && !page;

  const applyFilters = (nextAction: string, nextOrganization: string) => {
    setApplied(nextAction.trim());
    setAppliedOrganization(nextOrganization.trim());
    setOffset(0);
    setSelectedId('');
  };

  const submit = () => {
    const wanted = organization.trim();
    if (wanted && !UUID.test(wanted)) {
      setOrganizationError('Use the organization’s id: a UUID such as 3f2a91c0-….');
      return;
    }
    setOrganizationError(null);
    applyFilters(action, wanted);
  };

  const onlyOrganization = (id: string) => {
    setOrganization(id);
    setOrganizationError(null);
    applyFilters(action, id);
  };

  return (
    <AdminFrame
      section="audit"
      trail={[{ label: 'Administration', to: '/app/admin' }, { label: 'Audit log' }]}
      title="Audit log"
      lede="Who changed contracts, pricing, accounts and platform maintenance, and when. Events recorded inside an organization, such as a change of sponsor, appear here too with the organization named."
    >
      <form className="adm-toolbar" role="search" onSubmit={(event) => { event.preventDefault(); submit(); }}>
        <FilterPills ariaLabel="Kind of event" options={AUDIT_FAMILIES.map((item) => ({ id: item.id, label: item.label }))} value={family} onChange={(id) => setFamily(id as AuditFamily | '')} />
        <label className="adm-select">
          <span>Exact action</span>
          <input value={action} onChange={(event) => setAction(event.target.value)} placeholder="contract.subscription.changed" autoComplete="off" spellCheck={false} />
        </label>
        <label className="adm-select">
          <span>Organization id (optional)</span>
          <input
            value={organization}
            onChange={(event) => { setOrganization(event.target.value); setOrganizationError(null); }}
            placeholder="Only this organization’s events"
            aria-invalid={organizationError ? true : undefined}
            aria-describedby={organizationError ? 'adm-audit-org-error' : undefined}
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <Action type="submit" size="sm" variant="secondary">Filter</Action>
        {applied && <Action size="sm" variant="link" onClick={() => { setAction(''); applyFilters('', appliedOrganization); }}>Clear “{applied}”</Action>}
        {appliedOrganization && <Action size="sm" variant="link" onClick={() => { setOrganization(''); applyFilters(applied, ''); }}>Clear organization filter</Action>}
      </form>
      {organizationError && <span id="adm-audit-org-error" className="adm-muted" role="alert">{organizationError}</span>}

      {failure && <FailureNotice failure={failure} onRetry={list.reload} />}
      {loading && <div aria-busy="true" className="adm-skeleton"><span className="sr-only">Loading the audit log</span><Skeleton variant="panel" /></div>}

      {page && events.length === 0 && (
        <EmptyState icon={<ScrollText />} title="No events for this filter" dashed>
          {applied || appliedOrganization || family ? 'Try another kind of event, or clear the filter.' : 'Nothing has been recorded yet.'}
        </EmptyState>
      )}

      {page && events.length > 0 && view && selected && (
        <>
          <div className="adm-split">
            <ol className="adm-timeline" aria-label="Events, newest first">
              {events.map((event) => {
                const kind = auditFamily(event.action);
                const item = describeAuditEvent(event);
                const on = event.id === selected.id;
                return (
                  <li key={event.id}>
                    <span className={`adm-dot is-${kind}`} aria-hidden="true" />
                    <button type="button" aria-pressed={on} className={`adm-event${on ? ' is-on' : ''}`} onClick={() => setSelectedId(event.id)}>
                      <span className="adm-event-head">
                        <Tag tone={FAMILY_TONE[kind]} mono>{event.action}</Tag>
                        {event.organizationId && <span className="adm-event-org"><Tag>{event.organizationSlug ?? shortId(event.organizationId)}</Tag></span>}
                        <span className="adm-muted">{formatDateTime(event.createdAt) ?? event.createdAt}</span>
                      </span>
                      <span>{item.text}</span>
                    </button>
                  </li>
                );
              })}
            </ol>

            <aside className="adm-aside" aria-label="Event detail">
              <strong>Event</strong>
              <dl className="adm-detail">
                <div><dt>Action</dt><dd className="is-mono">{selected.action}</dd></div>
                <div>
                  <dt>Actor</dt>
                  <dd>
                    {selected.actorId
                      ? <Link to={`/app/admin/users/${selected.actorId}`} className="is-mono" title={selected.actorId}>{shortId(selected.actorId)}</Link>
                      : 'The platform itself'}
                  </dd>
                </div>
                <div><dt>Target</dt><dd>{selected.targetType} · <span className="is-mono" title={selected.targetId ?? undefined}>{selected.targetId ? shortId(selected.targetId) : 'the platform'}</span></dd></div>
                {selected.organizationId && (
                  <div>
                    <dt>Organization</dt>
                    <dd>
                      {selected.organizationSlug && <>{selected.organizationSlug} · </>}
                      <span className="is-mono" title={selected.organizationId}>{shortId(selected.organizationId)}</span>
                      {selected.organizationId !== appliedOrganization && (
                        <> <Action size="sm" variant="link" onClick={() => onlyOrganization(selected.organizationId as string)}>Only this organization</Action></>
                      )}
                    </dd>
                  </div>
                )}
                <div><dt>When</dt><dd>{formatDateTime(selected.createdAt) ?? selected.createdAt}</dd></div>
                {view.facts.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
                <div><dt>Event id</dt><dd className="is-mono">{selected.id}</dd></div>
              </dl>
              {(view.before || view.after) && (
                <div className="adm-change" aria-label="Before and after">
                  <Tag>{view.before ?? '—'}</Tag><span aria-hidden="true">→</span><Tag tone="dark">{view.after ?? '—'}</Tag>
                </div>
              )}
              <Action size="sm" variant="link" onClick={() => void copy(selected.id, 'id')}>
                {status('id') === 'copied' ? 'Event id copied' : status('id') === 'failed' ? 'Couldn’t copy' : 'Copy event id'}
              </Action>
              <ViewSource value={selected} label="View source" />
            </aside>
          </div>
          <Pager offset={page.offset} limit={page.limit} total={page.total} shown={page.events.length} onPage={(next) => { setOffset(next); setSelectedId(''); }} noun="events" />
          {family && <span className="adm-muted">The kind filter narrows the events on this page; “Exact action” asks the gateway.</span>}
        </>
      )}
    </AdminFrame>
  );
}

/** admin-audit: the platform’s append-only audit log, newest first, with the detail of the event you pick. */
export function AdminAudit() {
  return <AdminOnly><AuditScreen /></AdminOnly>;
}
