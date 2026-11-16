// Adapted from SPHERE frontend/src/modules/notification/components/notification-item/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: OpenBinding's kinds and deep links (utils/notification-link): an invitation opens its join page, a new version
// its composition, a finished or failed run the run; opening one marks it read, read or not; the time from date-fns.

import { useNavigate } from 'react-router-dom';
import Iconify from '../../../core/components/iconify';
import type { Notification } from '../../api/notificationsApi';
import { useNotificationsContext } from '../../hooks/useNotificationsContext';
import { KIND_ICONS, notificationLink, timeAgo } from '../../utils/notification-link';

interface NotificationItemProps {
  notification: Notification;
  onClose: () => void;
}

export default function NotificationItem({ notification, onClose }: NotificationItemProps) {
  const { markAsRead } = useNotificationsContext();
  const navigate = useNavigate();
  const read = Boolean(notification.read_at);
  const link = notificationLink(notification);

  const handleClick = async () => {
    if (!read) await markAsRead(notification.id).catch(() => undefined);
    if (link) navigate(link);
    onClose();
  };

  return (
    <button
      type="button"
      onClick={() => void handleClick()}
      className={`flex w-full items-start gap-3 px-4 py-3 text-left transition-colors ${
        read && !link ? 'cursor-default' : 'cursor-pointer hover:bg-tp-surface'
      } ${read ? '' : 'bg-tp-surface/50'}`}
    >
      <div
        className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${
          read ? 'bg-tp-surface' : 'bg-tp-primary/10'
        }`}
      >
        <Iconify
          icon={KIND_ICONS[notification.kind] ?? 'mdi:bell'}
          width={16}
          className={read ? 'text-tp-steel' : 'text-tp-accent'}
        />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <p className={`text-sm ${read ? 'text-tp-slate' : 'font-medium text-tp-ink'}`}>
            {notification.subject}
            {!read && <span className="sr-only"> (unread)</span>}
          </p>
          {!read && (
            <span aria-hidden="true" className="mt-1 h-2 w-2 shrink-0 rounded-full bg-tp-primary" />
          )}
        </div>
        <p className="mt-0.5 truncate text-xs text-tp-steel">{notification.body}</p>
        <p className="mt-1 text-[10px] text-tp-steel">{timeAgo(notification.created_at)}</p>
      </div>
    </button>
  );
}
