// Adapted from SPHERE frontend/src/modules/presentation/layouts/authenticated-layout/mobile-nav.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: OpenBinding's menus (layouts/router/header-routes.ts) as links with an active state, plus the person's own places
// (SPHERE's drawer lacks them) and a Search that opens the palette; New creates in the organization the header has in
// hand; a labelled navigation and close button; Escape closes the drawer.

import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../../../auth/hooks/useAuth';
import {
  menuItemVariants,
  staggerContainer,
  transitionFast,
} from '../../../core/utils/motion-variants';
import { headerRoutes, isActive, newEntries, userEntries } from '../router/header-routes';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  /** Opens the command palette, whose trigger the narrow header hides. */
  onSearch?: () => void;
  organization?: string;
}

export default function MobileNav({ isOpen, onClose, onSearch, organization }: Props) {
  const location = useLocation();
  const navigate = useNavigate();
  const { user, isAdmin, signOut } = useAuth();
  const [expandedGroup, setExpandedGroup] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen, onClose]);

  const handleLogout = () => {
    onClose();
    void signOut().then(() => navigate('/'));
  };

  const linkClass = (active: boolean) =>
    `mb-1 block w-full cursor-pointer rounded-lg px-3 py-2.5 text-left text-sm font-medium transition-colors hover:bg-tp-surface ${
      active ? 'bg-tp-surface text-tp-ink' : 'text-tp-ink'
    }`;

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 z-40 cursor-pointer bg-tp-ink/20 backdrop-blur-sm"
            onClick={onClose}
            aria-hidden="true"
          />

          <motion.div
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', damping: 30, stiffness: 300 }}
            className="fixed top-0 right-0 bottom-0 z-50 w-75 max-w-[85vw] bg-tp-canvas shadow-elevation-4"
          >
            <div className="flex h-full flex-col">
              {/* Header */}
              <div className="flex items-center justify-between border-b border-tp-hairline px-4 py-4">
                <span className="text-sm font-semibold tracking-[0.22em] text-tp-ink uppercase">
                  OpenBinding
                </span>
                <button
                  type="button"
                  onClick={onClose}
                  aria-label="Close menu"
                  className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-md text-tp-steel transition-colors hover:bg-tp-surface hover:text-tp-ink"
                >
                  <svg
                    className="h-5 w-5"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={1.5}
                    aria-hidden="true"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>

              {/* User info */}
              {user && (
                <div className="border-b border-tp-hairline px-4 py-3">
                  <div className="flex items-center gap-3">
                    <div className="flex h-9 w-9 items-center justify-center rounded-full bg-tp-cream text-sm font-semibold text-tp-accent">
                      {user.username?.[0]?.toUpperCase() ?? 'U'}
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-tp-ink">{user.username}</p>
                      <p className="truncate text-xs text-tp-steel">{user.email}</p>
                    </div>
                  </div>
                </div>
              )}

              {/* Nav items */}
              <motion.nav
                variants={staggerContainer}
                initial="hidden"
                animate="visible"
                className="flex-1 overflow-y-auto px-3 py-4"
                aria-label="Mobile navigation"
              >
                {onSearch && (
                  <motion.div variants={menuItemVariants} transition={transitionFast}>
                    <button
                      type="button"
                      onClick={onSearch}
                      className="mb-1 block w-full cursor-pointer rounded-lg px-3 py-2.5 text-left text-sm font-medium text-tp-ink transition-colors hover:bg-tp-surface"
                    >
                      Search
                    </button>
                  </motion.div>
                )}
                {headerRoutes.map(item => (
                  <motion.div
                    key={item.name}
                    variants={menuItemVariants}
                    transition={transitionFast}
                  >
                    {item.children ? (
                      <div className="mb-1">
                        <button
                          type="button"
                          aria-expanded={expandedGroup === item.name}
                          onClick={() =>
                            setExpandedGroup(prev => (prev === item.name ? null : item.name))
                          }
                          className="flex w-full cursor-pointer items-center justify-between rounded-lg px-3 py-2.5 text-sm font-medium text-tp-ink transition-colors hover:bg-tp-surface"
                        >
                          {item.name}
                          <svg
                            className={`h-4 w-4 text-tp-steel transition-transform ${expandedGroup === item.name ? 'rotate-180' : ''}`}
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                            strokeWidth={2}
                            aria-hidden="true"
                          >
                            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                          </svg>
                        </button>
                        <AnimatePresence>
                          {expandedGroup === item.name && (
                            <motion.div
                              initial={{ height: 0, opacity: 0 }}
                              animate={{ height: 'auto', opacity: 1 }}
                              exit={{ height: 0, opacity: 0 }}
                              transition={{ duration: 0.2 }}
                              className="overflow-hidden"
                            >
                              <div className="ml-3 border-l border-tp-hairline py-1 pl-3">
                                {item.children.map(child => (
                                  <Link
                                    key={child.to}
                                    to={child.to!}
                                    onClick={onClose}
                                    aria-current={
                                      isActive(child, location.pathname) ? 'page' : undefined
                                    }
                                    className="block w-full cursor-pointer rounded-md px-3 py-2 text-left text-sm text-tp-slate transition-colors hover:bg-tp-surface hover:text-tp-ink"
                                  >
                                    {child.name}
                                  </Link>
                                ))}
                              </div>
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </div>
                    ) : (
                      <Link
                        to={item.to!}
                        onClick={onClose}
                        aria-current={isActive(item, location.pathname) ? 'page' : undefined}
                        className={linkClass(isActive(item, location.pathname))}
                      >
                        {item.name}
                      </Link>
                    )}
                  </motion.div>
                ))}

                {user && (
                  <motion.div
                    variants={menuItemVariants}
                    transition={transitionFast}
                    className="mt-3 border-t border-tp-hairline pt-3"
                  >
                    {userEntries(isAdmin).map(entry => (
                      <Link
                        key={entry.label}
                        to={entry.to}
                        onClick={onClose}
                        aria-current={location.pathname === entry.to ? 'page' : undefined}
                        className={linkClass(location.pathname === entry.to)}
                      >
                        {entry.label}
                      </Link>
                    ))}
                  </motion.div>
                )}
              </motion.nav>

              {/* Footer actions */}
              <div className="border-t border-tp-hairline px-3 py-3">
                <p className="mb-2 px-1 text-xs font-medium text-tp-steel">Create new</p>
                <div className="mb-2 grid grid-cols-2 gap-1.5">
                  {newEntries(organization).map(entry => (
                    <Link
                      key={entry.label}
                      to={entry.to}
                      onClick={onClose}
                      className="flex w-full cursor-pointer items-center justify-center rounded-lg border border-tp-hairline-strong bg-tp-canvas px-3 py-2 text-sm font-medium text-tp-ink transition-colors hover:bg-tp-surface"
                    >
                      {entry.label}
                    </Link>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={handleLogout}
                  className="flex w-full cursor-pointer items-center justify-center rounded-lg px-4 py-2.5 text-sm text-tp-steel transition-colors hover:bg-tp-surface hover:text-tp-ink"
                >
                  Sign out
                </button>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
