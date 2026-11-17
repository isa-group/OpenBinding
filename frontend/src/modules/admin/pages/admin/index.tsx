// Adapted from SPHERE frontend/src/modules/settings/pages/SettingsPage.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: SPHERE has no administration frontend, so its settings shell holds OpenBinding's administration: the sections of
// sections.ts, each a segment of the address (`/admin/:section?`) and its nav entry a link; the phone selector is a labelled
// disclosure that closes on Escape; there is no dirty guard (no section keeps a draft that a link would lose); an unknown
// section and a person who is not a platform administrator get the in-place 404, and no request is made for them.

import { useEffect, useRef, useState, type ComponentType } from 'react';
import { Helmet } from 'react-helmet-async';
import { AnimatePresence, motion } from 'framer-motion';
import { FiChevronDown } from 'react-icons/fi';
import { Link, useParams } from 'react-router-dom';
import { useAuth } from '../../../auth/hooks/useAuth';
import NotFoundPage from '../../../core/pages/page-not-found';
import { fadeInUp, transitionDefault } from '../../../core/utils/motion-variants';
import { adminPath, adminSectionOf, type AdminSectionId } from '../../../../routes/paths/admin';
import AuditSection from '../../components/audit-section';
import ErrorsSection from '../../components/errors-section';
import MaintenanceSection from '../../components/maintenance-section';
import ModerationSection from '../../components/moderation-section';
import OverviewSection from '../../components/overview-section';
import QueuesSection from '../../components/queues-section';
import UsersSection from '../../components/users-section';
import { ADMIN_SECTIONS } from './sections';

const BODIES: Record<AdminSectionId, ComponentType> = {
  overview: OverviewSection,
  users: UsersSection,
  moderation: ModerationSection,
  audit: AuditSection,
  errors: ErrorsSection,
  queues: QueuesSection,
  maintenance: MaintenanceSection,
};

/** `/admin/:section?`: how the platform is doing, and every administration tool, in SPHERE's settings shell. */
export default function AdminPage() {
  const { isAdmin } = useAuth();
  const { section: segment } = useParams();
  const activeSection = adminSectionOf(segment);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!dropdownOpen) return;
    const handleClickOutside = (e: globalThis.MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDropdownOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [dropdownOpen]);

  // Administration is unreadable to everybody else, and anything unreadable is the same in-place 404 as a missing page.
  if (!isAdmin || activeSection === null) return <NotFoundPage />;

  const activeMeta =
    ADMIN_SECTIONS.find(section => section.id === activeSection) ?? ADMIN_SECTIONS[0];
  const Body = BODIES[activeSection];

  return (
    <>
      <Helmet>
        <title>OpenBinding - Administration</title>
      </Helmet>
      <div className="mx-auto h-full max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        <motion.div
          initial="hidden"
          animate="visible"
          variants={fadeInUp}
          transition={transitionDefault}
          className="mb-8"
        >
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="font-display text-3xl text-tp-ink">Administration</h1>
            <span className="rounded-full bg-tp-ink px-2.5 py-0.5 text-[11px] font-semibold text-tp-on-dark">
              Platform admin
            </span>
          </div>
          <p className="mt-1 text-sm text-tp-steel">
            How the platform is doing, and where to act. Contract, pricing and maintenance changes
            are recorded in the audit log.
          </p>
        </motion.div>

        {/* Phone selector */}
        <div className="mb-5 lg:hidden" ref={dropdownRef}>
          <button
            type="button"
            onClick={() => setDropdownOpen(!dropdownOpen)}
            aria-expanded={dropdownOpen}
            aria-controls="admin-sections-menu"
            aria-label={`Administration section: ${activeMeta.label}`}
            className="flex w-full cursor-pointer items-center justify-between rounded-[8px] border border-tp-hairline-strong bg-tp-canvas px-4 py-3 text-sm font-medium text-tp-ink transition-colors hover:border-tp-hairline"
          >
            <span className="flex items-center gap-3">
              <activeMeta.icon className="h-4 w-4 text-tp-accent" aria-hidden="true" />
              {activeMeta.label}
            </span>
            <motion.div animate={{ rotate: dropdownOpen ? 180 : 0 }} transition={{ duration: 0.2 }}>
              <FiChevronDown className="h-4 w-4 text-tp-steel" aria-hidden="true" />
            </motion.div>
          </button>

          <AnimatePresence>
            {dropdownOpen && (
              <motion.nav
                id="admin-sections-menu"
                aria-label="Administration sections"
                initial={{ opacity: 0, y: -4, scaleY: 0.95 }}
                animate={{ opacity: 1, y: 0, scaleY: 1 }}
                exit={{ opacity: 0, y: -4, scaleY: 0.95 }}
                transition={{ duration: 0.15, ease: 'easeOut' }}
                style={{ transformOrigin: 'top' }}
                className="mt-1 overflow-hidden rounded-[8px] border border-tp-hairline bg-tp-canvas shadow-elevation-4"
              >
                {ADMIN_SECTIONS.map(section => {
                  const isActive = activeSection === section.id;
                  const Icon = section.icon;
                  return (
                    <Link
                      key={section.id}
                      to={adminPath(section.id)}
                      onClick={() => setDropdownOpen(false)}
                      aria-current={isActive ? 'page' : undefined}
                      className={`flex w-full cursor-pointer items-center gap-3 px-4 py-3 text-sm font-medium transition-colors ${
                        isActive
                          ? 'bg-tp-primary/10 text-tp-accent'
                          : 'text-tp-steel hover:bg-tp-surface hover:text-tp-ink'
                      }`}
                    >
                      <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                      {section.label}
                    </Link>
                  );
                })}
              </motion.nav>
            )}
          </AnimatePresence>
        </div>

        <div className="flex gap-8">
          {/* Desktop sidebar */}
          <motion.aside
            initial={{ opacity: 0, x: -12 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.4, delay: 0.1 }}
            className="hidden w-56 shrink-0 lg:block"
          >
            <nav aria-label="Administration" className="sticky top-24 space-y-0.5">
              {ADMIN_SECTIONS.map(section => {
                const isActive = activeSection === section.id;
                const Icon = section.icon;
                return (
                  <Link
                    key={section.id}
                    to={adminPath(section.id)}
                    aria-current={isActive ? 'page' : undefined}
                    className={`flex w-full cursor-pointer items-center gap-3 rounded-[8px] px-3 py-2.5 text-sm font-medium transition-all duration-150 ${
                      isActive
                        ? 'bg-tp-primary/10 text-tp-accent'
                        : 'text-tp-steel hover:bg-tp-surface hover:text-tp-ink'
                    }`}
                  >
                    <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                    {section.label}
                  </Link>
                );
              })}
            </nav>
          </motion.aside>

          {/* Content area */}
          <div className="min-w-0 flex-1 pb-8 lg:pb-0">
            <AnimatePresence mode="wait">
              <motion.div
                key={activeSection}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.2, ease: 'easeOut' }}
                className="flex flex-col gap-6"
              >
                <Body />
              </motion.div>
            </AnimatePresence>
          </div>
        </div>
      </div>
    </>
  );
}
