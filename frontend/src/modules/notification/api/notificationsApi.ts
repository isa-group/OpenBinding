// Adapted from SPHERE frontend/src/modules/notification/api/notificationsApi.ts (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: OpenBinding's gateway routes and generated types (`subject`, `body`, `payload`, `read_at`); the kind and offset
// filters; the stream opens with a short-lived ticket instead of the access token in its URL; refusals throw the typed
// error `readApiError` reads.

import { useCallback, useMemo } from 'react';
import { readResponse } from '../../core/api/http';
import type { components } from '../../core/api/openapi';
import { useAuth } from '../../auth/hooks/useAuth';

export type Notification = components['schemas']['NotificationView'];
export type StreamTicket = components['schemas']['StreamTicket'];

/** The kinds the gateway sends, as the inbox filters them. */
export const NOTIFICATION_KINDS = [
  'OrganizationInvitation',
  'System',
  'CompositionUpdated',
  'RunFinished',
  'RunFailed',
  'CompositionAdopted',
  'UpstreamEvent',
] as const;

export interface NotificationQuery {
  unreadOnly?: boolean;
  kind?: string;
  offset?: number;
  limit?: number;
}

const BASE = '/v1/notifications';

export function useNotificationsApi() {
  const { fetchWithInterceptor } = useAuth();

  const call = useCallback(
    async <T>(path: string, init?: RequestInit): Promise<T> =>
      readResponse<T>(await fetchWithInterceptor(path, init)),
    [fetchWithInterceptor]
  );

  const getNotifications = useCallback(
    (options: NotificationQuery = {}) => {
      const query = new URLSearchParams();
      if (options.unreadOnly) query.set('unread_only', 'true');
      if (options.kind) query.set('kind', options.kind);
      if (options.offset) query.set('offset', String(options.offset));
      if (options.limit) query.set('limit', String(options.limit));
      const text = query.toString();
      return call<Notification[]>(`${BASE}${text ? `?${text}` : ''}`);
    },
    [call]
  );

  const getUnreadCount = useCallback(async () => {
    const answer = await call<{ count?: unknown } | null>(`${BASE}/unread-count`);
    return typeof answer?.count === 'number' ? answer.count : 0;
  }, [call]);

  const markAsRead = useCallback(
    (id: string) =>
      call<Notification>(`${BASE}/${encodeURIComponent(id)}/read`, { method: 'POST' }),
    [call]
  );

  const markAllAsRead = useCallback(
    () => call<unknown>(`${BASE}/read-all`, { method: 'POST' }),
    [call]
  );

  const deleteNotification = useCallback(
    (id: string) => call<void>(`${BASE}/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    [call]
  );

  /** A single-use ticket that opens the stream for a minute. */
  const createStreamTicket = useCallback(
    () => call<StreamTicket>(`${BASE}/stream-ticket`, { method: 'POST' }),
    [call]
  );

  return useMemo(
    () => ({
      getNotifications,
      getUnreadCount,
      markAsRead,
      markAllAsRead,
      deleteNotification,
      createStreamTicket,
    }),
    [
      getNotifications,
      getUnreadCount,
      markAsRead,
      markAllAsRead,
      deleteNotification,
      createStreamTicket,
    ]
  );
}
