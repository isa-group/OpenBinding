// Adapted from SPHERE frontend/src/modules/notification/components/notification-bell/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: the bell is a labelled button that says how many are unread and whether the panel is open; Escape gives the
// focus back to it.

import { useEffect, useRef, useState } from 'react';
import Iconify from '../../../core/components/iconify';
import { useNotificationsContext } from '../../hooks/useNotificationsContext';
import NotificationDropdown from '../notification-dropdown';

export default function NotificationBell() {
  const { unreadCount, hasUnseen, markSeen } = useNotificationsContext();
  const [isOpen, setIsOpen] = useState(false);
  const [isRinging, setIsRinging] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const prevCountRef = useRef(unreadCount);

  // The bell rings when the count goes up.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (unreadCount > prevCountRef.current) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- SPHERE's ring, started by a new notification
      setIsRinging(true);
      timer = setTimeout(() => setIsRinging(false), 700);
    }
    prevCountRef.current = unreadCount;
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [unreadCount]);

  useEffect(() => {
    if (!isOpen) return;
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node))
        setIsOpen(false);
    }
    function handleEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setIsOpen(false);
        buttonRef.current?.focus();
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [isOpen]);

  const label =
    unreadCount > 0
      ? `Notifications, ${unreadCount > 9 ? '9+' : unreadCount} unread`
      : 'Notifications';

  return (
    <div ref={containerRef} className="relative flex items-center justify-center">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => {
          if (!isOpen) markSeen();
          setIsOpen(!isOpen);
        }}
        className={`relative flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg transition-colors ${
          hasUnseen ? 'text-tp-accent' : 'text-tp-steel hover:text-tp-ink'
        }`}
        title={label}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
      >
        <span className={isRinging ? 'animate-bell-ring inline-block' : 'inline-block'}>
          <Iconify icon="mdi:bell-outline" width={18} />
        </span>
        {hasUnseen && (
          <span
            aria-hidden="true"
            className="absolute top-1 right-1 h-2.5 w-2.5 rounded-full bg-tp-primary ring-2 ring-tp-canvas"
          />
        )}
      </button>

      {isOpen && <NotificationDropdown onClose={() => setIsOpen(false)} />}
    </div>
  );
}
