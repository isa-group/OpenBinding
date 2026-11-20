// Adapted from SPHERE frontend/src/modules/settings/pages/SettingsPage.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: OpenBinding's sections (sections.ts); the section is in the address (`?section=`), and the nav entries are links
// that the dirty guard can hold back; the phone selector is a labelled disclosure that closes on Escape; each section reads
// and writes its own data through the gateway instead of SPHERE's settings blob in the session.

import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';
import { Helmet } from 'react-helmet-async';
import { AnimatePresence, motion } from 'framer-motion';
import { FiChevronDown } from 'react-icons/fi';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { fadeInUp, transitionDefault } from '../../../core/utils/motion-variants';
import AccountSection from '../../components/AccountSection';
import AppearanceSection from '../../components/AppearanceSection';
import BetaFeaturesSection from '../../components/BetaFeaturesSection';
import DangerZoneSection from '../../components/DangerZoneSection';
import NotificationsSection from '../../components/NotificationsSection';
import PlanSection from '../../components/PlanSection';
import UnsavedChangesDialog from '../../components/UnsavedChangesDialog';
import { SETTINGS_SECTIONS, sectionOf, settingsPath, type SettingsSectionId } from './sections';

export default function SettingsPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const activeSection = sectionOf(searchParams.get('section'));
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [pendingSection, setPendingSection] = useState<SettingsSectionId | null>(null);
  const dirtySectionsRef = useRef<Partial<Record<SettingsSectionId, boolean>>>({});
  const dropdownRef = useRef<HTMLDivElement>(null);

  const markDirty = useCallback((sectionId: SettingsSectionId, dirty: boolean) => {
    dirtySectionsRef.current[sectionId] = dirty;
  }, []);

  /** A nav link was followed: held back while the open section has unsaved changes. */
  const guard = (target: SettingsSectionId) => (event: MouseEvent<HTMLAnchorElement>) => {
    setDropdownOpen(false);
    if (target === activeSection || !dirtySectionsRef.current[activeSection]) return;
    event.preventDefault();
    setPendingSection(target);
  };

  const confirmDiscard = () => {
    if (pendingSection) {
      dirtySectionsRef.current[activeSection] = false;
      navigate(settingsPath(pendingSection));
    }
    setPendingSection(null);
  };

  const accountDirtyChange = useCallback((d: boolean) => markDirty('account', d), [markDirty]);
  const notificationsDirtyChange = useCallback(
    (d: boolean) => markDirty('notifications', d),
    [markDirty]
  );

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

  const activeMeta =
    SETTINGS_SECTIONS.find(section => section.id === activeSection) ?? SETTINGS_SECTIONS[0];

  return (
    <>
      <Helmet>
        <title>OpenBinding - Settings</title>
      </Helmet>
      <div className="mx-auto h-full max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
        <motion.div
          initial="hidden"
          animate="visible"
          variants={fadeInUp}
          transition={transitionDefault}
          className="mb-8"
        >
          <h1 className="font-display text-3xl text-tp-ink">Settings</h1>
          <p className="mt-1 text-sm text-tp-steel">
            Manage your account, sign-in, notifications and preferences
          </p>
        </motion.div>

        {/* Phone selector */}
        <div className="mb-5 lg:hidden" ref={dropdownRef}>
          <button
            type="button"
            onClick={() => setDropdownOpen(!dropdownOpen)}
            aria-expanded={dropdownOpen}
            aria-controls="settings-sections-menu"
            aria-label={`Settings section: ${activeMeta.label}`}
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
                id="settings-sections-menu"
                aria-label="Settings sections"
                initial={{ opacity: 0, y: -4, scaleY: 0.95 }}
                animate={{ opacity: 1, y: 0, scaleY: 1 }}
                exit={{ opacity: 0, y: -4, scaleY: 0.95 }}
                transition={{ duration: 0.15, ease: 'easeOut' }}
                style={{ transformOrigin: 'top' }}
                className="mt-1 overflow-hidden rounded-[8px] border border-tp-hairline bg-tp-canvas shadow-elevation-4"
              >
                {SETTINGS_SECTIONS.map(section => {
                  const isActive = activeSection === section.id;
                  const Icon = section.icon;
                  return (
                    <Link
                      key={section.id}
                      to={settingsPath(section.id)}
                      onClick={guard(section.id)}
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
            <nav aria-label="Settings" className="sticky top-24 space-y-0.5">
              {SETTINGS_SECTIONS.map(section => {
                const isActive = activeSection === section.id;
                const Icon = section.icon;
                return (
                  <Link
                    key={section.id}
                    to={settingsPath(section.id)}
                    onClick={guard(section.id)}
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
              >
                {activeSection === 'account' && (
                  <AccountSection onDirtyChange={accountDirtyChange} />
                )}
                {activeSection === 'notifications' && (
                  <NotificationsSection onDirtyChange={notificationsDirtyChange} />
                )}
                {activeSection === 'plan' && <PlanSection />}
                {activeSection === 'appearance' && <AppearanceSection />}
                {activeSection === 'beta' && <BetaFeaturesSection />}
                {activeSection === 'danger' && <DangerZoneSection />}
              </motion.div>
            </AnimatePresence>
          </div>
        </div>
      </div>
      <UnsavedChangesDialog
        open={pendingSection !== null}
        onDiscard={confirmDiscard}
        onCancel={() => setPendingSection(null)}
      />
    </>
  );
}
