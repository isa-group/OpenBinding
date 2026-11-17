import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { MdArticle } from 'react-icons/md';
import { Action } from '../../../core/components/action-button';
import { EmptyState } from '../../../core/components/empty-state';
import { FilterPills } from '../../../core/components/filter-pills';
import { Skeleton } from '../../../core/components/skeleton';
import { useCopy } from '../../../core/hooks/useCopy';
import { formatDateTime } from '../../../../utils/format';
import { useResource } from '../../../../utils/useResource';
import { ViewSource } from '../../../engine/components/engine-parts';
import { adminUserPath } from '../../../../routes/paths/admin';
import { useAdminApi } from '../../api/adminApi';
import {
  AUDIT_FAMILIES,
  auditFamily,
  describeAdminFailure,
  describeAuditEvent,
  shortId,
  UUID,
  type AuditEvent,
  type AuditFamily,
} from '../../utils/adminModel';
import {
  FACTS,
  FailureNotice,
  FIELD,
  FILL,
  INPUT,
  LABEL,
  Loading,
  MUTED,
  Pager,
  PICK,
  SectionHeader,
  Tag,
  TOOLBAR,
} from '../admin-parts';

const PAGE = 100;

const FAMILY_TONE: Record<AuditFamily, 'dark' | 'info' | 'warning' | 'plain'> = {
  contract: 'dark',
  pricing: 'info',
  maintenance: 'warning',
  account: 'info',
  organization: 'plain',
  other: 'plain',
};

/** The dot of an event's kind on the timeline. */
const FAMILY_DOT: Record<AuditFamily, string> = {
  contract: FILL.dark,
  pricing: FILL.info,
  maintenance: FILL.warning,
  account: FILL.info,
  organization: FILL.muted,
  other: FILL.muted,
};

