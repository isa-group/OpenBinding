// Adapted from SPHERE frontend/src/modules/notification/contexts/notificationsContext.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: OpenBinding's session and API (`read_at`, `created_at`); the last-seen time is kept under an `openbinding:` key;
// a failed load keeps its message instead of going to the console; deleting an unread notification counts it down once.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { readApiError } from '../../core/api/errors';
import { useAuth } from '../../auth/hooks/useAuth';
import {
  useNotificationsApi,
  type Notification,
  type NotificationQuery,
} from '../api/notificationsApi';
import { NotificationsContext, type NotificationsContextValue } from './notificationsContext';

// When the bell was last opened, per user and per browser. Storage may be unavailable (a private window, blocked site
// data): the dot then simply shows for any unread notification.
const lastSeenKey = (userId: string) => `openbinding:notifications:last-seen:${userId}`;
const readLastSeen = (userId: string) => {
  try {
    return Number(localStorage.getItem(lastSeenKey(userId))) || 0;
  } catch {
    return 0;
  }
};
const writeLastSeen = (userId: string, time: number) => {
  try {
    localStorage.setItem(lastSeenKey(userId), String(time));
  } catch {
    // Not kept: the dot is cleared for this visit only.
  }
};

export function NotificationsProvider({ children }: { children: ReactNode }) {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasUnseen, setHasUnseen] = useState(false);
  const api = useNotificationsApi();
  const { user } = useAuth();
  const userId = user?.id ?? null;

  // The latest API without re-running the effects that read it.
  const apiRef = useRef(api);
  useEffect(() => {
    apiRef.current = api;
  }, [api]);

  const fetchNotifications = useCallback(
    async (options?: NotificationQuery) => {
      if (!userId) return;
      setIsLoading(true);
      setError(null);
      try {
        setNotifications(await apiRef.current.getNotifications(options));
      } catch (caught) {
        setError(readApiError(caught).message || 'The notifications could not be loaded.');
      } finally {
        setIsLoading(false);
      }
    },
    [userId]
  );

  const fetchUnreadCount = useCallback(async () => {
    if (!userId) return;
    try {
      setUnreadCount(await apiRef.current.getUnreadCount());
    } catch {
      // The count stays as it was; the bell still opens the list.
    }
  }, [userId]);

  const markAsRead = useCallback(async (notificationId: string) => {
    await apiRef.current.markAsRead(notificationId);
    setNotifications(prev =>
      prev.map(n =>
        n.id === notificationId ? { ...n, read_at: n.read_at ?? new Date().toISOString() } : n
      )
    );
    setUnreadCount(prev => Math.max(0, prev - 1));
  }, []);

  const markAllAsRead = useCallback(async () => {
    await apiRef.current.markAllAsRead();
    const now = new Date().toISOString();
    setNotifications(prev => prev.map(n => ({ ...n, read_at: n.read_at ?? now })));
    setUnreadCount(0);
  }, []);

  const notificationsRef = useRef(notifications);
  useEffect(() => {
    notificationsRef.current = notifications;
  }, [notifications]);

  const deleteNotification = useCallback(async (notificationId: string) => {
    await apiRef.current.deleteNotification(notificationId);
    const deleted = notificationsRef.current.find(n => n.id === notificationId);
    if (deleted && !deleted.read_at) setUnreadCount(c => Math.max(0, c - 1));
    setNotifications(prev => prev.filter(n => n.id !== notificationId));
  }, []);

  const addNotification = useCallback((notification: Notification) => {
    setNotifications(prev => [notification, ...prev.filter(n => n.id !== notification.id)]);
    if (!notification.read_at) setHasUnseen(true);
  }, []);

  const markSeen = useCallback(() => {
    setHasUnseen(false);
    if (userId) writeLastSeen(userId, Date.now());
  }, [userId]);

  // On sign-in, the dot shows if the newest unread notification came after the bell was last opened.
  useEffect(() => {
    let active = true;
    if (!userId) {
      setHasUnseen(false);
      setNotifications([]);
      setUnreadCount(0);
      return;
    }
    void fetchUnreadCount();
    apiRef.current
      .getNotifications({ unreadOnly: true, limit: 1 })
      .then(([newest]) => {
        if (active && newest)
          setHasUnseen(new Date(newest.created_at).getTime() > readLastSeen(userId));
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [userId, fetchUnreadCount]);

  // Nothing left to read, nothing to point at.
  useEffect(() => {
    if (unreadCount === 0) setHasUnseen(false);
  }, [unreadCount]);

  const value = useMemo<NotificationsContextValue>(
    () => ({
      notifications,
      unreadCount,
      isLoading,
      error,
      fetchNotifications,
      fetchUnreadCount,
      markAsRead,
      markAllAsRead,
      deleteNotification,
      addNotification,
      hasUnseen,
      markSeen,
    }),
    [
      notifications,
      unreadCount,
      isLoading,
      error,
      fetchNotifications,
      fetchUnreadCount,
      markAsRead,
      markAllAsRead,
      deleteNotification,
      addNotification,
      hasUnseen,
      markSeen,
    ]
  );

  return <NotificationsContext.Provider value={value}>{children}</NotificationsContext.Provider>;
}
