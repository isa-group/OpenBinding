import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Download } from 'lucide-react';
import { platformApi } from '../../api/platform';
import type { Organization, OrganizationAuditEvent, OrganizationAuditPage } from '../../api/platform';
import { Action } from '../../components/ui/Action';
import { Notice } from '../../components/ui/Notice';
import { Skeleton } from '../../components/ui/Skeleton';
import { useCopy } from '../../components/ui/useCopy';
import { useAuth } from '../../contexts/auth';
import { formatDateTime } from '../../utils/format';
import { useResource } from '../../utils/useResource';
import { AUDIT_KINDS, KNOWN_ACTIONS, actionLabel, changesOf, describeEvent, detailRows, kindOf, toCsv, type DetailValue } from './auditModel';
import { atLeast, personName } from './orgModel';
import { classifyAuthError, generalFailure, isForbidden, marker } from './orgErrors';
import { NeutralGate, PageSkeleton, SelectField } from './parts';
import { OrgSettingsLayout } from './OrgSettingsLayout';
import { useRouteOrganization } from './useRouteOrganization';
import './Organization.css';

const PAGE_SIZE = 50;
const NOT_RECORDED = '__none';

interface Loaded {
  page: OrganizationAuditPage | null;
  /** When the page arrived, for the “last 30 days” filter (the clock is not read while rendering). */
  loadedAt: number;
}

async function loadAudit(slug: string, permitted: boolean, action: string, offset: number): Promise<Loaded> {
  return {
    page: permitted ? await platformApi.organizationAudit(slug, { action: action || undefined, offset, limit: PAGE_SIZE }) : null,
    loadedAt: Date.now(),
  };
}

