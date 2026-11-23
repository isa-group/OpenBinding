// Adapted from SPHERE frontend/src/modules/notification/hooks/useNotificationsSSE.ts (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: the stream opens with a single-use ticket (`POST /v1/notifications/stream-ticket`), never with the access token
// in its URL, and a new ticket is asked for on every reconnection (the gateway ends a stream after 15 minutes); OpenBinding's
// API base; the unread count arrives in the event itself; the latest callbacks are kept in effects; every notification is
// also handed to the listeners of its kind (`subscribe` of the notifications context).

import { useEffect, useRef } from 'react';
import { config } from '../../../config';
import { useAuth } from '../../auth/hooks/useAuth';
import { useNotificationsApi, type Notification } from '../api/notificationsApi';
import { useNotificationsContext } from './useNotificationsContext';

const INITIAL_DELAY = 2000;
const MAX_DELAY = 60000;

export function useNotificationsSSE(onNotification?: (notification: Notification) => void) {
  const { user } = useAuth();
  const { createStreamTicket } = useNotificationsApi();
  const { addNotification, fetchUnreadCount, publish } = useNotificationsContext();

  const latest = useRef({
    addNotification,
    fetchUnreadCount,
    onNotification,
    createStreamTicket,
    publish,
  });
  useEffect(() => {
    latest.current = {
      addNotification,
      fetchUnreadCount,
      onNotification,
      createStreamTicket,
      publish,
    };
  });

  const userId = user?.id ?? null;

  useEffect(() => {
    if (!userId || typeof EventSource === 'undefined') return;

    let stopped = false;
    let source: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let delay = INITIAL_DELAY;

    const cleanup = () => {
      source?.close();
      source = null;
      if (timer) clearTimeout(timer);
      timer = null;
    };

    const scheduleReconnect = () => {
      if (stopped) return;
      timer = setTimeout(() => {
        delay = Math.min(delay * 1.5, MAX_DELAY);
        void connect();
      }, delay);
    };

    async function connect() {
      if (stopped) return;
      cleanup();
      let ticket: string;
      try {
        ticket = (await latest.current.createStreamTicket()).ticket;
      } catch {
        scheduleReconnect();
        return;
      }
      if (stopped) return;
      const es = new EventSource(
        `${config.apiBaseUrl}/v1/notifications/stream?ticket=${encodeURIComponent(ticket)}`
      );
      source = es;

      es.addEventListener('connected', () => {
        delay = INITIAL_DELAY;
      });

      es.addEventListener('notification', event => {
        try {
          const notification = JSON.parse((event as MessageEvent).data) as Notification;
          latest.current.addNotification(notification);
          latest.current.onNotification?.(notification);
          latest.current.publish(notification);
        } catch {
          /* a malformed event is skipped */
        }
      });

      es.addEventListener('unread-count', () => {
        void latest.current.fetchUnreadCount();
      });

      // The ticket is spent: every reconnection asks for a new one.
      es.onerror = () => {
        es.close();
        source = null;
        scheduleReconnect();
      };
    }

    void connect();

    return () => {
      stopped = true;
      cleanup();
    };
  }, [userId]);
}
