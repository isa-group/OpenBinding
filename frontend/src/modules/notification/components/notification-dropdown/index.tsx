// Adapted from SPHERE frontend/src/modules/notification/components/notification-dropdown/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: a labelled region with a link to the inbox (not a `navigate` button); the loading and the failed states.

import { motion } from 'framer-motion';
import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { dropdownVariants, transitionFast } from '../../../core/utils/motion-variants';
import { useNotificationsContext } from '../../hooks/useNotificationsContext';
import NotificationItem from '../notification-item';

interface NotificationDropdownProps {
  onClose: () => void;
}

export default function NotificationDropdown({ onClose }: NotificationDropdownProps) {
  const { notifications, unreadCount, isLoading, error, fetchNotifications, markAllAsRead } =
    useNotificationsContext();

  useEffect(() => {
    void fetchNotifications({ limit: 10 });
  }, [fetchNotifications]);

  return (
    <motion.div
      initial="hidden"
      animate="visible"
      exit="hidden"
      variants={dropdownVariants}
      transition={transitionFast}
      role="dialog"
      aria-label="Notifications"
      className="absolute top-full right-0 z-50 mt-2 w-80 max-w-[calc(100vw-2rem)] rounded-xl border border-tp-hairline bg-tp-canvas shadow-elevation-4"
    >
      <div className="flex items-center justify-between border-b border-tp-hairline px-4 py-3">
        <h3 className="font-display text-sm font-medium text-tp-ink">Notifications</h3>
        {unreadCount > 0 && (
          <button
            type="button"
            onClick={() => void markAllAsRead()}
            className="cursor-pointer text-xs text-tp-accent transition-colors hover:text-tp-primary-deep"
          >
            Mark all read
          </button>
        )}
      </div>

      <div className="max-h-80 overflow-y-auto">
        {isLoading && notifications.length === 0 ? (
          <div
            className="flex items-center justify-center py-8"
            role="status"
            aria-label="Loading notifications"
          >
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-tp-primary border-t-transparent" />
          </div>
        ) : error && notifications.length === 0 ? (
          <p role="alert" className="px-4 py-8 text-center text-sm text-red-700">
            {error}
          </p>
        ) : notifications.length === 0 ? (
          <div className="py-8 text-center">
            <p className="text-sm text-tp-steel">No notifications yet</p>
          </div>
        ) : (
          <ul className="py-1">
            {notifications.slice(0, 10).map(notification => (
              <li key={notification.id}>
                <NotificationItem notification={notification} onClose={onClose} />
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="border-t border-tp-hairline px-4 py-2">
        <Link
          to="/notifications"
          onClick={onClose}
          className="block w-full cursor-pointer text-center text-xs font-medium text-tp-accent transition-colors hover:text-tp-primary-deep"
        >
          View all notifications
        </Link>
      </div>
    </motion.div>
  );
}
