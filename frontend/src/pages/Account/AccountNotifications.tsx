import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Bell, BellOff, CheckCheck, CircleCheck, FileText, Mail, MoveRight } from 'lucide-react';
import { apiClient } from '../../api/client';
import type { Notification, NotificationPreferences } from '../../api/auth';
import { Action } from '../../components/ui/Action';
import { EmptyState } from '../../components/ui/EmptyState';
import { FilterPills } from '../../components/ui/FilterPills';
import { Notice } from '../../components/ui/Notice';
import { Skeleton } from '../../components/ui/Skeleton';
import { Switch } from '../../components/ui/Switch';
import { useAuth } from '../../contexts/auth';
import { formatDate, formatDateTime } from '../../utils/format';
import { useResource } from '../../utils/useResource';
import { classifyAuthError, fallbackMessage } from './accountErrors';
import { AccountLayout, LoadFailure, PermissionNotice } from './AccountLayout';
import { contractChange, groupOf, NOTIFICATION_FILTERS, NOTIFICATIONS_UPDATED, unreadCount, type NotificationGroup } from './notificationsModel';
import { SponsorRequestsForYou } from './SponsorRequestsForYou';
import './AccountNotifications.css';

const ICONS: Record<NotificationGroup, typeof Bell> = { contract: FileText, job: CircleCheck, invite: Mail, other: Bell };

/** The gateway keeps four delivery preferences. The first is the one the design puts forward; the rest stay editable. */
const PREFERENCES: ReadonlyArray<{ key: keyof NotificationPreferences; label: string; description: string; aria: string }> = [
  { key: 'email_contract_changes', label: 'Contract changes', description: 'Email me when my plan, add-ons or pricing version change.', aria: 'Email me about contract changes' },
  { key: 'email_invitations', label: 'Invitations', description: 'Email me when I’m invited to an organization.', aria: 'Email me about invitations' },
  { key: 'email_job_failures', label: 'Failed jobs', description: 'Email me when a job I started fails.', aria: 'Email me about failed jobs' },
  { key: 'inbox', label: 'Keep the inbox', description: 'Keep notifications in this inbox for seven days.', aria: 'Keep notifications in the account inbox' },
];

/** The header bell listens for this to refresh its count. */
function announceChange() {
  window.dispatchEvent(new CustomEvent(NOTIFICATIONS_UPDATED));
}

function Detail({ item, onMarkRead, busy }: { item: Notification; onMarkRead: () => void; busy: boolean }) {
  const change = contractChange(item);
  const group = groupOf(item.kind);
  return (
    <div className="notif-detail">
      {change && (
        <>
          <div className="notif-change" role="group" aria-label="Before and after">
            <div><span>Before</span><strong>{change.before.plan}</strong><small>Add-ons: {change.before.addOns}</small></div>
            <MoveRight aria-hidden="true" />
            <div className="is-after"><span>After</span><strong>{change.after.plan}</strong><small>Add-ons: {change.after.addOns}</small></div>
          </div>
          <span className="notif-reason">
            {change.reason ? `Reason: ${change.reason}` : 'Reason: not given'}
            {change.pricingVersion && ` · pricing version ${change.pricingVersion}`}
          </span>
          <Link to="/app/account/usage" viewTransition>See your plan</Link>
        </>
      )}
      {!change && <p className="notif-body-full">{item.body}</p>}
      {group === 'job' && <Link to="/app/jobs" viewTransition>Open job history</Link>}
      {!item.read_at && (
        <Action variant="secondary" size="sm" className="notif-mark" onClick={onMarkRead} busy={busy}>Mark as read</Action>
      )}
    </div>
  );
}

