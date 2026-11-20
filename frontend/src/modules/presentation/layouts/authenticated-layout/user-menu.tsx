// Adapted from SPHERE frontend/src/modules/presentation/layouts/authenticated-layout/user-menu.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: OpenBinding's places (layouts/router/header-routes.ts) as links, Administration for platform administrators; the
// person is named by OpenBinding's profile; the Inbox shows SPHERE's unread badge (9+); the menu is labelled and
// returns focus on Escape.

import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  FaBell,
  FaBuilding,
  FaCog,
  FaCogs,
  FaKey,
  FaLayerGroup,
  FaUserCircle,
  FaUserShield,
} from 'react-icons/fa';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../../auth/hooks/useAuth';
import UserAvatar from '../../../core/components/user-avatar';
import { dropdownVariants, transitionFast } from '../../../core/utils/motion-variants';
import { useNotificationsContext } from '../../../notification/hooks/useNotificationsContext';
import { userEntries } from '../router/header-routes';

const ICONS: Record<string, typeof FaKey> = {
  Organizations: FaBuilding,
  Compositions: FaLayerGroup,
  Inbox: FaBell,
  Engines: FaCogs,
  'API keys': FaKey,
  Settings: FaCog,
  Administration: FaUserShield,
};

export default function UserMenu() {
  const { user, isAdmin, signOut } = useAuth();
  const { unreadCount } = useNotificationsContext();
  const navigate = useNavigate();
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e: MouseEvent | TouchEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsOpen(false);
        toggleRef.current?.focus();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('touchstart', handleClickOutside);
    document.addEventListener('keydown', handleEscape);

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('touchstart', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [isOpen]);

  const handleLogout = (scope: 'this' | 'all' = 'this') => {
    setIsOpen(false);
    void signOut(scope).then(() => navigate('/'));
  };

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={toggleRef}
        type="button"
        onClick={() => setIsOpen(prev => !prev)}
        aria-label="Account menu"
        aria-expanded={isOpen}
        className="flex cursor-pointer items-center justify-center overflow-hidden rounded-full border border-tp-hairline bg-tp-cream transition-all hover:ring-2 hover:ring-tp-primary/20"
      >
        <UserAvatar username={user?.username ?? ''} size={32} />
      </button>

      <AnimatePresence>
        {isOpen && (
          <motion.div
            variants={dropdownVariants}
            initial="hidden"
            animate="visible"
            exit="exit"
            transition={transitionFast}
            className="absolute top-full right-0 z-50 mt-2 w-56 origin-top-right rounded-lg border border-tp-hairline bg-tp-canvas py-1 shadow-elevation-4"
          >
            <div className="border-b border-tp-hairline px-3 py-2.5">
              <p className="text-sm font-medium text-tp-ink">{user?.username}</p>
              <p className="truncate text-xs text-tp-steel">{user?.email}</p>
            </div>

            {userEntries(isAdmin).map(item => {
              const Icon = ICONS[item.label] ?? FaUserCircle;
              return (
                <Link
                  key={item.label}
                  to={item.to}
                  onClick={() => setIsOpen(false)}
                  className="flex w-full cursor-pointer items-center gap-2.5 px-3 py-2 text-left text-sm text-tp-slate transition-colors hover:bg-tp-surface hover:text-tp-ink"
                >
                  <Icon className="h-4 w-4" aria-hidden="true" />
                  {item.label}
                  {item.to === '/notifications' && unreadCount > 0 && (
                    <span className="ml-auto rounded-full bg-tp-accent px-1.5 py-0.5 text-[10px] font-semibold text-tp-on-primary">
                      {unreadCount > 9 ? '9+' : unreadCount}
                      <span className="sr-only"> unread</span>
                    </span>
                  )}
                </Link>
              );
            })}

            <div className="border-t border-tp-hairline">
              <button
                type="button"
                onClick={() => handleLogout()}
                className="flex w-full cursor-pointer items-center gap-2.5 px-3 py-2 text-left text-sm text-tp-slate transition-colors hover:bg-tp-surface hover:text-tp-ink"
              >
                <svg
                  className="h-4 w-4"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={1.5}
                  aria-hidden="true"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M15.75 9V5.25A2.25 2.25 0 0013.5 3h-6a2.25 2.25 0 00-2.25 2.25v13.5A2.25 2.25 0 007.5 21h6a2.25 2.25 0 002.25-2.25V15m3 0l3-3m0 0l-3-3m3 3H9"
                  />
                </svg>
                Sign out
              </button>
              <button
                type="button"
                onClick={() => handleLogout('all')}
                title="Sign out of every OpenBinding session of this account, on every device"
                className="flex w-full cursor-pointer items-center gap-2.5 px-3 py-2 pl-[2.375rem] text-left text-xs text-tp-steel transition-colors hover:bg-tp-surface hover:text-tp-ink"
              >
                End every session
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
