// Adapted from SPHERE frontend/src/modules/core/components/toast/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: a toast takes any `{ kind, title, message }` (SPHERE's Notification fits it) so `core` imports no
// notification module; the text colours reach 4.5:1; the close button is named; both timers are cleared on unmount; a
// toast given `to` (a notification's page) makes its title a link there.

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import Iconify from '../iconify';

/** What a toast shows. SPHERE's notifications fit it as they are; the notification module (B4) feeds it. */
export interface ToastNotification {
  kind: string;
  title: string;
  message?: string;
  /** Where the toast leads (a notification's page): its title becomes a link there. */
  to?: string;
}

export interface Toast {
  id: string;
  notification: ToastNotification;
}

interface ToastItemProps {
  toast: Toast;
  onRemove: (id: string) => void;
  duration?: number;
}

const kindConfig: Record<
  string,
  { icon: string; bgClass: string; borderClass: string; textClass: string; iconClass: string }
> = {
  OrganizationInvitation: {
    icon: 'mdi:account-plus',
    bgClass: 'bg-tp-primary/10',
    borderClass: 'border-tp-primary/30',
    textClass: 'text-tp-accent-hover',
    iconClass: 'text-tp-accent',
  },
  System: {
    icon: 'mdi:information',
    bgClass: 'bg-tp-severity-info-bg',
    borderClass: 'border-tp-severity-info-border',
    textClass: 'text-tp-info-strong',
    iconClass: 'text-tp-severity-info',
  },
  CollectionShared: {
    icon: 'mdi:folder-shared',
    bgClass: 'bg-tp-severity-success-bg',
    borderClass: 'border-tp-severity-success-border',
    textClass: 'text-tp-success-strong',
    iconClass: 'text-tp-severity-success',
  },
  UpstreamEvent: {
    icon: 'mdi:update',
    bgClass: 'bg-tp-severity-warning-bg',
    borderClass: 'border-tp-severity-warning-border',
    textClass: 'text-tp-warning-strong',
    iconClass: 'text-tp-severity-warning',
  },
  PricingUpdated: {
    icon: 'mdi:file-replace',
    bgClass: 'bg-tp-severity-warning-bg',
    borderClass: 'border-tp-severity-warning-border',
    textClass: 'text-tp-warning-strong',
    iconClass: 'text-tp-severity-warning',
  },
};

const defaultConfig = {
  icon: 'mdi:bell',
  bgClass: 'bg-tp-surface',
  borderClass: 'border-tp-hairline',
  textClass: 'text-tp-slate',
  iconClass: 'text-tp-steel',
};

const TOAST_DURATION = 5000;

export default function ToastItem({ toast, onRemove, duration = TOAST_DURATION }: ToastItemProps) {
  const [isExiting, setIsExiting] = useState(false);
  const config = kindConfig[toast.notification.kind] || defaultConfig;

  useEffect(() => {
    let removal: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      setIsExiting(true);
      removal = setTimeout(() => onRemove(toast.id), 250);
    }, duration);

    return () => {
      clearTimeout(timer);
      if (removal) clearTimeout(removal);
    };
  }, [toast.id, duration, onRemove]);

  const handleClose = () => {
    setIsExiting(true);
    setTimeout(() => onRemove(toast.id), 250);
  };

  return (
    <div
      role="status"
      className={`pointer-events-auto w-80 overflow-hidden rounded-lg border ${config.borderClass} ${config.bgClass} shadow-elevation-4 ${
        isExiting ? 'animate-toast-slide-out' : 'animate-toast-slide-in'
      }`}
    >
      <div className="flex items-start gap-3 p-3">
        <div
          className={`mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full ${config.bgClass}`}
        >
          <Iconify icon={config.icon} width={14} className={config.iconClass} />
        </div>
        <div className="min-w-0 flex-1">
          <p className={`text-sm font-medium ${config.textClass}`}>
            {toast.notification.to ? (
              <Link to={toast.notification.to} onClick={handleClose} className="hover:underline">
                {toast.notification.title}
              </Link>
            ) : (
              toast.notification.title
            )}
          </p>
          {toast.notification.message && (
            <p className="mt-0.5 truncate text-xs text-tp-steel">{toast.notification.message}</p>
          )}
        </div>
        <button
          type="button"
          onClick={handleClose}
          aria-label="Dismiss"
          className="flex h-5 w-5 flex-shrink-0 cursor-pointer items-center justify-center rounded text-tp-steel transition-colors hover:text-tp-ink"
        >
          <Iconify icon="mdi:close" width={14} />
        </button>
      </div>
    </div>
  );
}