/** The Audit section of `/admin`: the platform’s append-only audit log, newest first, with the detail of the event you pick. */
export default function AuditSection() {
  const api = useAdminApi();
  const [family, setFamily] = useState<AuditFamily | ''>('');
  const [action, setAction] = useState('');
  const [applied, setApplied] = useState('');
  const [organization, setOrganization] = useState('');
  const [appliedOrganization, setAppliedOrganization] = useState('');
  const [organizationError, setOrganizationError] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [selectedId, setSelectedId] = useState('');
  const { copy, status } = useCopy();

  const list = useResource(`admin-audit:${applied}:${appliedOrganization}:${offset}`, () =>
    api.adminAudit({
      action: applied || undefined,
      organizationId: appliedOrganization || undefined,
      offset,
      limit: PAGE,
    })
  );
  const page = list.data ?? list.stale;
  const failure =
    list.status === 'error'
      ? describeAdminFailure(list.error, 'The audit log couldn’t be loaded')
      : null;

  const events = useMemo(
    () => (page?.events ?? []).filter(event => !family || auditFamily(event.action) === family),
    [page, family]
  );
  const selected: AuditEvent | undefined =
    events.find(event => event.id === selectedId) ?? events[0];
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
    <>
      <SectionHeader
        title="Audit log"
        lede="Who changed contracts, pricing, accounts and platform maintenance, and when. Events recorded inside an organization, such as a member change, appear here too with the organization named."
      />
      <form
        className={TOOLBAR}
        role="search"
        onSubmit={event => {
          event.preventDefault();
          submit();
        }}
      >
        <FilterPills
          ariaLabel="Kind of event"
          options={AUDIT_FAMILIES.map(item => ({ id: item.id, label: item.label }))}
          value={family}
          onChange={id => setFamily(id as AuditFamily | '')}
        />
        <label className={`${FIELD} flex-[1_1_14rem]`}>
          <span className={LABEL}>Exact action</span>
          <input
            className={INPUT}
            value={action}
            onChange={event => setAction(event.target.value)}
            placeholder="contract.subscription.changed"
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <label className={`${FIELD} flex-[1_1_14rem]`}>
          <span className={LABEL}>Organization id (optional)</span>
          <input
            className={INPUT}
            value={organization}
            onChange={event => {
              setOrganization(event.target.value);
              setOrganizationError(null);
            }}
            placeholder="Only this organization’s events"
            aria-invalid={organizationError ? true : undefined}
            aria-describedby={organizationError ? 'adm-audit-org-error' : undefined}
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <Action type="submit" size="sm" variant="secondary">
          Filter
        </Action>
        {applied && (
          <Action
            size="sm"
            variant="link"
            onClick={() => {
              setAction('');
              applyFilters('', appliedOrganization);
            }}
          >
            Clear “{applied}”
          </Action>
        )}
        {appliedOrganization && (
          <Action
            size="sm"
            variant="link"
            onClick={() => {
              setOrganization('');
              applyFilters(applied, '');
            }}
          >
            Clear organization filter
          </Action>
        )}
      </form>
      {organizationError && (
        <span id="adm-audit-org-error" className="text-[13px] text-tp-error-text" role="alert">
          {organizationError}
        </span>
      )}

      {failure && <FailureNotice failure={failure} onRetry={list.reload} />}
      {loading && (
        <Loading label="Loading the audit log">
          <Skeleton variant="panel" />
        </Loading>
      )}

      {page && events.length === 0 && (
        <EmptyState icon={<MdArticle />} title="No events for this filter" dashed>
          {applied || appliedOrganization || family
            ? 'Try another kind of event, or clear the filter.'
            : 'Nothing has been recorded yet.'}
        </EmptyState>
      )}

      {page && events.length > 0 && view && selected && (
        <>
          <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
            <ol className="flex min-w-0 flex-col gap-2" aria-label="Events, newest first">
              {events.map(event => {
                const kind = auditFamily(event.action);
                const item = describeAuditEvent(event);
                const on = event.id === selected.id;
                return (
                  <li key={event.id} className="flex items-start gap-3">
                    <span
                      className={`mt-4 h-2.5 w-2.5 shrink-0 rounded-full ${FAMILY_DOT[kind]}`}
                      aria-hidden="true"
                    />
                    <button
                      type="button"
                      aria-pressed={on}
                      className={PICK}
                      onClick={() => setSelectedId(event.id)}
                    >
                      <span className="flex flex-wrap items-center gap-2">
                        <Tag tone={FAMILY_TONE[kind]} mono>
                          {event.action}
                        </Tag>
                        {event.organizationId && (
                          <Tag>{event.organizationSlug ?? shortId(event.organizationId)}</Tag>
                        )}
                        <span className={MUTED}>
                          {formatDateTime(event.createdAt) ?? event.createdAt}
                        </span>
                      </span>
                      <span className="text-tp-ink">{item.text}</span>
                    </button>
                  </li>
                );
              })}
            </ol>

            <aside
              className="flex min-w-0 flex-col items-start gap-3 rounded-xl border border-tp-hairline bg-tp-canvas p-5 lg:sticky lg:top-24"
              aria-label="Event detail"
            >
              <strong className="text-sm text-tp-ink">Event</strong>
              <dl className={`${FACTS} w-full sm:grid-cols-1`}>
                <div>
                  <dt>Action</dt>
                  <dd className="font-mono">{selected.action}</dd>
                </div>
                <div>
                  <dt>Actor</dt>
                  <dd>
                    {selected.actorId ? (
                      <Link
                        to={adminUserPath(selected.actorId)}
                        className="cursor-pointer font-mono text-tp-accent hover:underline"
                        title={selected.actorId}
                      >
                        {shortId(selected.actorId)}
                      </Link>
                    ) : (
                      'The platform itself'
                    )}
                  </dd>
                </div>
                <div>
                  <dt>Target</dt>
                  <dd>
                    {selected.targetType} ·{' '}
                    <span className="font-mono" title={selected.targetId ?? undefined}>
                      {selected.targetId ? shortId(selected.targetId) : 'the platform'}
                    </span>
                  </dd>
                </div>
                {selected.organizationId && (
                  <div>
                    <dt>Organization</dt>
                    <dd>
                      {selected.organizationSlug && <>{selected.organizationSlug} · </>}
                      <span className="font-mono" title={selected.organizationId}>
                        {shortId(selected.organizationId)}
                      </span>
                      {selected.organizationId !== appliedOrganization && (
                        <>
                          {' '}
                          <Action
                            size="sm"
                            variant="link"
                            onClick={() => onlyOrganization(selected.organizationId as string)}
                          >
                            Only this organization
                          </Action>
                        </>
                      )}
                    </dd>
                  </div>
                )}
                <div>
                  <dt>When</dt>
                  <dd>{formatDateTime(selected.createdAt) ?? selected.createdAt}</dd>
                </div>
                {view.facts.map(([label, value]) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
                <div>
                  <dt>Event id</dt>
                  <dd className="font-mono">{selected.id}</dd>
                </div>
              </dl>
              {(view.before || view.after) && (
                <div className="flex flex-wrap items-center gap-2" aria-label="Before and after">
                  <Tag>{view.before ?? '—'}</Tag>
                  <span aria-hidden="true">→</span>
                  <Tag tone="dark">{view.after ?? '—'}</Tag>
                </div>
              )}
              <Action size="sm" variant="link" onClick={() => void copy(selected.id, 'id')}>
                {status('id') === 'copied'
                  ? 'Event id copied'
                  : status('id') === 'failed'
                    ? 'Couldn’t copy'
                    : 'Copy event id'}
              </Action>
              <ViewSource value={selected} label="View source" />
            </aside>
          </div>
          <Pager
            offset={page.offset}
            limit={page.limit}
            total={page.total}
            shown={page.events.length}
            onPage={next => {
              setOffset(next);
              setSelectedId('');
            }}
            noun="events"
          />
          {family && (
            <span className={MUTED}>
              The kind filter narrows the events on this page; “Exact action” asks the gateway.
            </span>
          )}
        </>
      )}
    </>
  );
}
