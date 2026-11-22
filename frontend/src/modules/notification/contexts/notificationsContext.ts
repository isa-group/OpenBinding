// Adapted from SPHERE frontend/src/modules/notification/contexts/notificationsContext.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: the context alone (its provider is contexts/notificationsProvider.tsx, so fast refresh keeps working); a
// notification is read when it has a `read_at`; the list remembers the query it was fetched with; `subscribe` fans the
// live notifications out by kind, so a page can read what it shows again when one about it arrives (F6).

import { createContext } from 'react';
import type { Notification, NotificationQuery } from '../api/notificationsApi';

export interface NotificationsContextValue {
  notifications: Notification[];
  unreadCount: number;
  isLoading: boolean;
  /** Why the list could not be loaded, or null. */
  error: string | null;
  fetchNotifications: (options?: NotificationQuery) => Promise<void>;
  fetchUnreadCount: () => Promise<void>;
  markAsRead: (notificationId: string) => Promise<void>;
  markAllAsRead: () => Promise<void>;
  deleteNotification: (notificationId: string) => Promise<void>;
  addNotification: (notification: Notification) => void;
  /** An unread notification arrived after the bell was last opened. */
  hasUnseen: boolean;
  markSeen: () => void;
  /**
   * Listen to the notifications of one kind as they arrive on the live stream; returns the function that stops listening.
   * The public way for a module to react to a notification (a page reads what it shows again).
   */
  subscribe: (kind: string, listener: (notification: Notification) => void) => () => void;
  /** Hands a notification that arrived on the live stream to the listeners of its kind (the stream's hook calls it). */
  publish: (notification: Notification) => void;
}

export const NotificationsContext = createContext<NotificationsContextValue | null>(null);
