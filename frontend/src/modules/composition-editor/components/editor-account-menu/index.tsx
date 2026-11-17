// Adapted from SPHERE frontend/src/modules/pricing-editor/layouts/editor-layout/editor-account-menu.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: OpenBinding's account (`useAuth().user`, `signOut`) and its avatar (initials); the entries are links; the menu
// is labelled and closes on Escape back to its button; the panel's colour is the code surface token.

import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { FiChevronDown, FiGrid, FiLogOut, FiSettings, FiUsers } from 'react-icons/fi';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../../auth/hooks/useAuth';
import UserAvatar from '../../../core/components/user-avatar';
import { dropdownVariants, transitionFast } from '../../../core/utils/motion-variants';

const ENTRY =
  'flex w-full cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-left text-xs text-white/65 transition-colors hover:bg-white/10 hover:text-white';

export default function EditorAccountMenu() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!isOpen) return;

    const handlePointerDown = (event: MouseEvent | TouchEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setIsOpen(false);
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsOpen(false);
        toggleRef.current?.focus();
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('touchstart', handlePointerDown);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('touchstart', handlePointerDown);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [isOpen]);

  const handleLogout = () => {
    setIsOpen(false);
    void signOut().then(() => navigate('/'));
  };

  const displayName = user?.username ?? '';

  return (
    <div ref={containerRef} className="relative ml-1 border-l border-white/10 pl-2">
      <button
        ref={toggleRef}
        type="button"
        onClick={() => setIsOpen(current => !current)}
        aria-label="Editor account menu"
        aria-expanded={isOpen}
        className="flex cursor-pointer items-center gap-2 rounded-lg py-1 pr-2 pl-1 text-left transition-colors hover:bg-white/10"
      >
        <span className="rounded-full ring-1 ring-white/20">
          <UserAvatar username={displayName} size={28} />
        </span>
        <span className="hidden max-w-28 truncate text-xs font-medium text-white/80 xl:block">
          {displayName}
        </span>
        <FiChevronDown
          aria-hidden="true"
          className={`hidden h-3.5 w-3.5 text-white/40 transition-transform sm:block ${isOpen ? 'rotate-180' : ''}`}
        />
      </button>

      <AnimatePresence>
        {isOpen ? (
          <motion.div
            variants={dropdownVariants}
            initial="hidden"
            animate="visible"
            exit="exit"
            transition={transitionFast}
            className="absolute top-full right-0 z-50 mt-2 w-64 origin-top-right overflow-hidden rounded-xl border border-white/10 bg-tp-surface-code shadow-elevation-4"
          >
            <div className="border-b border-white/10 px-4 py-3">
              <p className="truncate text-sm font-medium text-white">{displayName}</p>
              <p className="mt-0.5 truncate text-xs text-white/60">{user?.email}</p>
            </div>

            <div className="p-1.5">
              <Link to="/" onClick={() => setIsOpen(false)} className={ENTRY}>
                <FiGrid className="h-4 w-4" aria-hidden="true" />
                Dashboard
              </Link>
              <Link to="/me/orgs" onClick={() => setIsOpen(false)} className={ENTRY}>
                <FiUsers className="h-4 w-4" aria-hidden="true" />
                My organizations
              </Link>
              <Link to="/me/settings" onClick={() => setIsOpen(false)} className={ENTRY}>
                <FiSettings className="h-4 w-4" aria-hidden="true" />
                Account settings
              </Link>
            </div>

            <div className="border-t border-white/10 p-1.5">
              <button
                type="button"
                onClick={handleLogout}
                className="flex w-full cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-left text-xs text-white/65 transition-colors hover:bg-red-500/10 hover:text-red-300"
              >
                <FiLogOut className="h-4 w-4" aria-hidden="true" />
                Sign out
              </button>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