/** Notifications (`acct-notifications`, `/app/account/notifications`): the inbox, with delivery preferences underneath. */
export function AccountNotifications() {
  const { user } = useAuth();
  const inbox = useResource(`notifications:${user?.id ?? ''}`, () => apiClient.listNotifications());
  const prefs = useResource(`notification-prefs:${user?.id ?? ''}`, () => apiClient.getNotificationPreferences());
  const [filter, setFilter] = useState('all');
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [readAt, setReadAt] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [draft, setDraft] = useState<NotificationPreferences | null>(null);
  const [saved, setSaved] = useState<NotificationPreferences | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveState, setSaveState] = useState<'idle' | 'saved'>('idle');
  const [prefsProblem, setPrefsProblem] = useState<string | null>(null);

  const failure = inbox.status === 'error' ? classifyAuthError(inbox.error) : null;
  const items: Notification[] = (inbox.data ?? []).map((item) => (item.read_at || !readAt[item.id] ? item : { ...item, read_at: readAt[item.id] }));
  const unread = unreadCount(items);
  const shown = items.filter((item) => (filter === 'all' || groupOf(item.kind) === filter) && (!unreadOnly || !item.read_at));

  const markRead = async (item: Notification) => {
    setBusy(item.id);
    setProblem(null);
    try {
      const updated = await apiClient.markNotificationRead(item.id);
      setReadAt((current) => ({ ...current, [item.id]: updated.read_at ?? new Date().toISOString() }));
      announceChange();
    } catch (caught) {
      setProblem(fallbackMessage(classifyAuthError(caught), 'marked as read'));
    } finally {
      setBusy(null);
    }
  };

  const markAll = async () => {
    setBusy('all');
    setProblem(null);
    try {
      const updated = await apiClient.markAllNotificationsRead();
      const stamp = new Date().toISOString();
      setReadAt((current) => ({
        ...current,
        ...Object.fromEntries(items.filter((item) => !item.read_at).map((item) => [item.id, stamp])),
        ...Object.fromEntries(updated.filter((item) => item.read_at).map((item) => [item.id, item.read_at as string])),
      }));
      announceChange();
    } catch (caught) {
      setProblem(fallbackMessage(classifyAuthError(caught), 'marked as read'));
    } finally {
      setBusy(null);
    }
  };

  const current = saved ?? prefs.data;
  const working = draft ?? current;
  const dirty = Boolean(current && working && JSON.stringify(current) !== JSON.stringify(working));

  const savePreferences = async () => {
    if (!working) return;
    setSaving(true);
    setPrefsProblem(null);
    try {
      const result = await apiClient.updateNotificationPreferences(working);
      setSaved(result);
      setDraft(null);
      setSaveState('saved');
    } catch (caught) {
      setPrefsProblem(fallbackMessage(classifyAuthError(caught), 'saved'));
    } finally {
      setSaving(false);
    }
  };

  const subtitle = inbox.data && unread > 0
    ? `You have ${unread} unread notification${unread === 1 ? '' : 's'}`
    : 'All caught up!';

  return (
    <AccountLayout
      section="notifications"
      title="Notifications"
      lede={subtitle}
      actions={(
        <Action variant="secondary" onClick={() => void markAll()} disabled={unread === 0} busy={busy === 'all'}>
          <CheckCheck aria-hidden="true" className="notif-icon" />Mark all read
        </Action>
      )}
    >
      <SponsorRequestsForYou />

      <div className="notif-filters">
        <FilterPills options={NOTIFICATION_FILTERS} value={filter} onChange={setFilter} ariaLabel="Filter notifications" />
        <label className="acct-check">
          <input type="checkbox" checked={unreadOnly} onChange={(event) => setUnreadOnly(event.target.checked)} />
          Show unread only
        </label>
      </div>

      {problem && <Notice tone="error">{problem}</Notice>}
      {failure?.status === 403 && <PermissionNotice permissions={['notifications:read']} action="read notifications" />}
      {failure && failure.status !== 403 && (
        <LoadFailure onRetry={inbox.reload}>Notifications couldn’t be loaded.</LoadFailure>
      )}
      {inbox.status === 'loading' && <div aria-busy="true"><Skeleton variant="panel" /></div>}

      {inbox.data && shown.length === 0 && (
        <EmptyState icon={<BellOff />} title="No notifications found">
          {items.length === 0 ? 'Contract changes and other notices will show up here.' : 'Nothing matches these filters.'}
        </EmptyState>
      )}

      {shown.length > 0 && (
        <ul className="notif-list" aria-label="Notifications">
          {shown.map((item) => {
            const group = groupOf(item.kind);
            const Icon = ICONS[group];
            const isOpen = open === item.id;
            const isUnread = !item.read_at;
            const panel = `notif-${item.id}`;
            return (
              <li key={item.id} className={isUnread ? 'is-unread' : undefined}>
                <button type="button" className="notif-row" aria-expanded={isOpen} aria-controls={panel} onClick={() => setOpen(isOpen ? null : item.id)}>
                  <span className="notif-icon-tile" aria-hidden="true"><Icon /></span>
                  <span className="notif-main">
                    <span className="notif-subject">
                      {item.subject}
                      {isUnread && <span className="notif-dot" role="img" aria-label="Unread" />}
                    </span>
                    <span className="notif-body">{item.body}</span>
                  </span>
                  <time className="notif-when" dateTime={item.created_at} title={formatDateTime(item.created_at) ?? undefined}>{formatDate(item.created_at)}</time>
                </button>
                {isOpen && (
                  <div id={panel}>
                    <Detail item={item} busy={busy === item.id} onMarkRead={() => void markRead(item)} />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {inbox.data && <p className="acct-muted">Notifications are kept for 7 days.</p>}

      <section className="notif-prefs" aria-labelledby="notif-prefs-title">
        <header>
          <h2 id="notif-prefs-title">Email preferences</h2>
          <p>In-app notifications are always on.</p>
        </header>
        {prefs.status === 'loading' && <Skeleton variant="tile" />}
        {prefs.status === 'error' && (
          <div className="notif-prefs-error">
            <LoadFailure onRetry={prefs.reload}>Email preferences couldn’t be loaded.</LoadFailure>
          </div>
        )}
        {working && PREFERENCES.map((preference) => (
          <div key={preference.key} className="notif-pref">
            <div>
              <strong>{preference.label}</strong>
              <span>{preference.description}</span>
            </div>
            <Switch
              label={preference.aria}
              checked={working[preference.key]}
              onChange={(next) => { setDraft({ ...working, [preference.key]: next }); setSaveState('idle'); }}
            />
          </div>
        ))}
        {prefsProblem && <div className="notif-prefs-error"><Notice tone="error">{prefsProblem}</Notice></div>}
        {working && (
          <div className="notif-prefs-actions">
            <Action variant="primary" disabled={!dirty} busy={saving} onClick={() => void savePreferences()}>
              {saveState === 'saved' && !dirty ? 'Saved' : 'Save preferences'}
            </Action>
            {dirty && <span className="acct-muted">You have unsaved changes</span>}
          </div>
        )}
      </section>
    </AccountLayout>
  );
}
