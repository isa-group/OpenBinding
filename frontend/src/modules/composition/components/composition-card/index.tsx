// Adapted from SPHERE frontend/src/modules/pricing/components/pricing-card/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: a composition instead of a pricing: the chips are its kind, its tasks, its cost with the verified or declared
// mark (on its own when there is no cost), and its version. The name is a real link stretched over the card (SPHERE navigated on click, which loses
// middle-click and the keyboard); the kebab opens with the keyboard, closes on Escape and shows on focus as on hover.

import { motion } from 'framer-motion';
import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { Link } from 'react-router-dom';
import OrgAvatar from '../../../core/components/org-avatar';
import { ValueBadge } from '../../../core/components/value-badge/ValueBadge';
import { valueStatus } from '../../../core/utils/composition/values';
import type { Kind } from '../../../core/utils/composition/document';
import { kindLabel } from '../../../core/utils/composition/kinds';
import type { VersionFigures } from '../../api/compositionsApi';
import { formatCost } from './format';

/** What a card shows of a composition, from any of the lists (public, the account's, an organization's). */
export interface CompositionCardData {
  organization: { slug: string; name: string };
  slug: string;
  name: string;
  kind: Kind;
  latest_version?: {
    label: string;
    values_status: 'verified' | 'declared';
    /** Whether the current evaluation verified the binding (the gateway's row summary). */
    verified?: boolean;
    figures?: VersionFigures | null;
  } | null;
  version_count: number;
  archived?: boolean;
  visibility?: 'public' | 'private';
}

export interface MenuItem {
  label: string;
  icon?: 'archive' | 'restore' | 'link';
  onClick: () => void;
  variant?: 'danger' | 'default';
}

interface Props {
  data: CompositionCardData;
  /** Where the card leads: the composition's page. */
  to: string;
  menuItems?: MenuItem[];
  /** Show the visibility pill (a list the account reads as a member). */
  showVisibility?: boolean;
}

export default function CompositionCard({
  data,
  to,
  menuItems = [],
  showVisibility = false,
}: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const handleClick = (e: globalThis.MouseEvent | TouchEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [menuOpen]);

  const latest = data.latest_version;
  // How far the latest values can be trusted: verified, declared, or linked but not verified by the current evaluation.
  const status = valueStatus({
    values_status: latest?.values_status ?? 'declared',
    verified: latest?.verified ?? false,
  });
  const figures = latest?.figures;
  const tasks = figures?.tasks;
  const cost = figures?.cost;

  return (
    <motion.article
      whileHover={{ y: -2 }}
      transition={{ duration: 0.15 }}
      aria-label={data.name}
      className="group relative rounded-xl border border-tp-hairline bg-tp-canvas p-4 transition-colors focus-within:border-tp-hairline-strong hover:border-tp-hairline-strong hover:shadow-elevation-2"
    >
      {/* Header */}
      <div className="mb-3 flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex items-center gap-2">
            <OrgAvatar name={data.organization.name} size={20} square />
            <span className="truncate text-[11px] text-tp-steel">{data.organization.name}</span>
            {showVisibility && data.visibility === 'public' && (
              <span className="rounded-full bg-emerald-50 px-1.5 py-px text-[10px] font-semibold text-emerald-800">
                Public
              </span>
            )}
            {data.archived && (
              <span className="rounded-full bg-amber-50 px-1.5 py-px text-[10px] font-semibold text-amber-800">
                Archived
              </span>
            )}
          </div>
          <h3 className="min-w-0 text-sm font-medium text-tp-ink group-hover:text-tp-accent">
            <Link
              to={to}
              className="block cursor-pointer truncate py-1 outline-none after:absolute after:inset-0 after:rounded-xl after:content-[''] focus-visible:after:ring-2 focus-visible:after:ring-tp-primary"
            >
              {data.name}
            </Link>
          </h3>
        </div>

        {menuItems.length > 0 && (
          <div ref={menuRef} className="relative z-10">
            <button
              type="button"
              aria-label={`Actions for ${data.name}`}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen(!menuOpen)}
              className="flex h-6 cursor-pointer items-center justify-center rounded text-tp-steel opacity-0 transition-all group-focus-within:opacity-100 group-hover:opacity-100 hover:bg-tp-surface hover:text-tp-ink focus:opacity-100 aria-expanded:opacity-100 max-sm:opacity-100"
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
                  d="M12 6.75a.75.75 0 110-1.5.75.75 0 010 1.5zM12 12.75a.75.75 0 110-1.5.75.75 0 010 1.5zM12 18.75a.75.75 0 110-1.5.75.75 0 010 1.5z"
                />
              </svg>
            </button>
            {menuOpen && (
              <div
                role="menu"
                className="absolute top-full right-0 z-10 mt-1 w-47 rounded-lg border border-tp-hairline bg-tp-canvas py-1 shadow-elevation-4"
              >
                {menuItems.map(item => (
                  <button
                    key={item.label}
                    type="button"
                    role="menuitem"
                    onClick={(e: MouseEvent) => {
                      e.stopPropagation();
                      item.onClick();
                      setMenuOpen(false);
                    }}
                    className={`flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors ${
                      item.variant === 'danger'
                        ? 'text-red-700 hover:bg-red-50'
                        : 'text-tp-ink hover:bg-tp-surface'
                    }`}
                  >
                    {(item.icon === 'archive' || item.icon === 'restore') && (
                      <svg
                        className="h-3.5 w-3.5"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={1.5}
                        aria-hidden="true"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M20.25 7.5l-.625 10.632a2.25 2.25 0 01-2.247 2.118H6.622a2.25 2.25 0 01-2.247-2.118L3.75 7.5M10 11.25h4M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125z"
                        />
                      </svg>
                    )}
                    {item.icon === 'link' && (
                      <svg
                        className="h-3.5 w-3.5"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={1.5}
                        aria-hidden="true"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m9.86-4.18a4.5 4.5 0 00-1.242-7.244l-4.5-4.5a4.5 4.5 0 00-6.364 6.364L4.34 8.374"
                        />
                      </svg>
                    )}
                    {item.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Stats */}
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-tp-steel">
        <span className="inline-flex items-center gap-1 rounded bg-tp-surface px-1.5 py-0.5">
          {kindLabel(data.kind)}
        </span>
        {latest ? (
          <>
            {tasks !== null && tasks !== undefined && (
              <span className="inline-flex items-center gap-1 rounded bg-tp-surface px-1.5 py-0.5">
                {tasks.toLocaleString('en')} {tasks === 1 ? 'task' : 'tasks'}
              </span>
            )}
            {cost !== null && cost !== undefined ? (
              <span className="inline-flex items-center gap-1.5 rounded bg-tp-surface px-1.5 py-0.5">
                {formatCost(cost, figures?.cost_unit)}
                <ValueBadge status={status} />
              </span>
            ) : (
              <ValueBadge status={status} />
            )}
            <span className="text-tp-steel">v{latest.label}</span>
          </>
        ) : (
          <span className="rounded bg-tp-surface px-1.5 py-0.5 text-tp-steel">No version yet</span>
        )}
      </div>
    </motion.article>
  );
}
