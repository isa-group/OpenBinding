// Adapted from SPHERE frontend/src/modules/core/contexts/toastContext.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: toasts carry `ToastNotification` instead of the notification module's type; the stack is a polite live region.

import { createContext, useCallback, useMemo, useState, type ReactNode } from 'react';
import ToastItem, { type Toast, type ToastNotification } from '../components/toast';

export interface ToastContextValue {
  addToast: (notification: ToastNotification) => void;
  removeToast: (id: string) => void;
}

// eslint-disable-next-line react-refresh/only-export-components -- SPHERE keeps the context beside its provider
export const ToastContext = createContext<ToastContextValue | null>(null);

let toastCounter = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const maxToasts = 3;

  const addToast = useCallback((notification: ToastNotification) => {
    const id = `toast-${++toastCounter}`;
    const toast: Toast = { id, notification };
    setToasts(prev => {
      const next = [toast, ...prev];
      return next.length > maxToasts ? next.slice(0, maxToasts) : next;
    });
  }, []);

  const removeToast = useCallback((id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  const value = useMemo<ToastContextValue>(
    () => ({ addToast, removeToast }),
    [addToast, removeToast]
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        className="pointer-events-none fixed right-4 bottom-4 z-50 flex flex-col gap-2"
        aria-live="polite"
      >
        {toasts.map(toast => (
          <ToastItem key={toast.id} toast={toast} onRemove={removeToast} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}
