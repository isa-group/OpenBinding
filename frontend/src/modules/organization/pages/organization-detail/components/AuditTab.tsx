import { useState } from 'react';
import { Link } from 'react-router-dom';
import { MdDownload } from 'react-icons/md';
import { organizationClient } from '../../../api/organizationClient';
import type {
  Organization,
  OrganizationAuditEvent,
  OrganizationAuditPage,
} from '../../../api/organizationClient';
import { Action } from '../../../../core/components/action-button';
import { Notice } from '../../../../core/components/notice';
import { Skeleton } from '../../../../core/components/skeleton';
import { useCopy } from '../../../../core/hooks/useCopy';
import { useAuth } from '../../../../auth/hooks/useAuth';
import { formatDateTime } from '../../../../core/utils/format';
import { useResource } from '../../../../core/hooks/useResource';
import {
  AUDIT_KINDS,
  KNOWN_ACTIONS,
  actionLabel,
  changesOf,
  describeEvent,
  detailRows,
  kindOf,
  toCsv,
  type DetailValue,
} from '../auditModel';
import { atLeast, personName } from '../../../utils/org-tree';
import { isForbidden } from '../orgErrors';
import { generalFailure } from '../../../../core/utils/general-failure';
import { classifyAuthError, marker } from '../../../../core/api/errors';
import { SelectField } from '../../../../core/components/select-field';
import TabCard from './TabCard';

const KIND_CLASS: Record<string, string> = {
  organization: 'bg-tp-accent-hover text-tp-on-primary',
  members: 'bg-tp-cream-deeper text-tp-accent-hover',
  problems: 'border-tp-severity-success-border bg-tp-severity-success-bg text-tp-success-text',
  content: 'border-tp-severity-warning-border bg-tp-severity-warning-bg text-tp-warning-text',
  other: 'border-tp-hairline bg-tp-surface text-tp-slate',
};

const LINK_BUTTON =
  'cursor-pointer text-sm font-medium text-tp-accent underline underline-offset-2';

const PAGE_SIZE = 50;
const NOT_RECORDED = '__none';

interface Loaded {
  page: OrganizationAuditPage | null;
  /** When the page arrived, for the “last 30 days” filter (the clock is not read while rendering). */
  loadedAt: number;
}