function download(contents: string, filename: string) {
  const url = URL.createObjectURL(new Blob([contents], { type: 'text/csv' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function DetailView({ value }: { value: DetailValue }) {
  if (value.kind === 'text') return <>{value.text}</>;
  if (value.kind === 'list') {
    return value.items.length === 0
      ? <>none</>
      : <ul className="org-tl-changes">{value.items.map((item, position) => <li key={position}><DetailView value={item} /></li>)}</ul>;
  }
  return value.rows.length === 0
    ? <>none</>
    : <dl className="org-tl-nested">{value.rows.map((row) => <div key={row.label}><dt>{row.label}</dt><dd><DetailView value={row.value} /></dd></div>)}</dl>;
}

function EventCard({ event, who, nameOf, open, onToggle }: {
  event: OrganizationAuditEvent;
  who: string;
  nameOf: (userId: string) => string;
  open: boolean;
  onToggle: () => void;
}) {
  const { copy, status } = useCopy();
  const kind = AUDIT_KINDS[kindOf(event.action)];
  const detailId = `audit-${event.id}`;
  const batch = changesOf(event);
  const extra = detailRows(event.detail, ['changes']);
  const copied = status(event.id);

  return (
    <li className="org-tl-item">
      <span className="org-tl-dot" style={{ background: kind.colour }} aria-hidden="true" />
      <div className="org-tl-card">
        <button type="button" className="org-tl-head" aria-expanded={open} aria-controls={detailId} onClick={onToggle}>
          <span className="org-kind" data-kind={kindOf(event.action)}>{kind.label}</span>
          <span className="org-tl-text">{describeEvent(event)}</span>
          <span className="org-tl-when">{formatDateTime(event.createdAt) ?? event.createdAt}</span>
          <span aria-hidden="true" className="org-tl-caret">{open ? '−' : '+'}</span>
        </button>
        {open && (
          <div id={detailId} className="org-tl-body">
            <dl>
              <dt>Who</dt><dd>{who}</dd>
              <dt>Action</dt><dd><code>{event.action}</code></dd>
              <dt>Target</dt><dd>{event.targetType}{event.targetId ? <> · <code>{event.targetId}</code></> : null}</dd>
              {batch.length > 0 && (
                <>
                  <dt>Changes</dt>
                  <dd>
                    <ul className="org-tl-changes">
                      {batch.map((change) => <li key={change.userId}>{nameOf(change.userId)} → {change.role ?? 'removed'}</li>)}
                    </ul>
                  </dd>
                </>
              )}
              {extra.map((row) => (
                <div key={row.label} className="org-tl-fact">
                  <dt>{row.label}</dt><dd><DetailView value={row.value} /></dd>
                </div>
              ))}
              <dt>Event</dt><dd><code>{event.id}</code></dd>
            </dl>
            <button type="button" className="org-link-button" onClick={() => void copy(event.id, event.id)}>
              {copied === 'copied' ? 'Event reference copied' : copied === 'failed' ? 'Copy failed' : 'Copy event reference'}
            </button>
          </div>
        )}
      </div>
    </li>
  );
}

function AuditBody({ organization }: { organization: Organization }) {
  const { user } = useAuth();
  const slug = organization.slug;
  const role = organization.effective_role;
  const permitted = atLeast(role, 'ADMIN');
  const me = user ? { id: user.id, username: user.username } : null;

  const [action, setAction] = useState('');
  const [offset, setOffset] = useState(0);
  const [actor, setActor] = useState('');
  const [period, setPeriod] = useState('all');
  const [openId, setOpenId] = useState('');
  const [exported, setExported] = useState('');

  const data = useResource<Loaded>(`audit:${slug}:${permitted}:${action}:${offset}`, () => loadAudit(slug, permitted, action, offset));
  const people = useResource(`audit-people:${slug}`, () => platformApi.members(slug).catch(() => []));

  const failure = data.status === 'error' ? classifyAuthError(data.error) : null;
  const refused = failure !== null && isForbidden(failure);
  const page = data.data?.page ?? null;
  const events = page?.events ?? [];
  const nameOf = (userId: string) => personName(userId, people.data ?? [], me, `User ${userId.slice(0, 8)}…`);
  const who = (event: OrganizationAuditEvent) => (event.actorId ? nameOf(event.actorId) : 'Not recorded');

  const actors = [...new Set(events.map((event) => event.actorId))];
  const days = period === 'all' ? null : Number(period);
  const visible = events.filter((event) => (
    (!actor || (actor === NOT_RECORDED ? event.actorId === null : event.actorId === actor))
    && (days === null || (data.data !== undefined && data.data.loadedAt - Date.parse(event.createdAt) <= days * 86_400_000))
  ));
  const filtered = Boolean(action || actor || period !== 'all');
  const actionOptions = [
    ...KNOWN_ACTIONS,
    ...[...new Set(events.map((event) => event.action))].filter((item) => !KNOWN_ACTIONS.some((known) => known.action === item)).map((item) => ({ action: item, label: actionLabel(item) })),
  ];
  const from = (page?.offset ?? 0) + 1;
  const to = (page?.offset ?? 0) + events.length;
  const total = page?.total ?? 0;

  const clear = () => { setAction(''); setActor(''); setPeriod('all'); setOffset(0); };

  return (
    <OrgSettingsLayout
      organization={organization}
      section="audit"
      title="Audit log"
      lede={`Who did what in ${organization.name}.`}
      actions={permitted && !refused ? (
        <Action
          variant="secondary"
          disabled={visible.length === 0}
          onClick={() => {
            download(toCsv(visible), `${slug}-audit.csv`);
            setExported(`Exported ${visible.length} event${visible.length === 1 ? '' : 's'} as CSV: this page, with the filters you set.`);
          }}
        >
          <Download aria-hidden="true" className="org-inline-icon" />Export this view
        </Action>
      ) : undefined}
    >
      {(!permitted || refused) && (
        <div className="org-forbidden" role="alert">
          <strong>The audit log needs ADMIN (403)</strong>
          <span>Your role in {organization.name} is {role ?? 'none'}. An owner or admin can raise it in <Link to={`/app/${slug}/settings/members`}>Members</Link>.</span>
        </div>
      )}

      {exported && <Notice tone="success">{exported}</Notice>}

      {permitted && !refused && (
        <>
          <div className="org-filters">
            <SelectField label="Action" value={action} onChange={(value) => { setAction(value); setOffset(0); setOpenId(''); }}>
              <option value="">All actions</option>
              {actionOptions.map((item) => <option key={item.action} value={item.action}>{item.label} · {item.action}</option>)}
            </SelectField>
            <SelectField label="Actor" value={actor} onChange={setActor}>
              <option value="">Anyone</option>
              {actors.map((item) => (
                <option key={item ?? NOT_RECORDED} value={item ?? NOT_RECORDED}>{item ? nameOf(item) : 'Not recorded'}</option>
              ))}
            </SelectField>
            <SelectField label="Period" value={period} onChange={setPeriod}>
              <option value="all">All time</option>
              <option value="30">Last 30 days</option>
              <option value="90">Last 90 days</option>
            </SelectField>
            <span className="org-muted org-filters-note">Action is filtered by the server; actor and period are filtered in this view.</span>
          </div>

          {data.status === 'loading' && (
            <div aria-busy="true" role="status" className="org-skeleton"><span className="sr-only">Loading the audit log…</span><Skeleton variant="tile" /><Skeleton variant="tile" /><Skeleton variant="tile" /></div>
          )}

          {failure && !refused && (
            <Notice tone="error" action={<Action variant="secondary" size="sm" onClick={data.reload}>Retry</Action>}>
              {failure.kind === 'not-found'
                ? `This organization no longer exists${marker(failure)}.`
                : `The audit log couldn’t be loaded${marker(failure)}.${failure.kind === 'unavailable' || failure.kind === 'network' ? ` ${generalFailure(failure, 'nothing is shown')}` : ''}`}
            </Notice>
          )}

          {data.status === 'ready' && visible.length === 0 && (
            <div className="org-empty is-center">
              {filtered
                ? <>No events match these filters. <button type="button" className="org-link-button" onClick={clear}>Clear filters</button></>
                : 'No events have been recorded for this organization yet.'}
            </div>
          )}

          {visible.length > 0 && (
            <ol className="org-timeline" aria-label="Audit events, newest first">
              {visible.map((event) => (
                <EventCard
                  key={event.id}
                  event={event}
                  who={who(event)}
                  nameOf={nameOf}
                  open={openId === event.id}
                  onToggle={() => setOpenId(openId === event.id ? '' : event.id)}
                />
              ))}
            </ol>
          )}

          {page && events.length > 0 && (
            <div className="org-pager">
              <span>
                Showing {from}–{to} of {total} · newest first
                {visible.length !== events.length && ` · ${visible.length} match the actor and period filters`}
              </span>
              <span className="org-pager-buttons">
                <Action variant="ghost" size="sm" disabled={offset === 0} onClick={() => { setOffset(Math.max(0, offset - PAGE_SIZE)); setOpenId(''); }}>Previous</Action>
                <Action variant="ghost" size="sm" disabled={to >= total} onClick={() => { setOffset(offset + PAGE_SIZE); setOpenId(''); }}>Next</Action>
              </span>
            </div>
          )}
        </>
      )}
    </OrgSettingsLayout>
  );
}

/** The audit log of an organization (`org-audit`, `/app/:org/settings/audit`); ADMIN or above. */
export function OrgAudit() {
  const { organization, waiting } = useRouteOrganization();
  if (waiting) return <div className="org-page"><PageSkeleton /></div>;
  if (!organization) return <div className="org-page"><NeutralGate /></div>;
  return <AuditBody organization={organization} />;
}
