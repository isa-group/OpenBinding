// Adapted from SPHERE frontend/src/modules/notification/pages/inbox/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: OpenBinding's kinds, filtered by the gateway (not in the page), with the filter, "Unread only" and the page in
// the address; a delete per row and paging (both added); opening a notification follows its deep link; the load error is
// said, with Retry; a Helmet title.

import { useEffect } from 'react';
import { Helmet } from 'react-helmet-async';
import { useNavigate, useSearchParams } from 'react-router-dom';
import Iconify from '../../../core/components/iconify';
import customAlert from '../../../core/utils/custom-alert';
import { readApiError } from '../../../core/api/errors';
import { NOTIFICATION_KINDS, type Notification } from '../../api/notificationsApi';
import { useNotificationsContext } from '../../hooks/useNotificationsContext';
import { KIND_ICONS, KIND_LABELS, notificationLink, timeAgo } from '../../utils/notification-link';

const PAGE_SIZE = 20;

export default function InboxPage() {
  const {
    notifications,
    isLoading,
    error,
    fetchNotifications,
    markAsRead,
    markAllAsRead,
    deleteNotification,
    unreadCount,
  } = useNotificationsContext();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const kind = params.get('kind') ?? '';
  const unreadOnly = params.get('unread') === '1';
  const page = Math.max(1, Number.parseInt(params.get('page') ?? '1', 10) || 1);

  const update = (next: { kind?: string; unread?: boolean; page?: number }) =>
    setParams(
      current => {
        const merged = new URLSearchParams(current);
        const set = (name: string, value: string | null) =>
          value ? merged.set(name, value) : merged.delete(name);
        if (next.kind !== undefined) set('kind', next.kind);
        if (next.unread !== undefined) set('unread', next.unread ? '1' : null);
        const nextPage = next.page ?? 1;
        set('page', nextPage > 1 ? String(nextPage) : null);
        return merged;
      },
      { replace: true }
    );

  const load = () =>
    fetchNotifications({
      unreadOnly,
      kind: kind || undefined,
      offset: (page - 1) * PAGE_SIZE,
      limit: PAGE_SIZE,
    });

  useEffect(() => {
    void fetchNotifications({
      unreadOnly,
      kind: kind || undefined,
      offset: (page - 1) * PAGE_SIZE,
      limit: PAGE_SIZE,
    });
  }, [fetchNotifications, unreadOnly, kind, page]);

  const handleOpen = async (notification: Notification) => {
    if (!notification.read_at) await markAsRead(notification.id).catch(() => undefined);
    const link = notificationLink(notification);
    if (link) navigate(link);
  };

  const handleDelete = (notification: Notification) =>
    deleteNotification(notification.id).catch((caught: unknown) =>
      customAlert(readApiError(caught).message || 'The notification could not be deleted.', 'error')
    );

  const chip = (active: boolean) =>
    `cursor-pointer rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
      active
        ? 'bg-tp-accent text-tp-on-primary'
        : 'border border-tp-hairline text-tp-steel hover:bg-tp-surface'
    }`;

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <Helmet>
        <title>OpenBinding - Notifications</title>
      </Helmet>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl text-tp-ink">Notifications</h1>
          <p className="mt-1 text-sm text-tp-steel">
            {unreadCount > 0
              ? `You have ${unreadCount} unread notification${unreadCount !== 1 ? 's' : ''}`
              : 'All caught up!'}
          </p>
        </div>
        {unreadCount > 0 && (
          <button
            type="button"
            onClick={() => void markAllAsRead()}
            className="cursor-pointer rounded-lg border border-tp-hairline px-3 py-2 text-sm font-medium text-tp-ink transition-colors hover:bg-tp-surface"
          >
            Mark all read
          </button>
        )}
      </div>

      <div className="mb-4 flex flex-wrap gap-2" role="group" aria-label="Kind">
        <button
          type="button"
          aria-pressed={!kind}
          onClick={() => update({ kind: '' })}
          className={chip(!kind)}
        >
          All
        </button>
        {NOTIFICATION_KINDS.map(value => (
          <button
            key={value}
            type="button"
            aria-pressed={kind === value}
            onClick={() => update({ kind: value })}
            className={chip(kind === value)}
          >
            {KIND_LABELS[value]}
          </button>
        ))}
      </div>

      <div className="mb-4 flex items-center gap-2">
        <label className="flex cursor-pointer items-center gap-2 text-sm text-tp-steel">
          <input
            type="checkbox"
            checked={unreadOnly}
            onChange={e => update({ unread: e.target.checked })}
            className="h-4 w-4 rounded border-tp-hairline text-tp-primary focus:ring-tp-primary"
          />
          Unread only
        </label>
      </div>

      <div className="rounded-xl border border-tp-hairline bg-tp-canvas">
        {isLoading && notifications.length === 0 ? (
          <div
            className="flex items-center justify-center py-12"
            role="status"
            aria-label="Loading notifications"
          >
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-tp-primary border-t-transparent" />
          </div>
        ) : error ? (
          <div
            role="alert"
            className="flex flex-col items-center gap-3 py-12 text-center text-sm text-red-700"
          >
            <p>{error}</p>
            <button
              type="button"
              onClick={() => void load()}
              className="cursor-pointer rounded-md border border-red-300 px-3 py-1.5 font-medium hover:bg-red-50"
            >
              Retry
            </button>
          </div>
        ) : notifications.length === 0 ? (
          <div className="py-12 text-center">
            <Iconify icon="mdi:bell-off" width={48} className="mx-auto text-tp-muted" />
            <p className="mt-4 text-sm text-tp-steel">No notifications found</p>
          </div>
        ) : (
          <ul className="divide-y divide-tp-hairline">
            {notifications.map(notification => {
              const read = Boolean(notification.read_at);
              const payload = notification.payload ?? {};
              return (
                <li
                  key={notification.id}
                  className={`flex items-start gap-2 ${read ? '' : 'bg-tp-surface/50'}`}
                >
                  <button
                    type="button"
                    onClick={() => void handleOpen(notification)}
                    className="flex min-w-0 flex-1 cursor-pointer items-start gap-4 p-4 text-left transition-colors hover:bg-tp-surface"
                  >
                    <div
                      className={`mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${
                        read ? 'bg-tp-surface' : 'bg-tp-primary/10'
                      }`}
                    >
                      <Iconify
                        icon={KIND_ICONS[notification.kind] ?? 'mdi:bell'}
                        width={20}
                        className={read ? 'text-tp-steel' : 'text-tp-accent'}
                      />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start justify-between gap-2">
                        <p
                          className={`text-sm ${read ? 'text-tp-slate' : 'font-medium text-tp-ink'}`}
                        >
                          {notification.subject}
                          {!read && <span className="sr-only"> (unread)</span>}
                        </p>
                        <div className="flex shrink-0 items-center gap-2">
                          {!read && (
                            <span
                              aria-hidden="true"
                              className="h-2 w-2 rounded-full bg-tp-primary"
                            />
                          )}
                          <span className="text-[10px] text-tp-steel">
                            {timeAgo(notification.created_at)}
                          </span>
                        </div>
                      </div>
                      <p className="mt-1 text-sm text-tp-steel">{notification.body}</p>
                      {notification.kind === 'OrganizationInvitation' &&
                        typeof payload.organization_name === 'string' && (
                          <p className="mt-2 text-xs text-tp-steel">
                            Organization: {payload.organization_name}
                          </p>
                        )}
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleDelete(notification)}
                    aria-label={`Delete ${notification.subject}`}
                    title="Delete"
                    className="mt-4 mr-3 flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-md text-tp-steel hover:bg-tp-surface hover:text-red-700"
                  >
                    <Iconify icon="mdi:trash-can-outline" width={16} />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {(page > 1 || notifications.length === PAGE_SIZE) && (
        <nav className="mt-6 flex items-center justify-between" aria-label="Notification pages">
          <button
            type="button"
            disabled={page === 1}
            onClick={() => update({ page: page - 1 })}
            className="cursor-pointer rounded-lg border border-tp-hairline-strong px-4 py-2 text-sm font-medium text-tp-ink hover:bg-tp-surface disabled:cursor-not-allowed disabled:opacity-40"
          >
            Previous
          </button>
          <span className="text-sm text-tp-steel">Page {page}</span>
          <button
            type="button"
            disabled={notifications.length < PAGE_SIZE}
            onClick={() => update({ page: page + 1 })}
            className="cursor-pointer rounded-lg border border-tp-hairline-strong px-4 py-2 text-sm font-medium text-tp-ink hover:bg-tp-surface disabled:cursor-not-allowed disabled:opacity-40"
          >
            Next
          </button>
        </nav>
      )}
    </div>
  );
}