async function loadAudit(
  slug: string,
  permitted: boolean,
  action: string,
  offset: number
): Promise<Loaded> {
  return {
    page: permitted
      ? await organizationClient.organizationAudit(slug, {
          action: action || undefined,
          offset,
          limit: PAGE_SIZE,
        })
      : null,
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
    return value.items.length === 0 ? (
      <>none</>
    ) : (
      <ul className="m-0 list-disc pl-4">
        {value.items.map((item, position) => (
          <li key={position}>
            <DetailView value={item} />
          </li>
        ))}
      </ul>
    );
  }
  return value.rows.length === 0 ? (
    <>none</>
  ) : (
    <dl className="m-0 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5">
      {value.rows.map(row => (
        <div key={row.label} className="contents">
          <dt>{row.label}</dt>
          <dd>
            <DetailView value={row.value} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

function EventCard({
  event,
  who,
  nameOf,
  open,
  onToggle,
}: {
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
    <li className="relative pb-3.5 pl-9 before:absolute before:top-0 before:bottom-0 before:left-[11px] before:w-0.5 before:bg-tp-hairline-soft">
      <span
        className="absolute top-2.5 left-0.5 h-5 w-5 rounded-full border-[3px] border-tp-surface"
        style={{ background: kind.colour }}
        aria-hidden="true"
      />
      <div className="relative overflow-hidden rounded-xl border border-tp-hairline bg-tp-canvas">
        <button
          type="button"
          className="flex w-full cursor-pointer flex-wrap items-center gap-2.5 bg-tp-canvas px-3.5 py-3 text-left text-tp-ink hover:bg-tp-surface"
          aria-expanded={open}
          aria-controls={detailId}
          onClick={onToggle}
        >
          <span
            className={`inline-flex rounded-full border border-transparent px-2.5 py-px text-[11px] font-semibold ${KIND_CLASS[kindOf(event.action)]}`}
            data-kind={kindOf(event.action)}
          >
            {kind.label}
          </span>
          <span className="min-w-[200px] flex-1 text-sm">{describeEvent(event)}</span>
          <span className="text-xs text-tp-steel">
            {formatDateTime(event.createdAt) ?? event.createdAt}
          </span>
          <span aria-hidden="true" className="text-tp-steel">
            {open ? '−' : '+'}
          </span>
        </button>
        {open && (
          <div
            id={detailId}
            className="flex flex-col items-start gap-2 border-t border-tp-hairline-soft bg-tp-surface px-3.5 py-3"
          >
            <dl className="m-0 grid w-full grid-cols-[120px_1fr] gap-x-3 gap-y-1.5 text-[13px] [&_code]:font-mono [&_code]:text-xs [&_dd]:m-0 [&_dd]:min-w-0 [&_dd]:[overflow-wrap:anywhere] [&_dt]:text-tp-steel">
              <dt>Who</dt>
              <dd>{who}</dd>
              <dt>Action</dt>
              <dd>
                <code>{event.action}</code>
              </dd>
              <dt>Target</dt>
              <dd>{event.targetType}</dd>
              {batch.length > 0 && (
                <>
                  <dt>Changes</dt>
                  <dd>
                    <ul className="m-0 list-disc pl-4">
                      {batch.map(change => (
                        <li key={change.userId}>
                          {nameOf(change.userId)} → {change.role ?? 'removed'}
                        </li>
                      ))}
                    </ul>
                  </dd>
                </>
              )}
              {extra.map(row => (
                <div key={row.label} className="contents">
                  <dt>{row.label}</dt>
                  <dd>
                    <DetailView value={row.value} />
                  </dd>
                </div>
              ))}{' '}
            </dl>
            <button
              type="button"
              className={LINK_BUTTON}
              onClick={() => void copy(event.id, event.id)}
            >
              {copied === 'copied'
                ? 'Event reference copied'
                : copied === 'failed'
                  ? 'Copy failed'
                  : 'Copy event reference'}
            </button>
          </div>
        )}
      </div>
    </li>
  );
}

export default function AuditBody({ organization }: { organization: Organization }) {
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

  const data = useResource<Loaded>(`audit:${slug}:${permitted}:${action}:${offset}`, () =>
    loadAudit(slug, permitted, action, offset)
  );
  const people = useResource(`audit-people:${slug}`, () =>
    organizationClient.members(slug).catch(() => [])
  );

  const failure = data.status === 'error' ? classifyAuthError(data.error) : null;
  const refused = failure !== null && isForbidden(failure);
  const page = data.data?.page ?? null;
  const events = page?.events ?? [];
  const nameOf = (userId: string) => personName(userId, people.data ?? [], me, 'Former member');
  const who = (event: OrganizationAuditEvent) =>
    event.actorId ? nameOf(event.actorId) : 'Unknown person';

  const actors = [...new Set(events.map(event => event.actorId))];
  const days = period === 'all' ? null : Number(period);
  const visible = events.filter(
    event =>
      (!actor || (actor === NOT_RECORDED ? event.actorId === null : event.actorId === actor)) &&
      (days === null ||
        (data.data !== undefined &&
          data.data.loadedAt - Date.parse(event.createdAt) <= days * 86_400_000))
  );
  const filtered = Boolean(action || actor || period !== 'all');
  const actionOptions = [
    ...KNOWN_ACTIONS,
    ...[...new Set(events.map(event => event.action))]
      .filter(item => !KNOWN_ACTIONS.some(known => known.action === item))
      .map(item => ({ action: item, label: actionLabel(item) })),
  ];
  const from = (page?.offset ?? 0) + 1;
  const to = (page?.offset ?? 0) + events.length;
  const total = page?.total ?? 0;

  const clear = () => {
    setAction('');
    setActor('');
    setPeriod('all');
    setOffset(0);
  };

  return (
    <TabCard
      id="audit"
      title="Audit log"
      lede={`Who did what in ${organization.name}.`}
      actions={
        permitted && !refused ? (
          <Action
            variant="secondary"
            disabled={visible.length === 0}
            onClick={() => {
              download(toCsv(visible), `${slug}-audit.csv`);
              setExported(
                `Exported ${visible.length} event${visible.length === 1 ? '' : 's'} as CSV: this page, with the filters you set.`
              );
            }}
          >
            <MdDownload aria-hidden="true" className="h-4 w-4" />
            Export this view
          </Action>
        ) : undefined
      }
    >
      {(!permitted || refused) && (
        <div
          className="flex flex-col gap-1 rounded-md border border-tp-severity-error-border bg-tp-severity-error-bg px-4 py-3 text-sm text-tp-error-text [&_a]:font-medium [&_a]:underline"
          role="alert"
        >
          <strong>The audit log needs ADMIN (403)</strong>
          <span>
            Your role in {organization.name} is {role ?? 'none'}. An owner or admin can raise it in{' '}
            <Link to={`/orgs/${slug}/members`}>Members</Link>.
          </span>
        </div>
      )}

      {exported && <Notice tone="success">{exported}</Notice>}

      {permitted && !refused && (
        <>
          <div className="mb-4 grid gap-4 sm:grid-cols-3">
            <SelectField
              label="Action"
              value={action}
              onChange={value => {
                setAction(value);
                setOffset(0);
                setOpenId('');
              }}
            >
              <option value="">All actions</option>
              {actionOptions.map(item => (
                <option key={item.action} value={item.action}>
                  {item.label} · {item.action}
                </option>
              ))}
            </SelectField>
            <SelectField label="Actor" value={actor} onChange={setActor}>
              <option value="">Anyone</option>
              {actors.map(item => (
                <option key={item ?? NOT_RECORDED} value={item ?? NOT_RECORDED}>
                  {item ? nameOf(item) : 'Not recorded'}
                </option>
              ))}
            </SelectField>
            <SelectField label="Period" value={period} onChange={setPeriod}>
              <option value="all">All time</option>
              <option value="30">Last 30 days</option>
              <option value="90">Last 90 days</option>
            </SelectField>
            <span className="text-xs text-tp-steel sm:col-span-3">
              Action is filtered by the server; actor and period are filtered in this view.
            </span>
          </div>

          {data.status === 'loading' && (
            <div aria-busy="true" role="status" className="flex flex-col gap-3">
              <span className="sr-only">Loading the audit log…</span>
              <Skeleton variant="tile" />
              <Skeleton variant="tile" />
              <Skeleton variant="tile" />
            </div>
          )}

          {failure && !refused && (
            <Notice
              tone="error"
              action={
                <Action variant="secondary" size="sm" onClick={data.reload}>
                  Retry
                </Action>
              }
            >
              {failure.kind === 'not-found'
                ? `This organization no longer exists${marker(failure)}.`
                : `The audit log couldn’t be loaded${marker(failure)}.${failure.kind === 'unavailable' || failure.kind === 'network' ? ` ${generalFailure(failure, 'nothing is shown')}` : ''}`}
            </Notice>
          )}

          {data.status === 'ready' && visible.length === 0 && (
            <div className="rounded-xl border border-dashed border-tp-hairline px-4 py-10 text-center text-sm text-tp-steel">
              {filtered ? (
                <>
                  No events match these filters.{' '}
                  <button type="button" className={LINK_BUTTON} onClick={clear}>
                    Clear filters
                  </button>
                </>
              ) : (
                'No events have been recorded for this organization yet.'
              )}
            </div>
          )}

          {visible.length > 0 && (
            <ol className="relative m-0 list-none p-0" aria-label="Audit events, newest first">
              {visible.map(event => (
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
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-tp-steel">
              <span>
                Showing {from}–{to} of {total} · newest first
                {visible.length !== events.length &&
                  ` · ${visible.length} match the actor and period filters`}
              </span>
              <span className="flex gap-2">
                <Action
                  variant="ghost"
                  size="sm"
                  disabled={offset === 0}
                  onClick={() => {
                    setOffset(Math.max(0, offset - PAGE_SIZE));
                    setOpenId('');
                  }}
                >
                  Previous
                </Action>
                <Action
                  variant="ghost"
                  size="sm"
                  disabled={to >= total}
                  onClick={() => {
                    setOffset(offset + PAGE_SIZE);
                    setOpenId('');
                  }}
                >
                  Next
                </Action>
              </span>
            </div>
          )}
        </>
      )}
    </TabCard>
  );
}
