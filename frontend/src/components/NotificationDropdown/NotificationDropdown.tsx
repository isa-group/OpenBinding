import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Bell,
  BellDot,
  CheckCheck,
  Clock,
  ExternalLink,
  Maximize2,
  Minimize2,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { apiClient } from '../../api/client';
import type { Notification } from '../../api/auth';
import './NotificationDropdown.css';

function formatTimeAgo(isoString: string): string {
  const timestamp = new Date(isoString).getTime();
  const diffMs = Date.now() - timestamp;
  if (Number.isNaN(timestamp) || diffMs < 0) return 'ahora';

  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return 'ahora';
  if (minutes < 60) return `hace ${minutes}m`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `hace ${hours}h`;

  const days = Math.floor(hours / 24);
  return `hace ${days}d`;
}

export function NotificationDropdown() {
  const [isOpen, setIsOpen] = useState(false);
  const [isEnlarged, setIsEnlarged] = useState(false);
  const [activeTab, setActiveTab] = useState<'unread' | 'all'>('unread');
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [busyItem, setBusyItem] = useState<string | null>(null);
  const [markingAll, setMarkingAll] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);

  const reload = useCallback(async () => {
    try {
      const data = await apiClient.listNotifications(false);
      setNotifications(data);
    } catch {
      // Retain previous state gracefully on network hiccup
    }
  }, []);

  useEffect(() => {
    void reload();

    const handleUpdate = () => {
      void reload();
    };

    window.addEventListener('openbinding:notifications-updated', handleUpdate);
    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') {
        void reload();
      }
    }, 60000);

    return () => {
      window.removeEventListener('openbinding:notifications-updated', handleUpdate);
      clearInterval(interval);
    };
  }, [reload]);

  useEffect(() => {
    if (!isOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsOpen(false);
      }
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen]);

  const unreadNotifications = notifications.filter((item) => !item.read_at);
  const unreadCount = unreadNotifications.length;

  const toggleOpen = () => {
    setIsOpen((current) => {
      const next = !current;
      if (next) {
        void reload();
      }
      return next;
    });
  };

  const handleEnlargeToggle = () => {
    setIsEnlarged((current) => {
      const next = !current;
      if (next) {
        // When enlarging to view all, switch tab to 'all' if on 'unread'
        setActiveTab('all');
      }
      return next;
    });
  };

  const markRead = async (notification: Notification) => {
    if (notification.read_at || busyItem === notification.id) return;
    setBusyItem(notification.id);
    try {
      const updated = await apiClient.markNotificationRead(notification.id);
      setNotifications((current) =>
        current.map((item) => (item.id === updated.id ? updated : item))
      );
      window.dispatchEvent(new CustomEvent('openbinding:notifications-updated'));
    } catch {
      // Ignored; notification read failure is not blocking
    } finally {
      setBusyItem(null);
    }
  };

  const markAllRead = async () => {
    if (unreadCount === 0 || markingAll) return;
    setMarkingAll(true);
    try {
      const updated = await apiClient.markAllNotificationsRead();
      const updatedMap = new Map(updated.map((item) => [item.id, item]));
      setNotifications((current) =>
        current.map((item) => updatedMap.get(item.id) || { ...item, read_at: item.read_at || new Date().toISOString() })
      );
      window.dispatchEvent(new CustomEvent('openbinding:notifications-updated'));
    } catch {
      // Ignored
    } finally {
      setMarkingAll(false);
    }
  };

  const displayedList = activeTab === 'unread' ? unreadNotifications : notifications;

  return (
    <div className="notification-dropdown-container" ref={containerRef}>
      <button
        type="button"
        className={`notification-trigger ${isOpen ? 'is-open' : ''}`}
        onClick={toggleOpen}
        aria-label={
          unreadCount > 0
            ? `${unreadCount} unread notifications`
            : 'Notifications'
        }
        aria-expanded={isOpen}
        aria-haspopup="dialog"
      >
        {unreadCount > 0 ? (
          <BellDot className="notification-icon has-unread" aria-hidden="true" />
        ) : (
          <Bell className="notification-icon" aria-hidden="true" />
        )}

        {unreadCount > 0 && (
          <span className="notification-badge" aria-hidden="true">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {isOpen && (
        <div
          className={`notification-panel ${isEnlarged ? 'is-enlarged' : ''}`}
          role="dialog"
          aria-label="Notifications panel"
        >
          <header className="notification-panel-header">
            <div className="notification-header-title">
              <h3>Notifications</h3>
              {unreadCount > 0 && (
                <span className="notification-count-pill">{unreadCount} new</span>
              )}
            </div>

            <div className="notification-header-actions">
              {unreadCount > 0 && (
                <button
                  type="button"
                  className="notification-action-btn"
                  onClick={() => void markAllRead()}
                  disabled={markingAll}
                  title="Mark all as read"
                  aria-label="Mark all as read"
                >
                  <CheckCheck aria-hidden="true" />
                  <span>Read</span>
                </button>
              )}

              <button
                type="button"
                className="notification-action-btn notification-icon-btn"
                onClick={handleEnlargeToggle}
                title={isEnlarged ? 'Reduce size' : 'Enlarge to view all'}
                aria-label={isEnlarged ? 'Reduce size' : 'Enlarge to view all'}
              >
                {isEnlarged ? <Minimize2 aria-hidden="true" /> : <Maximize2 aria-hidden="true" />}
              </button>
            </div>
          </header>

          <div className="notification-tabs" role="tablist" aria-label="Notification filter">
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'unread'}
              className={`notification-tab ${activeTab === 'unread' ? 'is-active' : ''}`}
              onClick={() => setActiveTab('unread')}
            >
              Unread ({unreadCount})
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'all'}
              className={`notification-tab ${activeTab === 'all' ? 'is-active' : ''}`}
              onClick={() => setActiveTab('all')}
            >
              All ({notifications.length})
            </button>
          </div>

          <div className="notification-panel-list" tabIndex={0} role="region" aria-label="Notification list">
            {displayedList.length > 0 ? (
              displayedList.map((item) => {
                const isUnread = !item.read_at;
                return (
                  <button
                    key={item.id}
                    type="button"
                    className={`notification-item ${isUnread ? 'is-unread' : ''}`}
                    onClick={() => void markRead(item)}
                    disabled={busyItem === item.id}
                    aria-label={
                      isUnread
                        ? `Mark as read: ${item.subject}`
                        : `${item.subject}, read`
                    }
                  >
                    {isUnread && <span className="notification-unread-dot" aria-hidden="true" />}
                    <div className="notification-item-main">
                      <div className="notification-item-header">
                        <strong>{item.subject}</strong>
                        <span className="notification-item-time">{formatTimeAgo(item.created_at)}</span>
                      </div>
                      <p className="notification-item-body">{item.body}</p>
                    </div>
                  </button>
                );
              })
            ) : (
              <div className="notification-empty">
                {activeTab === 'unread' ? (
                  <>
                    <p>You have no unread notifications.</p>
                    {notifications.length > 0 && (
                      <button
                        type="button"
                        className="notification-empty-btn"
                        onClick={() => setActiveTab('all')}
                      >
                        View the {notifications.length} notifications from the last 7 days
                      </button>
                    )}
                  </>
                ) : (
                  <p>No notifications in the last 7 days.</p>
                )}
              </div>
            )}
          </div>

          <footer className="notification-panel-footer">
            <span className="notification-retention-badge" title="Notifications expire automatically after 7 days">
              <Clock aria-hidden="true" />
              <span>Lifetime: 7 days</span>
            </span>
            <Link
              to="/app/account?tab=services"
              className="notification-account-link"
              onClick={() => setIsOpen(false)}
            >
              <span>Manage in account</span>
              <ExternalLink aria-hidden="true" />
            </Link>
          </footer>
        </div>
      )}
    </div>
  );
}
