// SPHERE's App.tsx mounts `useNotificationsSSE` with the toast context (frontend/src/App.tsx, revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández. MIT licence: the full text is in
// THIRD_PARTY_NOTICES.md. Pattern only: the bridge is a component of the notification module, so App.tsx only mounts it;
// every notification that arrives live is also a toast (at most three at once, the toast provider's rule), whose title leads
// where the notification does.

import { useCallback } from 'react';
import { useToast } from '../../../core/contexts/useToast';
import type { Notification } from '../../api/notificationsApi';
import { useNotificationsSSE } from '../../hooks/useNotificationsSSE';
import { notificationBody, notificationLink } from '../../utils/notification-link';

export default function NotificationsSSEBridge() {
  const { addToast } = useToast();
  const onNotification = useCallback(
    (notification: Notification) =>
      addToast({
        kind: notification.kind,
        title: notification.subject,
        message: notificationBody(notification),
        to: notificationLink(notification) ?? undefined,
      }),
    [addToast]
  );
  useNotificationsSSE(onNotification);
  return null;
}
