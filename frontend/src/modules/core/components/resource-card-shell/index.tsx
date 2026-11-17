// Adapted from SPHERE frontend/src/modules/pricing/pages/card/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: the frame of SPHERE's pricing card page, taken out so every resource page of an organization uses it: the
// breadcrumb (links, not buttons), the `font-display` title with its version line, the actions (on a phone the primary one
// stays and the rest go into a ⋯ menu), the stat tiles and the underline tabs (pills on a phone). The tabs are links to the
// tab's address, so a tab can be linked and the back button returns to it; the page decides what each tab holds.

import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { transitionDefault } from '../../utils/motion-variants';

export interface ShellCrumb {
  label: string;
  to?: string;
}

export interface ShellTab {
  id: string;
  label: string;
  /** The label on a phone, when shorter. */
  shortLabel?: string;
  to: string;
}

export interface ShellStat {
  label: string;
  value: ReactNode;
}

/** An action the ⋯ menu offers on a phone. */
export interface OverflowAction {
  label: string;
  onSelect?: () => void;
  to?: string;
}

interface Props {
  crumbs: ShellCrumb[];
  title: string;
  /** Under the title: the version select or chip and "· Updated X ago", the lineage. */
  subtitle?: ReactNode;
  /** The actions beside the title from `sm` up. */
  actions?: ReactNode;
  /** The action that stays visible on a phone (SPHERE's primary "Get" menu). */
  primaryAction?: ReactNode;
  /** The other actions, in the ⋯ menu below `sm`. */
  overflow?: OverflowAction[];
  stats?: ShellStat[];
  tabs: ShellTab[];
  activeTab: string;
  /** The tab bar's name for assistive technology. */
  tabsLabel: string;
  children: ReactNode;
}

function OverflowMenu({ items }: { items: OverflowAction[] }) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  if (items.length === 0) return null;
  const itemClass =
    'flex w-full cursor-pointer items-center rounded-lg px-3 py-2 text-left text-xs text-tp-ink hover:bg-tp-surface';
  return (
    <div ref={menuRef} className="relative sm:hidden">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="More actions"
        onClick={() => setOpen(value => !value)}
        className="inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg border border-tp-input-border bg-tp-input-bg text-tp-ink transition-colors hover:bg-tp-surface"
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
            d="M6.75 12a.75.75 0 11-1.5 0 .75.75 0 011.5 0zM12.75 12a.75.75 0 11-1.5 0 .75.75 0 011.5 0zM18.75 12a.75.75 0 11-1.5 0 .75.75 0 011.5 0z"
          />
        </svg>
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 z-30 mt-2 w-56 overflow-hidden rounded-xl border border-tp-hairline bg-tp-canvas p-1.5 shadow-elevation-3"
        >
          {items.map(item =>
            item.to ? (
              <Link
                key={item.label}
                role="menuitem"
                to={item.to}
                onClick={() => setOpen(false)}
                className={itemClass}
              >
                {item.label}
              </Link>
            ) : (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                onClick={() => {
                  item.onSelect?.();
                  setOpen(false);
                }}
                className={itemClass}
              >
                {item.label}
              </button>
            )
          )}
        </div>
      )}
    </div>
  );
}

export default function ResourceCardShell({
  crumbs,
  title,
  subtitle,
  actions,
  primaryAction,
  overflow = [],
  stats = [],
  tabs,
  activeTab,
  tabsLabel,
  children,
}: Props) {
  return (
    <div className="mx-auto max-w-7xl px-4 py-6 md:px-8">
      {/* Breadcrumb + header */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={transitionDefault}
        className="mb-6"
      >
        <nav aria-label="Breadcrumb" className="mb-2 flex items-center gap-2 text-xs text-tp-steel">
          {crumbs.map((crumb, index) => (
            <span key={`${crumb.label}-${index}`} className="flex min-w-0 items-center gap-2">
              {index > 0 && <span aria-hidden="true">/</span>}
              {crumb.to ? (
                <Link to={crumb.to} className="cursor-pointer truncate hover:text-tp-ink">
                  {crumb.label}
                </Link>
              ) : (
                <span className="truncate text-tp-ink" aria-current="page">
                  {crumb.label}
                </span>
              )}
            </span>
          ))}
        </nav>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <h1 className="font-display text-2xl font-normal [overflow-wrap:anywhere] text-tp-ink">
              {title}
            </h1>
            {subtitle}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="hidden flex-wrap items-center gap-2 sm:flex">{actions}</div>
            <OverflowMenu items={overflow} />
            {primaryAction}
          </div>
        </div>
      </motion.div>

      {/* Stats */}
      {stats.length > 0 && (
        <motion.dl
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ ...transitionDefault, delay: 0.05 }}
          className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4"
        >
          {stats.map(stat => (
            <div key={stat.label} className="rounded-xl border border-tp-hairline bg-tp-canvas p-3">
              <dt className="text-[11px] text-tp-steel">{stat.label}</dt>
              <dd className="mt-0.5 text-lg font-semibold text-tp-ink">{stat.value}</dd>
            </div>
          ))}
        </motion.dl>
      )}

      {/* Tabs */}
      <nav aria-label={tabsLabel} className="mb-6 border-b border-tp-hairline">
        <div
          className="mb-2 flex gap-2 overflow-x-auto pb-2 md:mb-0 md:gap-1 md:overflow-visible md:pb-0"
          style={{ scrollbarWidth: 'none', WebkitOverflowScrolling: 'touch' }}
        >
          {tabs.map(tab => {
            const active = activeTab === tab.id;
            return (
              <Link
                key={tab.id}
                to={tab.to}
                aria-current={active ? 'page' : undefined}
                className={`relative shrink-0 cursor-pointer rounded-full px-4 py-2 text-sm font-medium whitespace-nowrap transition-all md:rounded-none md:py-2.5 ${
                  active
                    ? 'bg-tp-accent text-tp-on-primary shadow-sm md:bg-transparent md:text-tp-accent md:shadow-none'
                    : 'bg-tp-surface text-tp-steel hover:bg-tp-hairline hover:text-tp-ink md:bg-transparent md:hover:bg-transparent'
                }`}
              >
                {tab.shortLabel ? (
                  <>
                    <span className="md:hidden">{tab.shortLabel}</span>
                    <span className="hidden md:inline">{tab.label}</span>
                  </>
                ) : (
                  tab.label
                )}
                {active && (
                  <motion.div
                    layoutId="resource-tab"
                    className="absolute right-0 bottom-0 left-0 hidden h-0.5 bg-tp-primary md:block"
                    transition={{ type: 'spring', stiffness: 380, damping: 30 }}
                  />
                )}
              </Link>
            );
          })}
        </div>
      </nav>

      <AnimatePresence mode="wait">
        <motion.div
          key={activeTab}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={transitionDefault}
        >
          {children}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
